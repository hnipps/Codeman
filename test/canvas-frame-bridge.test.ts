// @vitest-environment jsdom
/**
 * The frame bridge as it ships: the inline script's own text, run in a DOM. Layout does not exist here,
 * so boxes are stubbed; the browser suite (`canvas-elements.browser.test.ts`) covers real geometry.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  FRAME_BRIDGE_SCRIPT,
  FRAME_BRIDGE_SOURCE,
  FRAME_LIMITS,
  injectFrameBridge,
} from '../src/canvas/frame-bridge.js';
import { ElementRefSchema, MAX_ELEMENT_REFS } from '../src/canvas/element-ref.js';
import { parseFrameMessage } from '../packages/canvas/src/frame-messages.js';
import { allowFrameBridge, rewriteHtml } from '../src/web/webview-proxy.js';

type Posted = Record<string, unknown> & { type: string };
const posted: Posted[] = [];
/** Stands in for the canvas: a real window, so the bridge's own source check is exercised. */
let parentWindow: Window;
const boxes = new Map<Element, { x: number; y: number; width: number; height: number }>();

const fromParent = (data: unknown, source: Window | null = parentWindow) =>
  window.dispatchEvent(new MessageEvent('message', { data, source }));
const last = (type: string) => posted.filter((m) => m.type === type).at(-1);
const place = (el: Element, x: number, y: number, width: number, height: number) =>
  boxes.set(el, { x, y, width, height });
const ask = (data: Record<string, unknown>) => {
  posted.length = 0;
  fromParent(data);
  return posted[0];
};
const locate = (selector: string) => {
  const reply = ask({ type: 'codeman:locate', requestId: 'r', selectors: [selector] });
  return (reply.rects as unknown[])[0];
};
const pick = (el: Element) => {
  fromParent({ type: 'codeman:pick-start' });
  const box = boxes.get(el) ?? { x: 0, y: 0, width: 10, height: 10 };
  (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => {
    const chain: Element[] = [];
    for (let at: Element | null = el; at; at = at.parentElement) chain.push(at);
    return chain;
  };
  posted.length = 0;
  window.dispatchEvent(
    new MouseEvent('click', { clientX: box.x + 1, clientY: box.y + 1, bubbles: true, cancelable: true })
  );
  return last('codeman:frame-picked')?.element as Record<string, unknown> | undefined;
};

beforeAll(() => {
  const holder = document.createElement('iframe');
  document.documentElement.append(holder);
  parentWindow = holder.contentWindow as Window;
  parentWindow.postMessage = ((message: Posted) => void posted.push(message)) as typeof parentWindow.postMessage;
  Object.defineProperty(window, 'parent', { value: parentWindow, configurable: true });
  Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const b = boxes.get(this) ?? { x: 0, y: 0, width: 0, height: 0 };
    return { ...b, left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height, toJSON: () => b } as DOMRect;
  };
  new Function(FRAME_BRIDGE_SOURCE)();
});
beforeEach(() => {
  fromParent({ type: 'codeman:pick-stop' });
  boxes.clear();
  document.body.innerHTML = `
    <main id="app" data-source="src/App.tsx:3">
      <section class="lanes wide">
        <article class="card"><h3>First</h3><button data-testid="go">Start task</button></article>
        <article class="card"><h3>Second</h3><button>Stop</button><button>Retry</button></article>
      </section>
      <form>
        <input id="1st" name="user" value="alice" placeholder="Name">
        <input type="password" name="secret" value="hunter2" aria-label="Password">
        <img alt="A chart" src="/chart.png">
        <p id="twin">one</p><p id="twin">two</p>
      </form>
    </main>`;
  posted.length = 0;
});

