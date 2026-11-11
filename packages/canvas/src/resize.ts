import type { ViewObject } from './model.js';
import type { Point } from './viewport.js';
import { worldOrigin } from './drag.js';
export const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
export function resized(
  objects: ViewObject[],
  object: ViewObject,
  handle: string,
  delta: Point,
  proportional: boolean,
  center: boolean
) {
  const size = object.size;
  if (!size) return null;
  const a = (-worldOrigin(objects, object).rotation * Math.PI) / 180;
  const d = { x: delta.x * Math.cos(a) - delta.y * Math.sin(a), y: delta.x * Math.sin(a) + delta.y * Math.cos(a) };
  let width = Math.max(
    16,
    size.width + (handle.includes('e') ? d.x : handle.includes('w') ? -d.x : 0) * (center ? 2 : 1)
  );
  let height = Math.max(
    16,
    size.height + (handle.includes('s') ? d.y : handle.includes('n') ? -d.y : 0) * (center ? 2 : 1)
  );
  if (proportional) {
    const scale =
      handle === 'n' || handle === 's'
        ? height / size.height
        : handle === 'e' || handle === 'w'
          ? width / size.width
          : Math.abs(width / size.width - 1) > Math.abs(height / size.height - 1)
            ? width / size.width
            : height / size.height;
    width = Math.max(16 / size.width, 16 / size.height, scale) * size.width;
    height = (width / size.width) * size.height;
  }
  const offset = {
    x: center ? (size.width - width) / 2 : handle.includes('w') ? size.width - width : 0,
    y: center ? (size.height - height) / 2 : handle.includes('n') ? size.height - height : 0,
  };
  const r = (object.rotation * Math.PI) / 180;
  return {
    size: { width, height },
    position: {
      x: object.position.x + offset.x * Math.cos(r) - offset.y * Math.sin(r),
      y: object.position.y + offset.x * Math.sin(r) + offset.y * Math.cos(r),
    },
  };
}
