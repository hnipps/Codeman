/**
 * Comments on an element inside a live canvas frame: Comment on a picked element, the element chip in the
 * thread, the numbered pins over the frame, and Ask agent from a comment that is about an element.
 *
 * The test page is served by a local site and reaches the frame through the real proxy and the real frame
 * bridge. Comments and their anchors go to the real server; only the conversation routes are answered here.
 */
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright';
import puppeteer from 'puppeteer';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { WebServer } from '../src/web/server.js';
import { dataPath } from '../src/config/instance.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';
import { CommandSchema } from '../src/canvas/operations.js';
import { ElementRefSchema, type ElementRef } from '../src/canvas/element-ref.js';
import { PIN_NUDGE } from '../packages/canvas/src/element-anchors.js';

const installed = vi.hoisted(() => ({ map: { claude: true } as Record<string, boolean> }));
vi.mock('../src/utils/cli-installed-probes.js', async (original) => ({
  ...(await original<typeof import('../src/utils/cli-installed-probes.js')>()),
  probeStockCliAvailability: async () => installed.map,
}));

/** Taller than its frame, so it scrolls. The second card can be left out, as a later version of the page would. */
const board = (withStop: boolean) => `<!doctype html><html><head><title>Sprint board</title><style>
  body{margin:0;height:1200px;font:14px system-ui;background:#f4f1ea;color:#222}
  .card{position:absolute;top:70px;width:150px;height:110px;background:#fff;border:1px solid #bbb;border-radius:6px}
  #card-a{left:20px} #card-b{left:200px}
  h2{position:absolute;left:20px;top:8px;margin:0} h3{margin:10px} button{margin:0 10px}
</style></head><body><main id="app" data-source="src/board.html:4">
  <h2 id="heading">Sprint board</h2>
  <article class="card" id="card-a"><h3>Alpha</h3><button id="start">Start task</button></article>
  ${withStop ? '<article class="card" id="card-b"><h3>Beta</h3><button id="stop">Stop</button></article>' : ''}
</main></body></html>`;

const SHOTS = process.env.CANVAS_ELEMENT_COMMENT_SHOTS || resolve(tmpdir(), 'codeman-canvas-element-comments');
const stamp = Date.now();

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
type Command = { tool: string; requestId: string; arguments: Record<string, unknown> };

