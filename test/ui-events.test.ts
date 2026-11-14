/**
 * @fileoverview The page-side UI event reporter (`src/web/public/ui-events.js`) and what the canvas hands it
 * (`packages/canvas/src/ui-events.ts`): batched, coalesced, capped, dropped when hidden or offline, tokens
 * only, and in a shape `POST /api/client-errors` accepts.
 *
 * Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { reportClassicLinks, uiEvent, viewEvent } from '../packages/canvas/src/ui-events.js';
import type { ViewCommand } from '../packages/canvas/src/commands.js';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const SOURCE = read('src/web/public/ui-events.js');

type Body = { kind: 'ui'; events: Array<Record<string, unknown>> };
type Reporter = {
  record(surface: string, action: string, target?: unknown): boolean;
  flush(): void;
  MAX_BATCH: number;
  MAX_PER_LOAD: number;
  FLUSH_MS: number;
};

function page(url = 'https://codeman.test/x/canvas/ws_1') {
  const dom = new JSDOM('<!doctype html><html><head><base href="/x/" /></head><body></body></html>', {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true }));
  let visibility = 'visible';
  let online = true;
  Object.assign(dom.window, { fetch });
  Object.defineProperty(dom.window.document, 'visibilityState', { get: () => visibility });
  Object.defineProperty(dom.window.navigator, 'onLine', { get: () => online });
  vm.runInContext(SOURCE, dom.getInternalVMContext());
  const reporter = (dom.window as unknown as { CodemanUiEvents: Reporter }).CodemanUiEvents;
  return {
    dom,
    reporter,
    posts: () => fetch.mock.calls.map(([to, init]) => ({ to, init, body: JSON.parse(String(init.body)) as Body })),
    hide: () => {
      visibility = 'hidden';
      dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
    },
    show: () => (visibility = 'visible'),
    offline: (off: boolean) => (online = !off),
  };
}

describe('the UI event reporter', () => {
  it('sends nothing until asked, then one batch to the base-path route with tokens and an age', () => {
    const p = page();
    expect(p.reporter.record('tab-strip', 'tab.select', 'a1b2c3d4')).toBe(true);
    expect(p.reporter.record('canvas', 'outline', 'open')).toBe(true);
    expect(p.posts()).toHaveLength(0);
    p.reporter.flush();
    const [post] = p.posts();
    expect(p.posts()).toHaveLength(1);
    expect(post.to).toBe('/x/api/client-errors');
    expect(post.init).toMatchObject({ method: 'POST', keepalive: true });
    expect(post.body.kind).toBe('ui');
    expect(post.body.events).toEqual([
      { surface: 'tab-strip', action: 'tab.select', target: 'a1b2c3d4', agoMs: expect.any(Number) },
      { surface: 'canvas', action: 'outline', target: 'open', agoMs: expect.any(Number) },
    ]);
    p.reporter.flush();
    expect(p.posts()).toHaveLength(1);
  });

  it('flushes by itself after the flush interval', () => {
    vi.useFakeTimers();
    try {
      const dom = new JSDOM('<!doctype html><base href="/" />', {
        url: 'https://codeman.test/',
        runScripts: 'outside-only',
      });
      const fetch = vi.fn(async () => ({ ok: true }));
      Object.assign(dom.window, { fetch, setTimeout, clearTimeout });
      vm.runInContext(SOURCE, dom.getInternalVMContext());
      const reporter = (dom.window as unknown as { CodemanUiEvents: Reporter }).CodemanUiEvents;
      reporter.record('canvas', 'tool', 'pan');
      vi.advanceTimersByTime(reporter.FLUSH_MS - 1);
      expect(fetch).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts a run of the same event as one entry', () => {
    const p = page();
    for (let i = 0; i < 40; i++) p.reporter.record('canvas', 'edit', 'update');
    p.reporter.record('canvas', 'edit', 'delete');
    p.reporter.flush();
    expect(p.posts()[0].body.events.map(({ action, target, n }) => ({ action, target, n }))).toEqual([
      { action: 'edit', target: 'update', n: 40 },
      { action: 'edit', target: 'delete', n: undefined },
    ]);
  });

  it('drops what does not fit one batch and stops at the per-load cap', () => {
    const p = page();
    for (let i = 0; i < p.reporter.MAX_BATCH + 10; i++) p.reporter.record('canvas', 'tool', `t${i}`);
    p.reporter.flush();
    expect(p.posts()[0].body.events).toHaveLength(p.reporter.MAX_BATCH);
    let accepted = p.reporter.MAX_BATCH;
    for (let i = 0; i < p.reporter.MAX_PER_LOAD * 2; i++) {
      if (p.reporter.record('canvas', 'tool', `u${i}`)) accepted++;
      if (i % p.reporter.MAX_BATCH === 0) p.reporter.flush();
    }
    p.reporter.flush();
    expect(accepted).toBe(p.reporter.MAX_PER_LOAD);
    expect(p.posts().reduce((sum, post) => sum + post.body.events.length, 0)).toBe(p.reporter.MAX_PER_LOAD);
  });

  it('drops an event recorded while the page is hidden or the browser is offline', () => {
    const p = page();
    p.offline(true);
    expect(p.reporter.record('canvas', 'tool', 'pan')).toBe(false);
    p.offline(false);
    p.hide();
    expect(p.reporter.record('canvas', 'tool', 'pan')).toBe(false);
    p.reporter.flush();
    expect(p.posts()).toHaveLength(0);
  });

  it('sends what was recorded while visible when the page is hidden or left', () => {
    const p = page();
    p.reporter.record('tab-strip', 'canvas.open');
    p.hide();
    expect(p.posts()).toHaveLength(1);
    p.show();
    p.reporter.record('canvas', 'classic.open', 'classicView');
    p.dom.window.dispatchEvent(new p.dom.window.Event('pagehide'));
    expect(p.posts()).toHaveLength(2);
  });

  it('refuses prose, an unknown surface and a malformed action', () => {
    const p = page();
    expect(p.reporter.record('canvas', 'edit', 'fix the login bug')).toBe(false);
    expect(p.reporter.record('canvas', 'edit', 'line\nbreak')).toBe(false);
    expect(p.reporter.record('canvas', 'Edit')).toBe(false);
    expect(p.reporter.record('terminal', 'edit')).toBe(false);
    p.reporter.flush();
    expect(p.posts()).toHaveLength(0);
  });

  it('never throws into the page when the request cannot be made', () => {
    const p = page();
    Object.assign(p.dom.window, {
      fetch: () => {
        throw new Error('no network stack');
      },
    });
    p.reporter.record('canvas', 'tool', 'pan');
    expect(() => p.reporter.flush()).not.toThrow();
  });
});

describe('what the canvas records', () => {
  const kinds: ViewCommand[] = [
    { kind: 'tool', tool: 'pan' },
    { kind: 'outline', open: false },
    { kind: 'rail', view: 'assistant' },
    { kind: 'rail-close', view: 'thread' },
    { kind: 'conversation', id: 'conv_1' },
    { kind: 'full-view', content: { kind: 'session', sessionId: 'a1b2c3d4-0000-4000-8000-000000000001' } },
    { kind: 'full-view', content: null },
    { kind: 'full-view', content: { kind: 'embed', objectId: 'obj_1' } },
    { kind: 'page', objectId: 'obj_1' },
    { kind: 'page', objectId: null },
    { kind: 'letters', enabled: false },
    { kind: 'enter', id: 'obj_1' },
    { kind: 'leave' },
  ];

  it('names discrete view commands and leaves the camera, focus and selection out', () => {
    expect(kinds.map(viewEvent)).toEqual([
      ['tool', 'pan'],
      ['outline', 'closed'],
      ['rail.open', 'assistant'],
      ['rail.close', 'thread'],
      ['conversation.show', 'conv_1'],
      ['full-view.open', 'a1b2c3d4-0000-4000-8000-000000000001'],
      ['full-view.close', null],
      ['page.open', 'full'],
      ['page.open', 'rail'],
      ['page.close', 'rail'],
      ['letters', 'off'],
      ['subcanvas.enter', 'obj_1'],
      ['subcanvas.leave', null],
    ]);
    for (const quiet of [
      { kind: 'pan', delta: { x: 1, y: 1 } },
      { kind: 'focus', id: 'obj_1' },
      { kind: 'selection', ids: ['obj_1'] },
      { kind: 'context-add', ids: ['obj_1'] },
      { kind: 'escape' },
    ] satisfies ViewCommand[]) {
      expect(viewEvent(quiet)).toBeNull();
    }
    // Escape and the rail's close button pop the top rail view without naming it.
    expect(viewEvent({ kind: 'escape' }, 'assistant')).toEqual(['rail.close', 'assistant']);
  });

  it('every named view command is accepted by the reporter', () => {
    const p = page();
    for (const [index, action] of kinds.entries()) {
      const event = viewEvent(action)!;
      uiEvent(event[0], event[1], p.dom.window as unknown as Window);
      p.reporter.flush();
      expect(p.posts()).toHaveLength(index + 1);
    }
  });

  it('records a click on a classic view link by the link id and nothing for another link', () => {
    const p = page();
    p.dom.window.document.body.innerHTML =
      '<a id="classicView" href="classic">Classic view</a><a id="classicLink" href="./?view=classic">Open</a><a id="docs" href="https://example.test/">Docs</a>';
    reportClassicLinks(p.dom.window as unknown as Window);
    for (const id of ['classicView', 'docs', 'classicLink']) {
      const link = p.dom.window.document.getElementById(id)!;
      link.addEventListener('click', (e) => e.preventDefault());
      link.dispatchEvent(new p.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    }
    p.reporter.flush();
    expect(p.posts()[0].body.events.map(({ action, target }) => [action, target])).toEqual([
      ['classic.open', 'classicView'],
      ['classic.open', 'classicLink'],
    ]);
  });

  it('records nothing on a page that did not load the reporter', () => {
    const dom = new JSDOM('<!doctype html>');
    expect(() => uiEvent('tool', 'pan', dom.window as unknown as Window)).not.toThrow();
  });
});

describe('the pages load the reporter ahead of the code that records', () => {
  it('canvas.html loads it before the bundle, and index.html before app.js', () => {
    const canvas = read('src/web/public/canvas.html');
    expect(canvas.indexOf('<script defer src="ui-events.js">')).toBeGreaterThan(-1);
    expect(canvas.indexOf('<script defer src="ui-events.js">')).toBeLessThan(canvas.indexOf('src="canvas.js"'));
    const index = read('src/web/public/index.html');
    expect(index.indexOf('<script defer src="ui-events.js">')).toBeGreaterThan(-1);
    expect(index.indexOf('<script defer src="ui-events.js">')).toBeLessThan(index.indexOf('src="app.js"'));
  });

  it('the tab strip passes ids and state words only, never a session name', () => {
    const app = read('src/web/public/app.js') + read('src/web/public/webview-tabs.js');
    const calls = [...app.matchAll(/this\._uiEvent\(([^)]*)\)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThanOrEqual(8);
    for (const call of calls) expect(call).not.toMatch(/\.name\b|title|label|text|prompt/i);
  });
});
