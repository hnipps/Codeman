import { CanvasUndo } from '../packages/canvas/src/undo.js';
import { describe, it, expect, vi } from 'vitest';
import { EditQueue, Refused, type Edit, type Acknowledged } from '../packages/canvas/src/edit-queue.js';
import type { ViewObject } from '../packages/canvas/src/model.js';
const object: ViewObject = {
  id: 'note',
  type: 'text',
  parentId: null,
  order: 0,
  position: { x: 0, y: 0 },
  size: { width: 200, height: 100 },
  rotation: 0,
  content: { type: 'text', text: 'Before' },
  author: { kind: 'human', userId: 'owner' },
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  revision: 1,
};
const move = (x: number): Edit => ({
  kind: 'move',
  objectId: 'note',
  opId: `move-${x}`,
  patch: { position: { x, y: 0 } },
});
const ack = (op: Edit, seq = 1): Acknowledged => ({
  seq,
  opId: op.opId,
  objectId: op.objectId,
  kind: op.kind,
  prev: [
    {
      objectId: 'note',
      before: object,
      after: { ...object, position: op.kind === 'move' ? op.patch.position : object.position, revision: seq + 1 },
    },
  ],
});
function fixture(send: (ops: Edit[], since: number) => Promise<Acknowledged[]>, memory = new Map<string, string>()) {
  let displayed: ViewObject[] = [],
    status = '',
    message = '';
  const queue = new EditQueue({
    storage: {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => {
        memory.set(key, value);
      },
      removeItem: (key) => {
        memory.delete(key);
      },
    },
    key: 'drafts',
    send,
    display: (objects) => {
      displayed = objects;
    },
    status: (s, m) => {
      status = s;
      message = m;
    },
    acknowledged: () => {},
  });
  queue.receive({ seq: 0, objects: [object] });
  queue.online(true);
  return { queue, memory, display: () => displayed, status: () => status, message: () => message };
}
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
describe('durable canvas edit queue', () => {
  it('displays immediately, sends in order with one batch in flight, and removes only acknowledged operations', async () => {
    let release: (ops: Acknowledged[]) => void = () => {};
    const send = vi.fn(
      (ops: Edit[]) =>
        new Promise<Acknowledged[]>((resolve) => {
          release = resolve;
          expect(ops).toHaveLength(1);
        })
    );
    const f = fixture(send);
    f.queue.enqueue([move(10)]);
    f.queue.enqueue([move(20)]);
    expect(f.display()[0].position.x).toBe(20);
    expect(send).toHaveBeenCalledTimes(1);
    expect(f.memory.get('drafts')).toContain('move-20');
    release([ack(move(10))]);
    await settle();
    expect(send).toHaveBeenCalledTimes(2);
    expect(f.memory.get('drafts')).not.toContain('move-10');
    release([ack(move(20), 2)]);
    await settle();
    expect(f.memory.has('drafts')).toBe(false);
    expect(f.status()).toBe('saved');
    f.queue.stop();
  });
  it('resends the exact opId after a lost acknowledgement and restores localStorage after reload', async () => {
    const send = vi.fn().mockRejectedValue(new Error('Disconnected'));
    const f = fixture(send);
    f.queue.enqueue([move(30)]);
    await settle();
    expect(f.status()).toBe('failed');
    f.queue.stop();
    const resend = vi.fn(async (ops: Edit[]) => ops.map((op) => ack(op)));
    const restored = fixture(resend, f.memory);
    expect(resend.mock.calls[0][0][0].opId).toBe('move-30');
    await settle();
    expect(restored.memory.size).toBe(0);
    expect(restored.display()[0].position.x).toBe(30);
    restored.queue.stop();
  });
  it('rolls back refused optimistic writes, explains why, and offers retry or discard', async () => {
    const send = vi.fn().mockRejectedValue(new Refused('Edit refused: object is locked.'));
    const f = fixture(send);
    f.queue.enqueue([move(40)]);
    await settle();
    expect(f.display()[0].position.x).toBe(0);
    expect(f.status()).toBe('refused');
    expect(f.message()).toContain('locked');
    expect(f.memory.size).toBe(1);
    expect(f.queue.enqueue([move(50)])).toBe(false);
    send.mockImplementation(async (ops: Edit[]) => ops.map((op) => ack(op)));
    f.queue.retry();
    await settle();
    expect(f.display()[0].position.x).toBe(40);
    f.queue.enqueue([move(60)]);
    await settle();
    f.queue.discard();
    expect(f.memory.size).toBe(0);
    f.queue.stop();
  });
  it('refuses new offline writes and keeps earlier operations durable until reconnect', async () => {
    let release: (ops: Acknowledged[]) => void = () => {};
    const f = fixture(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    f.queue.enqueue([move(10)]);
    f.queue.online(false);
    expect(f.queue.enqueue([move(20)])).toBe(false);
    expect(f.memory.get('drafts')).toContain('move-10');
    expect(f.memory.get('drafts')).not.toContain('move-20');
    release([ack(move(10))]);
    await settle();
    f.queue.stop();
  });
  it('reapplies pending positions over concurrent content without losing the content', async () => {
    const f = fixture(() => new Promise(() => {}));
    f.queue.enqueue([move(70)]);
    f.queue.receive({ seq: 1, objects: [{ ...object, content: { type: 'text', text: 'Agent text' } }] });
    expect(f.display()[0].position.x).toBe(70);
    expect(f.display()[0].content.text).toBe('Agent text');
    f.queue.stop();
  });
});

describe('safe acknowledged history', () => {
  it('undoes only acknowledged fields and refuses later conflicting edits', () => {
    const undo = new CanvasUndo();
    undo.acknowledge([ack(move(10))], 'note');
    const current = {
      ...object,
      position: { x: 10, y: 0 },
      content: { type: 'text', text: 'Agent update' },
      revision: 3,
    };
    const action = undo.prepare('undo', [current]);
    expect(action?.operations[0]).toMatchObject({
      kind: 'revert',
      expectedRevision: 3,
      patch: { position: { x: 0, y: 0 } },
    });
    expect(action?.operations[0]).not.toHaveProperty('patch.content');
    undo.refused();
    expect(() => undo.prepare('undo', [{ ...current, position: { x: 15, y: 0 } }])).toThrow('later change');
  });
  it('refuses to undo container creation when another author added a child', () => {
    const undo = new CanvasUndo();
    undo.acknowledge(
      [{ ...ack(move(10)), kind: 'create', prev: [{ objectId: 'note', before: null, after: object }] }],
      'note'
    );
    expect(() => undo.prepare('undo', [object, { ...object, id: 'child', parentId: 'note' }])).toThrow('later work');
  });
});
