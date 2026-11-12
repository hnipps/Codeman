import { describe, expect, it } from 'vitest';
import {
  chips,
  contextAdd,
  contextPrune,
  contextRemove,
  idleLasso,
  lassoHits,
  lassoStep,
  MAX_CONTEXT_OBJECTS,
  MAX_LASSO_POINTS,
  type CancelReason,
  type LassoState,
} from '../packages/canvas/src/context.js';
import { command, initialView } from '../packages/canvas/src/commands.js';
import { canvasToScreen } from '../packages/canvas/src/viewport.js';
import { parseStoredContext, draftBytes } from '../packages/canvas/src/assistant.js';
import { canvasStorageKeys } from '../packages/canvas/src/storage-keys.js';
import { publishDelay } from '../packages/canvas/src/view-sync.js';
import type { ViewObject } from '../packages/canvas/src/model.js';

const object = (
  id: string,
  parentId: string | null,
  x: number,
  y: number,
  type = 'text',
  deletedAt: number | null = null
): ViewObject => ({
  id,
  parentId,
  order: 0,
  type,
  position: { x, y },
  size: type === 'group' ? null : { width: 100, height: 60 },
  rotation: 0,
  content: type === 'text' ? { type, text: id } : { type, label: id },
  author: { kind: 'human', userId: 'u' },
  createdAt: 0,
  updatedAt: 0,
  deletedAt,
});
const objects = [
  object('frame', null, 0, 0, 'frame'),
  object('inside', 'frame', 10, 10),
  object('loose', null, 400, 0),
  object('gone', null, 0, 200, 'text', 5),
];
describe('pending context', () => {
  it('adds, drops a child under an attached ancestor, and keeps insertion order', () => {
    expect(contextAdd(objects, [], ['loose', 'inside'])).toEqual(['loose', 'inside']);
    expect(contextAdd(objects, ['inside', 'loose'], ['frame'])).toEqual(['loose', 'frame']);
    expect(contextAdd(objects, ['frame'], ['inside'])).toEqual(['frame']);
    expect(contextAdd(objects, ['loose'], ['loose'])).toEqual(['loose']);
  });
  it('drops deleted and unknown ids and removes by id', () => {
    expect(contextAdd(objects, [], ['gone', 'nope', 'loose'])).toEqual(['loose']);
    expect(contextPrune(objects, ['loose', 'gone', 'nope'])).toEqual(['loose']);
    expect(contextRemove(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c']);
  });
  it('is bounded', () => {
    const many = Array.from({ length: 300 }, (_, i) => object(`n${i}`, null, i, 0));
    expect(
      contextAdd(
        many,
        [],
        many.map((o) => o.id)
      )
    ).toHaveLength(MAX_CONTEXT_OBJECTS);
  });
  it('goes through the view reducer without touching camera or selection', () => {
    const before = { ...initialView(), selected: ['loose'], focusId: 'loose' };
    const added = command(before, { kind: 'context-add', ids: ['frame', 'inside'] }, objects);
    expect(added.context).toEqual(['frame']);
    expect({ ...added, context: [] }).toEqual(before);
    const removed = command(added, { kind: 'context-remove', ids: ['frame'] }, objects);
    expect(removed).toEqual(before);
    expect(command(added, { kind: 'context-clear-sent' }, objects).context).toEqual([]);
    expect(command(added, { kind: 'rail', view: 'assistant' }, objects).rail).toEqual(['assistant']);
    expect(
      command({ ...added, rail: ['assistant', 'keys'] }, { kind: 'rail-close', view: 'assistant' }, objects).rail
    ).toEqual(['keys']);
  });
  it('describes chips with a descendant count for containers', () => {
    const rows = chips(objects, ['frame', 'loose', 'gone']);
    expect(rows).toEqual([
      { id: 'frame', label: 'frame', type: 'frame', descendants: 1 },
      { id: 'loose', label: 'loose', type: 'text', descendants: 0 },
    ]);
  });
});
describe('lasso hit rule', () => {
  // A loop around the loose note's centre (450, 30) and nothing else, drawn at the given camera.
  const around = (viewport: { x: number; y: number; zoom: number }, cx: number, cy: number, r: number) =>
    [
      { x: cx - r, y: cy - r },
      { x: cx + r, y: cy - r },
      { x: cx + r, y: cy + r },
      { x: cx - r, y: cy + r },
    ].map((p) => canvasToScreen(viewport, p));
  for (const zoom of [0.5, 2]) {
    it(`reads centres in world space at zoom ${zoom}`, () => {
      const viewport = { x: -120, y: 75, zoom };
      expect(lassoHits(objects, objects, around(viewport, 450, 30, 20), viewport)).toEqual(['loose']);
      expect(lassoHits(objects, objects, around(viewport, 60, 40, 60), viewport)).toEqual(['frame']);
    });
  }
  it('captures a container as one chip, a child alone, and never a deleted object', () => {
    const view = { x: 0, y: 0, zoom: 1 };
    const wide = [
      { x: -10, y: -10 },
      { x: 600, y: -10 },
      { x: 600, y: 300 },
      { x: -10, y: 300 },
    ];
    expect(lassoHits(objects, objects, wide, view).sort()).toEqual(['frame', 'loose']);
    const childOnly = [
      { x: 56, y: 36 },
      { x: 70, y: 36 },
      { x: 70, y: 46 },
      { x: 56, y: 46 },
    ];
    expect(lassoHits(objects, objects, childOnly, view)).toEqual(['inside']);
  });
  it('captures nothing for fewer than three points or objects not in view', () => {
    const view = { x: 0, y: 0, zoom: 1 };
    expect(
      lassoHits(
        objects,
        objects,
        [
          { x: 0, y: 0 },
          { x: 9, y: 9 },
        ],
        view
      )
    ).toEqual([]);
    const wide = [
      { x: -10, y: -10 },
      { x: 600, y: -10 },
      { x: 600, y: 300 },
    ];
    expect(lassoHits(objects, [objects[2]], wide, view)).toEqual(['loose']);
  });
});
describe('lasso machine', () => {
  const armed = (): LassoState => lassoStep(idleLasso(), { type: 'arm' }).state;
  const drawing = (): LassoState => {
    let s = lassoStep(armed(), { type: 'down', point: { x: 0, y: 0 } }).state;
    s = lassoStep(s, { type: 'move', point: { x: 30, y: 0 } }).state;
    return lassoStep(s, { type: 'move', point: { x: 30, y: 30 } }).state;
  };
  it('arms, draws, and captures on pointer-up while still armed', () => {
    const result = lassoStep(drawing(), { type: 'up', point: { x: 0, y: 30 } });
    expect(result.capture).toHaveLength(4);
    expect(result.state).toEqual({ armed: true, points: null });
  });
  it('ignores a press when not armed', () => {
    const result = lassoStep(idleLasso(), { type: 'down', point: { x: 1, y: 1 } });
    expect(result).toMatchObject({ consumed: false, state: idleLasso() });
  });
  it('a key release, Escape and every cancel reason end the gesture with no capture', () => {
    const reasons: CancelReason[] = ['pointercancel', 'lostcapture', 'blur', 'hidden', 'composition'];
    const events = [
      { type: 'disarm' as const },
      { type: 'escape' as const },
      ...reasons.map((reason) => ({ type: 'cancel' as const, reason })),
    ];
    for (const event of events) {
      const result = lassoStep(drawing(), event);
      expect(result.capture).toBeNull();
      expect(result.cancelled).toBe(true);
      expect(result.state.points).toBeNull();
    }
    expect(lassoStep(drawing(), { type: 'cancel', reason: 'blur' }).state.armed).toBe(false);
  });
  it('a click or a two-point stroke is a cancel, and Escape with nothing armed is not consumed', () => {
    const click = lassoStep(lassoStep(armed(), { type: 'down', point: { x: 5, y: 5 } }).state, {
      type: 'up',
      point: { x: 5, y: 5 },
    });
    expect(click).toMatchObject({ capture: null, cancelled: true });
    expect(lassoStep(idleLasso(), { type: 'escape' }).consumed).toBe(false);
  });
  it('keeps the path bounded and ignores sub-step jitter', () => {
    let s = lassoStep(armed(), { type: 'down', point: { x: 0, y: 0 } }).state;
    s = lassoStep(s, { type: 'move', point: { x: 0.5, y: 0.5 } }).state;
    expect(s.points).toHaveLength(1);
    for (let i = 1; i < MAX_LASSO_POINTS + 50; i++) s = lassoStep(s, { type: 'move', point: { x: i * 3, y: 0 } }).state;
    expect(s.points).toHaveLength(MAX_LASSO_POINTS);
  });
});
describe('assistant storage and publishing', () => {
  it('scopes the draft and context per viewer and workspace', () => {
    const a = canvasStorageKeys('user-a', 'ws');
    expect(a.assistantDraft).not.toBe(canvasStorageKeys('user-b', 'ws').assistantDraft);
    expect(a.assistantContext).not.toBe(canvasStorageKeys('user-a', 'other').assistantContext);
    expect(a.assistantDraft).toContain('assistant:draft');
  });
  it('reads stored context defensively', () => {
    expect(parseStoredContext(null)).toEqual([]);
    expect(parseStoredContext('{bad')).toEqual([]);
    expect(parseStoredContext('{"a":1}')).toEqual([]);
    expect(parseStoredContext('["a",1,"b"]')).toEqual(['a', 'b']);
    expect(draftBytes('é')).toBe(2);
  });
  it('spaces publishes by the gap', () => {
    expect(publishDelay(1000, 900, 250)).toBe(150);
    expect(publishDelay(1000, 500, 250)).toBe(0);
  });
});
