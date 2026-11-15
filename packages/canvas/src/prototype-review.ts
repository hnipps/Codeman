/**
 * @fileoverview Review a stored prototype on a phone: its embed's live page full screen, every touch going to the
 * page, with Back, the title and `v<n> · <author>`, a quiet Reload, a labelled Pick and Comments in one bar, and a
 * Phone / Desktop switch under it (the page at the phone's width, or at 1280 px scaled to fit and still usable).
 *
 * The frame is made by `createEmbedFrame()` from the same capability address as a board frame, so it has the same
 * sandbox and is never same-origin. It is the only live frame while the review is open: the media editor hears it
 * through its one message receiver (`ReviewFrame`), and pick, locate and the element pins talk to it. One review at
 * a time; closing removes the frame, never hides it.
 *
 * Opening shows the version the embed shows now. A version that lands while the review is open is announced
 * ("v<n> is ready · Reload") and nothing reloads by itself.
 */
import { parsePrototypeAddress } from '../../../src/canvas/prototype-address.js';
import type { ElementRef } from '../../../src/canvas/element-ref.js';
import type { FrameLoader } from './frame-loader.js';
import { frameBox, type FrameBox } from './frame-messages.js';
import { createEmbedFrame, type ReviewFrame } from './media.js';
import { label, type ViewObject } from './model.js';
import type { PrototypeVersions } from './prototype-versions.js';

/** The width the Desktop switch lays the page out at. */
export const DESKTOP_WIDTH = 1280;

export type ReviewWidth = 'phone' | 'desktop';

/** How the page is laid out in a stage of this size: its own width and height, and the scale it is drawn at. */
export function reviewLayout(
  width: ReviewWidth,
  stage: { width: number; height: number }
): { width: number; height: number; scale: number } {
  if (width === 'phone' || !(stage.width > 0) || !(stage.height > 0))
    return { width: stage.width, height: stage.height, scale: 1 };
  const scale = Math.min(1, stage.width / DESKTOP_WIDTH);
  return { width: DESKTOP_WIDTH, height: Math.round(stage.height / scale), scale };
}

/** The bar's second line: the version the page shows, and who published it when that is known. */
export const reviewMeta = (version: number, author: string | null): string =>
  author ? `v${version} · ${author}` : `v${version}`;

export type PrototypeReviewHost = {
  loader: FrameLoader;
  objects: () => ViewObject[];
  versions: PrototypeVersions;
  /** False while the tab is in the background: no frame runs then. */
  live: () => boolean;
  commentCount: (objectId: string) => number;
  /** Lets the person point at one element of the page; null when picking ended any other way. */
  pick: (objectId: string) => Promise<ElementRef | null>;
  cancelPick: () => void;
  /** An element was picked: start a comment about it. */
  picked: (element: ElementRef) => void;
  openComments: (objectId: string) => void;
  /** The review opened or closed, or its frame moved: pins and the sheet follow. */
  changed: () => void;
};

