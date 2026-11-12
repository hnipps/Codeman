import { targets, inPolygon } from './select.js';
import { worldBounds } from './tree.js';
import { screenToCanvas, type Point, type Viewport } from './viewport.js';
import { label, type ViewObject } from './model.js';

/** Most objects one assistant message may carry as direct context. */
export const MAX_CONTEXT_OBJECTS = 200;
/** A lasso path is bounded; later samples are dropped, never stored. */
export const MAX_LASSO_POINTS = 1000;
/** A lasso with fewer points is a click, not a loop. */
export const MIN_LASSO_POINTS = 3;
const MIN_STEP = 2;

/** Pending context after adding ids: normalized so a child never rides beside its attached ancestor. */
export function contextAdd(objects: ViewObject[], current: string[], ids: string[]): string[] {
  const keep = new Set(targets(objects, [...current, ...ids]).map((o) => o.id));
  const merged: string[] = [];
  for (const id of [...current, ...ids]) if (keep.has(id) && !merged.includes(id)) merged.push(id);
  return merged.slice(0, MAX_CONTEXT_OBJECTS);
}
export const contextRemove = (current: string[], ids: string[]): string[] => current.filter((id) => !ids.includes(id));
/** Drops ids that no longer name a live object; the order of what remains is kept. */
export function contextPrune(objects: ViewObject[], current: string[]): string[] {
  const live = new Set(targets(objects, current).map((o) => o.id));
  return current.filter((id) => live.has(id));
}
export type Chip = { id: string; label: string; type: string; descendants: number };
export function descendantCount(objects: ViewObject[], id: string): number {
  const children = new Map<string, string[]>();
  for (const o of objects)
    if (o.parentId && o.deletedAt === null) children.set(o.parentId, [...(children.get(o.parentId) ?? []), o.id]);
  let count = 0;
  const seen = new Set([id]);
  const pending = [...(children.get(id) ?? [])];
  while (pending.length && count < 100_000) {
    const next = pending.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    count++;
    pending.push(...(children.get(next) ?? []));
  }
  return count;
}
export function chips(objects: ViewObject[], ids: string[]): Chip[] {
  const byId = new Map(objects.map((o) => [o.id, o]));
  return ids.flatMap((id) => {
    const o = byId.get(id);
    return o && o.deletedAt === null
      ? [{ id, label: label(o).slice(0, 80), type: o.type, descendants: descendantCount(objects, id) }]
      : [];
  });
}

/**
 * Objects a lasso captures: every live candidate, at any depth, whose world-bounds centre lies inside the
 * loop, then reduced so a captured container stands for its descendants. Points are client pixels and are
 * converted with the camera as it is now.
 */
export function lassoHits(
  objects: ViewObject[],
  candidates: ViewObject[],
  screenPoints: Point[],
  viewport: Viewport
): string[] {
  if (screenPoints.length < MIN_LASSO_POINTS) return [];
  const polygon = screenPoints.map((p) => screenToCanvas(viewport, p));
  const inside = candidates.filter((o) => {
    if (o.deletedAt !== null) return false;
    const r = worldBounds(objects, o);
    return inPolygon({ x: r.x + r.width / 2, y: r.y + r.height / 2 }, polygon);
  });
  return targets(
    objects,
    inside.map((o) => o.id)
  ).map((o) => o.id);
}

export type LassoState = { armed: boolean; points: Point[] | null };
export type CancelReason = 'pointercancel' | 'lostcapture' | 'blur' | 'hidden' | 'composition';
export type LassoEvent =
  | { type: 'arm' }
  | { type: 'disarm' }
  | { type: 'down'; point: Point }
  | { type: 'move'; point: Point }
  | { type: 'up'; point: Point }
  | { type: 'escape' }
  | { type: 'cancel'; reason: CancelReason };
export type LassoStep = {
  state: LassoState;
  /** The loop to resolve into context, in client pixels. */
  capture: Point[] | null;
  /** A gesture that was running ended with no change. */
  cancelled: boolean;
  /** The event was this machine's, so the page must not act on it. */
  consumed: boolean;
};
export const idleLasso = (): LassoState => ({ armed: false, points: null });
/** The hold-Q lasso as a pure machine: every way out other than a finished loop changes nothing. */
export function lassoStep(state: LassoState, event: LassoEvent): LassoStep {
  const gesture = state.points !== null;
  const stop = (armed: boolean, cancelled = gesture): LassoStep => ({
    state: { armed, points: null },
    capture: null,
    cancelled,
    consumed: cancelled,
  });
  switch (event.type) {
    case 'arm':
      return { state: { ...state, armed: true }, capture: null, cancelled: false, consumed: false };
    case 'disarm':
      return stop(false);
    case 'down':
      if (!state.armed || gesture) return { state, capture: null, cancelled: false, consumed: false };
      return { state: { armed: true, points: [event.point] }, capture: null, cancelled: false, consumed: true };
    case 'move': {
      if (!state.points) return { state, capture: null, cancelled: false, consumed: false };
      const last = state.points[state.points.length - 1];
      const far = Math.hypot(event.point.x - last.x, event.point.y - last.y) >= MIN_STEP;
      const points = far && state.points.length < MAX_LASSO_POINTS ? [...state.points, event.point] : state.points;
      return { state: { armed: state.armed, points }, capture: null, cancelled: false, consumed: true };
    }
    case 'up': {
      if (!state.points) return { state, capture: null, cancelled: false, consumed: false };
      const points = [...state.points, event.point];
      if (state.armed && points.length >= MIN_LASSO_POINTS)
        return { state: { armed: true, points: null }, capture: points, cancelled: false, consumed: true };
      return stop(state.armed);
    }
    case 'escape': {
      const handled = gesture || state.armed;
      return { ...stop(false, gesture), consumed: handled };
    }
    case 'cancel':
      return stop(event.reason === 'pointercancel' || event.reason === 'lostcapture' ? state.armed : false);
  }
}
