/**
 * Elements inside a live canvas frame: Pick element, element chips that ride with a message, the hold-Q
 * lasso inside a frame, and what a page may and may not do to the canvas through the frame bridge.
 *
 * The test page is served by a local site and reaches the frame through the real proxy, so the bridge
 * under test is the one the proxy injected.
 */
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import puppeteer from 'puppeteer';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebServer } from '../src/web/server.js';
import { dataPath } from '../src/config/instance.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';
import { CommandSchema } from '../src/canvas/operations.js';
import { ElementRefSchema, type ElementRef } from '../src/canvas/element-ref.js';

const BOARD = `<!doctype html><html><head><title>Sprint board</title><style>
  body{margin:0;font:14px system-ui;background:#f4f1ea;color:#222}
  .card{position:absolute;top:70px;width:150px;height:110px;background:#fff;border:1px solid #bbb;border-radius:6px}
  #card-a{left:20px} #card-b{left:200px}
  h2{position:absolute;left:20px;top:8px;margin:0} h3{margin:10px} button{margin:0 10px}
  #field{position:absolute;left:20px;top:210px;width:200px}
</style></head><body><main id="app" data-source="src/board.html:4">
  <h2 id="heading">Sprint board</h2>
  <article class="card" id="card-a"><h3>Alpha</h3><button id="start" onclick="document.title='clicked'">Start task</button></article>
  <article class="card" id="card-b"><h3>Beta</h3><button id="stop">Stop</button></article>
  <input id="field" placeholder="Type here">
</main></body></html>`;
/** A page that says everything the bridge can say, unasked, as soon as it loads and whenever told to. */
const HOSTILE = `<!doctype html><html><head><title>Hostile</title></head><body><p id="bait">bait</p><script>
  const element = { selector: '#bait', path: 'p#bait', tag: 'p', text: 'FORGED', rect: { x: 0, y: 0, width: 10, height: 10 }, attrs: {}, styles: {} };
  function shout() {
    const say = (m) => parent.postMessage(m, '*');
    say({ type: 'codeman:frame-picked', element });
    say({ type: 'codeman:frame-picked', element: { ...element, objectId: 'board' } });
    say({ type: 'codeman:frame-elements', requestId: 'guess', elements: [element] });
    say({ type: 'codeman:frame-key', key: 'q', phase: 'down' });
    say({ type: 'codeman:frame-key', key: 'a', phase: 'down' });
    say({ type: 'codeman:frame-picked', element: { ...element, text: 'x'.repeat(500000) } });
    say({ type: 'codeman:frame-elements', requestId: 'guess', elements: Array(5000).fill(element) });
    say({ type: 'codeman:frame-rects', requestId: 'guess', rects: [{ x: 0, y: 0, width: 1, height: 1 }] });
    say({ type: 'codeman:context-add', ids: ['board'] });
    say('codeman:frame-picked');
  }
  shout();
  addEventListener('message', (e) => { if (e.data && e.data.type === 'test:shout') shout(); });
  setInterval(shout, 150);
</script></body></html>`;

const embed = (id: string, x: number, y: number, url: string, label: string) =>
  CommandSchema.parse({
    kind: 'create',
    opId: `seed-${id}`,
    objectId: id,
    patch: {
      parentId: null,
      order: x,
      position: { x, y },
      size: { width: 420, height: 320 },
      content: { type: 'embed', url, label },
    },
  });

