import Fastify from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCanvasRoutes } from '../../src/web/routes/canvas-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { CanvasStores } from '../../src/canvas/canvas-store.js';
import * as pathProbe from '../../src/utils/bounded-path-probe.js';
import { readWorkspaces, workspaceForCase } from '../../src/canvas/workspace-registry.js';
import { deployRole } from '../../src/deploy-role.js';
import { resolveCasesDir } from '../../src/web/route-helpers.js';
import { create, human, agent } from '../canvas-fixtures.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-routes-'));
  vi.stubEnv('CODEMAN_DATA_DIR', dir);
  vi.stubEnv('CODEMAN_MULTIUSER', '1');
});
afterEach(() => {
  deployRole.enter('live');
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
async function harness(username = 'user-a', role: 'user' | 'admin' = 'user') {
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    req.authUser = { username, role };
  });
  let enabled = true;
  const stores = new CanvasStores();
  const port = {
    sessions: new Map(),
    canvasEnabled: async () => enabled,
    canvasStores: vi.fn(async () => stores),
    broadcast: vi.fn(),
  };
  registerCanvasRoutes(app, port);
  installRouteErrorHandler(app);
  await app.ready();
  return {
    app,
    port,
    disable: () => {
      enabled = false;
    },
  };
}

describe('canvas routes', () => {
  it('deduplicates a compound request after changed state and refuses identity reuse with different arguments', async () => {
    const workspace = workspaceForCase('compound-retry', 'user-a');
    const { app, port } = await harness();
    try {
      const store = (await port.canvasStores()).get(workspace.id);
      store.append([create('a'), create('b')], human);
      const payload = {
        requestId: crypto.randomUUID(),
        tool: 'canvas_arrange',
        arguments: { action: 'group', targetIds: ['a', 'b'], groupId: 'g', label: 'Group', parentId: null },
      };
      const first = await app.inject({ method: 'POST', url: `/api/canvas/${workspace.id}/command`, payload });
      expect(first.statusCode).toBe(200);
      const log = store.operations();
      const replay = await app.inject({ method: 'POST', url: `/api/canvas/${workspace.id}/command`, payload });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().data.sequences).toEqual(first.json().data.sequences);
      expect(store.operations()).toEqual(log);
      const reused = await app.inject({
        method: 'POST',
        url: `/api/canvas/${workspace.id}/command`,
        payload: { ...payload, arguments: { ...payload.arguments, label: 'Changed' } },
      });
      expect(reused.statusCode).toBe(409);
      expect(store.operations()).toEqual(log);
    } finally {
      await app.close();
    }
  });
  it.each(['group', 'restore', 'redo'] as const)(
    'refuses %s history with later agent descendants atomically',
    async (variant) => {
      const workspace = workspaceForCase('dependents-' + variant, 'user-a');
      const { app, port } = await harness();
      try {
        const store = (await port.canvasStores()).get(workspace.id);
        store.append([create('a'), create('b')], human);
        const command = async (tool: string, args: unknown) =>
          app.inject({
            method: 'POST',
            url: `/api/canvas/${workspace.id}/command`,
            payload: { tool, arguments: args },
          });
        let forward = await command('canvas_arrange', {
          action: 'group',
          targetIds: ['a', 'b'],
          groupId: 'g',
          label: 'G',
          parentId: null,
        });
        expect(forward.statusCode).toBe(200);
        if (variant !== 'group') {
          const deleted = await command('canvas_delete', {
            operations: [{ kind: 'delete', opId: 'delete-g', objectId: 'g' }],
          });
          expect(deleted.statusCode).toBe(200);
          forward =
            variant === 'redo'
              ? await command('canvas_history', { action: 'undo', sequences: deleted.json().data.sequences })
              : await command('canvas_update', {
                  operations: [{ kind: 'restore', opId: 'restore-g', objectId: 'g' }],
                });
        }
        expect(forward.statusCode).toBe(200);
        port.sessions.set('session-a', {
          id: 'session-a',
          owner: 'user-a',
          workingDir: join(resolveCasesDir({ username: 'user-a', role: 'user' }), 'dependents-' + variant),
        });
        const added = await app.inject({
          method: 'POST',
          url: '/api/canvas/current/command',
          headers: { 'x-codeman-parent-session': 'session-a' },
          payload: { tool: 'canvas_create', arguments: { operations: [create('y', 'g')] } },
        });
        expect(added.statusCode, added.body).toBe(200);
        expect(store.read().objects.y.author).toEqual(agent);
        const before = store.read();
        const log = readFileSync(store.logPath, 'utf8');
        const broadcasts = port.broadcast.mock.calls.length;
        const response = await command('canvas_history', {
          action: variant === 'redo' ? 'redo' : 'undo',
          sequences: forward.json().data.sequences,
        });
        expect(response.statusCode).toBe(409);
        expect(response.json().reasons).toContainEqual(
          expect.objectContaining({
            code: 'DEPENDENTS',
            objectId: 'g',
            dependents: [{ objectId: 'y', author: agent }],
          })
        );
        expect(store.read()).toEqual(before);
        expect(readFileSync(store.logPath, 'utf8')).toBe(log);
        expect(port.broadcast.mock.calls).toHaveLength(broadcasts);
      } finally {
        await app.close();
      }
    }
  );
  it.each([
    ['group', 200],
    ['group', 334],
    ['group', 1000],
    ['ungroup', 1000],
    ['reparent', 1000],
  ] as const)(
    'accepts maximum-target/audit %s of %i forward undo and redo through the command endpoint',
    async (action, count) => {
      const workspace = workspaceForCase('maximum-' + action, 'user-a');
      const { app, port } = await harness();
      try {
        const store = (await port.canvasStores()).get(workspace.id);
        const ids = Array.from({ length: count }, (_, i) => 'target-' + i);
        if (action === 'ungroup') {
          expect(
            store.append(
              ids.map((id) => create(id, null, 'group')),
              human
            ).ok
          ).toBe(true);
          expect(
            store.append(
              ids.map((id) => create('child-' + id, id)),
              human
            ).ok
          ).toBe(true);
        } else {
          expect(
            store.append(
              ids.map((id) => create(id)),
              human
            ).ok
          ).toBe(true);
        }
        expect(store.append([create('destination', null, 'section')], human).ok).toBe(true);
        const initial = store.read();
        const command = async (tool: string, args: unknown) =>
          app.inject({
            method: 'POST',
            url: `/api/canvas/${workspace.id}/command`,
            payload: { tool, arguments: args },
          });
        let response = await command('canvas_arrange', {
          action,
          targetIds: ids,
          ...(action === 'group'
            ? { groupId: 'g', label: 'G', parentId: 'destination' }
            : action === 'reparent'
              ? { parentId: 'destination' }
              : {}),
        });
        expect(response.statusCode, response.body).toBe(200);
        const forward = store.read();
        for (const step of ['undo', 'redo', 'undo', 'redo']) {
          response = await command('canvas_history', { action: step, sequences: response.json().data.sequences });
          expect(response.statusCode, response.body).toBe(200);
          const expected = step === 'undo' ? initial : forward;
          const actual = store.read();
          for (const id of Object.keys(initial.objects)) {
            const { parentId, position, rotation, order, deletedAt } = expected.objects[id];
            expect(actual.objects[id]).toMatchObject({ parentId, position, rotation, order });
            expect(actual.objects[id].deletedAt === null).toBe(deletedAt === null);
          }
        }
        const tooMany = await command('canvas_create', {
          operations: Array.from({ length: 1001 }, (_, i) => create('excess-' + i)),
        });
        expect(tooMany.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    },
    120_000
  );
  it.each([2, 300])('keeps healthy discovery readable beside a %i-node loaded cycle', async (count) => {
    const workspace = workspaceForCase('cycle-command-' + count, 'user-a');
    const { app, port } = await harness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = (await port.canvasStores()).get(workspace.id);
      store.append([create('healthy', null, 'section'), create('healthy-child', 'healthy')], human);
      const state = store.read();
      for (let i = 0; i < count; i++) {
        const id = 'cycle-' + i;
        state.objects[id] = { ...state.objects.healthy, id, parentId: 'cycle-' + ((i + 1) % count) };
      }
      writeFileSync(store.snapshotPath, JSON.stringify({ version: 1, state }));
      store.reload();
      const command = async (tool: string, args: unknown) =>
        app.inject({
          method: 'POST',
          url: `/api/canvas/${workspace.id}/command`,
          payload: { tool, arguments: args },
        });
      const read = await command('canvas_read', {});
      expect(read.statusCode).toBe(200);
      const data = read.json().data;
      expect(data.tree.find((n: { object: { id: string } }) => n.object.id === 'healthy').children).toHaveLength(1);
      expect(data.tree.filter((n: { hierarchy?: string }) => n.hierarchy === 'cycle').length).toBeGreaterThan(0);
      expect(data.diagnostics[0]).toMatchObject({ code: 'CYCLE' });
      expect(data.diagnostics[0].objectIds).toHaveLength(count);
      expect(
        data.tree
          .filter((n: { hierarchy?: string }) => n.hierarchy === 'cycle')
          .every((n: { children: unknown[] }) => n.children.length === 0)
      ).toBe(true);
      const search = await command('canvas_search', { text: 'healthy' });
      expect(search.statusCode).toBe(200);
      expect(search.json().data.data).toContainEqual({
        object: state.objects['cycle-0'],
        path: [],
        hierarchy: 'cycle',
      });
      expect(search.json().data.diagnostics[0].objectIds).toHaveLength(count);
      const query = await command('canvas_query', { shape: 'point', point: { x: 20, y: 40 } });
      expect(query.statusCode).toBe(200);
      expect(query.json().data.data).toContainEqual(
        expect.objectContaining({ id: 'healthy-child', bounds: expect.any(Object) })
      );
      expect(query.json().data.data).toContainEqual({
        id: 'cycle-0',
        object: state.objects['cycle-0'],
        hierarchy: 'cycle',
      });
      expect(query.json().data.diagnostics[0].objectIds).toHaveLength(count);
      const before = store.operations();
      const edit = await command('canvas_update', {
        operations: [{ kind: 'move', opId: 'cycle-edit', objectId: 'cycle-0', patch: { position: { x: 0, y: 0 } } }],
      });
      expect(edit.statusCode).toBe(409);
      expect(edit.json().reasons[0].code).toBe('CYCLE');
      expect(store.operations()).toEqual(before);
    } finally {
      warn.mockRestore();
      await app.close();
    }
  });
  it('gates every endpoint before loading a store', async () => {
    const { app, port, disable } = await harness();
    disable();
    for (const [method, path] of [
      ['GET', 'objects'],
      ['GET', 'ops'],
      ['POST', 'ops'],
      ['POST', 'revert'],
    ] as const) {
      expect(
        (
          await app.inject({
            method,
            url: `/api/canvas/missing/${path}`,
            ...(method === 'POST' ? { payload: {} } : {}),
          })
        ).statusCode
      ).toBe(404);
    }
    expect((await app.inject({ url: '/api/canvas/workspaces' })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: '/api/canvas/workspaces', payload: { caseName: 'case' } })).statusCode
    ).toBe(404);
    expect(port.canvasStores).not.toHaveBeenCalled();
    await app.close();
  });
  it('covers create/list, descendants, comments, replay, revert and trusted author/SSE metadata', async () => {
    const workspace = workspaceForCase('case', 'user-a');
    const { app, port } = await harness();
    const base = `/api/canvas/${workspace.id}`;
    let response = await app.inject({
      method: 'POST',
      url: `${base}/ops`,
      payload: {
        operations: [create('section', null, 'section'), create('frame', 'section', 'frame'), create('text', 'frame')],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.seq).toBe(3);
    expect(port.broadcast).toHaveBeenCalledWith('canvas:changed', {
      workspaceId: workspace.id,
      seq: 3,
      owner: 'user-a',
    });
    response = await app.inject({ url: `${base}/objects?root=section` });
    expect(response.json().data.objects).toHaveLength(3);
    expect(response.json().data.objects[0].author).toEqual({ kind: 'human', userId: 'user-a' });
    response = await app.inject({
      method: 'POST',
      url: `${base}/ops`,
      payload: {
        operations: [{ kind: 'comment', objectId: 'text', opId: 'comment', patch: { id: 'comment', text: 'hello' } }],
      },
    });
    expect(response.statusCode).toBe(200);
    expect((await app.inject({ url: `${base}/objects` })).json().data.comments).toHaveLength(1);
    expect((await app.inject({ url: `${base}/ops?since=3` })).json().data.operations).toHaveLength(1);
    const beforeObjects = (await app.inject({ url: `${base}/objects` })).json();
    const beforeLog = (await app.inject({ url: `${base}/ops` })).json();
    response = await app.inject({
      method: 'POST',
      url: `${base}/revert`,
      payload: { author: { kind: 'agent', sessionId: 'other' } },
    });
    expect(response.statusCode).toBe(200);
    expect((await app.inject({ url: `${base}/objects` })).json()).toEqual(beforeObjects);
    expect((await app.inject({ url: `${base}/ops` })).json()).toEqual(beforeLog);
    expect((await app.inject({ url: '/api/canvas/workspaces' })).json().data.workspaces).toHaveLength(1);
    await app.close();
  });
  it.each(['mystery', 'image'] as const)(
    'preserves opaque %s content while reverting normal objects by the same author',
    async (type) => {
      for (const mixed of [false, true]) {
        const workspace = workspaceForCase(`opaque-${type}-${mixed}`, 'user-a');
        const { app, port } = await harness();
        try {
          const stores = await port.canvasStores();
          const store = stores.get(workspace.id);
          store.append([create('opaque'), create('normal')], agent);
          if (mixed)
            store.append(
              [
                {
                  kind: 'update',
                  opId: 'normal-update',
                  objectId: 'normal',
                  patch: { content: { type: 'text', text: 'changed' } },
                },
              ],
              human
            );
          const before = { ...store.read().objects.opaque, content: { type, text: 'old', url: 'future-url', alt: '' } };
          const after = { ...before, content: { ...before.content, text: 'z' } };
          appendFileSync(
            store.logPath,
            JSON.stringify({
              seq: store.read().seq + 1,
              opId: 'opaque-update',
              kind: 'update',
              author: human,
              objectId: 'opaque',
              patch: {},
              prev: [{ objectId: 'opaque', before, after }],
            }) + '\n'
          );
          store.reload();
          const originalSeq = store.read().seq;
          const response = await app.inject({
            method: 'POST',
            url: `/api/canvas/${workspace.id}/revert`,
            payload: { author: human },
          });
          expect(response.statusCode).toBe(200);
          expect(store.read().objects.opaque).toEqual(after);
          expect(store.read().objects.normal.content.text).toBe('normal');
          expect(store.read().seq).toBe(originalSeq + (mixed ? 1 : 0));
          expect((await app.inject({ url: `/api/canvas/${workspace.id}/objects` })).json().data.objects).toContainEqual(
            after
          );
          const edit = await app.inject({
            method: 'POST',
            url: `/api/canvas/${workspace.id}/ops`,
            payload: {
              operations: [
                { kind: 'move', objectId: 'opaque', opId: 'edit-opaque', patch: { position: { x: 0, y: 0 } } },
              ],
            },
          });
          expect(edit.statusCode).toBe(409);
          expect(edit.json().reasons[0].code).toBe('INVALID');
          store.snapshot();
          stores.reload();
          expect(store.read().objects.opaque).toEqual(after);
        } finally {
          await app.close();
        }
      }
    }
  );
  it('returns the audit cycle from root reads and rejects its edits without changing the log', async () => {
    const workspace = workspaceForCase('cycle', 'user-a');
    const { app, port } = await harness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = (await port.canvasStores()).get(workspace.id);
      store.append([create('a'), create('b')], human);
      const state = store.read();
      state.objects.a.parentId = 'b';
      state.objects.b = { ...state.objects.b, type: 'future-widget', parentId: 'a' };
      writeFileSync(store.snapshotPath, JSON.stringify({ version: 1, state }));
      store.reload();
      const log = store.operations();
      const read = await app.inject({ url: `/api/canvas/${workspace.id}/objects?root=a` });
      expect(read.statusCode).toBe(200);
      expect(read.json().data.objects).toEqual([state.objects.a, state.objects.b]);
      const response = await app.inject({
        method: 'POST',
        url: `/api/canvas/${workspace.id}/ops`,
        payload: { operations: [{ kind: 'move', opId: 'cycle', objectId: 'a', patch: { position: { x: 0, y: 0 } } }] },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().reasons[0].code).toBe('CYCLE');
      expect(store.operations()).toEqual(log);
    } finally {
      warn.mockRestore();
      await app.close();
    }
  });
  it('refuses non-live writes and malformed or forged author requests', async () => {
    const workspace = workspaceForCase('case', 'user-a');
    const { app } = await harness();
    const url = `/api/canvas/${workspace.id}/ops`;
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: { operations: [create('x')], author: { kind: 'human', userId: 'other' } },
        })
      ).statusCode
    ).toBe(400);
    deployRole.initFromEnv({ CODEMAN_DEPLOY_ROLE: 'candidate' });
    expect((await app.inject({ method: 'POST', url, payload: { operations: [create('x')] } })).statusCode).toBe(409);
    await app.close();
  });
  it('scopes reads and writes to owners while preserving admin and single-user access', async () => {
    const workspace = workspaceForCase('case', 'other');
    for (const [username, role, expected] of [
      ['user-a', 'user', 404],
      ['admin-a', 'admin', 200],
    ] as const) {
      const { app } = await harness(username, role);
      expect((await app.inject({ url: `/api/canvas/${workspace.id}/objects` })).statusCode).toBe(expected);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/canvas/${workspace.id}/ops`,
            payload: { operations: [create('owner-check')] },
          })
        ).statusCode
      ).toBe(expected);
      await app.close();
    }
    vi.stubEnv('CODEMAN_MULTIUSER', '0');
    const { app } = await harness();
    expect((await app.inject({ url: `/api/canvas/${workspace.id}/objects` })).statusCode).toBe(200);
    await app.close();
  });
  it('returns a diagnostic 503 without minting when the case probe is unknown', async () => {
    const probe = vi.spyOn(pathProbe, 'probePathKind').mockResolvedValue('unknown');
    const { app } = await harness();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/canvas/workspaces',
        payload: { caseName: 'unreachable' },
      });
      expect(response.statusCode).toBe(503);
      const path = join(resolveCasesDir({ username: 'user-a', role: 'user' }), 'unreachable');
      expect(probe).toHaveBeenCalledWith(path, { pastCap: true });
      expect(response.json().error).toBe(pathProbe.describeUnknownPath('Case folder', path, { pastCap: true }));
      expect(readWorkspaces()).toEqual([]);
    } finally {
      probe.mockRestore();
      await app.close();
    }
  });
  it('mints a workspace only for an existing accessible case', async () => {
    mkdirSync(join(resolveCasesDir({ username: 'user-a', role: 'user' }), 'canvas-test-case'), { recursive: true });
    const { app } = await harness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/canvas/workspaces',
      payload: { caseName: 'canvas-test-case' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.workspace.owner).toBe('user-a');
    expect(
      (await app.inject({ method: 'POST', url: '/api/canvas/workspaces', payload: { caseName: '../escape' } }))
        .statusCode
    ).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: '/api/canvas/workspaces', payload: { caseName: 'missing-case' } }))
        .statusCode
    ).toBe(404);
    await app.close();
  });
});

describe('canvas command acknowledgement and no-ops', () => {
  async function seeded() {
    const workspace = workspaceForCase('noop-case', 'user-a');
    const h = await harness();
    const store = (await h.port.canvasStores()).get(workspace.id);
    const ordered = (id: string, order: number) => {
      const command = create(id);
      if (command.kind === 'create') command.patch.order = order;
      return command;
    };
    store.append([ordered('a', 0), ordered('b', 1)], human);
    return { ...h, store, base: `/api/canvas/${workspace.id}` };
  }
  const logBytes = (store: { logPath: string }) => readFileSync(store.logPath);
  async function textSaveSucceeds(app: Awaited<ReturnType<typeof harness>>['app'], base: string, revision: number) {
    const save = await app.inject({
      method: 'POST',
      url: `${base}/ops`,
      payload: {
        operations: [
          {
            kind: 'update',
            opId: crypto.randomUUID(),
            objectId: 'a',
            expectedRevision: revision,
            patch: { content: { type: 'text', text: 'Saved after a no-op' } },
          },
        ],
      },
    });
    expect(save.statusCode).toBe(200);
  }
  it('answers Send backward on the backmost object as a no-op that appends nothing', async () => {
    const { app, store, base } = await seeded();
    try {
      const before = store.read().objects.a;
      const log = logBytes(store);
      const payload = {
        requestId: crypto.randomUUID(),
        tool: 'canvas_arrange',
        arguments: { action: 'order', targetIds: ['a'], placement: 'backward' },
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await app.inject({ method: 'POST', url: `${base}/command`, payload });
        expect(response.statusCode).toBe(200);
        expect(response.json().data).toMatchObject({ noop: true, sequences: [], seq: 2 });
        expect(logBytes(store)).toEqual(log);
      }
      expect(store.read().objects.a.revision).toBe(before.revision);
      expect(store.read().objects.a.updatedAt).toBe(before.updatedAt);
      expect(store.read().seq).toBe(2);
      await textSaveSucceeds(app, base, before.revision);
    } finally {
      await app.close();
    }
  });
  it('answers a drag whose snap correction returns to the start as a no-op', async () => {
    const { app, store, base } = await seeded();
    try {
      const before = store.read().objects.a;
      const log = logBytes(store);
      const response = await app.inject({
        method: 'POST',
        url: `${base}/command`,
        payload: {
          requestId: crypto.randomUUID(),
          tool: 'canvas_transform',
          arguments: {
            targetIds: ['a'],
            space: 'world',
            anchor: { x: 0, y: 0 },
            translation: { x: 0, y: 0 },
            scale: { width: 1, height: 1 },
            rotation: 0,
          },
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toMatchObject({ noop: true, sequences: [] });
      expect(logBytes(store)).toEqual(log);
      expect(store.read().objects.a.revision).toBe(before.revision);
      await textSaveSucceeds(app, base, before.revision);
    } finally {
      await app.close();
    }
  });
  it('refuses a plain edit whose patch changes nothing instead of bumping the revision', async () => {
    const { app, store, base } = await seeded();
    try {
      const log = logBytes(store);
      for (const kind of ['update', 'revert']) {
        const response = await app.inject({
          method: 'POST',
          url: `${base}/ops`,
          payload: { operations: [{ kind, opId: crypto.randomUUID(), objectId: 'a', patch: {} }] },
        });
        expect(response.statusCode).toBe(409);
      }
      expect(logBytes(store)).toEqual(log);
    } finally {
      await app.close();
    }
  });
  it('writes one author revert batch for two sends with the same request id', async () => {
    const { app, store, base } = await seeded();
    try {
      store.append([{ kind: 'move', opId: 'moved', objectId: 'b', patch: { position: { x: 90, y: 90 } } }], human);
      const payload = { requestId: crypto.randomUUID(), tool: 'canvas_history', arguments: { action: 'revert' } };
      const first = await app.inject({ method: 'POST', url: `${base}/command`, payload });
      expect(first.statusCode).toBe(200);
      const length = store.operations().length;
      const second = await app.inject({ method: 'POST', url: `${base}/command`, payload });
      expect(second.statusCode).toBe(200);
      expect(second.json().data.sequences).toEqual(first.json().data.sequences);
      expect(store.operations()).toHaveLength(length);
    } finally {
      await app.close();
    }
  });
  it('caps each history answer by records and bytes and pages to the end with a cursor', async () => {
    const { app, store, base } = await seeded();
    try {
      for (let batch = 0; batch < 5; batch++)
        store.append(
          Array.from({ length: 1000 }, (_, i) => ({
            kind: 'move' as const,
            opId: `bulk-${batch}-${i}`,
            objectId: 'b',
            patch: { position: { x: batch * 1000 + i, y: 0 } },
          })),
          human
        );
      const seen: number[] = [];
      let since = 0;
      let pages = 0;
      let last: Record<string, unknown> = {};
      for (;;) {
        const response = await app.inject({ url: `${base}/ops?since=${since}` });
        expect(response.statusCode).toBe(200);
        expect(response.body.length).toBeLessThanOrEqual(1024 * 1024 + 4096);
        last = response.json().data;
        const operations = last.operations as { seq: number }[];
        expect(operations.length).toBeLessThanOrEqual(500);
        seen.push(...operations.map((o) => o.seq));
        pages++;
        if (!last.more) break;
        expect(last.seq).toBeUndefined();
        since = last.next as number;
      }
      expect(pages).toBeGreaterThan(1);
      expect(seen).toEqual(Array.from({ length: 5002 }, (_, i) => i + 1));
      expect(last.seq).toBe(5002);
      const big = 'x'.repeat(400_000);
      store.append(
        [0, 1, 2, 3].map((i) => ({
          kind: 'update' as const,
          opId: `big-${i}`,
          objectId: 'a',
          patch: { content: { type: 'text' as const, text: `${big}${i}` } },
        })),
        human
      );
      const page = await app.inject({ url: `${base}/ops?since=5002` });
      expect(page.json().data.operations.length).toBeGreaterThanOrEqual(1);
      expect(page.json().data.operations.length).toBeLessThan(4);
      expect(page.json().data.more).toBe(true);
    } finally {
      await app.close();
    }
  });
});
