import { knownContentFields } from '../../../src/canvas/model.js';
import { EditSchema, type Edit } from './edit-queue.js';
import { targets } from './select.js';
import { worldBounds } from './tree.js';
import { worldOrigin } from './drag.js';
import { union, type Point, type Rect } from './viewport.js';
import type { ViewObject } from './model.js';
function selectedIds(objects: ViewObject[], ids: string[]): Set<string> {
  const included = new Set(targets(objects, ids).map((o) => o.id));
  for (let changed = true; changed; ) {
    changed = false;
    for (const o of objects)
      if (o.parentId && included.has(o.parentId) && !included.has(o.id)) {
        included.add(o.id);
        changed = true;
      }
  }
  return included;
}
export function copied(objects: ViewObject[], ids: string[]): ViewObject[] {
  const included = selectedIds(objects, ids);
  const roots = new Set(targets(objects, ids).map((o) => o.id));
  return objects
    .filter((o) => included.has(o.id))
    .map((o) =>
      roots.has(o.id)
        ? { ...o, parentId: null, position: worldOrigin(objects, o), rotation: worldOrigin(objects, o).rotation }
        : structuredClone(o)
    );
}
export function pasted(objects: ViewObject[], offset: Point, id = () => crypto.randomUUID()): Edit[] {
  const ids = new Map(objects.map((o) => [o.id, id()]));
  const pending = [...objects],
    operations: Edit[] = [];
  while (pending.length) {
    const index = pending.findIndex((o) => !pending.some((p) => p.id === o.parentId));
    if (index < 0) throw new Error('Clipboard hierarchy cannot be pasted.');
    const [o] = pending.splice(index, 1);
    operations.push(
      EditSchema.parse({
        kind: 'create',
        opId: id(),
        objectId: ids.get(o.id),
        patch: {
          parentId: ids.get(o.parentId ?? '') ?? null,
          order: o.order,
          position: { x: o.position.x + (o.parentId ? 0 : offset.x), y: o.position.y + (o.parentId ? 0 : offset.y) },
          size: o.size,
          rotation: o.rotation,
          lock: o.lock ?? null,
          content: knownContentFields(o.content),
        },
      })
    );
  }
  return operations;
}
export function selectionBox(objects: ViewObject[], ids: string[]): Rect {
  return union(targets(objects, ids).map((o) => worldBounds(objects, o)));
}
export function snapped(
  objects: ViewObject[],
  ids: string[],
  box: Rect,
  delta: Point,
  zoom: number,
  disabled: boolean
) {
  const guides: { axis: 'x' | 'y'; value: number }[] = [];
  const result = { delta: { ...delta }, guides };
  if (disabled) return result;
  const selected = selectedIds(objects, ids);
  for (const axis of ['x', 'y'] as const) {
    const extent = axis === 'x' ? 'width' : 'height';
    const moving = [box[axis], box[axis] + box[extent] / 2, box[axis] + box[extent]].map((n) => n + delta[axis]);
    let closest = 6 / zoom,
      correction = 0,
      guide: number | undefined;
    for (const o of objects) {
      if (selected.has(o.id)) continue;
      const b = worldBounds(objects, o);
      for (const target of [b[axis], b[axis] + b[extent] / 2, b[axis] + b[extent]])
        for (const source of moving) {
          if (Math.abs(target - source) < closest) {
            closest = Math.abs(target - source);
            correction = target - source;
            guide = target;
          }
        }
    }
    result.delta[axis] += correction;
    if (guide !== undefined) result.guides.push({ axis, value: guide });
  }
  return result;
}
export function lockOwner(objects: ViewObject[], object: ViewObject): ViewObject | null {
  let current: ViewObject | undefined = object,
    locked: ViewObject | null = null;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.lock === 'subtree' || (current.id === object.id && current.lock === 'background')) locked = current;
    current = objects.find((o) => o.id === current?.parentId);
  }
  return locked;
}
