/**
 * Phone canvas: reading, navigation and comments only. Headless Chromium reports no
 * touch even with touch emulation, so `window.__canvasTouch` forces the touch branch of
 * the one phone-mode helper (packages/canvas/src/mobile.ts).
 */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright';
import puppeteer from 'puppeteer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebServer } from '../../src/web/server.js';
import { dataPath } from '../../src/config/instance.js';
import { workspaceForCase } from '../../src/canvas/workspace-registry.js';
import { resolveCasesDir } from '../../src/web/route-helpers.js';
import { CanvasStores } from '../../src/canvas/canvas-store.js';
import { CommandSchema, type Command } from '../../src/canvas/operations.js';

const MEDIA = resolve('pr/media');
const stamp = Date.now();
const shot = (page: Page, slug: string) =>
  page.screenshot({ animations: 'disabled', path: resolve(MEDIA, `pc6-review-${stamp}-${slug}.png`) });
const item = (
  id: string,
  parentId: string | null,
  type: string,
  x: number,
  y: number,
  w: number,
  h: number,
  text: string
) =>
  CommandSchema.parse({
    kind: 'create',
    opId: `create-${id}`,
    objectId: id,
    patch: {
      parentId,
      order: x + y,
      position: { x, y },
      size: { width: w, height: h },
      content: type === 'text' ? { type, text } : { type, label: text },
    },
  });
const long =
  'Long passage about glasshouse typography. Readers moving across a wide board need a stable anchor, so the reading panel keeps the text in one column and never shifts while you pan. '.repeat(
    3
  );

