import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasStore, CanvasStores } from '../src/canvas/canvas-store.js';
import { workspaceForCase, readWorkspaces } from '../src/canvas/workspace-registry.js';
import { rekeyCaseWorkspace } from '../src/case-rename.js';
import { deployRole } from '../src/deploy-role.js';
import { applyOperation, OperationSchema, CommandSchema } from '../src/canvas/operations.js';
import { emptyState, StateSchema, MAX_HIERARCHY_DEPTH } from '../src/canvas/model.js';
import { create, human, agent } from './canvas-fixtures.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-store-'));
  vi.stubEnv('CODEMAN_DATA_DIR', dir);
});
afterEach(() => {
  deployRole.enter('live');
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('canvas durable store', () => {
  it('replays a snapshot plus newer log entries and retains history and deduplication', () => {
    const store = new CanvasStore('workspace');
    expect(store.append([create('a')], human)).toMatchObject({ ok: true, seq: 1 });
    store.snapshot();
    expect(statSync(store.snapshotPath).mode & 0o777).toBe(0o600);
    store.append([create('b')], agent);
    const reloaded = new CanvasStore('workspace');
    expect(reloaded.read()).toEqual(store.read());
    expect(reloaded.operations()).toHaveLength(2);
    expect(reloaded.append([create('a')], human)).toMatchObject({ ok: true, seq: 1 });
    expect(readFileSync(store.logPath, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(statSync(store.logPath).mode & 0o777).toBe(0o600);
  });
  it.each(['log', 'snapshot'] as const)(
    'preserves future data loaded from a %s through edits, snapshots and replay',
    (source) => {
      const store = new CanvasStore('workspace');
      const result = store.append([create('known'), create('opaque')], human);
      if (!result.ok) throw new Error('fixture append failed');
      const operations = result.operations.map((op) => ({
        ...op,
        futureOperation: { nested: ['keep'] },
        prev: op.prev.map((change) => ({
          ...change,
          futureChange: true,
          after: {
            ...change.after,
            futureObject: { keep: true },
            type: change.objectId === 'opaque' ? 'future-widget' : change.after.type,
            content: {
              ...change.after.content,
              type: change.objectId === 'opaque' ? 'future-widget' : change.after.type,
              futureContent: ['keep'],
            },
          },
        })),
      }));
      const future = { seq: 3, opId: 'future-op', kind: 'future-operation', futurePayload: { keep: ['all'] } };
      const rawLog = [...operations, future].map((op) => JSON.stringify(op)).join('\n') + '\n';
      writeFileSync(store.logPath, rawLog);
      let expected = emptyState();
      for (const op of operations) expected = applyOperation(expected, OperationSchema.parse(op));
      expected.seq = 3;
      if (source === 'snapshot') writeFileSync(store.snapshotPath, JSON.stringify({ version: 1, state: expected }));
      const loaded = new CanvasStore('workspace');
      expect(loaded.read()).toEqual(expected);
      expect(loaded.operations()).toEqual([...operations, future]);
      const opaqueBefore = structuredClone(loaded.read().objects.opaque);
      expect(
        loaded.append(
          [{ kind: 'move', opId: 'opaque-move', objectId: 'opaque', patch: { position: { x: 9, y: 9 } } }],
          human
        ).ok
      ).toBe(false);
      expect(
        loaded.append(
          [
            {
              kind: 'update',
              opId: 'known-edit',
              objectId: 'known',
              patch: { content: { type: 'text', text: 'edited' } },
            },
          ],
          human
        ).ok
      ).toBe(true);
      expect(loaded.read().objects.known).toMatchObject({
        futureObject: { keep: true },
        content: { text: 'edited', futureContent: ['keep'] },
      });
      expect(loaded.read().objects.opaque).toEqual(opaqueBefore);
      expect(() => CommandSchema.parse({ ...create('bad'), futureRequest: true })).toThrow();
      expect(() =>
        CommandSchema.parse({
          kind: 'update',
          opId: 'bad-content',
          objectId: 'known',
          patch: { content: { type: 'text', text: 'bad', futureContent: true } },
        })
      ).toThrow();
      const state = loaded.read();
      const log = loaded.operations();
      loaded.snapshot();
      if (source === 'snapshot') expect(JSON.parse(readFileSync(loaded.snapshotPath, 'utf8')).state).toEqual(expected);
      else expect(existsSync(loaded.snapshotPath)).toBe(false);
      expect(readFileSync(loaded.logPath, 'utf8').startsWith(rawLog)).toBe(true);
      const replayed = new CanvasStore('workspace');
      expect(replayed.read()).toEqual(state);
      expect(replayed.operations()).toEqual(log);
      rmSync(loaded.snapshotPath, { force: true });
      expect(new CanvasStore('workspace').read()).toEqual(state);
      expect(new CanvasStore('workspace').operations()).toEqual(log);
    }
  );
  it.each(['snapshot', 'shutdown', 'handoff'] as const)(
    'keeps the exact future-operation replayable after %s and known later writes',
    async (flush) => {
      const stores = new CanvasStores();
      const store = stores.get('workspace');
      const created = store.append([create('text')], human);
      if (!created.ok) throw new Error('fixture append failed');
      const before = { ...store.read().objects.text, content: { type: 'text', text: 'before' } };
      const op = created.operations[0];
      const future = {
        ...op,
        seq: 2,
        opId: 'future',
        kind: 'future-operation',
        prev: [{ objectId: 'text', before, after: { ...before, content: { type: 'text', text: 'after-future' } } }],
      };
      // Use the audit's before/after sequence, with no checkpoint before the future record.
      const first = {
        ...op,
        prev: [{ objectId: 'text', before: null, after: { ...before, content: { type: 'text', text: 'before' } } }],
      };
      writeFileSync(store.logPath, [first, future].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
      store.reload();
      expect(store.read()).toMatchObject({ seq: 2, objects: { text: { content: { text: 'before' } } } });
      expect(store.operations()[1]).toEqual(future);
      if (flush === 'snapshot') store.snapshot();
      else stores.flush();
      expect(existsSync(store.snapshotPath)).toBe(false);
      // A later known operation must not let a later lifecycle flush seal the gap either.
      store.append([create('later')], human);
      stores.flush();
      if (flush !== 'snapshot') {
        vi.stubEnv('CODEMAN_INSTANCE', 'lane-pc1-replay');
        vi.stubEnv('CODEMAN_NO_AUTOSTART', '1');
        vi.stubEnv('CODEMAN_DEPLOY_ROLE', 'live');
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ canvasEnabled: true }));
        writeFileSync(
          join(dir, 'workspaces.json'),
          JSON.stringify({ version: 1, workspaces: [{ id: 'workspace', caseName: 'lifecycle' }] })
        );
        const { WebServer } = await import('../src/web/server.js');
        const server = new WebServer(0, false, true);
        try {
          await server.start();
          const response = await fetch(`http://127.0.0.1:${server.boundPort}/api/canvas/workspace/objects`);
          expect(response.status).toBe(200);
          expect((await response.json()).data.seq).toBe(3);
          if (flush === 'handoff') expect(await server.changeDeployRole('retired')).toMatchObject({ kind: 'accepted' });
        } finally {
          await server.stop();
        }
        deployRole.enter('live');
        expect(existsSync(store.snapshotPath)).toBe(false);
      }
      expect(new CanvasStore('workspace').read()).toEqual(store.read());
      let understood = existsSync(store.snapshotPath)
        ? StateSchema.parse(JSON.parse(readFileSync(store.snapshotPath, 'utf8')).state)
        : emptyState();
      const snapshotSeq = understood.seq;
      // Simulate the next release: it understands future-operation's before/after payload.
      for (const line of readFileSync(store.logPath, 'utf8').trim().split('\n')) {
        const entry = OperationSchema.parse(JSON.parse(line));
        if (entry.seq <= snapshotSeq) continue;
        for (const change of entry.prev) understood.objects[change.objectId] = change.after;
        understood.seq = entry.seq;
      }
      expect(understood.objects.text.content.text).toBe('after-future');
      expect(understood.objects.later).toBeDefined();
    }
  );
  it('retains a checkpoint below a future operation that alone introduces an object', () => {
    const store = new CanvasStore('workspace');
    const result = store.append([create('a')], human);
    if (!result.ok) throw new Error('fixture append failed');
    store.snapshot();
    const checkpoint = readFileSync(store.snapshotPath, 'utf8');
    const future = {
      ...result.operations[0],
      seq: 2,
      opId: 'future-create',
      kind: 'future-operation',
      prev: [{ objectId: 'future-only', before: null, after: { ...store.read().objects.a, id: 'future-only' } }],
    };
    appendFileSync(store.logPath, JSON.stringify(future) + '\n');
    store.reload();
    store.snapshot();
    expect(readFileSync(store.snapshotPath, 'utf8')).toBe(checkpoint);
    const understood = StateSchema.parse(JSON.parse(checkpoint).state);
    const replayable = store.operations(understood.seq);
    expect(replayable).toEqual([future]);
    for (const entry of replayable) {
      for (const change of OperationSchema.parse(entry).prev) understood.objects[change.objectId] = change.after;
    }
    expect(understood.objects['future-only']).toEqual(future.prev[0].after);
  });
  it.each(['two-object', 'self-parent'] as const)(
    'diagnoses a loaded %s cycle once and preserves its records',
    (kind) => {
      const store = new CanvasStore('workspace');
      store.append([create('a'), create('b')], human);
      const state = store.read();
      state.objects.a.parentId = kind === 'self-parent' ? 'a' : 'b';
      state.objects.b = { ...state.objects.b, type: 'future-widget', parentId: 'a' };
      writeFileSync(store.snapshotPath, JSON.stringify({ version: 1, state }));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const loaded = new CanvasStore('workspace');
        loaded.reload();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('Cyclic'),
          expect.objectContaining({ objectIds: expect.arrayContaining(['a']) })
        );
        expect(loaded.read()).toEqual(state);
        expect(
          loaded.append(
            [{ kind: 'move', objectId: 'a', opId: 'move-cycle', patch: { position: { x: 1, y: 2 } } }],
            human
          )
        ).toMatchObject({ ok: false, reasons: [{ code: 'CYCLE' }] });
        expect(loaded.read()).toEqual(state);
      } finally {
        warn.mockRestore();
      }
    }
  );
  it('loads a chain at the bound and diagnoses a cycle longer than the bound once', () => {
    const store = new CanvasStore('workspace');
    store.append([create('seed', null, 'group')], human);
    const seed = store.read().objects.seed;
    const state = emptyState();
    state.seq = 1;
    for (let i = 0; i < MAX_HIERARCHY_DEPTH; i++) {
      const id = `n${i}`;
      state.objects[id] = { ...seed, id, parentId: i ? `n${i - 1}` : null };
    }
    writeFileSync(store.snapshotPath, JSON.stringify({ version: 1, state }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      store.reload();
      expect(warn).not.toHaveBeenCalled();
      expect(store.read()).toEqual(state);
      state.objects.extra = { ...seed, id: 'extra', parentId: `n${MAX_HIERARCHY_DEPTH - 1}` };
      state.objects.n0.parentId = 'extra';
      writeFileSync(store.snapshotPath, JSON.stringify({ version: 1, state }));
      store.reload();
      store.reload();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(store.read()).toEqual(state);
      expect(
        store.append([{ kind: 'move', opId: 'long-cycle', objectId: 'n0', patch: { position: { x: 0, y: 0 } } }], human)
      ).toMatchObject({ ok: false, reasons: [{ code: 'HIERARCHY_LIMIT' }] });
    } finally {
      warn.mockRestore();
    }
  });
  it('ignores a torn final transaction and repairs its tail before appending', () => {
    const store = new CanvasStore('workspace');
    store.append([create('a')], human);
    appendFileSync(store.logPath, '{"version":1,"operations":[{"seq":2');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loaded = new CanvasStore('workspace');
    expect(loaded.read().seq).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('torn'));
    loaded.append([create('b'), create('c')], human);
    expect(new CanvasStore('workspace').read()).toEqual(loaded.read());
    expect(readFileSync(store.logPath, 'utf8').trim().split('\n')).toHaveLength(2);
  });
  it('does not ignore corrupt complete lines or overwrite corrupt snapshots', () => {
    const store = new CanvasStore('workspace');
    store.append([create('a')], human);
    appendFileSync(store.logPath, 'broken\n');
    expect(() => new CanvasStore('workspace')).toThrow();
    writeFileSync(store.snapshotPath, '{}');
    expect(() => new CanvasStore('workspace')).toThrow();
  });
  it('appends nothing on lock/cycle failure, including earlier operations in a batch', () => {
    const store = new CanvasStore('workspace');
    store.append([create('group', null, 'group'), create('child', 'group', 'group')], human);
    const before = readFileSync(store.logPath, 'utf8');
    expect(
      store.append(
        [
          create('new'),
          {
            kind: 'reparent',
            objectId: 'group',
            opId: 'cycle',
            patch: { parentId: 'child', order: 1, preserveWorld: true },
          },
        ],
        human
      ).ok
    ).toBe(false);
    expect(readFileSync(store.logPath, 'utf8')).toBe(before);
    expect(store.read().objects.new).toBeUndefined();
  });
  it('refuses every write on a candidate/retired colour and reloads after handoff', () => {
    const store = new CanvasStore('workspace');
    store.append([create('a')], human);
    deployRole.enter('retired');
    expect(() => store.append([create('b')], human)).toThrow('live');
    expect(() => store.snapshot()).toThrow('live');
    expect(() => workspaceForCase('case')).toThrow('live');
    deployRole.enter('live');
    deployRole.initFromEnv({ CODEMAN_DEPLOY_ROLE: 'candidate' });
    expect(() => store.append([create('b')], human)).toThrow('live');
    deployRole.enter('live');
    const other = new CanvasStore('workspace');
    other.append([create('b')], human);
    store.reload();
    expect(store.read().seq).toBe(2);
  });
  it('skips future operation kinds and continues sequence allocation', () => {
    const store = new CanvasStore('workspace');
    store.append([create('a')], human);
    appendFileSync(store.logPath, JSON.stringify({ kind: 'future', seq: 2, opId: 'future' }) + '\n');
    const loaded = new CanvasStore('workspace');
    expect(loaded.append([create('b')], human)).toMatchObject({ ok: true, seq: 3 });
  });
  it('re-keys only the renamed owner case and preserves workspace identity', async () => {
    const first = workspaceForCase('before', 'a');
    const second = workspaceForCase('before', 'b');
    await rekeyCaseWorkspace('before', 'after', 'a');
    expect(workspaceForCase('after', 'a').id).toBe(first.id);
    expect(workspaceForCase('before', 'b').id).toBe(second.id);
    expect(readWorkspaces()).toHaveLength(2);
    expect(statSync(join(dir, 'workspaces.json')).mode & 0o777).toBe(0o600);
  });
  it('does not expose mutable canonical objects through append or read results', () => {
    const store = new CanvasStore('workspace');
    const result = store.append([create('text')], human);
    if (!result.ok) throw new Error('append failed');
    const after = result.operations[0]?.prev[0]?.after;
    if (!after) throw new Error('missing change');
    after.position.x = 999;
    const copy = store.read();
    if (copy.objects.text) copy.objects.text.position.x = 777;
    expect(store.read().objects.text?.position.x).toBe(10);
  });
});
