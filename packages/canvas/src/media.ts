/**
 * @fileoverview Desktop media editing: paste and drop of images, URLs and text, image upload
 * and replacement, link previews, link ↔ embed conversion, and the live embed frames.
 *
 * Every write goes through the editor's own submit/compound path, so nothing here is a second
 * write path. Live frames are a view concern: at most `MAX_LIVE_FRAMES` embeds nearest the
 * middle of the viewport hold an iframe; the rest show their card with "Paused". A frame never
 * takes focus by itself: a shield covers it until a click on an already selected embed, and
 * Escape inside the page (relayed by the frame bridge) hands focus back to the board.
 *
 * The frame bridge (`src/canvas/frame-bridge.ts`) is the only channel into a frame. A message is
 * taken only from the window of a frame this editor mounted, only with the opaque origin a
 * sandboxed frame has, and only when `parseFrameMessage` accepts its shape and size. What a frame
 * reports is the page's own text: it reaches the DOM through `textContent` and nothing else.
 */
import { uuid } from './ids.js';
import type { PhoneQuery } from './mobile.js';
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
import { screenToCanvas, type Point, type Rect } from './viewport.js';
import { elementLabel, type ElementRef } from '../../../src/canvas/element-ref.js';
import { parsePrototypeAddress } from '../../../src/canvas/prototype-address.js';
import type { PageSlot } from '../../../src/canvas/view-schema.js';
import { FrameLoader } from './frame-loader.js';
import {
  clipToFrame,
  FRAME_ORIGIN,
  frameBox,
  framePolygon,
  FrameReplies,
  MAX_LOCATE_SELECTORS,
  parseFrameMessage,
  toScreenRect,
  type FrameBox,
} from './frame-messages.js';

export const MAX_LIVE_FRAMES = 6;
/**
 * Exactly an untrusted web tab's list (webview-tabs.js). No allow-same-origin: the page runs in
 * an opaque origin and cannot read Codeman's. No allow-popups-to-escape-sandbox: a popup keeps
 * this sandbox, so a page cannot open its own /webview/ URL as a top-level document on
 * Codeman's origin with the login cookie.
 */
export const EMBED_SANDBOX = 'allow-scripts allow-forms allow-popups allow-downloads allow-modals';
/**
 * The one place a frame for an embed's page is made, for the board and for the page slots: the sandbox, the
 * referrer policy and the tab order are the same wherever the page is shown.
 */
export function createEmbedFrame(title: string, embedUrl: string): HTMLIFrameElement {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', EMBED_SANDBOX);
  frame.referrerPolicy = 'no-referrer';
  frame.tabIndex = -1;
  frame.title = title;
  frame.src = embedUrl;
  return frame;
}
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_PASTED_IMAGES = 10;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const LINK_SIZE = { width: 320, height: 96 };
const EMBED_SIZE = { width: 640, height: 420 };
const TEXT_SIZE = { width: 280, height: 180 };

