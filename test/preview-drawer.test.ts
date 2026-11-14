import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const read = (name: string) => readFileSync(new URL(`../src/web/public/${name}`, import.meta.url), 'utf-8');
const CONSTANTS = read('constants.js');
const WEBVIEW_TABS = read('webview-tabs.js');
const SESSION_UI = read('session-ui.js');

// The drawer and both toggles exactly as index.html ships them.
const INDEX = new JSDOM(read('index.html')).window.document;
const DRAWER_HTML = INDEX.getElementById('previewDrawer')!.outerHTML;
const BUTTONS_HTML = [...INDEX.querySelectorAll('[data-preview-drawer-toggle]')].map((b) => b.outerHTML).join('');

interface Preview {
  webviewId: string;
  sessionId: string;
  name: string;
  cmd: string;
  port: number;
  state: 'running' | 'stopped' | 'exited';
}

interface Reply {
  status: number;
  body: unknown;
}

interface AppLike {
  sessions: Map<string, { id: string; name: string }>;
  activeSessionId: string | null;
  activeWebviewId: string | null;
  sessionPreviews: Map<string, Preview[]>;
  openPreviewDrawer(opener?: Element | null): Promise<void>;
  closePreviewDrawer(): void;
  togglePreviewDrawer(event?: unknown): void;
  _onWebviewChanged(data: unknown): Promise<void>;
  _previewDrawerOpen?: boolean;
  [key: string]: unknown;
}

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
const MIN = 60_000;

function preview(over: Partial<Preview> = {}): Preview {
  return {
    webviewId: 'wv-web',
    sessionId: 'sess-a',
    name: 'web',
    cmd: 'python3 -m http.server {port}',
    port: 5173,
    state: 'running',
    ...over,
  };
}

function boot(opts: { previews: Preview[]; createdAt?: Record<string, number> }) {
  const dom = new JSDOM(
    `<!doctype html><body><div class="app">
      <div id="sessionTabs"></div>
      <main class="main"><div id="webviewLayer"></div></main>
      <footer class="toolbar">${BUTTONS_HTML}</footer>
      ${DRAWER_HTML}
    </div></body>`,
    { url: 'http://localhost/', runScripts: 'outside-only' }
  );
  const win = dom.window as unknown as Window &
    typeof globalThis & { app: AppLike; CodemanApp: new () => AppLike; confirm: () => boolean };
  (win as unknown as { eval: (s: string) => void }).eval(
    ['window.CodemanApp = class CodemanApp {};', CONSTANTS, WEBVIEW_TABS, SESSION_UI].join('\n')
  );
  (win as unknown as { Date: { now: () => number } }).Date.now = () => NOW;

  const calls: string[] = [];
  const state = { previews: opts.previews.slice() };
  const createdAt = opts.createdAt || {};
  const answer = (method: string, path: string): Reply => {
    calls.push(`${method} ${path}`);
    if (method === 'GET' && path === '/api/previews')
      return { status: 200, body: { success: true, data: { previews: state.previews, leftRunning: [] } } };
    if (method === 'GET' && path === '/api/webviews') {
      const webviews = state.previews.map((p) => ({
        id: p.webviewId,
        name: p.name,
        url: `http://127.0.0.1:${p.port}/`,
        embedMode: 'proxy',
        trusted: false,
        origin: { kind: 'session', sessionId: p.sessionId, name: p.name },
        createdAt: createdAt[p.webviewId] ?? NOW - MIN,
      }));
      return { status: 200, body: { success: true, data: { webviews } } };
    }
    const one = /^\/api\/sessions\/([^/]+)\/previews\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && one) {
      const name = decodeURIComponent(one[2]);
      const sessionId = decodeURIComponent(one[1]);
      const gone = state.previews.find((p) => p.sessionId === sessionId && p.name === name);
      state.previews = state.previews.filter((p) => p !== gone);
      return { status: 200, body: { success: true, data: { name, webviewId: gone?.webviewId } } };
    }
    const list = /^\/api\/sessions\/([^/]+)\/previews$/.exec(path);
    if (method === 'GET' && list) {
      const previews = state.previews.filter((p) => p.sessionId === decodeURIComponent(list[1]));
      return { status: 200, body: { success: true, data: { previews, leftRunning: [] } } };
    }
    if (method === 'POST' && /^\/api\/webviews\/[^/]+\/open$/.test(path))
      return { status: 200, body: { success: true, data: { embedUrl: '/webview/cap/' } } };
    return { status: 404, body: { success: false, error: 'not found' } };
  };

  const app = new win.CodemanApp();
  app.sessions = new Map([
    ['sess-a', { id: 'sess-a', name: 'w1-shop' }],
    ['sess-b', { id: 'sess-b', name: 'w2-blog' }],
    ['sess-c', { id: 'sess-c', name: 'w3-docs' }],
  ]);
  app.activeSessionId = 'sess-a';
  app.activeWebviewId = null;
  app.webviews = new Map();
  app.webviewOrder = [];
  app.renderSessionTabs = () => {};
  app.renderWebviewMenuItems = () => {};
  app.hideWelcome = () => {};
  app.showToast = () => {};
  const selected: string[] = [];
  app.selectSession = async (id: string) => {
    selected.push(id);
    app.activeSessionId = id;
    app.activeWebviewId = null;
  };
  app._api = async (path: string, o: { method?: string } = {}) => {
    const reply = answer(o.method || 'GET', path);
    return { ok: reply.status < 300, status: reply.status, json: async () => reply.body };
  };
  app._apiJson = async (path: string, o: { method?: string } = {}) => {
    const reply = answer(o.method || 'GET', path);
    const body = reply.body as { success?: boolean; data?: unknown };
    return reply.status < 300 && body?.success ? body.data : null;
  };
  (win as unknown as { fetch: unknown }).fetch = async () => ({ status: 200 });
  (win as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = () => 0;
  (win as unknown as { CSS: unknown }).CSS = { escape: (v: string) => v };
  win.app = app;
  win.confirm = () => true;
  return { win, app, calls, state, selected };
}

