/**
 * @fileoverview Desktop media editing: paste and drop of images, URLs and text, image upload
 * and replacement, link previews, link ↔ embed conversion, and the live embed frames.
 *
 * Every write goes through the editor's own submit/compound path, so nothing here is a second
 * write path. Live frames are a view concern: at most `MAX_LIVE_FRAMES` embeds nearest the
 * middle of the viewport hold an iframe; the rest show their card with "Paused". A frame never
 * takes focus by itself: a shield covers it until a click on an already selected embed, and
 * Escape inside the page (relayed by the proxy) hands focus back to the board.
 */
import { z } from 'zod';
import { knownContentFields } from '../../../src/canvas/model.js';
import type { CanvasRequest, Edit } from './edit-queue.js';
import { EditSchema } from './edit-queue.js';
import type { ViewCommand, ViewState } from './commands.js';
import { worldOrigin } from './drag.js';
import { label, type ViewObject } from './model.js';
import { imageCreateSize } from './objects/image.js';
import { isLoopbackUrl, linkHost, pastedUrl } from './objects/link.js';
import { embedStage, paintEmbed } from './objects/embed.js';
import { screenToCanvas, type Point } from './viewport.js';

export const MAX_LIVE_FRAMES = 6;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_PASTED_IMAGES = 10;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const LINK_SIZE = { width: 320, height: 96 };
const EMBED_SIZE = { width: 640, height: 420 };
const TEXT_SIZE = { width: 280, height: 180 };

export type MediaHost = {
  url: (path: string) => string;
  workspace: string;
  mobile: MediaQueryList;
  objects: () => ViewObject[];
  view: () => ViewState;
  dispatch: (action: ViewCommand) => void;
  available: () => boolean;
  submit: (operations: Edit[]) => boolean;
  compound: (request: CanvasRequest) => boolean;
  say: (message: string) => void;
  /** The editor's own clipboard paste, used when the system clipboard holds the canvas selection. */
  internalPaste: () => void;
  hasInternalClipboard: () => boolean;
  assetUrl: (assetId: string) => string | null;
};

