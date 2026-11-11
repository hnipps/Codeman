import { container, type ViewObject } from './model.js';
import { union, type Point, type Rect } from './viewport.js';
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
function geometryPoints(objects: ViewObject[], o: ViewObject, seen: Set<string>): Point[] {
  if (seen.has(o.id)) return [];
  seen.add(o.id);
  const points = o.size
    ? [
        { x: 0, y: 0 },
        { x: o.size.width, y: 0 },
        { x: 0, y: o.size.height },
        { x: o.size.width, y: o.size.height },
      ]
    : siblings(objects, o.id).flatMap((child) => geometryPoints(objects, child, new Set(seen)));
  return transform(points.length ? points : [{ x: 0, y: 0 }], o);
}
function transform(points: Point[], o: ViewObject): Point[] {
  const angle = (o.rotation * Math.PI) / 180;
  return points.map((p) => ({
    x: o.position.x + p.x * Math.cos(angle) - p.y * Math.sin(angle),
    y: o.position.y + p.x * Math.sin(angle) + p.y * Math.cos(angle),
  }));
}
const enclose = (points: Point[]): Rect => union(points.map((p) => ({ ...p, width: 0, height: 0 })));
export function localBounds(objects: ViewObject[], o: ViewObject): Rect {
  return enclose(geometryPoints(objects, o, new Set()));
}
export function worldBounds(objects: ViewObject[], o: ViewObject): Rect {
  let points = geometryPoints(objects, o, new Set()),
    parent = objects.find((p) => p.id === o.parentId);
  const seen = new Set([o.id]);
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id);
    points = transform(points, parent);
    const parentId = parent.parentId;
    parent = objects.find((p) => p.id === parentId);
  }
  return enclose(points);
}