export type MediaHost = {
  url: (path: string) => string;
  workspace: string;
  mobile: PhoneQuery;
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

/** Something a person can do with an element they picked; the popover lists these in the order they were added. */
export type PickAction = { id: string; label: string; primary?: boolean; run: (element: ElementRef) => void };
/** What the page wires to the frame bridge beyond this editor: the hold-Q lasso. */
export type FrameHooks = {
  /** The frame in use reported bare Q going down or up. */
  key?: (objectId: string, phase: 'down' | 'up') => void;
  /** Escape was pressed inside a frame. True when it was used up and the frame keeps the keyboard. */
  escape?: () => boolean;
  /** Publishes this tab's view now; resolves when the server has answered. */
  publishView?: () => Promise<void>;
  /** A person asked for an embed's page in the rail or the full view, from the control they pressed. */
  openPage?: (objectId: string, slot: PageSlot, opener: HTMLElement) => void;
  /** The frames of the page slots. They are mounted elsewhere and heard here, through the one receiver. */
  slots?: SlotFrameRegistry;
};
/**
 * What the one message receiver needs from the page slots. A slot frame is heard for two things only, that
 * its bridge runs and that Escape was pressed in it: it has no pick, no lasso and no element reply.
 */
export type SlotFrameRegistry = {
  find(source: MessageEventSource): { frame: HTMLIFrameElement; objectId: string } | null;
  heard(frame: HTMLIFrameElement, type: 'ready' | 'escape'): void;
  /** An embed's Reload reloads the slots that show it too. */
  reload(objectId: string): void;
};
const FLASH_MS = 1200;

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
  /** Frame addresses, shared with the page slots so an embed has one address wherever it shows. */
  readonly loader: FrameLoader;
  /** The tab is in the background: no frame is live until it is shown again. */
  private suspended = false;
  private interacting: string | null = null;
  private dropTarget: HTMLElement | null = null;
  private fileInput: HTMLInputElement;
  /** Frames whose bridge has spoken: a page that blocks the injected script never does. */
  private bridged = new WeakSet<HTMLIFrameElement>();
  private hooks: FrameHooks = {};
  private picking: { id: string; done: (element: ElementRef | null) => void } | null = null;
  private offered: { element: ElementRef; view: string } | null = null;
  private pickActions: PickAction[] = [];
  private pickListeners = new Set<(element: ElementRef) => void>();
  private frameListeners = new Set<(objectId: string) => void>();
  private elementReplies = new FrameReplies<ElementRef[]>(uuid);
  private rectReplies = new FrameReplies<(Rect | null)[]>(uuid);
  private flashTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private host: MediaHost) {
    this.loader = new FrameLoader({
      url: host.url,
      workspace: host.workspace,
      publishView: () => this.hooks.publishView?.() ?? Promise.resolve(),
    });
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
          moved: false,
        };
        if (this.offered && !target?.closest('#elementPopover')) this.closeOffer(false);
        if (this.picking && !target?.closest('.embed-stage.picking, [data-media-action="pick"]')) this.endPick(null);
        if (target?.closest('#board [data-media-action]')) e.stopPropagation();
        else if (this.interacting && !target?.closest('.embed-stage.interacting')) this.endInteraction(false);
      },
      true
    );
    // A loop that ends where it began is still a drag: what counts is how far the pointer went, not where it stopped.
    document.addEventListener(
      'pointermove',
      (e) => {
        if (this.down && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 4) this.down.moved = true;
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
        // Focus inside one of our frames still counts as this document's; anything else is the person leaving.
        if (!document.hasFocus()) {
          this.endPick(null);
          this.closeOffer(false);
        }
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
      // A prototype has no address a link card could open, and the server refuses the switch.
      embed.hidden = this.host.mobile.matches || !web || !!parsePrototypeAddress(text(o.content.url));
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
    const id = uuid();
    const operation = EditSchema.parse({
      kind: 'create',
      opId: uuid(),
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
        opId: uuid(),
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
      const message =
        object.type === 'embed'
          ? 'This address is on the Codeman machine, so it opens only inside the canvas.'
          : 'This address is on the Codeman machine. Embed it to open it here.';
      // A double-click selects first; the paint that clears a stale refusal runs in the next
      // frame, so the refusal is said after it rather than wiped by it.
      requestAnimationFrame(() => this.host.say(message));
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
        // Ask for the frame again: the address this page holds may have been retired by the server.
        this.loader.reload(object.id);
        this.unmount(this.frameOf(object.id));
        this.frames();
        this.hooks.slots?.reload(object.id);
        break;
      }
      case 'dock':
      case 'full':
        this.hooks.openPage?.(object.id, control.dataset.mediaAction === 'dock' ? 'rail' : 'full', control);
        // The slot decides where the keyboard goes; the board does not take it back below.
        return;
      case 'pick':
        this.host.dispatch({ kind: 'selection', ids: [object.id] });
        this.togglePick(object.id);
        // The popover or the page takes over from here; the board keeps the keyboard so Escape cancels.
        break;
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
    const live = new Set(
      this.host.mobile.matches || this.suspended ? [] : candidates.slice(0, MAX_LIVE_FRAMES).map(({ el }) => el)
    );
    const byId = new Map(this.host.objects().map((o) => [o.id, o]));
    for (const el of embeds) {
      const body = el.querySelector<HTMLElement>(':scope > .object-body');
      const stage = body ? embedStage(body) : null;
      if (!body || !stage) continue;
      const object = byId.get(el.dataset.objectId ?? '');
      if (live.has(el) && object) this.mount(body, stage, object, text(object.content.url));
      else this.pause(body, stage, object);
    }
    this.syncPick();
  }
  private unmount(frame: Element | null | undefined): void {
    if (!(frame instanceof HTMLIFrameElement)) return;
    this.elementReplies.drop(frame);
    this.rectReplies.drop(frame);
    this.loader.release(frame);
    frame.remove();
  }
  private pause(body: HTMLElement, stage: HTMLElement, object: ViewObject | undefined): void {
    const frame = stage.querySelector(':scope > iframe');
    if (!frame && stage.dataset.note === 'Paused' && stage.querySelector(':scope > .embed-card')) return;
    this.unmount(frame);
    stage.querySelector(':scope > .embed-shield')?.remove();
    stage.dataset.note = 'Paused';
    stage.classList.remove('live', 'interacting', 'picking', 'shielded');
    if (object && this.interacting === object.id) this.interacting = null;
    if (object) paintEmbed(body, object, { assetUrl: this.host.assetUrl });
  }
  private mount(body: HTMLElement, stage: HTMLElement, object: ViewObject, url: string): void {
    const current = stage.querySelector<HTMLIFrameElement>(':scope > iframe');
    if (current && this.loader.held(object.id, url)) return;
    const note = (words: string): void => {
      if (stage.dataset.note === words) return;
      stage.dataset.note = words;
      paintEmbed(body, object, { assetUrl: this.host.assetUrl });
    };
    // Two frames in a row never spoke: the page stays unavailable until Reload asks again.
    if (this.loader.unavailable(object.id, url)) return note('Unavailable');
    note('Loading');
    void this.loader.address(object.id, url).then((embedUrl) => {
      if (!embedUrl || !stage.isConnected || this.suspended) {
        if (!embedUrl && stage.isConnected) note('Unavailable');
        return;
      }
      if (stage.querySelector(':scope > iframe')?.getAttribute('src') === embedUrl) return;
      this.unmount(stage.querySelector(':scope > iframe'));
      stage.querySelector(':scope > .embed-card')?.remove();
      stage.querySelector(':scope > .embed-shield')?.remove();
      const frame = createEmbedFrame(label(object) || linkHost(url), embedUrl);
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
      // A prototype whose frame never reports its bridge holds an address the server has retired.
      this.loader.watch(frame, object.id, url, () => {
        this.unmount(frame);
        stage.classList.remove('live', 'interacting', 'picking', 'shielded');
        if (this.interacting === object.id) this.interacting = null;
        this.frames();
      });
    });
  }
  /** A hidden tab keeps no live frame; showing it again mounts them afresh. A page's own state is lost. */
  suspend(on: boolean): void {
    if (this.suspended === on) return;
    this.suspended = on;
    if (on) this.loader.forgetAll();
    this.frames();
  }
  /** A click (not a drag) on an embed that was already selected hands the pointer and keys to its page. */
  private down: { x: number; y: number; selected: string[]; shield: HTMLElement | null; moved: boolean } | null = null;
  private maybeInteract(e: PointerEvent): void {
    // The board captures the pointer, so pointerup targets the board: the shield is the one pressed.
    const down = this.down;
    const shield = down?.shield ?? null;
    const id = shield?.closest<HTMLElement>('[data-object-id]')?.dataset.objectId;
    if (!shield || !id || !down || this.host.mobile.matches || e.button !== 0) return;
    if (down.moved || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
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
    // Only a frame this editor mounted may speak, and only as the opaque origin its sandbox gives it.
    if (e.origin !== FRAME_ORIGIN || !e.source) return;
    const frame = [...document.querySelectorAll<HTMLIFrameElement>('.embed-stage > iframe')].find(
      (candidate) => candidate.contentWindow === e.source
    );
    if (!frame) {
      // A page slot's frame goes through the same parser and is heard for less: no pick, no lasso, no reply.
      const slot = this.hooks.slots?.find(e.source);
      const said = slot ? parseFrameMessage(e.data, slot.objectId) : null;
      if (slot && said?.type === 'ready') this.loader.spoke(slot.frame);
      if (slot && (said?.type === 'ready' || said?.type === 'escape')) this.hooks.slots?.heard(slot.frame, said.type);
      return;
    }
    const objectId = frame?.closest<HTMLElement>('[data-object-id]')?.dataset.objectId;
    const message = frame && objectId ? parseFrameMessage(e.data, objectId) : null;
    if (!frame || !objectId || !message) return;
    switch (message.type) {
      case 'ready':
        this.bridged.add(frame);
        this.loader.spoke(frame);
        break;
      case 'escape':
        // A lasso the frame armed ends first, and the page keeps the keyboard.
        if (this.interacting === objectId && this.hooks.escape?.()) break;
        this.endInteraction(true);
        // Escape from any of our frames hands the keys back, even one that took focus by itself.
        if (document.activeElement === frame) node('board').focus({ preventScroll: true });
        break;
      case 'key':
        // Only the frame the person is using speaks for the keyboard.
        if (this.interacting === objectId && !this.host.mobile.matches) this.hooks.key?.(objectId, message.phase);
        break;
      case 'picked':
        if (this.picking?.id === objectId) this.endPick(message.element);
        break;
      case 'pick-cancelled':
        if (this.picking?.id === objectId) this.endPick(null);
        break;
      case 'elements':
        this.elementReplies.settle(message.requestId, frame, message.elements);
        break;
      case 'rects':
        this.rectReplies.settle(message.requestId, frame, message.rects);
        break;
      case 'rects-changed':
        if (this.offered?.element.objectId === objectId) this.closeOffer(false);
        for (const listener of this.frameListeners) listener(objectId);
        break;
    }
  }
  get interactingId(): string | null {
    return this.interacting;
  }
  escape(): boolean {
    if (this.offered) {
      this.closeOffer(true);
      return true;
    }
    if (this.picking) {
      this.endPick(null);
      return true;
    }
    if (!this.interacting) return false;
    this.endInteraction(true);
    return true;
  }

  // ───────────── the frame bridge: pick, locate, lasso ─────────────
  connect(hooks: FrameHooks): void {
    this.hooks = { ...this.hooks, ...hooks };
  }
  private liveFrame(id: string): HTMLIFrameElement | null {
    return this.host.mobile.matches ? null : this.frameOf(id);
  }
  private send(frame: HTMLIFrameElement, message: Record<string, unknown>): void {
    // The frame's origin is opaque, so no target origin can name it; the bridge checks that its parent sent this.
    frame.contentWindow?.postMessage(message, '*');
  }
  /** Where each live, unrotated frame sits on screen, front-most first. */
  frameBoxes(): FrameBox[] {
    if (this.host.mobile.matches) return [];
    const byId = new Map(this.host.objects().map((o) => [o.id, o]));
    const boxes: FrameBox[] = [];
    for (const stage of document.querySelectorAll<HTMLElement>('#layer .embed-stage.live')) {
      const el = stage.closest<HTMLElement>('[data-object-id]');
      const object = byId.get(el?.dataset.objectId ?? '');
      if (!el || !object || el.dataset.view !== 'in' || !stage.querySelector(':scope > iframe')) continue;
      const r = stage.getBoundingClientRect();
      const box = frameBox(
        object.id,
        { x: r.x, y: r.y, width: r.width, height: r.height },
        stage.offsetWidth,
        worldOrigin(this.host.objects(), object).rotation
      );
      if (box) boxes.unshift(box);
    }
    return boxes;
  }
  private boxOf(id: string): FrameBox | null {
    return this.frameBoxes().find((box) => box.id === id) ?? null;
  }
  /** A rectangle in a frame's own pixels as it shows on screen, cut to the frame; null when none of it shows. */
  screenRect(objectId: string, rect: Rect): Rect | null {
    const box = this.boxOf(objectId);
    return box ? clipToFrame(box, toScreenRect(box, rect)) : null;
  }
  /** Where the frame finds each selector now, in its own pixels. Null when the frame is not live or does not answer. */
  locate(objectId: string, selectors: string[]): Promise<(Rect | null)[] | null> {
    const frame = this.liveFrame(objectId);
    if (!frame) return Promise.resolve(null);
    return this.rectReplies.ask(frame, (requestId) =>
      this.send(frame, { type: 'codeman:locate', requestId, selectors: selectors.slice(0, MAX_LOCATE_SELECTORS) })
    );
  }
  /** Elements whose centres fall inside a loop drawn on screen. Null when the frame is not live or does not answer. */
  elementsIn(objectId: string, screenPoints: Point[]): Promise<ElementRef[] | null> {
    const frame = this.liveFrame(objectId);
    const box = this.boxOf(objectId);
    if (!frame || !box) return Promise.resolve(null);
    return this.elementReplies.ask(frame, (requestId) =>
      this.send(frame, { type: 'codeman:query-polygon', requestId, points: framePolygon(box, screenPoints) })
    );
  }
  /** Tells a listener that a frame scrolled or resized, so rectangles read from it are stale. */
  onFrameChange(listener: (objectId: string) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }
  /** Called with every element a person picks, before the popover offers its actions. */
  onPicked(listener: (element: ElementRef) => void): () => void {
    this.pickListeners.add(listener);
    return () => this.pickListeners.delete(listener);
  }
  /** Adds an action to the popover a picked element shows. */
  addPickAction(action: PickAction): () => void {
    this.pickActions = [...this.pickActions.filter((a) => a.id !== action.id), action];
    return () => {
      this.pickActions = this.pickActions.filter((a) => a !== action);
    };
  }
  /**
   * Lets the person point at one element in a live frame. Resolves with it, or with null when picking
   * ended any other way (Escape, a click elsewhere, the selection or the frame changing, the window losing focus).
   */
  pickElement(objectId: string): Promise<ElementRef | null> {
    this.endPick(null);
    this.closeOffer(false);
    const frame = this.liveFrame(objectId);
    if (!frame) return Promise.resolve(null);
    return new Promise((done) => {
      this.picking = { id: objectId, done };
      frame.parentElement?.classList.add('picking');
      this.send(frame, { type: 'codeman:pick-start' });
      this.paintPick();
    });
  }
  get pickingId(): string | null {
    return this.picking?.id ?? null;
  }
  /** Pick element as the head button and the I key run it: pick, then offer what can be done with the element. */
  togglePick(objectId: string): void {
    if (this.picking?.id === objectId) return this.endPick(null);
    const frame = this.liveFrame(objectId);
    if (!frame) return this.host.say('This page is paused. Bring it to the middle of the view, then pick an element.');
    if (!this.bridged.has(frame))
      return this.host.say('This page has not answered Codeman, so its elements cannot be picked.');
    void this.pickElement(objectId).then((element) => {
      if (element) this.offer(element);
    });
  }
  private endPick(element: ElementRef | null): void {
    const picking = this.picking;
    if (!picking) return;
    this.picking = null;
    const frame = this.frameOf(picking.id);
    frame?.parentElement?.classList.remove('picking');
    if (frame) this.send(frame, { type: 'codeman:pick-stop' });
    this.paintPick();
    if (element) for (const listener of this.pickListeners) listener(element);
    picking.done(element);
  }
  private paintPick(): void {
    for (const button of document.querySelectorAll<HTMLElement>('#board [data-media-action="pick"]')) {
      const on = button.dataset.objectRef === this.picking?.id;
      button.setAttribute('aria-pressed', String(on));
      button.title = on ? 'Cancel picking' : 'Pick element';
    }
  }
  /** Picking and its popover belong to one selected, live frame at one camera position. */
  private syncPick(): void {
    const view = this.host.view();
    const only = view.selected.length === 1 ? view.selected[0] : null;
    if (this.picking && (only !== this.picking.id || !this.liveFrame(this.picking.id))) this.endPick(null);
    if (this.picking) this.paintPick();
    const offered = this.offered;
    if (offered && (!this.liveFrame(offered.element.objectId) || offered.view !== this.viewKey()))
      this.closeOffer(false);
  }
  private viewKey(): string {
    const v = this.host.view();
    return JSON.stringify([v.viewport, v.selected, v.root]);
  }
  private outline(rect: Rect | null): void {
    const mark = node('elementMark');
    mark.hidden = !rect;
    if (!rect) return;
    mark.style.left = `${rect.x}px`;
    mark.style.top = `${rect.y}px`;
    mark.style.width = `${rect.width}px`;
    mark.style.height = `${rect.height}px`;
  }
  /** The popover for a picked element: its label and what can be done with it. Every word of the label is the page's. */
  private offer(element: ElementRef): void {
    const rect = this.screenRect(element.objectId, element.rect);
    if (!this.pickActions.length || !this.boxOf(element.objectId)) return;
    const popover = node('elementPopover');
    node('elementPopoverLabel').textContent = elementLabel(element);
    const actions = node('elementPopoverActions');
    actions.replaceChildren(
      ...this.pickActions.map((action) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.pickAction = action.id;
        button.textContent = action.label;
        if (action.primary) button.className = 'primary';
        button.onclick = () => {
          this.closeOffer(true);
          action.run(element);
        };
        return button;
      })
    );
    clearTimeout(this.flashTimer);
    this.outline(rect);
    node('elementMark').classList.remove('flash');
    popover.hidden = false;
    // Under the element when there is room, over it otherwise; an element scrolled out of the frame anchors to the frame.
    const stage = this.boxOf(element.objectId)!.rect;
    const anchor = rect ?? { x: stage.x, y: stage.y, width: 0, height: 0 };
    const size = popover.getBoundingClientRect();
    const below = anchor.y + anchor.height + 8;
    const top = below + size.height <= innerHeight - 8 ? below : Math.max(8, anchor.y - size.height - 8);
    popover.style.left = `${Math.max(8, Math.min(anchor.x, innerWidth - size.width - 8))}px`;
    popover.style.top = `${top}px`;
    this.offered = { element, view: this.viewKey() };
    actions.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }
  private closeOffer(focusBoard: boolean): void {
    if (!this.offered) return;
    this.offered = null;
    const popover = node('elementPopover');
    const held = popover.contains(document.activeElement);
    popover.hidden = true;
    this.outline(null);
    if (focusBoard || held) node('board').focus({ preventScroll: true });
  }
  /** Shows where an element is now, for a moment. False when its frame is not live or no longer has it. */
  async flash(element: ElementRef): Promise<boolean> {
    const rects = await this.locate(element.objectId, [element.selector]);
    const found = rects?.[0];
    const rect = found ? this.screenRect(element.objectId, found) : null;
    if (!rect || this.offered) return false;
    const mark = node('elementMark');
    clearTimeout(this.flashTimer);
    this.outline(rect);
    mark.classList.remove('flash');
    void mark.offsetWidth;
    mark.classList.add('flash');
    this.flashTimer = setTimeout(() => {
      mark.classList.remove('flash');
      this.outline(null);
    }, FLASH_MS);
    return true;
  }
  /** While the lasso a frame armed is held, its shield is back up so the drag reaches the board. */
  holdShield(objectId: string): void {
    this.frameOf(objectId)?.parentElement?.classList.add('shielded');
  }
  /** The hold is over: the page is in use again, with the keyboard if the board borrowed it for the drag. */
  releaseShield(objectId: string): void {
    const frame = this.frameOf(objectId);
    frame?.parentElement?.classList.remove('shielded');
    if (frame && this.interacting === objectId && document.activeElement !== frame) frame.focus();
  }
  /** Whether the keyboard is inside this frame right now. */
  frameHasKeys(objectId: string): boolean {
    const frame = this.frameOf(objectId);
    return !!frame && document.activeElement === frame && document.hasFocus();
  }
  /** Drop frame addresses of objects that are no longer embeds (removed, or switched back to a link): the server retired them. Called after every render. */
  forget(ids: Set<string>): void {
    this.loader.keep(ids);
  }
}
