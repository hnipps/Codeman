/**
 * @fileoverview Page slots: one embed's live page shown where canvas chrome lives, docked in the right rail
 * or over the whole canvas, so a view under design is seen at its real size and place.
 *
 * A slot shows an embed that is on the board; it is never a second kind of object and writes nothing. There
 * are two slots and each holds at most one frame, apart from the board's own six. A slot's frame is made by
 * the same function as a board frame (`createEmbedFrame`), from the same capability address, so it carries
 * the same sandbox and is never same-origin. It is heard through the media editor's one message receiver,
 * for two things only: that its bridge runs, and that Escape was pressed in it. A slot has no pick and no
 * lasso. A phone shows no live pages, so it has no slots.
 *
 * A slot's page gets the keyboard only when the person gives it: by a click on the page, or by tabbing into
 * it. Until then a shield lies over the frame, as on the board, and focus the page takes by itself is handed
 * back. Nothing the page says can lift the shield: only events in the canvas's own document do. The person
 * stops using the page when focus returns to the canvas (Escape in the page, or a click outside it).
 */
import type { PageSlot } from '../../../src/canvas/view-schema.js';
import type { FrameLoader } from './frame-loader.js';
import { createEmbedFrame, type SlotFrameRegistry } from './media.js';
import { label, type ViewObject } from './model.js';
import { embedOrigin } from './objects/embed.js';

/**
 * Why an agent's open changes nothing in this view, or null when it may open. An agent's command only steers
 * the view: it never replaces what a person is typing into, and a phone or touch view has no live pages.
 */
export function agentPageOpenRefusal(view: {
  slot: PageSlot;
  shell: boolean;
  /** The object is an embed this view holds. */
  embed: boolean;
  touch: boolean;
  typing: boolean;
}): string | null {
  if (view.touch) return 'This view is on a phone or touch device, which shows no live pages.';
  if (!view.embed) return 'This view does not hold that embed.';
  if (view.slot === 'full' && !view.shell) return 'This view is not a canvas shell page, so it has no full view.';
  if (view.typing) return 'The person is typing on the canvas. Nothing was opened; try again later.';
  return null;
}
/** Why an agent's close leaves the slot open, or null when it may close. `using` is keyboard focus inside its page. */
export const agentPageCloseRefusal = (using: boolean): string | null =>
  using ? 'The person is using that page. It was left open; try again later.' : null;

export type SlotHost = {
  loader: FrameLoader;
  objects: () => ViewObject[];
  /** False on a phone and while the tab is in the background: no frame is mounted then. */
  live: () => boolean;
  /** The keyboard should leave the page in this slot: Escape was pressed in it, or it took focus unasked. */
  release: (slot: PageSlot) => void;
};

