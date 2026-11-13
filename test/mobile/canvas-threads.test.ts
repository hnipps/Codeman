/**
 * Ask agent on a phone (PC10): the same controls, routes and records as desktop, at touch size, above the software
 * keyboard, with the request line and Open conversation in the thread.
 * Headless Chromium reports no touch even with touch emulation, so `window.__canvasTouch` forces the touch branch.
 */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import puppeteer from 'puppeteer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebServer } from '../../src/web/server.js';
import { dataPath } from '../../src/config/instance.js';
import { workspaceForCase } from '../../src/canvas/workspace-registry.js';
import { resolveCasesDir } from '../../src/web/route-helpers.js';
import { CanvasStores } from '../../src/canvas/canvas-store.js';
import { CommandSchema } from '../../src/canvas/operations.js';

vi.mock('../../src/utils/cli-installed-probes.js', async (original) => ({
  ...(await original<typeof import('../../src/utils/cli-installed-probes.js')>()),
  probeStockCliAvailability: async () => ({ claude: true }),
}));

const MEDIA = resolve('pr/media');
const stamp = Date.now();

describe('phone thread requests', () => {
  let server: WebServer, browser: Browser, context: BrowserContext, page: Page, origin: string, workspace: string;
  const posts: string[] = [];
  const view = () => page.evaluate(() => window.canvasView.read());
  const keyboard = (h: number) =>
    page.evaluate((px) => (window as unknown as { __keyboard: (h: number) => void }).__keyboard(px), h);
  const shot = (slug: string) =>
    page.screenshot({ animations: 'disabled', path: resolve(MEDIA, `pc10-${stamp}-phone-${slug}.png`) });

  beforeAll(async () => {
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-pc10-phone');
    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasEnabled: true }));
    mkdirSync(resolve(resolveCasesDir(), 'phone-threads'), { recursive: true });
    workspace = workspaceForCase('phone-threads').id;
    const stores = new CanvasStores();
    expect(
      stores.get(workspace).append(
        [
          CommandSchema.parse({
            kind: 'create',
            opId: 'create-brief',
            objectId: 'brief',
            patch: {
              parentId: null,
              order: 0,
              position: { x: 0, y: 0 },
              size: { width: 300, height: 80 },
              content: { type: 'text', text: 'Readers scan headings first' },
            },
          }),
        ],
        { kind: 'human', userId: 'admin' }
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
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      hasTouch: true,
      isMobile: true,
    });
    await context.addInitScript(() => {
      window.__canvasTouch = true;
      if (!localStorage.getItem('codeman:skin')) localStorage.setItem('codeman:skin', 'og');
      // A controllable visual viewport stands in for the software keyboard; it follows the window the rest of the time.
      let covered = 0;
      const fake = new EventTarget();
      Object.defineProperties(fake, {
        width: { get: () => innerWidth },
        height: { get: () => innerHeight - covered },
        offsetTop: { value: 0 },
        offsetLeft: { value: 0 },
        scale: { value: 1 },
      });
      Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake });
      (window as unknown as { __keyboard: (h: number) => void }).__keyboard = (h: number) => {
        covered = h;
        fake.dispatchEvent(new Event('resize'));
      };
    });
    page = await context.newPage();
    page.on('request', (r) => {
      const path = /\/api\/canvas\/[^/]+(\/(?:command|conversations)[^?]*)/.exec(r.url())?.[1];
      if (r.method() === 'POST' && path) posts.push(path.replace(/[0-9a-f-]{36}/, ':id'));
    });
    mkdirSync(MEDIA, { recursive: true });
    await page.goto(`${origin}/x/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-object-id="brief"]');
    await page.waitForFunction(() => !!window.canvasView);
    await page.waitForFunction(() => document.querySelectorAll('#providerSelect option[value="claude"]').length === 1);
    await page.evaluate(() => {
      window.canvasView.dispatch({ kind: 'focus', id: 'brief' });
      window.canvasView.dispatch({ kind: 'selection', ids: ['brief'] });
    });
    await page.locator('#chatTool').tap();
    await page.waitForSelector('#threadView:not([hidden])');
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  }, 60000);
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    vi.unstubAllEnvs();
  }, 60000);

  it('shows the Ask controls at touch size with 16px fields, inside the width', async () => {
    for (const selector of ['#askTarget', '#askAgent', '#postComment', '#commentDraft']) {
      const box = (await page.locator(selector).boundingBox())!;
      expect(box.height, selector).toBeGreaterThanOrEqual(44);
      expect(box.x, selector).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, selector).toBeLessThanOrEqual(390);
    }
    for (const selector of ['#askTarget', '#commentDraft'])
      expect(
        await page.locator(selector).evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
        selector
      ).toBeGreaterThanOrEqual(16);
    expect(await page.locator('#askTarget').evaluate((el) => (el as HTMLSelectElement).selectedOptions[0].text)).toBe(
      'New conversation · Claude Code'
    );
  });

  it('keeps the draft, the chooser and both buttons above the software keyboard', async () => {
    await page.locator('#commentDraft').tap();
    await keyboard(340);
    await page.waitForTimeout(150);
    const bottom = (await page.evaluate(() => innerHeight)) - 340;
    for (const selector of ['#commentDraft', '#askTarget', '#askAgent', '#postComment']) {
      const box = (await page.locator(selector).boundingBox())!;
      expect(box.y + box.height, selector).toBeLessThanOrEqual(bottom + 0.5);
      expect(box.y, selector).toBeGreaterThanOrEqual(0);
    }
    await shot('keyboard');
    await keyboard(0);
  });

  it('Return is a line break, and Ask agent sends through the same routes without moving the board', async () => {
    const before = await view();
    const draft = page.locator('#commentDraft');
    await draft.fill('first line');
    await draft.press('Enter');
    await draft.type('second line');
    expect(await draft.inputValue()).toBe('first line\nsecond line');
    await page.waitForTimeout(200);
    expect(posts).toEqual([]);
    await page.locator('#askAgent').tap();
    await page.waitForSelector('#threadList .comment-request');
    expect(posts).toEqual(['/command', '/conversations', '/conversations/:id/messages']);
    expect(await draft.inputValue()).toBe('');
    expect(await page.locator('#threadList .comment-text').textContent()).toBe('first line\nsecond line');
    expect(await page.locator('#threadList .request-state').textContent()).toMatch(/^Asked an agent · /);
    const open = page.locator('#threadList .request-open');
    expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const after = await view();
    expect(after.viewport).toEqual(before.viewport);
    expect(after.selected).toEqual(before.selected);
    await shot('asked');
  });

  it('Open conversation shows that session full-viewport, and the backlink returns to the thread', async () => {
    const before = await view();
    await page.locator('#threadList .request-open').tap();
    await page.waitForSelector('#assistantView:not([hidden])');
    await page.waitForSelector('#thread .turn-origin');
    expect((await page.locator('#rail').boundingBox())!).toMatchObject({ x: 0, y: 0, width: 390 });
    expect(await page.locator('#closeRail').isVisible()).toBe(true);
    const after = await view();
    expect(after.viewport).toEqual(before.viewport);
    expect(after.selected).toEqual(before.selected);
    const back = page.locator('#thread .turn-origin');
    expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await shot('conversation');
    await back.tap();
    await page.waitForSelector('#threadView:not([hidden])');
    expect((await view()).selected).toEqual(['brief']);
  });

  it('says Working on the asking comment while the turn runs, as the desktop does', async () => {
    const listed = await page.request.get(`${origin}/x/api/canvas/${workspace}/conversations`);
    const [conversation] = (await listed.json()).data.conversations as { sessionId: string }[];
    const hooked = await page.request.post(`${origin}/x/api/hook-event`, {
      data: {
        event: 'prompt_submitted',
        sessionId: conversation.sessionId,
        data: { session_id: conversation.sessionId },
      },
    });
    expect(hooked.status()).toBe(200);
    await page.waitForFunction(() => document.querySelector('.request-state')?.textContent?.endsWith('Working'));
  });
});
