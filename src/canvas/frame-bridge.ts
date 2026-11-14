/**
 * @fileoverview The script Codeman injects into every canvas frame, a proxied embed or a stored prototype.
 *
 * A canvas frame is sandboxed with an opaque origin, so the canvas cannot reach into it and none of its
 * keys reach the canvas. This script is the only channel: it posts messages to the parent and answers the
 * parent's requests. The page can send the same messages itself, so the parent treats every one as
 * untrusted (see `packages/canvas/src/frame-messages.ts`).
 *
 * `frameBridge` is the whole script. It is shipped as its own source text, so it must stay self-contained:
 * no import, no reference to anything outside its body, and its limits arrive as its one argument.
 *
 * Frame to parent: `codeman:canvas-escape`, `codeman:frame-ready`, `codeman:frame-key` (bare Q only),
 * `codeman:frame-picked`, `codeman:frame-pick-cancelled`, `codeman:frame-elements`, `codeman:frame-rects`,
 * `codeman:frame-rects-changed`. Parent to frame: `codeman:pick-start`, `codeman:pick-stop`,
 * `codeman:query-polygon`, `codeman:locate`.
 */
import { MAX_ELEMENT_REFS } from './element-ref.js';

/** Bounds the bridge applies to what it reports and to what it accepts from the parent. */
export const FRAME_LIMITS = {
  maxElements: MAX_ELEMENT_REFS,
  maxPoints: 1024,
  maxSelectors: 64,
  maxScan: 5000,
  text: 2000,
  selector: 1024,
  path: 2048,
  attr: 512,
  style: 256,
  source: 512,
} as const;
export type FrameLimits = { readonly [K in keyof typeof FRAME_LIMITS]: number };

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A value from the page's DOM. The server is compiled without the DOM library, on purpose, so nothing
 * there can reach for `window` by accident; this one function runs in a browser and reads its globals
 * from `globalThis`. A DOM test environment and the browser suite check what the compiler cannot.
 */