type Shown = {
  stage: HTMLElement;
  objectId: string;
  /** The address the mounted or requested frame is for. */
  address: string | null;
  frame: HTMLIFrameElement | null;
  pending: boolean;
  /** Counts the requests made for this slot, so only the latest one's answer mounts a frame. */
  asked: number;
  failed: boolean;
  /** The person gave this page the keyboard. False puts the shield back over it. */
  using: boolean;
  shield: HTMLElement | null;
};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export class SlotFrames implements SlotFrameRegistry {
  private shown: Record<PageSlot, Shown | null> = { rail: null, full: null };
  private tabAt = 0;

  constructor(private host: SlotHost) {
    window.addEventListener('keydown', (e) => e.key === 'Tab' && (this.tabAt = Date.now()), true);
    // Focus went into a frame. A page that focuses itself would take the keyboard from the canvas; focus the
    // person gave it, by a click on its shield or by tabbing into it, stays.
    window.addEventListener('blur', () => {
      setTimeout(() => {
        const slot = this.slotOf(document.activeElement);
        const shown = slot && this.shown[slot];
        if (!slot || !shown || shown.using) return;
        if (Date.now() - this.tabAt < 250) this.use(shown, true);
        else this.host.release(slot);
      }, 0);
    });
    // Focus came back to the canvas's own document: no page is in use any more.
    document.addEventListener('focusin', () => {
      for (const shown of [this.shown.rail, this.shown.full])
        if (shown?.using && document.activeElement !== shown.frame) this.use(shown, false);
    });
  }

  private use(shown: Shown, on: boolean): void {
    shown.using = on;
    if (shown.shield) shown.shield.hidden = on;
  }

  private slotOf(frame: unknown): PageSlot | null {
    if (!(frame instanceof HTMLIFrameElement)) return null;
    return this.shown.rail?.frame === frame ? 'rail' : this.shown.full?.frame === frame ? 'full' : null;
  }

  /** Shows `objectId`'s page in a slot's stage. Showing the same page in the same stage again changes nothing. */
  show(slot: PageSlot, stage: HTMLElement, objectId: string): void {
    const current = this.shown[slot];
    if (current?.stage === stage && current.objectId === objectId) return;
    this.clear(slot);
    this.shown[slot] = {
      stage,
      objectId,
      address: null,
      frame: null,
      pending: false,
      asked: 0,
      failed: false,
      using: false,
      shield: null,
    };
    this.sync();
  }
  /** Removes the slot's frame. A frame is removed, never hidden, so a page that is not shown does not run. */
  clear(slot: PageSlot): void {
    const current = this.shown[slot];
    if (!current) return;
    this.shown[slot] = null;
    this.drop(current);
    current.stage.replaceChildren();
  }
  private drop(shown: Shown): void {
    if (shown.frame) this.host.loader.release(shown.frame);
    shown.frame?.remove();
    shown.frame = null;
    shown.shield = null;
    shown.using = false;
  }
  /** The embed a slot shows, or null. */
  objectIn(slot: PageSlot): string | null {
    return this.shown[slot]?.objectId ?? null;
  }
  /** Whether the keyboard is inside the page of this slot. */
  using(slot: PageSlot): boolean {
    const frame = this.shown[slot]?.frame;
    return !!frame && document.activeElement === frame;
  }

  private note(shown: Shown, words: string): void {
    this.drop(shown);
    const line = document.createElement('p');
    line.className = 'slot-note';
    line.textContent = words;
    shown.stage.replaceChildren(line);
  }

  /** Follows the objects after every render: a new address loads a fresh frame, a hidden tab holds none. */
  sync(): void {
    const objects = this.host.objects();
    for (const slot of ['rail', 'full'] as const) {
      const shown = this.shown[slot];
      if (!shown) continue;
      const object = objects.find((o) => o.id === shown.objectId && o.type === 'embed');
      if (!object) {
        this.note(shown, 'This page is no longer on the canvas.');
        continue;
      }
      if (!this.host.live()) {
        shown.address = null;
        shown.failed = false;
        this.note(shown, 'Paused');
        continue;
      }
      const address = text(object.content.url);
      if (shown.address === address && (shown.pending || shown.failed)) continue;
      if (shown.address === address && shown.frame && this.host.loader.held(object.id, address)) continue;
      shown.address = address;
      shown.failed = false;
      if (this.host.loader.unavailable(object.id, address)) {
        shown.failed = true;
        this.note(shown, 'Unavailable. Reload asks for the page again.');
        continue;
      }
      this.mount(slot, shown, object, address);
    }
  }
  private mount(slot: PageSlot, shown: Shown, object: ViewObject, address: string): void {
    shown.pending = true;
    const asked = ++shown.asked;
    this.note(shown, 'Loading');
    void this.host.loader.address(object.id, address).then((embedUrl) => {
      if (this.shown[slot] !== shown || shown.asked !== asked) return;
      shown.pending = false;
      if (!this.host.live()) return this.sync();
      if (!embedUrl) {
        shown.failed = true;
        return this.note(shown, 'Unavailable. Reload asks for the page again.');
      }
      const frame = createEmbedFrame(`${label(object) || embedOrigin(address)} (${slot})`, embedUrl);
      // Tab reaches the page and a click on its shield does; Escape in it returns the keyboard.
      frame.tabIndex = 0;
      frame.addEventListener('load', () => {
        if (document.activeElement === frame && !shown.using) this.host.release(slot);
      });
      const shield = document.createElement('div');
      shield.className = 'slot-shield';
      shield.title = 'Click to use this page';
      shield.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.use(shown, true);
        frame.focus({ preventScroll: true });
      });
      shown.frame = frame;
      shown.shield = shield;
      shown.stage.replaceChildren(frame, shield);
      // A prototype whose frame never reports its bridge holds an address the server has retired.
      this.host.loader.watch(frame, object.id, address, () => {
        this.drop(shown);
        shown.address = null;
        this.sync();
      });
    });
  }

  /** Reload in a slot's bar, or on the embed itself: ask the server for the page again. */
  reload(objectId: string): void {
    for (const slot of ['rail', 'full'] as const) {
      const shown = this.shown[slot];
      if (shown?.objectId !== objectId) continue;
      shown.address = null;
      shown.failed = false;
      shown.pending = false;
    }
    this.host.loader.reload(objectId);
    this.sync();
  }

  // ───────────── the one message receiver's view of the slots ─────────────
  find(source: MessageEventSource): { frame: HTMLIFrameElement; objectId: string } | null {
    for (const shown of [this.shown.rail, this.shown.full])
      if (shown?.frame && shown.frame.contentWindow === source) return { frame: shown.frame, objectId: shown.objectId };
    return null;
  }
  heard(frame: HTMLIFrameElement, type: 'ready' | 'escape'): void {
    const slot = this.slotOf(frame);
    if (!slot) return;
    if (type === 'ready') frame.dataset.bridge = 'ready';
    else this.host.release(slot);
  }
}
