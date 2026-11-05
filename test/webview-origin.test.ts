/**
 * Web tab origins against a live server on an ephemeral port: old records gain an
 * origin as they are read without the file being rewritten, a session-origin
 * record can never be trusted, and deleting a session deletes the web tabs it owns.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebServer } from '../src/web/server.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { webviewsPath } from '../src/webview-store.js';

vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);

let server: WebServer;
let dataDir: string;
let workDir: string;
let savedDataDir: string | undefined;

const url = (p: string) => `http://localhost:${server.boundPort}${p}`;
const json = { 'Content-Type': 'application/json' };

async function call(method: string, p: string, body?: unknown) {
  const res = await fetch(url(p), {
    method,
    headers: body === undefined ? {} : json,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function listWebviews(): Promise<Array<Record<string, unknown> & { id: string }>> {
  const { body } = await call('GET', '/api/v1/webviews');
  return body.data.webviews;
}

async function createSession(name: string): Promise<string> {
  const { body } = await call('POST', '/api/v1/sessions', { workingDir: workDir, name });
  expect(body.success).toBe(true);
  return body.data.id ?? body.data.session?.id;
}

async function createSessionTab(sessionId: string, name: string, extra: Record<string, unknown> = {}) {
  return call('POST', '/api/v1/webviews', {
    name,
    url: 'http://127.0.0.1:1/',
    origin: { kind: 'session', sessionId },
    ...extra,
  });
}

async function sseDuring(action: () => Promise<unknown>): Promise<string> {
  const controller = new AbortController();
  const res = await fetch(url('/api/events'), { signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        text += decoder.decode(value, { stream: true });
      }
    } catch {}
  })();
  await new Promise((r) => setTimeout(r, 100));
  await action();
  await new Promise((r) => setTimeout(r, 300));
  controller.abort();
  await pump;
  return text;
}

function sseFrames(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  const frames: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n');
    const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
    const data = lines
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6))
      .join('\n');
    if (event && data) frames.push({ event, data: JSON.parse(data) });
  }
  return frames;
}

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webview-origin-data-'));
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webview-origin-work-'));
  savedDataDir = process.env.CODEMAN_DATA_DIR;
  process.env.CODEMAN_DATA_DIR = dataDir;
  server = new WebServer(0, false, true);
  await server.start();
});

afterAll(async () => {
  await server?.stop();
  if (savedDataDir === undefined) delete process.env.CODEMAN_DATA_DIR;
  else process.env.CODEMAN_DATA_DIR = savedDataDir;
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
});

describe('records written before origin existed', () => {
  it('read as user and managed origins, and reading twice leaves the file byte-identical', async () => {
    const legacy = [
      {
        id: 'legacy-user',
        name: 'Grafana',
        url: 'http://127.0.0.1:3001/',
        embedMode: 'proxy',
        trusted: false,
        createdAt: 1,
      },
      {
        id: 'legacy-deepseek',
        name: 'DeepSeek Harness',
        url: 'http://127.0.0.1:3080/',
        embedMode: 'proxy',
        trusted: true,
        managed: 'deepseek-web',
        createdAt: 2,
      },
    ];
    const raw = JSON.stringify(legacy, null, 2);
    await fs.writeFile(webviewsPath(dataDir), raw);

    const first = await listWebviews();
    const second = await listWebviews();

    expect(first).toEqual(second);
    expect(first.find((w) => w.id === 'legacy-user')).toMatchObject({ origin: { kind: 'user' } });
    const deepseek = first.find((w) => w.id === 'legacy-deepseek')!;
    expect(deepseek.origin).toEqual({ kind: 'managed', managed: 'deepseek-web' });
    expect(deepseek.managed).toBe('deepseek-web');
    expect(first.find((w) => w.id === 'legacy-user')).not.toHaveProperty('managed');
    expect(await fs.readFile(webviewsPath(dataDir), 'utf-8')).toBe(raw);
  });

  it('writes the origin and drops the old field on the next ordinary write', async () => {
    const res = await call('PATCH', '/api/v1/webviews/legacy-user', { name: 'Grafana 2' });
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(await fs.readFile(webviewsPath(dataDir), 'utf-8'));
    expect(onDisk.find((w: { id: string }) => w.id === 'legacy-user').origin).toEqual({ kind: 'user' });
    const deepseek = onDisk.find((w: { id: string }) => w.id === 'legacy-deepseek');
    expect(deepseek.origin).toEqual({ kind: 'managed', managed: 'deepseek-web' });
    expect(deepseek).not.toHaveProperty('managed');
  });
});

describe('creating web tabs', () => {
  it('defaults to a user origin and keeps a managed origin', async () => {
    const plain = await call('POST', '/api/v1/webviews', { name: 'Plain', url: 'http://127.0.0.1:4000/' });
    expect(plain.body.data.origin).toEqual({ kind: 'user' });
    const managed = await call('POST', '/api/v1/webviews', {
      name: 'DS',
      url: 'http://127.0.0.1:3081/',
      trusted: true,
      origin: { kind: 'managed', managed: 'deepseek-web' },
    });
    expect(managed.body.data.origin).toEqual({ kind: 'managed', managed: 'deepseek-web' });
  });

  it('still accepts the deprecated managed field, and GET shows both managed and origin', async () => {
    const created = await call('POST', '/api/v1/webviews', {
      name: 'DeepSeek Harness',
      url: 'http://127.0.0.1:3082/',
      trusted: true,
      managed: 'deepseek-web',
    });
    expect(created.status).toBe(200);
    expect(created.body.data).toMatchObject({
      managed: 'deepseek-web',
      origin: { kind: 'managed', managed: 'deepseek-web' },
    });
    const listed = (await listWebviews()).find((w) => w.id === created.body.data.id);
    expect(listed).toMatchObject({ managed: 'deepseek-web', origin: { kind: 'managed', managed: 'deepseek-web' } });
    const onDisk = JSON.parse(await fs.readFile(webviewsPath(dataDir), 'utf-8'));
    expect(onDisk.find((w: { id: string }) => w.id === created.body.data.id)).not.toHaveProperty('managed');
  });

  it('refuses managed and origin that disagree with INVALID_INPUT and saves nothing', async () => {
    const before = (await listWebviews()).length;
    const res = await call('POST', '/api/v1/webviews', {
      name: 'Mixed',
      url: 'http://127.0.0.1:3083/',
      managed: 'deepseek-web',
      origin: { kind: 'user' },
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
    expect((await listWebviews()).length).toBe(before);
  });

  it('takes a session origin name from the session, and refuses a session it cannot find', async () => {
    const sessionId = await createSession('origin-name');
    const created = await createSessionTab(sessionId, 'Preview');
    expect(created.status).toBe(200);
    expect(created.body.data.origin).toEqual({ kind: 'session', sessionId, name: 'origin-name' });

    const missing = await createSessionTab('no-such-session-id', 'Preview');
    expect(missing.status).toBe(404);
  });
});

describe('a session-origin web tab is never trusted', () => {
  it('refuses trusted on create with INVALID_INPUT and saves nothing', async () => {
    const sessionId = await createSession('trusted-create');
    const before = (await listWebviews()).length;
    const res = await createSessionTab(sessionId, 'Preview', { trusted: true });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
    expect((await listWebviews()).length).toBe(before);
  });

  it('refuses trusted on update with INVALID_INPUT and leaves the record unchanged', async () => {
    const sessionId = await createSession('trusted-update');
    const { body } = await createSessionTab(sessionId, 'Preview');
    const id = body.data.id;
    const before = (await listWebviews()).find((w) => w.id === id);

    const res = await call('PATCH', `/api/v1/webviews/${id}`, { trusted: true, name: 'Renamed' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
    expect((await listWebviews()).find((w) => w.id === id)).toEqual(before);
  });

  it('still lets a user web tab be trusted, keeping its origin', async () => {
    const { body } = await call('POST', '/api/v1/webviews', { name: 'Mine', url: 'http://127.0.0.1:4001/' });
    const res = await call('PATCH', `/api/v1/webviews/${body.data.id}`, { trusted: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ trusted: true, origin: { kind: 'user' } });
  });

  it('cannot change an origin through PATCH', async () => {
    const sessionId = await createSession('origin-fixed');
    const { body } = await createSessionTab(sessionId, 'Preview');
    const res = await call('PATCH', `/api/v1/webviews/${body.data.id}`, { origin: { kind: 'user' } });
    expect(res.status).toBe(200);
    expect(res.body.data.origin).toEqual({ kind: 'session', sessionId, name: 'origin-fixed' });
  });

  it('accepts the deprecated managed field on a user web tab', async () => {
    const { body } = await call('POST', '/api/v1/webviews', { name: 'DeepSeek', url: 'http://127.0.0.1:4003/' });
    const res = await call('PATCH', `/api/v1/webviews/${body.data.id}`, { managed: 'deepseek-web' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      managed: 'deepseek-web',
      origin: { kind: 'managed', managed: 'deepseek-web' },
    });
    const stored = JSON.parse(await fs.readFile(webviewsPath(dataDir), 'utf-8')).find(
      (w: { id: string }) => w.id === body.data.id
    );
    expect(stored.origin).toEqual({ kind: 'managed', managed: 'deepseek-web' });
  });

  it('refuses the deprecated managed field on a session web tab and leaves the file unchanged', async () => {
    const sessionId = await createSession('managed-refused');
    const { body } = await createSessionTab(sessionId, 'Preview');
    const before = await fs.readFile(webviewsPath(dataDir), 'utf-8');
    const res = await call('PATCH', `/api/v1/webviews/${body.data.id}`, { managed: 'deepseek-web', name: 'X' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
    expect(await fs.readFile(webviewsPath(dataDir), 'utf-8')).toBe(before);
  });
});

describe('deleting a session', () => {
  it("removes only that session's web tabs, revokes their capabilities and announces each removal", async () => {
    const doomed = await createSession('doomed');
    const kept = await createSession('kept');
    const doomedTabs = [
      (await createSessionTab(doomed, 'Doomed A')).body.data.id,
      (await createSessionTab(doomed, 'Doomed B')).body.data.id,
    ];
    const keptTab = (await createSessionTab(kept, 'Kept')).body.data.id;
    const userTab = (await call('POST', '/api/v1/webviews', { name: 'User', url: 'http://127.0.0.1:4002/' })).body.data
      .id;
    const opened = await call('POST', `/api/v1/webviews/${doomedTabs[0]}/open`);
    const embedUrl: string = opened.body.data.embedUrl;
    expect(embedUrl).toMatch(/^\/webview\//);

    const events = await sseDuring(async () => {
      const del = await call('DELETE', `/api/v1/sessions/${doomed}`);
      expect(del.status).toBe(200);
    });

    const ids = (await listWebviews()).map((w) => w.id);
    for (const id of doomedTabs) expect(ids).not.toContain(id);
    expect(ids).toContain(keptTab);
    expect(ids).toContain(userTab);

    const onDisk = JSON.parse(await fs.readFile(webviewsPath(dataDir), 'utf-8')).map((w: { id: string }) => w.id);
    for (const id of doomedTabs) expect(onDisk).not.toContain(id);

    const proxied = await fetch(url(embedUrl));
    expect(proxied.status).toBe(403);

    const changes = sseFrames(events).filter((f) => f.event === 'webview:changed');
    for (const id of doomedTabs) {
      expect(changes.filter((f) => f.data.id === id)).toEqual([
        { event: 'webview:changed', data: { action: 'deleted', id, owner: '@single' } },
      ]);
    }
    expect(changes.filter((f) => f.data.id === keptTab || f.data.id === userTab)).toEqual([]);
  });

  it('keeps the web tabs of a detached session', async () => {
    const detached = await createSession('detached');
    const tab = (await createSessionTab(detached, 'Survives')).body.data.id;
    const del = await call('DELETE', `/api/v1/sessions/${detached}?killMux=false`);
    expect(del.status).toBe(200);
    expect((await listWebviews()).find((w) => w.id === tab)).toMatchObject({
      origin: { kind: 'session', sessionId: detached },
    });
  });
});

describe('malformed rows on disk', () => {
  const valid = {
    id: 'valid-row',
    name: 'Valid',
    url: 'http://127.0.0.1:3001/',
    embedMode: 'proxy',
    trusted: false,
    origin: { kind: 'user' },
    createdAt: 1,
  };

  it('skips rows that are not objects or have no id, and the next write keeps the good row', async () => {
    await fs.writeFile(webviewsPath(dataDir), JSON.stringify([valid, null, 5, { name: 'no id' }]));
    expect((await listWebviews()).map((w) => w.id)).toEqual(['valid-row']);

    const created = await call('POST', '/api/v1/webviews', { name: 'New', url: 'http://127.0.0.1:4003/' });
    expect(created.status).toBe(200);
    const onDisk = JSON.parse(await fs.readFile(webviewsPath(dataDir), 'utf-8'));
    expect(onDisk.map((w: { id: string }) => w.id)).toEqual(['valid-row', created.body.data.id]);
  });

  it('keeps a session row without a name as a session row, with a default name', async () => {
    const row = { ...valid, id: 'nameless', origin: { kind: 'session', sessionId: 'sess-1' } };
    await fs.writeFile(webviewsPath(dataDir), JSON.stringify([row]));
    const [read] = await listWebviews();
    expect(read.origin).toMatchObject({ kind: 'session', sessionId: 'sess-1' });
    expect(typeof (read.origin as { name: unknown }).name).toBe('string');
  });

  it('reads a stored trusted session row as untrusted', async () => {
    const row = {
      ...valid,
      id: 'trusted-session',
      trusted: true,
      origin: { kind: 'session', sessionId: 's', name: 'n' },
    };
    await fs.writeFile(webviewsPath(dataDir), JSON.stringify([row]));
    const [read] = await listWebviews();
    expect(read).toMatchObject({ trusted: false, origin: { kind: 'session', sessionId: 's', name: 'n' } });
  });
});