type Dom = any;
export function frameBridge(limits: FrameLimits): void {
  const window: Dom = globalThis;
  const document: Dom = window.document;
  const host = window.parent;
  if (!host || host === window) return;
  const post = (message: Record<string, unknown>): void => {
    try {
      host.postMessage(message, '*');
    } catch {
      /* A parent that cannot be reached gets nothing. */
    }
  };
  // Joins a shadow host's selector to a selector inside its open shadow root.
  const JOIN = ' >>> ';
  const ATTRS = [
    'id',
    'class',
    'role',
    'aria-label',
    'data-testid',
    'name',
    'type',
    'href',
    'src',
    'title',
    'placeholder',
  ];
  const STYLES = [
    'color',
    'background-color',
    'font-family',
    'font-size',
    'font-weight',
    'line-height',
    'padding',
    'margin',
    'border',
    'border-radius',
    'display',
    'position',
    'width',
    'height',
    'gap',
    'opacity',
  ];
  const clip = (value: unknown, max: number): string => {
    const s = typeof value === 'string' ? value : '';
    return s.length > max ? s.slice(0, max) : s;
  };
  const quote = (value: string): string =>
    `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ')}"`;
  type Scope = Dom;
  const scopeOf = (el: Dom): Scope => el.getRootNode() as Scope;
  const only = (scope: Scope, selector: string, el: Dom): boolean => {
    try {
      const found = scope.querySelectorAll(selector);
      return found.length === 1 && found[0] === el;
    } catch {
      return false;
    }
  };
  const segment = (el: Dom): string => {
    const parent = el.parentElement;
    const simple = /^[a-z][a-z0-9-]*$/.test(el.localName);
    if (!parent && !(el.parentNode instanceof window.ShadowRoot)) return simple ? el.localName : '*';
    const siblings: Dom[] = Array.from(el.parentNode.children);
    if (!simple) return `*:nth-child(${siblings.indexOf(el) + 1})`;
    const same = siblings.filter((s) => s.localName === el.localName);
    return `${el.localName}:nth-of-type(${same.indexOf(el) + 1})`;
  };
  const anchor = (scope: Scope, el: Dom): string | null => {
    const id = el.getAttribute('id');
    if (id) {
      const byId = /^[A-Za-z_][\w-]*$/.test(id) ? `#${id}` : `[id=${quote(id)}]`;
      if (only(scope, byId, el)) return byId;
    }
    const testId = el.getAttribute('data-testid');
    if (testId) {
      const byTest = `[data-testid=${quote(testId)}]`;
      if (only(scope, byTest, el)) return byTest;
    }
    return null;
  };
  /** A selector that finds exactly `el` inside its own document or shadow root, or null. */
  const localSelector = (el: Dom): string | null => {
    const scope = scopeOf(el);
    const direct = anchor(scope, el);
    if (direct) return direct;
    let chain = segment(el);
    let at: Dom = el.parentElement;
    while (!only(scope, chain, el)) {
      if (!at) return null;
      const named = anchor(scope, at);
      chain = `${named ?? segment(at)} > ${chain}`;
      if (named) return only(scope, chain, el) ? chain : null;
      at = at.parentElement;
    }
    return chain;
  };
  /** The selector the parent sends back to find `el` again; shadow roots are crossed with `>>>`. */
  const selectorFor = (el: Dom): string | null => {
    const parts: string[] = [];
    let at: Dom = el;
    while (at) {
      const local = localSelector(at);
      if (!local) return null;
      parts.unshift(local);
      const scope = scopeOf(at);
      at = scope instanceof window.ShadowRoot ? scope.host : null;
    }
    const selector = parts.join(JOIN);
    return selector.length <= limits.selector ? selector : null;
  };
  const resolve = (selector: unknown): Dom => {
    if (typeof selector !== 'string' || !selector || selector.length > limits.selector) return null;
    let scope: Scope | null = document;
    let found: Dom = null;
    for (const part of selector.split(JOIN)) {
      if (!scope) return null;
      try {
        found = scope.querySelector(part);
      } catch {
        return null;
      }
      if (!found) return null;
      scope = found.shadowRoot;
    }
    return found;
  };
  const above = (el: Dom): Dom => {
    if (el.parentElement) return el.parentElement;
    const scope = scopeOf(el);
    return scope instanceof window.ShadowRoot ? scope.host : null;
  };
  const pathOf = (el: Dom): string => {
    const names: string[] = [];
    for (let at: Dom = el; at && names.length < 8; at = above(at)) {
      if (at === document.documentElement || at === document.body) break;
      const id = at.getAttribute('id');
      const first = (at.getAttribute('class') ?? '').trim().split(/\s+/)[0];
      names.unshift(at.localName + (id ? `#${id}` : first ? `.${first}` : ''));
    }
    return clip(names.join(' > '), limits.path);
  };
  const textOf = (el: Dom): string => {
    const field = el as Dom;
    // What a person typed into the page is theirs and never leaves it. A button input's value is its label.
    const labelled = el.localName === 'input' && ['button', 'submit', 'reset'].includes(field.type);
    const editable =
      field.isContentEditable === true || el.querySelector('[contenteditable]:not([contenteditable="false"])') !== null;
    const shown = editable ? '' : ((el as Dom).innerText ?? el.textContent ?? '');
    const candidates = [
      shown,
      el.getAttribute('aria-label'),
      el.getAttribute('alt'),
      el.getAttribute('placeholder'),
      labelled && typeof field.value === 'string' ? field.value : '',
    ];
    for (const candidate of candidates) {
      const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
      if (trimmed) return clip(trimmed, limits.text);
    }
    return '';
  };
  const boxOf = (el: Dom): { x: number; y: number; width: number; height: number } => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  };
  /** The element as the parent receives it: an `ElementRef` without its `objectId`. */
  const describe = (target: Dom): Record<string, unknown> | null => {
    // An element with no selector of its own (inside a shadow root that repeats its shape) is reported as its nearest ancestor that has one.
    for (let el: Dom = target; el; el = above(el)) {
      const selector = selectorFor(el);
      if (!selector) continue;
      const attrs: Record<string, string> = {};
      for (const name of ATTRS) {
        const value = el.getAttribute(name);
        if (value !== null) attrs[name] = clip(value, limits.attr);
      }
      const styles: Record<string, string> = {};
      const computed = window.getComputedStyle(el);
      for (const name of STYLES) {
        const value = computed.getPropertyValue(name);
        if (value) styles[name] = clip(value, limits.style);
      }
      const marked = el.closest('[data-source]')?.getAttribute('data-source');
      return {
        selector,
        path: pathOf(el),
        tag: clip(el.localName, 64) || 'element',
        text: textOf(el),
        rect: boxOf(el),
        attrs,
        styles,
        ...(marked ? { source: clip(marked, limits.source) } : {}),
      };
    }
    return null;
  };

  // ───────────── pick mode ─────────────
  let layer: Dom | null = null;
  let outline: Dom | null = null;
  let hovered: Dom = null;
  const mine = (el: Dom): boolean => !!el && !!layer && (el === layer || layer.contains(el));
  /** The innermost element at a point, through open shadow roots, never the bridge's own layer. */
  const elementAt = (x: number, y: number): Dom => {
    let el = document.elementsFromPoint(x, y).find((candidate: Dom) => !mine(candidate)) ?? null;
    for (let depth = 0; el?.shadowRoot && depth < 16; depth++) {
      const inner: Dom = el.shadowRoot.elementsFromPoint(x, y).find((c: Dom) => !mine(c) && c !== el) ?? null;
      if (!inner || !el.shadowRoot.contains(inner)) break;
      el = inner;
    }
    return el;
  };
  const paintOutline = (): void => {
    if (!outline) return;
    if (!hovered || !hovered.isConnected) {
      outline.style.display = 'none';
      return;
    }
    const r = hovered.getBoundingClientRect();
    outline.style.display = 'block';
    outline.style.left = `${r.left}px`;
    outline.style.top = `${r.top}px`;
    outline.style.width = `${r.width}px`;
    outline.style.height = `${r.height}px`;
  };
  const stopPick = (): boolean => {
    if (!layer) return false;
    layer.remove();
    layer = outline = hovered = null;
    return true;
  };
  const startPick = (): void => {
    if (layer || !document.documentElement) return;
    layer = document.createElement('div');
    layer.setAttribute('data-codeman-frame-bridge', '');
    layer.setAttribute('aria-hidden', 'true');
    layer.style.cssText =
      'all:initial;position:fixed;inset:0;width:auto;height:auto;margin:0;padding:0;border:0;background:transparent;overflow:visible;cursor:crosshair;z-index:2147483647;';
    outline = document.createElement('div');
    outline.style.cssText =
      'all:initial;position:fixed;display:none;box-sizing:border-box;pointer-events:none;border:2px solid #f58a45;background:rgba(245,138,69,.14);border-radius:2px;';
    layer.append(outline);
    document.documentElement.append(layer);
    try {
      // The top layer sits above every z-index and every open dialog of the page.
      layer.setAttribute('popover', 'manual');
      (layer as Dom).showPopover?.();
    } catch {
      /* Without the top layer the z-index above still covers an ordinary page. */
    }
  };
  const swallow = (e: Dom): void => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const pointerEvents = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'auxclick', 'contextmenu'];
  for (const name of pointerEvents)
    window.addEventListener(
      name,
      (e: Dom) => {
        if (layer) swallow(e);
      },
      true
    );
  window.addEventListener(
    'pointermove',
    (e: Dom) => {
      if (!layer) return;
      e.stopImmediatePropagation();
      hovered = elementAt(e.clientX, e.clientY);
      paintOutline();
    },
    true
  );
  window.addEventListener(
    'click',
    (e: Dom) => {
      if (!layer) return;
      swallow(e);
      const target = elementAt(e.clientX, e.clientY) ?? hovered;
      const element = target ? describe(target) : null;
      stopPick();
      post(element ? { type: 'codeman:frame-picked', element } : { type: 'codeman:frame-pick-cancelled' });
    },
    true
  );

  // ───────────── keys: Escape, and bare Q for the canvas lasso ─────────────
  let qDown = false;
  const typing = (e: Dom): boolean => {
    const target = (e.composedPath?.()[0] ?? e.target) as Dom;
    return (
      e.isComposing ||
      e.keyCode === 229 ||
      document.designMode === 'on' ||
      (!!target &&
        typeof target.closest === 'function' &&
        !!target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))
    );
  };
  window.addEventListener(
    'keydown',
    (e: Dom) => {
      if (e.key === 'Escape') {
        if (stopPick()) {
          swallow(e);
          post({ type: 'codeman:frame-pick-cancelled' });
        } else post({ type: 'codeman:canvas-escape' });
        return;
      }
      // Only this one key is ever reported, and never while the page is being typed into.
      if (e.key.toLowerCase() !== 'q' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.repeat || qDown || typing(e)) return;
      qDown = true;
      post({ type: 'codeman:frame-key', key: 'q', phase: 'down' });
    },
    true
  );
  const qUp = (): void => {
    if (!qDown) return;
    qDown = false;
    post({ type: 'codeman:frame-key', key: 'q', phase: 'up' });
  };
  window.addEventListener(
    'keyup',
    (e: Dom) => {
      if (e.key.toLowerCase() === 'q') qUp();
    },
    true
  );
  window.addEventListener('blur', qUp);

  // ───────────── requests from the canvas ─────────────
  const visible = (el: Dom, r: Dom): boolean => {
    if (r.width <= 0 || r.height <= 0) return false;
    if (r.right <= 0 || r.bottom <= 0 || r.left >= window.innerWidth || r.top >= window.innerHeight) return false;
    const check = el.checkVisibility;
    if (typeof check === 'function') return check.call(el, { checkOpacity: true, checkVisibilityCSS: true });
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  const inside = (x: number, y: number, polygon: number[][]): boolean => {
    let hit = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, yi] = polygon[i];
      const [xj, yj] = polygon[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  /** Visible elements whose box centre is in the loop: the outermost ones, never the page or a near-full-page wrapper. */
  const inPolygon = (points: unknown): Record<string, unknown>[] => {
    if (!Array.isArray(points) || points.length < 3 || points.length > limits.maxPoints) return [];
    const polygon: number[][] = [];
    for (const p of points) {
      if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return [];
      polygon.push([p[0], p[1]]);
    }
    const page = window.innerWidth * window.innerHeight;
    const matched = new Set<Dom>();
    let scanned = 0;
    const scan = (scope: Scope): void => {
      for (const el of Array.from<Dom>(scope.querySelectorAll('*'))) {
        if (++scanned > limits.maxScan) return;
        if (el.shadowRoot) scan(el.shadowRoot);
        if (el === document.documentElement || el === document.body || mine(el)) continue;
        const r = el.getBoundingClientRect();
        if (!visible(el, r) || r.width * r.height >= page * 0.8) continue;
        if (inside(r.left + r.width / 2, r.top + r.height / 2, polygon)) matched.add(el);
      }
    };
    scan(document);
    const elements: Record<string, unknown>[] = [];
    for (const el of matched) {
      let covered = false;
      for (let up = above(el); up && !covered; up = above(up)) covered = matched.has(up);
      if (covered) continue;
      const described = describe(el);
      if (described) elements.push(described);
      if (elements.length >= limits.maxElements) break;
    }
    return elements;
  };
  let watching = false;
  let changed: ReturnType<typeof setTimeout> | undefined;
  const rectsChanged = (): void => {
    if (!watching || changed !== undefined) return;
    changed = setTimeout(() => {
      changed = undefined;
      post({ type: 'codeman:frame-rects-changed' });
    }, 120);
  };
  window.addEventListener('scroll', rectsChanged, true);
  window.addEventListener('resize', rectsChanged);
  window.addEventListener('message', (e: Dom) => {
    if (e.source !== host) return;
    const data = e.data as { type?: unknown; requestId?: unknown; points?: unknown; selectors?: unknown } | null;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
    const requestId = typeof data.requestId === 'string' && data.requestId.length <= 64 ? data.requestId : null;
    switch (data.type) {
      case 'codeman:pick-start':
        startPick();
        break;
      case 'codeman:pick-stop':
        stopPick();
        break;
      case 'codeman:query-polygon':
        if (requestId) post({ type: 'codeman:frame-elements', requestId, elements: inPolygon(data.points) });
        break;
      case 'codeman:locate': {
        if (!requestId || !Array.isArray(data.selectors) || data.selectors.length > limits.maxSelectors) break;
        watching = true;
        const rects = data.selectors.map((selector) => {
          const el = resolve(selector);
          return el && el.isConnected ? boxOf(el) : null;
        });
        post({ type: 'codeman:frame-rects', requestId, rects });
        break;
      }
    }
  });
  post({ type: 'codeman:frame-ready' });
}

/* eslint-enable @typescript-eslint/no-explicit-any */
/**
 * The bridge as one inline script. `__name` is the helper some TypeScript runners wrap around named
 * functions; the frame has no such helper, so the script supplies a no-op of its own.
 *
 * The text is ASCII only. A page served without a charset, or in another one, would otherwise read the
 * script as different characters, and the hash that lets it past the page's policy would stop matching.
 */
export const FRAME_BRIDGE_SOURCE =
  `(function(){var __name=function(f){return f};(${frameBridge.toString()})(${JSON.stringify(FRAME_LIMITS)})})()`.replace(
    /[\u0080-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
export const FRAME_BRIDGE_SCRIPT = `<script>${FRAME_BRIDGE_SOURCE}</script>`;

/** Put the bridge first in the document, ahead of any script of the page's own. */
export function injectFrameBridge(html: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (head)
    return html.slice(0, head.index + head[0].length) + FRAME_BRIDGE_SCRIPT + html.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  const at = doctype ? doctype[0].length : 0;
  return html.slice(0, at) + FRAME_BRIDGE_SCRIPT + html.slice(at);
}
