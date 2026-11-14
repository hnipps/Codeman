// @vitest-environment jsdom
/**
 * Prototype capture, the parts that need no real browser: the states spec, the page serializer run in a
 * DOM, page assembly (tokens to local files, the runtime appended), and the runtime's click rules.
 * The browser suite (`prototype-capture.browser.test.ts`) drives a real app end to end.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CaptureSpecError,
  hotspotFor,
  parseCaptureSpec,
  statePagePath,
  stepsToReach,
} from '../src/canvas/capture-spec.js';
import { snapshotPage, snapshotSource, tokenizeCss, type Snapshot } from '../src/canvas/capture-page.js';
import {
  HIDE_HASH,
  HOTSPOT_ATTR,
  SCROLL_ATTR,
  captureRuntime,
  captureRuntimeScript,
  type CaptureRuntimeData,
} from '../src/canvas/capture-runtime.js';
import { assembleStatePage, assetExtension, replaceTokens } from '../src/canvas/prototype-capture.js';
import { forkId } from '../src/canvas/prototypes.js';

const base = 'http://app.test:4000/';
const spec = (states: unknown[], extra: Record<string, unknown> = {}) => ({ baseUrl: base, states, ...extra });

describe('the states spec', () => {
  it('parses a spec with defaults, and finds the hotspot and the steps of each state', () => {
    const parsed = parseCaptureSpec(
      spec([
        { name: 'home' },
        { name: 'settings', from: 'home', steps: [{ click: '#gear' }, { waitFor: '.modal' }] },
        { name: 'about', from: 'settings', steps: [{ type: '#q', text: 'x' }, { click: 'a.about' }], hotspot: '#more' },
        { name: 'deep', from: 'home', steps: [{ goto: '/deep' }] },
        { name: 'quiet', from: 'home', steps: [{ click: '#x' }], hotspot: false },
      ])
    );
    expect(parsed.viewports).toEqual([
      { name: 'desktop', width: 1280, height: 800, mobile: false, deviceScaleFactor: 1 },
    ]);
    expect(parsed.switcher).toBe(true);
    const [home, settings, about, deep, quiet] = parsed.states;
    expect(hotspotFor(home)).toBeNull();
    expect(hotspotFor(settings)).toEqual({ from: 'home', to: 'settings', selector: '#gear' });
    expect(hotspotFor(about)).toEqual({ from: 'settings', to: 'about', selector: '#more' });
    expect(hotspotFor(deep)).toBeNull();
    expect(hotspotFor(quiet)).toBeNull();
    expect(stepsToReach(parsed, 'about')).toEqual([
      { goto: '/' },
      { click: '#gear' },
      { waitFor: '.modal' },
      { type: '#q', text: 'x' },
      { click: 'a.about' },
    ]);
    expect(statePagePath('phone', 'about')).toBe('phone/about.html');
  });

  it('refuses what cannot be captured, naming the field', () => {
    const cases: [unknown, RegExp][] = [
      [{ states: [{ name: 'a' }] }, /baseUrl/],
      [spec([]), /states/],
      [spec([{ name: 'A b' }]), /states\.0\.name/],
      [spec([{ name: 'a' }, { name: 'a' }]), /listed twice/],
      [spec([{ name: 'b', from: 'a' }, { name: 'a' }]), /not an earlier state/],
      [spec([{ name: 'a', from: 'a' }]), /not an earlier state/],
      [spec([{ name: 'a', steps: [{ goto: 'https://elsewhere.test/' }] }]), /leaves/],
      [spec([{ name: 'a', steps: [{ click: '#x', wait: 3 }] }]), /steps/],
      [spec([{ name: 'a', steps: [{ wait: 999_999 }] }]), /steps/],
      [spec([{ name: 'a' }], { baseUrl: 'ftp://x.test/' }), /http or https/],
      [spec([{ name: 'a' }], { viewports: [] }), /viewports/],
      [spec([{ name: 'a' }], { extra: 1 }), /Unrecognized|extra/],
      [
        spec([{ name: 'a' }], {
          viewports: [
            { name: 'd', width: 800, height: 600 },
            { name: 'd', width: 400, height: 600 },
          ],
        }),
        /listed twice/,
      ],
    ];
    for (const [input, message] of cases) {
      expect(() => parseCaptureSpec(input), String(message)).toThrow(CaptureSpecError);
      expect(() => parseCaptureSpec(input), String(message)).toThrow(message);
    }
  });
});

describe('CSS addresses', () => {
  it('tokenizes url() and @import against the base, leaving data: and #fragment references alone', () => {
    const seen: string[] = [];
    const out = tokenizeCss(
      `@import "theme.css"; a{background:url(img/a.png)} b{background:url('/b.png')} c{mask:url(#m)} d{background:url(data:image/png;base64,AA==)} @font-face{src:url( "https://cdn.test/f.woff2" )}`,
      'http://app.test:4000/css/site.css',
      (absolute) => {
        seen.push(absolute);
        return `T${seen.length - 1}`;
      }
    );
    expect(seen).toEqual([
      'http://app.test:4000/css/img/a.png',
      'http://app.test:4000/b.png',
      'https://cdn.test/f.woff2',
      'http://app.test:4000/css/theme.css',
    ]);
    expect(out).toContain('@import url("T3")');
    expect(out).toContain('url("T0")');
    expect(out).toContain('url(#m)');
    expect(out).toContain('url(data:image/png;base64,AA==)');
  });

  it('names stored assets by type, refusing types a prototype cannot hold', () => {
    expect(assetExtension('image/png; charset=binary', 'http://x/a')).toBe('png');
    expect(assetExtension(null, 'http://x/font.woff2?v=3')).toBe('woff2');
    expect(assetExtension('font/otf', 'http://x/a')).toBe('ttf');
    expect(assetExtension('image/avif', 'http://x/a.avif')).toBeNull();
    expect(assetExtension('text/javascript', 'http://x/a.js')).toBeNull();
    expect(assetExtension('text/html', 'http://x/page')).toBeNull();
  });
});

describe('the page serializer', () => {
  afterEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    for (const attr of Array.from(document.documentElement.attributes))
      document.documentElement.removeAttribute(attr.name);
  });

  const here = new URL('/', document.baseURI).href;
  function snap(): Snapshot {
    return snapshotPage({ nonce: 'n1', inlineStyleMax: 64 }, tokenizeCss);
  }

  it('drops scripts and handlers, keeps form state but never a password, and tokenizes resources', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.head.innerHTML =
      '<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="x"><base href="/">' +
      '<title>App &amp; co</title><link rel="stylesheet" href="/site.css" media="screen">' +
      '<link rel="preload" href="/x.js"><style>.a{background:url(/bg.png)}</style>' +
      '<script>window.x=1</script>';
    document.body.innerHTML =
      '<main id="app" onclick="evil()"><img src="/logo.png" srcset="/logo@2x.png 2x" loading="lazy" alt="Logo">' +
      '<a href="javascript:alert(1)">bad</a><a href="/settings">settings</a>' +
      '<input id="name"><input id="pw" type="password"><input id="cb" type="checkbox">' +
      '<textarea id="t"></textarea><select id="s"><option>a</option><option>b</option></select>' +
      '<div style="background-image:url(&quot;/tile.png&quot;)">x &lt; y</div>' +
      '<svg viewBox="0 0 10 10"><use href="/sprite.svg#icon"></use><use href="#local"></use></svg>' +
      '<iframe src="https://elsewhere.test/"></iframe><video src="/v.mp4" poster="/poster.png" autoplay></video>' +
      '<noscript>enable js</noscript><script src="/app.js"></script></main>';
    (document.getElementById('name') as HTMLInputElement).value = 'Harry';
    (document.getElementById('pw') as HTMLInputElement).value = 'secret';
    (document.getElementById('cb') as HTMLInputElement).checked = true;
    (document.getElementById('t') as HTMLTextAreaElement).value = 'typed <b>';
    (document.getElementById('s') as HTMLSelectElement).selectedIndex = 1;
    const shot = snap();
    const html = shot.html;
    expect(html).not.toMatch(/<script|onclick|evil|enable js|rel="preload"|<base|http-equiv|<meta/i);
    expect(html).toContain('<html data-theme="dark">');
    expect(html).toContain('<title>App &amp; co</title>');
    expect(html).toContain('value="Harry"');
    expect(html).not.toContain('secret');
    expect(html).toMatch(/<input id="cb" type="checkbox" checked>/);
    expect(html).toContain('<textarea id="t">typed &lt;b&gt;</textarea>');
    expect(html).toMatch(/<option selected>b<\/option>/);
    expect(html).toContain('<a href="#">bad</a>');
    expect(html).toContain('<a href="/settings">');
    expect(html).toContain('x &lt; y');
    expect(html).not.toContain('srcset');
    expect(html).not.toContain('loading=');
    expect(html).toContain('<use href="#local">');
    expect(html).toContain('<iframe></iframe>');
    expect(html).toMatch(/<video poster="__ccan1_\d+__" preload="none"><\/video>/);
    expect(shot.urls).toEqual(
      expect.arrayContaining([
        `${here}logo.png`,
        `${here}tile.png`,
        `${here}sprite.svg`,
        `${here}poster.png`,
        `${here}bg.png`,
      ])
    );
    expect(shot.urls).not.toContain(`${here}v.mp4`);
    expect(shot.urls).not.toContain('https://elsewhere.test/');
    expect(html).toMatch(/<use href="__ccan1_\d+__#icon">/);
    expect(shot.sheets).toEqual([
      { kind: 'link', text: null, href: `${here}site.css`, media: 'screen', inline: false },
      expect.objectContaining({ kind: 'style', inline: true, media: '' }),
    ]);
    expect(shot.sheets[1].text).toMatch(/url\("__ccan1_\d+__"\)/);
    expect(html).toContain('<!--ccan1-sheet-0-->');
    expect(shot.title).toBe('App & co');
  });

  it('writes an open shadow root as a declarative template and records scroll offsets', () => {
    const host = document.createElement('x-card');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>p{color:red}</style><p>inside</p>';
    const list = document.createElement('div');
    list.id = 'list';
    document.body.append(list);
    Object.defineProperty(list, 'scrollTop', { value: 120 });
    const html = snap().html;
    expect(html).toMatch(
      /<x-card><template shadowrootmode="open"><!--ccan1-sheet-\d+--><p>inside<\/p><\/template><\/x-card>/
    );
    expect(html).toContain(`<div id="list" ${SCROLL_ATTR}="0,120">`);
  });

  it('runs from its shipped source text, as the capture evaluates it', () => {
    document.body.innerHTML = '<p id="p">hello</p><script>1</script>';
    const shot = (0, eval)(snapshotSource({ nonce: 'abc', inlineStyleMax: 10 })) as Snapshot;
    expect(shot.html).toContain('<p id="p">hello</p>');
    expect(shot.html).not.toContain('<script');
  });
});

describe('page assembly', () => {
  const runtime: CaptureRuntimeData = {
    state: 'home',
    viewport: 'desktop',
    states: [
      { name: 'home', label: 'Home </script><b>', href: 'home.html' },
      { name: 'settings', label: 'Settings', href: 'settings.html' },
    ],
    viewports: [{ name: 'desktop', href: '../desktop/home.html' }],
    index: '../index.html',
    switcher: true,
  };

  it('fills sheets and tokens with local files and leaves no address that reaches the network', () => {
    const html =
      '<!doctype html>\n<html><head><!--ccaN-sheet-0--><title>t</title></head><body>' +
      '<img src="__ccaN_0__"><div style="background:url(&quot;__ccaN_1__&quot;)"></div>' +
      '<canvas style="background:url(&quot;__ccaN_c0__&quot;) 0 0/100% 100%"></canvas></body></html>';
    const page = assembleStatePage({
      html,
      nonce: 'N',
      sheets: ['<link rel="stylesheet" href="../assets/s.css">'],
      path: (key) => ({ '0': '../assets/a.png', c0: '../assets/c.png' })[key] ?? null,
      runtime,
    });
    expect(
      page.startsWith(
        '<!doctype html>\n<html><head><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="../assets/s.css">'
      )
    ).toBe(true);
    expect(page).toContain('<img src="../assets/a.png">');
    expect(page).toContain('url(&quot;data:,&quot;)');
    expect(page).toContain('../assets/c.png');
    expect(page).not.toMatch(/__cca/);
    const withoutRuntime = page.replace(/<script data-codeman-capture-runtime>[\s\S]*?<\/script>/, '');
    expect(withoutRuntime).not.toMatch(/(src|href)="(https?:)?\/\//);
    expect(withoutRuntime).not.toMatch(/url\((&quot;|"|')?(https?:)?\/\//);
    expect(page.indexOf('<script data-codeman-capture-runtime>')).toBeLessThan(page.indexOf('</body>'));
    // The label's </script> cannot close the runtime early, and the script is ASCII.
    const script = page.slice(page.indexOf('<script data-codeman-capture-runtime>'), page.indexOf('</body>'));
    expect(script.match(/<\/script/gi)).toHaveLength(1);
    expect(script).toMatch(/^[\x00-\x7f]*$/);
    expect(replaceTokens('a __ccaN_7__ b', 'N', () => null)).toBe('a data:, b');
  });

  it('keeps the runtime source free of anything that would end its script element', () => {
    expect(captureRuntime.toString()).not.toMatch(/<\//);
    expect(captureRuntimeScript(runtime)).toContain('\\u003c/script>');
  });
});

describe('the runtime in a page', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    document.querySelectorAll('codeman-capture-switcher,[data-codeman-frame-bridge]').forEach((el) => el.remove());
  });
  const data = (switcher: boolean): CaptureRuntimeData => ({
    state: 'home',
    viewport: 'desktop',
    states: [
      { name: 'home', label: 'Home', href: 'home.html' },
      { name: 'settings', label: 'Settings', href: 'settings.html' },
    ],
    viewports: [
      { name: 'desktop', href: '../desktop/home.html' },
      { name: 'phone', href: '../phone/home.html' },
    ],
    index: '../index.html',
    switcher,
  });
  const click = (el: Element) => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true });
    el.dispatchEvent(event);
    return event;
  };

  it('holds the page still: a hotspot click is taken, a link and a submit go nowhere, a plain click passes', () => {
    document.body.innerHTML =
      `<button id="go" ${HOTSPOT_ATTR}="settings.html"><span id="inner">Open</span></button>` +
      '<a id="link" href="/elsewhere">away</a><form><button id="submit">Save</button></form><p id="plain">text</p>' +
      `<div id="scroller" ${SCROLL_ATTR}="5,40" style="height:10px;overflow:auto"><div style="height:200px"></div></div>`;
    captureRuntime(data(false));
    // jsdom does not navigate; the hotspot click is still claimed by the runtime.
    expect(click(document.getElementById('inner')!).defaultPrevented).toBe(true);
    expect(click(document.getElementById('link')!).defaultPrevented).toBe(true);
    expect(click(document.getElementById('submit')!).defaultPrevented).toBe(true);
    expect(click(document.getElementById('plain')!).defaultPrevented).toBe(false);
    expect((document.getElementById('scroller') as HTMLElement).scrollTop).toBe(40);
    expect(document.querySelector('codeman-capture-switcher')).toBeNull();
  });

  it('stands down while the canvas picks an element, so a pick never navigates', () => {
    document.body.innerHTML = `<button id="go" ${HOTSPOT_ATTR}="settings.html">Open</button>`;
    captureRuntime(data(false));
    const layer = document.createElement('div');
    layer.setAttribute('data-codeman-frame-bridge', '');
    document.documentElement.append(layer);
    expect(click(document.getElementById('go')!).defaultPrevented).toBe(false);
  });

  it('adds one switcher outside <body>, in a closed shadow root', () => {
    document.body.innerHTML = '<p>page</p>';
    captureRuntime(data(true));
    const host = document.querySelector('codeman-capture-switcher')!;
    expect(host.parentElement).toBe(document.documentElement);
    expect(host.shadowRoot).toBeNull();
    expect(document.body.querySelector('codeman-capture-switcher')).toBeNull();
    expect(HIDE_HASH).toBe('#cca-hide');
  });
});

describe('fork ids', () => {
  it('takes the next free <source>-fork name', () => {
    expect(forkId('demo', new Set())).toBe('demo-fork');
    expect(forkId('demo', new Set(['demo-fork', 'demo-fork-2']))).toBe('demo-fork-3');
    expect(forkId('a'.repeat(63), new Set())).toMatch(/^a{50}-fork$/);
  });
});
