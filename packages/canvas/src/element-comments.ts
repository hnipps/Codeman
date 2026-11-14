/**
 * @fileoverview Element comments on the page: the anchors read from the server, and one numbered pin over a
 * live frame for each element that has comments.
 *
 * Pins are a view of two things this module does not own: the comments (from the snapshot) and where the
 * frame finds each selector now (`MediaEditor.locate`, through the frame bridge). Nothing here writes to the
 * canvas. A frame is asked for all of its selectors in one message, at most once per animation frame; a pan
 * or zoom only redraws from the rectangles already held, since those are in the frame's own pixels.
 *
 * A pin shows only where its frame is what a pointer would hit at that point, so it never floats over the
 * rail, the dock or an object lying on the embed. Pins sit in `#elementPins`, a layer that takes no pointer
 * events of its own.
 */
import { z } from 'zod';
import { elementLabel, type ElementRef } from '../../../src/canvas/element-ref.js';
import type { ViewComment } from './comments.js';
import {
  AnchorStore,
  groupOf,
  parseAnchors,
  pinGroups,
  pinPoint,
  Relocator,
  type PinGroup,
} from './element-anchors.js';
import { clipToFrame, MAX_LOCATE_SELECTORS, toScreenRect, type FrameBox } from './frame-messages.js';
import type { Rect } from './viewport.js';

/** Whether the live page still has an element: `unknown` while its frame is paused, loading or silent. */
export type ElementState = 'found' | 'missing' | 'unknown';
export type AnchoredComment = { element: ElementRef; number: number; state: ElementState };

type Located = {
  frame: HTMLIFrameElement;
  asked: Set<string>;
  /** Absent for a selector the frame did not find. */
  rects: Map<string, Rect>;
  answered: boolean;
};
const ChangedSchema = z.object({ workspaceId: z.string(), anchors: z.literal(true) }).passthrough();
const key = (group: Pick<PinGroup, 'objectId' | 'selector'>): string => `${group.objectId}\n${group.selector}`;

export class ElementComments {
  private store = new AnchorStore();
  private comments: ViewComment[] = [];
  private commentSignature = '';
  private groups = new Map<string, PinGroup[]>();
  private located = new Map<string, Located>();
  private pins = new Map<string, { button: HTMLButtonElement; group: PinGroup }>();
  private layer: HTMLElement;
  private relocator: Relocator;
  /** Frames whose bridge has spoken: only in those can an element be picked. */
  private answering = new WeakSet<HTMLIFrameElement>();
  private reading = false;
  private readAgain = false;

  constructor(
    private options: {
      url: (path: string) => string;
      workspace: string;
      media: {
        locate: (objectId: string, selectors: string[]) => Promise<(Rect | null)[] | null>;
        frameBoxes: () => FrameBox[];
        onFrameChange: (listener: (objectId: string) => void) => () => void;
      };
      /** A phone holds no live frame: no pins there. */
      phone: () => boolean;
      /** A pin was used: open that embed's thread at this comment. */
      open: (objectId: string, commentId: string) => void;
      /** Which comments have an element, or what a frame says of one, changed. */
      changed: () => void;
    }
  ) {
    const layer = document.getElementById('elementPins');
    if (!layer) throw new Error('Missing canvas element: elementPins');
    this.layer = layer;
    this.relocator = new Relocator(
      (objectId) => this.relocate(objectId),
      (callback) => requestAnimationFrame(callback)
    );
    options.media.onFrameChange((objectId) => {
      const frame = this.frameOf(objectId);
      if (frame) this.answering.add(frame);
      if (this.groups.has(objectId)) this.relocator.request(objectId);
      // A frame that just answered may now be one an element can be picked in.
      else this.options.changed();
    });
    layer.addEventListener('keydown', (e) => this.keys(e));
    window.addEventListener('resize', () => requestAnimationFrame(() => this.sync()));
    document.addEventListener('visibilitychange', () => requestAnimationFrame(() => this.sync()));
  }

