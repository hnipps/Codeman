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
import { png } from '../canvas-media-fixtures.js';
import { readWebviews } from '../../src/webview-store.js';
import { webviewCapabilities } from '../../src/webview-capabilities.js';

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
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
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
      const reason = pathProbe.describeUnknownPath('Case folder', path, { pastCap: true });
      expect(response.json().error).toBe(reason.replace(`: ${path}`, ''));
      expect(response.body).not.toContain(path);
      expect(logged.mock.calls.join()).toContain('POST /api/canvas/workspaces failed 503');
      expect(readWorkspaces()).toEqual([]);
    } finally {
      probe.mockRestore();
      logged.mockRestore();
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
        expect(response.json().reasons).toEqual([
          expect.objectContaining({ code: 'INVALID', objectId: 'a', message: 'The edit changes nothing' }),
        ]);
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

describe('canvas no-op request identity', () => {
  it('holds a no-op answer for its request id: a retry repeats it and a different payload is refused', async () => {
    const workspace = workspaceForCase('noop-identity', 'user-a');
    const { app, port } = await harness();
    try {
      const store = (await port.canvasStores()).get(workspace.id);
      const backmost = create('a');
      if (backmost.kind === 'create') backmost.patch.order = 0;
      store.append([backmost], human);
      const url = `/api/canvas/${workspace.id}/command`;
      const payload = {
        requestId: crypto.randomUUID(),
        tool: 'canvas_arrange',
        arguments: { action: 'order', targetIds: ['a'], placement: 'backward' },
      };
      const first = await app.inject({ method: 'POST', url, payload });
      expect(first.json().data).toMatchObject({ noop: true, sequences: [] });
      const retry = await app.inject({ method: 'POST', url, payload });
      expect(retry.statusCode).toBe(200);
      expect(retry.json().data).toEqual(first.json().data);
      const reused = await app.inject({
        method: 'POST',
        url,
        payload: { ...payload, arguments: { ...payload.arguments, placement: 'front' } },
      });
      expect(reused.statusCode).toBe(409);
      expect(reused.json().error).toMatch(/already used for a different command/);
      expect(store.operations()).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});

describe('canvas media', () => {
  async function media(name = 'media-case') {
    const workspace = workspaceForCase(name, 'user-a');
    const h = await harness();
    const store = (await h.port.canvasStores()).get(workspace.id);
    const base = `/api/canvas/${workspace.id}`;
    const command = (tool: string, args: unknown) =>
      h.app.inject({ method: 'POST', url: `${base}/command`, payload: { tool, arguments: args } });
    return { ...h, store, base, command, workspace };
  }
  const upload = (app: Awaited<ReturnType<typeof harness>>['app'], base: string, body: Buffer, type = 'image/png') =>
    app.inject({ method: 'POST', url: `${base}/assets`, headers: { 'content-type': type }, payload: body });

  it('stores an uploaded image, serves it by id with nosniff and ranges, and refuses forged bytes', async () => {
    const { app, base } = await media();
    try {
      const bytes = png(6, 4);
      const stored = await upload(app, base, bytes);
      expect(stored.statusCode).toBe(200);
      const { assetId, width, height } = stored.json().data;
      expect({ width, height }).toEqual({ width: 6, height: 4 });
      const read = await app.inject({ method: 'GET', url: `${base}/assets/${assetId}` });
      expect(read.statusCode).toBe(200);
      expect(read.headers['content-type']).toBe('image/png');
      expect(read.headers['x-content-type-options']).toBe('nosniff');
      expect(read.rawPayload.equals(bytes)).toBe(true);
      const ranged = await app.inject({
        method: 'GET',
        url: `${base}/assets/${assetId}`,
        headers: { range: 'bytes=0-3' },
      });
      expect(ranged.statusCode).toBe(206);
      expect(ranged.rawPayload).toHaveLength(4);
      const octet = await app.inject({
        method: 'POST',
        url: `${base}/assets?type=image/png`,
        headers: { 'content-type': 'application/octet-stream' },
        payload: bytes,
      });
      expect(octet.json().data.assetId).toBe(assetId);
      const forged = await upload(app, base, Buffer.from('<script>alert(1)</script>'.padEnd(64)));
      expect(forged.statusCode).toBe(400);
      expect(forged.json().refusal).toBe('bytes');
      const svg = await upload(app, base, Buffer.from('<svg/>'), 'image/svg+xml');
      expect(svg.statusCode).toBe(415);
      expect((await app.inject({ method: 'GET', url: `${base}/assets/${'0'.repeat(64)}` })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: `${base}/assets/..%2F..%2Fstate.json` })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
  it("hides another owner's workspace from upload and read", async () => {
    const own = await media('media-owned');
    const { assetId } = (await upload(own.app, own.base, png(2, 2))).json().data;
    await own.app.close();
    const other = await harness('user-b');
    try {
      expect((await upload(other.app, own.base, png(2, 2))).statusCode).toBe(404);
      expect((await other.app.inject({ method: 'GET', url: `${own.base}/assets/${assetId}` })).statusCode).toBe(404);
    } finally {
      await other.app.close();
    }
  });
  it('refuses an image object whose asset is not stored, and accepts it after upload', async () => {
    const { app, base, command, store } = await media();
    try {
      const bytes = png(3, 3);
      const { createHash } = await import('node:crypto');
      const assetId = createHash('sha256').update(bytes).digest('hex');
      const operation = {
        kind: 'create',
        opId: 'img',
        objectId: 'img',
        patch: {
          parentId: null,
          order: 0,
          position: { x: 0, y: 0 },
          size: { width: 30, height: 30 },
          content: { type: 'image', url: '', alt: 'Chart', assetId },
        },
      };
      const refused = await command('canvas_create', { operations: [operation] });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().reasons[0]).toMatchObject({ code: 'NOT_FOUND', objectId: 'img' });
      expect(store.operations()).toHaveLength(0);
      await upload(app, base, bytes);
      expect((await command('canvas_create', { operations: [operation] })).statusCode).toBe(200);
      expect(store.read().objects.img.content).toMatchObject({ type: 'image', assetId });
    } finally {
      await app.close();
    }
  });
  it('switches a link to an embed and back keeping its id, refuses other type switches, and undo restores the link', async () => {
    const { app, command, store } = await media();
    try {
      const link = {
        kind: 'create',
        opId: 'l',
        objectId: 'l',
        patch: {
          parentId: null,
          order: 0,
          position: { x: 0, y: 0 },
          size: { width: 320, height: 96 },
          content: { type: 'link', url: 'https://example.com/docs', label: 'Docs', preview: 'ready' },
        },
      };
      await command('canvas_create', { operations: [link, create('t')] });
      const embed = await command('canvas_update', {
        operations: [
          {
            kind: 'update',
            opId: 'to-embed',
            objectId: 'l',
            patch: { content: { type: 'embed', url: 'https://example.com/docs', label: 'Docs' } },
          },
        ],
      });
      expect(embed.statusCode).toBe(200);
      expect(store.read().objects.l).toMatchObject({ type: 'embed', content: { type: 'embed' } });
      expect(store.read().objects.l.content).not.toHaveProperty('preview');
      const other = await command('canvas_update', {
        operations: [
          {
            kind: 'update',
            opId: 'bad',
            objectId: 't',
            patch: { content: { type: 'embed', url: 'https://example.com' } },
          },
        ],
      });
      expect(other.statusCode).toBe(409);
      expect(other.json().reasons[0].message).toBe('Only a link and an embed can change into each other');
      const undo = await command('canvas_history', { action: 'undo', sequences: embed.json().data.sequences });
      expect(undo.statusCode).toBe(200);
      expect(store.read().objects.l).toMatchObject({
        type: 'link',
        content: { type: 'link', label: 'Docs', preview: 'ready' },
      });
    } finally {
      await app.close();
    }
  });
  it('mints a frame only for a live embed, in memory, and retires it on delete, back-to-link and a new URL', async () => {
    const { app, command, base, store } = await media();
    try {
      // A user web tab already on disk: frames must leave this file byte for byte as it is.
      const userRow = [
        {
          id: 'mine',
          name: 'Mine',
          url: 'https://example.com/',
          embedMode: 'proxy',
          trusted: false,
          origin: { kind: 'user' },
          owner: 'user-a',
          createdAt: 1,
        },
      ];
      const file = join(dir, 'webviews.json');
      writeFileSync(file, JSON.stringify(userRow, null, 2));
      const before = readFileSync(file);
      const embed = (id: string, url: string) => ({
        kind: 'create',
        opId: id,
        objectId: id,
        patch: {
          parentId: null,
          order: 0,
          position: { x: 0, y: 0 },
          size: { width: 480, height: 320 },
          content: { type: 'embed', url },
        },
      });
      await command('canvas_create', {
        operations: [embed('e', 'https://example.com/'), embed('meta', 'http://169.254.169.254/'), create('t')],
      });
      expect((await app.inject({ method: 'POST', url: `${base}/objects/t/frame` })).statusCode).toBe(409);
      expect((await app.inject({ method: 'POST', url: `${base}/objects/meta/frame` })).statusCode).toBe(400);
      const frame = await app.inject({ method: 'POST', url: `${base}/objects/e/frame` });
      expect(frame.statusCode).toBe(200);
      const { webviewId, embedUrl } = frame.json().data;
      expect(embedUrl).toMatch(/^\/webview\/[^/]+\/$/);
      const again = await app.inject({ method: 'POST', url: `${base}/objects/e/frame` });
      expect(again.json().data.webviewId).toBe(webviewId);
      const cap = embedUrl.split('/')[2];
      expect(webviewCapabilities.resolve(cap)).toBeTruthy();
      // Back to link and to embed twenty times, then delete and restore: still nothing on disk.
      for (let i = 0; i < 20; i++) {
        const type = i % 2 ? 'embed' : 'link';
        const content =
          type === 'link' ? { type, url: 'https://example.com/', label: '' } : { type, url: 'https://example.com/' };
        const res = await command('canvas_update', {
          operations: [{ kind: 'update', opId: `switch-${i}`, objectId: 'e', patch: { content } }],
        });
        expect(res.statusCode).toBe(200);
        if (type === 'embed')
          expect((await app.inject({ method: 'POST', url: `${base}/objects/e/frame` })).statusCode).toBe(200);
      }
      expect(webviewCapabilities.resolve(cap)).toBeFalsy();
      const last = (await app.inject({ method: 'POST', url: `${base}/objects/e/frame` })).json().data.embedUrl;
      await command('canvas_delete', { operations: [{ kind: 'delete', opId: 'del-e', objectId: 'e' }] });
      expect(webviewCapabilities.resolve(last.split('/')[2])).toBeFalsy();
      expect(store.read().objects.e.deletedAt).not.toBeNull();
      expect((await app.inject({ method: 'POST', url: `${base}/objects/e/frame` })).statusCode).toBe(409);
      await command('canvas_history', { action: 'undo', sequences: [store.read().seq] });
      expect((await app.inject({ method: 'POST', url: `${base}/objects/e/frame` })).statusCode).toBe(200);
      expect(readFileSync(file).equals(before)).toBe(true);
      // The previous release reads the file as a plain array of rows: it sees only the user's tab.
      expect((JSON.parse(readFileSync(file, 'utf8')) as { id: string }[]).map((w) => w.id)).toEqual(['mine']);
      expect((await readWebviews(dir)).map((w) => w.id)).toEqual(['mine']);
    } finally {
      await app.close();
    }
  });
  it('retires a frame whose URL changes and when its owner logs out', async () => {
    const { app, command, base } = await media();
    try {
      await command('canvas_create', {
        operations: [
          {
            kind: 'create',
            opId: 'e',
            objectId: 'e',
            patch: {
              parentId: null,
              order: 0,
              position: { x: 0, y: 0 },
              size: { width: 480, height: 320 },
              content: { type: 'embed', url: 'https://example.com/' },
            },
          },
        ],
      });
      const first = (await app.inject({ method: 'POST', url: `${base}/objects/e/frame` })).json().data.embedUrl;
      await command('canvas_update', {
        operations: [
          {
            kind: 'update',
            opId: 'move',
            objectId: 'e',
            patch: { content: { type: 'embed', url: 'https://example.org/' } },
          },
        ],
      });
      expect(webviewCapabilities.resolve(first.split('/')[2])).toBeFalsy();
      const second = (await app.inject({ method: 'POST', url: `${base}/objects/e/frame` })).json().data.embedUrl;
      expect(webviewCapabilities.resolve(second.split('/')[2])).toBeTruthy();
      webviewCapabilities.revokeOwner('user-a');
      expect(webviewCapabilities.resolve(second.split('/')[2])).toBeFalsy();
    } finally {
      await app.close();
    }
  });
  it('answers a link preview through the command route and refuses metadata targets', async () => {
    const { app, command } = await media();
    try {
      const refused = await command('canvas_link_preview', { url: 'http://169.254.169.254/' });
      expect(refused.statusCode).toBe(200);
      expect(refused.json().data).toMatchObject({ status: 'unavailable', reason: 'This page could not be previewed' });
      const unreachable = await command('canvas_link_preview', { url: 'http://127.0.0.1:1/' });
      expect(unreachable.json().data.reason).toBe(refused.json().data.reason);
    } finally {
      await app.close();
    }
  });
  it('refuses a link or embed address that is not plain http(s) when it is written', async () => {
    const { app, command, store } = await media('media-urls');
    try {
      const create = (objectId: string, type: 'link' | 'embed', url: string) =>
        command('canvas_create', {
          operations: [
            {
              kind: 'create',
              opId: objectId,
              objectId,
              patch: {
                parentId: null,
                order: 0,
                position: { x: 0, y: 0 },
                size: { width: 200, height: 80 },
                content: type === 'link' ? { type, url, label: '' } : { type, url },
              },
            },
          ],
        });
      for (const [n, url] of [
        'javascript:alert(1)',
        'data:text/html,<b>x</b>',
        'file:///etc/passwd',
        'https://user:secret@example.com/',
        'https://example.com/a b',
        'example.com',
      ].entries()) {
        const refused = await create(`bad${n}`, n % 2 ? 'embed' : 'link', url);
        expect(refused.statusCode, url).toBe(409);
        expect(refused.json().reasons[0].code).toBe('INVALID');
      }
      expect(store.read().objects).toEqual({});
      expect((await create('good', 'link', 'https://example.com/docs')).statusCode).toBe(200);
      const repoint = await command('canvas_update', {
        operations: [
          {
            kind: 'update',
            opId: 'repoint',
            objectId: 'good',
            patch: { content: { type: 'embed', url: 'javascript:alert(1)' } },
          },
        ],
      });
      expect(repoint.statusCode).toBe(409);
      expect(store.read().objects.good.content).toMatchObject({ type: 'link', url: 'https://example.com/docs' });
    } finally {
      await app.close();
    }
  });
  it('limits uploads per caller and workspace, and refuses past the workspace quota with product copy', async () => {
    const { app, base } = await media('media-limits');
    try {
      const bytes = png(2, 2);
      for (let n = 0; n < 30; n++) expect((await upload(app, base, bytes)).statusCode).toBe(200);
      const limited = await upload(app, base, bytes);
      expect(limited.statusCode).toBe(429);
      expect(limited.json().errorCode).toBe('RATE_LIMITED');
    } finally {
      await app.close();
    }
    const quota = await media('media-quota');
    try {
      const first = png(3, 3);
      vi.stubEnv('CODEMAN_CANVAS_ASSET_QUOTA_BYTES', String(first.length));
      expect((await upload(quota.app, quota.base, first)).statusCode).toBe(200);
      const full = await upload(quota.app, quota.base, png(4, 4));
      expect(full.statusCode).toBe(413);
      expect(full.json()).toMatchObject({ refusal: 'quota' });
      expect(full.json().error).toMatch(/image limit\. Images already on it still show\./);
    } finally {
      vi.stubEnv('CODEMAN_CANVAS_ASSET_QUOTA_BYTES', '');
      await quota.app.close();
    }
  });
});
