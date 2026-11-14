/**
 * @fileoverview The canvas side of the frame bridge (`src/canvas/frame-bridge.ts`): what a frame may say,
 * parsed and bounded, and the arithmetic between screen pixels and a frame's own viewport.
 *
 * The page inside a frame can post any of these messages itself, so nothing here is trusted. A message
 * that is not exactly one of the shapes below, or that carries more than the bounds allow, parses to
 * null and is dropped. Every string that survives was written by the page: render it with `textContent`.
 */
import { z } from 'zod';
import { ElementRefSchema, MAX_ELEMENT_REFS, type ElementRef } from '../../../src/canvas/element-ref.js';
import { hit, type Point, type Rect } from './viewport.js';

/** A sandboxed frame without `allow-same-origin` has an opaque origin, which a message reports as this. */
export const FRAME_ORIGIN = 'null';
export const MAX_LOCATE_SELECTORS = 64;
export const MAX_POLYGON_POINTS = 1024;
/** How long the canvas waits for a frame to answer before it acts as if the frame had nothing to say. */
export const FRAME_REPLY_MS = 800;

const RequestId = z.string().min(1).max(64);
const RectSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
  })
  .strict();
const FrameElementSchema = ElementRefSchema.omit({ objectId: true });
const WireSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('codeman:canvas-escape') }).strict(),
  z.object({ type: z.literal('codeman:frame-ready') }).strict(),
  z.object({ type: z.literal('codeman:frame-key'), key: z.literal('q'), phase: z.enum(['down', 'up']) }).strict(),
  z.object({ type: z.literal('codeman:frame-picked'), element: FrameElementSchema }).strict(),
  z.object({ type: z.literal('codeman:frame-pick-cancelled') }).strict(),
  z
    .object({
      type: z.literal('codeman:frame-elements'),
      requestId: RequestId,
      elements: z.array(FrameElementSchema).max(MAX_ELEMENT_REFS),
    })
    .strict(),
  z
    .object({
      type: z.literal('codeman:frame-rects'),
      requestId: RequestId,
      rects: z.array(RectSchema.nullable()).max(MAX_LOCATE_SELECTORS),
    })
    .strict(),
  z.object({ type: z.literal('codeman:frame-rects-changed') }).strict(),
]);

export type FrameMessage =
  | { type: 'escape' }
  | { type: 'ready' }
  | { type: 'key'; phase: 'down' | 'up' }
  | { type: 'picked'; element: ElementRef }
  | { type: 'pick-cancelled' }
  | { type: 'elements'; requestId: string; elements: ElementRef[] }
  | { type: 'rects'; requestId: string; rects: (Rect | null)[] }
  | { type: 'rects-changed' };

/**
 * One message from the frame that shows `objectId`, or null. The frame never names its own object: the
 * canvas knows which frame spoke and stamps the id itself.
 */
export function parseFrameMessage(data: unknown, objectId: string): FrameMessage | null {
  const parsed = WireSchema.safeParse(data);
  if (!parsed.success) return null;
  const message = parsed.data;
  const ref = (element: z.infer<typeof FrameElementSchema>): ElementRef | null => {
    const made = ElementRefSchema.safeParse({ ...element, objectId });
    return made.success ? made.data : null;
  };
  switch (message.type) {
    case 'codeman:canvas-escape':
      return { type: 'escape' };
    case 'codeman:frame-ready':
      return { type: 'ready' };
    case 'codeman:frame-key':
      return { type: 'key', phase: message.phase };
    case 'codeman:frame-pick-cancelled':
      return { type: 'pick-cancelled' };
    case 'codeman:frame-rects-changed':
      return { type: 'rects-changed' };
    case 'codeman:frame-rects':
      return { type: 'rects', requestId: message.requestId, rects: message.rects };
    case 'codeman:frame-picked': {
      const element = ref(message.element);
      return element ? { type: 'picked', element } : null;
    }
    case 'codeman:frame-elements': {
      const elements = message.elements.map(ref);
      return elements.every((e): e is ElementRef => e !== null)
        ? { type: 'elements', requestId: message.requestId, elements }
        : null;
    }
  }
}

/** A live frame on screen: where its viewport sits, and how many screen pixels one of its pixels covers. */
export type FrameBox = { id: string; rect: Rect; scale: number };
/**
 * The box of a frame whose stage measures `rect` on screen and lays out `width` CSS pixels across.
 * A rotated frame has no such box: its screen rectangle is not its viewport.
 */
export function frameBox(id: string, rect: Rect, width: number, rotation: number): FrameBox | null {
  if (!(width > 0) || !(rect.width > 0) || !(rect.height > 0) || ((rotation % 360) + 360) % 360 !== 0) return null;
  return { id, rect, scale: rect.width / width };
}
export const toFramePoint = (box: FrameBox, p: Point): Point => ({
  x: (p.x - box.rect.x) / box.scale,
  y: (p.y - box.rect.y) / box.scale,
});
export const toScreenRect = (box: FrameBox, r: Rect): Rect => ({
  x: box.rect.x + r.x * box.scale,
  y: box.rect.y + r.y * box.scale,
  width: r.width * box.scale,
  height: r.height * box.scale,
});
/** The part of a rectangle that falls inside the frame's own box, or null when none of it does. */
export function clipToFrame(box: FrameBox, r: Rect): Rect | null {
  const x = Math.max(r.x, box.rect.x),
    y = Math.max(r.y, box.rect.y);
  const right = Math.min(r.x + r.width, box.rect.x + box.rect.width),
    bottom = Math.min(r.y + r.height, box.rect.y + box.rect.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}
/**
 * The frame a loop was drawn in: the one whose box holds every point of it, when the loop takes in no
 * canvas object other than that frame's own embed. A loop that leaves the frame, even by one sample, or
 * that also circles something lying on top of it, is a loop around canvas objects. `objectHits` is what
 * the loop captures as objects; frames are given front-most first.
 */
export function loopFrame(points: Point[], frames: FrameBox[], objectHits: string[]): FrameBox | null {
  if (points.length < 3) return null;
  const frame = frames.find((candidate) => points.every((p) => hit(candidate.rect, p)));
  return frame && objectHits.every((id) => id === frame.id) ? frame : null;
}
/** A loop in a frame's own pixels, thinned to what one message may carry. */
export function framePolygon(box: FrameBox, points: Point[]): [number, number][] {
  const step = Math.ceil(points.length / MAX_POLYGON_POINTS);
  return points.filter((_, i) => i % step === 0).map((p) => [toFramePoint(box, p).x, toFramePoint(box, p).y]);
}

/** Replies matched to their request by id. One that does not come in time resolves to null. */
export class FrameReplies<T> {
  private waiting = new Map<string, { frame: unknown; done: (value: T | null) => void }>();
  constructor(
    private makeId: () => string,
    private timeoutMs = FRAME_REPLY_MS
  ) {}
  /** `frame` is whoever was asked; only an answer from the same one settles the request. */
  ask(frame: unknown, send: (requestId: string) => void): Promise<T | null> {
    const requestId = this.makeId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(requestId, frame, null), this.timeoutMs);
      this.waiting.set(requestId, {
        frame,
        done: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
      send(requestId);
    });
  }
  settle(requestId: string, frame: unknown, value: T | null): boolean {
    const entry = this.waiting.get(requestId);
    if (!entry || entry.frame !== frame) return false;
    this.waiting.delete(requestId);
    entry.done(value);
    return true;
  }
  /** A frame that went away answers nothing more. */
  drop(frame: unknown): void {
    for (const [requestId, entry] of this.waiting) if (entry.frame === frame) this.settle(requestId, frame, null);
  }
}