const UploadSchema = z.object({
  success: z.literal(true),
  data: z.object({ assetId: z.string(), width: z.number().nullable(), height: z.number().nullable() }),
});
const RefusalSchema = z.object({ error: z.string() }).passthrough();
const PreviewSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.enum(['ready', 'unavailable']),
    title: z.string(),
    thumbnailAssetId: z.string().optional(),
  }),
});
const FrameSchema = z.object({ success: z.literal(true), data: z.object({ embedUrl: z.string() }) });
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const node = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing canvas element: ${id}`);
  return el;
};

export class MediaEditor {
  private pointer: Point | null = null;
  private pasteTimer: ReturnType<typeof setTimeout> | undefined;
  private replaceTarget: string | null = null;
  private frameUrls = new Map<string, { url: string; embedUrl: string }>();
  private frameRequests = new Map<string, Promise<string | null>>();
  private interacting: string | null = null;
  private dropTarget: HTMLElement | null = null;
  private fileInput: HTMLInputElement;

  constructor(private host: MediaHost) {
    const board = node('board');
    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = [...IMAGE_TYPES].join(',');
    this.fileInput.hidden = true;
    this.fileInput.id = 'imageFile';
    this.fileInput.onchange = () => this.picked();
    document.body.append(this.fileInput);
    board.addEventListener('pointermove', (e) => (this.pointer = { x: e.clientX, y: e.clientY }));
    board.addEventListener('pointerleave', () => (this.pointer = null));
    // In-object controls are buttons inside the board, whose pointer capture would eat their click.
    // Document capture runs before the board's own capture listeners, which stop propagation.
    document.addEventListener(
      'pointerdown',
      (e) => {
        const target = e.target instanceof Element ? e.target : null;
        this.down = {
          x: e.clientX,
          y: e.clientY,
          selected: [...this.host.view().selected],
          shield: target?.closest<HTMLElement>('.embed-shield') ?? null,
        };
        if (target?.closest('#board [data-media-action]')) e.stopPropagation();
        else if (this.interacting && !target?.closest('.embed-stage.interacting')) this.endInteraction(false);
      },
      true
    );
    document.addEventListener('pointerup', (e) => this.maybeInteract(e), true);
    board.addEventListener('click', (e) => this.action(e));
    document.addEventListener('paste', (e) => this.paste(e));
    document.addEventListener('copy', (e) => this.mark(e));
    document.addEventListener('cut', (e) => this.mark(e));
    board.addEventListener('dragover', (e) => this.dragOver(e));
    board.addEventListener('dragleave', (e) => {
      if (!(e.relatedTarget instanceof Node) || !board.contains(e.relatedTarget)) this.highlight(null);
    });
    board.addEventListener('drop', (e) => void this.drop(e));
    window.addEventListener('message', (e) => this.message(e));
    // A page that focuses itself on load would take the keyboard from the canvas.
    window.addEventListener('blur', () => {
      setTimeout(() => {
        const active = document.activeElement;
        if (active instanceof HTMLIFrameElement && active.closest('.embed-stage') && !this.interacting)
          board.focus({ preventScroll: true });
      }, 0);
    });
    const add = document.getElementById('addImage');
    if (add) add.onclick = () => this.chooseImage(null);
    const embed = document.getElementById('embedSelection');
    if (embed) embed.onclick = () => this.toggleEmbed();
    const replace = document.getElementById('replaceImage');
    if (replace) replace.onclick = () => this.chooseImage(this.single()?.id ?? null);
    const open = document.getElementById('openSubcanvas');
    if (open)
      open.onclick = () => {
        const target = this.single();
        if (target?.type === 'subcanvas') this.host.dispatch({ kind: 'enter', id: target.id });
      };
  }

  // ───────────── contextual row ─────────────
  private single(): ViewObject | undefined {
    const ids = this.host.view().selected;
    return ids.length === 1 ? this.host.objects().find((o) => o.id === ids[0]) : undefined;
  }
  paint(): void {
    const o = this.single();
    const web = o && (o.type === 'link' || o.type === 'embed') && o.content.type === o.type;
    const embed = document.getElementById('embedSelection');
    if (embed) {
      embed.hidden = this.host.mobile.matches || !web;
      embed.textContent = o?.type === 'embed' ? 'Back to link' : 'Embed';
      embed.title = o?.type === 'embed' ? 'Show as a link card' : 'Show the live page';
    }
    const replace = document.getElementById('replaceImage');
    if (replace) replace.hidden = this.host.mobile.matches || o?.type !== 'image';
    const open = document.getElementById('openSubcanvas');
    if (open) open.hidden = o?.type !== 'subcanvas';
    this.frames();
  }

  // ───────────── placement ─────────────
  /** Where a pasted or dropped object goes: the container under the point, or the open sub-canvas. */
  placement(screen: Point | null, containerId?: string | null): { parentId: string | null; at: Point } {
    const v = this.host.view();
    const point = screen ?? { x: innerWidth / 2, y: innerHeight / 2 };
    const world = screenToCanvas(v.viewport, point);
    const objects = this.host.objects();
    const parentId = containerId ?? v.root;
    const parent = parentId ? objects.find((o) => o.id === parentId) : undefined;
    if (!parent) return { parentId: null, at: world };
    const origin = worldOrigin(objects, parent),
      a = (-origin.rotation * Math.PI) / 180;
    return {
      parentId: parent.id,
      at: {
        x: (world.x - origin.x) * Math.cos(a) - (world.y - origin.y) * Math.sin(a),
        y: (world.x - origin.x) * Math.sin(a) + (world.y - origin.y) * Math.cos(a),
      },
    };
  }
  private create(
    content: Record<string, unknown> & { type: string },
    size: { width: number; height: number },
    place: { parentId: string | null; at: Point },
    index = 0
  ): string | null {
    const id = crypto.randomUUID();
    const operation = EditSchema.parse({
      kind: 'create',
      opId: crypto.randomUUID(),
      objectId: id,
      patch: {
        parentId: place.parentId,
        order: Date.now() + index,
        position: { x: place.at.x - size.width / 2 + index * 24, y: place.at.y - size.height / 2 + index * 24 },
        size,
        rotation: 0,
        lock: null,
        content,
      },
    });
    if (!this.host.submit([operation])) return null;
    this.host.dispatch({ kind: 'selection', ids: [id] });
    this.host.dispatch({ kind: 'focus', id });
    return id;
  }

  // ───────────── paste and drop ─────────────
  /** Ctrl/Cmd+V: let the browser deliver its paste event; fall back to the canvas clipboard. */
  armPaste(): void {
    clearTimeout(this.pasteTimer);
    this.pasteTimer = setTimeout(() => this.host.internalPaste(), 150);
  }
  private marker(): string | null {
    try {
      return localStorage.getItem(`${this.host.workspace}:canvas-clipboard-marker`);
    } catch {
      return null;
    }
  }
  private mark(e: ClipboardEvent): void {
    if (!(e.target instanceof Element) || !e.target.closest('#board') || !this.host.view().selected.length) return;
    const marker = `Codeman canvas selection · ${this.host.view().selected.length} · ${Date.now()}`;
    try {
      localStorage.setItem(`${this.host.workspace}:canvas-clipboard-marker`, marker);
    } catch {
      return;
    }
    e.clipboardData?.setData('text/plain', marker);
    e.preventDefault();
  }
  private paste(e: ClipboardEvent): void {
    const target = e.target instanceof Element ? e.target : null;
    if (!target?.closest('#board') || target.closest('input,textarea,select,[contenteditable]')) return;
    clearTimeout(this.pasteTimer);
    e.preventDefault();
    if (this.host.mobile.matches) return;
    const data = e.clipboardData;
    const files = [...(data?.files ?? [])];
    const plain = data?.getData('text/plain') ?? '';
    if (!files.length && plain && plain === this.marker()) return this.host.internalPaste();
    void this.insert(files, data?.getData('text/uri-list') ?? '', plain, this.pointer, null);
  }
  private containerAt(e: DragEvent): HTMLElement | null {
    const target = e.target instanceof Element ? e.target : null;
    const el = target?.closest<HTMLElement>('.object.container[data-view="in"]');
    return el ?? null;
  }
  private highlight(el: HTMLElement | null): void {
    if (this.dropTarget === el) return;
    this.dropTarget?.classList.remove('drop-target');
    this.dropTarget = el;
    el?.classList.add('drop-target');
  }
  private dragOver(e: DragEvent): void {
    const types = [...(e.dataTransfer?.types ?? [])];
    if (this.host.mobile.matches || !types.some((t) => ['Files', 'text/uri-list', 'text/plain'].includes(t))) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    this.highlight(this.containerAt(e));
  }
  private async drop(e: DragEvent): Promise<void> {
    if (this.host.mobile.matches || !e.dataTransfer) return;
    e.preventDefault();
    const containerId = this.containerAt(e)?.dataset.objectId ?? null;
    this.highlight(null);
    await this.insert(
      [...e.dataTransfer.files],
      e.dataTransfer.getData('text/uri-list'),
      e.dataTransfer.getData('text/plain'),
      { x: e.clientX, y: e.clientY },
      containerId
    );
  }
  private async insert(
    files: File[],
    uriList: string,
    plain: string,
    point: Point | null,
    containerId: string | null
  ): Promise<void> {
    if (!this.host.available()) return;
    const place = this.placement(point, containerId);
    if (files.length) {
      const images = files.filter((f) => IMAGE_TYPES.has(f.type));
      if (!images.length) return this.host.say('Only PNG, JPEG, GIF and WebP images can be added to the canvas.');
      if (images.length > MAX_PASTED_IMAGES) this.host.say(`Adding the first ${MAX_PASTED_IMAGES} images.`);
      for (const [index, file] of images.slice(0, MAX_PASTED_IMAGES).entries()) await this.addImage(file, place, index);
      return;
    }
    const firstUri = uriList
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#'));
    const url = pastedUrl(firstUri ?? plain);
    if (url) return void this.addLink(url, place);
    if (plain.trim()) {
      this.create({ type: 'text', text: plain.slice(0, 1_000_000) }, TEXT_SIZE, place);
      return;
    }
    if (this.host.hasInternalClipboard()) return this.host.internalPaste();
    this.host.say('Nothing to paste. Copy an image, a web address or some text first.');
  }

  // ───────────── images ─────────────
  private chooseImage(replace: string | null): void {
    if (!this.host.available()) return;
    this.replaceTarget = replace;
    this.fileInput.value = '';
    this.fileInput.click();
  }
  private picked(): void {
    const file = this.fileInput.files?.[0];
    if (!file) return;
    if (this.replaceTarget) void this.replaceImage(this.replaceTarget, file);
    else void this.addImage(file, this.placement(null), 0);
  }
  private async upload(file: File): Promise<{ assetId: string; width: number | null; height: number | null } | null> {
    if (!IMAGE_TYPES.has(file.type)) {
      this.host.say('Only PNG, JPEG, GIF and WebP images can be added to the canvas.');
      return null;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      this.host.say('This image is larger than 8 MB. Make it smaller, then add it again.');
      return null;
    }
    try {
      const response = await fetch(this.host.url(`/api/canvas/${this.host.workspace}/assets`), {
        method: 'POST',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      const payload: unknown = await response.json();
      const ok = UploadSchema.safeParse(payload);
      if (ok.success) return ok.data.data;
      const refusal = RefusalSchema.safeParse(payload);
      this.host.say(refusal.success ? refusal.data.error : 'The image could not be added.');
    } catch {
      this.host.say('The image could not be uploaded. Check the connection and try again.');
    }
    return null;
  }
  private async addImage(file: File, place: { parentId: string | null; at: Point }, index: number): Promise<void> {
    const asset = await this.upload(file);
    if (!asset) return;
    const size = imageCreateSize(asset.width ?? 0, asset.height ?? 0);
    const alt = file.name.replace(/\.[a-z0-9]{1,5}$/i, '').slice(0, 200);
    this.create(
      { type: 'image', url: '', alt: alt === 'image' ? '' : alt, assetId: asset.assetId },
      size,
      place,
      index
    );
  }
  private async replaceImage(id: string, file: File): Promise<void> {
    const asset = await this.upload(file);
    const object = this.host.objects().find((o) => o.id === id);
    if (!asset || !object || object.type !== 'image' || !object.size) return;
    const ratio = asset.width && asset.height ? asset.height / asset.width : object.size.height / object.size.width;
    this.update(
      object,
      { ...this.known(object), url: '', assetId: asset.assetId },
      {
        width: object.size.width,
        height: Math.max(1, Math.round(object.size.width * ratio)),
      }
    );
  }

  // ───────────── links and embeds ─────────────
  private known(object: ViewObject): Record<string, unknown> & { type: string } {
    try {
      return { ...knownContentFields(object.content) };
    } catch {
      return { ...object.content };
    }
  }
  private update(
    object: ViewObject,
    content: Record<string, unknown> & { type: string },
    size?: { width: number; height: number }
  ): boolean {
    return this.host.submit([
      EditSchema.parse({
        kind: 'update',
        opId: crypto.randomUUID(),
        objectId: object.id,
        patch: size ? { content, size } : { content },
      }),
    ]);
  }
  private addLink(url: string, place: { parentId: string | null; at: Point }): void {
    const id = this.create({ type: 'link', url, label: '', preview: 'pending' }, LINK_SIZE, place);
    if (id) void this.preview(id, url);
  }
  /** Ask the server for a title and thumbnail, then write them as an ordinary update. */
  private async preview(id: string, url: string): Promise<void> {
    let result: z.infer<typeof PreviewSchema>['data'] | null = null;
    try {
      const response = await fetch(this.host.url(`/api/canvas/${this.host.workspace}/command`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'canvas_link_preview', arguments: { url } }),
      });
      const parsed = PreviewSchema.safeParse(await response.json());
      if (parsed.success) result = parsed.data.data;
    } catch {
      /* No preview: the card keeps its bare address. */
    }
    const object = this.host.objects().find((o) => o.id === id);
    if (!object || object.type !== 'link' || text(object.content.url) !== url) return;
    const ready = result?.status === 'ready' && !!result.title;
    const content: Record<string, unknown> & { type: string } = {
      ...this.known(object),
      label: ready ? result!.title : text(object.content.label),
      preview: ready ? 'ready' : 'unavailable',
    };
    if (result?.thumbnailAssetId) content.thumbnailAssetId = result.thumbnailAssetId;
    this.update(object, content);
  }
  private toggleEmbed(): void {
    const object = this.single();
    if (!object || !this.host.available()) return;
    const url = text(object.content.url);
    const labelText = text(object.content.label);
    const thumb = text(object.content.thumbnailAssetId);
    const size = object.size;
    if (object.type === 'link') {
      const content: Record<string, unknown> & { type: string } = { type: 'embed', url };
      if (labelText) content.label = labelText;
      if (thumb) content.thumbnailAssetId = thumb;
      const grown =
        size && (size.width < EMBED_SIZE.width || size.height < EMBED_SIZE.height)
          ? { width: Math.max(size.width, EMBED_SIZE.width), height: Math.max(size.height, EMBED_SIZE.height) }
          : undefined;
      this.update(object, content, grown);
    } else if (object.type === 'embed') {
      const content: Record<string, unknown> & { type: string } = {
        type: 'link',
        url,
        label: labelText,
        preview: labelText ? 'ready' : 'unavailable',
      };
      if (thumb) content.thumbnailAssetId = thumb;
      this.update(object, content, size ? { width: Math.min(size.width, 480), height: LINK_SIZE.height } : undefined);
    }
  }
  /** A link opens in a new tab. A loopback address names the server's own machine, so only an embed reaches it. */
  openLink(object: ViewObject): void {
    const url = text(object.content.url);
    if (!pastedUrl(url)) return;
    if (isLoopbackUrl(url)) {
      this.host.say('This address is on the Codeman machine. Embed it to open it here.');
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  // ───────────── in-object actions ─────────────
  private action(e: MouseEvent): void {
    const control = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-media-action]') : null;
    if (!control) return;
    e.preventDefault();
    const object = this.host.objects().find((o) => o.id === control.dataset.objectRef);
    if (!object) return;
    switch (control.dataset.mediaAction) {
      case 'open-subcanvas':
        this.host.dispatch({ kind: 'enter', id: object.id });
        break;
      case 'open':
        this.openLink(object);
        break;
      case 'reload': {
        const frame = this.frameOf(object.id);
        if (frame) frame.setAttribute('src', frame.getAttribute('src') ?? '');
        break;
      }
      case 'to-link':
        this.host.dispatch({ kind: 'selection', ids: [object.id] });
        this.toggleEmbed();
        break;
    }
    node('board').focus({ preventScroll: true });
  }

  // ───────────── live frames ─────────────
  private frameOf(id: string): HTMLIFrameElement | null {
    return document.querySelector<HTMLIFrameElement>(`[data-object-id="${CSS.escape(id)}"] .embed-stage > iframe`);
  }
  /** Keep at most six frames live: visible embeds nearest the middle of the screen. */
  frames(): void {
    const layer = document.getElementById('layer');
    if (!layer) return;
    const embeds = [...layer.querySelectorAll<HTMLElement>('.object[data-type="embed"]')];
    const middle = { x: innerWidth / 2, y: innerHeight / 2 };
    const candidates = embeds
      .map((el) => ({ el, rect: el.getBoundingClientRect() }))
      .filter(
        ({ el, rect }) =>
          el.dataset.view === 'in' &&
          rect.width > 24 &&
          rect.height > 24 &&
          rect.right > 0 &&
          rect.bottom > 0 &&
          rect.left < innerWidth &&
          rect.top < innerHeight
      )
      .sort(
        (a, b) =>
          Math.hypot(a.rect.x + a.rect.width / 2 - middle.x, a.rect.y + a.rect.height / 2 - middle.y) -
          Math.hypot(b.rect.x + b.rect.width / 2 - middle.x, b.rect.y + b.rect.height / 2 - middle.y)
      );
    const live = new Set(this.host.mobile.matches ? [] : candidates.slice(0, MAX_LIVE_FRAMES).map(({ el }) => el));
    const byId = new Map(this.host.objects().map((o) => [o.id, o]));
    for (const el of embeds) {
      const body = el.querySelector<HTMLElement>(':scope > .object-body');
      const stage = body ? embedStage(body) : null;
      if (!body || !stage) continue;
      const object = byId.get(el.dataset.objectId ?? '');
      if (live.has(el) && object) this.mount(body, stage, object, text(object.content.url));
      else this.pause(body, stage, object);
    }
  }
  private pause(body: HTMLElement, stage: HTMLElement, object: ViewObject | undefined): void {
    const frame = stage.querySelector(':scope > iframe');
    if (!frame && stage.dataset.note === 'Paused' && stage.querySelector(':scope > .embed-card')) return;
    frame?.remove();
    stage.querySelector(':scope > .embed-shield')?.remove();
    stage.dataset.note = 'Paused';
    stage.classList.remove('live', 'interacting');
    if (object && this.interacting === object.id) this.interacting = null;
    if (object) paintEmbed(body, object, { assetUrl: this.host.assetUrl });
  }
  private mount(body: HTMLElement, stage: HTMLElement, object: ViewObject, url: string): void {
    const current = stage.querySelector<HTMLIFrameElement>(':scope > iframe');
    const known = this.frameUrls.get(object.id);
    if (current && known && known.url === url) return;
    if (stage.dataset.note !== 'Loading') {
      stage.dataset.note = 'Loading';
      paintEmbed(body, object, { assetUrl: this.host.assetUrl });
    }
    void this.frameUrl(object.id, url).then((embedUrl) => {
      if (!embedUrl || !stage.isConnected) {
        if (!embedUrl && stage.isConnected) {
          stage.dataset.note = 'Unavailable';
          paintEmbed(body, object, { assetUrl: this.host.assetUrl });
        }
        return;
      }
      if (stage.querySelector(':scope > iframe')?.getAttribute('src') === embedUrl) return;
      stage.querySelector(':scope > iframe')?.remove();
      stage.querySelector(':scope > .embed-card')?.remove();
      const frame = document.createElement('iframe');
      // No allow-same-origin: the page runs in an opaque origin and cannot read this one.
      frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox');
      frame.referrerPolicy = 'no-referrer';
      frame.tabIndex = -1;
      frame.title = label(object) || linkHost(url);
      frame.src = embedUrl;
      frame.addEventListener('load', () => {
        if (document.activeElement === frame && this.interacting !== object.id)
          node('board').focus({ preventScroll: true });
      });
      const shield = document.createElement('div');
      shield.className = 'embed-shield';
      shield.title = 'Click a selected embed to use the page · Escape returns to the canvas';
      stage.append(frame, shield);
      stage.classList.add('live');
      stage.dataset.note = '';
    });
  }
  private frameUrl(id: string, url: string): Promise<string | null> {
    const known = this.frameUrls.get(id);
    if (known?.url === url) return Promise.resolve(known.embedUrl);
    const key = `${id}\n${url}`;
    const pending = this.frameRequests.get(key);
    if (pending) return pending;
    const request = fetch(this.host.url(`/api/canvas/${this.host.workspace}/objects/${encodeURIComponent(id)}/frame`), {
      method: 'POST',
    })
      .then(async (response) => {
        const parsed = FrameSchema.safeParse(await response.json());
        if (!parsed.success) return null;
        const embedUrl = this.host.url(parsed.data.data.embedUrl);
        this.frameUrls.set(id, { url, embedUrl });
        return embedUrl;
      })
      .catch(() => null)
      .finally(() => this.frameRequests.delete(key));
    this.frameRequests.set(key, request);
    return request;
  }
  /** A click (not a drag) on an embed that was already selected hands the pointer and keys to its page. */
  private down: { x: number; y: number; selected: string[]; shield: HTMLElement | null } | null = null;
  private maybeInteract(e: PointerEvent): void {
    // The board captures the pointer, so pointerup targets the board: the shield is the one pressed.
    const down = this.down;
    const shield = down?.shield ?? null;
    const id = shield?.closest<HTMLElement>('[data-object-id]')?.dataset.objectId;
    if (!shield || !id || !down || this.host.mobile.matches || e.button !== 0) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
    if (down.selected.length !== 1 || down.selected[0] !== id) return;
    // Defer so the board's own pointerup (selection) runs first.
    setTimeout(() => {
      const view = this.host.view();
      if (view.selected.length !== 1 || view.selected[0] !== id) return;
      const stage = shield.parentElement;
      const frame = stage?.querySelector<HTMLIFrameElement>(':scope > iframe');
      if (!stage || !frame) return;
      this.interacting = id;
      stage.classList.add('interacting');
      frame.tabIndex = 0;
      frame.focus();
    }, 0);
  }
  private endInteraction(focusBoard: boolean): void {
    const id = this.interacting;
    this.interacting = null;
    if (!id) return;
    const frame = this.frameOf(id);
    frame?.parentElement?.classList.remove('interacting');
    if (frame) frame.tabIndex = -1;
    if (focusBoard) node('board').focus({ preventScroll: true });
  }
  private message(e: MessageEvent): void {
    if (!e.data || typeof e.data !== 'object' || (e.data as { type?: unknown }).type !== 'codeman:canvas-escape')
      return;
    const frame = [...document.querySelectorAll<HTMLIFrameElement>('.embed-stage > iframe')].find(
      (candidate) => candidate.contentWindow === e.source
    );
    if (!frame) return;
    this.endInteraction(true);
  }
  get interactingId(): string | null {
    return this.interacting;
  }
  escape(): boolean {
    if (!this.interacting) return false;
    this.endInteraction(true);
    return true;
  }
  /** Stop live frames whose object was removed; called after every render. */
  forget(ids: Set<string>): void {
    for (const id of [...this.frameUrls.keys()]) if (!ids.has(id)) this.frameUrls.delete(id);
  }
}
