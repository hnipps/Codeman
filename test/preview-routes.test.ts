import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebServer } from '../src/web/server.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { findListenerPids, readProcSnapshot, readProcStat } from '../src/preview-proc.js';
import { deployRole } from '../src/deploy-role.js';
import { webviewCapabilities } from '../src/webview-capabilities.js';

vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);

const SERVER = `${process.execPath} -e "require('http').createServer((q,s)=>s.end('preview '+process.env.PORT)).listen(Number(process.argv[1]))" {port}`;

let server: WebServer;
let dataDir: string;
let workDir: string;
let savedDataDir: string | undefined;

const url = (p: string) => `http://localhost:${server.boundPort}${p}`;

async function call(method: string, p: string, body?: unknown) {
  const res = await fetch(url(p), {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function createSession(name: string): Promise<string> {
  const { body } = await call('POST', '/api/v1/sessions', { workingDir: workDir, name });
  expect(body.success).toBe(true);
  return body.data.id ?? body.data.session?.id;
}

const put = (sid: string, name: string, cmd = SERVER) =>
  call('PUT', `/api/v1/sessions/${sid}/previews/${name}`, { cmd });

function markerPids(): number[] {
  return [...readProcSnapshot().values()].filter((e) => !e.zombie && e.previewOwner === dataDir).map((e) => e.pid);
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function webviews(): Promise<Array<Record<string, any>>> {
  return (await call('GET', '/api/v1/webviews')).body.data.webviews;
}

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-routes-data-'));
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-routes-work-'));
  savedDataDir = process.env.CODEMAN_DATA_DIR;
  process.env.CODEMAN_DATA_DIR = dataDir;
  server = new WebServer(0, false, true);
  await server.start();
});

afterEach(async () => {
  for (const preview of server.previews.list()) await server.previews.remove(preview.webviewId);
});

afterAll(async () => {
  await server?.stop();
  for (const pid of markerPids()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  if (savedDataDir === undefined) delete process.env.CODEMAN_DATA_DIR;
  else process.env.CODEMAN_DATA_DIR = savedDataDir;
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
});

describe('PUT creates a preview', () => {
  it('returns port, url and running state, the url serves the server, and the web tab has a session origin', async () => {
    const sid = await createSession('prev-create');
    const { status, body } = await put(sid, 'web');
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ name: 'web', sessionId: sid, state: 'running', ready: true, cwd: workDir });
    expect(body.data.url).toMatch(/^\/webview\/[^/]+\/$/);
    const page = await fetch(url(body.data.url));
    expect(await page.text()).toBe(`preview ${body.data.port}`);
    const tab = (await webviews()).find((w) => w.id === body.data.webviewId);
    expect(tab).toMatchObject({
      origin: { kind: 'session', sessionId: sid, name: 'prev-create' },
      trusted: false,
      url: `http://127.0.0.1:${body.data.port}/`,
    });
  });

  it('refuses an origin or any other field in the body', async () => {
    const sid = await createSession('prev-strict');
    const { status, body } = await call('PUT', `/api/v1/sessions/${sid}/previews/web`, {
      cmd: SERVER,
      origin: { kind: 'user' },
    });
    expect(status).toBe(400);
    expect(body.errorCode).toBe('INVALID_INPUT');
    expect(server.previews.list()).toEqual([]);
  });

  it('refuses a bad name and an empty cmd', async () => {
    const sid = await createSession('prev-bad');
    expect((await put(sid, '..bad')).status).toBe(400);
    expect((await put(sid, 'web', '  ')).body.errorCode).toBe('INVALID_INPUT');
  });
});

describe('PUT again replaces', () => {
  it('stops the old process and leaves one preview on the same web tab', async () => {
    const sid = await createSession('prev-replace');
    const first = (await put(sid, 'web')).body.data;
    const second = (await put(sid, 'web')).body.data;
    const third = (await put(sid, 'web')).body.data;
    expect(third.webviewId).toBe(first.webviewId);
    expect(readProcStat(first.pid)).toBeNull();
    expect(readProcStat(second.pid)).toBeNull();
    const list = (await call('GET', '/api/v1/previews')).body.data.previews;
    expect(list).toHaveLength(1);
    expect((await webviews()).filter((w) => w.origin.kind === 'session' && w.origin.sessionId === sid)).toHaveLength(1);
    expect(new Set(markerPids().map((pid) => readProcStat(pid)?.pgid))).toEqual(new Set([third.pgid]));
  });
});

describe('listing and reading', () => {
  it('lists previews per session and overall, reads one, and tails its log', async () => {
    const a = await createSession('prev-list-a');
    const b = await createSession('prev-list-b');
    await put(a, 'web');
    await put(b, 'api', 'echo hello from {port}; exit 0');
    expect((await call('GET', '/api/v1/previews')).body.data.previews).toHaveLength(2);
    const mine = (await call('GET', `/api/v1/sessions/${a}/previews`)).body.data.previews;
    expect(mine.map((p: { name: string }) => p.name)).toEqual(['web']);
    const one = await call('GET', `/api/v1/sessions/${b}/previews/api`);
    expect(one.body.data).toMatchObject({ name: 'api', state: 'exited' });
    const tail = `${one.body.data.port}\n`;
    const log = await call('GET', `/api/v1/sessions/${b}/previews/api/log?tail=${tail.length}`);
    expect(log.body.data).toMatchObject({ text: tail, size: `hello from ${tail}`.length, state: 'exited' });
    expect((await call('GET', `/api/v1/sessions/${b}/previews/nope`)).status).toBe(404);
  });
});

describe('deleting', () => {
  it('DELETE on the preview stops the process, frees the port and removes the web tab', async () => {
    const sid = await createSession('prev-del');
    const created = (await put(sid, 'web')).body.data;
    const { status, body } = await call('DELETE', `/api/v1/sessions/${sid}/previews/web`);
    expect(status).toBe(200);
    expect(body.data.webviewId).toBe(created.webviewId);
    expect(await portOpen(created.port)).toBe(false);
    expect((await webviews()).some((w) => w.id === created.webviewId)).toBe(false);
    expect(server.previews.list()).toEqual([]);
  });

  it('deleting the web tab stops the preview in the same call', async () => {
    const sid = await createSession('prev-del-tab');
    const created = (await put(sid, 'web')).body.data;
    expect((await call('DELETE', `/api/v1/webviews/${created.webviewId}`)).status).toBe(200);
    expect(await portOpen(created.port)).toBe(false);
    expect(server.previews.list()).toEqual([]);
  });

  it('deleting the session stops its previews and removes their web tabs, leaving other sessions alone', async () => {
    const doomed = await createSession('prev-cascade');
    const kept = await createSession('prev-kept');
    const gone = (await put(doomed, 'web')).body.data;
    const stays = (await put(kept, 'web')).body.data;
    expect((await call('DELETE', `/api/v1/sessions/${doomed}`)).status).toBe(200);
    expect(await portOpen(gone.port)).toBe(false);
    expect(server.previews.list().map((p) => p.webviewId)).toEqual([stays.webviewId]);
    const ids = (await webviews()).map((w) => w.id);
    expect(ids).not.toContain(gone.webviewId);
    expect(ids).toContain(stays.webviewId);
  });

  it('deleting a pinned session cascades to its previews too', async () => {
    const sid = await createSession('prev-pinned');
    expect((await call('POST', `/api/v1/sessions/${sid}/pin`, { pinned: true })).body.success).toBe(true);
    expect((await call('GET', `/api/v1/sessions/${sid}`)).body.data.pinned).toBe(true);
    const created = (await put(sid, 'web')).body.data;
    expect((await call('DELETE', `/api/v1/sessions/${sid}`)).status).toBe(200);
    expect(await portOpen(created.port)).toBe(false);
    expect(server.previews.list()).toEqual([]);
    expect((await webviews()).some((w) => w.id === created.webviewId)).toBe(false);
  });
});

describe('remote and Docker sessions', () => {
  it.each([
    ['_remote', { hostId: 'h1', remoteTmuxSession: 'x', owned: true }, 'remote (SSH)'],
    ['_docker', { caseName: 'c', containerName: 'x' }, 'Docker'],
  ])('refuses a %s session with INVALID_INPUT naming the type, and spawns nothing', async (field, meta, label) => {
    const sid = await createSession(`prev-${field}`);
    (server as unknown as { sessions: Map<string, Record<string, unknown>> }).sessions.get(sid)![field] = meta;
    const before = markerPids();
    const { status, body } = await put(sid, 'web');
    expect(status).toBe(400);
    expect(body.errorCode).toBe('INVALID_INPUT');
    expect(body.error).toContain(label);
    expect(markerPids()).toEqual(before);
    expect(server.previews.list()).toEqual([]);
  });
});

describe('reconcile', () => {
  it('deletes session web tabs whose session is gone, and stops their previews', async () => {
    const sid = await createSession('prev-orphan');
    const created = (await put(sid, 'web')).body.data;
    const internals = server as unknown as {
      sessions: Map<string, unknown>;
      store: { removeSession(id: string): void };
    };
    internals.sessions.delete(sid);
    internals.store.removeSession(sid);
    await server.reconcilePreviews();
    expect((await webviews()).some((w) => w.id === created.webviewId)).toBe(false);
    expect(server.previews.list()).toEqual([]);
    expect(await portOpen(created.port)).toBe(false);
  });

  it('marks a preview viewed when its proxy URL is requested', async () => {
    const sid = await createSession('prev-viewed');
    const created = (await put(sid, 'web')).body.data;
    const before = server.previews.forWebview(created.webviewId)!.lastViewedAt;
    await new Promise((r) => setTimeout(r, 1100));
    await (await fetch(url(created.url))).text();
    expect(server.previews.forWebview(created.webviewId)!.lastViewedAt).toBeGreaterThan(before);
  });
});

describe('revoking a capability', () => {
  it('closes the WebSockets proxied through it', async () => {
    const { WebSocketServer, WebSocket } = await import('ws');
    const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => upstream.once('listening', r));
    const port = (upstream.address() as net.AddressInfo).port;
    try {
      const created = await call('POST', '/api/v1/webviews', { name: 'ws', url: `http://127.0.0.1:${port}/` });
      const id = created.body.data.id;
      const open = await call('POST', `/api/v1/webviews/${id}/open`);
      const client = new WebSocket(`ws://localhost:${server.boundPort}${open.body.data.embedUrl}socket`);
      await new Promise((resolve, reject) => {
        client.once('open', resolve);
        client.once('error', reject);
      });
      await new Promise((r) => setTimeout(r, 100));
      const closed = new Promise<number>((resolve) => client.once('close', (code) => resolve(code)));
      webviewCapabilities.revokeWebview(id);
      expect(await closed).toBe(4003);
      await call('DELETE', `/api/v1/webviews/${id}`);
    } finally {
      upstream.close();
    }
  });
});

