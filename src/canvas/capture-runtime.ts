/**
 * @fileoverview The small script every captured state page carries, so a captured prototype can be
 * clicked through: hotspots that open the next state, scroll offsets put back, the page's own links and
 * forms held still, and a compact state switcher.
 *
 * `captureRuntime` is shipped as source text, like `frameBridge`: no import, no reference to anything
 * outside its body, its data arrives as its one argument. It uses no storage (a prototype frame has an
 * opaque origin, where storage throws), makes no request, and never throws out of a handler.
 *
 * ⚠️ Element Pick belongs to the canvas. The frame bridge is injected ahead of this script and swallows
 * every click while it picks; this script also stands down whenever the bridge's pick layer
 * (`[data-codeman-frame-bridge]`) is in the document, so a click in pick mode never navigates.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Dom = any;

export interface CaptureRuntimeData {
  /** This page's state. */
  state: string;
  viewport: string;
  /** Every state, in spec order, with its page at this viewport (relative to this page). */
  states: { name: string; label: string; href: string }[];
  /** This state at every viewport (relative to this page); one entry means no viewport choice. */
  viewports: { name: string; href: string }[];
  /** The gallery page of every state, relative to this page. */
  index: string;
  switcher: boolean;
}

/** Attribute a capture puts on the element that opens another state; its value is that page's href. */
export const HOTSPOT_ATTR = 'data-cca-hotspot';
/** Attribute holding an element's scroll offset at capture time, `left,top`. */
export const SCROLL_ATTR = 'data-cca-scroll';
/** The hash that keeps the switcher hidden across hotspot navigation. */
export const HIDE_HASH = '#cca-hide';

