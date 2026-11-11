import type { ViewObject } from './model.js';
import { worldBounds } from './tree.js';
import { hit, type Point, type Rect } from './viewport.js';
export function targets(objects: ViewObject[], ids: string[]): ViewObject[] {
  const selected = new Set(ids);
  return objects.filter((o) => {
    if (!selected.has(o.id) || o.deletedAt !== null) return false;
    const seen = new Set([o.id]);
    let parent = o.parentId;
    while (parent && !seen.has(parent)) {
      if (selected.has(parent)) return false;
      seen.add(parent);
      parent = objects.find((p) => p.id === parent)?.parentId ?? null;
    }
    return true;
  });
}
export function inPolygon(p: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
export function selectRegion(
  objects: ViewObject[],
  region: { kind: 'rectangle'; rect: Rect } | { kind: 'polygon'; points: Point[] },
  parentId: string | null
): string[] {
  return targets(
    objects,
    objects
      .filter((o) => {
        if (o.parentId !== parentId) return false;
        const r = worldBounds(objects, o);
        return region.kind === 'rectangle'
          ? hit(region.rect, r) && hit(region.rect, { x: r.x + r.width, y: r.y + r.height })
          : inPolygon({ x: r.x + r.width / 2, y: r.y + r.height / 2 }, region.points);
      })
      .map((o) => o.id)
  ).map((o) => o.id);
}
