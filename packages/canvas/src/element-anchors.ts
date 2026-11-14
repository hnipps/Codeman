/**
 * @fileoverview Element comments, the part with no DOM: which element each comment is about, how those
 * comments share pins over a live frame, where a pin sits, and when a frame is asked again.
 *
 * An anchor is an `ElementRef` the server keeps beside a comment (`GET .../comment-anchors`). Every string
 * in it was written by the page inside the frame: it is rendered with `textContent` and nothing else.
 */
import { z } from 'zod';
import { ElementRefSchema, type ElementRef } from '../../../src/canvas/element-ref.js';
import type { Point, Rect } from './viewport.js';

const AnswerSchema = z
  .object({ success: z.literal(true), data: z.object({ anchors: z.record(z.string(), z.unknown()) }).passthrough() })
  .passthrough();

/** The anchors route's answer by comment id, or null when it is not that answer. An entry that is not an element is left out. */
export function parseAnchors(payload: unknown): Map<string, ElementRef> | null {
  const answer = AnswerSchema.safeParse(payload);
  if (!answer.success) return null;
  const anchors = new Map<string, ElementRef>();
  for (const [commentId, value] of Object.entries(answer.data.data.anchors)) {
    const element = ElementRefSchema.safeParse(value);
    if (element.success) anchors.set(commentId, element.data);
  }
  return anchors;
}

export const sameElement = (a: ElementRef | null | undefined, b: ElementRef | null | undefined): boolean =>
  (!a && !b) || (!!a && !!b && a.objectId === b.objectId && a.selector === b.selector);

/** The anchors this page holds, by comment id. */
export class AnchorStore {
  private anchors = new Map<string, ElementRef>();
  private seen = new Set<string>();

  get(commentId: string): ElementRef | undefined {
    return this.anchors.get(commentId);
  }
  get size(): number {
    return this.anchors.size;
  }
  /** The server's answer is the whole truth: it lists an anchor only while its comment exists. */
  replace(anchors: ReadonlyMap<string, ElementRef>): void {
    this.anchors = new Map(anchors);
  }
  /** A comment this page just posted with an element, before the next read confirms it. */
  set(commentId: string, element: ElementRef): void {
    this.anchors.set(commentId, element);
  }
  /**
   * The comments changed. The anchor of a comment that went away goes with it. Answers whether a comment
   * appeared, which is when the server may hold an anchor this page has not read: a new comment, or an
   * undo that brought an anchored one back.
   */
  comments(ids: Iterable<string>): boolean {
    const now = new Set(ids);
    for (const id of this.seen) if (!now.has(id)) this.anchors.delete(id);
    let appeared = false;
    for (const id of now) if (!this.seen.has(id)) appeared = true;
    this.seen = now;
    return appeared;
  }
}

/** The comments of one embed that are about the same element: they share one pin. */
export type PinGroup = {
  objectId: string;
  selector: string;
  /** 1 for the element first commented on in this embed, 2 for the next, and so on. */
  number: number;
  /** Oldest first. */
  commentIds: string[];
  /** The element as the oldest of those comments recorded it. */
  element: ElementRef;
};

/** Pin groups by embed, in thread order. A comment with no anchor, or whose anchor names another object, has no pin. */
export function pinGroups(
  comments: readonly { id: string; objectId: string; createdAt: number }[],
  anchor: (commentId: string) => ElementRef | undefined
): Map<string, PinGroup[]> {
  const groups = new Map<string, PinGroup[]>();
  const ordered = [...comments].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  for (const comment of ordered) {
    const element = anchor(comment.id);
    if (!element || element.objectId !== comment.objectId) continue;
    const list = groups.get(comment.objectId) ?? [];
    groups.set(comment.objectId, list);
    const group = list.find((g) => g.selector === element.selector);
    if (group) group.commentIds.push(comment.id);
    else
      list.push({
        objectId: comment.objectId,
        selector: element.selector,
        number: list.length + 1,
        commentIds: [comment.id],
        element,
      });
  }
  return groups;
}

export const groupOf = (groups: ReadonlyMap<string, PinGroup[]>, objectId: string, commentId: string) =>
  groups.get(objectId)?.find((g) => g.commentIds.includes(commentId));

export const PIN_SIZE = 20;
/** How far up and to the right of the corner a pin's middle sits, so it covers little of a small element. */
export const PIN_NUDGE = 4;
/**
 * The middle of a pin for an element whose visible part is `visible` (screen pixels) in a frame at `frame`:
 * just off the element's top-right corner, moved in just enough that the whole pin stays inside the frame.
 * Null when none of the element shows or the frame is smaller than a pin.
 */
export function pinPoint(frame: Rect, visible: Rect | null, size = PIN_SIZE): Point | null {
  if (!visible || frame.width < size || frame.height < size) return null;
  const half = size / 2;
  const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);
  return {
    x: clamp(visible.x + visible.width + PIN_NUDGE, frame.x + half, frame.x + frame.width - half),
    y: clamp(visible.y - PIN_NUDGE, frame.y + half, frame.y + frame.height - half),
  };
}

/**
 * Asks each frame again at most once per animation frame, and never while its last answer is still out:
 * a request made meanwhile runs once more when that answer is in.
 */
export class Relocator {
  private dirty = new Set<string>();
  private running = new Set<string>();
  private scheduled = false;

  constructor(
    private run: (objectId: string) => Promise<void>,
    private nextFrame: (callback: () => void) => void
  ) {}

  request(objectId: string): void {
    this.dirty.add(objectId);
    this.schedule();
  }
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.nextFrame(() => this.flush());
  }
  private flush(): void {
    this.scheduled = false;
    for (const objectId of [...this.dirty]) {
      if (this.running.has(objectId)) continue;
      this.dirty.delete(objectId);
      this.running.add(objectId);
      const done = (): void => {
        this.running.delete(objectId);
        if (this.dirty.has(objectId)) this.schedule();
      };
      this.run(objectId).then(done, done);
    }
  }
}

/** The element an unposted comment is about, kept across reloads beside its draft: one per object. */
export type DraftElements = Record<string, ElementRef>;
export const MAX_STORED_DRAFT_ELEMENTS = 16;
export function parseDraftElements(raw: string | null): DraftElements {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    const kept: [string, ElementRef][] = [];
    for (const [objectId, entry] of Object.entries(value)) {
      const element = ElementRefSchema.safeParse(entry);
      if (element.success && element.data.objectId === objectId) kept.push([objectId, element.data]);
    }
    return Object.fromEntries(kept.slice(-MAX_STORED_DRAFT_ELEMENTS));
  } catch {
    return {};
  }
}
/** Null removes the object's element; the oldest go first past the bound. */
export function storeDraftElement(
  elements: DraftElements,
  objectId: string,
  element: ElementRef | null
): DraftElements {
  const rest = Object.entries(elements).filter(([id]) => id !== objectId);
  if (element) rest.push([objectId, element]);
  return Object.fromEntries(rest.slice(-MAX_STORED_DRAFT_ELEMENTS));
}
