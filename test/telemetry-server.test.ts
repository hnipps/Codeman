/**
 * A live WebServer (port 0) with CODEMAN_LOG_DIR, CODEMAN_BUILD_ID and a password set:
 * the build id on /api/status and the SSE init event, /api/health and /ws/health behind
 * auth and the upgrade guard, and what lands in requests.jsonl and client-errors.jsonl.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';

const PASSWORD = 's3cret-pass';
const BUILD_ID = 'live-build-1';
const AUTH = { authorization: `Basic ${Buffer.from(`admin:${PASSWORD}`).toString('base64')}` };

let server: WebServer;
let base: string;
let logDir: string;

function logLines(file: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(join(logDir, file), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function wsHealth(headers: Record<string, string>, origin?: string) {
  return new Promise<{ frames: unknown[]; closeCode?: number }>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.boundPort}/ws/health`, { headers, origin });
    const result: { frames: unknown[]; closeCode?: number } = { frames: [] };
    ws.on('message', (data) => result.frames.push(JSON.parse(String(data))));
    ws.on('close', (code) => resolve({ ...result, closeCode: code }));
    ws.on('error', () => {});
  });
}

async function firstInitEvent(): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: AUTH, signal: controller.signal });
  const reader = res.body!.getReader();
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended before an init event');
      text += new TextDecoder().decode(value);
      const m = /event: init\ndata: (.*)\n\n/.exec(text);
      if (m) return JSON.parse(m[1]);
    }
  } finally {
    controller.abort();
  }
}

beforeAll(async () => {
  logDir = mkdtempSync(join(tmpdir(), 'codeman-telemetry-server-'));
  process.env.CODEMAN_LOG_DIR = logDir;
  process.env.CODEMAN_BUILD_ID = BUILD_ID;
  process.env.CODEMAN_PASSWORD = PASSWORD;
  server = new WebServer(0, false, true);
  await server.start();
  base = `http://127.0.0.1:${server.boundPort}`;
});

afterAll(async () => {
  await server.stop();
  delete process.env.CODEMAN_LOG_DIR;
  delete process.env.CODEMAN_BUILD_ID;
  delete process.env.CODEMAN_PASSWORD;
  rmSync(logDir, { recursive: true, force: true });
});

describe('build id', () => {
  it('rides /api/status next to the version', async () => {
    const res = await fetch(`${base}/api/status`, { headers: AUTH });
    const { data } = await res.json();
    expect(data.buildId).toBe(BUILD_ID);
    expect(data.version).toBeDefined();
  });

  it('rides the SSE init event, which is what tells a page a new build is live', async () => {
    const init = await firstInitEvent();
    expect(init.buildId).toBe(BUILD_ID);
  });
});

describe('GET /api/health', () => {
  it('answers ok with the build identity once authenticated', async () => {
    const res = await fetch(`${base}/api/health`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ status: 'ok', buildId: BUILD_ID, sessions: 0, pid: process.pid });
  });

  it('is behind the normal auth', async () => {
    expect((await fetch(`${base}/api/health`)).status).toBe(401);
  });
});

describe('/ws/health', () => {
  it('sends {ok, buildId} and closes normally', async () => {
    const result = await wsHealth(AUTH);
    expect(result.frames).toEqual([{ ok: true, buildId: BUILD_ID }]);
    expect(result.closeCode).toBe(1000);
  });

  // A refused upgrade is not driven through a WebSocket client here: the repo's auth hook leaves
  // that socket open on the server, which makes stop() wait on it (true of the terminal route too).
  it('is behind the normal auth hook', async () => {
    expect((await fetch(`${base}/ws/health`)).status).toBe(401);
    expect((await fetch(`${base}/ws/health`, { headers: AUTH })).status).not.toBe(401);
  });

  it('refuses a cross-site Origin like the terminal socket does', async () => {
    const result = await wsHealth(AUTH, 'https://evil.example');
    expect(result.frames).toEqual([]);
  });
});

describe('telemetry files', () => {
  it('logs each request as method, path without its query, status and ms, and never a header', async () => {
    await fetch(`${base}/api/status?token=hunter2`, { headers: AUTH });
    await fetch(`${base}/api/health`);

    await vi.waitFor(
      () => {
        const lines = logLines('requests.jsonl');
        expect(lines.some((l) => l.path === '/api/status' && l.status === 200)).toBe(true);
        expect(lines.some((l) => l.path === '/api/health' && l.status === 401)).toBe(true);
      },
      { timeout: 3000 }
    );

    const raw = readFileSync(join(logDir, 'requests.jsonl'), 'utf8');
    for (const secret of ['hunter2', PASSWORD, 'Basic ', 'authorization']) expect(raw).not.toContain(secret);
    for (const line of logLines('requests.jsonl')) {
      expect(Object.keys(line).sort()).toEqual(['buildId', 'method', 'ms', 'path', 'pid', 'reqId', 'status', 'ts']);
      expect(line.ms).toEqual(expect.any(Number));
      expect(line.reqId).toMatch(/^req-[0-9a-f]{8}-[0-9a-z]+$/);
    }
    const ids = logLines('requests.jsonl').map((l) => l.reqId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('records a posted client error with the build id and user agent', async () => {
    const res = await fetch(`${base}/api/client-errors`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json', 'user-agent': 'LiveTest/2' },
      body: JSON.stringify({ message: 'render failed', source: '/app.js', line: 7, col: 3, url: '/' }),
    });
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(logLines('client-errors.jsonl')).toHaveLength(1), { timeout: 3000 });
    expect(logLines('client-errors.jsonl')[0]).toMatchObject({
      buildId: BUILD_ID,
      ua: 'LiveTest/2',
      message: 'render failed',
      source: '/app.js',
      line: 7,
      col: 3,
    });
  });
});
