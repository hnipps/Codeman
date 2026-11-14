/**
 * @fileoverview Agent text as rendered Markdown, through the dashboard's own pipeline: the vendored `marked`, the
 * DOMPurify allowlist in `sanitize-html.js` and the shared Mermaid frame in `mermaid-render.js`, all loaded by
 * `canvas.html` as classic scripts ahead of the bundle. No second parser, sanitizer or diagram path lives here.
 * Without every piece the answer is null and the caller keeps plain text.
 */

declare global {
  interface Window {
    marked?: { parse(src: string, options?: { breaks?: boolean; gfm?: boolean }): string };
    sanitizeMarkdownHtml?: (html: string) => string;
    CodemanMermaid?: { hydrate(root: Element): void };
  }
}

export interface MarkdownDeps {
  parse(src: string): string;
  sanitize(html: string): string;
}

function pageDeps(): MarkdownDeps | null {
  const marked = window.marked;
  const sanitize = window.sanitizeMarkdownHtml;
  if (typeof marked?.parse !== 'function' || typeof sanitize !== 'function') return null;
  return { parse: (src) => marked.parse(src, { breaks: true, gfm: true }), sanitize };
}

/** A detached element holding `text` rendered and sanitized, or null when the page lacks the pipeline. */
export function renderMarkdown(text: string, deps: MarkdownDeps | null = pageDeps()): HTMLElement | null {
  if (!deps) return null;
  let html: string;
  try {
    html = deps.sanitize(deps.parse(text));
  } catch {
    return null;
  }
  // A template parses without loading images, so nothing fetches before the links are decorated.
  const template = document.createElement('template');
  template.innerHTML = html;
  const root = template.content;
  // The shape mermaid-render.js hydrates: a wrapper around the <pre> holding an actions row it moves.
  root.querySelectorAll('pre > code').forEach((code) => {
    const pre = code.parentElement as HTMLElement;
    const wrap = document.createElement('div');
    wrap.className = 'rv-code-wrap';
    const actions = document.createElement('div');
    actions.className = 'rv-code-actions';
    pre.replaceWith(wrap);
    wrap.append(actions, pre);
  });
  root.querySelectorAll('table').forEach((table) => {
    const wrap = document.createElement('div');
    wrap.className = 'md-table';
    table.replaceWith(wrap);
    wrap.append(table);
  });
  // Set after sanitizing, so these are the only target/rel an agent's link can carry.
  root.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') ?? '';
    if (!href || href.startsWith('#') || /^(?:mailto|tel):/i.test(href)) return;
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  const out = document.createElement('div');
  out.className = 'md';
  out.append(root);
  return out;
}

/** Turns Mermaid fences under `root` into diagrams. `root` must be in the document: the renderer skips detached ones. */
export function hydrateDiagrams(root: Element): void {
  window.CodemanMermaid?.hydrate(root);
}
