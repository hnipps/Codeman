import { resized } from '../packages/canvas/src/resize.js';
import { targets, selectRegion } from '../packages/canvas/src/select.js';
import { movedPosition, reparentPosition } from '../packages/canvas/src/drag.js';
import { CanvasUndo } from '../packages/canvas/src/undo.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchHistory, forgetSharedHistory } from '../packages/canvas/src/sync.js';
import {
  EditQueue,
  Refused,
  type Edit,
  type Acknowledged,
  type QueuedRequest,
  optimistic,
  requestIds,
} from '../packages/canvas/src/edit-queue.js';
beforeEach(() => forgetSharedHistory());
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
function fixture(
  send: (ops: Edit[], since: number) => Promise<Acknowledged[]>,
  memory = new Map<string, string>(),
  sendCommand?: (request: QueuedRequest) => Promise<{ records: Acknowledged[]; sequences: number[] }>,
  refused?: (operations: Edit[], message: string) => void
) {
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
    sendCommand,
    refused,
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
  it('persists compound identity before sending and restores the same command after a lost response', async () => {
    const transport = vi.fn(async (_request: QueuedRequest) => {
      throw new Error('Lost response');
    });
    const f = fixture(async () => [], new Map(), transport);
    f.queue.enqueueCommand({
      tool: 'canvas_arrange',
      arguments: { action: 'duplicate', targetIds: ['note'], offset: { x: 24, y: 24 } },
    });
    await settle();
    expect(f.status()).toBe('failed');
    const original = transport.mock.calls[0];
    const data = JSON.parse(f.memory.get('drafts') ?? '{}');
    expect(Object.values(data.requests)).toHaveLength(1);
    f.queue.stop();
    const resend = vi.fn(async (_request: QueuedRequest) => ({ records: [ack(move(24))], sequences: [1] }));
    const restored = fixture(async () => [], f.memory, resend);
    await settle();
    expect(resend.mock.calls[0]).toEqual(original);
    expect(restored.memory.size).toBe(0);
    expect(restored.display()[0].position.x).toBe(24);
    restored.queue.stop();
  });
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
  it('retries the original batch separately from newer writes after a lost acknowledgement', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('Lost acknowledgement'))
      .mockImplementation(async (ops: Edit[]) => ops.map((op) => ack(op, op.opId === 'move-20' ? 2 : 1)));
    const f = fixture(send);
    f.queue.enqueue([move(10)]);
    await settle();
    f.queue.enqueue([move(20)]);
    await settle();
    expect(send.mock.calls[1][0].map((op: Edit) => op.opId)).toEqual(['move-10']);
    expect(send.mock.calls[2][0].map((op: Edit) => op.opId)).toEqual(['move-20']);
    expect(f.display()[0].position.x).toBe(20);
    f.queue.stop();
  });
  it('shows Saving during an automatic resend so in-flight edits are not offered for discard', async () => {
    vi.useFakeTimers();
    let release: (ops: Acknowledged[]) => void = () => {};
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('Disconnected'))
      .mockImplementation(
        () =>
          new Promise<Acknowledged[]>((resolve) => {
            release = resolve;
          })
      );
    const f = fixture(send);
    try {
      f.queue.enqueue([move(10)]);
      await settle();
      expect(f.status()).toBe('failed');
      await vi.advanceTimersByTimeAsync(1500);
      expect(f.status()).toBe('saving');
      expect(f.memory.get('drafts')).toContain('move-10');
      release([ack(move(10))]);
      await settle();
      expect(f.status()).toBe('saved');
    } finally {
      f.queue.stop();
      vi.useRealTimers();
    }
  });
  it('rolls back a refused optimistic write, explains why, and keeps editing available', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Refused('Edit refused: object is locked.'));
    const f = fixture(send);
    f.queue.enqueue([move(40)]);
    await settle();
    expect(f.display()[0].position.x).toBe(0);
    expect(f.status()).toBe('refused');
    expect(f.message()).toContain('locked');
    expect(f.memory.size).toBe(0);
    send.mockImplementation(async (ops: Edit[]) => ops.map((op) => ack(op)));
    expect(f.queue.enqueue([move(50)])).toBe(true);
    await settle();
    expect(send.mock.calls.map((call) => call[0][0].opId)).toEqual(['move-40', 'move-50']);
    expect(f.display()[0].position.x).toBe(50);
    expect(f.status()).toBe('saved');
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

