/**
 * @fileoverview The browser-side half of a prototype capture: a self-contained function that walks the
 * live page and writes it out as static HTML, with every resource address replaced by a token the
 * Node side resolves to a local file.
 *
 * `snapshotPage` runs INSIDE the captured app's page (puppeteer `evaluate` of its source text), like
 * `frameBridge` runs inside a canvas frame: no import, no reference to anything outside its body, its
 * options and the CSS tokenizer arrive as arguments. The server is compiled without the DOM library, so
 * the DOM is typed `any` here and a real browser (the browser suite) checks what the compiler cannot.
 *
 * What the walk does:
 * - drops `script`, `noscript`, `base`, `meta[http-equiv]`, `meta[charset]`, every `link` that is not a
 *   stylesheet, `object`/`embed`, every `on*` attribute, `nonce`/`integrity`, and `javascript:` hrefs;
 * - keeps a `style`/`link` stylesheet in place as a placeholder comment; the Node side puts back a
 *   `<style>` or a `<link>` to a shared CSS file (a stylesheet written by CSSOM calls with no text,
 *   CSS-in-JS, is read from its rules);
 * - tokenizes resource addresses: `src`, `poster`, SVG `href`/`xlink:href`, `url()` and `@import` in
 *   CSS and `style` attributes; an `img` keeps the one source the browser chose (`currentSrc`);
 * - writes form state as markup (values, checked, selected; never a password's value), an open shadow
 *   root as `<template shadowrootmode="open">` with its adopted sheets, a canvas as its pixels behind it
 *   (a background image), and every element's scroll offset as `data-cca-scroll`;
 * - leaves iframes empty and media without a source (their poster stays).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Dom = any;

export interface SnapshotOptions {
  /** Makes the tokens unique to one capture, so page text cannot be mistaken for one. */
  nonce: string;
  /** Inline `<style>` text longer than this goes to a shared CSS file. */
  inlineStyleMax: number;
}

export interface SnapshotSheet {
  /** `style` text (already tokenized) or a `link` whose original text the Node side fetches. */
  kind: 'style' | 'link';
  /** The stylesheet text, tokenized; for a link, its CSSOM text as a fallback (null when unreadable). */
  text: string | null;
  href: string | null;
  media: string;
  /** Stays a `<style>` element (inside SVG or a shadow root, or short). */
  inline: boolean;
}

export interface Snapshot {
  html: string;
  /** Absolute addresses by token number. */
  urls: string[];
  /** `data:` PNGs of canvas elements by token number. */
  canvases: string[];
  sheets: SnapshotSheet[];
  title: string;
}

/**
 * Replace every resource address in a stylesheet with what `register` answers, resolved against
 * `base`. Self-contained: it is shipped into the page as source text and also used in Node.
 * `url(#id)` (an SVG reference) and `data:` addresses are left as written.
 */
export function tokenizeCss(css: string, base: string, register: (absolute: string) => string | null): string {
  const swap = (raw: string): string | null => {
    const value = raw.trim();
    if (!value || value.startsWith('#') || /^data:/i.test(value)) return null;
    let absolute: string;
    try {
      absolute = new URL(value, base).href;
    } catch {
      return null;
    }
    return register(absolute);
  };
  const quoted = (token: string): string => `"${token.replace(/["\\\n]/g, '')}"`;
  return css
    .replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi, (whole, a, b, c) => {
      const token = swap(a ?? b ?? c ?? '');
      return token === null ? whole : `url(${quoted(token)})`;
    })
    .replace(/@import\s+(?:"([^"]*)"|'([^']*)')/gi, (whole, a, b) => {
      const token = swap(a ?? b ?? '');
      return token === null ? whole : `@import url(${quoted(token)})`;
    });
}