describe('canvas elements inside a live frame', () => {
  let server: WebServer,
    pages: Server,
    site: string,
    browser: Browser,
    page: Page,
    origin: string,
    workspace: string,
    serial = 0;
  const sends: { url: string; body: Record<string, unknown> }[] = [];
  const views: { status: number; body: Record<string, unknown> }[] = [];

  beforeAll(async () => {
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-canvas-elements');
    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasEnabled: true, canvasShellEnabled: false }));
    server = new WebServer(0, false, true, undefined, undefined, undefined, '/x');
    await server.start();
    origin = `http://localhost:${server.boundPort}`;
    pages = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      if (req.url?.startsWith('/strict')) res.setHeader('Content-Security-Policy', "default-src 'self'");
      res.end(req.url?.startsWith('/hostile') ? HOSTILE : BOARD);
    });
    await new Promise<void>((done) => pages.listen(0, '127.0.0.1', done));
    site = `http://127.0.0.1:${(pages.address() as AddressInfo).port}`;
    browser = await chromium.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: ['--no-sandbox'],
    });
  }, 60000);
  beforeEach(async () => {
    const name = `Canvas elements ${++serial}`;
    mkdirSync(resolve(resolveCasesDir(), name), { recursive: true });
    workspace = workspaceForCase(name).id;
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    sends.length = views.length = 0;
    // The server side of `elements` is another change; here the send is answered for it and its body is read.
    await page.route('**/conversations/*/messages', async (route) => {
      sends.push({ url: route.request().url(), body: route.request().postDataJSON() });
      await route.fulfill({ json: { success: true, data: {} } });
    });
    page.on('response', (r) => {
      if (r.request().method() === 'PUT' && r.url().includes('/views/'))
        views.push({ status: r.status(), body: r.request().postDataJSON() });
    });
  });
  afterEach(async () => {
    await page?.unrouteAll({ behavior: 'ignoreErrors' });
    await page?.close();
  });
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    await new Promise((done) => pages?.close(done));
    vi.unstubAllEnvs();
  }, 60000);

  async function open(
    viewport = { x: 240, y: 40, zoom: 1 },
    objects = [embed('board', 40, 40, `${site}/board`, 'Board')]
  ) {
    const seeded = await page.request.post(`${origin}/x/api/canvas/${workspace}/ops`, {
      data: { operations: objects },
    });
    expect(seeded.ok()).toBe(true);
    await page.goto(`${origin}/x/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.canvasEdit?.read().status === 'saved');
    await page.evaluate((v) => window.canvasView.dispatch({ kind: 'viewport', viewport: v }), viewport);
    for (const o of objects) await live(o.objectId);
  }
  /** The frame is mounted and its bridge has spoken. */
  async function live(id: string): Promise<Frame> {
    const handle = await page.waitForSelector(`[data-object-id="${id}"] .embed-stage.live > iframe`);
    const frame = (await handle.contentFrame())!;
    await frame.waitForLoadState('domcontentloaded');
    await expect
      .poll(() => page.evaluate(async (o) => !!(await window.canvasFrames.locate(o, ['html']))?.[0], id), {
        timeout: 15000,
      })
      .toBe(true);
    return frame;
  }
  const frameOf = async (id = 'board') => (await (await page.$(`[data-object-id="${id}"] iframe`))!.contentFrame())!;
  const view = () => page.evaluate(() => window.canvasView.read());
  const select = (id: string) => page.evaluate((i) => window.canvasView.dispatch({ kind: 'selection', ids: [i] }), id);
  const stage = (id = 'board') => page.locator(`[data-object-id="${id}"] .embed-stage`);
  const stageClass = async (id = 'board') => (await stage(id).getAttribute('class')) ?? '';
  const pickButton = (id = 'board') => page.locator(`[data-object-id="${id}"] [data-media-action="pick"]`);
  /** An element of the framed page, in the canvas page's own pixels. */
  async function inFrame(selector: string, id = 'board') {
    // Worked out from the stage and the zoom: Playwright's own box for a framed element ignores the canvas's scale.
    const box = (await stage(id).boundingBox())!;
    const scale = box.width / (await stage(id).evaluate((el) => (el as HTMLElement).offsetWidth));
    const r = await (await frameOf(id)).locator(selector).evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    });
    return { x: box.x + r.x * scale, y: box.y + r.y * scale, width: r.width * scale, height: r.height * scale };
  }
  async function startPick(id = 'board') {
    await select(id);
    await pickButton(id).click();
    await page.waitForFunction((i) => window.canvasFrames.picking() === i, id);
    await (await frameOf(id)).waitForSelector('[data-codeman-frame-bridge]', { state: 'attached' });
  }
  async function pick(selector: string, id = 'board') {
    await startPick(id);
    const box = await inFrame(selector, id);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector('#elementPopover:not([hidden])');
  }
  /** Holds Q and drags a closed loop through the given corners, in page pixels. */
  async function drag(corners: [number, number][]) {
    await page.mouse.move(...corners[0]);
    await page.mouse.down();
    for (const [x, y] of [...corners.slice(1), corners[0]]) await page.mouse.move(x, y, { steps: 6 });
    await page.mouse.up();
  }
  const around = (b: { x: number; y: number; width: number; height: number }, pad = 6): [number, number][] => [
    [b.x - pad, b.y - pad],
    [b.x + b.width + pad, b.y - pad],
    [b.x + b.width + pad, b.y + b.height + pad],
    [b.x - pad, b.y + b.height + pad],
  ];
  const pending = async () => (await view()).contextElements.map((e) => e.selector);

  it('picks a button, shows it as a chip, and sends it with the message', async () => {
    await open();
    // Pick element is offered only on a live page, and nothing of the bridge shows until it is used.
    expect(await (await frameOf()).locator('[data-codeman-frame-bridge]').count()).toBe(0);
    await pick('#start');
    // The click went to the picker, not to the page's own button.
    expect(await (await frameOf()).title()).toBe('Sprint board');
    expect(await page.locator('#elementPopoverLabel').textContent()).toBe('button "Start task"');
    expect(await page.locator('#elementPopoverActions button').allTextContents()).toEqual(['Add to chat']);
    // The popover hangs under the element it is about, and the mark sits on it.
    const target = await inFrame('#start');
    const popover = (await page.locator('#elementPopover').boundingBox())!;
    expect(Math.abs(popover.x - target.x)).toBeLessThan(2);
    expect(popover.y).toBeGreaterThan(target.y + target.height);
    expect(popover.y).toBeLessThan(target.y + target.height + 16);
    const mark = (await page.locator('#elementMark').boundingBox())!;
    expect(Math.abs(mark.x - target.x) + Math.abs(mark.width - target.width)).toBeLessThan(2);
    // Picking is over: the shield is back and the page is not in use.
    expect(await stageClass()).not.toMatch(/picking|interacting/);
    expect(await (await frameOf()).locator('[data-codeman-frame-bridge]').count()).toBe(0);

    await page.locator('#elementPopoverActions button').click();
    await page.waitForSelector('#contextChips .chip-element');
    expect(await page.locator('#elementPopover').isHidden()).toBe(true);
    expect(await page.locator('#assistantView').isVisible()).toBe(true);
    expect(await page.locator('#contextChips .chip-element .chip-name').textContent()).toBe('button "Start task"');
    expect(await page.locator('#contextChips .chip-element .chip-page').textContent()).toBe('in Board');
    expect(await page.locator('#contextHeading').textContent()).toBe('Context · 1');
    const state = await view();
    expect(state.context).toEqual([]);
    const element = ElementRefSchema.parse(state.contextElements[0]);
    expect(element).toMatchObject({ objectId: 'board', selector: '#start', tag: 'button', text: 'Start task' });
    expect(element.source).toBe('src/board.html:4');
    expect(element.path).toBe('main#app > article#card-a > button#start');
    expect(element.styles.display).toBeTruthy();

    await page.waitForFunction(() => document.activeElement?.id === 'assistantDraft');
    await page.keyboard.type('Make this button calmer');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#contextChips .chip-element'));
    expect(sends).toHaveLength(1);
    expect(sends[0].body).toMatchObject({ text: 'Make this button calmer', refIds: [] });
    const sent = (sends[0].body.elements as unknown[]).map((e) => ElementRefSchema.parse(e));
    expect(sent).toEqual([element]);
    expect(await pending()).toEqual([]);
    // The view registry still takes this tab's view while elements are pending.
    expect(views.length).toBeGreaterThan(0);
    expect(views.every((v) => v.status === 200)).toBe(true);
  }, 60000);

  it('keeps the element chips when a send fails, removes one on request, and drops them when the page changes', async () => {
    await open();
    await pick('#start');
    await page.locator('#elementPopoverActions button').click();
    await pick('#stop');
    await page.locator('#elementPopoverActions button').click();
    await page.waitForFunction(() => document.querySelectorAll('#contextChips .chip-element').length === 2);
    await page.unroute('**/conversations/*/messages');
    await page.route('**/conversations/*/messages', (route) =>
      route.fulfill({ status: 409, json: { success: false, error: 'NOT_DELIVERED: no', errorCode: 'CONFLICT' } })
    );
    await page.locator('#assistantDraft').click();
    await page.keyboard.type('About these two');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#assistantRetry:not([hidden])');
    expect(await pending()).toEqual(['#start', '#stop']);
    expect(await page.locator('#assistantDraft').inputValue()).toBe('About these two');

    await page.locator('#contextChips .chip-element .chip-remove').first().click();
    expect(await pending()).toEqual(['#stop']);
    // Reloading keeps what is pending, as it keeps pending objects.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.canvasView?.read().contextElements.length === 1);
    // The embed now shows another page: an element of the old one names nothing.
    const moved = await page.request.post(`${origin}/x/api/canvas/${workspace}/ops`, {
      data: {
        operations: [
          {
            kind: 'update',
            opId: 'move-page',
            objectId: 'board',
            patch: { content: { type: 'embed', url: `${site}/board?v=2`, label: 'Board' } },
          },
        ],
      },
    });
    expect(moved.ok()).toBe(true);
    await page.waitForFunction(() => window.canvasView.read().contextElements.length === 0);
    expect(await page.locator('#contextChips .chip-element').count()).toBe(0);
  }, 60000);

  it('offers a second action through the same seam, and tells listeners what was picked', async () => {
    await open();
    await page.evaluate(() => {
      const w = window as unknown as { picked: string[]; commented: string[] };
      w.picked = [];
      w.commented = [];
      window.canvasFrames.onPicked((e) => w.picked.push(e.selector));
      window.canvasFrames.addPickAction({ id: 'comment', label: 'Comment', run: (e) => w.commented.push(e.selector) });
    });
    await pick('#stop');
    expect(await page.locator('#elementPopoverActions button').allTextContents()).toEqual(['Add to chat', 'Comment']);
    await page.locator('#elementPopoverActions [data-pick-action="comment"]').click();
    const heard = await page.evaluate(() => {
      const w = window as unknown as { picked: string[]; commented: string[] };
      return { picked: w.picked, commented: w.commented };
    });
    expect(heard).toEqual({ picked: ['#stop'], commented: ['#stop'] });
    expect(await pending()).toEqual([]);
    // pickElement by itself resolves with the element and shows no popover.
    await select('board');
    const waiting = page.evaluate(() => window.canvasFrames.pickElement('board'));
    await (await frameOf()).waitForSelector('[data-codeman-frame-bridge]', { state: 'attached' });
    const heading = await inFrame('#heading');
    await page.mouse.click(heading.x + 4, heading.y + 4);
    expect((await waiting)?.selector).toBe('#heading');
    expect(await page.locator('#elementPopover').isHidden()).toBe(true);
  }, 60000);

  it('ends picking on Escape, a click elsewhere, a selection change, Reload and the window losing focus', async () => {
    await open({ x: 240, y: 40, zoom: 1 }, [
      embed('board', 40, 40, `${site}/board`, 'Board'),
      embed('other', 520, 40, `${site}/board?other`, 'Other'),
    ]);
    const over = async () => {
      await page.waitForFunction(() => window.canvasFrames.picking() === null);
      expect(await stageClass()).not.toContain('picking');
      expect(await stage().locator(':scope > .embed-shield').isVisible()).toBe(true);
      await (await frameOf()).waitForSelector('[data-codeman-frame-bridge]', { state: 'detached' });
      expect(await pickButton().getAttribute('aria-pressed')).toBe('false');
    };
    await startPick();
    expect(await stageClass()).toContain('picking');
    expect(await stage().locator(':scope > .embed-shield').isVisible()).toBe(false);
    expect(await pickButton().getAttribute('aria-pressed')).toBe('true');
    // The hover outline is the bridge's own element inside the page, over the element under the pointer.
    const start = await inFrame('#start');
    await page.mouse.move(start.x + 5, start.y + 5);
    const outline = (await (await frameOf()).locator('[data-codeman-frame-bridge] > div').boundingBox())!;
    expect(Math.abs(outline.x - start.x) + Math.abs(outline.width - start.width)).toBeLessThan(2);
    expect(await (await frameOf()).locator('#start').evaluate((el) => el.getAttribute('style'))).toBe(null);
    await page.keyboard.press('Escape');
    await over();
    expect((await view()).selected).toEqual(['board']);

    await startPick();
    await page.mouse.click(900, 700);
    await over();

    await startPick();
    await select('other');
    await over();

    await startPick();
    await page.locator('[data-object-id="board"] [data-media-action="reload"]').click();
    await page.waitForFunction(() => window.canvasFrames.picking() === null);
    await live('board');

    await startPick();
    await pickButton().click();
    await over();

    await startPick();
    await page.evaluate(() => {
      document.hasFocus = () => false;
      window.dispatchEvent(new Event('blur'));
    });
    await over();
    await page.evaluate(() => delete (document as { hasFocus?: unknown }).hasFocus);

    // The I key is the button, for the one selected embed.
    await select('board');
    await page.locator('#board').focus();
    await page.keyboard.press('i');
    await page.waitForFunction(() => window.canvasFrames.picking() === 'board');
    await page.keyboard.press('i');
    await over();

    // Escape closes the popover and leaves the selection alone.
    await pick('#start');
    await page.keyboard.press('Escape');
    expect(await page.locator('#elementPopover').isHidden()).toBe(true);
    expect(await page.locator('#elementMark').isHidden()).toBe(true);
    expect((await view()).selected).toEqual(['board']);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('board');
  }, 90000);

  it.each([0.5, 2])(
    'captures the elements a Q loop encloses inside a frame at %s zoom',
    async (zoom) => {
      await open({ x: 240, y: 40, zoom });
      await page.locator('#board').focus();
      await page.keyboard.down('q');
      // Around the first card only.
      await drag(around(await inFrame('#card-a'), 3 * zoom));
      await page.waitForFunction(() => window.canvasView.read().contextElements.length > 0);
      expect(await pending()).toEqual(['#card-a']);
      expect((await view()).context).toEqual([]);
      // Around both cards: the outermost matches, in page order, added once.
      const a = await inFrame('#card-a'),
        b = await inFrame('#card-b');
      await drag(around({ x: a.x, y: a.y, width: b.x + b.width - a.x, height: a.height }, 3 * zoom));
      await page.waitForFunction(() => window.canvasView.read().contextElements.length === 2);
      expect(await pending()).toEqual(['#card-a', '#card-b']);
      const element = ElementRefSchema.parse((await view()).contextElements[0]) as ElementRef;
      // The rectangle is in the frame's own pixels whatever the zoom.
      expect(element.rect).toMatchObject({ x: 20, y: 70, width: 152, height: 112 });
      // A loop that crosses the frame's edge is a loop around the object.
      const box = (await stage().boundingBox())!;
      await drag(around(box, 12));
      await page.waitForFunction(() => window.canvasView.read().context.length === 1);
      await page.keyboard.up('q');
      expect((await view()).context).toEqual(['board']);
      expect(await pending()).toEqual(['#card-a', '#card-b']);
      await expect.poll(() => page.locator('#contextHeading').textContent()).toBe('Context · 3');
      // A loop inside the frame around empty page stands for the embed as a whole, which is already there.
      expect(await page.locator('#board.lasso-armed').count()).toBe(0);
    },
    60000
  );

  it('arms the lasso from Q pressed inside the page, and gives the page back on release', async () => {
    await open();
    await select('board');
    await stage().locator(':scope > .embed-shield').click();
    await page.waitForFunction(() => document.querySelector('.embed-stage.interacting'));
    const frame = await frameOf();
    // Typing Q into a field of the page is typing.
    await frame.locator('#field').click();
    await page.keyboard.type('quiet q');
    expect(await frame.locator('#field').inputValue()).toBe('quiet q');
    expect(await page.locator('#board.lasso-armed').count()).toBe(0);
    await frame.locator('#heading').click();
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME');

    await page.keyboard.down('q');
    await page.waitForSelector('#board.lasso-armed');
    expect(await stageClass()).toContain('shielded');
    expect(await stage().locator(':scope > .embed-shield').isVisible()).toBe(true);
    await drag(around(await inFrame('#card-b'), 4));
    await page.waitForFunction(() => window.canvasView.read().contextElements.length === 1);
    expect(await pending()).toEqual(['#card-b']);
    // Still held: a second loop is taken too.
    expect(await page.locator('#board.lasso-armed').count()).toBe(1);
    await drag(around(await inFrame('#card-a'), 4));
    await page.waitForFunction(() => window.canvasView.read().contextElements.length === 2);
    await page.keyboard.up('q');
    await page.waitForFunction(() => !document.querySelector('#board.lasso-armed'));
    expect(await stageClass()).toContain('interacting');
    expect(await stageClass()).not.toContain('shielded');
    expect(await stage().locator(':scope > .embed-shield').isVisible()).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME');
    expect((await view()).selected).toEqual(['board']);

    // Released without a drag: nothing is captured and the page keeps the keyboard.
    await frame.locator('#heading').click();
    await page.keyboard.down('q');
    await page.waitForSelector('#board.lasso-armed');
    await page.keyboard.up('q');
    await page.waitForFunction(() => !document.querySelector('#board.lasso-armed'));
    expect(await stageClass()).not.toContain('shielded');

    // Escape inside the page ends a lasso it armed and leaves the page in use; the next Escape hands the keys back.
    await page.keyboard.down('q');
    await page.waitForSelector('#board.lasso-armed');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#board.lasso-armed'));
    expect(await stageClass()).toContain('interacting');
    await page.keyboard.up('q');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.embed-stage.interacting'));
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('board');
    expect(await pending()).toEqual(['#card-b', '#card-a']);
  }, 60000);

  it('shows the embed and flashes the element when its chip is used', async () => {
    await open();
    await pick('#stop');
    await page.locator('#elementPopoverActions button').click();
    await page.waitForSelector('#contextChips .chip-element');
    await page.evaluate(() => window.canvasView.dispatch({ kind: 'selection', ids: [] }));
    await page.locator('#contextChips .chip-element .chip-label').click();
    await page.waitForSelector('#elementMark.flash:not([hidden])');
    expect((await view()).selected).toEqual(['board']);
    const mark = (await page.locator('#elementMark').boundingBox())!;
    const target = await inFrame('#stop');
    expect(Math.abs(mark.x - target.x) + Math.abs(mark.y - target.y)).toBeLessThan(2);
    await page.waitForSelector('#elementMark', { state: 'hidden' });
    // The frame is asked where things are now, in its own pixels; a selector that names nothing is null.
    expect(await page.evaluate(() => window.canvasFrames.locate('board', ['#heading', '#gone', ':::']))).toEqual([
      { x: 20, y: 8, width: expect.any(Number), height: expect.any(Number) },
      null,
      null,
    ]);
    expect(await page.evaluate(() => window.canvasFrames.locate('nope', ['#heading']))).toBe(null);
  }, 60000);

  it('changes nothing for a page that forges or floods bridge messages', async () => {
    await open({ x: 240, y: 40, zoom: 1 }, [
      embed('board', 40, 40, `${site}/board`, 'Board'),
      embed('hostile', 520, 40, `${site}/hostile`, 'Hostile'),
    ]);
    const quiet = async () => {
      await page.waitForTimeout(400);
      const state = await view();
      expect(state.contextElements).toEqual([]);
      expect(state.context).toEqual([]);
      expect(await page.locator('#board.lasso-armed').count()).toBe(0);
      expect(await page.locator('#elementPopover').isHidden()).toBe(true);
      expect(await page.locator('.embed-stage.shielded').count()).toBe(0);
    };
    await quiet();
    // The canvas's own window, and a window that is no frame of the canvas, are not frames either.
    await page.evaluate(() => {
      const element = {
        selector: '#x',
        path: '',
        tag: 'p',
        text: 'SELF',
        rect: { x: 0, y: 0, width: 1, height: 1 },
        attrs: {},
        styles: {},
      };
      window.postMessage({ type: 'codeman:frame-picked', element }, '*');
      window.postMessage({ type: 'codeman:frame-key', key: 'q', phase: 'down' }, '*');
      const stray = document.createElement('iframe');
      stray.srcdoc = `<script>parent.postMessage({type:'codeman:frame-key',key:'q',phase:'down'},'*')</script>`;
      document.body.append(stray);
    });
    await quiet();
    // While the person picks in ANOTHER frame, a forged pick is still not theirs.
    await startPick('board');
    await quiet();
    expect(await page.evaluate(() => window.canvasFrames.picking())).toBe('board');
    await page.keyboard.press('Escape');
    // While they pick in the hostile frame itself, the page can answer for itself only, and only as plain text.
    await select('hostile');
    await pickButton('hostile').click();
    await page.waitForSelector('#elementPopover:not([hidden])');
    expect(await page.locator('#elementPopoverLabel').textContent()).toBe('p "FORGED"');
    expect(await page.locator('#elementPopoverLabel *').count()).toBe(0);
    await page.keyboard.press('Escape');
    expect(await pending()).toEqual([]);
    // The legitimate frame still works beside it.
    await pick('#start');
    await page.locator('#elementPopoverActions button').click();
    expect(await pending()).toEqual(['#start']);
    expect((await view()).contextElements[0].objectId).toBe('board');
  }, 60000);

  it('runs under a page policy that forbids inline scripts, and still relays Escape', async () => {
    await open({ x: 240, y: 40, zoom: 1 }, [embed('strict', 40, 40, `${site}/strict`, 'Strict')]);
    await pick('#start', 'strict');
    expect(await page.locator('#elementPopoverLabel').textContent()).toBe('button "Start task"');
    await page.keyboard.press('Escape');
    // The page's own inline handler is still blocked by its policy: only the bridge was let through.
    await stage('strict').locator(':scope > .embed-shield').click();
    await page.waitForFunction(() => document.querySelector('.embed-stage.interacting'));
    const frame = await frameOf('strict');
    await frame.locator('#start').click();
    expect(await frame.title()).toBe('Sprint board');
    await frame.locator('#field').click();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.embed-stage.interacting'));
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('board');
  }, 60000);
});