const text = (objectId: string, value: string, opId = `text-${objectId}-${value.replace(/\W/g, '')}`): Edit => ({
  kind: 'update',
  objectId,
  opId,
  expectedRevision: 1,
  patch: { content: { type: 'text', text: value } },
});
const arrangeRequest = {
  tool: 'canvas_arrange' as const,
  arguments: { action: 'order' as const, targetIds: ['note'], placement: 'back' as const },
};
function controlled<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
describe('a refusal discards only the refused submission', () => {
  it('still sends a text draft queued behind a refused compound, in order, and ends Saved', async () => {
    const command = controlled<{ records: Acknowledged[]; sequences: number[] }>();
    const send = vi.fn(async (ops: Edit[]) => ops.map((op, i) => ack(op, 10 + i)));
    const refused = vi.fn();
    const f = fixture(send, new Map(), () => command.promise, refused);
    expect(f.queue.enqueueCommand(arrangeRequest)).toBe(true);
    expect(f.queue.enqueue([text('note', 'Typed while dragging')])).toBe(true);
    command.reject(new Refused('Locked', [{ code: 'LOCKED', objectId: 'note', message: 'Locked' }]));
    await settle();
    await settle();
    expect(refused).toHaveBeenCalledTimes(1);
    expect(refused.mock.calls[0][0]).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].map((op: Edit) => op.opId)).toEqual(['text-note-Typedwhiledragging']);
    expect(f.queue.holds('text-note-Typedwhiledragging')).toBe(false);
    expect(f.status()).toBe('saved');
    expect(f.memory.size).toBe(0);
    expect(f.queue.enqueue([text('note', 'More')])).toBe(true);
    await settle();
    expect(send).toHaveBeenCalledTimes(2);
    f.queue.stop();
  });
  it('survives two refusals in a row and still sends the later edit', async () => {
    const command = controlled<{ records: Acknowledged[]; sequences: number[] }>();
    const send = vi.fn(async (ops: Edit[]) => {
      if (ops[0].objectId === 'first')
        throw new Refused('Changed', [{ code: 'REVISION', objectId: 'first', message: 'Object revision changed' }]);
      return ops.map((op) => ack(op, 20));
    });
    const f = fixture(send, new Map(), () => command.promise);
    f.queue.enqueueCommand(arrangeRequest);
    f.queue.enqueue([text('first', 'A')]);
    f.queue.enqueue([text('second', 'B')]);
    command.reject(new Refused('Locked', [{ code: 'LOCKED', objectId: 'note', message: 'Locked' }]));
    for (let i = 0; i < 4; i++) await settle();
    expect(send.mock.calls.map((call) => call[0][0].objectId)).toEqual(['first', 'second']);
    expect(f.status()).toBe('saved');
    expect(f.memory.size).toBe(0);
    f.queue.stop();
  });
  it('keeps three text edits to different objects through a refusal that lands while offline', async () => {
    const command = controlled<{ records: Acknowledged[]; sequences: number[] }>();
    const send = vi.fn(async (ops: Edit[]) => ops.map((op) => ack(op, 30)));
    const f = fixture(send, new Map(), () => command.promise);
    f.queue.enqueueCommand(arrangeRequest);
    for (const id of ['one', 'two', 'three']) f.queue.enqueue([text(id, id)]);
    f.queue.online(false);
    command.reject(new Refused('Locked', [{ code: 'LOCKED', objectId: 'note', message: 'Locked' }]));
    await settle();
    expect(send).not.toHaveBeenCalled();
    expect(f.memory.get('drafts')).toContain('text-three-three');
    f.queue.online(true);
    for (let i = 0; i < 6; i++) await settle();
    expect(send.mock.calls.map((call) => call[0].map((op: Edit) => op.objectId))).toEqual([
      ['one'],
      ['two'],
      ['three'],
    ]);
    expect(f.status()).toBe('saved');
    expect(f.memory.size).toBe(0);
    f.queue.stop();
  });
  it('drops later edits that depend on an object the refused batch would have created', async () => {
    const send = vi.fn(async (ops: Edit[]) => {
      if (ops[0].kind === 'create') throw new Refused('No', [{ code: 'INVALID', message: 'No' }]);
      return ops.map((op) => ack(op, 40));
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture(async (ops, since) => {
      await gate;
      return send(ops, since);
    });
    f.queue.enqueue([
      {
        kind: 'create',
        opId: 'make-x',
        objectId: 'x',
        patch: {
          parentId: null,
          order: 0,
          position: { x: 0, y: 0 },
          rotation: 0,
          lock: null,
          content: { type: 'text', text: '' },
        },
      },
    ]);
    f.queue.enqueue([text('x', 'Depends')]);
    f.queue.enqueue([text('note', 'Independent')]);
    release();
    for (let i = 0; i < 4; i++) await settle();
    expect(send.mock.calls.map((call) => call[0][0].opId)).toEqual(['make-x', 'text-note-Independent']);
    f.queue.stop();
  });
});

