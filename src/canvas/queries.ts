/** @fileoverview Bounded text inspection and world-bounds spatial queries. */
import { z } from 'zod';
import {
  bounds,
  descendants,
  effectiveLock,
  walkHierarchy,
  requireHierarchy,
  type CanvasState,
  type CanvasObject,
} from './model.js';
import { QuerySchema, ReadSchema, SearchSchema, CanvasCommandError } from './commands.js';

export const MAX_CANVAS_TEXT_BYTES = 60_000;
type Point = { x: number; y: number };
type TreeNode = { object: CanvasObject; effectiveLock: ReturnType<typeof effectiveLock>; children: TreeNode[] };
function onSegment(p: Point, a: Point, b: Point): boolean {
  return (
    Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) < 1e-8 &&
    p.x >= Math.min(a.x, b.x) &&
    p.x <= Math.max(a.x, b.x) &&
    p.y >= Math.min(a.y, b.y) &&
    p.y <= Math.max(a.y, b.y)
  );
}
function inside(p: Point, poly: Point[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (onSegment(p, a, b)) return true;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}
function crosses(a: Point, b: Point, c: Point, d: Point): boolean {
  const side = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return (
    onSegment(a, c, d) ||
    onSegment(b, c, d) ||
    onSegment(c, a, b) ||
    onSegment(d, a, b) ||
    (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0)
  );
}
function containsSegment(a: Point, b: Point, poly: Point[]): boolean {
  if (!inside(a, poly) || !inside(b, poly)) return false;
  const times = [0, 1];
  const dx = b.x - a.x,
    dy = b.y - a.y;
  for (let i = 0; i < poly.length; i++) {
    const c = poly[i],
      d = poly[(i + 1) % poly.length];
    const ex = d.x - c.x,
      ey = d.y - c.y;
    const denominator = dx * ey - dy * ex;
    if (Math.abs(denominator) < 1e-10) {
      for (const p of [c, d])
        if (onSegment(p, a, b)) times.push(Math.abs(dx) > Math.abs(dy) ? (p.x - a.x) / dx : dy ? (p.y - a.y) / dy : 0);
    } else {
      const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / denominator;
      const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / denominator;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) times.push(t);
    }
  }
  times.sort((x, y) => x - y);
  return times
    .slice(1)
    .every((t, i) => inside({ x: a.x + (dx * (t + times[i])) / 2, y: a.y + (dy * (t + times[i])) / 2 }, poly));
}
function readTargets(state: CanvasState, root?: string) {
  if (root && !state.objects[root])
    throw new CanvasCommandError([{ code: 'NOT_FOUND', objectId: root, message: 'Object identity is unavailable' }]);
  return root ? descendants(state, root, true) : Object.values(state.objects);
}
export function queryObjects(state: CanvasState, input: z.infer<typeof QuerySchema>) {
  const objects = readTargets(state, input.root);
  const poly =
    input.shape === 'point'
      ? []
      : input.shape === 'polygon'
        ? input.points
        : [
            { x: input.position.x, y: input.position.y },
            { x: input.position.x + input.size.width, y: input.position.y },
            { x: input.position.x + input.size.width, y: input.position.y + input.size.height },
            { x: input.position.x, y: input.position.y + input.size.height },
          ];
  if (input.shape === 'polygon') {
    let area = 0;
    for (let i = 0; i < poly.length; i++) {
      const next = (i + 1) % poly.length;
      area += poly[i].x * poly[next].y - poly[next].x * poly[i].y;
      for (let j = i + 1; j < poly.length; j++) {
        if (j === next || (j + 1) % poly.length === i) continue;
        if (crosses(poly[i], poly[next], poly[j], poly[(j + 1) % poly.length]))
          throw new CanvasCommandError([
            { code: 'INVALID', objectId: '', message: 'Polygon must be simple and nondegenerate' },
          ]);
      }
    }
    if (Math.abs(area) < 1e-10)
      throw new CanvasCommandError([
        { code: 'INVALID', objectId: '', message: 'Polygon must be simple and nondegenerate' },
      ]);
  }
  return objects
    .filter((o) => o.deletedAt === null)
    .map((o) => ({ id: o.id, bounds: bounds(state, o.id) }))
    .filter(({ bounds: b }) => {
      if (input.shape === 'point')
        return (
          input.point.x >= b.x &&
          input.point.x <= b.x + b.width &&
          input.point.y >= b.y &&
          input.point.y <= b.y + b.height
        );
      const box = [
        { x: b.x, y: b.y },
        { x: b.x + b.width, y: b.y },
        { x: b.x + b.width, y: b.y + b.height },
        { x: b.x, y: b.y + b.height },
      ];
      if (input.semantics === 'containment') return box.every((p, i) => containsSegment(p, box[(i + 1) % 4], poly));
      return (
        box.some((p) => inside(p, poly)) ||
        poly.some((p) => inside(p, box)) ||
        box.some((p, i) => poly.some((q, j) => crosses(p, box[(i + 1) % 4], q, poly[(j + 1) % poly.length])))
      );
    });
}
export function boundedCanvasData(data: unknown): unknown {
  const full = JSON.stringify({ data, truncated: false });
  if (Buffer.byteLength(full) <= MAX_CANVAS_TEXT_BYTES) return { data, truncated: false };
  if (Array.isArray(data)) {
    const kept: unknown[] = [];
    let used = 100;
    for (const item of data) {
      const size = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (used + size > MAX_CANVAS_TEXT_BYTES) break;
      kept.push(item);
      used += size;
    }
    return { data: kept, truncated: true };
  }
  return { data: null, truncated: true };
}
export function readTree(state: CanvasState, input: z.infer<typeof ReadSchema>) {
  const selected = readTargets(state, input.root)
    .filter((o) => input.includeDeleted || o.deletedAt === null)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const scoped = { ...state, objects: Object.fromEntries(selected.map((o) => [o.id, o])) };
  const roots = selected.filter((o) => o.parentId === null || !scoped.objects[o.parentId]);
  const objects = requireHierarchy(
    walkHierarchy(
      scoped,
      [...roots, ...selected].map((o) => o.id),
      'children'
    )
  );
  const nodes = new Map<string, TreeNode>();
  let used = 200,
    truncated = false;
  for (const object of objects) {
    const node = { object, effectiveLock: effectiveLock(state, object.id), children: [] };
    const size = Buffer.byteLength(JSON.stringify(node)) + 2;
    if (used + size > MAX_CANVAS_TEXT_BYTES - 2000) {
      truncated = true;
      continue;
    }
    nodes.set(object.id, node);
    used += size;
  }
  const tree: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(node.object.parentId ?? '');
    if (parent) parent.children.push(node);
    else tree.push(node);
  }
  const comments = state.comments.filter((c) => nodes.has(c.objectId));
  const result = { seq: state.seq, tree, comments: [] as typeof comments, truncated };
  for (const comment of comments) {
    const size = Buffer.byteLength(JSON.stringify(comment)) + 1;
    if (used + size > MAX_CANVAS_TEXT_BYTES - 100) {
      result.truncated = true;
      break;
    }
    result.comments.push(comment);
    used += size;
  }
  return result;
}
export function searchObjects(state: CanvasState, input: z.infer<typeof SearchSchema>) {
  const objects = readTargets(state, input.root);
  return objects
    .filter(
      (o) =>
        o.deletedAt === null && JSON.stringify(o.content).toLocaleLowerCase().includes(input.text.toLocaleLowerCase())
    )
    .map((object) => ({
      object,
      path: requireHierarchy(walkHierarchy(state, [object.id], 'parents'))
        .reverse()
        .map((p) => ({ id: p.id, label: p.content.label ?? p.id })),
    }));
}