const node = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing canvas element: ${id}`);
  return el as T;
};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export class PrototypeReview implements ReviewFrame {
  private root = node('protoReview');
  private stage = node('protoReviewStage');
  private open_: { objectId: string; address: string; opener: HTMLElement | null } | null = null;
  private iframe: HTMLIFrameElement | null = null;
  private asked = 0;
  private width: ReviewWidth = 'phone';
  private picking = false;
  private resize = new ResizeObserver(() => this.layout());

  constructor(private host: PrototypeReviewHost) {
    node('protoReviewBack').onclick = () => this.close();
    node('protoReviewReload').onclick = () => this.reload();
    node('protoReviewNewReload').onclick = () => this.reload();
    node('protoReviewPick').onclick = () => this.togglePick();
    node('protoReviewCancelPick').onclick = () => this.togglePick();
    node('protoReviewComments').onclick = () => {
      if (this.open_) this.host.openComments(this.open_.objectId);
    };
    for (const [id, width] of [
      ['protoReviewPhone', 'phone'],
      ['protoReviewDesktop', 'desktop'],
    ] as const)
      node(id).onclick = () => this.setWidth(width);
    this.root.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      if (this.picking) this.togglePick();
      else this.close();
    });
    this.resize.observe(this.stage);
  }

  // ───────────── what the media editor and the pins read ─────────────
  objectId(): string | null {
    return this.open_?.objectId ?? null;
  }
  frame(): HTMLIFrameElement | null {
    return this.iframe;
  }
  box(): FrameBox | null {
    const frame = this.iframe;
    if (!frame || !this.open_) return null;
    const r = frame.getBoundingClientRect();
    return frameBox(this.open_.objectId, { x: r.x, y: r.y, width: r.width, height: r.height }, frame.offsetWidth, 0);
  }
  heard(frame: HTMLIFrameElement, type: 'ready' | 'escape'): void {
    if (frame !== this.iframe) return;
    if (type === 'ready') {
      this.stage.dataset.bridge = 'ready';
      this.paint();
    }
    // Escape in the page hands the keyboard back to the bar.
    else node('protoReviewBack').focus({ preventScroll: true });
  }
  get isOpen(): boolean {
    return !!this.open_;
  }

  /** Opens an embed's page: the version it shows now. Only a stored prototype opens here. */
  open(objectId: string, opener: HTMLElement | null): void {
    const object = this.host.objects().find((o) => o.id === objectId && o.type === 'embed');
    const address = text(object?.content.url);
    if (!object || !parsePrototypeAddress(address)) return;
    if (this.open_) this.drop();
    this.open_ = { objectId, address, opener };
    this.width = 'phone';
    this.root.hidden = false;
    document.documentElement.dataset.review = '';
    this.paint();
    this.mount();
    node('protoReviewBack').focus({ preventScroll: true });
    this.host.changed();
  }

  close(): void {
    const open = this.open_;
    if (!open) return;
    if (this.picking) this.togglePick();
    this.drop();
    this.open_ = null;
    this.root.hidden = true;
    delete document.documentElement.dataset.review;
    this.host.changed();
    if (open.opener?.isConnected && !open.opener.closest('[hidden]')) open.opener.focus({ preventScroll: true });
    else document.getElementById('board')?.focus({ preventScroll: true });
  }

  /** Follows the canvas after every render: the object going away, a new version landing, the tab hiding. */
  sync(): void {
    const open = this.open_;
    if (!open) return;
    const object = this.host.objects().find((o) => o.id === open.objectId && o.type === 'embed');
    if (!object || !parsePrototypeAddress(text(object.content.url))) return this.close();
    if (!this.host.live()) {
      if (this.iframe || this.stage.dataset.state !== 'paused') {
        this.drop();
        this.note('paused', 'Paused while Codeman is in the background.');
      }
    } else if (this.stage.dataset.state === 'paused') this.mount();
    this.paint();
  }

  private paint(): void {
    const open = this.open_;
    if (!open) return;
    const object = this.host.objects().find((o) => o.id === open.objectId);
    const shown = parsePrototypeAddress(open.address);
    const now = parsePrototypeAddress(text(object?.content.url));
    const title = (object && label(object)) || shown?.id || 'Prototype';
    if (node('protoReviewTitle').textContent !== title) node('protoReviewTitle').textContent = title;
    const meta = shown
      ? reviewMeta(shown.version, this.host.versions.get(shown.id, shown.version)?.author ?? null)
      : '';
    if (node('protoReviewMeta').textContent !== meta) node('protoReviewMeta').textContent = meta;
    const count = this.host.commentCount(open.objectId);
    node('protoReviewCount').textContent = count ? String(count) : '';
    node('protoReviewComments').setAttribute('aria-label', count === 1 ? '1 comment' : `${count} comments`);
    // A newer version is the embed's now; the page on screen stays what the person opened until they reload.
    const fresh = now && text(object?.content.url) !== open.address ? now.version : null;
    node('protoReviewNew').hidden = fresh === null;
    if (fresh !== null) node('protoReviewNewText').textContent = `v${fresh} is ready`;
    for (const [id, width] of [
      ['protoReviewPhone', 'phone'],
      ['protoReviewDesktop', 'desktop'],
    ] as const)
      node(id).setAttribute('aria-pressed', String(this.width === width));
    node('protoReviewPick').setAttribute('aria-pressed', String(this.picking));
    node('protoReviewHint').hidden = !this.picking;
    node('protoReviewPick').toggleAttribute('disabled', !this.iframe || this.stage.dataset.bridge !== 'ready');
  }

  /** Reload, in the bar or on the new-version note: the page again, at the version the embed shows now. */
  reload(): void {
    const open = this.open_;
    if (!open) return;
    const object = this.host.objects().find((o) => o.id === open.objectId);
    open.address = text(object?.content.url) || open.address;
    this.host.loader.reload(open.objectId);
    this.drop();
    this.mount();
    this.paint();
  }

  private setWidth(width: ReviewWidth): void {
    if (this.width === width) return;
    this.width = width;
    this.layout();
    this.paint();
  }

  private togglePick(): void {
    const open = this.open_;
    if (!open) return;
    if (this.picking) {
      this.picking = false;
      this.host.cancelPick();
      return this.paint();
    }
    if (!this.iframe || this.stage.dataset.bridge !== 'ready') return;
    this.picking = true;
    this.paint();
    void this.host.pick(open.objectId).then((element) => {
      this.picking = false;
      this.paint();
      if (element && this.open_?.objectId === element.objectId) this.host.picked(element);
    });
  }

  private note(state: string, words: string, retry = false): void {
    this.stage.dataset.state = state;
    const line = document.createElement('div');
    line.className = 'proto-review-note';
    const p = document.createElement('p');
    p.textContent = words;
    line.append(p);
    if (retry) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'quiet';
      button.textContent = 'Reload';
      button.onclick = () => this.reload();
      line.append(button);
    }
    this.stage.replaceChildren(line);
  }

  private drop(): void {
    const frame = this.iframe;
    this.iframe = null;
    delete this.stage.dataset.bridge;
    if (frame) {
      this.host.loader.release(frame);
      frame.remove();
    }
    this.stage.replaceChildren();
  }

  private mount(): void {
    const open = this.open_;
    if (!open) return;
    if (!this.host.live()) return this.note('paused', 'Paused while Codeman is in the background.');
    const { objectId, address } = open;
    if (this.host.loader.unavailable(objectId, address))
      return this.note('unavailable', 'This page did not load.', true);
    const asked = ++this.asked;
    this.note('loading', 'Loading the page');
    void this.host.loader.address(objectId, address).then((embedUrl) => {
      if (this.open_ !== open || this.asked !== asked || open.address !== address) return;
      if (!embedUrl) return this.note('unavailable', 'This version could not be loaded.', true);
      const object = this.host.objects().find((o) => o.id === objectId);
      const frame = createEmbedFrame(`${(object && label(object)) || 'Prototype'} (review)`, embedUrl);
      frame.tabIndex = 0;
      this.iframe = frame;
      this.stage.dataset.state = 'live';
      this.stage.replaceChildren(frame);
      this.layout();
      this.paint();
      this.host.changed();
      // A frame whose bridge never speaks holds an address the server has retired: ask once more, then say so.
      this.host.loader.watch(frame, objectId, address, (verdict) => {
        if (this.iframe !== frame) return;
        this.drop();
        if (verdict === 'ask-again') this.mount();
        else this.note('unavailable', 'This page did not load.', true);
        this.paint();
      });
    });
  }

  /** Phone: the page at the stage's own width. Desktop: 1280 px wide, scaled down to fit, as tall as the stage. */
  private layout(): void {
    const frame = this.iframe;
    this.stage.dataset.width = this.width;
    if (!frame) return;
    const size = reviewLayout(this.width, { width: this.stage.clientWidth, height: this.stage.clientHeight });
    frame.style.width = `${size.width}px`;
    frame.style.height = `${size.height}px`;
    frame.style.transform = size.scale === 1 ? '' : `scale(${size.scale})`;
    node('protoReviewWidthNote').textContent =
      this.width === 'desktop' ? `${DESKTOP_WIDTH} px at ${Math.round(size.scale * 100)}%` : '';
    this.host.changed();
  }
}