describe('dependants of a refused compound', () => {
  const create = (objectId: string, parentId: string | null = null): Edit => ({
    kind: 'create',
    opId: `make-${objectId}`,
    objectId,
    patch: {
      parentId,
      order: 0,
      position: { x: 0, y: 0 },
      rotation: 0,
      lock: null,
      content: { type: 'text', text: '' },
    },
  });
  it('counts the group id a refused compound would have created', async () => {
    const command = controlled<{ records: Acknowledged[]; sequences: number[] }>();
    const send = vi.fn(async (ops: Edit[]) => ops.map((op) => ack(op, 50)));
    const sendCommand = vi.fn(() => command.promise);
    const f = fixture(send, new Map(), sendCommand);
    f.queue.enqueueCommand({
      tool: 'canvas_arrange',
      arguments: { action: 'group', targetIds: ['note'], groupId: 'g', label: 'G', parentId: null },
    });
    f.queue.enqueue([create('child', 'g')]);
    f.queue.enqueueCommand({
      tool: 'canvas_arrange',
      arguments: { action: 'order', targetIds: ['g'], placement: 'front' },
    });
    f.queue.enqueue([text('note', 'Kept')]);
    command.reject(new Refused('Locked', [{ code: 'LOCKED', objectId: 'note', message: 'Locked' }]));
    for (let i = 0; i < 4; i++) await settle();
    expect(send.mock.calls.map((call) => call[0][0].opId)).toEqual(['text-note-Kept']);
    expect(sendCommand).toHaveBeenCalledTimes(1);
    f.queue.stop();
  });
  it('compares ids structurally: free text that quotes an id is not a dependency', async () => {
    expect([...requestIds({ action: 'group', targetIds: ['a', 'b'], groupId: 'g', label: '"x"' })].sort()).toEqual([
      'a',
      'b',
      'g',
    ]);
    expect(
      requestIds({ operations: [{ kind: 'update', objectId: 'y', patch: { content: { type: 'text', text: 'x' } } }] })
    ).toEqual(new Set(['y']));
    const send = vi.fn(async (ops: Edit[]) => {
      if (ops[0].kind === 'create') throw new Refused('No', [{ code: 'INVALID', message: 'No' }]);
      return ops.map((op) => ack(op, 60));
    });
    const sendCommand = vi.fn(async () => ({ records: [], sequences: [] }));
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture(
      async (ops, since) => {
        await gate;
        return send(ops, since);
      },
      new Map(),
      sendCommand
    );
    f.queue.enqueue([create('x')]);
    f.queue.enqueueCommand({
      tool: 'canvas_arrange',
      arguments: { action: 'group', targetIds: ['note'], groupId: 'h', label: 'x', parentId: null },
    });
    release();
    for (let i = 0; i < 4; i++) await settle();
    expect(sendCommand).toHaveBeenCalledTimes(1);
    f.queue.stop();
  });
  it('switches the optimistic type when a link becomes an embed', () => {
    const link: ViewObject = {
      ...object,
      id: 'l',
      type: 'link',
      content: { type: 'link', url: 'https://example.com/' },
    };
    const [shown] = optimistic(
      [link],
      [{ kind: 'update', opId: 'u', objectId: 'l', patch: { content: { type: 'embed', url: 'https://example.com/' } } }]
    );
    expect(shown.type).toBe('embed');
  });
});