describe('fix round 1', () => {
  const killListener = (port: number) => {
    for (const pid of findListenerPids(port)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  };

  it('DELETE says a server that escaped the marker is still listening, and the list shows it', async () => {
    const sid = await createSession('prev-escaped');
    const created = (await put(sid, 'web', `(env -i setsid ${SERVER} >/dev/null 2>&1 &)`)).body.data;
    try {
      const deadline = Date.now() + 5000;
      while (!(await portOpen(created.port)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      const pids = findListenerPids(created.port);
      expect(pids).toHaveLength(1);
      const { status, body } = await call('DELETE', `/api/v1/sessions/${sid}/previews/web`);
      expect(status).toBe(200);
      expect(body.data.leftRunning).toEqual({ port: created.port, pids });
      const listed = (await call('GET', '/api/v1/previews')).body.data;
      expect(listed.previews).toEqual([]);
      expect(listed.leftRunning).toEqual([
        expect.objectContaining({ port: created.port, pids, sessionId: sid, name: 'web' }),
      ]);
      expect((await call('GET', `/api/v1/sessions/${sid}/previews`)).body.data.leftRunning).toHaveLength(1);
    } finally {
      killListener(created.port);
      await new Promise((r) => setTimeout(r, 200));
      await server.reconcilePreviews(false);
    }
    expect((await call('GET', '/api/v1/previews')).body.data.leftRunning).toEqual([]);
  });

  it('DELETE is refused on a deploy colour that may not write, and stops nothing', async () => {
    const sid = await createSession('prev-colour');
    const created = (await put(sid, 'web')).body.data;
    deployRole.initFromEnv({ CODEMAN_DEPLOY_ROLE: 'candidate' });
    try {
      const { status, body } = await call('DELETE', `/api/v1/sessions/${sid}/previews/web`);
      expect(status).toBe(409);
      expect(body.errorCode).toBe('CONFLICT');
      expect(await portOpen(created.port)).toBe(true);
    } finally {
      deployRole.initFromEnv({});
    }
  });

  it('web tab DELETE and session delete stop nothing on a deploy colour that may not write', async () => {
    const sid = await createSession('prev-colour-tab');
    const created = (await put(sid, 'web')).body.data;
    deployRole.initFromEnv({ CODEMAN_DEPLOY_ROLE: 'candidate' });
    try {
      const tab = await call('DELETE', `/api/v1/webviews/${created.webviewId}`);
      expect(tab.status).toBe(409);
      expect(tab.body.errorCode).toBe('CONFLICT');
      expect((await webviews()).some((w) => w.id === created.webviewId)).toBe(true);
      expect((await call('DELETE', `/api/v1/sessions/${sid}`)).status).toBe(200);
      expect(await portOpen(created.port)).toBe(true);
      expect(server.previews.forWebview(created.webviewId)?.state).toBe('running');
    } finally {
      deployRole.initFromEnv({});
    }
  });

  it('concurrent PUTs stop at the eight-preview limit', async () => {
    const sid = await createSession('prev-limit');
    const results = await Promise.all(Array.from({ length: 9 }, (_, i) => put(sid, `n${i}`, 'exit 0')));
    expect(results.filter((r) => r.status === 200)).toHaveLength(8);
    const refused = results.filter((r) => r.status === 400);
    expect(refused).toHaveLength(1);
    expect(refused[0].body.error).toContain('at most 8 previews');
    expect(server.previews.list().filter((p) => p.sessionId === sid)).toHaveLength(8);
  });

  it('an open proxied WebSocket keeps a preview from being stopped as idle', async () => {
    const { WebSocket } = await import('ws');
    const wsModule = createRequire(import.meta.url).resolve('ws');
    const cmd = `${process.execPath} -e "const {WebSocketServer}=require(process.argv[2]);new WebSocketServer({port:Number(process.argv[1])})" {port} ${wsModule}`;
    const sid = await createSession('prev-ws-idle');
    const created = (await put(sid, 'live', cmd)).body.data;
    expect(created.ready).toBe(true);
    const saved = process.env.CODEMAN_PREVIEW_IDLE_STOP_MS;
    process.env.CODEMAN_PREVIEW_IDLE_STOP_MS = '1500';
    try {
      const client = new WebSocket(`ws://localhost:${server.boundPort}${created.url}`);
      await new Promise((resolve, reject) => {
        client.once('open', resolve);
        client.once('error', reject);
      });
      await new Promise((r) => setTimeout(r, 2500));
      await server.reconcilePreviews(false);
      expect(server.previews.forWebview(created.webviewId)?.state).toBe('running');
      const closed = new Promise((resolve) => client.once('close', resolve));
      client.close();
      await closed;
      await new Promise((r) => setTimeout(r, 2500));
      await server.reconcilePreviews(false);
      expect(server.previews.forWebview(created.webviewId)?.state).toBe('stopped');
      expect(await portOpen(created.port)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.CODEMAN_PREVIEW_IDLE_STOP_MS;
      else process.env.CODEMAN_PREVIEW_IDLE_STOP_MS = saved;
    }
  }, 20_000);
});

describe('fix round 3', () => {
  const killListener = (port: number) => {
    for (const pid of findListenerPids(port)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  };

  it('a web tab DELETE whose stop the supervisor refuses after the tab is gone says the stop was deferred', async () => {
    const sid = await createSession('prev-deferred');
    const created = (await put(sid, 'web')).body.data;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const holding = server.previews.reconcile(async () => {
      await held;
      return new Set([created.webviewId]);
    });
    try {
      const deletion = call('DELETE', `/api/v1/webviews/${created.webviewId}`);
      const deadline = Date.now() + 5000;
      while ((await webviews()).some((w) => w.id === created.webviewId) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      deployRole.initFromEnv({ CODEMAN_DEPLOY_ROLE: 'candidate' });
      release();
      const { status, body } = await deletion;
      await holding;
      expect(status).toBe(200);
      expect(body.data).toEqual({ id: created.webviewId, previewStop: 'deferred' });
      expect(await portOpen(created.port)).toBe(true);
    } finally {
      release();
      deployRole.initFromEnv({});
    }
  });

  it('an exited preview whose server escaped lists the listener on the preview and under leftRunning', async () => {
    const sid = await createSession('prev-exited-escaped');
    const cmd = `env -i PATH=/usr/bin:/bin setsid ${SERVER} >/dev/null 2>&1 &`;
    const created = (await put(sid, 'web', cmd)).body.data;
    try {
      expect(created.state).toBe('exited');
      const pids = findListenerPids(created.port);
      expect(pids).toHaveLength(1);
      expect(created.stillListening).toEqual({ port: created.port, pids });
      const listed = (await call('GET', '/api/v1/previews')).body.data;
      expect(listed.previews).toEqual([expect.objectContaining({ webviewId: created.webviewId, state: 'exited' })]);
      expect(listed.previews[0].stillListening).toEqual({ port: created.port, pids });
      expect(listed.leftRunning).toEqual([expect.objectContaining({ port: created.port, pids, name: 'web' })]);
    } finally {
      killListener(created.port);
      await new Promise((r) => setTimeout(r, 200));
      await server.reconcilePreviews(false);
    }
  });
});