  /** The element a comment is about, the number on its pin, and whether the live page still has it. */
  of(commentId: string): AnchoredComment | null {
    const element = this.store.get(commentId);
    const group = element ? groupOf(this.groups, element.objectId, commentId) : undefined;
    if (!element || !group) return null;
    const at = this.located.get(element.objectId);
    const state: ElementState =
      at?.answered && at.asked.has(element.selector)
        ? at.rects.has(element.selector)
          ? 'found'
          : 'missing'
        : 'unknown';
    return { element, number: group.number, state };
  }

  /** Whether an element can be picked in this embed here and now: its page is live, upright and has answered. */
  canPick(objectId: string): boolean {
    if (this.options.phone() || !this.options.media.frameBoxes().some((box) => box.id === objectId)) return false;
    const frame = this.frameOf(objectId);
    return !!frame && this.answering.has(frame);
  }

  /** The snapshot's comments, on every change of them. */
  commentsChanged(comments: ViewComment[]): void {
    // Every edit of the board delivers the comments again; only a change of them is work.
    const signature = comments.map((c) => c.id).join('\n');
    if (signature === this.commentSignature) return;
    this.commentSignature = signature;
    this.comments = comments;
    if (this.store.comments(comments.map((c) => c.id))) void this.read();
    this.regroup();
  }

  /** `canvas:changed` as the stream delivered it: a commit that stored an anchor says so. */
  serverChanged(data: string): void {
    try {
      const parsed = ChangedSchema.safeParse(JSON.parse(data));
      if (parsed.success && parsed.data.workspaceId === this.options.workspace) void this.read();
    } catch {
      /* Not an event this page can read; the next comment change reads the anchors anyway. */
    }
  }

  /** This page posted a comment with an element and the server kept it. */
  anchored(commentId: string, element: ElementRef): void {
    this.store.set(commentId, element);
    this.regroup();
  }

  /** One read at a time; a change during a read is read once more after it, so the last answer is the newest. */
  private async read(): Promise<void> {
    if (this.reading) {
      this.readAgain = true;
      return;
    }
    this.reading = true;
    try {
      const response = await fetch(this.options.url(`/api/canvas/${this.options.workspace}/comment-anchors`));
      const anchors = response.ok ? parseAnchors(await response.json()) : null;
      if (anchors) {
        this.store.replace(anchors);
        this.regroup();
      }
    } catch {
      /* Offline: comments keep the anchors already held, and the next change reads again. */
    }
    this.reading = false;
    if (this.readAgain) {
      this.readAgain = false;
      void this.read();
    }
  }

  private regroup(): void {
    this.groups = pinGroups(this.comments, (id) => this.store.get(id));
    this.sync();
    this.options.changed();
  }

  private frameOf(objectId: string): HTMLIFrameElement | null {
    return document.querySelector<HTMLIFrameElement>(
      `#layer [data-object-id="${CSS.escape(objectId)}"] .embed-stage.live > iframe`
    );
  }

  /** Ask one frame where its commented elements are now. */
  private async relocate(objectId: string): Promise<void> {
    const frame = this.options.phone() ? null : this.frameOf(objectId);
    const selectors = (this.groups.get(objectId) ?? []).slice(0, MAX_LOCATE_SELECTORS).map((g) => g.selector);
    if (!frame || !selectors.length) return;
    const answer = await this.options.media.locate(objectId, selectors);
    // The frame was replaced while it was asked: the next sync asks the new one.
    if (this.frameOf(objectId) !== frame) return;
    const rects = new Map<string, Rect>();
    selectors.forEach((selector, index) => {
      const rect = answer?.[index];
      if (rect) rects.set(selector, rect);
    });
    this.located.set(objectId, { frame, asked: new Set(selectors), rects, answered: answer !== null });
    this.sync();
    this.options.changed();
  }