describe('one catch-up per write', () => {
  it('shares one /ops walk between the command acknowledgement and the change event', async () => {
    const { sendCommand } = await import('../packages/canvas/src/edit-queue.js');
    const record = { ...ack(move(7), 7), opId: 'op-7' };
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        urls.push(`${init?.method ?? 'GET'} ${url}`);
        if (init?.method === 'POST')
          return new Response(JSON.stringify({ success: true, data: { seq: 7, sequences: [7] } }));
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response(JSON.stringify({ success: true, data: { seq: 7, operations: [record] } }));
      })
    );
    try {
      const [command, event] = await Promise.all([
        sendCommand((path) => path, 'shared', { ...arrangeRequest, requestId: crypto.randomUUID() }, 6),
        // The change event the write produced arrives while the acknowledgement walks history.
        new Promise((resolve) => setTimeout(resolve, 1)).then(() =>
          fetchHistory((path) => path, 'shared', 6, undefined, 7)
        ),
      ]);
      expect(command.sequences).toEqual([7]);
      expect(event.operations).toHaveLength(1);
      expect(urls.filter((url) => url.startsWith('GET'))).toEqual(['GET /api/canvas/shared/ops?since=6']);
      // A reconnect catch-up has no target sequence and always walks again.
      await fetchHistory((path) => path, 'shared', 6);
      expect(urls.filter((url) => url.startsWith('GET'))).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('compound acknowledgement cost', () => {
  it('acknowledges a compound against 5,000 operations without requesting the whole log', async () => {
    const { sendCommand } = await import('../packages/canvas/src/edit-queue.js');
    const record = (seq: number) => ({ ...ack(move(seq), seq), opId: `op-${seq}` });
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(`${init?.method ?? 'GET'} ${url}`);
      if (init?.method === 'POST')
        return new Response(JSON.stringify({ success: true, data: { seq: 5001, sequences: [5001] } }));
      const since = Number(new URL(url, 'http://canvas.test').searchParams.get('since'));
      const operations = Array.from({ length: 5001 - since }, (_, i) => record(since + 1 + i)).slice(0, 500);
      return new Response(JSON.stringify({ success: true, data: { seq: 5001, operations } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await sendCommand(
        (path) => path,
        'ws',
        { ...arrangeRequest, requestId: crypto.randomUUID() },
        5000
      );
      expect(urls.some((url) => url.includes('since=0'))).toBe(false);
      expect(urls.filter((url) => url.startsWith('GET'))).toEqual(['GET /api/canvas/ws/ops?since=5000']);
      expect(result.sequences).toEqual([5001]);
      expect(result.records.map((op) => op.seq)).toEqual([5001]);
      urls.length = 0;
      const noop = vi.fn(
        async () => new Response(JSON.stringify({ success: true, data: { seq: 5001, sequences: [], noop: true } }))
      );
      vi.stubGlobal('fetch', noop);
      const quiet = await sendCommand(
        (path) => path,
        'ws',
        { ...arrangeRequest, requestId: crypto.randomUUID() },
        5001
      );
      expect(quiet).toEqual({ records: [], sequences: [] });
      expect(noop).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('server sequence history', () => {
  it('selects acknowledged sequences and moves returned undo sequences to redo', () => {
    const undo = new CanvasUndo();
    undo.acknowledge([ack(move(10), 2), ack(move(20), 3)], 'note');
    expect(undo.prepare('undo')).toEqual({ tool: 'canvas_history', arguments: { action: 'undo', sequences: [2, 3] } });
    undo.acknowledge([ack(move(0), 4)], 'note');
    expect(undo.prepare('redo')).toEqual({ tool: 'canvas_history', arguments: { action: 'redo', sequences: [4] } });
    undo.refused();
    expect(undo.available('redo')).toBe(true);
  });
  it('releases a pending history step when the server answers with a no-op', () => {
    const undo = new CanvasUndo();
    undo.acknowledge([ack(move(10), 2)], 'note');
    undo.prepare('undo');
    undo.acknowledge([], null);
    expect(undo.available('undo')).toBe(true);
  });
});

describe('selection geometry', () => {
  it('normalizes selected parent/child overlap and keeps explicit containment on ordinary movement', () => {
    const parent = {
      ...object,
      id: 'frame',
      type: 'frame',
      position: { x: 100, y: 100 },
      rotation: 90,
      content: { type: 'frame', label: 'Frame' },
    };
    const child = { ...object, parentId: parent.id, position: { x: 20, y: 30 } };
    expect(targets([parent, child], [parent.id, child.id]).map((o) => o.id)).toEqual(['frame']);
    const position = movedPosition([parent, child], child, { x: 10, y: 0 });
    expect(position.x).toBeCloseTo(20);
    expect(position.y).toBeCloseTo(20);
    expect(child.parentId).toBe('frame');
    const root = reparentPosition([parent, child], child, null);
    expect(root.x).toBeCloseTo(70);
    expect(root.y).toBeCloseTo(120);
  });
  it('uses enclosure for marquee, centers for polygon and immediate members of the active container', () => {
    expect(
      selectRegion([object], { kind: 'rectangle', rect: { x: -1, y: -1, width: 300, height: 200 } }, null)
    ).toEqual(['note']);
    expect(selectRegion([object], { kind: 'rectangle', rect: { x: 1, y: 1, width: 10, height: 10 } }, null)).toEqual(
      []
    );
    expect(
      selectRegion(
        [object],
        {
          kind: 'polygon',
          points: [
            { x: 0, y: 0 },
            { x: 200, y: 0 },
            { x: 200, y: 100 },
            { x: 0, y: 100 },
          ],
        },
        null
      )
    ).toEqual(['note']);
    expect(
      selectRegion(
        [{ ...object, parentId: 'frame' }],
        { kind: 'rectangle', rect: { x: -1, y: -1, width: 300, height: 200 } },
        null
      )
    ).toEqual([]);
  });
});

describe('resize geometry', () => {
  it('resizes proportionally and from center without scaling children', () => {
    const child = { ...object, id: 'child', parentId: 'note' };
    const result = resized([object, child], object, 'se', { x: 50, y: 50 }, true, true);
    expect(result?.size).toEqual({ width: 400, height: 200 });
    expect(result?.position).toEqual({ x: -100, y: -50 });
    expect(child.position).toEqual({ x: 0, y: 0 });
    expect(resized([object], object, 'w', { x: -20, y: 0 }, false, false)?.position.x).toBe(-20);
  });
});

import { emptyState, type CanvasState } from '../src/canvas/model.js';
import { validateBatch, type Command } from '../src/canvas/operations.js';
import { human, agent, create } from './canvas-fixtures.js';
function apply(state: CanvasState, commands: Command[], author = human) {
  const result = validateBatch(state, commands, author, state.seq + 100);
  if (!result.ok) throw new Error(JSON.stringify(result.reasons));
  return result;
}
import { historyCommands } from '../src/canvas/commands.js';
describe('history through the real server command validator', () => {
  it('refuses a changed revision, including a later author change to a different field', () => {
    const initial = apply(emptyState(), [create('note')]);
    const edit = apply(initial.state, [
      { kind: 'move', opId: 'move', objectId: 'note', patch: { position: { x: 20, y: 40 } } },
    ]);
    const later = apply(
      edit.state,
      [
        {
          kind: 'update',
          opId: 'agent-text',
          objectId: 'note',
          patch: { content: { type: 'text', text: 'Later work' } },
        },
      ],
      agent
    );
    expect(() =>
      historyCommands(
        later.state,
        edit.operations,
        edit.operations.map((o) => o.seq),
        human
      )
    ).toThrow();
    expect(later.state.objects.note.content.text).toBe('Later work');
  });
  it('refuses to undo container creation when a later author added a child', () => {
    const initial = apply(emptyState(), [create('frame', null, 'frame')]);
    const later = apply(initial.state, [create('child', 'frame')], agent);
    expect(() =>
      historyCommands(
        later.state,
        initial.operations,
        initial.operations.map((o) => o.seq),
        human
      )
    ).toThrow();
    expect(later.state.objects.child.deletedAt).toBeNull();
  });
});

describe('per-viewer canvas storage', () => {
  const memoryStorage = (entries: Record<string, string>) => {
    const map = new Map(Object.entries(entries));
    return {
      map,
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    };
  };
  it('scopes queue, drafts and clipboard by viewer, and never shares a clipboard between viewers', async () => {
    const { canvasStorageKeys } = await import('../packages/canvas/src/storage-keys.js');
    const a = canvasStorageKeys('user-a', 'ws');
    const b = canvasStorageKeys('user-b', 'ws');
    // Every key but the one clipboard is per viewer; PC13 added the phone's return ticket.
    expect(new Set([...Object.values(a), ...Object.values(b)]).size).toBe(28);
    expect(canvasStorageKeys('user-a', 'other').clipboard).toBe(a.clipboard);
    expect(a.edits).not.toBe(canvasStorageKeys('user-a', 'other').edits);
  });
  it('discards unscoped entries in multi-user mode and adopts them once in single-user mode', async () => {
    const { canvasStorageKeys, retireUnscopedKeys, SINGLE_USER_VIEWER } =
      await import('../packages/canvas/src/storage-keys.js');
    const legacy = {
      'codeman:canvas:ws:edits': '{"operations":[]}',
      'codeman:canvas:ws:drafts': '{}',
      'codeman:canvas:clipboard': '[]',
    };
    const shared = memoryStorage(legacy);
    retireUnscopedKeys(shared, 'user-b', 'ws');
    expect([...shared.map.keys()]).toEqual([]);
    const single = memoryStorage(legacy);
    retireUnscopedKeys(single, SINGLE_USER_VIEWER, 'ws');
    const keys = canvasStorageKeys(SINGLE_USER_VIEWER, 'ws');
    expect(Object.fromEntries(single.map)).toEqual({
      [keys.edits]: legacy['codeman:canvas:ws:edits'],
      [keys.drafts]: legacy['codeman:canvas:ws:drafts'],
      [keys.clipboard]: legacy['codeman:canvas:clipboard'],
    });
    single.map.set('codeman:canvas:clipboard', '[{"stale":true}]');
    retireUnscopedKeys(single, SINGLE_USER_VIEWER, 'ws');
    expect(single.map.get(keys.clipboard)).toBe('[]');
  });
  it('refuses a clipboard over one megabyte', async () => {
    const { clipboardTooLarge, MAX_CLIPBOARD_BYTES } = await import('../packages/canvas/src/storage-keys.js');
    expect(clipboardTooLarge('x'.repeat(MAX_CLIPBOARD_BYTES))).toBe(false);
    expect(clipboardTooLarge('x'.repeat(MAX_CLIPBOARD_BYTES + 1))).toBe(true);
  });
});
