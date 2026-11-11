import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import puppeteer from 'puppeteer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebServer } from '../src/web/server.js';
import { dataPath } from '../src/config/instance.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';
import { CanvasStores } from '../src/canvas/canvas-store.js';
import { CommandSchema } from '../src/canvas/operations.js';
import type { ViewObject } from '../packages/canvas/src/model.js';

const MEDIA = resolve('pr/media');
const stamp = Date.now();
const shot = (page: Page, slug: string) =>
  page.screenshot({ animations: 'disabled', path: resolve(MEDIA, `pc3-review-${stamp}-${slug}.png`) });
const item = (
  id: string,
  parentId: string | null,
  type: string,
  x: number,
  y: number,
  width: number,
  height: number,
  text: string
) =>
  CommandSchema.parse({
    kind: 'create',
    opId: `create-${id}`,
    objectId: id,
    patch: {
      parentId,
      order: x,
      position: { x, y },
      size: type === 'group' ? null : { width, height },
      content: type === 'text' ? { type, text } : { type, label: text },
    },
  });
describe('read-only canvas document', () => {
  let server: WebServer, browser: Browser, page: Page, origin: string, workspace: string;
  let increment = 0;
  beforeAll(async () => {
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-pc3-owner');
    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasEnabled: true }));
    mkdirSync(resolve(resolveCasesDir(), 'Fieldnotes'), { recursive: true });
    workspace = workspaceForCase('Fieldnotes').id;
    const stores = new CanvasStores();
    const result = stores
      .get(workspace)
      .append(
        [
          item('research', null, 'section', 0, 0, 920, 500, 'Design exploration'),
          item('frame-one', 'research', 'frame', 24, 56, 268, 360, 'Reading patterns'),
          item(
            'brief',
            'frame-one',
            'text',
            20,
            24,
            224,
            280,
            'What a saved page should remember\n\nThe title, a useful excerpt and a note in your own words. Keep the reason you wanted to return.'
          ),
          item('frame-two', 'research', 'frame', 316, 56, 260, 360, 'Reference notes'),
          item(
            'notes',
            'frame-two',
            'text',
            20,
            24,
            220,
            260,
            'A place to return, not another inbox to keep up with.\n\nCapture, then choose what deserves a place.'
          ),
          item(
            'headline',
            'research',
            'text',
            616,
            56,
            272,
            300,
            'A place for what stays with you.\n\nSave the passage, not just the page. Return to an idea when it has something more to say.'
          ),
          item('caption', null, 'text', 24, 580, 720, 56, 'Keep the ideas you come back to.'),
          item('nested-group', null, 'group', 1000, 0, 0, 0, 'Archive'),
          item('nested-text', 'nested-group', 'text', -20, 40, 240, 100, 'A quiet place for references.'),
        ],
        { kind: 'agent', sessionId: 'design-agent' }
      );
    expect(result.ok).toBe(true);
    stores.flush();
    server = new WebServer(0, false, true, undefined, undefined, undefined, '/x');
    await server.start();
    origin = `http://localhost:${server.boundPort}`;
    browser = await chromium.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: ['--no-sandbox'],
    });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await page.addInitScript(() => localStorage.setItem('codeman:skin', 'og'));
    mkdirSync(MEDIA, { recursive: true });
  }, 60000);
  afterEach(async () => {
    await page?.unroute('**/api/canvas/*/objects');
    await page?.context().setOffline(false);
  });
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    vi.unstubAllEnvs();
  }, 60000);
  async function open(selector = '[data-object-id="brief"]') {
    await page.goto(`${origin}/x/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(selector);
    await page.waitForFunction(() => !!window.canvasView);
  }
  async function createLive(id: string) {
    const response = await page.request.post(`${origin}/x/api/canvas/${workspace}/ops`, {
      data: { operations: [item(id, 'research', 'text', 616, 380, 200, 70, '<img onerror="alert(1)">')] },
    });
    expect(response.ok()).toBe(true);
  }
  it('renders nested objects in the authenticated base-path document and captures the board', async () => {
    await open();
    expect(await page.locator('[data-object-id="frame-one"] > [data-object-id="brief"]').count()).toBe(1);
    expect(await page.locator('#outline').evaluate((el) => el.getBoundingClientRect().width)).toBe(192);
    expect(await page.locator('#board').evaluate((el) => getComputedStyle(el).backgroundImage)).toBe('none');
    await shot(page, 'board-outline');
    await page.locator('#closeOutline').click();
    await shot(page, 'outline-collapsed');
    await page.locator('#openOutline').click();
    await page.locator('#search').fill('Design exploration');
    await page.locator('#tree button:visible').click();
    await page.locator('#search').fill('');
    await page.locator('#board').focus();
    await shot(page, 'selected-group');
  });
  it('separates keyboard focus from selection, drills into children and restores focus from the rail', async () => {
    await open();
    await page.locator('#board').focus();
    await page.keyboard.press('k');
    await page.keyboard.press('ArrowRight');
    await page.waitForSelector('.keyboard-focus', { state: 'attached' });
    expect(await page.locator('.keyboard-focus').count()).toBe(1);
    await shot(page, 'keyboard-focus');
    await page.keyboard.press('x');
    const before = await page.evaluate(() => window.canvasView.read());
    const focusedId = await page.evaluate(() => document.activeElement?.getAttribute('data-object-id'));
    await page.keyboard.press('Enter');
    await page.waitForSelector('#readerView:not([hidden])');
    await shot(page, 'object-reader');
    await page.keyboard.press('F1');
    await page.waitForSelector('#keysView:not([hidden])');
    await shot(page, 'keys');
    await page.keyboard.press('F1');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#readerView:not([hidden])');
    expect(await page.locator('#readerView').isVisible()).toBe(true);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#rail', { state: 'hidden' });
    expect(await page.locator('#rail').isVisible()).toBe(false);
    expect(await page.evaluate(() => window.canvasView.read())).toEqual(before);
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-object-id'))).toBe(focusedId);
    await shot(page, 'rail-closed');
  });
  it('preserves the pointer zoom anchor and keeps view state across a live write under one second', async () => {
    const before = await page.evaluate(() => window.canvasView.read());
    await page.mouse.move(700, 450);
    await page.mouse.wheel(0, -150);
    await page.waitForTimeout(100);
    const after = await page.evaluate(() => window.canvasView.read());
    expect((700 - before.viewport.x) / before.viewport.zoom).toBeCloseTo(
      (700 - after.viewport.x) / after.viewport.zoom
    );
    const state = await page.evaluate(() => window.canvasView.read());
    const id = `live-${++increment}`,
      started = Date.now();
    await createLive(id);
    await page.waitForSelector(`[data-object-id="${id}"]`, { timeout: 1000 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await page.evaluate(() => window.canvasView.read())).toEqual(state);
    expect(await page.locator(`[data-object-id="${id}"] img`).count()).toBe(0);
    expect(await page.locator(`[data-object-id="${id}"]`).textContent()).toContain('<img onerror');
    await shot(page, 'zoom-live-inert');
  });
  it('suppresses shortcut letters, spaces and IME in search and on native controls', async () => {
    await open();
    await page.locator('#closeOutline').click();
    await page.waitForSelector('#outline', { state: 'hidden' });
    await page.locator('#board').focus();
    await page.keyboard.press('/');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('search');
    const before = await page.evaluate(() => window.canvasView.read());
    await page.keyboard.type('jkhvx /');
    await page.keyboard.press('Space');
    expect(await page.evaluate(() => window.canvasView.read())).toEqual(before);
    await page.locator('#search').fill('');
    await page.locator('#board').focus();
    await page.evaluate(() => {
      document.dispatchEvent(new CompositionEvent('compositionstart'));
      document
        .getElementById('board')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true, isComposing: true }));
      document.dispatchEvent(new CompositionEvent('compositionend'));
    });
    expect(await page.evaluate(() => window.canvasView.read())).toEqual(before);
    await page.locator('#selectTool').focus();
    await page.keyboard.press('h');
    expect(await page.evaluate(() => window.canvasView.read().tool)).toBe('select');
  });
  it('retains the board offline and catches up five missed operations on reconnect', async () => {
    await page.context().setOffline(true);
    await page.waitForTimeout(300);
    await page.waitForSelector('#notice:not([hidden])', { timeout: 15000 });
    await shot(page, 'offline');
    for (let i = 0; i < 5; i++) await createLive(`reconnect-${i}`);
    await page.context().setOffline(false);
    await page.waitForSelector('[data-object-id="reconnect-4"]', { timeout: 15000 });
    expect(await page.locator('[data-object-id^="reconnect-"]').count()).toBe(5);
  }, 30000);
  it('designs loading, error/retry, empty, unknown content and long text states', async () => {
    await page.route('**/api/canvas/*/objects', async (route) => {
      await new Promise((r) => setTimeout(r, 200));
      await route.fulfill({ status: 500, body: '{}' });
    });
    await page.goto(`${origin}/x/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
    await shot(page, 'loading');
    await page.waitForSelector('#retry:not([hidden])');
    await shot(page, 'error');
    await page.unroute('**/api/canvas/*/objects');
    await page.route('**/api/canvas/*/objects', (route) =>
      route.fulfill({ json: { success: true, data: { seq: 1000, objects: [] } } })
    );
    await page.locator('#retry').click();
    await page.waitForFunction(() => document.querySelector('#state h1')?.textContent === 'A place for your work');
    await shot(page, 'empty');
    await page.unroute('**/api/canvas/*/objects');
    const response = await page.request.get(`${origin}/x/api/canvas/${workspace}/objects`);
    const snapshot = await response.json();
    const first: ViewObject = snapshot.data.objects[0];
    const unknown = {
      ...first,
      id: 'future',
      parentId: null,
      type: 'new-widget',
      content: { type: 'new-widget' },
      size: { width: 300, height: 120 },
    };
    const long = {
      ...first,
      id: 'long',
      parentId: null,
      type: 'text',
      position: { x: 400, y: 0 },
      content: { type: 'text', text: 'Long reference '.repeat(30000) },
    };
    await page.route('**/api/canvas/*/objects', (route) =>
      route.fulfill({ json: { success: true, data: { seq: 1000, objects: [unknown, long] } } })
    );
    await open('[data-object-id="future"]');
    expect(await page.locator('[data-object-id="future"]').textContent()).toContain('Unsupported object · new-widget');
    await page.locator('[data-object-id="long"]').dblclick();
    await page.waitForSelector('#readerView:not([hidden])');
    expect(await page.locator('#readerText').textContent()).toContain('Long reference');
    await shot(page, 'long-unknown');
    await page.unroute('**/api/canvas/*/objects');
  });
  it('keeps phone board, outline and reader within the viewport with 44px controls', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open();
    expect(await page.locator('#outline').isVisible()).toBe(false);
    await shot(page, 'phone-board');
    await page.locator('#openOutline').click();
    await shot(page, 'phone-outline');
    expect(await page.locator('#outline').evaluate((el) => el.getBoundingClientRect().width)).toBe(390);
    await page.locator('#closeOutline').click();
    await page.locator('#keys').click();
    await page.waitForSelector('#rail:not([hidden])');
    expect(await page.locator('#rail').evaluate((el) => el.getBoundingClientRect().width)).toBe(390);
    expect(await page.locator('#closeRail').evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(
      44
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await shot(page, 'phone-keys');
  });
  it('pans 500 objects at at least 50fps and renders within a second', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const response = await page.request.get(`${origin}/x/api/canvas/${workspace}/objects`);
    const data = await response.json();
    const first: ViewObject = data.data.objects.find((o: ViewObject) => o.type === 'text');
    const many = Array.from({ length: 500 }, (_, i) => ({
      ...first,
      id: `perf-${i}`,
      parentId: null,
      position: { x: (i % 25) * 280, y: Math.floor(i / 25) * 180 },
      size: { width: 240, height: 140 },
    }));
    await page.route('**/api/canvas/*/objects', (route) =>
      route.fulfill({ json: { success: true, data: { seq: 1000, objects: many } } })
    );
    const start = Date.now();
    await page.goto(`${origin}/x/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-object-id="perf-499"]');
    const firstRender = Date.now() - start;
    expect(firstRender).toBeLessThan(1000);
    const fps = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let frames = 0;
          const start = performance.now();
          const tick = () => {
            window.canvasView.dispatch({ kind: 'pan', delta: { x: 1, y: 0.5 } });
            frames++;
            if (performance.now() - start < 5000) requestAnimationFrame(tick);
            else resolve(frames / ((performance.now() - start) / 1000));
          };
          requestAnimationFrame(tick);
        })
    );
    writeFileSync(
      resolve(MEDIA, `pc3-review-${stamp}-perf.json`),
      JSON.stringify({ objects: 500, firstRenderMs: firstRender, panFps: fps })
    );
    expect(fps).toBeGreaterThanOrEqual(50);
    await shot(page, '500-objects');
    await page.unroute('**/api/canvas/*/objects');
  });
  it('opens the case canvas through the existing managed tab and restores it after reload', async () => {
    await page.goto(`${origin}/x/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#quickStartCaseSearch');
    await page.locator('#quickStartCase').selectOption('Fieldnotes');
    await page.locator('#quickStartCaseSearch').click();
    await page.locator('[data-case-action="canvas"]').click();
    const frame = page.frameLocator('iframe.webview-iframe');
    await frame.locator('[data-object-id="brief"]').waitFor();
    const records = await (await page.request.get(`${origin}/x/api/webviews`)).json();
    const record = records.data.webviews.find((w: { origin: { managed?: string } }) => w.origin.managed === 'canvas');
    expect(record.embedMode).toBe('direct');
    expect(record.trusted).toBe(true);
    expect(record.name).toBe('Fieldnotes');
    await shot(page, 'managed-tab');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator(`.session-tab[data-webview-id="${record.id}"]`).click();
    await page.frameLocator('iframe.webview-iframe').locator('[data-object-id="brief"]').waitFor();
  });
  it('records the pan, zoom and live-write interaction for design review', async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      recordVideo: { dir: MEDIA, size: { width: 1440, height: 900 } },
    });
    const capture = await context.newPage();
    await capture.addInitScript(() => localStorage.setItem('codeman:skin', 'og'));
    await capture.goto(`${origin}/x/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
    await capture.waitForSelector('[data-object-id="brief"]');
    for (let i = 0; i < 4; i++) {
      await capture.locator('#panTool').click();
      await capture.mouse.move(700, 600);
      await capture.mouse.down();
      await capture.mouse.move(800 + i * 20, 540, { steps: 30 });
      await capture.mouse.up();
      await capture.waitForTimeout(2000);
      await capture.mouse.wheel(0, i % 2 ? 100 : -100);
      await capture.waitForTimeout(2000);
      if (i === 1) await createLive('video-write');
      await capture.waitForTimeout(4000);
    }
    const video = capture.video();
    await context.close();
    if (video) await video.saveAs(resolve(MEDIA, `pc3-review-${stamp}-interaction.webm`));
  }, 60000);
  it('follows the app light skin and themes native surfaces', async () => {
    await open();
    await page.evaluate(() => {
      localStorage.setItem('codeman:skin', 'paper-gray');
      window.dispatchEvent(new StorageEvent('storage', { key: 'codeman:skin' }));
    });
    expect(await page.locator('html').getAttribute('data-theme')).toBe('light');
    const colors = await page.locator('html').evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        background: style.backgroundColor,
        color: style.color,
        caret: style.caretColor,
        scheme: style.colorScheme,
      };
    });
    expect(colors).toEqual({
      background: 'rgb(232, 231, 227)',
      color: 'rgb(32, 33, 31)',
      caret: 'rgb(181, 71, 2)',
      scheme: 'light',
    });
    await shot(page, 'light');
    await page.evaluate(() => {
      localStorage.setItem('codeman:skin', 'og');
      window.dispatchEvent(new StorageEvent('storage', { key: 'codeman:skin' }));
    });
  });
  it('gates the canvas page with the synced setting and normal authentication', async () => {
    await page.request.put(`${origin}/x/api/settings`, { data: { canvasEnabled: false } });
    expect((await page.request.get(`${origin}/x/canvas/${workspace}`)).status()).toBe(404);
    expect((await page.request.get(`${origin}/x/canvas.html`)).status()).toBe(404);
    await page.request.put(`${origin}/x/api/settings`, { data: { canvasEnabled: true } });
  });
  it('requires normal login for the canvas document', async () => {
    await server.stop();
    vi.stubEnv('CODEMAN_USERNAME', 'canvas-test');
    vi.stubEnv('CODEMAN_PASSWORD', 'canvas-test-password');
    const protectedServer = new WebServer(0, false, true);
    try {
      await protectedServer.start();
      const response = await page.request.get(`http://localhost:${protectedServer.boundPort}/canvas/${workspace}`);
      expect(response.status()).toBe(401);
    } finally {
      await protectedServer.stop();
      vi.stubEnv('CODEMAN_USERNAME', undefined);
      vi.stubEnv('CODEMAN_PASSWORD', undefined);
    }
  });
});