  /**
   * Put every pin where its element shows now. Called on each paint of the board, so it only reads: a frame
   * is asked again when it is a new frame or has a selector it was never asked for, and otherwise only when
   * the frame itself says its rectangles changed.
   */
  sync(): void {
    const boxes = new Map(
      this.groups.size && !this.options.phone() ? this.options.media.frameBoxes().map((box) => [box.id, box]) : []
    );
    const shown = new Set<string>();
    let forgot = false;
    for (const objectId of this.located.keys())
      if (!this.groups.has(objectId) || !boxes.has(objectId)) forgot = this.located.delete(objectId) || forgot;
    for (const [objectId, groups] of this.groups) {
      const box = boxes.get(objectId);
      const frame = box ? this.frameOf(objectId) : null;
      if (!box || !frame) continue;
      const wanted = groups.slice(0, MAX_LOCATE_SELECTORS);
      const at = this.located.get(objectId);
      const current = at?.frame === frame ? at : undefined;
      if (!current || wanted.some((g) => !current.asked.has(g.selector))) this.relocator.request(objectId);
      if (!current) continue;
      for (const group of wanted) {
        const rect = current.rects.get(group.selector);
        const point = rect ? pinPoint(box.rect, clipToFrame(box, toScreenRect(box, rect))) : null;
        if (!point || !this.shows(frame, point.x, point.y)) continue;
        const button = this.pin(group);
        button.style.left = `${point.x}px`;
        button.style.top = `${point.y}px`;
        shown.add(key(group));
      }
    }
    for (const [id, pin] of this.pins) {
      if (shown.has(id)) continue;
      const held = pin.button === document.activeElement;
      pin.button.remove();
      this.pins.delete(id);
      if (held) document.getElementById('board')?.focus({ preventScroll: true });
    }
    // One stop in the tab order: the pin last used, else the first.
    const buttons = [...this.pins.values()].map((p) => p.button);
    const stop = buttons.find((b) => b === document.activeElement) ?? buttons.find((b) => b.tabIndex === 0);
    for (const button of buttons) button.tabIndex = button === (stop ?? buttons[0]) ? 0 : -1;
    if (forgot) this.options.changed();
  }

  /** Whether the frame is what a pointer would reach at this point: nothing else is drawn over it there. */
  private shows(frame: HTMLIFrameElement, x: number, y: number): boolean {
    const top = document.elementsFromPoint(x, y).find((el) => !this.layer.contains(el));
    return !!top && !!frame.parentElement?.contains(top);
  }

  /** The button for one group. Its label is the page's own text: an attribute and `textContent`, never markup. */
  private pin(group: PinGroup): HTMLButtonElement {
    const id = key(group);
    let pin = this.pins.get(id);
    if (!pin) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'element-pin';
      button.tabIndex = -1;
      button.dataset.i18nSkip = '';
      const number = document.createElement('span');
      number.className = 'pin-number';
      const more = document.createElement('span');
      more.className = 'pin-more';
      button.append(number, more);
      button.addEventListener('click', () => {
        const current = this.pins.get(id)?.group;
        if (current) this.options.open(current.objectId, current.commentIds[0]);
      });
      pin = { button, group };
      this.pins.set(id, pin);
      this.layer.append(button);
    }
    pin.group = group;
    const { button } = pin;
    const count = group.commentIds.length;
    const signature = `${group.number}/${count}/${group.commentIds[0]}`;
    if (button.dataset.signature !== signature) {
      button.dataset.signature = signature;
      button.dataset.objectRef = group.objectId;
      button.dataset.number = String(group.number);
      button.dataset.count = String(count);
      button.children[0].textContent = String(group.number);
      // The number names the element; a badge counts its comments once there is more than one.
      button.children[1].textContent = count > 1 ? String(count) : '';
      const name = `${count === 1 ? '1 comment' : `${count} comments`} on ${elementLabel(group.element)}`;
      button.setAttribute('aria-label', `${name}. Open the thread`);
      button.title = name;
    }
    return button;
  }

  /** Arrow keys move between pins, which share one tab stop. */
  private keys(e: KeyboardEvent): void {
    const buttons = [...this.layer.querySelectorAll<HTMLButtonElement>('.element-pin')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0 || e.metaKey || e.ctrlKey || e.altKey) return;
    const next =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? buttons[(index + 1) % buttons.length]
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? buttons[(index - 1 + buttons.length) % buttons.length]
          : e.key === 'Home'
            ? buttons[0]
            : e.key === 'End'
              ? buttons.at(-1)
              : undefined;
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    for (const button of buttons) button.tabIndex = button === next ? 0 : -1;
    next.focus({ preventScroll: true });
  }
}