describe('canvas comments on an element of a live page', () => {
  let server: WebServer,
    pages: Server,
    site: string,
    browser: Browser,
    context: BrowserContext,
    page: Page,
    origin: string,
    workspace: string,
    withStop = true,
    serial = 0;
  const commands: Command[] = [];
  const sends: { path: string; body: Record<string, unknown> }[] = [];

  beforeAll(async () => {
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-canvas-element-comments');
    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasEnabled: true, canvasShellEnabled: false }));
    server = new WebServer(0, false, true, undefined, undefined, undefined, '/x');
    await server.start();
    origin = `http://localhost:${server.boundPort}`;
    pages = createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(board(withStop));
    });
    await new Promise<void>((done) => pages.listen(0, '127.0.0.1', done));
    site = `http://127.0.0.1:${(pages.address() as AddressInfo).port}`;
    browser = await chromium.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: ['--no-sandbox'],
    });
    mkdirSync(SHOTS, { recursive: true });
  }, 60000);
  beforeEach(async () => {
    const name = `Canvas element comments ${++serial}`;
    mkdirSync(resolve(resolveCasesDir(), name), { recursive: true });
    workspace = workspaceForCase(name).id;
    withStop = true;
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    page = await context.newPage();
    commands.length = sends.length = 0;
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/api\/canvas\/[^/]+\/command$/.test(r.url())) commands.push(r.postDataJSON());
    });
  });
  afterEach(async () => {
    await page?.unrouteAll({ behavior: 'ignoreErrors' });
    await context?.close();
  });
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    await new Promise((done) => pages?.close(done));
    vi.unstubAllEnvs();
  }, 60000);

  const api = (path: string) => `${origin}/x/api/canvas/${workspace}${path}`;
  const shot = (name: string) =>
    page.screenshot({ animations: 'disabled', path: resolve(SHOTS, `element-comments-${stamp}-${name}.png`) });
  async function seed() {
    const seeded = await page.request.post(api('/ops'), {
      data: { operations: [embed('board', 40, 40, `${site}/board`, 'Board')] },
    });
    expect(seeded.ok()).toBe(true);
  }
  async function open(viewport = { x: 240, y: 40, zoom: 1 }) {
    await page.goto(`${origin}/x/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.canvasEdit?.read().status === 'saved');
    await page.evaluate((v) => window.canvasView.dispatch({ kind: 'viewport', viewport: v }), viewport);
    await live();
  }
  /** The frame is mounted and its bridge has spoken. */
  async function live(id = 'board'): Promise<Frame> {
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
  const select = (id: string) => page.evaluate((i) => window.canvasView.dispatch({ kind: 'selection', ids: [i] }), id);
  const stage = (id = 'board') => page.locator(`[data-object-id="${id}"] .embed-stage`);
  /** An element of the framed page, in the canvas page's own pixels. */
  async function inFrame(selector: string, id = 'board') {
    const box = (await stage(id).boundingBox())!;
    const scale = box.width / (await stage(id).evaluate((el) => (el as HTMLElement).offsetWidth));
    const r = await (await frameOf(id)).locator(selector).evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    });
    return { x: box.x + r.x * scale, y: box.y + r.y * scale, width: r.width * scale, height: r.height * scale };
  }
  async function pick(selector: string, id = 'board') {
    await select(id);
    await page.locator(`[data-object-id="${id}"] [data-media-action="pick"]`).click();
    await page.waitForFunction((i) => window.canvasFrames.picking() === i, id);
    await (await frameOf(id)).waitForSelector('[data-codeman-frame-bridge]', { state: 'attached' });
    const box = await inFrame(selector, id);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector('#elementPopover:not([hidden])');
  }
  const commentAction = () => page.locator('#elementPopoverActions [data-pick-action="comment"]');
  /** Pick, Comment, type and post: the whole path a person takes. Resolves with the posted command. */
  async function commentOn(selector: string, text: string): Promise<Command> {
    const before = commands.length;
    await pick(selector);
    await commentAction().click();
    await page.waitForFunction(() => document.activeElement?.id === 'commentDraft');
    await page.keyboard.type(text);
    await page.keyboard.press('Control+Enter');
    await expect.poll(() => commands.length).toBeGreaterThan(before);
    await page.waitForFunction(
      (t) => [...document.querySelectorAll('#threadList .comment-text')].some((p) => p.textContent === t),
      text
    );
    return commands.at(-1)!;
  }
  /** A comment posted straight to the server, as an agent or another tab would. */
  async function serverComment(commentId: string, text: string, element?: Partial<ElementRef>) {
    const response = await page.request.post(api('/command'), {
      data: {
        tool: 'canvas_comment',
        arguments: {
          objectId: 'board',
          text,
          commentId,
          ...(element
            ? {
                element: {
                  objectId: 'board',
                  selector: '#start',
                  path: 'main#app > button#start',
                  tag: 'button',
                  text: 'Start task',
                  rect: { x: 30, y: 110, width: 80, height: 22 },
                  attrs: {},
                  styles: {},
                  ...element,
                },
              }
            : {}),
        },
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  const pins = () => page.locator('#elementPins .element-pin');
  /** Each pin's number, with `×n` when n comments share it. */
  const pinTexts = () =>
    pins().evaluateAll((list) =>
      list.map((p) => {
        const [number, badge] = [...p.children].map((c) => c.textContent);
        return badge ? `${number}×${badge}` : number;
      })
    );
  /** How far the middle of a pin is from where it belongs: just off the top-right corner of its element. */
  async function pinOffset(index: number, selector: string): Promise<number> {
    const pin = await pins().nth(index).boundingBox();
    const target = await inFrame(selector);
    if (!pin) return Infinity;
    return Math.hypot(
      pin.x + pin.width / 2 - (target.x + target.width + PIN_NUDGE),
      pin.y + pin.height / 2 - (target.y - PIN_NUDGE)
    );
  }
  const chips = () =>
    page.locator('#threadList .comment').evaluateAll((items) =>
      items.map((li) => {
        const chip = li.querySelector<HTMLElement>('.comment-element');
        return {
          text: li.querySelector('.comment-text')?.textContent ?? '',
          number: chip?.querySelector('.element-number')?.textContent ?? null,
          name: chip?.querySelector('.element-name')?.textContent ?? null,
          where: chip?.querySelector('.element-where')?.textContent ?? null,
          state: chip?.dataset.state ?? null,
        };
      })
    );
  async function openThread() {
    await page.evaluate(() => {
      window.canvasView.dispatch({ kind: 'focus', id: 'board' });
      window.canvasView.dispatch({ kind: 'selection', ids: ['board'] });
      window.canvasView.dispatch({ kind: 'rail', view: 'thread' });
    });
    await page.waitForSelector('#threadView:not([hidden])');
  }
  async function closeRail() {
    for (let i = 0; i < 4 && (await page.locator('#rail').isVisible()); i++) await page.keyboard.press('Escape');
    await page.waitForSelector('#rail', { state: 'hidden' });
  }
  const anchors = async () =>
    (await (await page.request.get(api('/comment-anchors'))).json()).data.anchors as Record<string, ElementRef>;

  it('comments on a picked element: the post carries it, the thread shows it, and a pin marks it in the page', async () => {
    await seed();
    await open();
    await pick('#start');
    expect(await page.locator('#elementPopoverActions button').allTextContents()).toEqual(['Add to chat', 'Comment']);
    await shot('popover');
    // Without a mouse: the popover opens on its first action, and Tab reaches Comment.
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.pickAction)).toBe('comment');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.id === 'commentDraft');
    expect(await page.locator('#threadTarget').textContent()).toBe('Board');
    expect(await page.locator('#commentAbout').isVisible()).toBe(true);
    expect(await page.locator('#commentAboutShow').textContent()).toBe('button "Start task"');
    expect(await page.locator('#commentPick').isHidden()).toBe(true);
    await shot('about');
    // Nothing is written until the person posts.
    expect(commands).toEqual([]);
    expect(await pins().count()).toBe(0);

    await page.keyboard.type('Make this button calmer');
    await page.keyboard.press('Control+Enter');
    await page.waitForSelector('#threadList .comment .comment-element');
    expect(commands).toHaveLength(1);
    expect(commands[0].tool).toBe('canvas_comment');
    const sent = ElementRefSchema.parse(commands[0].arguments.element);
    expect(sent).toMatchObject({ objectId: 'board', selector: '#start', tag: 'button', text: 'Start task' });
    expect(commands[0].arguments).toMatchObject({ objectId: 'board', text: 'Make this button calmer' });
    const commentId = commands[0].arguments.commentId as string;
    expect(await anchors()).toEqual({ [commentId]: sent });

    expect(await chips()).toEqual([
      {
        text: 'Make this button calmer',
        number: '1',
        name: 'button "Start task"',
        where: 'src/board.html:4',
        state: 'found',
      },
    ]);
    expect(await page.locator('.comment-element').getAttribute('title')).toContain('#start');
    // The composer is an ordinary one again.
    expect(await page.locator('#commentAbout').isHidden()).toBe(true);
    expect(await page.locator('#commentDraft').inputValue()).toBe('');
    await shot('thread-chip');

    // One pin, on the button's top-right corner, at this zoom, at another, and after the page scrolls.
    await expect.poll(() => pins().count()).toBe(1);
    expect(await pinTexts()).toEqual(['1']);
    expect(await pins().getAttribute('aria-label')).toBe('1 comment on button "Start task". Open the thread');
    await expect.poll(() => pinOffset(0, '#start')).toBeLessThan(1.5);
    const first = (await pins().boundingBox())!;
    await page.evaluate(() =>
      window.canvasView.dispatch({ kind: 'viewport', viewport: { x: 300, y: 120, zoom: 0.75 } })
    );
    await expect.poll(async () => Math.abs((await pins().boundingBox())!.x - first.x)).toBeGreaterThan(20);
    await expect.poll(() => pinOffset(0, '#start')).toBeLessThan(1.5);
    // The pin keeps its size: it is a mark on the canvas, not part of the page.
    expect((await pins().boundingBox())!.height).toBe(first.height);
    await page.evaluate(() => window.canvasView.dispatch({ kind: 'viewport', viewport: { x: 240, y: 40, zoom: 1 } }));
    await expect.poll(() => pinOffset(0, '#start')).toBeLessThan(1.5);
    const unscrolled = (await pins().boundingBox())!;
    await (await frameOf()).evaluate(() => scrollTo(0, 60));
    await expect.poll(async () => unscrolled.y - (await pins().boundingBox())!.y).toBeCloseTo(60, 0);
    await expect.poll(() => pinOffset(0, '#start')).toBeLessThan(1.5);
    // Scrolled out of the frame, the element has no pin; scrolled back, it has one again.
    await (await frameOf()).evaluate(() => scrollTo(0, 500));
    await expect.poll(() => pins().count()).toBe(0);
    await (await frameOf()).evaluate(() => scrollTo(0, 0));
    await expect.poll(() => pins().count()).toBe(1);
    await expect.poll(() => pinOffset(0, '#start')).toBeLessThan(1.5);

    // A pin opens the thread at its comment, with the keyboard on that comment's element.
    await closeRail();
    await pins().click();
    await page.waitForSelector('#threadView:not([hidden])');
    await page.waitForFunction(
      (id) =>
        document.activeElement?.classList.contains('comment-element') &&
        document.activeElement.closest('li')?.getAttribute('data-comment-id') === id,
      commentId
    );
    // The chip shows the element where the page has it now.
    await page.keyboard.press('Enter');
    await page.waitForSelector('#elementMark.flash');
    const mark = (await page.locator('#elementMark').boundingBox())!;
    const target = await inFrame('#start');
    expect(Math.abs(mark.x - target.x) + Math.abs(mark.y - target.y)).toBeLessThan(2);

    // While an element is being picked the pins stand down, and they are back when it ends.
    await page.locator('[data-object-id="board"] [data-media-action="pick"]').click();
    await page.waitForFunction(() => window.canvasFrames.picking() === 'board');
    expect(await page.locator('#elementPins').evaluate((el) => getComputedStyle(el).visibility)).toBe('hidden');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.canvasFrames.picking() === null);
    expect(await page.locator('#elementPins').evaluate((el) => getComputedStyle(el).visibility)).toBe('visible');
    expect(await page.locator('#threadView').isVisible()).toBe(true);

    // Removing the comment removes its pin and its chip; nothing else is written for the anchor.
    const removed = await page.request.post(api('/ops'), {
      data: { operations: [{ kind: 'remove-comment', opId: 'drop-1', objectId: 'board', patch: { id: commentId } }] },
    });
    expect(removed.ok(), await removed.text()).toBe(true);
    await expect.poll(() => pins().count()).toBe(0);
    expect(await page.locator('#threadList .comment').count()).toBe(0);
    expect(await anchors()).toEqual({});
  }, 90000);

  it('hides a pin in the same paint that opens the rail over it', async () => {
    await seed();
    // Far enough right that the pin on #start sits where the rail will open.
    await open({ x: 1000, y: 40, zoom: 1 });
    await commentOn('#start', 'Under the rail');
    await closeRail();
    await expect.poll(() => pins().count()).toBe(1);
    const pin = (await pins().boundingBox())!;
    expect(pin.x).toBeGreaterThan(1440 - 320);
    await openThread();
    // Read in the paint that showed the rail, before anything else repaints the board.
    expect(await pins().count()).toBe(0);
    await closeRail();
    await expect.poll(() => pins().count()).toBe(1);
  }, 90000);

  it('gives comments on one element one pin with a count, numbers the next element, and posts a plain comment once the element is removed', async () => {
    await seed();
    await open();
    await commentOn('#start', 'First on start');
    await commentOn('#stop', 'About stop');
    await commentOn('#start', 'Second on start');
    await expect.poll(() => pinTexts()).toEqual(['1×2', '2']);
    expect(await pins().first().getAttribute('aria-label')).toBe('2 comments on button "Start task". Open the thread');
    await expect.poll(() => pinOffset(0, '#start')).toBeLessThan(1.5);
    await expect.poll(() => pinOffset(1, '#stop')).toBeLessThan(1.5);
    expect((await chips()).map((c) => [c.text, c.number, c.name])).toEqual([
      ['First on start', '1', 'button "Start task"'],
      ['About stop', '2', 'button "Stop"'],
      ['Second on start', '1', 'button "Start task"'],
    ]);
    await shot('pins');

    // Arrow keys walk the pins, which share one stop in the tab order.
    expect(await pins().evaluateAll((list) => list.map((p) => (p as HTMLElement).tabIndex))).toEqual([0, -1]);
    await pins().first().focus();
    await page.keyboard.press('ArrowRight');
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.number)).toBe('2');
    expect(await pins().evaluateAll((list) => list.map((p) => (p as HTMLElement).tabIndex))).toEqual([-1, 0]);
    // The second pin opens the thread at the comment about Stop.
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => document.activeElement?.closest('li')?.querySelector('.comment-text')?.textContent === 'About stop'
    );

    // Comment on an element, then take the element away: what is posted is an ordinary comment on the embed.
    const before = commands.length;
    await pick('#heading');
    await commentAction().click();
    await page.waitForSelector('#commentAbout:not([hidden])');
    await page.locator('#commentAboutRemove').click();
    expect(await page.locator('#commentAbout').isHidden()).toBe(true);
    await page.waitForFunction(() => document.activeElement?.id === 'commentDraft');
    await page.keyboard.type('About the whole page');
    await page.keyboard.press('Control+Enter');
    await expect.poll(() => commands.length).toBe(before + 1);
    expect(commands.at(-1)!.arguments).not.toHaveProperty('element');
    await page.waitForFunction(() => document.querySelectorAll('#threadList .comment').length === 4);
    expect((await chips()).at(-1)).toMatchObject({ text: 'About the whole page', number: null });
    expect(await pinTexts()).toEqual(['1×2', '2']);
  }, 120000);

  it('keeps the draft and its element when a post fails, retries the same comment, and restores both after a reload', async () => {
    await seed();
    await open();
    await pick('#start');
    await commentAction().click();
    await page.waitForFunction(() => document.activeElement?.id === 'commentDraft');
    await page.keyboard.type('Kept through a failure');
    await page.route('**/api/canvas/*/command', (route) => route.abort());
    await page.keyboard.press('Control+Enter');
    await page.waitForSelector('#retryComment:not([hidden])');
    expect(await page.locator('#commentStatus').textContent()).toBe('Not posted. Your comment is kept here.');
    expect(await page.locator('#commentDraft').inputValue()).toBe('Kept through a failure');
    expect(await page.locator('#commentAboutShow').textContent()).toBe('button "Start task"');
    const failed = commands.at(-1)!;
    expect(ElementRefSchema.parse(failed.arguments.element).selector).toBe('#start');

    // A reload in the middle loses neither the words nor what they are about.
    await page.unroute('**/api/canvas/*/command');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.canvasEdit?.read().status === 'saved');
    await live();
    await openThread();
    expect(await page.locator('#commentDraft').inputValue()).toBe('Kept through a failure');
    expect(await page.locator('#commentAboutShow').textContent()).toBe('button "Start task"');
    expect(await page.locator('#threadList .comment').count()).toBe(0);

    commands.length = 0;
    await page.locator('#postComment').click();
    await page.waitForSelector('#threadList .comment .comment-element');
    expect(commands).toHaveLength(1);
    expect(ElementRefSchema.parse(commands[0].arguments.element).selector).toBe('#start');
    expect(await page.locator('#commentAbout').isHidden()).toBe(true);
    await expect.poll(() => pins().count()).toBe(1);
    // Nothing is left behind to come back on the next visit.
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.includes(':thread:draft')).length)).toBe(
      0
    );

    // A retry after a lost answer resends the same request, element included, and lands once.
    await pick('#stop');
    await commentAction().click();
    await page.waitForFunction(() => document.activeElement?.id === 'commentDraft');
    await page.keyboard.type('Sent twice, posted once');
    let dropped = 0;
    await page.route('**/api/canvas/*/command', async (route) => {
      if (dropped++) return route.continue();
      // The server takes it; the answer never reaches the page.
      await route.fetch();
      await route.abort();
    });
    commands.length = 0;
    await page.keyboard.press('Control+Enter');
    await page.waitForSelector('#retryComment:not([hidden])');
    expect(await page.locator('#commentAboutShow').textContent()).toBe('button "Stop"');
    await page.locator('#retryComment').click();
    await page.waitForFunction(() => document.getElementById('commentAbout')?.hidden === true);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    await expect
      .poll(async () => (await chips()).map((c) => [c.text, c.name]))
      .toEqual([
        ['Kept through a failure', 'button "Start task"'],
        ['Sent twice, posted once', 'button "Stop"'],
      ]);
    await expect.poll(() => pinTexts()).toEqual(['1', '2']);
  }, 120000);

  it('picks an element from the thread composer, by pointer and by keyboard', async () => {
    await seed();
    await open();
    await openThread();
    // The control is there because this embed's page is live and has answered.
    await page.waitForSelector('#commentPick:not([hidden])');
    expect(await page.locator('#commentPick').textContent()).toBe('Pick element');
    await page.locator('#commentPick').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.canvasFrames.picking() === 'board');
    expect(await page.locator('#commentPick').getAttribute('aria-pressed')).toBe('true');
    expect(await page.locator('#commentStatus').textContent()).toBe('Click an element in the page. Escape cancels.');
    // Escape ends the pick and leaves the thread open; a second Escape is the rail's.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.canvasFrames.picking() === null);
    expect(await page.locator('#threadView').isVisible()).toBe(true);
    await page.waitForFunction(() => document.getElementById('commentPick')?.getAttribute('aria-pressed') === 'false');
    expect(await page.locator('#commentAbout').isHidden()).toBe(true);

    // A press on the control while it is picking cancels, and does not start again.
    await page.locator('#commentPick').click();
    await page.waitForFunction(() => window.canvasFrames.picking() === 'board');
    await page.locator('#commentPick').click();
    await page.waitForFunction(() => document.getElementById('commentPick')?.getAttribute('aria-pressed') === 'false');
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.canvasFrames.picking())).toBeNull();

    await page.locator('#commentPick').click();
    await page.waitForFunction(() => window.canvasFrames.picking() === 'board');
    await (await frameOf()).waitForSelector('[data-codeman-frame-bridge]', { state: 'attached' });
    const box = await inFrame('#stop');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    // No popover on this path: the element goes straight to the comment being written.
    await page.waitForSelector('#commentAbout:not([hidden])');
    expect(await page.locator('#elementPopover').isHidden()).toBe(true);
    expect(await page.locator('#commentAboutShow').textContent()).toBe('button "Stop"');
    await page.waitForFunction(() => document.activeElement?.id === 'commentDraft');
    await page.keyboard.type('Picked from the thread');
    await page.keyboard.press('Control+Enter');
    await page.waitForSelector('#threadList .comment .comment-element');
    expect(ElementRefSchema.parse(commands.at(-1)!.arguments.element).selector).toBe('#stop');
    expect((await chips())[0]).toMatchObject({ name: 'button "Stop"', number: '1' });

    // An object that is not a live page offers no pick.
    const made = await page.request.post(api('/ops'), {
      data: {
        operations: [
          {
            kind: 'create',
            opId: 'seed-note',
            objectId: 'note',
            patch: {
              parentId: null,
              order: 900,
              position: { x: 520, y: 40 },
              size: { width: 180, height: 90 },
              content: { type: 'text', text: 'A note' },
            },
          },
        ],
      },
    });
    expect(made.ok()).toBe(true);
    await page.waitForSelector('[data-object-id="note"]');
    await page.evaluate(() => {
      window.canvasView.dispatch({ kind: 'focus', id: 'note' });
      window.canvasView.dispatch({ kind: 'selection', ids: ['note'] });
    });
    await page.waitForFunction(() => document.getElementById('threadTarget')?.textContent === 'A note');
    expect(await page.locator('#commentPick').isHidden()).toBe(true);
  }, 90000);

  it('says an element is no longer on the page when a later version drops it, and keeps the pin of one that stayed', async () => {
    await seed();
    await open();
    await commentOn('#start', 'Stays');
    await commentOn('#stop', 'Goes away');
    await expect.poll(() => pinTexts()).toEqual(['1', '2']);
    expect((await chips()).map((c) => c.state)).toEqual(['found', 'found']);

    // The page changes under the same address; Reload brings a new frame, and the same selectors are tried in it.
    withStop = false;
    await page.locator('[data-object-id="board"] [data-media-action="reload"]').click();
    await expect.poll(() => pinTexts(), { timeout: 15000 }).toEqual(['1']);
    await expect.poll(() => pinOffset(0, '#start')).toBeLessThan(1.5);
    await expect
      .poll(async () => (await chips()).map((c) => [c.text, c.state, c.where]))
      .toEqual([
        ['Stays', 'found', 'src/board.html:4'],
        ['Goes away', 'missing', 'No longer on the page'],
      ]);
    // The chip still names what the comment was about, and activating it shows the embed without a false mark.
    expect((await chips())[1].name).toBe('button "Stop"');
    await page.locator('.comment-element[data-state="missing"]').click();
    await page.waitForTimeout(1200);
    expect(await page.locator('#elementMark').isHidden()).toBe(true);

    // The element returns with the page, and so does its pin.
    withStop = true;
    await page.locator('[data-object-id="board"] [data-media-action="reload"]').click();
    await expect.poll(() => pinTexts(), { timeout: 15000 }).toEqual(['1', '2']);
    await expect.poll(async () => (await chips()).map((c) => c.state)).toEqual(['found', 'found']);
  }, 120000);

  it('shows anchors that arrive from elsewhere, and renders whatever the page wrote as text', async () => {
    await seed();
    await open();
    await openThread();
    const markup = '<img src=x onerror="window.__pwned=1"><b>bold</b>';
    await serverComment('hostile-1', 'From an agent', {
      text: markup,
      source: '"><script>window.__pwned=2</script>',
      path: '<i>path</i>',
    });
    await page.waitForSelector('#threadList .comment .comment-element');
    await expect.poll(() => pins().count()).toBe(1);
    const chip = (await chips())[0];
    expect(chip.name).toBe(`button "${markup.slice(0, 39)}…"`);
    expect(chip.where).toBe('"><script>window.__pwned=2</script>');
    expect(await pins().getAttribute('aria-label')).toContain('<img src=x');
    expect(await pins().getAttribute('title')).toContain('<img src=x');
    // Nothing the page wrote became an element of the canvas document.
    expect(await page.locator('#threadList img, #threadList b, #threadList script, #threadList i').count()).toBe(0);
    expect(await page.locator('#elementPins img, #elementPins b, #elementPins script').count()).toBe(0);
    expect(await page.locator('.comment-element').evaluate((el) => el.children.length)).toBe(3);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();

    // The same in the composer, for an element that is about to be commented on.
    await page.evaluate((text) => {
      window.canvasFrames.addPickAction({ id: 'noop', label: text, run: () => {} });
    }, markup);
    await pick('#start');
    expect(await page.locator('#elementPopoverActions img, #elementPopoverActions b').count()).toBe(0);
    await commentAction().click();
    await page.waitForSelector('#commentAbout:not([hidden])');
    expect(await page.locator('#commentAbout img, #commentAbout b').count()).toBe(0);

    // A comment without an element posted from elsewhere has no chip, and a later anchored one joins the pin.
    await serverComment('plain-1', 'No element here');
    await serverComment('hostile-2', 'Same element', {});
    await expect.poll(() => pinTexts()).toEqual(['1×2']);
    expect((await chips()).map((c) => [c.text, c.number])).toEqual([
      ['From an agent', '1'],
      ['No element here', null],
      ['Same element', '1'],
    ]);
  }, 90000);

  it('asks an agent from a comment about an element with the same calls as any thread request', async () => {
    await seed();
    await page.route('**/api/canvas/*/conversations', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      sends.push({ path: '/conversations', body: route.request().postDataJSON() });
      await route.fulfill({ json: { success: true, data: { conversation: { id: 'conversation-1' } } } });
    });
    await page.route('**/api/canvas/*/conversations/*/messages', async (route) => {
      sends.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
      await route.fulfill({ json: { success: true, data: {} } });
    });
    await open();
    await page.waitForFunction(() => document.querySelectorAll('#providerSelect option[value="claude"]').length === 1);
    await pick('#start');
    await commentAction().click();
    await page.waitForFunction(() => document.activeElement?.id === 'commentDraft');
    await page.keyboard.type('Why is this button amber?');
    await page.locator('#askAgent').click();
    await page.waitForSelector('#threadList .comment .comment-element');
    await expect.poll(() => sends.length).toBe(2);

    // The comment carries the element; the request to the agent names the comment and nothing more.
    expect(commands).toHaveLength(1);
    const commentId = commands[0].arguments.commentId as string;
    expect(ElementRefSchema.parse(commands[0].arguments.element).selector).toBe('#start');
    const thread = { kind: 'thread', objectId: 'board', commentId };
    expect(sends[0].body).toMatchObject({ origin: thread });
    expect(sends[1].path).toMatch(/\/conversations\/conversation-1\/messages$/);
    expect(sends[1].body).toEqual({
      messageId: expect.any(String),
      text: 'Why is this button amber?',
      refIds: ['board'],
      origin: thread,
    });
    // The server holds the anchor the send's origin points at, which is where the agent's context gets the element.
    expect((await anchors())[commentId]).toMatchObject({ selector: '#start', text: 'Start task' });

    expect(await chips()).toEqual([
      {
        text: 'Why is this button amber?',
        number: '1',
        name: 'button "Start task"',
        where: 'src/board.html:4',
        state: 'found',
      },
    ]);
    expect(await page.locator('#commentAbout').isHidden()).toBe(true);
    expect(await page.locator('#commentDraft').inputValue()).toBe('');
    await expect.poll(() => pins().count()).toBe(1);

    // The agent's reply is an ordinary comment in the same thread: no element, no second pin.
    await serverComment('reply-1', 'It uses the accent token.');
    await page.waitForFunction(() => document.querySelectorAll('#threadList .comment').length === 2);
    expect((await chips())[1]).toMatchObject({ text: 'It uses the accent token.', number: null });
    expect(await pinTexts()).toEqual(['1']);
  }, 90000);

  it('shows the element as text on a phone, with no pin and no pick', async () => {
    await seed();
    await serverComment('phone-1', 'Read on a phone', { source: 'src/Card.tsx:27' });
    await context.close();
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      hasTouch: true,
      isMobile: true,
    });
    page = await context.newPage();
    await page.goto(`${origin}/x/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-phone'));
    await page.waitForFunction(() => !!window.canvasView && window.canvasComments.read().length === 1);
    await page.evaluate(() => {
      window.canvasView.dispatch({ kind: 'focus', id: 'board' });
      window.canvasView.dispatch({ kind: 'rail', view: 'thread' });
    });
    await page.waitForSelector('#threadList .comment .comment-element');
    expect(await chips()).toEqual([
      {
        text: 'Read on a phone',
        number: '1',
        name: 'button "Start task"',
        where: 'src/Card.tsx:27',
        state: 'unknown',
      },
    ]);
    expect(await page.locator('#threadList .comment-element').isVisible()).toBe(true);
    expect(await page.locator('#elementPins .element-pin').count()).toBe(0);
    expect(await page.locator('#commentPick').isHidden()).toBe(true);
    expect(await page.locator('.embed-stage > iframe').count()).toBe(0);
  }, 60000);
});