describe('phone canvas', () => {
  let server: WebServer, browser: Browser, context: BrowserContext, page: Page, cdp: CDPSession;
  let origin: string, workspace: string;
  const writes: string[] = [];
  const view = () => page.evaluate(() => window.canvasView.read());
  async function touch(type: 'touchStart' | 'touchMove' | 'touchEnd', points: { x: number; y: number }[]) {
    await cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map((p, id) => ({ x: Math.round(p.x), y: Math.round(p.y), id })),
    });
  }
  async function tapAt(x: number, y: number) {
    await touch('touchStart', [{ x, y }]);
    await touch('touchEnd', []);
  }
  async function tapEl(selector: string) {
    const box = (await page.locator(selector).first().boundingBox())!;
    await tapAt(box.x + Math.min(24, box.width / 2), box.y + Math.min(24, box.height / 2));
  }
  async function open(width = 390, height = 844) {
    context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      hasTouch: true,
      isMobile: true,
    });
    await context.addInitScript(() => {
      window.__canvasTouch = true;
      if (!localStorage.getItem('codeman:skin')) localStorage.setItem('codeman:skin', 'og');
      // A controllable visual viewport stands in for the software keyboard.
      const fake = new EventTarget() as EventTarget & Record<string, number>;
      Object.assign(fake, { width: innerWidth, height: innerHeight, offsetTop: 0, offsetLeft: 0, scale: 1 });
      Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake });
      (window as unknown as { __keyboard: (h: number) => void }).__keyboard = (h: number) => {
        fake.height = innerHeight - h;
        fake.dispatchEvent(new Event('resize'));
      };
    });
    page = await context.newPage();
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/api\/canvas\/[^/]+\/(ops|command|revert)$/.test(request.url()))
        writes.push(request.postData() ?? '');
    });
    cdp = await context.newCDPSession(page);
    await page.goto(`${origin}/x/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-object-id="brief"]');
    await page.waitForTimeout(300);
  }
  beforeAll(async () => {
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-pc6-phone');
    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasEnabled: true }));
    mkdirSync(resolve(resolveCasesDir(), 'canvas-demo'), { recursive: true });
    workspace = workspaceForCase('canvas-demo').id;
    const stores = new CanvasStores();
    const human = { kind: 'human' as const, userId: 'admin' };
    const commands: Command[] = [
      item('research', null, 'section', 0, 0, 920, 640, 'Design exploration'),
      item('reading', 'research', 'frame', 24, 56, 420, 560, 'Reading patterns'),
      item('brief', 'reading', 'text', 24, 32, 360, 40, 'Readers scan headings first'),
      item('short', 'reading', 'text', 24, 96, 360, 40, 'Short lines beat long ones'),
      item('long', 'reading', 'text', 24, 160, 360, 360, long),
      item('refs', 'research', 'frame', 476, 56, 420, 300, 'Reference notes'),
      item('tap', 'refs', 'text', 24, 32, 360, 60, 'Note: tap targets need space'),
    ];
    expect(stores.get(workspace).append(commands, human).ok).toBe(true);
    expect(
      stores.get(workspace).append(
        [
          CommandSchema.parse({
            kind: 'comment',
            opId: 'c0',
            objectId: 'tap',
            patch: { id: 'c0', text: '44 px at least.' },
          }),
        ],
        { kind: 'agent', sessionId: 'reader-agent-1' }
      ).ok
    ).toBe(true);
    stores.flush();
    server = new WebServer(0, false, true, undefined, undefined, undefined, '/x');
    await server.start();
    origin = `http://localhost:${server.boundPort}`;
    browser = await chromium.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: ['--no-sandbox'],
    });
    mkdirSync(MEDIA, { recursive: true });
    await open();
  }, 60000);
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    vi.unstubAllEnvs();
  }, 60000);

  async function readableFirstView(width: number) {
    const v = await view();
    expect(v.viewport.zoom).toBeGreaterThanOrEqual(12 / 14 - 1e-9);
    const body = await page.locator('[data-object-id="brief"] .object-body').evaluate((el) => {
      const zoom = el.getBoundingClientRect().width / (el as HTMLElement).offsetWidth;
      return parseFloat(getComputedStyle(el).fontSize) * zoom;
    });
    expect(body).toBeGreaterThanOrEqual(12 - 0.01);
    const title = await page.locator('[data-object-id="research"] > .object-title').evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().toJSON();
    });
    const frame = (await page.locator('[data-object-id="research"]').boundingBox())!;
    expect(title.x).toBeGreaterThanOrEqual(8);
    expect(title.y).toBeGreaterThanOrEqual(8);
    expect(frame.x).toBeGreaterThanOrEqual(8);
    expect(frame.y).toBeGreaterThan(title.y);
    expect(frame.x + Math.min(frame.width, width - 32)).toBeLessThanOrEqual(width);
  }

  it('opens at a readable size anchored on the first section, with no board focus ring', async () => {
    await readableFirstView(390);
    expect(await page.locator('#board').evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none');
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-phone'))).toBe(true);
    await shot(page, 'phone-board');
  });

  it('fits every object above the dock when Fit is pressed with nothing selected', async () => {
    expect((await view()).selected).toEqual([]);
    await tapEl('#fit');
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const dockTop = await page.locator('.dock-area').evaluate((el) => el.getBoundingClientRect().top);
    const boxes = await page.evaluate(() =>
      [...document.querySelectorAll('#layer > [data-object-id]')].map((el) => el.getBoundingClientRect().toJSON())
    );
    for (const box of boxes) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(390);
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(dockTop);
    }
  });

  it('shows only phone controls: labelled Sections, Find, Comments and Fit, and no edit dock', async () => {
    for (const selector of [
      '#addTool',
      '#selectTool',
      '#panTool',
      '#undoEdit',
      '#redoEdit',
      '#keys',
      '#openOutline',
      '#outlineKeys',
    ])
      expect(await page.locator(`${selector}:visible`).count()).toBe(0);
    expect(await page.locator('.edit-control:visible, .resize-handle:visible').count()).toBe(0);
    for (const [selector, text] of [
      ['#sectionsTool', 'Sections'],
      ['#findTool', 'Find'],
      ['#chatTool', 'Comments'],
      ['#fit', 'Fit'],
    ]) {
      const control = page.locator(selector);
      expect((await control.textContent())?.trim()).toBe(text);
      const box = (await control.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }
  });

  it('gives container titles a 44 px hit area without changing the drawn label', async () => {
    const title = page.locator('[data-object-id="reading"] > .object-title');
    const box = (await title.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(43.5);
    const text = await title.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().toJSON();
    });
    const frame = (await page.locator('[data-object-id="reading"]').boundingBox())!;
    expect(text.bottom).toBeLessThanOrEqual(frame.y);
  });

  it('pans with one finger from an object without selecting it, and sends no write', async () => {
    const before = await view();
    const start = writes.length;
    const box = (await page.locator('[data-object-id="short"]').boundingBox())!;
    const from = { x: box.x + 10, y: box.y + box.height / 2 };
    await touch('touchStart', [from]);
    for (let i = 1; i <= 8; i++) await touch('touchMove', [{ x: from.x - i * 10, y: from.y - i * 6 }]);
    await touch('touchEnd', []);
    const after = await view();
    expect(after.viewport.x).toBeLessThan(before.viewport.x - 40);
    expect(after.selected).toEqual(before.selected);
    expect(writes.length).toBe(start);
    expect(
      await page.evaluate(() => window.canvasEdit.apply([{ kind: 'delete', opId: 'phone-delete', objectId: 'short' }]))
    ).toBe(false);
    expect(
      await page.evaluate(() =>
        window.canvasEdit.command({ tool: 'canvas_delete', arguments: { ids: ['short'] } } as Parameters<
          typeof window.canvasEdit.command
        >[0])
      )
    ).toBe(false);
    await page.waitForTimeout(100);
    expect(writes.length).toBe(start);
    await page.locator('#fit').click();
  });

  it('pinches about the fingers at 40 frames per second or better', async () => {
    const before = await view();
    await touch('touchStart', [
      { x: 150, y: 400 },
      { x: 240, y: 400 },
    ]);
    for (let i = 1; i <= 10; i++)
      await touch('touchMove', [
        { x: 150 - i * 6, y: 400 },
        { x: 240 + i * 6, y: 400 },
      ]);
    await touch('touchEnd', []);
    const after = await view();
    expect(after.viewport.zoom).toBeGreaterThan(before.viewport.zoom * 1.5);
    const fps = await page.evaluate(
      () =>
        new Promise<number>((done) => {
          let frames = 0;
          const started = performance.now();
          const step = () => {
            const spread = 100 + (frames % 30) * 4;
            window.canvasView.dispatch({
              kind: 'pinch',
              before: [
                { x: 195 - spread / 2, y: 400 },
                { x: 195 + spread / 2, y: 400 },
              ],
              after: [
                { x: 195 - spread / 2 - 2, y: 400 },
                { x: 195 + spread / 2 + 2, y: 400 },
              ],
            });
            if (++frames < 90) requestAnimationFrame(step);
            else done((frames * 1000) / (performance.now() - started));
          };
          requestAnimationFrame(step);
        })
    );
    console.log(`[perf] phone pinch ${fps.toFixed(1)} fps`);
    expect(fps).toBeGreaterThanOrEqual(40);
    await page.locator('#fit').click();
  });

  it('opens Sections without raising the keyboard, and Find focuses search on request', async () => {
    await tapEl('#sectionsTool');
    await page.waitForSelector('#outline:not([hidden])');
    expect(await page.evaluate(() => document.activeElement?.id)).not.toBe('search');
    await shot(page, 'phone-outline');
    await tapEl('#closeOutline');
    await tapEl('#findTool');
    await page.waitForSelector('#outline:not([hidden])');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('search');
    await page.locator('#closeOutline').click();
  });

  it('brings an outline pick fully above the dock and sheet, and a second pick opens the reader', async () => {
    await tapEl('#sectionsTool');
    await page.waitForSelector('#outline:not([hidden])');
    await page.locator('[data-row-id="long"]').click();
    await page.waitForSelector('#sheet:not([hidden])');
    const target = (await page.locator('[data-object-id="long"]').boundingBox())!;
    const sheet = (await page.locator('#sheet').boundingBox())!;
    expect(target.y).toBeGreaterThanOrEqual(0);
    expect(Math.min(target.y + target.height, sheet.y)).toBeLessThanOrEqual(sheet.y);
    expect(target.y + Math.min(target.height, sheet.y - 32)).toBeLessThanOrEqual(sheet.y);
    await tapEl('#sectionsTool');
    await page.locator('[data-row-id="long"]').click();
    await page.waitForSelector('#readerView:not([hidden])');
    expect(await page.locator('#readerText').textContent()).toContain('glasshouse');
    await page.locator('#closeRail').click();
  });

  it('shows a bottom sheet for a tapped object with Read, Comments and Focus parent', async () => {
    await page.waitForSelector('#rail', { state: 'hidden' });
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    if (await page.locator('#sheet').isVisible()) await tapEl('#closeSheet');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    expect((await view()).selected).toEqual([]);
    await page.locator('#fit').click();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await tapEl('[data-object-id="tap"]');
    await page.waitForSelector('#sheet:not([hidden])');
    expect(await page.locator('#sheetTitle').textContent()).toBe('Note: tap targets need space');
    expect(await page.locator('#sheetComments').textContent()).toBe('Comments · 1');
    expect(await page.locator('#sheetMeta').isVisible()).toBe(false);
    for (const id of ['#sheetRead', '#sheetComments', '#sheetParent', '#closeSheet'])
      expect((await page.locator(id).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await shot(page, 'phone-sheet');
    await tapEl('#sheetRead');
    await page.waitForSelector('#readerView:not([hidden])');
    await page.locator('#closeRail').click();
    await page.waitForSelector('#rail', { state: 'hidden' });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('sheetRead');
  });

  it('posts a comment from the phone with the composer above the keyboard, and returns focus', async () => {
    const start = writes.length;
    await tapEl('#sheetComments');
    await page.waitForSelector('#threadView:not([hidden])');
    expect(await page.evaluate(() => document.activeElement?.id)).not.toBe('commentDraft');
    await page.locator('#commentDraft').tap();
    await page.evaluate(() => (window as unknown as { __keyboard: (h: number) => void }).__keyboard(320));
    await page.waitForTimeout(50);
    const composer = (await page.locator('#commentForm').boundingBox())!;
    expect(composer.y + composer.height).toBeLessThanOrEqual(844 - 320 + 1);
    await page.keyboard.type('Read on the phone. <script>alert(1)</script>');
    expect(await page.locator('#commentStatus').textContent()).toBe('');
    await shot(page, 'phone-thread');
    await page.locator('#postComment').tap();
    await page.waitForFunction(() => document.querySelectorAll('#threadList .comment').length === 2);
    expect(await page.locator('#threadList script').count()).toBe(0);
    expect(writes.slice(start).every((body) => JSON.parse(body).tool === 'canvas_comment')).toBe(true);
    await page.evaluate(() => (window as unknown as { __keyboard: (h: number) => void }).__keyboard(0));
    await page.locator('#closeRail').click();
    await page.waitForSelector('#rail', { state: 'hidden' });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('sheetComments');
  });

  it('shows the phone comment on a desktop tab within a second', async () => {
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await desktop.goto(`${origin}/x/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
    await desktop.waitForSelector('[data-object-id="tap"] > .comment-mark');
    await desktop.waitForTimeout(500);
    const started = Date.now();
    expect(await page.evaluate(() => window.canvasComments.post('tap', 'Second note from the phone.'))).toBe(true);
    await desktop.waitForFunction(
      () => document.querySelector('[data-object-id="tap"] > .comment-mark')?.textContent === '3',
      undefined,
      { timeout: 1000 }
    );
    expect(Date.now() - started).toBeLessThan(1000);
    await desktop.close();
    await page.locator('#closeRail').click();
  });

  it('keeps history read-only on a phone', async () => {
    await page.waitForSelector('#rail', { state: 'hidden' });
    await page.waitForSelector('#sectionsTool', { state: 'visible' });
    await tapEl('#sectionsTool');
    await page.locator('#outlineHistory').click();
    await page.waitForSelector('#historyList .history-row');
    expect(await page.locator('.history-revert').count()).toBe(0);
    await page.locator('#closeRail').click();
  });

  it('opens readable on a 414 x 714 Safari-sized viewport too', async () => {
    await context.close();
    await open(414, 714);
    await readableFirstView(414);
    await shot(page, 'phone-board-414');
  });

  it('lists a canvas entry per case on the phone home screen, with no new header button', async () => {
    const home = await browser.newPage({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      hasTouch: true,
      isMobile: true,
    });
    await home.goto(`${origin}/x/`, { waitUntil: 'domcontentloaded' });
    await home.waitForSelector('#mobileOverview:not([hidden])');
    await home.waitForSelector('[data-mo-action="canvas"][data-mo-case="canvas-demo"]', { timeout: 10000 });
    expect(await home.locator('.header [data-mo-action="canvas"], header [data-mo-action="canvas"]').count()).toBe(0);
    await home.locator('[data-mo-action="canvas"][data-mo-case="canvas-demo"]').scrollIntoViewIfNeeded();
    await home.screenshot({ animations: 'disabled', path: resolve(MEDIA, `pc6-review-${stamp}-phone-home.png`) });
    await home.close();
  });
});