describe('the frame bridge script', () => {
  it('is one inline script that cannot close itself, and goes first in the document', () => {
    expect(FRAME_BRIDGE_SCRIPT).toBe(`<script>${FRAME_BRIDGE_SOURCE}</script>`);
    expect(FRAME_BRIDGE_SOURCE).not.toMatch(/<\/script|<!--/i);
    // A page in another charset must read the same script, or its hash stops matching.
    expect(FRAME_BRIDGE_SOURCE).toMatch(/^[\x00-\x7f]+$/);
    expect(FRAME_BRIDGE_SOURCE.length).toBeLessThan(24_000);
    expect(injectFrameBridge('<!doctype html><html><head><script src=a.js></script></head></html>')).toBe(
      `<!doctype html><html><head>${FRAME_BRIDGE_SCRIPT}<script src=a.js></script></head></html>`
    );
    expect(injectFrameBridge('<!doctype html><p>bare</p>')).toBe(`<!doctype html>${FRAME_BRIDGE_SCRIPT}<p>bare</p>`);
    expect(rewriteHtml('<html><head></head></html>', 'cap', '', { frameBridge: true })).toContain(FRAME_BRIDGE_SCRIPT);
    expect(rewriteHtml('<html><head></head></html>', 'cap', '')).not.toContain('codeman:frame-ready');
  });
  it('announces itself, shows nothing, and answers only its parent', () => {
    // The script ran in beforeAll; nothing of it is in the page until picking starts.
    expect(document.querySelector('[data-codeman-frame-bridge]')).toBe(null);
    fromParent({ type: 'codeman:pick-start' }, window);
    fromParent({ type: 'codeman:pick-start' }, null);
    expect(document.querySelector('[data-codeman-frame-bridge]')).toBe(null);
    fromParent({ type: 'codeman:locate', requestId: 'r', selectors: ['#app'] }, window);
    expect(posted).toEqual([]);
    fromParent({ type: 'codeman:pick-start' });
    expect(document.querySelector('[data-codeman-frame-bridge]')).not.toBe(null);
    fromParent({ type: 'codeman:pick-stop' });
    expect(document.querySelector('[data-codeman-frame-bridge]')).toBe(null);
  });
});

describe('keys', () => {
  const key = (type: string, init: KeyboardEventInit, target: EventTarget = document.body) =>
    target.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));
  it('relays Escape as before', () => {
    key('keydown', { key: 'Escape' });
    expect(posted).toEqual([{ type: 'codeman:canvas-escape' }]);
  });
  it('reports bare Q going down and up, once', () => {
    key('keydown', { key: 'q' });
    key('keydown', { key: 'q', repeat: true });
    key('keyup', { key: 'q' });
    key('keyup', { key: 'q' });
    expect(posted).toEqual([
      { type: 'codeman:frame-key', key: 'q', phase: 'down' },
      { type: 'codeman:frame-key', key: 'q', phase: 'up' },
    ]);
  });
  it('reports no other key, no chord, and nothing typed into a field', () => {
    for (const k of ['a', 'w', 'Enter', ' ', '1', 'Tab', 'Backspace']) {
      key('keydown', { key: k });
      key('keyup', { key: k });
    }
    for (const chord of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }])
      key('keydown', { key: 'q', ...chord });
    key('keydown', { key: 'q' }, document.querySelector('input')!);
    key('keydown', { key: 'q', isComposing: true });
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', '');
    document.body.append(editable);
    key('keydown', { key: 'q' }, editable);
    expect(posted).toEqual([]);
  });
  it('lets go of Q when the frame loses the keyboard', () => {
    key('keydown', { key: 'q' });
    window.dispatchEvent(new Event('blur'));
    expect(posted.map((m) => m.phase)).toEqual(['down', 'up']);
  });
});

