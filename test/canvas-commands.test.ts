import { describe, it, expect } from 'vitest';
import {
  arrange,
  transform,
  historyCommands,
  normalizeTargets,
  ArrangeSchema,
  TransformSchema,
  capabilities,
} from '../src/canvas/commands.js';
import { queryObjects, readTree, MAX_CANVAS_TEXT_BYTES } from '../src/canvas/queries.js';
import { emptyState, worldTransform, descendants, bounds, type CanvasState } from '../src/canvas/model.js';
import { validateBatch, CommandSchema, type Command } from '../src/canvas/operations.js';
import { create, human, agent } from './canvas-fixtures.js';

function apply(state: CanvasState, commands: Command[]) {
  const result = validateBatch(state, commands, human, 1);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.reasons));
  return result;
}
const seed = () =>
  apply(emptyState(), [create('section', null, 'section'), create('a', 'section'), create('b', 'section')]).state;
describe('shared compound canvas commands', () => {
  it('rejects ignored snap fields and describes browser pointer snapping in capabilities', () => {
    for (const action of ['align', 'distribute']) {
      const args = { action, targetIds: ['a', 'b'], axis: 'x', ...(action === 'align' ? { anchor: 'start' } : {}) };
      expect(ArrangeSchema.safeParse(args).success).toBe(true);
      expect(ArrangeSchema.safeParse({ ...args, snap: false }).success).toBe(false);
      expect(ArrangeSchema.safeParse({ ...args, snap: true }).success).toBe(false);
    }
    expect(JSON.stringify(capabilities().compoundCommands)).not.toContain('"snap"');
    expect(capabilities().geometry.snapping).toContain('pointer aid in the browser');
  });
  it.each([2, 300])('reads complete descendants and omits bounds for a %i-node cycle', (count) => {
    const state = seed();
    for (let i = 0; i < count; i++) {
      const id = 'cycle-' + i;
      state.objects[id] = { ...state.objects.section, id, parentId: 'cycle-' + ((i + 1) % count) };
    }
    expect(descendants(state, 'cycle-0', true)).toHaveLength(count);
    expect(bounds(state, 'cycle-0')).toEqual({ hierarchy: 'cycle' });
    expect(bounds(state, 'section')).toMatchObject({ x: 10, y: 20, width: 100, height: 80 });
  });
  it('groups, nests, reparents and ungroups without ID loss or world movement', () => {
    let state = seed();
    const before = worldTransform(state, 'a');
    state = apply(
      state,
      arrange(
        state,
        ArrangeSchema.parse({
          action: 'group',
          targetIds: ['a', 'b'],
          groupId: 'g',
          label: 'Design',
          parentId: 'section',
        })
      )
    ).state;
    expect(state.objects.a.parentId).toBe('g');
    expect(worldTransform(state, 'a')).toEqual(before);
    expect(normalizeTargets(state, ['g', 'a']).map((o) => o.id)).toEqual(['g']);
    state = apply(
      state,
      arrange(state, { action: 'group', targetIds: ['g'], groupId: 'outer', label: 'Outer', parentId: 'section' })
    ).state;
    state = apply(state, arrange(state, { action: 'ungroup', targetIds: ['g'] })).state;
    expect(state.objects.a.parentId).toBe('outer');
    expect(worldTransform(state, 'a')).toEqual(before);
    expect(state.objects.g.deletedAt).not.toBeNull();
    const cycle = validateBatch(state, arrange(state, { action: 'nest', targetIds: ['outer'], parentId: 'a' }), human);
    expect(cycle.ok).toBe(false);
  });
  it('rejects a compound transform atomically on a locked descendant', () => {
    let state = seed();
    state = apply(
      state,
      arrange(state, { action: 'group', targetIds: ['a', 'b'], groupId: 'g', label: 'G', parentId: 'section' })
    ).state;
    state = apply(state, [{ kind: 'lock', objectId: 'a', opId: 'lock', patch: { mode: 'subtree' } }]).state;
    const before = structuredClone(state);
    const commands = transform(
      state,
      TransformSchema.parse({
        targetIds: ['g', 'a'],
        space: 'world',
        anchor: { x: 0, y: 0 },
        translation: { x: 20, y: 0 },
        scale: { width: 2, height: 2 },
        rotation: 0,
      })
    );
    const result = validateBatch(state, commands, agent);
    expect(result).toMatchObject({ ok: false, reasons: [{ code: 'LOCKED' }] });
    expect(state).toEqual(before);
  });
  it('scales nested group contents once and rejects nonuniform scale in rotated axes', () => {
    let state = seed();
    state = apply(
      state,
      arrange(state, { action: 'group', targetIds: ['a', 'b'], groupId: 'g', label: 'G', parentId: 'section' })
    ).state;
    state = apply(state, [create('frame', 'g', 'frame'), create('deep', 'frame')]).state;
    const before = worldTransform(state, 'deep');
    const input = TransformSchema.parse({
      targetIds: ['g', 'deep'],
      space: 'world',
      anchor: { x: 0, y: 0 },
      translation: { x: 0, y: 0 },
      scale: { width: 2, height: 2 },
      rotation: 0,
    });
    state = apply(state, transform(state, input)).state;
    expect(worldTransform(state, 'deep')).toEqual({ x: before.x * 2, y: before.y * 2, rotation: before.rotation });
    state = apply(state, [{ kind: 'update', objectId: 'a', opId: 'rotate-a', patch: { rotation: 30 } }]).state;
    expect(() => transform(state, { ...input, targetIds: ['a'], scale: { width: 2, height: 1 } })).toThrow(
      'Canvas operation rejected'
    );
  });
  it('duplicates nested structure with fresh IDs and edits independently', () => {
    let state = seed();
    state = apply(
      state,
      arrange(state, { action: 'group', targetIds: ['a', 'b'], groupId: 'g', label: 'G', parentId: 'section' })
    ).state;
    state = apply(
      state,
      arrange(state, { action: 'duplicate', targetIds: ['g', 'a'], offset: { x: 30, y: 40 } })
    ).state;
    const copies = Object.values(state.objects).filter((o) => !['a', 'b', 'g', 'section'].includes(o.id));
    expect(copies).toHaveLength(3);
    const group = copies.find((o) => o.type === 'group')!;
    expect(copies.filter((o) => o.parentId === group.id)).toHaveLength(2);
    expect(state.objects.a.content.text).toBe('a');
  });
  it('aligns and distributes world bounds and preserves unrelated sibling order', () => {
    let state = seed();
    state = apply(state, [
      CommandSchema.parse({ kind: 'move', opId: 'move-b', objectId: 'b', patch: { position: { x: 250, y: 100 } } }),
    ]).state;
    state = apply(state, arrange(state, { action: 'align', targetIds: ['a', 'b'], axis: 'y', anchor: 'start' })).state;
    expect(worldTransform(state, 'a').y).toBe(worldTransform(state, 'b').y);
    state = apply(state, arrange(state, { action: 'distribute', targetIds: ['a', 'b'], axis: 'x', spacing: 25 })).state;
    expect(worldTransform(state, 'b').x - worldTransform(state, 'a').x).toBe(125);
    state = apply(state, arrange(state, { action: 'order', targetIds: ['a'], placement: 'front' })).state;
    expect(state.objects.a.order).toBeGreaterThan(state.objects.b.order);
  });
  it('refuses undo when a comment ID was reused for a later author', () => {
    const first = apply(seed(), [
      { kind: 'comment', opId: 'comment-first', objectId: 'a', patch: { id: 'c', text: 'first' } },
    ]);
    const removed = apply(first.state, [
      { kind: 'remove-comment', opId: 'comment-remove', objectId: 'a', patch: { id: 'c' } },
    ]);
    const later = validateBatch(
      removed.state,
      [{ kind: 'comment', opId: 'comment-later', objectId: 'a', patch: { id: 'c', text: 'later' } }],
      agent
    );
    if (!later.ok) throw new Error('fixture rejected');
    expect(() => historyCommands(later.state, first.operations, [first.state.seq], human)).toThrow();
    const undoneTogether = apply(
      removed.state,
      historyCommands(
        removed.state,
        [...first.operations, ...removed.operations],
        [first.state.seq, removed.state.seq],
        human
      )
    );
    expect(undoneTogether.state.comments).toEqual([]);
  });
  it('retains revision checks when an inverse batch is applied after another edit', () => {
    const forward = apply(seed(), [
      { kind: 'move', opId: 'first', objectId: 'a', patch: { position: { x: 50, y: 60 } } },
    ]);
    const inverse = historyCommands(forward.state, forward.operations, [forward.state.seq], human);
    const later = apply(forward.state, [
      { kind: 'move', opId: 'later', objectId: 'a', patch: { position: { x: 90, y: 80 } } },
    ]);
    expect(validateBatch(later.state, inverse, human)).toMatchObject({ ok: false, reasons: [{ code: 'REVISION' }] });
  });
  it('undoes and redoes own operations and refuses another author or intervening revision', () => {
    const result = apply(seed(), [{ kind: 'move', objectId: 'a', opId: 'm', patch: { position: { x: 50, y: 60 } } }]);
    expect(() => historyCommands(result.state, result.operations, [result.state.seq], agent)).toThrow();
    const inverse = historyCommands(result.state, result.operations, [result.state.seq], human);
    const undo = apply(result.state, inverse);
    expect(undo.state.objects.a.position).toEqual({ x: 10, y: 20 });
    const redo = apply(undo.state, historyCommands(undo.state, undo.operations, [undo.state.seq], human));
    expect(redo.state.objects.a.position).toEqual({ x: 50, y: 60 });
    expect(() => historyCommands(undo.state, result.operations, [result.state.seq], human)).toThrow();
  });
  it('uses point, rectangle and polygon world AABB semantics, including touching edges', () => {
    const state = seed();
    expect(queryObjects(state, { shape: 'point', point: { x: 20, y: 40 } }).map((o) => o.id)).toContain('a');
    expect(
      queryObjects(state, {
        shape: 'rectangle',
        position: { x: 20, y: 40 },
        size: { width: 100, height: 80 },
        semantics: 'containment',
      }).map((o) => o.id)
    ).toEqual(['a', 'b']);
    const points = [
      { x: 120, y: 40 },
      { x: 150, y: 40 },
      { x: 150, y: 100 },
      { x: 120, y: 100 },
    ];
    expect(queryObjects(state, { shape: 'polygon', points, semantics: 'intersection' }).map((o) => o.id)).toContain(
      'a'
    );
    expect(queryObjects(state, { shape: 'polygon', points, semantics: 'containment' })).toEqual([]);
  });
  it('rejects self-intersecting polygons and narrow concave exclusions', () => {
    const state = seed();
    expect(() =>
      queryObjects(state, {
        shape: 'polygon',
        semantics: 'intersection',
        points: [
          { x: 0, y: 0 },
          { x: 200, y: 200 },
          { x: 0, y: 200 },
          { x: 200, y: 0 },
        ],
      })
    ).toThrow();
    const points = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 60 },
      { x: 45, y: 60 },
      { x: 45, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 200 },
      { x: 0, y: 200 },
    ];
    expect(queryObjects(state, { shape: 'polygon', points, semantics: 'containment' }).map((o) => o.id)).not.toContain(
      'a'
    );
  });
  it('undoes a whole group transaction and redoes its hierarchy atomically', () => {
    const initial = seed();
    const grouped = apply(
      initial,
      arrange(initial, { action: 'group', targetIds: ['a', 'b'], groupId: 'g', label: 'G', parentId: 'section' })
    );
    const undone = apply(
      grouped.state,
      historyCommands(
        grouped.state,
        grouped.operations,
        grouped.operations.map((o) => o.seq),
        human
      )
    );
    expect(undone.state.objects.a.parentId).toBe('section');
    expect(undone.state.objects.g.deletedAt).not.toBeNull();
    const redone = apply(
      undone.state,
      historyCommands(
        undone.state,
        undone.operations,
        undone.operations.map((o) => o.seq),
        human
      )
    );
    expect(redone.state.objects.g.deletedAt).toBeNull();
    expect(redone.state.objects.a.parentId).toBe('g');
    expect(worldTransform(redone.state, 'a')).toEqual(worldTransform(initial, 'a'));
  });
  it('caps a nested 2000-object read as valid JSON with explicit truncation', () => {
    const state = seed();
    for (let i = 0; i < 2000; i++)
      state.objects['copy' + i] = {
        ...state.objects.a,
        id: 'copy' + i,
        content: { type: 'text', text: 'x'.repeat(100) },
      };
    const result = readTree(state, { root: 'section', includeDeleted: false });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MAX_CANVAS_TEXT_BYTES);
    expect(result.tree[0].object.id).toBe('section');
  });
});
