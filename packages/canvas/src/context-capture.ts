import { idleLasso, lassoHits, lassoStep, type CancelReason, type LassoEvent, type LassoState } from './context.js';
import type { ViewObject } from './model.js';
import type { ViewState } from './commands.js';
import type { Point } from './viewport.js';
import type { ElementRef } from '../../../src/canvas/element-ref.js';
import { loopFrame, type FrameBox } from './frame-messages.js';

/** The live frames a lasso can reach into, as the media editor exposes them. */
export type LassoFrames = {
  boxes: () => FrameBox[];
  /** Elements inside a loop drawn on screen; null when the frame does not answer. */
  elements: (objectId: string, screenPoints: Point[]) => Promise<ElementRef[] | null>;
  /** Raise the frame's shield while a lasso it armed is held, and lower it again. */
  hold: (objectId: string) => void;
  release: (objectId: string) => void;
  /** Whether the keyboard is inside that frame right now. */
  hasKeys: (objectId: string) => boolean;
};

type Options = {
  board: HTMLElement;
  view: () => ViewState;
  objects: () => ViewObject[];
  /** Objects the current view draws; a lasso never captures what is not on screen. */
  candidates: () => ViewObject[];
  /** A key press may arm the lasso only where canvas shortcuts are allowed. */
  allowed: (e: KeyboardEvent) => boolean;
  enabled: () => boolean;
  /** `inPage` is true when a page armed the lasso: that page keeps the keyboard afterwards. */
  capture: (ids: string[], inPage: boolean) => void;
  frames?: LassoFrames;
  captureElements?: (elements: ElementRef[], inPage: boolean) => void;
};
const SVG = 'http://www.w3.org/2000/svg';
/**
 * Hold Q and drag with the primary button to loop objects into the assistant's context. It reads the
 * board and writes only pending context: no operation, selection, parent or camera is touched. Its
 * listeners run before the editor's and the pan handler's, so a lasso never also drags or selects.
 */
