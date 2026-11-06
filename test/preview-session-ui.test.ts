/**
 * @fileoverview Session previews in the browser: the badge on the session tab, the
 * Terminal / Preview switch, the frame, Delete and the stopped card
 * (session-ui.js + webview-tabs.js).
 *
 * Builds a JSDOM window in-test under the default node env, like
 * test/webview-menu-rows.test.ts, and evaluates the real frontend files into it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const read = (name: string) => readFileSync(new URL(`../src/web/public/${name}`, import.meta.url), 'utf-8');
const CONSTANTS = read('constants.js');
const WEBVIEW_TABS = read('webview-tabs.js');
const SESSION_UI = read('session-ui.js');

interface Preview {
  webviewId: string;
  sessionId: string;
  name: string;
  cmd: string;
  port: number;
  state: 'running' | 'stopped' | 'exited';
  stillListening?: { port: number; pids: number[] };
}

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

interface Reply {
  status: number;
  body: unknown;
}

interface AppLike {
  sessions: Map<string, { id: string; name: string }>;
  activeSessionId: string | null;
  activeWebviewId: string | null;
  webviews: Map<string, unknown>;
  sessionWebviews: Map<string, unknown>;
  webviewOrder: string[];
  sessionPreviews: Map<string, Preview[]>;
  refreshWebviews(): Promise<void>;
  refreshSessionPreviews(): Promise<void>;
  showSessionPreview(sessionId: string, webviewId: string): Promise<void>;
  showSessionTerminal(sessionId: string): void;
  deleteSessionPreview(sessionId: string, name: string): Promise<void>;
  restartSessionPreview(sessionId: string, name: string): Promise<void>;
  _syncSessionPreviewView(): void;
  _onSessionSelectedForPreviews(sessionId: string): void;
  [key: string]: unknown;
}

const SESSION_A = 'sess-a';
const SESSION_B = 'sess-b';

function preview(over: Partial<Preview> = {}): Preview {
  return {
    webviewId: 'wv-web',
    sessionId: SESSION_B,
    name: 'web',
    cmd: 'python3 -m http.server {port}',
    port: 5173,
    state: 'running',
    ...over,
  };
}

function sessionWebview(p: Preview) {
  return {
    id: p.webviewId,
    name: p.name,
    url: `http://127.0.0.1:${p.port}/`,
    embedMode: 'proxy',
    trusted: false,
    origin: { kind: 'session', sessionId: p.sessionId, name: p.name },
  };
}

/**
 * `previews` is the server's list; `routes` answers anything else by
 * `${method} ${path}`. `upstream` is the status the proxy gives a probe.
 */
