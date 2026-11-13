/**
 * @fileoverview The canvas document's inline boot guard (PC13), extracted from `canvas.html` and run in a DOM:
 * it names the workspace in the address, sends the browser to the classic view on each failure, at most once,
 * and never when the shell is off, the page is framed, the bundle has started, or the address already asks for
 * the classic view (a saved copy served offline).
 *
 * Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const HTML = readFileSync(resolve(import.meta.dirname, '../src/web/public/canvas.html'), 'utf8');
const GUARD = /<script>\s*(\(function \(\) \{[\s\S]*?\}\)\(\);)\s*<\/script>/.exec(HTML)![1];

type Boot = { ok: boolean; shell: boolean; stale: boolean; navigations: number; ready(): void; fail(r: string): void };
function page(options: { url: string; shell?: boolean; workspace?: string; base?: string; framed?: boolean }) {
  const metas = options.shell
    ? `<meta name="codeman-canvas-shell" content="on" /><meta name="codeman-canvas-workspace" content="${options.workspace ?? ''}" />`
    : '';
  const dom = new JSDOM(
    `<!doctype html><html data-canvas${options.shell ? ' data-shell' : ''}><head>${metas}<base href="${options.base ?? '/'}" /></head><body><script type="module" id="bundle"></script><script id="other"></script></body></html>`,
    { url: options.url, runScripts: 'outside-only' }
  );
  const replaced: string[] = [];
  const context = dom.getInternalVMContext();
  // jsdom cannot navigate; the guard's one navigation call is recorded instead.
  const real = dom.window.location;
  const location = {
    get pathname() {
      return real.pathname;
    },
    get search() {
      return real.search;
    },
    get hash() {
      return real.hash;
    },
    replace: (to: string) => replaced.push(to),
  };
  // jsdom has no parent frame to load this page into; the one comparison that asks is answered here.
  const source = GUARD.replace('window.top === window.self', options.framed ? 'false' : 'true');
  expect(source).not.toBe(GUARD);
  vm.runInContext(`(function (location) { ${source} })`, context)(location);
  const boot = (dom.window as unknown as { __canvasBoot: Boot }).__canvasBoot;
  const fire = (type: string, target: 'bundle' | 'other' | 'window') => {
    const event = new dom.window.Event(type);
    if (target === 'window') dom.window.dispatchEvent(event);
    else dom.window.document.getElementById(target)!.dispatchEvent(event);
  };
  return { dom, boot, replaced, fire };
}

describe('canvas boot guard', () => {
  it('is in the document before the bundle and is not part of it', () => {
    expect(HTML.indexOf('__canvasBoot')).toBeGreaterThan(0);
    expect(HTML.indexOf('__canvasBoot')).toBeLessThan(HTML.indexOf('<script type="module" src="canvas.js">'));
    expect(HTML).toContain('<a id="classicLink" class="shell-only" href="./?view=classic">Open classic view</a>');
  });

  it('names the workspace in the address without a second load, keeping the query', () => {
    const { dom, boot } = page({ url: 'http://localhost/?session=abc', shell: true, workspace: 'ws-1' });
    expect(boot.shell).toBe(true);
    expect(dom.window.location.pathname + dom.window.location.search).toBe('/canvas/ws-1?session=abc');
    const based = page({ url: 'http://localhost/x', shell: true, workspace: 'ws-1', base: '/x/' });
    expect(based.dom.window.location.pathname).toBe('/x/canvas/ws-1');
    const direct = page({ url: 'http://localhost/canvas/ws-2', shell: true, workspace: 'ws-2' });
    expect(direct.dom.window.location.pathname).toBe('/canvas/ws-2');
    const firstRun = page({ url: 'http://localhost/', shell: true, workspace: '' });
    expect(firstRun.dom.window.location.pathname).toBe('/');
  });

  it('goes to the classic view when the bundle fails to load', () => {
    const { replaced, fire } = page({ url: 'http://localhost/', shell: true, workspace: 'ws-1' });
    fire('error', 'bundle');
    expect(replaced).toEqual(['/?view=classic&canvas=failed&reason=load']);
  });

  it('goes to the classic view when the bundle loads but did not start, or throws before it started', () => {
    const loaded = page({ url: 'http://localhost/', shell: true, workspace: 'ws-1' });
    loaded.fire('load', 'bundle');
    expect(loaded.replaced).toEqual(['/?view=classic&canvas=failed&reason=boot']);
    const thrown = page({ url: 'http://localhost/x/', shell: true, workspace: 'ws-1', base: '/x/' });
    thrown.fire('error', 'window');
    expect(thrown.replaced).toEqual(['/x/?view=classic&canvas=failed&reason=boot']);
    const rejected = page({ url: 'http://localhost/', shell: true, workspace: 'ws-1' });
    rejected.fire('unhandledrejection', 'window');
    expect(rejected.replaced).toHaveLength(1);
  });

  it('navigates at most once, and never for another script', () => {
    const { replaced, fire, boot } = page({ url: 'http://localhost/', shell: true, workspace: 'ws-1' });
    fire('error', 'other');
    fire('load', 'other');
    expect(replaced).toEqual([]);
    fire('error', 'bundle');
    fire('error', 'window');
    fire('load', 'bundle');
    boot.fail('boot');
    expect(replaced).toHaveLength(1);
    expect(boot.navigations).toBe(1);
  });

  it('does nothing once the bundle reported that it started', () => {
    const { replaced, fire, boot } = page({ url: 'http://localhost/', shell: true, workspace: 'ws-1' });
    boot.ready();
    fire('load', 'bundle');
    fire('error', 'window');
    fire('unhandledrejection', 'window');
    expect(replaced).toEqual([]);
  });

  it('does nothing with the shell off, and nothing when the page is framed', () => {
    const off = page({ url: 'http://localhost/canvas/ws-1' });
    off.fire('error', 'bundle');
    off.fire('error', 'window');
    expect(off.replaced).toEqual([]);
    expect(off.boot.shell).toBe(false);
    const framed = page({ url: 'http://localhost/canvas/ws-1', shell: true, workspace: 'ws-1', framed: true });
    framed.fire('error', 'bundle');
    expect(framed.replaced).toEqual([]);
    expect(framed.boot.shell).toBe(false);
    // The classic link and every other shell-only control stay hidden in a canvas tab.
    expect(framed.dom.window.document.documentElement.hasAttribute('data-shell')).toBe(false);
  });

  it('never navigates when the address already asks for the classic view (a saved copy served offline)', () => {
    const { replaced, fire, boot, dom } = page({
      url: 'http://localhost/?view=classic&canvas=failed&reason=load',
      shell: true,
      workspace: 'ws-1',
    });
    expect(boot.stale).toBe(true);
    fire('error', 'bundle');
    fire('error', 'window');
    fire('load', 'bundle');
    expect(replaced).toEqual([]);
    // The address is left alone too, so a reload asks the server for the classic view again.
    expect(dom.window.location.search).toBe('?view=classic&canvas=failed&reason=load');
    expect(dom.window.location.pathname).toBe('/');
  });
});
