import { describe, expect, it } from 'vitest';
import {
  emptyState,
  effectiveLock,
  worldTransform,
  bounds,
  descendants,
  walkHierarchy,
  MAX_HIERARCHY_DEPTH,
  MAX_HIERARCHY_NODES,
  type CanvasState,
} from '../src/canvas/model.js';
import {
  applyOperation,
  invertOperation,
  revertAuthor,
  validateBatch,
  type Command,
} from '../src/canvas/operations.js';

import { human, agent, create } from './canvas-fixtures.js';
function apply(state: CanvasState, commands: Command[], author = human) {
  const result = validateBatch(state, commands, author, 100);
  if (!result.ok) throw new Error(JSON.stringify(result.reasons));
  return result;
}

describe('canvas domain operations', () => {
  it.each(['deep', 'wide'] as const)('validates %s subtree edits within 250 ms', (shape) => {
    const seed = apply(emptyState(), [create('n0', null, 'group')]).state.objects.n0;
    let state = emptyState();
    const count = shape === 'deep' ? 200 : 5000;
    for (let i = 0; i < count; i++) {
      const id = `n${i}`;
      state.objects[id] = { ...seed, id, parentId: i === 0 ? null : shape === 'deep' ? `n${i - 1}` : 'n0' };
    }
    state.objects.destination = { ...seed, id: 'destination', parentId: null };
    const commands: Command[] = [
      { kind: 'delete', opId: 'delete', objectId: 'n0' },
      { kind: 'restore', opId: 'restore', objectId: 'n0' },
      { kind: 'move', opId: 'move', objectId: 'n0', patch: { position: { x: 30, y: 40 } } },
      {
        kind: 'reparent',
        opId: 'reparent',
        objectId: 'n0',
        patch: { parentId: 'destination', order: 2, preserveWorld: true },
      },
      { kind: 'lock', opId: 'lock', objectId: 'n0', patch: { mode: 'subtree' } },
    ];
    for (const command of commands) {
      const before = state;
      const start = performance.now();
      const result = validateBatch(state, [command], human, 100);
      const elapsed = performance.now() - start;
      expect(result.ok).toBe(true);
      expect(elapsed, `${shape} ${command.kind}`).toBeLessThan(250);
      if (!result.ok) throw new Error(JSON.stringify(result.reasons));
      state = result.state;
      expect(result.operations[0].prev).toHaveLength(['delete', 'restore'].includes(command.kind) ? count : 1);
      for (let i = 1; i < count; i++) {
        const child = state.objects[`n${i}`];
        if (command.kind === 'delete' || command.kind === 'restore') {
          expect(child).toEqual({
            ...before.objects[child.id],
            deletedAt: command.kind === 'delete' ? 100 : null,
            deletionOpId: command.kind === 'delete' ? 'delete' : null,
            updatedAt: 100,
            revision: before.objects[child.id].revision + 1,
          });
        } else expect(child).toEqual(before.objects[child.id]);
      }
      expect(state.objects.destination).toEqual(before.objects.destination);
    }
    expect(worldTransform(state, 'n0')).toEqual({ x: 30, y: 40, rotation: 0 });
    expect(state.objects.n0).toMatchObject({ parentId: 'destination', order: 2, lock: 'subtree', deletedAt: null });
    expect(effectiveLock(state, `n${count - 1}`)).toEqual({ objectId: 'n0', mode: 'subtree' });
  });
  it.each(['two-object', 'self-parent'] as const)('bounds every walk over a %s cycle', (kind) => {
    const state = apply(emptyState(), [create('a'), create('b')]).state;
    state.objects.a.parentId = kind === 'self-parent' ? 'a' : 'b';
    state.objects.b = { ...state.objects.b, type: 'future-widget', parentId: 'a' };
    expect(descendants(state, 'a').map((o) => o.id)).toEqual(['a', 'b']);
    expect(() => effectiveLock(state, 'a')).toThrow('Cyclic');
    expect(() => worldTransform(state, 'a')).toThrow('Cyclic');
    expect(bounds(state, 'a')).toEqual({ hierarchy: 'cycle' });
    // Auto-bounded geometry has its own child traversal through the same helper.
    state.objects.a.size = null;
    state.objects.b.size = null;
    expect(bounds(state, 'a', 'local')).toEqual({ hierarchy: 'cycle' });
    expect(
      validateBatch(
        state,
        [{ kind: 'move', opId: 'cycle-move', objectId: 'a', patch: { position: { x: 1, y: 2 } } }],
        human
      )
    ).toMatchObject({ ok: false, reasons: [{ code: 'CYCLE' }] });
  });
  it('accepts a chain at the depth bound and rejects writes and geometry beyond it', () => {
    const seed = apply(emptyState(), [create('seed', null, 'group')]).state.objects.seed;
    const state = emptyState();
    for (let i = 0; i < MAX_HIERARCHY_DEPTH; i++) {
      const id = `n${i}`;
      state.objects[id] = { ...seed, id, parentId: i === 0 ? null : `n${i - 1}` };
    }
    const last = `n${MAX_HIERARCHY_DEPTH - 1}`;
    expect(descendants(state, 'n0')).toHaveLength(MAX_HIERARCHY_DEPTH);
    expect(worldTransform(state, last).x).toBe(MAX_HIERARCHY_DEPTH * 10);
    expect(bounds(state, 'n0')).toMatchObject({ x: MAX_HIERARCHY_DEPTH * 10 });
    expect(effectiveLock(state, last)).toBeNull();
    expect(
      validateBatch(
        state,
        [{ kind: 'move', opId: 'at-limit', objectId: last, patch: { position: { x: 0, y: 0 } } }],
        human
      ).ok
    ).toBe(true);
    state.objects.extra = { ...seed, id: 'extra', parentId: last };
    expect(descendants(state, 'n0')).toHaveLength(MAX_HIERARCHY_DEPTH);
    expect(() => worldTransform(state, 'extra')).toThrow('limit');
    expect(() => effectiveLock(state, 'extra')).toThrow('limit');
    expect(() => bounds(state, 'n0')).toThrow('limit');
    expect(
      validateBatch(
        state,
        [{ kind: 'move', opId: 'over-limit', objectId: 'n0', patch: { position: { x: 0, y: 0 } } }],
        human
      )
    ).toMatchObject({ ok: false, reasons: [{ code: 'HIERARCHY_LIMIT' }] });
  });
  it('bounds wide descendant walks and rejects an incomplete compound edit atomically', () => {
    const seed = apply(emptyState(), [create('root', null, 'group')]).state.objects.root;
    const state = emptyState();
    state.objects.root = seed;
    for (let i = 1; i < MAX_HIERARCHY_NODES; i++) {
      const id = `n${i}`;
      state.objects[id] = { ...seed, id, parentId: 'root' };
    }
    expect(walkHierarchy(state, ['root'], 'children').issue).toBeNull();
    state.objects.extra = { ...seed, id: 'extra', parentId: 'root' };
    expect(descendants(state, 'root')).toHaveLength(MAX_HIERARCHY_NODES);
    const before = structuredClone(state);
    expect(
      validateBatch(state, [create('new'), { kind: 'delete', objectId: 'root', opId: 'wide-delete' }], human)
    ).toMatchObject({ ok: false, reasons: [{ code: 'HIERARCHY_LIMIT' }] });
    expect(state).toEqual(before);
  });
  it.each(['future-widget', 'mystery', 'image'])('rejects compound edits affecting an opaque %s descendant', (type) => {
    const state = apply(emptyState(), [create('group', null, 'group'), create('child', 'group')]).state;
    state.objects.child.content = { type, text: 'z', url: 'future-url', alt: '' };
    if (type === 'future-widget') state.objects.child.type = type;
    const before = structuredClone(state);
    for (const command of [
      { kind: 'move', objectId: 'group', opId: 'move', patch: { position: { x: 0, y: 0 } } },
      { kind: 'delete', objectId: 'group', opId: 'delete' },
      {
        kind: 'reparent',
        objectId: 'group',
        opId: 'reparent',
        patch: { parentId: null, order: 1, preserveWorld: true },
      },
      { kind: 'update', objectId: 'group', opId: 'rotate', patch: { rotation: 30 } },
    ] satisfies Command[]) {
      expect(validateBatch(state, [create('new'), command], human)).toMatchObject({
        ok: false,
        reasons: [{ code: 'INVALID' }],
      });
      expect(state).toEqual(before);
    }
  });
  it('applies and inverts create, typed update and movement', () => {
    let result = apply(emptyState(), [create('text')]);
    result = apply(result.state, [
      { kind: 'update', objectId: 'text', opId: 'update', patch: { content: { type: 'text', text: 'changed' } } },
    ]);
    const op = result.operations[0];
    if (!op) throw new Error('missing op');
    expect(invertOperation(op, 0)[0]?.kind).toBe('update');
    expect(apply(result.state, invertOperation(op, 0)).state.objects.text?.content).toEqual({
      type: 'text',
      text: 'text',
    });
    expect(
      validateBatch(
        result.state,
        [{ kind: 'move', objectId: 'text', opId: 'stale', expectedRevision: 0, patch: { position: { x: 1, y: 2 } } }],
        human
      )
    ).toMatchObject({ ok: false, reasons: [{ code: 'REVISION' }] });
  });
  it('uses native undo operations and restores exact local placement after reparenting', () => {
    const base = apply(emptyState(), [create('frame', null, 'frame'), create('child')]);
    const before = structuredClone(base.state.objects.child);
    const next = apply(base.state, [
      {
        kind: 'reparent',
        opId: 'parent',
        objectId: 'child',
        patch: { parentId: 'frame', order: 8, preserveWorld: true },
      },
    ]);
    const op = next.operations[0];
    if (!op) throw new Error('missing reparent');
    const inverse = invertOperation(op, 0);
    expect(inverse.map((command) => command.kind)).toEqual(['revert']);
    const restored = apply(next.state, inverse).state.objects.child;
    expect(restored).toMatchObject({
      parentId: before?.parentId,
      order: before?.order,
      position: before?.position,
      rotation: before?.rotation,
    });
    const created = base.operations[0];
    if (!created) throw new Error('missing create');
    expect(invertOperation(created, 0)[0]?.kind).toBe('delete');
  });
  it('refuses cycles and atomically rejects the preceding valid command', () => {
    const state = apply(emptyState(), [create('group', null, 'group'), create('child', 'group', 'group')]).state;
    const result = validateBatch(
      state,
      [
        { kind: 'move', opId: 'move', objectId: 'child', patch: { position: { x: 5, y: 6 } } },
        {
          kind: 'reparent',
          opId: 'cycle',
          objectId: 'group',
          patch: { parentId: 'child', order: 1, preserveWorld: true },
        },
      ],
      human
    );
    expect(result).toMatchObject({ ok: false, reasons: [{ code: 'CYCLE' }] });
    expect(state.objects.child?.position).toEqual({ x: 10, y: 20 });
  });
  it('skips unknown operations on replay', () => {
    expect(
      applyOperation(emptyState(), {
        seq: 1,
        opId: 'future',
        objectId: 'x',
        kind: 'future',
        author: human,
        patch: {},
        prev: [],
      })
    ).toEqual({ ...emptyState(), seq: 1 });
  });
  it('reverts only fields not overwritten by another author', () => {
    const base = apply(emptyState(), [create('text')]);
    const first = apply(
      base.state,
      [
        {
          kind: 'update',
          objectId: 'text',
          opId: 'agent',
          patch: { content: { type: 'text', text: 'agent' }, rotation: 20 },
        },
      ],
      agent
    );
    const second = apply(first.state, [
      { kind: 'update', objectId: 'text', opId: 'human', patch: { content: { type: 'text', text: 'human' } } },
    ]);
    const reverted = apply(
      second.state,
      revertAuthor(second.state, [...base.operations, ...first.operations, ...second.operations], agent)
    );
    expect(reverted.state.objects.text).toMatchObject({ content: { text: 'human' }, rotation: 0 });
  });
  it('preserves local locks and blocks child unlock under a locked ancestor', () => {
    let state = apply(emptyState(), [create('group', null, 'group'), create('child', 'group')]).state;
    state = apply(state, [
      { kind: 'lock', objectId: 'child', opId: 'child-lock', patch: { mode: 'subtree' } },
      { kind: 'lock', objectId: 'group', opId: 'group-lock', patch: { mode: 'subtree' } },
    ]).state;
    expect(effectiveLock(state, 'child')?.objectId).toBe('group');
    expect(validateBatch(state, [{ kind: 'unlock', objectId: 'child', opId: 'bad-unlock' }], agent)).toMatchObject({
      ok: false,
      reasons: [{ code: 'LOCKED' }],
    });
    state = apply(state, [{ kind: 'unlock', objectId: 'group', opId: 'unlock' }]).state;
    expect(effectiveLock(state, 'child')?.objectId).toBe('child');
    expect(validateBatch(state, [{ kind: 'delete', objectId: 'group', opId: 'delete' }], agent)).toMatchObject({
      ok: false,
      reasons: [{ code: 'LOCKED' }],
    });
  });
  it('allows content inside background-locked sections and refuses bounds edits', () => {
    let state = apply(emptyState(), [create('section', null, 'section'), create('child', 'section')]).state;
    state = apply(state, [{ kind: 'lock', objectId: 'section', opId: 'lock', patch: { mode: 'background' } }]).state;
    expect(
      validateBatch(
        state,
        [{ kind: 'move', objectId: 'child', opId: 'move', patch: { position: { x: 0, y: 0 } } }],
        agent
      ).ok
    ).toBe(true);
    expect(
      validateBatch(
        state,
        [{ kind: 'move', objectId: 'section', opId: 'move', patch: { position: { x: 0, y: 0 } } }],
        agent
      ).ok
    ).toBe(false);
    expect(
      validateBatch(
        state,
        [{ kind: 'lock', objectId: 'child', opId: 'invalid-mode', patch: { mode: 'background' } }],
        agent
      ).ok
    ).toBe(false);
  });
  it('preserves world position on reparent and soft-deletes/restores a hierarchy', () => {
    let state = apply(emptyState(), [
      create('group', null, 'group'),
      create('child', 'group'),
      create('frame', null, 'frame'),
    ]).state;
    const original = worldTransform(state, 'child');
    state = apply(state, [
      {
        kind: 'reparent',
        objectId: 'child',
        opId: 'parent',
        patch: { parentId: 'frame', order: 2, preserveWorld: true },
      },
    ]).state;
    expect(worldTransform(state, 'child')).toEqual(original);
    expect(bounds(state, 'group')).toMatchObject({ width: 0 });
    state = apply(state, [{ kind: 'delete', objectId: 'frame', opId: 'delete' }]).state;
    expect(state.objects.child?.deletedAt).toBe(100);
    state = apply(state, [{ kind: 'restore', objectId: 'frame', opId: 'restore' }]).state;
    expect(state.objects.child?.deletedAt).toBeNull();
  });
  it('restores only the subtree members deleted by the same operation, even at the same timestamp', () => {
    let state = apply(emptyState(), [
      create('group', null, 'group'),
      create('old', 'group'),
      create('live', 'group'),
    ]).state;
    state = apply(state, [{ kind: 'delete', opId: 'old-delete', objectId: 'old' }]).state;
    state = apply(state, [{ kind: 'delete', opId: 'group-delete', objectId: 'group' }]).state;
    state = apply(state, [{ kind: 'restore', opId: 'restore', objectId: 'group' }]).state;
    expect(state.objects.old?.deletedAt).toBe(100);
    expect(state.objects.live?.deletedAt).toBeNull();
  });
  it('rejects a restore that would leave a live descendant under an independently deleted container', () => {
    let state = apply(emptyState(), [
      create('root', null, 'group'),
      create('middle', 'root', 'group'),
      create('leaf', 'middle'),
    ]).state;
    state = apply(state, [{ kind: 'delete', opId: 'delete-root', objectId: 'root' }]).state;
    state.objects.middle = { ...state.objects.middle, deletionOpId: 'independent-delete' };
    const before = structuredClone(state);
    expect(validateBatch(state, [{ kind: 'restore', opId: 'restore-root', objectId: 'root' }], human)).toMatchObject({
      ok: false,
      reasons: [{ code: 'INVALID', objectId: 'leaf' }],
    });
    expect(state).toEqual(before);
  });
  it('computes rotated nested group bounds in parent and world coordinates', () => {
    let state = apply(emptyState(), [
      create('frame', null, 'frame'),
      create('group', 'frame', 'group'),
      create('child', 'group'),
    ]).state;
    state = apply(state, [{ kind: 'update', opId: 'rotate', objectId: 'group', patch: { rotation: 90 } }]).state;
    const local = bounds(state, 'group', 'local');
    const world = bounds(state, 'group');
    if ('hierarchy' in local || 'hierarchy' in world) throw new Error('Healthy geometry must have bounds');
    expect(local.x).toBeCloseTo(-90);
    expect(local.y).toBeCloseTo(30);
    expect(local.width).toBeCloseTo(80);
    expect(local.height).toBeCloseTo(100);
    expect(world.x).toBeCloseTo(local.x + 10);
    expect(world.y).toBeCloseTo(local.y + 20);
  });
  it('reverts comments and preserves a container with another author child', () => {
    const base = apply(emptyState(), [create('group', null, 'group')]);
    const next = apply(base.state, [create('child', 'group')], agent);
    const commented = apply(next.state, [
      { kind: 'comment', opId: 'comment', objectId: 'child', patch: { id: 'comment', text: 'note' } },
    ]);
    const commands = revertAuthor(
      commented.state,
      [...base.operations, ...next.operations, ...commented.operations],
      human
    );
    const reverted = apply(commented.state, commands);
    expect(reverted.state.comments).toHaveLength(0);
    expect(reverted.state.objects.group?.deletedAt).toBeNull();
    expect(reverted.state.objects.child?.deletedAt).toBeNull();
    expect(
      revertAuthor(commented.state, [...base.operations, ...next.operations, ...commented.operations], human)
    ).toEqual(commands);
  });
  it('preserves a container when another author edited an originally same-author descendant', () => {
    const base = apply(emptyState(), [create('group', null, 'group'), create('child', 'group')]);
    const next = apply(
      base.state,
      [{ kind: 'update', opId: 'edit', objectId: 'child', patch: { content: { type: 'text', text: 'retain' } } }],
      agent
    );
    const reverted = apply(next.state, revertAuthor(next.state, [...base.operations, ...next.operations], human));
    expect(reverted.state.objects.group?.deletedAt).toBeNull();
    expect(reverted.state.objects.child?.content).toMatchObject({ text: 'retain' });
  });
  it('resizes a frame without scaling its children and rejects a fixed size on an auto-bounded group', () => {
    const state = apply(emptyState(), [
      create('frame', null, 'frame'),
      create('child', 'frame'),
      create('group', null, 'group'),
    ]).state;
    const childBefore = structuredClone(state.objects.child);
    const resized = apply(state, [
      { kind: 'update', opId: 'resize', objectId: 'frame', patch: { size: { width: 200, height: 300 } } },
    ]).state;
    expect(resized.objects.child).toEqual(childBefore);
    expect(
      validateBatch(
        state,
        [{ kind: 'update', opId: 'group-resize', objectId: 'group', patch: { size: { width: 200, height: 300 } } }],
        human
      ).ok
    ).toBe(false);
  });
  it('treats subcanvas as an explicitly sized container without scaling children', () => {
    const base = apply(emptyState(), [create('sub', null, 'subcanvas'), create('child', 'sub')]);
    const childBefore = structuredClone(base.state.objects.child);
    const resized = apply(base.state, [
      { kind: 'update', opId: 'resize-sub', objectId: 'sub', patch: { size: { width: 600, height: 400 } } },
    ]);
    expect(bounds(resized.state, 'sub', 'local')).toEqual({ x: 10, y: 20, width: 600, height: 400 });
    expect(resized.state.objects.child).toEqual(childBefore);
    const deleted = apply(resized.state, [{ kind: 'delete', opId: 'delete-sub', objectId: 'sub' }]);
    const operation = deleted.operations[0];
    if (!operation) throw new Error('missing delete');
    const inverse = invertOperation(operation, 0);
    expect(inverse).toHaveLength(1);
    expect(inverse[0]?.kind).toBe('restore');
    const restored = apply(deleted.state, inverse);
    expect(restored.operations[0]?.kind).toBe('restore');
    expect(restored.state.objects.sub?.deletedAt).toBeNull();
    expect(restored.state.objects.child?.deletedAt).toBeNull();
  });
  it('validates against frozen input without exposing the staging table', () => {
    const initial = apply(emptyState(), [create('group', null, 'group')]).state;
    Object.freeze(initial.objects);
    const result = apply(initial, [create('child', 'group')]);
    expect(Object.keys(initial.objects)).toEqual(['group']);
    expect(Object.keys(result.state.objects)).toEqual(['group', 'child']);
    expect(Object.getPrototypeOf(result.state.objects)).toBe(Object.prototype);
  });
  it('inverts explicit lock and unlock commands through their permitted operations', () => {
    const base = apply(emptyState(), [create('text')]);
    const locked = apply(base.state, [{ kind: 'lock', opId: 'lock', objectId: 'text', patch: { mode: 'subtree' } }]);
    const lockOp = locked.operations[0];
    if (!lockOp) throw new Error('missing lock');
    const unlocked = apply(locked.state, invertOperation(lockOp, 0));
    expect(unlocked.state.objects.text?.lock).toBeNull();
    const unlockOp = unlocked.operations[0];
    if (!unlockOp) throw new Error('missing unlock');
    expect(apply(unlocked.state, invertOperation(unlockOp, 0)).state.objects.text?.lock).toBe('subtree');
  });
});