function boot(opts: { previews: Preview[]; routes?: Record<string, Reply>; upstream?: number; active?: string }) {
  const dom = new JSDOM(
    `<!doctype html><body><div class="app">
      <div id="sessionTabs">
        <div class="session-tab" data-id="${SESSION_A}"><span class="tab-name">a</span><span class="tab-actions"></span></div>
        <div class="session-tab" data-id="${SESSION_B}"><span class="tab-name">b</span><span class="tab-actions"></span></div>
      </div>
      <main class="main"><div class="terminal-wrap"></div><div id="webviewLayer"></div></main>
    </div></body>`,
    { url: 'http://localhost/', runScripts: 'outside-only' }
  );
  const win = dom.window as unknown as Window &
    typeof globalThis & { app: AppLike; CodemanApp: new () => AppLike; confirm: () => boolean };
  (win as unknown as { eval: (s: string) => void }).eval(
    ['window.CodemanApp = class CodemanApp {};', CONSTANTS, WEBVIEW_TABS, SESSION_UI].join('\n')
  );

  const calls: Call[] = [];
  const toasts: { message: string; type: string }[] = [];
  const state = { previews: opts.previews.slice() };
  const routes = opts.routes || {};
  const answer = (method: string, path: string, body?: unknown): Reply => {
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    if (routes[key]) return routes[key];
    if (key === 'GET /api/previews')
      return { status: 200, body: { success: true, data: { previews: state.previews } } };
    if (key === 'GET /api/webviews') {
      const user = { id: 'wv-user', name: 'Grafana', url: 'http://x/', origin: { kind: 'user' } };
      return {
        status: 200,
        body: { success: true, data: { webviews: [user, ...state.previews.map(sessionWebview)] } },
      };
    }
    const sessionList = /^\/api\/sessions\/([^/]+)\/previews$/.exec(path);
    if (method === 'GET' && sessionList) {
      const previews = state.previews.filter((p) => p.sessionId === decodeURIComponent(sessionList[1]));
      return { status: 200, body: { success: true, data: { previews, leftRunning: [] } } };
    }
    const open = /^\/api\/webviews\/([^/]+)\/open$/.exec(path);
    if (method === 'POST' && open) {
      return { status: 200, body: { success: true, data: { embedUrl: `/webview/cap-${open[1]}/` } } };
    }
    return { status: 404, body: { success: false, error: 'not found' } };
  };
  const response = (reply: Reply) => ({
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    json: async () => reply.body,
  });

  const app = new win.CodemanApp();
  app.sessions = new Map([
    [SESSION_A, { id: SESSION_A, name: 'a' }],
    [SESSION_B, { id: SESSION_B, name: 'b' }],
  ]);
  app.activeSessionId = opts.active ?? SESSION_A;
  app.activeWebviewId = null;
  app.webviews = new Map();
  app.webviewOrder = [];
  app.renderSessionTabs = () => {};
  app.renderWebviewMenuItems = () => {};
  app.hideWelcome = () => {};
  app.showToast = (message: string, type: string) => toasts.push({ message, type });
  app._api = async (path: string, o: { method?: string; body?: unknown } = {}) =>
    response(answer(o.method || 'GET', path, o.body));
  app._apiJson = async (path: string, o: { method?: string; body?: unknown } = {}) => {
    const reply = answer(o.method || 'GET', path, o.body);
    const body = reply.body as { success?: boolean; data?: unknown };
    return reply.status < 300 && body?.success ? body.data : null;
  };
  (win as unknown as { fetch: unknown }).fetch = async (url: string) => {
    calls.push({ method: 'PROBE', path: url });
    return { status: opts.upstream ?? 200 };
  };
  (win as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = () => 0;
  (win as unknown as { CSS: unknown }).CSS = { escape: (v: string) => v.replace(/["\\]/g, '\\$&') };
  win.app = app;
  win.confirm = () => true;
  return { win, app, calls, toasts, state };
}

const doc = (win: Window) => win.document;
const badge = (win: Window, sessionId: string) =>
  doc(win).querySelector(`.session-tab[data-id="${sessionId}"] .tab-preview-badge`);
const bar = (win: Window) => doc(win).getElementById('previewSwitch') as HTMLElement;
const options = (win: Window) =>
  [...doc(win).querySelectorAll<HTMLButtonElement>('#previewSwitch .preview-switch-option')].map((b) =>
    b.textContent?.trim()
  );
const main = (win: Window) => doc(win).querySelector('.main')!;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('session previews in the tab strip', () => {
  it('keeps session-origin records out of the web tab list', async () => {
    const { app } = boot({ previews: [preview()] });
    await app.refreshWebviews();
    expect([...app.webviews.keys()]).toEqual(['wv-user']);
    expect([...app.sessionWebviews.keys()]).toEqual(['wv-web']);
  });

  it('badges the owning tab of an unopened preview and changes nothing else', async () => {
    const { win, app } = boot({ previews: [preview()] });
    await app.refreshSessionPreviews();
    expect(badge(win, SESSION_B)?.textContent).toBe('1');
    expect(badge(win, SESSION_A)).toBeNull();
    expect(app.activeSessionId).toBe(SESSION_A);
    expect(bar(win).hidden).toBe(true);
    expect(main(win).classList.contains('webview-active')).toBe(false);
    expect(doc(win).querySelectorAll('#webviewLayer > *')).toHaveLength(0);
  });

  it('clears the badge once the preview is opened, and keeps it cleared after a reload', async () => {
    const { win, app } = boot({ previews: [preview()], active: SESSION_B });
    await app.refreshSessionPreviews();
    expect(badge(win, SESSION_B)?.textContent).toBe('1');
    await app.showSessionPreview(SESSION_B, 'wv-web');
    expect(badge(win, SESSION_B)).toBeNull();

    const stored = win.localStorage.getItem('codeman-seen-previews');
    const again = boot({ previews: [preview()] });
    again.win.localStorage.setItem('codeman-seen-previews', stored!);
    await again.app.refreshSessionPreviews();
    expect(badge(again.win, SESSION_B)).toBeNull();
  });
});

describe('the Terminal / Preview switch', () => {
  it('renders for the active session only, with one option per preview', async () => {
    const { win, app } = boot({
      previews: [preview(), preview({ webviewId: 'wv-docs', name: 'docs', port: 6006 })],
      active: SESSION_B,
    });
    await app.refreshSessionPreviews();
    expect(bar(win).hidden).toBe(false);
    expect(options(win)).toEqual(['Terminal', 'docs', 'web']);

    app.activeSessionId = SESSION_A;
    app._syncSessionPreviewView();
    expect(bar(win).hidden).toBe(true);
  });

  it('labels a lone preview "Preview: <name>" and shows its port and Delete once selected', async () => {
    const { win, app } = boot({ previews: [preview()], active: SESSION_B });
    await app.refreshSessionPreviews();
    expect(options(win)).toEqual(['Terminal', 'Preview: web']);
    expect(doc(win).querySelector('.preview-switch-delete')).toBeNull();
    await app.showSessionPreview(SESSION_B, 'wv-web');
    expect(doc(win).querySelector('.preview-switch-port')?.textContent).toBe(':5173');
    expect(doc(win).querySelector('.preview-switch-delete')?.textContent).toBe('Delete');
  });

  it('mounts the frame in #webviewLayer with the web tab sandbox and keeps it across switches', async () => {
    const { win, app, calls } = boot({ previews: [preview()], active: SESSION_B });
    await app.refreshWebviews();
    await app.refreshSessionPreviews();
    await app.showSessionPreview(SESSION_B, 'wv-web');
    await flush();

    const frame = doc(win).querySelector<HTMLIFrameElement>('#webviewLayer .webview-frame.active iframe')!;
    expect(frame.getAttribute('src')).toBe('/webview/cap-wv-web/');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-popups allow-downloads allow-modals');
    expect(main(win).classList.contains('preview-active')).toBe(true);

    app.showSessionTerminal(SESSION_B);
    expect(main(win).classList.contains('webview-active')).toBe(false);
    await app.showSessionPreview(SESSION_B, 'wv-web');
    await flush();
    expect(doc(win).querySelector('#webviewLayer .webview-frame.active iframe')).toBe(frame);
    expect(calls.filter((c) => c.path === '/api/webviews/wv-web/open')).toHaveLength(1);
  });

  it('brings back the stored Preview view when the session is selected again', async () => {
    const { win, app } = boot({ previews: [preview()], active: SESSION_B });
    await app.refreshWebviews();
    await app.refreshSessionPreviews();
    await app.showSessionPreview(SESSION_B, 'wv-web');
    app.activeSessionId = SESSION_A;
    app._onSessionSelectedForPreviews(SESSION_A);
    expect(main(win).classList.contains('preview-active')).toBe(false);
    app.activeSessionId = SESSION_B;
    app._onSessionSelectedForPreviews(SESSION_B);
    expect(main(win).classList.contains('preview-active')).toBe(true);
  });
});

describe('Delete', () => {
  it('calls the preview DELETE route and removes the switch', async () => {
    const { win, app, calls, state } = boot({
      previews: [preview()],
      active: SESSION_B,
      routes: {
        'DELETE /api/sessions/sess-b/previews/web': { status: 200, body: { success: true, data: { name: 'web' } } },
      },
    });
    await app.refreshSessionPreviews();
    await app.showSessionPreview(SESSION_B, 'wv-web');
    state.previews = [];
    await app.deleteSessionPreview(SESSION_B, 'web');
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/sessions/sess-b/previews/web')).toBe(true);
    expect(bar(win).hidden).toBe(true);
    expect(main(win).classList.contains('webview-active')).toBe(false);
  });

  it('says so when the server refuses with 409 and keeps the preview', async () => {
    const { win, app, toasts } = boot({
      previews: [preview()],
      active: SESSION_B,
      routes: {
        'DELETE /api/sessions/sess-b/previews/web': {
          status: 409,
          body: { success: false, error: 'This server is the standby deploy colour', errorCode: 'CONFLICT' },
        },
      },
    });
    await app.refreshSessionPreviews();
    await app.deleteSessionPreview(SESSION_B, 'web');
    expect(toasts).toEqual([
      { message: 'web was not deleted: This server is the standby deploy colour', type: 'error' },
    ]);
    expect(options(win)).toEqual(['Terminal', 'Preview: web']);
  });

  it('warns when the stop was deferred or a server was left running', async () => {
    const deferred = boot({
      previews: [preview()],
      routes: {
        'DELETE /api/sessions/sess-b/previews/web': {
          status: 200,
          body: { success: true, data: { name: 'web', previewStop: 'deferred' } },
        },
      },
    });
    await deferred.app.refreshSessionPreviews();
    await deferred.app.deleteSessionPreview(SESSION_B, 'web');
    expect(deferred.toasts[0].type).toBe('warning');
    expect(deferred.toasts[0].message).toContain('may not stop its server');

    const left = boot({
      previews: [preview()],
      routes: {
        'DELETE /api/sessions/sess-b/previews/web': {
          status: 200,
          body: { success: true, data: { name: 'web', leftRunning: { port: 5173, pids: [42] } } },
        },
      },
    });
    await left.app.refreshSessionPreviews();
    await left.app.deleteSessionPreview(SESSION_B, 'web');
    expect(left.toasts[0].type).toBe('warning');
    expect(left.toasts[0].message).toContain('still listens on :5173');
  });
});

describe('the stopped card', () => {
  it('shows a stopped preview as a card with its state and a Restart that re-PUTs its own cmd', async () => {
    const stopped = preview({ state: 'stopped' });
    const { win, app, calls } = boot({
      previews: [stopped],
      active: SESSION_B,
      routes: {
        'PUT /api/sessions/sess-b/previews/web': { status: 200, body: { success: true, data: { name: 'web' } } },
      },
    });
    await app.refreshSessionPreviews();
    await app.showSessionPreview(SESSION_B, 'wv-web');

    const card = doc(win).querySelector('#webviewLayer .preview-card')!;
    expect(card.querySelector('h3')?.textContent).toBe('web is stopped');
    expect(card.querySelector('.preview-card-cmd')?.textContent).toBe('python3 -m http.server {port}');
    expect(doc(win).querySelector('#webviewLayer iframe')).toBeNull();

    (card.querySelector('.preview-card-restart') as HTMLButtonElement).click();
    await flush();
    expect(calls.find((c) => c.method === 'PUT')).toEqual({
      method: 'PUT',
      path: '/api/sessions/sess-b/previews/web',
      body: { cmd: 'python3 -m http.server {port}' },
    });
  });

  it('says a server outside Codeman still listens and offers no Stop', async () => {
    const exited = preview({ state: 'exited', stillListening: { port: 5173, pids: [4242] } });
    const { win, app } = boot({ previews: [exited], active: SESSION_B });
    await app.refreshSessionPreviews();
    await app.showSessionPreview(SESSION_B, 'wv-web');
    const card = doc(win).querySelector('#webviewLayer .preview-card')!;
    expect(card.querySelector('h3')?.textContent).toBe('web exited');
    expect(card.querySelector('.preview-card-listening')?.textContent).toContain(
      'still listening on :5173 (pid 4242), outside Codeman'
    );
    expect(card.querySelector('.preview-card-listening')?.textContent).toContain('cannot stop it from here');
    const labels = [...card.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toEqual(['Restart', 'Delete']);
  });

  it('shows the card for a running preview whose proxy answers 502', async () => {
    const { win, app } = boot({ previews: [preview()], active: SESSION_B, upstream: 502 });
    await app.refreshWebviews();
    await app.refreshSessionPreviews();
    await app.showSessionPreview(SESSION_B, 'wv-web');
    const card = doc(win).querySelector('#webviewLayer .preview-card');
    expect(card?.querySelector('h3')?.textContent).toBe('web is not answering');
    expect(doc(win).querySelector('#webviewLayer .webview-frame.active')).toBeNull();
  });
});
