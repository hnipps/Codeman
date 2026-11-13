/**
 * @fileoverview A canvas route failure the server caused: the 5xx body carries no filesystem path, and one
 * error line reaches `server.jsonl` naming the route, the errno and the request id of the `requests` line.
 * A 4xx writes no error line.
 *
 * Port: N/A (app.inject, no listener is used).
 */
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CanvasStores } from '../src/canvas/canvas-store.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { dataPath } from '../src/config/instance.js';
import { installConsoleMirror, Telemetry } from '../src/telemetry.js';
import { queryLogs } from '../src/telemetry-query.js';
import { describeCanvasFailure } from '../src/web/routes/canvas-failure.js';
import { registerCanvasRoutes } from '../src/web/routes/canvas-routes.js';
import { create, human } from './canvas-fixtures.js';

let dir: string, logDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-failure-'));
  logDir = mkdtempSync(join(tmpdir(), 'canvas-failure-logs-'));
  vi.stubEnv('CODEMAN_DATA_DIR', dir);
  vi.stubEnv('CODEMAN_MULTIUSER', '0');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const path of [dir, logDir]) {
    try {
      chmodSync(join(path, 'canvas'), 0o700);
    } catch {
      /* only the data directory has one */
    }
    rmSync(path, { recursive: true, force: true });
  }
});

async function harness() {
  const app = Fastify();
  const requests: { reqId: string; status: number }[] = [];
  app.addHook('onRequest', async (req) => {
    req.authUser = { username: 'user-a', role: 'user' };
  });
  app.addHook('onResponse', async (req, reply) => {
    requests.push({ reqId: req.id, status: reply.statusCode });
  });
  const workspace = workspaceForCase('design');
  const stores = new CanvasStores();
  stores.get(workspace.id).append([create('first')], human);
  registerCanvasRoutes(app, {
    sessions: new Map(),
    canvasEnabled: async () => true,
    canvasStores: async () => stores,
    broadcast: vi.fn(),
  });
  await app.ready();
  const telemetry = new Telemetry(logDir, 'test-build', 1024 * 1024);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const restore = installConsoleMirror(telemetry);
  const command = (payload: unknown) =>
    app.inject({ method: 'POST', url: `/api/canvas/${workspace.id}/command`, payload: payload as object });
  /** What `logs_query` returns for `stream: server`: the route and the MCP tool both call this reader. */
  const serverLines = async () => {
    await telemetry.flush();
    const { lines } = await queryLogs({ stream: 'server', level: 'error', dir: logDir });
    return lines.map((line) => JSON.parse(line) as { level: string; msg: string });
  };
  const close = async () => {
    restore();
    await telemetry.close();
    await app.close();
  };
  return { workspace, requests, command, serverLines, close };
}

describe('canvas route failures', () => {
  it.skipIf(process.getuid?.() === 0)(
    'answers a failed write with a path-free 500 and logs its cause once, joined by the request id',
    async () => {
      const h = await harness();
      try {
        const log = dataPath('canvas', h.workspace.id, 'ops.jsonl');
        chmodSync(log, 0o444);
        chmodSync(dirname(log), 0o555);
        const response = await h.command({
          tool: 'canvas_create',
          arguments: { operations: [create('second')] },
        });
        chmodSync(dirname(log), 0o700);
        expect(response.statusCode).toBe(500);
        const body = response.json();
        expect(body.success).toBe(false);
        expect(body.errorCode).toBe('OPERATION_FAILED');
        expect(response.body).not.toContain(dir);
        expect(response.body).not.toContain('ops.jsonl');
        expect(response.body).not.toMatch(/\/[\w.-]+\//);
        const request = h.requests.at(-1)!;
        expect(request.status).toBe(500);
        expect(body.requestId).toBe(request.reqId);
        expect(body.error).toContain(request.reqId);

        const errors = await h.serverLines();
        expect(errors).toHaveLength(1);
        const { msg } = errors[0];
        expect(msg).toContain('POST /api/canvas/:workspaceId/command');
        expect(msg).toContain('failed 500');
        expect(msg).toContain(`reqId=${request.reqId}`);
        expect(msg).toContain(`workspace=${h.workspace.id}`);
        expect(msg).toContain('errno=EACCES');
        expect(msg).toContain('file="operation log"');
        expect(msg).toContain(`<data dir>/canvas/${h.workspace.id}/ops.jsonl`);
        expect(msg).not.toContain(dir);
        expect(msg).not.toContain('[redacted]');
      } finally {
        await h.close();
      }
    }
  );

  it('writes no error line for a request the caller got wrong', async () => {
    const h = await harness();
    try {
      expect((await h.command({ tool: 'canvas_create' })).statusCode).toBe(400);
      const update = {
        kind: 'update',
        opId: 'update-gone',
        objectId: 'gone',
        patch: { content: { type: 'text', text: 'x' } },
      };
      expect((await h.command({ tool: 'canvas_update', arguments: { operations: [update] } })).statusCode).toBe(409);
      expect(await h.serverLines()).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('names the data and home directories instead of spelling them out', () => {
    const home = homedir();
    const error = Object.assign(new Error(`ENOSPC: no space left on device, write '${home}/elsewhere/file'`), {
      code: 'ENOSPC',
      path: `${home}/elsewhere/file`,
    });
    expect(describeCanvasFailure(error, '/srv/data', home)).toBe(
      "errno=ENOSPC ENOSPC: no space left on device, write '~/elsewhere/file'"
    );
    expect(describeCanvasFailure('plain text')).toBe('plain text');
  });
});