describe('describing an element', () => {
  it('prefers an id, then a test id, then a short chain, and every selector finds exactly its element', () => {
    const cases: [Element, string][] = [
      [document.querySelector('#app')!, '#app'],
      [document.querySelector('[data-testid=go]')!, '[data-testid="go"]'],
      [
        document.querySelectorAll('article')[1].querySelectorAll('button')[0],
        'article:nth-of-type(2) > button:nth-of-type(1)',
      ],
      [document.querySelectorAll('article')[1].querySelectorAll('button')[1], 'button:nth-of-type(2)'],
      [document.querySelector('h3')!, 'article:nth-of-type(1) > h3:nth-of-type(1)'],
      [document.querySelector('[name=user]')!, '[id="1st"]'],
      [document.querySelectorAll('#twin')[1], 'p:nth-of-type(2)'],
      [document.querySelector('img')!, 'img:nth-of-type(1)'],
    ];
    for (const [el, expected] of cases) {
      const element = pick(el)!;
      expect(element.selector).toBe(expected);
      const found = document.querySelectorAll(element.selector as string);
      expect([found.length, found[0]]).toEqual([1, el]);
    }
  });
  it('reports what the schema takes, with the page-marked source and bounded values', () => {
    const button = document.querySelector('[data-testid=go]')!;
    button.setAttribute('title', 't'.repeat(900));
    place(button, 40, 60, 120, 32);
    const element = pick(button)!;
    const parsed = ElementRefSchema.parse({ ...element, objectId: 'embed-1' });
    expect(parsed).toMatchObject({
      tag: 'button',
      text: 'Start task',
      path: 'main#app > section.lanes > article.card > button',
      rect: { x: 40, y: 60, width: 120, height: 32 },
      source: 'src/App.tsx:3',
    });
    expect(parsed.attrs['data-testid']).toBe('go');
    expect(parsed.attrs.title).toHaveLength(FRAME_LIMITS.attr);
    expect(Object.keys(parsed.styles).length).toBeGreaterThan(0);
    expect(parseFrameMessage({ type: 'codeman:frame-picked', element }, 'embed-1')?.type).toBe('picked');
  });
  it('falls back from text to a label, alt text or a placeholder, and never reports what was typed', () => {
    expect(pick(document.querySelector('img')!)!.text).toBe('A chart');
    const user = document.querySelector('[name=user]') as HTMLInputElement;
    user.value = 'typed by the person';
    const field = pick(user)!;
    expect(field.text).toBe('Name');
    expect(JSON.stringify(field)).not.toMatch(/alice|typed by the person/);
    const secret = document.querySelector('[name=secret]') as HTMLInputElement;
    secret.removeAttribute('aria-label');
    const element = pick(secret)!;
    expect(element.text).toBe('');
    expect(JSON.stringify(element)).not.toContain('hunter2');
    const note = document.createElement('div');
    note.setAttribute('contenteditable', 'true');
    note.setAttribute('aria-label', 'Notes');
    note.textContent = 'written by the person';
    Object.defineProperty(note, 'isContentEditable', { value: true });
    const wrap = document.createElement('section');
    wrap.append(note);
    document.body.append(wrap);
    expect(pick(note)!.text).toBe('Notes');
    expect(JSON.stringify([pick(note), pick(wrap)])).not.toContain('written by the person');
    const go = document.createElement('input');
    go.type = 'submit';
    go.value = 'Send order';
    document.body.append(go);
    expect(pick(go)!.text).toBe('Send order');
    const long = document.querySelector('h3')!;
    long.textContent = `  ${'x'.repeat(5000)}  `;
    expect((pick(long)!.text as string).length).toBe(FRAME_LIMITS.text);
  });
  it('reaches into an open shadow root and finds the element again', () => {
    const hostEl = document.createElement('x-panel');
    hostEl.id = 'panel';
    document.body.append(hostEl);
    const root = hostEl.attachShadow({ mode: 'open' });
    root.innerHTML = '<div><button>Inner</button><button id="b2">Two</button></div>';
    const inner = root.querySelector('#b2')!;
    place(inner, 5, 6, 70, 20);
    const element = pick(inner)!;
    expect(element.selector).toBe('#panel >>> #b2');
    expect(element.text).toBe('Two');
    expect(locate('#panel >>> #b2')).toEqual({ x: 5, y: 6, width: 70, height: 20 });
    expect(locate('#panel >>> div > button:nth-of-type(1)')).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('picking', () => {
  it('takes the click away from the page and reports the element', () => {
    let clicks = 0;
    const button = document.querySelector('[data-testid=go]')!;
    button.addEventListener('click', () => clicks++);
    document.addEventListener('click', () => clicks++, true);
    expect(pick(button)!.selector).toBe('[data-testid="go"]');
    expect(clicks).toBe(0);
    // One click, one element: picking is over and the page has its clicks back.
    expect(document.querySelector('[data-codeman-frame-bridge]')).toBe(null);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(clicks).toBe(2);
  });
  it('is cancelled by Escape without handing the keyboard back', () => {
    fromParent({ type: 'codeman:pick-start' });
    posted.length = 0;
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(posted).toEqual([{ type: 'codeman:frame-pick-cancelled' }]);
    expect(document.querySelector('[data-codeman-frame-bridge]')).toBe(null);
  });
});

describe('requests from the canvas', () => {
  it('locates selectors, answers null for what is missing or malformed, and ignores an oversized request', () => {
    place(document.querySelector('#app')!, 0, 0, 300, 200);
    const reply = ask({ type: 'codeman:locate', requestId: 'r7', selectors: ['#app', '#nope', ':::bad', 42, ''] });
    expect(reply).toEqual({
      type: 'codeman:frame-rects',
      requestId: 'r7',
      rects: [{ x: 0, y: 0, width: 300, height: 200 }, null, null, null, null],
    });
    expect(parseFrameMessage(reply, 'e')?.type).toBe('rects');
    expect(
      ask({ type: 'codeman:locate', requestId: 'r', selectors: Array(FRAME_LIMITS.maxSelectors + 1).fill('#app') })
    ).toBeUndefined();
    expect(ask({ type: 'codeman:locate', selectors: ['#app'] })).toBeUndefined();
    expect(ask({ type: 'codeman:locate', requestId: 'x'.repeat(65), selectors: ['#app'] })).toBeUndefined();
  });
  it('says its rectangles changed only once it has been asked for some', async () => {
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    await new Promise((done) => setTimeout(done, 200));
    expect(last('codeman:frame-rects-changed')).toBeDefined();
    expect(posted.filter((m) => m.type === 'codeman:frame-rects-changed')).toHaveLength(1);
  });
  it('answers a loop with the outermost visible elements inside it, never the page or a near-full wrapper', () => {
    const [first, second] = [...document.querySelectorAll('article')];
    place(document.body, 0, 0, 800, 600);
    place(document.querySelector('#app')!, 0, 0, 800, 590);
    place(document.querySelector('section')!, 0, 0, 800, 300);
    place(first, 20, 20, 200, 120);
    place(first.querySelector('h3')!, 30, 30, 100, 20);
    place(first.querySelector('button')!, 30, 60, 100, 30);
    place(second, 420, 20, 200, 120);
    place(second.querySelector('h3')!, 430, 30, 100, 20);
    const around = (x: number, y: number, w: number, h: number) => [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ];
    const names = (points: unknown) =>
      (ask({ type: 'codeman:query-polygon', requestId: 'q', points }).elements as { selector: string }[]).map(
        (e) => e.selector
      );
    // Around the first card: the card stands for the heading and button inside it.
    expect(names(around(10, 10, 230, 150))).toEqual(['article:nth-of-type(1)']);
    // Around its heading and button only: both, since the card's own centre is outside.
    expect(names(around(25, 25, 80, 70))).toEqual(['article:nth-of-type(1) > h3:nth-of-type(1)', '[data-testid="go"]']);
    // Around everything: both cards. The section's centre is inside too, so it stands for them.
    expect(names(around(0, 0, 799, 400))).toEqual(['section:nth-of-type(1)']);
    // The whole page is never an answer, and a wrapper that fills it is not either.
    expect(names(around(380, 280, 40, 30))).toEqual([]);
    expect(names([[0, 0]])).toEqual([]);
    expect(names('everything')).toEqual([]);
    expect(names(Array(FRAME_LIMITS.maxPoints + 1).fill([1, 1]))).toEqual([]);
  });
  it('caps a loop at the most elements one message may carry', () => {
    const list = document.createElement('ul');
    document.body.append(list);
    for (let i = 0; i < MAX_ELEMENT_REFS + 30; i++) {
      const item = document.createElement('li');
      list.append(item);
      place(item, 10, 10, 20, 20);
    }
    const reply = ask({
      type: 'codeman:query-polygon',
      requestId: 'q',
      points: [
        [0, 0],
        [100, 0],
        [100, 100],
        [0, 100],
      ],
    });
    expect(reply.elements).toHaveLength(MAX_ELEMENT_REFS);
    expect(parseFrameMessage(reply, 'e')?.type).toBe('elements');
  });
});

describe('a page policy that restricts inline scripts', () => {
  const hash = /'sha256-[A-Za-z0-9+/=]{44}'/;
  it('gains the hash of the bridge and nothing else', () => {
    expect(allowFrameBridge("script-src 'self'")).toMatch(new RegExp(`^script-src 'self' ${hash.source}$`));
    expect(allowFrameBridge("default-src 'self'; img-src *")).toMatch(
      new RegExp(`^default-src 'self'; img-src \\*; script-src 'self' ${hash.source}$`)
    );
    expect(allowFrameBridge("script-src 'none'")).toMatch(new RegExp(`^script-src ${hash.source}$`));
    expect(allowFrameBridge("script-src 'nonce-abc' 'strict-dynamic'")).toMatch(hash);
    expect(allowFrameBridge("script-src 'self'; script-src-elem 'self'")).toMatch(
      new RegExp(`^script-src 'self'; script-src-elem 'self' ${hash.source}$`)
    );
    expect(allowFrameBridge("script-src 'self', default-src 'none'").match(new RegExp(hash.source, 'g'))).toHaveLength(
      2
    );
  });
  it('is left alone where inline scripts already run, since a hash would switch that off', () => {
    for (const csp of ["script-src 'self' 'unsafe-inline'", "default-src * 'unsafe-inline'", 'img-src *', ''])
      expect(allowFrameBridge(csp)).toBe(csp);
    // A nonce or hash beside 'unsafe-inline' already switched it off, so the bridge needs its own hash.
    expect(allowFrameBridge("script-src 'unsafe-inline' 'nonce-abc'")).toMatch(hash);
  });
});