export function snapshotPage(options: SnapshotOptions, cssTokens: typeof tokenizeCss): Snapshot {
  const window: Dom = globalThis;
  const document: Dom = window.document;
  const urls: string[] = [];
  const index = new Map<string, number>();
  const canvases: string[] = [];
  const sheets: SnapshotSheet[] = [];
  const token = (n: number | string): string => `__cca${options.nonce}_${n}__`;
  const register = (absolute: string): string | null => {
    if (!/^(https?|blob):/i.test(absolute)) return null;
    let n = index.get(absolute);
    if (n === undefined) {
      n = urls.length;
      urls.push(absolute);
      index.set(absolute, n);
    }
    return token(n);
  };
  const resource = (raw: string | null, base: string): string | null => {
    if (raw === null) return null;
    const value = raw.trim();
    if (!value || /^(data|about):/i.test(value)) return raw;
    const hash = value.indexOf('#');
    const head = hash >= 0 ? value.slice(0, hash) : value;
    const fragment = hash >= 0 ? value.slice(hash) : '';
    if (!head) return raw;
    let absolute: string;
    try {
      absolute = new URL(head, base).href;
    } catch {
      return 'data:,';
    }
    const t = register(absolute);
    return t === null ? 'data:,' : t + fragment;
  };
  const css = (text: string, base: string): string => cssTokens(text, base, register);
  const rulesText = (sheet: Dom): string | null => {
    let rules: Dom;
    try {
      rules = sheet.cssRules;
    } catch {
      return null;
    }
    if (!rules) return null;
    const base = sheet.href || document.baseURI;
    const out: string[] = [];
    for (const rule of Array.from<Dom>(rules)) {
      // An imported sheet the page can read is inlined, so its own addresses resolve against its own URL.
      if (rule.type === 3 && rule.styleSheet) {
        const inner = rulesText(rule.styleSheet);
        if (inner !== null) {
          const media = rule.media && rule.media.mediaText ? rule.media.mediaText : '';
          out.push(media ? `@media ${media}{${inner}}` : inner);
          continue;
        }
      }
      out.push(css(rule.cssText, base));
    }
    return out.join('\n');
  };

  const VOID = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'source',
    'track',
    'wbr',
  ]);
  const DROP = new Set(['script', 'noscript', 'base', 'object', 'embed', 'applet', 'portal']);
  const escText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const sheetPlaceholder = (sheet: SnapshotSheet): string => {
    sheets.push(sheet);
    return `<!--cca${options.nonce}-sheet-${sheets.length - 1}-->`;
  };

  const out: string[] = [];
  const attrsOf = (el: Dom, inSvg: boolean): string => {
    const tag = el.localName;
    const parts: string[] = [];
    const base = document.baseURI;
    const set = new Map<string, string | null>();
    for (const attr of Array.from<Dom>(el.attributes)) set.set(attr.name, attr.value);
    for (const name of Array.from(set.keys())) {
      const lower = name.toLowerCase();
      if (
        lower.startsWith('on') ||
        lower === 'nonce' ||
        lower === 'integrity' ||
        lower === 'srcset' ||
        lower === 'sizes'
      )
        set.delete(name);
    }
    const href = set.get('href');
    if (href !== undefined && href !== null && /^\s*javascript:/i.test(href)) set.set('href', '#');
    if (tag === 'img') {
      set.set('src', resource(el.currentSrc || el.getAttribute('src'), base));
      set.delete('loading');
    } else if (tag === 'input' && (el.type || '').toLowerCase() === 'image')
      set.set('src', resource(el.getAttribute('src'), base));
    else if (tag === 'video' || tag === 'audio') {
      set.delete('src');
      set.delete('autoplay');
      if (set.has('poster')) set.set('poster', resource(el.getAttribute('poster'), base));
      set.set('preload', 'none');
    } else if (tag === 'source' || tag === 'track') {
      set.delete('src');
    } else if (tag === 'iframe' || tag === 'frame') {
      set.delete('src');
      set.delete('srcdoc');
    } else if (inSvg) {
      for (const name of ['href', 'xlink:href'])
        if (set.has(name) && tag !== 'a') set.set(name, resource(set.get(name) ?? null, base));
    }
    if (set.has('background')) set.set('background', resource(set.get('background') ?? null, base));
    if (set.has('style')) set.set('style', css(set.get('style') ?? '', base));
    // Form state goes into markup; what a person typed into a password field never does.
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        if (el.checked) set.set('checked', '');
        else set.delete('checked');
      } else if (type !== 'password' && type !== 'file' && typeof el.value === 'string') set.set('value', el.value);
    }
    if (tag === 'option') {
      if (el.selected) set.set('selected', '');
      else set.delete('selected');
    }
    if (tag === 'details') {
      if (el.open) set.set('open', '');
      else set.delete('open');
    }
    if (tag === 'dialog') {
      if (el.open) set.set('open', '');
      else set.delete('open');
    }
    if (tag === 'canvas') {
      let data = '';
      try {
        data = el.width && el.height ? el.toDataURL('image/png') : '';
      } catch {
        data = '';
      }
      if (data.startsWith('data:image/png')) {
        canvases.push(data);
        const painted = `background:url("${token(`c${canvases.length - 1}`)}") 0 0/100% 100% no-repeat`;
        const own = set.get('style');
        set.set('style', own ? `${own};${painted}` : painted);
      }
    }
    if (el.scrollTop || el.scrollLeft)
      set.set('data-cca-scroll', `${Math.round(el.scrollLeft)},${Math.round(el.scrollTop)}`);
    for (const [name, value] of set) {
      if (value === null) continue;
      parts.push(value === '' ? ` ${name}` : ` ${name}="${escAttr(value)}"`);
    }
    return parts.join('');
  };

  const walkChildren = (parent: Dom, inSvg: boolean, inShadow: boolean): void => {
    for (const child of Array.from<Dom>(parent.childNodes)) walk(child, inSvg, inShadow);
  };
  const shadowOf = (el: Dom, inSvg: boolean): void => {
    const root = el.shadowRoot;
    if (!root) return;
    out.push('<template shadowrootmode="open">');
    for (const sheet of Array.from<Dom>(root.adoptedStyleSheets || [])) {
      const text = rulesText(sheet);
      if (text) out.push(sheetPlaceholder({ kind: 'style', text, href: null, media: '', inline: true }));
    }
    walkChildren(root, inSvg, true);
    out.push('</template>');
  };
  const walk = (node: Dom, inSvg: boolean, inShadow: boolean): void => {
    if (node.nodeType === 3) {
      const parent = node.parentNode;
      const raw = parent && parent.localName === 'style';
      out.push(raw ? node.data : escText(node.data));
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node;
    const tag: string = el.localName;
    if (DROP.has(tag)) return;
    if (tag === 'meta' && (el.hasAttribute('http-equiv') || el.hasAttribute('charset'))) return;
    const svg = inSvg || tag === 'svg';
    if (tag === 'link') {
      const rel = (el.getAttribute('rel') || '').toLowerCase().split(/\s+/);
      if (!rel.includes('stylesheet') || el.disabled || (el.sheet && el.sheet.disabled)) return;
      out.push(
        sheetPlaceholder({
          kind: 'link',
          text: el.sheet ? rulesText(el.sheet) : null,
          href: el.href || null,
          media: el.getAttribute('media') || '',
          inline: false,
        })
      );
      return;
    }
    if (tag === 'style') {
      if (el.sheet && el.sheet.disabled) return;
      const own = el.textContent || '';
      const text = own.trim() || !el.sheet ? css(own, document.baseURI) : (rulesText(el.sheet) ?? '');
      out.push(
        sheetPlaceholder({
          kind: 'style',
          text,
          href: null,
          media: el.getAttribute('media') || '',
          inline: svg || inShadow || text.length <= options.inlineStyleMax,
        })
      );
      return;
    }
    out.push(`<${tag}${attrsOf(el, svg)}>`);
    if (VOID.has(tag)) return;
    if (el.shadowRoot) shadowOf(el, svg);
    if (tag === 'textarea') out.push(escText(el.value || ''));
    else if (tag === 'template') walkChildren(el.content, svg, inShadow);
    else if (tag === 'iframe' || tag === 'frame') {
      /* An embedded document is not captured. */
    } else walkChildren(el, svg, inShadow);
    out.push(`</${tag}>`);
    if (tag === 'head') {
      // Sheets the page built in script and adopted, after everything the head declares.
      for (const sheet of Array.from<Dom>(document.adoptedStyleSheets || [])) {
        const text = rulesText(sheet);
        if (text) {
          out.pop();
          out.push(sheetPlaceholder({ kind: 'style', text, href: null, media: '', inline: false }), '</head>');
        }
      }
    }
  };

  const root = document.documentElement;
  if (window.scrollX || window.scrollY)
    root.setAttribute('data-cca-scroll', `${Math.round(window.scrollX)},${Math.round(window.scrollY)}`);
  walk(root, false, false);
  return { html: `<!doctype html>\n${out.join('')}`, urls, canvases, sheets, title: document.title || '' };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** The snapshot as one expression to evaluate in the page. See `FRAME_BRIDGE_SOURCE` for `__name`. */
export function snapshotSource(options: SnapshotOptions): string {
  return `(function(){var __name=function(f){return f};return (${snapshotPage.toString()})(${JSON.stringify(options)}, ${tokenizeCss.toString()})})()`;
}
