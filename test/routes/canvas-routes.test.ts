import Fastify from 'fastify';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
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
import { create } from '../canvas-fixtures.js';

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
  const port = { canvasEnabled: async () => enabled, canvasStores: vi.fn(async () => stores), broadcast: vi.fn() };
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
