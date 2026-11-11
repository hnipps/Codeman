import { describe, expect, it } from 'vitest';
import {
  canvasToScreen,
  screenToCanvas,
  zoomAt,
  pan,
  pinch,
  fit,
  hit,
  MIN_ZOOM,
  MAX_ZOOM,
} from '../packages/canvas/src/viewport.js';
import { command, initialView } from '../packages/canvas/src/commands.js';
import { nextFocus, outline, worldBounds } from '../packages/canvas/src/tree.js';
import { shortcutAllowed } from '../packages/canvas/src/shortcuts.js';
import { SnapshotSchema, readable, type ViewObject } from '../packages/canvas/src/model.js';
const object = (id: string, parentId: string | null = null, order = 0): ViewObject => ({
  id,
  parentId,
  order,
  type: 'text',
  position: { x: 10, y: 20 },
  size: { width: 100, height: 80 },
  rotation: 0,
  content: { type: 'text', text: id },
  author: { kind: 'human', userId: 'reader' },
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
});
describe('canvas viewport', () => {
  it('preserves the pointer anchor across zoom, clamps both ends and maps coordinates', () => {
    const view = { x: -230, y: 90, zoom: 0.75 },
      anchor = { x: 401, y: 311 };
    const world = screenToCanvas(view, anchor);
    expect(canvasToScreen(view, world)).toEqual(anchor);
    const next = zoomAt(view, anchor, 1.8);
    expect(canvasToScreen(next, world).x).toBeCloseTo(anchor.x);
    expect(canvasToScreen(next, world).y).toBeCloseTo(anchor.y);
    expect(zoomAt(view, anchor, 1000).zoom).toBe(MAX_ZOOM);
    expect(zoomAt(view, anchor, 0.0001).zoom).toBe(MIN_ZOOM);
    expect(pan(view, { x: 3, y: -4 })).toEqual({ ...view, x: -227, y: 86 });
  });
  it('pinches about the moving midpoint and fits a named target', () => {
    const view = pinch(
      { x: 0, y: 0, zoom: 1 },
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      [
        { x: 10, y: 10 },
        { x: 210, y: 10 },
      ]
    );
    expect(view).toEqual({ x: 10, y: 10, zoom: 2 });
    const fitted = fit({ x: 200, y: 100, width: 400, height: 300 }, { x: 192, y: 0, width: 1000, height: 800 });
    expect(canvasToScreen(fitted, { x: 400, y: 250 })).toEqual({ x: 692, y: 400 });
    expect(hit({ x: 0, y: 0, width: 10, height: 20 }, { x: 10, y: 20 })).toBe(true);
  });
});
describe('read view commands and hierarchy', () => {
  const group = { ...object('group'), type: 'group', size: null, content: { type: 'group', label: 'Research' } };
  const objects = [object('b', 'group', 2), group, object('a', 'group', 1)];
  it('keeps focus and selection separate with stable sibling order and explicit parent scope', () => {
    let view = command(initialView(), { kind: 'focus', id: 'a' }, objects);
    expect(view.selected).toEqual([]);
    view = command(view, { kind: 'toggle', id: 'a' }, objects);
    expect(command(view, { kind: 'navigate', step: 1 }, objects).focusId).toBe('b');
    expect(command(view, { kind: 'select-all' }, objects).selected).toEqual(['a', 'b']);
    expect(nextFocus([...objects, object('inserted', 'group', -1)], 'a', 1)).toBe('b');
    expect(outline(objects).map((r) => [r.object.id, r.depth])).toEqual([
      ['group', 0],
      ['a', 1],
      ['b', 1],
    ]);
    expect(worldBounds(objects, objects[0])).toEqual({ x: 20, y: 40, width: 100, height: 80 });
  });
  it('fits rotated descendants using their actual world corners', () => {
    const parent = { ...group, position: { x: 100, y: 0 }, rotation: -45 };
    const child = { ...object('rotated', 'group'), rotation: 45 };
    const result = worldBounds([parent, child], child);
    expect(result.x).toBeCloseTo(100 + 30 / Math.sqrt(2));
    expect(result.y).toBeCloseTo(10 / Math.sqrt(2));
    expect(result.width).toBeCloseTo(100);
    expect(result.height).toBeCloseTo(80);
  });
  it('overlays and unwinds rail views without changing the camera or selection', () => {
    const view = { ...initialView(), selected: ['a'], focusId: 'a' };
    const rail = command(
      command(view, { kind: 'rail', view: 'reader' }, objects),
      { kind: 'rail', view: 'keys' },
      objects
    );
    const back = command(rail, { kind: 'escape' }, objects);
    expect(back.rail).toEqual(['reader']);
    expect(command(back, { kind: 'escape' }, objects)).toEqual(view);
  });
  it('suppresses text, native controls, IME and noncanvas input', () => {
    const scope = { composing: false, editable: false, control: false, canvas: true };
    expect(shortcutAllowed(scope)).toBe(true);
    for (const flag of ['composing', 'editable', 'control'])
      expect(shortcutAllowed({ ...scope, [flag]: true })).toBe(false);
    expect(shortcutAllowed({ ...scope, canvas: false })).toBe(false);
  });
  it('accepts a newer object type as an inert labelled placeholder', () => {
    const data = SnapshotSchema.parse({
      seq: 1,
      objects: [
        { ...object('future'), type: 'diagram', content: { type: 'diagram', script: '<img onerror=alert(1)>' } },
      ],
    });
    expect(readable(data.objects[0])).toBe('Unsupported object · diagram');
  });
});
