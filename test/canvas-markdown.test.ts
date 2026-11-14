/**
 * @fileoverview Agent text in the canvas renders as Markdown (`packages/canvas/src/markdown.ts`) through the SHIPPING
 * pipeline: the vendored `marked` and DOMPurify, `sanitize-html.js`'s config and `mermaid-render.js`'s hydrate, the
 * same files `canvas.html` loads. jsdom is installed as the global document for the module under test.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const publicFile = (name: string) => readFileSync(resolve(import.meta.dirname, '../src/web/public', name), 'utf8');

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'outside-only' });
const win = dom.window as unknown as Window & typeof globalThis;

function commonjs<T>(source: string): T {
  const module: { exports: unknown } = { exports: {} };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  new Function('module', 'exports', source)(module, module.exports);
  return module.exports as T;
}

const marked = commonjs<{ parse: (src: string, opts?: unknown) => string }>(publicFile('vendor/marked.min.js'));
const DOMPurify = commonjs<(w: unknown) => unknown>(publicFile('vendor/dompurify.min.js'))(win);
const sanitize = commonjs<{ createMarkdownSanitizer: (dp: unknown) => (html: string) => string }>(
  publicFile('sanitize-html.js')
).createMarkdownSanitizer(DOMPurify);
const deps = { parse: (src: string) => marked.parse(src, { breaks: true, gfm: true }), sanitize };

const saved: Record<string, unknown> = {};
let renderMarkdown: typeof import('../packages/canvas/src/markdown.js').renderMarkdown;
let hydrateDiagrams: typeof import('../packages/canvas/src/markdown.js').hydrateDiagrams;

beforeAll(async () => {
  for (const key of ['window', 'document']) saved[key] = (globalThis as Record<string, unknown>)[key];
  Object.assign(globalThis, { window: win, document: win.document });
  ({ renderMarkdown, hydrateDiagrams } = await import('../packages/canvas/src/markdown.js'));
});
afterAll(() => {
  Object.assign(globalThis, saved);
});

describe('canvas agent Markdown', () => {
  it('renders headings, emphasis, lists, inline code and tables', () => {
    const el = renderMarkdown(
      '## Plan\n\n**Bold** and `code`\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |',
      deps
    )!;
    expect(el.className).toBe('md');
    expect(el.querySelector('h2')?.textContent).toBe('Plan');
    expect(el.querySelector('strong')?.textContent).toBe('Bold');
    expect(el.querySelector('p code')?.textContent).toBe('code');
    expect([...el.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['one', 'two']);
    expect(el.querySelector('.md-table > table td')?.textContent).toBe('1');
  });

  it('strips script, handlers and javascript: links through the shared sanitizer', () => {
    const el = renderMarkdown(
      '<script>alert(1)</script><img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))',
      deps
    )!;
    expect(el.querySelector('script')).toBeNull();
    expect(el.querySelector('[onerror]')).toBeNull();
    expect([...el.querySelectorAll('a')].some((a) => /^javascript:/i.test(a.getAttribute('href') ?? ''))).toBe(false);
  });

  it('opens links in a new tab without an opener', () => {
    const el = renderMarkdown('[site](https://example.com) [here](#top)', deps)!;
    const [out, frag] = [...el.querySelectorAll('a')];
    expect(out.getAttribute('target')).toBe('_blank');
    expect(out.getAttribute('rel')).toBe('noopener noreferrer');
    expect(frag.hasAttribute('target')).toBe(false);
  });

  it('answers null without the pipeline, so the caller keeps plain text', () => {
    expect(renderMarkdown('# hi', null)).toBeNull();
    expect(renderMarkdown('# hi')).toBeNull();
  });

  it('gives a Mermaid fence the shape the shared renderer hydrates', () => {
    const el = renderMarkdown('```mermaid\ngraph TD; A-->B\n```', deps)!;
    win.document.body.append(el);
    vm.runInContext(publicFile('mermaid-render.js'), dom.getInternalVMContext());
    hydrateDiagrams(el);
    const wrap = el.querySelector('.rv-code-wrap')!;
    expect(wrap.classList.contains('rv-mermaid-wrap')).toBe(true);
    expect(wrap.querySelector('.rv-mermaid-status')?.textContent).toBe('Rendering Mermaid diagram...');
    expect(wrap.querySelector('details > summary')?.textContent).toBe('Mermaid source');
    expect(wrap.querySelector('details pre > code.language-mermaid')?.textContent).toContain('A-->B');
    expect(wrap.textContent).not.toContain('null');
    el.remove();
  });
});
