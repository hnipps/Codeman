/**
 * @fileoverview The canvas pages report uncaught errors and unhandled rejections to `POST /api/client-errors`
 * with the dashboard's limits, through the page's base-path helper, and the boot guard in `canvas.html` still
 * sends the browser to the classic view on the same event.
 *
 * Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { MAX_REPORTS, reportClientErrors } from '../packages/canvas/src/client-errors.js';
import { ClientErrorSchema } from '../src/web/schemas.js';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

function page(html = '<!doctype html><html><head></head><body></body></html>') {
  const dom = new JSDOM(html, { url: 'https://codeman.test/x/canvas/ws_1', runScripts: 'outside-only' });
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true }));
  Object.assign(dom.window, { fetch });
  const posts = () => fetch.mock.calls.map(([url, init]) => ({ url, init, body: JSON.parse(String(init.body)) }));
  const fail = (message: string, line = 1) => {
    const error = new Error(message);
    dom.window.dispatchEvent(
      new dom.window.ErrorEvent('error', {
        message,
        filename: 'https://codeman.test/x/canvas.js',
        lineno: line,
        colno: 2,
        error,
      })
    );
    return error;
  };
  const reject = (reason: unknown) =>
    dom.window.dispatchEvent(Object.assign(new dom.window.Event('unhandledrejection'), { reason }));
  return { dom, posts, fail, reject };
}
const url = (path: string) => `/x${path}`;

describe('canvas client error reports', () => {
  it('posts one report with the message and stack of a thrown error', () => {
    const p = page();
    reportClientErrors(url, p.dom.window as unknown as Window);
    const error = p.fail('board exploded', 7);
    const [post] = p.posts();
    expect(p.posts()).toHaveLength(1);
    expect(post.url).toBe('/x/api/client-errors');
    expect(post.init.method).toBe('POST');
    expect(post.init.keepalive).toBe(true);
    expect(post.body).toEqual({
      message: 'board exploded',
      source: 'https://codeman.test/x/canvas.js',
      line: 7,
      col: 2,
      stack: error.stack,
      url: '/x/canvas/ws_1',
    });
    expect(ClientErrorSchema.safeParse(post.body).success).toBe(true);
  });

  it('reports an unhandled rejection, with or without an Error', () => {
    const p = page();
    reportClientErrors(url, p.dom.window as unknown as Window);
    const error = new Error('fetch fell over');
    p.reject(error);
    p.reject('a plain reason');
    expect(p.posts().map((post) => post.body)).toEqual([
      { message: 'fetch fell over', stack: error.stack, url: '/x/canvas/ws_1' },
      { message: 'a plain reason', url: '/x/canvas/ws_1' },
    ]);
    for (const post of p.posts()) expect(ClientErrorSchema.safeParse(post.body).success).toBe(true);
  });

  it('reports the same error once and at most twenty distinct errors a load', () => {
    const p = page();
    reportClientErrors(url, p.dom.window as unknown as Window);
    p.fail('again');
    p.fail('again');
    expect(p.posts()).toHaveLength(1);
    for (let i = 0; i < 40; i++) p.fail(`error ${i}`);
    expect(MAX_REPORTS).toBe(20);
    expect(p.posts()).toHaveLength(MAX_REPORTS);
  });

  it('keeps an oversized report inside what the route accepts and survives a failing fetch', () => {
    const p = page();
    Object.assign(p.dom.window, {
      fetch: vi.fn(() => {
        throw new Error('offline');
      }),
    });
    reportClientErrors(url, p.dom.window as unknown as Window);
    expect(() => p.fail('x'.repeat(5000))).not.toThrow();
    const sent = JSON.parse(String((p.dom.window.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body));
    expect(sent.message).toHaveLength(2000);
    expect(ClientErrorSchema.safeParse(sent).success).toBe(true);
  });

  it('leaves the boot guard its fallback: both see an early error', () => {
    const guard = /<script>\s*(\(function \(\) \{[\s\S]*?\}\)\(\);)\s*<\/script>/.exec(
      read('src/web/public/canvas.html')
    )![1];
    const p = page(
      '<!doctype html><html data-canvas data-shell><head><meta name="codeman-canvas-shell" content="on" /><meta name="codeman-canvas-workspace" content="ws_1" /><base href="/x/" /></head><body></body></html>'
    );
    const replaced: string[] = [];
    const real = p.dom.window.location;
    const location = {
      pathname: real.pathname,
      search: real.search,
      hash: real.hash,
      replace: (to: string) => replaced.push(to),
    };
    const source = guard.replace('window.top === window.self', 'true');
    expect(source).not.toBe(guard);
    vm.runInContext(`(function (location) { ${source} })`, p.dom.getInternalVMContext())(location);
    reportClientErrors(url, p.dom.window as unknown as Window);
    p.fail('thrown while starting');
    expect(replaced).toEqual(['/x/?view=classic&canvas=failed&reason=boot']);
    expect(p.posts().map((post) => post.body.message)).toEqual(['thrown while starting']);
    p.reject(new Error('later'));
    expect(replaced).toHaveLength(1);
    expect(p.posts()).toHaveLength(2);
  });

  it('is started by both canvas entries, through their base-path helper, before they touch the document', () => {
    for (const entry of ['packages/canvas/src/entry.ts', 'packages/canvas/src/home.ts']) {
      const source = read(entry);
      const helper = source.indexOf('const url = (path: string): string => joinBasePath(base, path);');
      const started = source.indexOf('reportClientErrors(url);');
      expect(helper, entry).toBeGreaterThan(-1);
      expect(started, entry).toBeGreaterThan(helper);
      expect(started, entry).toBeLessThan(source.indexOf('document.getElementById'));
    }
  });
});
