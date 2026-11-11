import type { ViewObject } from './model.js';
import type { Point } from './viewport.js';
export function worldOrigin(objects: ViewObject[], object: ViewObject): Point & { rotation: number } {
  let p = { ...object.position, rotation: object.rotation };
  const seen = new Set([object.id]);
  let parent = objects.find((o) => o.id === object.parentId);
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id);
    const a = (parent.rotation * Math.PI) / 180;
    p = {
      x: parent.position.x + p.x * Math.cos(a) - p.y * Math.sin(a),
      y: parent.position.y + p.x * Math.sin(a) + p.y * Math.cos(a),
      rotation: p.rotation + parent.rotation,
    };
    parent = objects.find((o) => o.id === parent?.parentId);
  }
  return p;
}
export function localDelta(objects: ViewObject[], object: ViewObject, delta: Point): Point {
  const parent = objects.find((o) => o.id === object.parentId);
  const a = parent ? (-worldOrigin(objects, parent).rotation * Math.PI) / 180 : 0;
  return { x: delta.x * Math.cos(a) - delta.y * Math.sin(a), y: delta.x * Math.sin(a) + delta.y * Math.cos(a) };
}
export function movedPosition(objects: ViewObject[], object: ViewObject, delta: Point): Point {
  const d = localDelta(objects, object, delta);
  return { x: object.position.x + d.x, y: object.position.y + d.y };
}
export function reparentPosition(objects: ViewObject[], object: ViewObject, parentId: string | null): Point {
  const origin = worldOrigin(objects, object);
  const parent = objects.find((o) => o.id === parentId);
  if (!parent) return { x: origin.x, y: origin.y };
  const p = worldOrigin(objects, parent),
    a = (-p.rotation * Math.PI) / 180;
  return {
    x: (origin.x - p.x) * Math.cos(a) - (origin.y - p.y) * Math.sin(a),
    y: (origin.x - p.x) * Math.sin(a) + (origin.y - p.y) * Math.cos(a),
  };
}