export function captureRuntime(data: CaptureRuntimeData): void {
  const window: Dom = globalThis;
  const document: Dom = window.document;
  const HOTSPOT = 'data-cca-hotspot';
  const SCROLL = 'data-cca-scroll';
  const HIDE = '#cca-hide';
  const safe =
    (fn: (...args: Dom[]) => void) =>
    (...args: Dom[]): void => {
      try {
        fn(...args);
      } catch {
        /* A prototype page never reports an error of its own making. */
      }
    };
  let hidden = window.location.hash === HIDE;
  const go = (href: string): void => {
    window.location.href = href + (hidden ? HIDE : '');
  };
  const picking = (): boolean => !!document.querySelector('[data-codeman-frame-bridge]');

  // Scroll offsets, through open shadow roots too.
  const restore = (scope: Dom): void => {
    for (const el of Array.from<Dom>(scope.querySelectorAll(`[${SCROLL}]`))) {
      const [left, top] = String(el.getAttribute(SCROLL)).split(',').map(Number);
      if (el === document.documentElement) window.scrollTo(left || 0, top || 0);
      else {
        el.scrollLeft = left || 0;
        el.scrollTop = top || 0;
      }
    }
    for (const el of Array.from<Dom>(scope.querySelectorAll('*'))) if (el.shadowRoot) restore(el.shadowRoot);
  };
  safe(restore)(document);
  window.addEventListener(
    'load',
    safe(() => restore(document))
  );

  let host: Dom = null;
  const hotspots = (): Dom[] => {
    const found: Dom[] = [];
    const scan = (scope: Dom): void => {
      for (const el of Array.from<Dom>(scope.querySelectorAll('*'))) {
        if (el.hasAttribute(HOTSPOT)) found.push(el);
        if (el.shadowRoot) scan(el.shadowRoot);
      }
    };
    scan(document);
    return found;
  };
  let flashing = false;
  /** A click that leads nowhere shows, briefly, where the clicks that lead somewhere are. */
  const flash = (): void => {
    if (flashing) return;
    const all = hotspots();
    if (!all.length) return;
    flashing = true;
    const saved = all.map((el) => [el, el.style.getPropertyValue('outline'), el.style.getPropertyPriority('outline')]);
    for (const el of all) el.style.setProperty('outline', '2px solid rgba(59,130,246,.9)', 'important');
    window.setTimeout(
      safe(() => {
        for (const [el, value, priority] of saved) {
          if (value) el.style.setProperty('outline', value, priority);
          else el.style.removeProperty('outline');
          if (!el.getAttribute('style')) el.removeAttribute('style');
        }
        flashing = false;
      }),
      700
    );
  };

  window.addEventListener(
    'click',
    safe((e: Dom) => {
      if (picking()) return;
      const path: Dom[] = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
      if (host && path.includes(host)) return;
      for (const el of path) {
        if (!el || typeof el.getAttribute !== 'function') continue;
        const target = el.getAttribute(HOTSPOT);
        if (target) {
          e.preventDefault();
          e.stopPropagation();
          go(target);
          return;
        }
      }
      // The page's own links and submit buttons lead to pages the prototype does not hold.
      const leads = path.some(
        (el) =>
          el &&
          typeof el.localName === 'string' &&
          ((el.localName === 'a' && el.hasAttribute('href')) ||
            ((el.localName === 'button' || el.localName === 'input') && el.type === 'submit' && el.form))
      );
      if (leads) e.preventDefault();
      flash();
    }),
    true
  );
  window.addEventListener(
    'submit',
    safe((e: Dom) => e.preventDefault()),
    true
  );

  if (!data.switcher || !document.documentElement) return;

  // The switcher: a closed shadow root on an element after <body>, so the page's own styles and
  // selectors never meet it.
  host = document.createElement('codeman-capture-switcher');
  host.setAttribute('aria-label', 'Prototype states');
  host.style.cssText = 'all:initial;position:fixed;right:8px;bottom:8px;z-index:2147483646;';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font:12px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif}',
    '.pill{display:flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:13px;border:1px solid rgba(255,255,255,.18);background:rgba(20,22,26,.78);color:#e8eaed;cursor:pointer;opacity:.6;transition:opacity .15s}',
    '.pill:hover,.pill:focus-visible,.open .pill{opacity:1}',
    '.dot{width:10px;height:10px;padding:0;border-radius:5px;border:1px solid rgba(255,255,255,.3);background:rgba(20,22,26,.5);cursor:pointer;opacity:.5}',
    '.panel{position:absolute;right:0;bottom:32px;min-width:200px;max-width:min(320px,calc(100vw - 16px));max-height:min(420px,calc(100vh - 48px));overflow:auto;padding:6px;border-radius:8px;border:1px solid rgba(255,255,255,.14);background:rgba(20,22,26,.96);color:#e8eaed;box-shadow:0 8px 24px rgba(0,0,0,.35)}',
    '.head{padding:4px 6px;color:#9aa0a6;font-size:11px;text-transform:uppercase;letter-spacing:.04em}',
    'button.item{display:block;width:100%;text-align:left;padding:6px 8px;border:0;border-radius:5px;background:none;color:inherit;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    'button.item:hover,button.item:focus-visible{background:rgba(255,255,255,.08)}',
    'button.item[aria-current="page"]{color:#8ab4f8}',
    '.row{display:flex;gap:4px;padding:4px 2px;border-top:1px solid rgba(255,255,255,.08);margin-top:4px}',
    '.row button{flex:1;padding:5px 6px;border:1px solid rgba(255,255,255,.14);border-radius:5px;background:none;color:inherit;cursor:pointer}',
    '.row button[aria-pressed="true"]{border-color:#8ab4f8;color:#8ab4f8}',
  ].join('');
  root.append(style);
  const wrap = document.createElement('div');
  root.append(wrap);
  const button = (cls: string, text: string, onClick: () => void): Dom => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    b.addEventListener('click', safe(onClick));
    return b;
  };
  const current = data.states.find((s) => s.name === data.state);
  const position = data.states.findIndex((s) => s.name === data.state) + 1;
  let open = false;
  const paint = (): void => {
    wrap.replaceChildren();
    wrap.className = open ? 'open' : '';
    if (hidden) {
      const dot = button('dot', '', () => {
        hidden = false;
        paint();
      });
      dot.title = 'Show prototype states';
      dot.setAttribute('aria-label', 'Show prototype states');
      wrap.append(dot);
      return;
    }
    if (open) {
      const panel = document.createElement('div');
      panel.className = 'panel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'Prototype states');
      const head = document.createElement('div');
      head.className = 'head';
      head.textContent = 'States';
      panel.append(head);
      for (const state of data.states) {
        const item = button('item', state.label, () => go(state.href));
        if (state.name === data.state) item.setAttribute('aria-current', 'page');
        panel.append(item);
      }
      if (data.viewports.length > 1) {
        const row = document.createElement('div');
        row.className = 'row';
        for (const viewport of data.viewports) {
          const b = button('', viewport.name, () => go(viewport.href));
          b.setAttribute('aria-pressed', String(viewport.name === data.viewport));
          row.append(b);
        }
        panel.append(row);
      }
      const row = document.createElement('div');
      row.className = 'row';
      row.append(
        button('', 'All states', () => go(data.index)),
        button('', 'Hide', () => {
          hidden = true;
          open = false;
          paint();
        })
      );
      panel.append(row);
      wrap.append(panel);
    }
    const pill = button('pill', `${current ? current.label : data.state} · ${position}/${data.states.length}`, () => {
      open = !open;
      paint();
    });
    pill.setAttribute('aria-expanded', String(open));
    pill.title = 'Prototype states';
    wrap.append(pill);
  };
  root.addEventListener(
    'keydown',
    safe((e: Dom) => {
      if (e.key === 'Escape' && open) {
        open = false;
        paint();
      }
    })
  );
  paint();
  document.documentElement.append(host);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** The runtime as one inline script with its data. ASCII only, `<` escaped, like the frame bridge. */
export function captureRuntimeScript(data: CaptureRuntimeData): string {
  // In JSON a `<` only ever sits inside a string, where < means the same; the function's own
  // source has no `</` (pinned by the unit test), so neither half can close the script element.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const source = `(function(){var __name=function(f){return f};(${captureRuntime.toString()})(${json})})()`;
  const ascii = source.replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `<script data-codeman-capture-runtime>${ascii}</script>`;
}
