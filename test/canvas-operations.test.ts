import { describe, expect, it } from 'vitest';
import { emptyState, effectiveLock, worldTransform, bounds, type CanvasState } from '../src/canvas/model.js';
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
  it('applies and inverts create, typed update and movement', () => {
    let result = apply(emptyState(), [create('text')]);
    result = apply(result.state, [
      { kind: 'update', objectId: 'text', opId: 'update', patch: { content: { type: 'text', text: 'changed' } } },
    ]);
    const op = result.operations[0];
    if (!op) throw new Error('missing op');
    expect(apply(result.state, invertOperation(op)).state.objects.text?.content).toEqual({
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
    expect(bounds(state, 'group').width).toBe(0);
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
  it('computes rotated nested group bounds in parent and world coordinates', () => {
    let state = apply(emptyState(), [
      create('frame', null, 'frame'),
      create('group', 'frame', 'group'),
      create('child', 'group'),
    ]).state;
    state = apply(state, [{ kind: 'update', opId: 'rotate', objectId: 'group', patch: { rotation: 90 } }]).state;
    const local = bounds(state, 'group', 'local');
    const world = bounds(state, 'group');
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
    const resized = apply(state, [
      { kind: 'update', opId: 'resize', objectId: 'frame', patch: { size: { width: 200, height: 300 } } },
    ]).state;
    expect(resized.objects.child).toEqual(state.objects.child);
    expect(
      validateBatch(
        state,
        [{ kind: 'update', opId: 'group-resize', objectId: 'group', patch: { size: { width: 200, height: 300 } } }],
        human
      ).ok
    ).toBe(false);
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
    const unlocked = apply(locked.state, invertOperation(lockOp));
    expect(unlocked.state.objects.text?.lock).toBeNull();
    const unlockOp = unlocked.operations[0];
    if (!unlockOp) throw new Error('missing unlock');
    expect(apply(unlocked.state, invertOperation(unlockOp)).state.objects.text?.lock).toBe('subtree');
  });
});