export class ContextCapture {
  private state: LassoState = idleLasso();
  private pointerId: number | null = null;
  private overlay: SVGSVGElement;
  private path: SVGPathElement;
  private preview = new Set<string>();
  /** The frame whose Q armed the lasso while it held the keyboard, or null when the board armed it. */
  private remote: string | null = null;
  constructor(private options: Options) {
    this.overlay = document.createElementNS(SVG, 'svg');
    this.overlay.id = 'contextGesture';
    this.overlay.setAttribute('aria-hidden', 'true');
    this.path = document.createElementNS(SVG, 'path');
    this.overlay.append(this.path);
    options.board.append(this.overlay);
    const board = options.board;
    window.addEventListener('keydown', (e) => this.keydown(e), true);
    window.addEventListener('keyup', (e) => {
      if (e.key.toLowerCase() === 'q') this.step({ type: 'disarm' });
    });
    board.addEventListener('pointerdown', (e) => this.down(e), true);
    board.addEventListener('pointermove', (e) => this.move(e), true);
    board.addEventListener('pointerup', (e) => this.up(e), true);
    board.addEventListener('pointercancel', () => this.cancel('pointercancel'), true);
    board.addEventListener('lostpointercapture', (e) => {
      if (e.pointerId === this.pointerId) this.cancel('lostcapture');
    });
    window.addEventListener('blur', () => this.cancel('blur'));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.cancel('hidden');
    });
    document.addEventListener('compositionstart', () => this.cancel('composition'), true);
  }
  get armed(): boolean {
    return this.state.armed;
  }
  get active(): boolean {
    return this.state.points !== null;
  }
  private step(event: LassoEvent) {
    const result = lassoStep(this.state, event);
    this.state = result.state;
    this.options.board.classList.toggle('lasso-armed', this.state.armed);
    if (result.cancelled || result.capture) this.clear();
    if (this.remote && !this.state.armed) {
      const frame = this.remote;
      this.remote = null;
      this.options.frames?.release(frame);
    }
    return result;
  }
  /**
   * Bare Q pressed or released inside the frame that holds the keyboard. The window is already blurred
   * then, so this is the only way the lasso hears the key. The frame's shield goes up for the hold, which
   * lets the drag reach the board.
   */
  frameKey(objectId: string, phase: 'down' | 'up'): void {
    const frames = this.options.frames;
    if (!frames || !this.options.enabled()) return;
    if (phase === 'down') {
      if (this.state.armed || !this.options.view().letters) return;
      this.remote = objectId;
      frames.hold(objectId);
      this.step({ type: 'arm' });
      return;
    }
    if (this.remote !== objectId) return;
    // The drag moves the keyboard to the board, which the frame reports as its key going up. The key is
    // still down: the board hears the real release.
    if (!frames.hasKeys(objectId) && document.hasFocus()) return;
    this.step({ type: 'disarm' });
  }
  /** Escape pressed inside a frame. True when it ended a lasso that frame armed. */
  frameEscape(): boolean {
    return this.remote !== null && this.step({ type: 'escape' }).consumed;
  }
  private cancel(reason: CancelReason): void {
    if (this.state.armed || this.state.points) this.step({ type: 'cancel', reason });
  }
  private clear(): void {
    this.path.removeAttribute('d');
    this.release();
    for (const el of this.options.board.querySelectorAll('.context-preview')) el.classList.remove('context-preview');
    this.preview.clear();
  }
  private release(): void {
    if (this.pointerId !== null && this.options.board.hasPointerCapture(this.pointerId))
      this.options.board.releasePointerCapture(this.pointerId);
    this.pointerId = null;
  }
  private keydown(e: KeyboardEvent): void {
    if (!this.options.enabled()) return;
    if (e.key === 'Escape') {
      if (this.step({ type: 'escape' }).consumed) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }
    if (e.key.toLowerCase() !== 'q' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (this.state.armed) {
      e.preventDefault();
      return;
    }
    if (!this.options.view().letters || !this.options.allowed(e)) return;
    e.preventDefault();
    this.step({ type: 'arm' });
  }
  private down(e: PointerEvent): void {
    if (!this.state.armed || e.button !== 0 || e.pointerType === 'touch' || !this.options.enabled()) return;
    const result = this.step({ type: 'down', point: { x: e.clientX, y: e.clientY } });
    if (!result.consumed) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.pointerId = e.pointerId;
    this.options.board.setPointerCapture(e.pointerId);
    this.options.board.focus({ preventScroll: true });
  }
  private move(e: PointerEvent): void {
    if (e.pointerId !== this.pointerId || !this.state.points) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.step({ type: 'move', point: { x: e.clientX, y: e.clientY } });
    this.paintPreview();
  }
  private up(e: PointerEvent): void {
    if (e.pointerId !== this.pointerId || !this.state.points) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const result = this.step({ type: 'up', point: { x: e.clientX, y: e.clientY } });
    if (result.capture) this.resolve(result.capture);
  }
  /** A loop wholly inside one live frame asks that frame for its elements; any other loop captures objects. */
  private resolve(points: Point[]): void {
    const ids = this.hits(points);
    const frames = this.options.frames;
    const inPage = this.remote !== null;
    const frame = frames ? loopFrame(points, frames.boxes(), ids) : null;
    if (!frames || !frame) {
      if (ids.length) this.options.capture(ids, inPage);
      return;
    }
    void frames.elements(frame.id, points).then((elements) => {
      if (elements?.length) this.options.captureElements?.(elements, inPage);
      // A frame with nothing in the loop, or no answer in time, stands in as a whole.
      else this.options.capture([frame.id], inPage);
    });
  }
  private hits(points: Point[]): string[] {
    return lassoHits(this.options.objects(), this.options.candidates(), points, this.options.view().viewport);
  }
  private paintPreview(): void {
    const points = this.state.points ?? [];
    this.path.setAttribute('d', `${points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ')} Z`);
    const ids = new Set(this.hits(points));
    if (ids.size === this.preview.size && [...ids].every((id) => this.preview.has(id))) return;
    this.preview = ids;
    for (const el of this.options.board.querySelectorAll<HTMLElement>('[data-object-id]'))
      el.classList.toggle('context-preview', ids.has(el.dataset.objectId ?? ''));
  }
}
