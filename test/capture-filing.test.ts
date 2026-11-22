/**
 * @fileoverview Ambient capture, ticket 4: filing and outbox (src/web/public/capture-filing.js).
 *
 * The module is loaded into a stand-in window and its filing service is driven against a real
 * WebServer through `app.inject()`: the fetch it is given calls the server, and a test can make that
 * fetch fail (a server that is down) or answer 500 once (a failed upload).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebServer } from '../src/web/server.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { MAX_WORK_FILE_BYTES } from '../src/canvas/work-files.js';
import { png } from './canvas-media-fixtures.js';

type Facts = { page?: string | null; session?: string | null };
type Lookup = (rule: string, value: string | null) => Promise<{ workspaceId?: string; skip?: boolean }>;
type Record_ = { requestId: string; attempts: number; workspaceId: string | null; key: string | null };
type Store = {
  durable: boolean;
  all: () => Promise<Record_[]>;
  put: (r: Record_) => Promise<void>;
  remove: (id: string) => Promise<void>;
};
type Service = {
  send: (p: { bundle: unknown; note: string; facts: Record<string, unknown> }) => Promise<string>;
  drain: () => Promise<void>;
  retry: () => Promise<void>;
  pending: () => Promise<number>;
};
type Filing = {
  create: (deps: Record<string, unknown>) => Service;
  pure: {
    resolveWorkspace: (facts: Facts, lookup: Lookup) => Promise<{ rule: string; workspaceId: string } | null>;
    describeCapture: (i: { note: string; facts: Record<string, unknown>; source: string }) => {
      title: string;
      description: string;
    };
    createBody: (r: Record<string, unknown>) => Record<string, unknown>;
    missingFiles: (item: unknown, names: string[]) => string[];
    backoffMs: (attempts: number) => number;
    pageWorkspace: (doc: unknown, path: string) => string | null;
    MAX_FILE_BYTES: number;
    STATUS: string;
  };
};

const filing: Filing = (() => {
  const win: Record<string, unknown> = { crypto: globalThis.crypto };
  new Function('window', readFileSync('src/web/public/capture-filing.js', 'utf8'))(win);
  return win.CodemanCaptureFiling as Filing;
})();

describe('the pure half', () => {
  // Invariant I7: TheWorkspaceIsTheOneOnScreen
  it('picks page, then session, then home, skipping a rule the person may not write', async () => {
    const answers: Record<string, { workspaceId?: string; skip?: boolean }> = {
      page: { workspaceId: 'ws-page' },
      session: { workspaceId: 'ws-session' },
      home: { workspaceId: 'ws-home' },
    };
    const asked: string[] = [];
    const lookup: Lookup = async (rule) => {
      asked.push(rule);
      return answers[rule];
    };
    const r = filing.pure.resolveWorkspace;
    expect(await r({ page: 'p', session: 'case' }, lookup)).toEqual({ rule: 'page', workspaceId: 'ws-page' });
    expect(await r({ page: null, session: 'case' }, lookup)).toEqual({ rule: 'session', workspaceId: 'ws-session' });
    expect(await r({}, lookup)).toEqual({ rule: 'home', workspaceId: 'ws-home' });
    answers.page = { skip: true };
    expect(await r({ page: 'p', session: 'case' }, lookup)).toEqual({ rule: 'session', workspaceId: 'ws-session' });
    answers.session = { skip: true };
    expect(await r({ page: 'p', session: 'case' }, lookup)).toEqual({ rule: 'home', workspaceId: 'ws-home' });
    answers.home = { skip: true };
    expect(await r({ page: 'p', session: 'case' }, lookup)).toBeNull();
    answers.page = { workspaceId: '../etc' };
    expect(await r({ page: 'p' }, lookup)).toBeNull();
    asked.length = 0;
    const offline: Lookup = async () => {
      throw new Error('offline');
    };
    await expect(r({ page: 'p' }, offline)).rejects.toThrow('offline');
  });

  it('reads the canvas page`s workspace from its meta tag or its address, and nothing on the dashboard', () => {
    const doc = (content: string) => ({ querySelector: () => (content ? { content } : null) });
    expect(filing.pure.pageWorkspace(doc('ws-1'), '/')).toBe('ws-1');
    expect(filing.pure.pageWorkspace(doc(''), '/base/canvas/ws-2')).toBe('ws-2');
    expect(filing.pure.pageWorkspace(doc(''), '/')).toBeNull();
    expect(filing.pure.pageWorkspace(doc(''), '/session/abc')).toBeNull();
  });

  // Invariant I6: CapturesLandInNeedsRefinement
  it('always sends status needs-refinement with the requestId', () => {
    expect(filing.pure.STATUS).toBe('needs-refinement');
    expect(filing.pure.createBody({ requestId: 'r', title: 't', description: 'd', extra: 1 })).toEqual({
      requestId: 'r',
      status: 'needs-refinement',
      title: 't',
      description: 'd',
    });
  });

  it('titles the item with the note`s first line, or the page title, and adds the facts line', () => {
    const facts = { path: '/session/x', title: 'Codeman', build: 'abcdef0123456789' };
    expect(filing.pure.describeCapture({ note: '\n  Broken button \nmore', facts, source: 'dom' })).toEqual({
      title: 'Broken button',
      description: 'Broken button \nmore\n\nCaptured on /session/x, build abcdef012345',
    });
    expect(filing.pure.describeCapture({ note: '  ', facts, source: 'dom' })).toEqual({
      title: 'Capture: Codeman',
      description: 'Captured on /session/x, build abcdef012345',
    });
    expect(filing.pure.describeCapture({ note: 'x'.repeat(300), facts, source: 'dom' }).title).toHaveLength(200);
    // Invariant I9: PhoneContextIsLabelled (the filing half's description)
    expect(filing.pure.describeCapture({ note: 'From the phone', facts, source: 'image' }).description).toBe(
      'From the phone\n\nWhere capture was opened: /session/x'
    );
  });

  it('skips names already attached and backs off from 2 s to 5 min', () => {
    const item = { attachments: [{ name: 'clean.png' }, { kind: 'object', id: 'o', name: 'marked-crop.png' }] };
    expect(filing.pure.missingFiles(item, ['clean.png', 'marked-crop.png'])).toEqual(['marked-crop.png']);
    expect([1, 2, 3, 20].map(filing.pure.backoffMs)).toEqual([2000, 4000, 8000, 300000]);
  });

  it('uses the Work file cap the server enforces', () => {
    expect(filing.pure.MAX_FILE_BYTES).toBe(MAX_WORK_FILE_BYTES);
  });
});

describe('filing against the server', () => {
  let server: WebServer;
  let ws: string;
  let inject: (o: { method: string; url: string; payload?: unknown; headers?: Record<string, string> }) => Promise<{
    statusCode: number;
    json: () => { success: boolean; data?: Record<string, unknown>; reason?: string };
  }>;
  const log: Array<{ method: string; url: string }> = [];
  let down = false;
  let failOnce: ((method: string, url: string) => boolean) | null = null;
  let stopAfterCreate = false;

  const fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
    const method = init.method ?? 'GET';
    if (down) throw new TypeError('Failed to fetch');
    log.push({ method, url });
    if (failOnce?.(method, url)) {
      failOnce = null;
      return { status: 500, ok: false, json: async () => ({ success: false, error: 'disk full' }) };
    }
    const payload = init.body instanceof Blob ? Buffer.from(await init.body.arrayBuffer()) : init.body;
    const r = await inject({ method, url, payload, headers: init.headers });
    if (stopAfterCreate && method === 'POST' && url.endsWith('/work')) down = true;
    return { status: r.statusCode, ok: r.statusCode < 300, json: async () => r.json() };
  };

  function memory(): Store {
    const map = new Map<string, Record_>();
    return {
      durable: true,
      all: async () => [...map.values()],
      put: async (r) => void map.set(r.requestId, r),
      remove: async (id) => void map.delete(id),
    };
  }

  function service(store: Store, facts: Facts, events: unknown[] = []): Service {
    return filing.create({
      fetch,
      store,
      setTimer: () => 0,
      notify: (e: unknown) => events.push(e),
      facts: () => facts,
    });
  }

  const bundle = () => ({
    json: { version: 1, source: 'dom', path: [[1, 1]], workspaceRule: null },
    files: [
      { name: 'clean.png', blob: new Blob([png(4, 3)], { type: 'image/png' }) },
      { name: 'marked-crop.png', blob: new Blob([png(2, 2)], { type: 'image/png' }) },
      { name: 'marked-wide.png', blob: new Blob([png(4, 3, [200, 0, 0])], { type: 'image/png' }) },
      { name: 'capture.json', blob: new Blob(['{}'], { type: 'application/json' }) },
    ],
  });
  const facts = { path: '/', title: 'Codeman', sessionId: 's1' };

  const items = async () =>
    (await inject({ method: 'GET', url: `/api/canvas/${ws}/work` })).json().data?.items as Array<{
      key: string;
      status: string;
      title: string;
      attachments?: Array<{ name: string; id: string }>;
    }>;
  const until = async (svc: Service) => {
    await new Promise((r) => setTimeout(r, 0));
    await svc.drain();
  };

  beforeAll(async () => {
    mkdirSync(resolve(resolveCasesDir(), 'capture-case'), { recursive: true });
    server = new WebServer(0, false, true);
    await server.start();
    ws = workspaceForCase('capture-case').id;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inject = (server as any).app.inject.bind((server as any).app);
  }, 60000);
  afterAll(async () => {
    await server?.stop();
  }, 60000);
  beforeEach(() => {
    down = false;
    failOnce = null;
    stopAfterCreate = false;
    log.length = 0;
  });

  // Invariant I6: CapturesLandInNeedsRefinement
  // Invariant I5: FilingIsRetrySafe
  it('files one item in Needs refinement in the shown session`s case with its four files', async () => {
    const events: Array<{ kind: string; key?: string }> = [];
    const store = memory();
    const svc = service(store, { page: null, session: 'capture-case' }, events);
    await svc.send({ bundle: bundle(), note: 'Toast overlaps the tab\nsecond line', facts });
    await until(svc);
    const filed = (await items()).find((i) => i.title === 'Toast overlaps the tab');
    expect(filed?.status).toBe('needs-refinement');
    expect(filed?.attachments?.map((a) => a.name).sort()).toEqual([
      'capture.json',
      'clean.png',
      'marked-crop.png',
      'marked-wide.png',
    ]);
    const json = filed!.attachments!.find((a) => a.name === 'capture.json')!;
    const raw = await inject({ method: 'GET', url: `/api/canvas/${ws}/work/${filed!.key}/attachments/${json.id}` });
    expect(JSON.parse((raw as unknown as { payload: string }).payload).workspaceRule).toBe('session');
    expect(await store.all()).toEqual([]);
    expect(events).toContainEqual({ kind: 'filed', key: filed!.key, workspaceId: ws });
  });

  // Invariant I5: FilingIsRetrySafe
  it('adds only what is missing when an upload fails, and never a second item', async () => {
    const store = memory();
    const svc = service(store, { session: 'capture-case' });
    let uploads = 0;
    failOnce = (method, url) => method === 'POST' && url.includes('/attachments') && ++uploads === 2;
    await svc.send({ bundle: bundle(), note: 'Retry me', facts });
    await until(svc);
    const [kept] = await store.all();
    expect(kept.attempts).toBe(1);
    expect(kept.key).toMatch(/^W-\d+$/);
    await svc.retry();
    await svc.retry();
    const mine = (await items()).filter((i) => i.title === 'Retry me');
    expect(mine).toHaveLength(1);
    const names = mine[0].attachments!.map((a) => a.name);
    expect(names.sort()).toEqual(['capture.json', 'clean.png', 'marked-crop.png', 'marked-wide.png']);
    expect(await store.all()).toEqual([]);
  });

  // Invariant I5: FilingIsRetrySafe (the create half)
  it('returns the same item when the create is replayed after success', async () => {
    const payload = { requestId: crypto.randomUUID(), status: 'needs-refinement', title: 'Replay' };
    const first = await inject({ method: 'POST', url: `/api/canvas/${ws}/work`, payload });
    const again = await inject({ method: 'POST', url: `/api/canvas/${ws}/work`, payload });
    expect((again.json().data?.item as { key: string }).key).toBe((first.json().data?.item as { key: string }).key);
    expect(again.json().data?.duplicate).toBe(true);
  });

  // Acceptance check 7: the outbox survives a server stop between Send and the first attachment.
  it('keeps a capture through a server that stops after the create, and files it once on return', async () => {
    const store = memory();
    const svc = service(store, { session: 'capture-case' });
    const before = (await items()).length;
    stopAfterCreate = true;
    await svc.send({ bundle: bundle(), note: 'Survives a stop', facts });
    await until(svc);
    expect(down).toBe(true);
    expect((await store.all())[0]).toMatchObject({ attempts: 1, key: expect.stringMatching(/^W-\d+$/) });
    stopAfterCreate = false;
    down = false;
    await svc.retry();
    const mine = (await items()).filter((i) => i.title === 'Survives a stop');
    expect(mine).toHaveLength(1);
    expect(mine[0].attachments).toHaveLength(4);
    expect((await items()).length).toBe(before + 1);
    expect(await store.all()).toEqual([]);
  });

  it('keeps a capture sent while the server is down and resolves its workspace on return', async () => {
    const store = memory();
    const events: Array<{ kind: string }> = [];
    const svc = service(store, { session: 'capture-case' }, events);
    down = true;
    await svc.send({ bundle: bundle(), note: 'Sent offline', facts });
    await until(svc);
    expect((await store.all())[0]).toMatchObject({ workspaceId: null, key: null, attempts: 1 });
    expect(events.map((e) => e.kind)).toContain('queued');
    down = false;
    await svc.retry();
    expect((await items()).filter((i) => i.title === 'Sent offline')[0]?.attachments).toHaveLength(4);
  });

  // Invariant I7: TheWorkspaceIsTheOneOnScreen (refusal) and I4: OnlyAPersonFiles
  it('refuses Send with no workspace rule and files nothing', async () => {
    const store = memory();
    const svc = service(store, { page: 'not-mine', session: 'no-such-case' });
    await expect(svc.send({ bundle: bundle(), note: 'Nowhere', facts })).rejects.toThrow(/No canvas workspace/);
    expect(await store.all()).toEqual([]);
    expect(log.filter((r) => r.method === 'POST' && r.url.endsWith('/work'))).toEqual([]);
  });

  // Invariant I4: OnlyAPersonFiles
  it('creates nothing from an empty outbox, however often it drains', async () => {
    const svc = service(memory(), { session: 'capture-case' });
    await svc.drain();
    await svc.retry();
    expect(log.filter((r) => r.method === 'POST')).toEqual([]);
  });

  it('prefers the page`s workspace over the session`s', async () => {
    const other = workspaceForCase('capture-case').id;
    const svc = service(memory(), { page: other, session: 'no-such-case' });
    await svc.send({ bundle: bundle(), note: 'From the canvas page', facts });
    await until(svc);
    expect((await items()).some((i) => i.title === 'From the canvas page')).toBe(true);
  });

  it('keeps the home-case route off the versioned alias', async () => {
    const internal = await inject({ method: 'GET', url: '/api/capture/home-case' });
    expect([200, 404]).toContain(internal.statusCode);
    if (internal.statusCode === 404) expect(internal.json().reason).toBe('NO_HOME_CASE');
    const versioned = await inject({ method: 'GET', url: '/api/v1/capture/home-case' });
    expect(versioned.statusCode).toBe(404);
    expect(versioned.json().reason).toBeUndefined();
  });

  it('stores nothing in a case folder', () => {
    expect(readdirSync(resolve(resolveCasesDir(), 'capture-case'))).toEqual([]);
  });
});
