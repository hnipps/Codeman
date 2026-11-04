import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const constants = readFileSync('src/web/public/constants.js', 'utf8');
const source = readFileSync('src/web/public/app.js', 'utf8');
const html = readFileSync('src/web/public/index.html', 'utf8');

function harness() {
  const dom = new JSDOM(html);
  // Instantiate only the prototype under test, not the dashboard boot listener.
  dom.window.document.addEventListener = vi.fn();
  const fetch = vi.fn();
  const context = vm.createContext({
    console,
    performance,
    document: dom.window.document,
    NodeFilter: dom.window.NodeFilter,
    AbortController,
    fetch,
    setTimeout,
    clearTimeout,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    requestAnimationFrame: vi.fn(),
    HTMLCanvasElement: class {},
    localStorage: { length: 0, getItem: vi.fn() },
    window: { addEventListener: vi.fn() },
    MobileDetection: {},
  });
  vm.runInContext(`${constants}\n${source}\nglobalThis.testApp = Object.create(CodemanApp.prototype);`, context);
  const app = context.testApp;
  app.activeSessionId = 'claude-1';
  app.sessions = new Map([
    ['claude-1', { mode: 'claude' }],
    ['codex-1', { mode: 'codex' }],
    ['remote-claude', { mode: 'claude', remote: {} }],
    ['docker-claude', { mode: 'claude', docker: {} }],
  ]);
  const body = dom.window.document.getElementById('chatViewBody')!;
  Object.defineProperties(body, {
    clientHeight: { value: 200, configurable: true },
    scrollHeight: { get: () => 1000 + body.children.length * 100, configurable: true },
  });
  return { app, fetch, body, document: dom.window.document };
}

const message = (text: string, extra = {}) => ({ role: 'assistant', text, turn: 1, kind: 'response', ...extra });
const response = (messages: unknown[]) => ({ ok: true, json: async () => ({ data: { messages } }) });

describe('Claude conversation overlay', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('opens only for Claude and reuses the rendered message and link pipeline', async () => {
    h.app.activeSessionId = 'codex-1';
    h.app.toggleChatView();
    expect(h.fetch).not.toHaveBeenCalled();
    h.app.activeSessionId = 'claude-1';
    h.fetch.mockResolvedValue(response([message('Read /home/work/report.md')]));
    h.app.toggleChatView();
    await h.app._chatView.refreshPromise;
    expect(h.document.getElementById('chatView')!.hidden).toBe(false);
    expect(h.document.getElementById('chatViewToggle')!.getAttribute('aria-expanded')).toBe('true');
    expect(h.body.querySelector('a.rv-path')?.getAttribute('data-path')).toBe('/home/work/report.md');
    expect(h.body.dataset.rvBound).toBe('1');
    expect(h.body.hasAttribute('data-i18n-skip')).toBe(true);
    expect(h.document.activeElement).toBe(h.body);
  });

  it.each(['remote-claude', 'docker-claude'])('does not open for %s sessions without a host transcript', (sessionId) => {
    h.app.activeSessionId = sessionId;
    h.app.toggleChatView();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.document.getElementById('chatView')!.hidden).toBe(true);
  });

  it('appends an exact prefix without replacing cards or moving a reader away from older text', async () => {
    h.fetch.mockResolvedValueOnce(response([message('first')]));
    h.app.toggleChatView();
    await h.app._chatView.refreshPromise;
    const first = h.body.firstChild;
    h.body.scrollTop = 120;
    h.fetch.mockResolvedValueOnce(response([message('first'), message('second')]));
    await h.app.refreshChatView();
    expect(h.body.firstChild).toBe(first);
    expect(h.body.scrollTop).toBe(120);
    expect(h.body.lastElementChild?.classList.contains('rv-msg-cont')).toBe(true);
    h.body.scrollTop = h.body.scrollHeight - h.body.clientHeight - 10;
    h.fetch.mockResolvedValueOnce(response([message('first'), message('second'), message('latest')]));
    await h.app.refreshChatView();
    expect(h.body.scrollTop).toBe(h.body.scrollHeight);
  });

  it.each([
    [[message('changed')]],
    [[message('first', { role: 'user' })]],
    [[message('first', { turn: 2 })]],
    [[message('first', { kind: 'tool' })]],
    [[message('first', { queued: true })]],
    [[]],
  ])('rebuilds replaced, changed metadata, or truncated snapshots: %j', async (messages) => {
    h.fetch.mockResolvedValueOnce(response([message('first')]));
    h.app.toggleChatView();
    await h.app._chatView.refreshPromise;
    const first = h.body.firstChild;
    h.body.scrollTop = 100;
    h.fetch.mockResolvedValueOnce(response(messages));
    await h.app.refreshChatView();
    expect(h.body.firstChild).not.toBe(first);
    expect(h.body.children).toHaveLength(messages.length);
    expect(h.body.scrollTop).toBe(100);
  });

  it('coalesces concurrent SSE notifications and ignores closed or other sessions', async () => {
    let finish!: (value: unknown) => void;
    h.fetch.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    h.fetch.mockResolvedValue(response([message('latest')]));
    h.app._onTranscriptUpdate({ sessionId: 'claude-1' });
    expect(h.fetch).not.toHaveBeenCalled();
    h.app.toggleChatView();
    const pending = h.app._chatView.refreshPromise;
    for (let i = 0; i < 5; i++) h.app._onTranscriptUpdate({ sessionId: 'claude-1' });
    h.app._onTranscriptUpdate({ sessionId: 'other' });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    finish(response([message('older')]));
    await pending;
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.body.textContent).toContain('latest');
    h.app.closeChatView();
    h.app._onTranscriptUpdate({ sessionId: 'claude-1' });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it('fences stale fetches even when the same session is reopened, and aborts on close', async () => {
    let finish!: (value: unknown) => void;
    h.fetch.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    h.app.toggleChatView();
    const old = h.app._chatView;
    h.app.closeChatView();
    expect(old.controller.signal.aborted).toBe(true);
    h.fetch.mockResolvedValueOnce(response([message('new view')]));
    h.app.toggleChatView();
    await h.app._chatView.refreshPromise;
    finish(response([message('stale view')]));
    await old.refreshPromise;
    expect(h.body.textContent).toContain('new view');
    expect(h.body.textContent).not.toContain('stale view');
    h.app.activeSessionId = 'codex-1';
    h.app._onTranscriptUpdate({ sessionId: 'claude-1' });
    expect(h.app._chatView).toBeNull();
    expect(h.document.getElementById('chatView')!.hidden).toBe(true);
  });

  it('keeps the last good snapshot on error and offers a working retry', async () => {
    h.fetch.mockResolvedValueOnce(response([message('good')]));
    h.app.toggleChatView();
    await h.app._chatView.refreshPromise;
    h.fetch.mockResolvedValueOnce({ ok: false });
    await h.app.refreshChatView();
    expect(h.body.textContent).toContain('good');
    expect(h.document.getElementById('chatViewStatus')!.textContent).toContain('Tap Refresh');
    h.fetch.mockResolvedValueOnce(response([]));
    await h.app.refreshChatView();
    expect(h.body.children).toHaveLength(0);
    expect(h.document.getElementById('chatViewStatus')!.textContent).toContain('No conversation history');
  });
});
