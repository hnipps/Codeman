import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasStore } from '../src/canvas/canvas-store.js';
import { workspaceForCase, readWorkspaces } from '../src/canvas/workspace-registry.js';
import { rekeyCaseWorkspace } from '../src/case-rename.js';
import { deployRole } from '../src/deploy-role.js';
import { applyOperation, OperationSchema, CommandSchema } from '../src/canvas/operations.js';
import { emptyState } from '../src/canvas/model.js';
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
      expect(JSON.parse(readFileSync(loaded.snapshotPath, 'utf8')).state).toEqual(state);
      expect(readFileSync(loaded.logPath, 'utf8').startsWith(rawLog)).toBe(true);
      const replayed = new CanvasStore('workspace');
      expect(replayed.read()).toEqual(state);
      expect(replayed.operations()).toEqual(log);
      rmSync(loaded.snapshotPath);
      expect(new CanvasStore('workspace').read()).toEqual(state);
      expect(new CanvasStore('workspace').operations()).toEqual(log);
    }
  );
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
