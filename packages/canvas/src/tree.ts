import { container, type ViewObject } from './model.js';
import { union, type Rect } from './viewport.js';
export const siblings = (objects: ViewObject[], parentId: string | null): ViewObject[] =>
  objects
    .filter((o) => o.parentId === parentId && o.deletedAt === null)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
export function outline(objects: ViewObject[]): { object: ViewObject; depth: number }[] {
  const result: ReturnType<typeof outline> = [],
    seen = new Set<string>();
  const walk = (parent: string | null, depth: number): void => {
    for (const object of siblings(objects, parent)) {
      if (seen.has(object.id)) continue;
      seen.add(object.id);
      result.push({ object, depth });
      if (container(object)) walk(object.id, depth + 1);
    }
  };
  walk(null, 0);
  return result;
}
export function nextFocus(objects: ViewObject[], id: string | null, step: number): string | null {
  const current = objects.find((o) => o.id === id),
    list = siblings(objects, current?.parentId ?? null);
  if (!list.length) return null;
  const index = list.findIndex((o) => o.id === id);
  return list[index < 0 ? (step > 0 ? 0 : list.length - 1) : (index + step + list.length) % list.length].id;
}
export function localBounds(objects: ViewObject[], o: ViewObject, seen = new Set<string>()): Rect {
  if (seen.has(o.id)) return { x: 0, y: 0, width: 0, height: 0 };
  seen.add(o.id);
  const r = o.size
    ? { x: 0, y: 0, ...o.size }
    : union(siblings(objects, o.id).map((c) => localBounds(objects, c, new Set(seen))));
  const angle = (o.rotation * Math.PI) / 180;
  return union(
    [
      [r.x, r.y],
      [r.x + r.width, r.y],
      [r.x, r.y + r.height],
      [r.x + r.width, r.y + r.height],
    ].map(([x, y]) => ({
      x: o.position.x + x * Math.cos(angle) - y * Math.sin(angle),
      y: o.position.y + x * Math.sin(angle) + y * Math.cos(angle),
      width: 0,
      height: 0,
    }))
  );
}
export function worldBounds(objects: ViewObject[], o: ViewObject): Rect {
  let r = localBounds(objects, o),
    parent = objects.find((p) => p.id === o.parentId);
  const seen = new Set([o.id]);
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id);
    const p = parent;
    const a = (p.rotation * Math.PI) / 180;
    r = union(
      [
        [r.x, r.y],
        [r.x + r.width, r.y],
        [r.x, r.y + r.height],
        [r.x + r.width, r.y + r.height],
      ].map(([x, y]) => ({
        x: p.position.x + x * Math.cos(a) - y * Math.sin(a),
        y: p.position.y + x * Math.sin(a) + y * Math.cos(a),
        width: 0,
        height: 0,
      }))
    );
    parent = objects.find((p) => p.id === parent?.parentId);
  }
  return r;
}