const doc = (win: Window) => win.document;
const drawer = (win: Window) => doc(win).getElementById('previewDrawer') as HTMLElement;
const rows = (win: Window) => [...doc(win).querySelectorAll<HTMLElement>('#previewDrawerList .preview-drawer-row')];
const text = (row: HTMLElement, cls: string) => row.querySelector(`.${cls}`)?.textContent;
const key = (win: Window, k: string, shiftKey = false) =>
  doc(win).dispatchEvent(new win.KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true, cancelable: true }));

describe('previews drawer', () => {
  it('says nothing is running when there are no previews', async () => {
    const { win, app } = boot({ previews: [] });
    await app.openPreviewDrawer();
    expect(drawer(win).hidden).toBe(false);
    expect(rows(win)).toHaveLength(0);
    const empty = doc(win).getElementById('previewDrawerEmpty')!;
    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toContain('Nothing is running');
  });

  it('lists every preview with session, name, port, state and uptime, longest running first', async () => {
    const { win, app } = boot({
      previews: [
        preview({ webviewId: 'wv-1', sessionId: 'sess-a', name: 'web', port: 41001 }),
        preview({ webviewId: 'wv-2', sessionId: 'sess-b', name: 'api', port: 41002 }),
        preview({ webviewId: 'wv-3', sessionId: 'sess-c', name: 'site', port: 41003, state: 'stopped' }),
      ],
      createdAt: { 'wv-1': NOW - 5 * MIN, 'wv-2': NOW - 90 * MIN, 'wv-3': NOW - 30_000 },
    });
    await app.openPreviewDrawer();
    const list = rows(win);
    expect(list.map((r) => text(r, 'preview-drawer-name'))).toEqual(['api', 'web', 'site']);
    const [api, web, site] = list;
    expect(text(api, 'preview-drawer-session')).toBe('w2-blog');
    expect(text(api, 'preview-drawer-port')).toBe(':41002');
    expect(text(api, 'preview-drawer-state')).toBe('running');
    expect(text(api, 'preview-drawer-uptime')).toBe('1h 30m');
    expect(text(web, 'preview-drawer-uptime')).toBe('5m');
    expect(text(site, 'preview-drawer-state')).toBe('stopped');
    expect(text(site, 'preview-drawer-uptime')).toBe('');
    expect(api.querySelector('.preview-drawer-delete')?.textContent).toBe('Delete');
    const count = doc(win).querySelector('#previewsBtn .preview-drawer-count') as HTMLElement;
    expect(count.textContent).toBe('2');
    expect(count.hidden).toBe(false);
  });

  it('Delete stops the preview through the API and removes its row', async () => {
    const { win, app, calls } = boot({
      previews: [
        preview({ webviewId: 'wv-1', sessionId: 'sess-a', name: 'web' }),
        preview({ webviewId: 'wv-2', sessionId: 'sess-b', name: 'api' }),
      ],
      createdAt: { 'wv-1': NOW - 2 * MIN, 'wv-2': NOW - MIN },
    });
    await app.openPreviewDrawer();
    rows(win)[0].querySelector<HTMLButtonElement>('.preview-drawer-delete')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toContain('DELETE /api/sessions/sess-a/previews/web');
    expect(rows(win).map((r) => text(r, 'preview-drawer-name'))).toEqual(['api']);
    expect(doc(win).activeElement?.closest('.preview-drawer-row')?.getAttribute('data-webview-id')).toBe('wv-2');
  });

  it('opening a row closes the drawer and shows that session’s Preview view', async () => {
    const { win, app, selected } = boot({
      previews: [preview({ webviewId: 'wv-2', sessionId: 'sess-b', name: 'api' })],
    });
    await app.openPreviewDrawer();
    rows(win)[0].querySelector<HTMLButtonElement>('.preview-drawer-open')!.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(drawer(win).hidden).toBe(true);
    expect(selected).toEqual(['sess-b']);
    expect(app.activeSessionId).toBe('sess-b');
    const on = doc(win).querySelector('#previewSwitch .preview-switch-option.on') as HTMLElement;
    expect(on?.dataset.webviewId).toBe('wv-2');
    expect(doc(win).querySelector('.main')!.classList.contains('preview-active')).toBe(true);
  });

  it('adds a row on webview:changed while open, without a reopen', async () => {
    const { win, app, state } = boot({ previews: [preview({ webviewId: 'wv-1', name: 'web' })] });
    await app.openPreviewDrawer();
    expect(rows(win)).toHaveLength(1);
    state.previews.push(preview({ webviewId: 'wv-9', sessionId: 'sess-c', name: 'new', port: 41009 }));
    await app._onWebviewChanged({ id: 'wv-9', action: 'created' });
    expect(rows(win).map((r) => text(r, 'preview-drawer-name'))).toEqual(['web', 'new']);
    expect(drawer(win).hidden).toBe(false);
  });

  it('closes on Escape and gives focus back to the button that opened it', async () => {
    const { win, app } = boot({ previews: [preview()] });
    const button = doc(win).getElementById('previewsBtn') as HTMLButtonElement;
    button.focus();
    await app.openPreviewDrawer(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(doc(win).activeElement?.classList.contains('preview-drawer-open')).toBe(true);
    key(win, 'Escape');
    expect(drawer(win).hidden).toBe(true);
    expect(doc(win).activeElement).toBe(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps Tab inside the sheet while it is open', async () => {
    const { win, app } = boot({ previews: [preview()] });
    await app.openPreviewDrawer();
    const del = rows(win)[0].querySelector<HTMLButtonElement>('.preview-drawer-delete')!;
    del.focus();
    key(win, 'Tab');
    expect(doc(win).activeElement?.id).toBe('previewDrawerClose');
    key(win, 'Tab', true);
    expect(doc(win).activeElement).toBe(del);
  });
});
