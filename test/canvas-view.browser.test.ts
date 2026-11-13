import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import puppeteer from 'puppeteer';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
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
  const liveIds: string[] = [];
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
    await page.addInitScript(() => {
      if (!localStorage.getItem('codeman:skin')) localStorage.setItem('codeman:skin', 'og');
    });
    mkdirSync(MEDIA, { recursive: true });
  }, 60000);
  afterEach(async () => {
    await page?.unroute('**/api/canvas/*/objects');
    await page?.unroute('**/api/canvas/*/ops?*');
    await page?.context().setOffline(false);
    for (const id of liveIds.splice(0)) {
      const response = await page.request.post(`${origin}/x/api/canvas/${workspace}/ops`, {
        data: { operations: [{ kind: 'delete', opId: `cleanup-${id}`, objectId: id }] },
      });
      expect(response.ok()).toBe(true);
    }
  });
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    vi.unstubAllEnvs();
  }, 60000);
  async function open(selector = '[data-object-id="brief"]', state: 'visible' | 'attached' = 'visible') {
    await page.goto(`${origin}/x/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(selector, { state });
    await page.waitForFunction(() => !!window.canvasView);
  }
  async function createLive(id: string) {
    const response = await page.request.post(`${origin}/x/api/canvas/${workspace}/ops`, {
      data: { operations: [item(id, 'research', 'text', 616, 380, 200, 70, '<img onerror="alert(1)">')] },
    });
    expect(response.ok()).toBe(true);
    liveIds.push(id);
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

  it('reports an uncaught error and an unhandled rejection to the client-errors route under the base path', async () => {
    await open();
    const reports: { url: string; body: { message: string; stack?: string; url?: string } }[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/client-errors'))
        reports.push({ url: request.url(), body: request.postDataJSON() });
    });
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('planted canvas fault');
      });
      void Promise.reject(new Error('planted canvas rejection'));
    });
    await expect.poll(() => reports.length).toBe(2);
    expect(reports.every((report) => report.url === `${origin}/x/api/client-errors`)).toBe(true);
    const thrown = reports.find((report) => report.body.message.includes('planted canvas fault'))!;
    expect(thrown.body.stack).toContain('planted canvas fault');
    expect(thrown.body.url).toBe(`/x/canvas/${workspace}`);
    expect(reports.some((report) => report.body.message === 'planted canvas rejection')).toBe(true);
  });

  it('never earns a 429 from its own view publishes while a person clicks about', async () => {
    await open();
    const limited: string[] = [];
    const published: number[] = [];
    page.on('response', (response) => {
      if (!/\/api\/canvas\/[^/]+\/views\//.test(response.url()) || response.request().method() !== 'PUT') return;
      published.push(response.status());
      if (response.status() === 429) limited.push(response.url());
    });
    for (let round = 0; round < 6; round++) {
      await page.locator('[data-object-id="brief"]').click();
      await page.locator('[data-object-id="notes"]').click();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(1200);
    expect(published.length).toBeGreaterThan(1);
    expect(limited).toEqual([]);
  });

  it('keeps the real group bounds selectable between children while chrome stays outside', async () => {
    await page.route('**/api/canvas/*/objects', async (route) => {
      const response = await route.fetch();
      const snapshot = await response.json();
      const child = snapshot.data.objects.find((o: ViewObject) => o.id === 'nested-text');
      snapshot.data.objects.push({
        ...child,
        id: 'group-gap-child',
        position: { x: 300, y: 40 },
        size: { width: 100, height: 100 },
      });
      await route.fulfill({ json: snapshot });
    });
    await open();
    await page.evaluate(() => window.canvasView.dispatch({ kind: 'viewport', viewport: { x: -600, y: 100, zoom: 1 } }));
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const hitBounds = await page.locator('[data-object-id="nested-group"] > .group-bounds').boundingBox();
    if (!hitBounds) throw new Error('Missing group hit bounds');
    expect(hitBounds).toEqual({ x: 380, y: 140, width: 420, height: 100 });
    await page.mouse.click(660, 180);
    await page.waitForFunction(() => window.canvasView.read().selected.includes('nested-group'));
    expect(await page.evaluate(() => window.canvasView.read().selected)).toEqual(['nested-group']);
    const chrome = await page.locator('[data-object-id="nested-group"] > .selection-bounds').boundingBox();
    if (!chrome) throw new Error('Missing group selection chrome');
    expect(chrome.x).toBeCloseTo(hitBounds.x - 6);
    expect(chrome.y).toBeCloseTo(hitBounds.y - 6);
    expect(chrome.width).toBeCloseTo(hitBounds.width + 12);
    expect(chrome.height).toBeCloseTo(hitBounds.height + 12);
    expect(await page.locator('[data-object-id="nested-group"] > .resize-handle:visible').count()).toBe(0);
  });

  it('opens the reader by double-click and pans twice in one Space hold without toggling selection', async () => {
    await open();
    await page.locator('[data-object-id="brief"] .object-body').dblclick();
    await page.waitForSelector('#readerView:not([hidden])');
    expect(await page.locator('#readerText').textContent()).toContain('What a saved page');
    await page.keyboard.press('Escape');
    await page.locator('#board').focus();
    const selected = await page.evaluate(() => window.canvasView.read().selected);
    await page.keyboard.down('Space');
    for (let i = 0; i < 2; i++) {
      const before = await page.evaluate(() => window.canvasView.read().viewport.x);
      await page.mouse.move(1100, 700);
      await page.mouse.down();
      await page.mouse.move(1140, 700, { steps: 4 });
      await page.mouse.up();
      expect(await page.evaluate(() => window.canvasView.read().viewport.x)).toBeCloseTo(before + 40);
    }
    await page.keyboard.up('Space');
    expect(await page.evaluate(() => window.canvasView.read().selected)).toEqual(selected);
    await page.keyboard.press('Space');
    expect(await page.evaluate(() => window.canvasView.read().selected)).toEqual([]);
    await page.keyboard.down('Space');
    await page.mouse.click(1100, 700);
    await page.keyboard.up('Space');
    expect(await page.evaluate(() => window.canvasView.read().selected)).toEqual([]);
  });
  it('searches full text as a literal case-insensitive substring', async () => {
    await open();
    await page.locator('#search').fill('USEFUL EXCERPT');
    expect(await page.locator('#tree button:visible').allTextContents()).toEqual(['What a saved page should remember']);
    await shot(page, 'outline-search-full-text');
    await page.locator('#search').fill('[');
    expect(await page.locator('#tree button:visible').count()).toBe(0);
  });
  it('skips the exact future header, renders subcanvas children, and recovers unreadable catch-ups once', async () => {
    const response = await page.request.get(`${origin}/x/api/canvas/${workspace}/objects`);
    const snapshot = await response.json();
    const first: ViewObject = snapshot.data.objects[0];
    const parent = {
      ...first,
      id: 'subcanvas',
      parentId: null,
      type: 'subcanvas',
      content: { type: 'subcanvas', label: 'Subcanvas' },
    };
    const child = {
      ...first,
      id: 'sub-child',
      parentId: 'subcanvas',
      type: 'text',
      content: { type: 'text', text: 'Nested child' },
    };
    let snapshots = 0;
    let malformed = false;
    let since = '';
    await page.route('**/api/canvas/*/objects', (route) => {
      snapshots++;
      return route.fulfill({
        json: {
          success: true,
          data: { seq: snapshots === 1 ? 1 : 5, objects: snapshots === 1 ? [] : [parent, child] },
        },
      });
    });
    await page.route('**/api/canvas/*/ops?*', (route) => {
      since = new URL(route.request().url()).searchParams.get('since') ?? '';
      return route.fulfill({
        json: {
          success: true,
          data: {
            seq: malformed ? 5 : 4,
            operations:
              since === '5'
                ? []
                : malformed
                  ? [null]
                  : [
                      { seq: 3, opId: 'future-op', kind: 'future-operation', futurePayload: { keep: ['all'] } },
                      {
                        seq: 4,
                        kind: 'create',
                        prev: [
                          { objectId: parent.id, after: parent },
                          { objectId: child.id, after: child },
                        ],
                      },
                    ],
          },
        },
      });
    });
    // A closed sub-canvas keeps its children in the tree but draws them only once it is opened.
    await open('[data-object-id="sub-child"]', 'attached');
    expect(since).toBe('1');
    expect(await page.locator('[data-object-id="subcanvas"] > [data-object-id="sub-child"]').count()).toBe(1);
    expect(await page.locator('[data-object-id="sub-child"]').getAttribute('data-view')).toBe('out');
    expect(await page.locator('#tree button').allTextContents()).toEqual(['Subcanvas', 'Nested child']);
    malformed = true;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => document.getElementById('notice')?.hidden === true);
    await vi.waitFor(() => expect(snapshots).toBe(2));
    expect(since).toBe('4');
    expect(await page.locator('[data-object-id="sub-child"]').count()).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await vi.waitFor(() => expect(since).toBe('5'));
    expect(snapshots).toBe(2);
    expect(await page.locator('#notice').isVisible()).toBe(false);
  });
  it('separates keyboard focus from selection, drills into children and restores focus from the rail', async () => {
    await open();
    await page.locator('#board').focus();
    await page.keyboard.press('k');
    await page.keyboard.press('ArrowRight');
    await page.waitForSelector('#layer .keyboard-focus', { state: 'attached' });
    expect(await page.locator('#layer .keyboard-focus').count()).toBe(1);
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
    await open();
    const before = await page.evaluate(() => window.canvasView.read());
    await page.mouse.move(700, 450);
    await page.mouse.wheel(0, -150);
    await page.waitForTimeout(100);
    const after = await page.evaluate(() => window.canvasView.read());
    expect(after.viewport.zoom).toBeGreaterThan(before.viewport.zoom);
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
    const unknownContent = {
      ...unknown,
      id: 'future-content',
      type: 'frame',
      position: { x: 0, y: 220 },
      content: { type: 'future-content', script: '<img onerror=alert(1)>' },
    };
    await page.route('**/api/canvas/*/objects', (route) =>
      route.fulfill({ json: { success: true, data: { seq: 1000, objects: [unknown, unknownContent, long] } } })
    );
    await open('[data-object-id="future"]');
    expect(await page.locator('[data-object-id="future"]').textContent()).toContain('Unsupported object · new-widget');
    expect(await page.locator('[data-object-id="future-content"] .object-body').textContent()).toBe(
      'Unsupported content · future-content'
    );
    await page.locator('[data-object-id="future-content"] .object-body').dblclick();
    await page.waitForSelector('#readerView:not([hidden])');
    expect(await page.locator('#readerText').isVisible()).toBe(true);
    expect(await page.locator('#readerText').textContent()).toBe('Unsupported content · future-content');
    expect(await page.locator('[data-object-id="future-content"] > .resize-handle:visible').count()).toBe(0);
    expect(
      await page.evaluate(() => window.canvasEdit.move({ targetIds: ['future-content'], delta: { x: 1, y: 1 } }))
    ).toBe(false);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#rail', { state: 'hidden' });
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
    await page.locator('#sectionsTool').click();
    await shot(page, 'phone-outline');
    expect(await page.locator('#outline').evaluate((el) => el.getBoundingClientRect().width)).toBe(390);
    await page.locator('#closeOutline').click();
    expect(await page.locator('#keys').isVisible()).toBe(false);
    await page.evaluate(() => window.canvasView.dispatch({ kind: 'rail', view: 'keys' }));
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
  it('omits empty reader bodies and describes an empty container', async () => {
    await open();
    await page.route('**/api/canvas/*/objects', async (route) => {
      const response = await route.fetch();
      const snapshot = await response.json();
      snapshot.data.objects = snapshot.data.objects
        .map((o: ViewObject) => (o.id === 'brief' ? { ...o, content: { type: 'text', text: '' } } : o))
        .filter((o: ViewObject) => o.id !== 'nested-text');
      await route.fulfill({ json: snapshot });
    });
    await open();
    for (const id of ['brief', 'nested-group']) {
      await page.evaluate((id) => {
        window.canvasView.dispatch({ kind: 'focus', id });
        window.canvasView.dispatch({ kind: 'rail', view: 'reader' });
      }, id);
      await page.waitForFunction(
        (title) => document.getElementById('railTitle')?.textContent === title,
        id === 'brief' ? 'Text' : 'Archive'
      );
      await page.waitForFunction(() => document.getElementById('readerText')?.hidden);
      expect(await page.locator('#readerText').evaluate((el) => getComputedStyle(el).display)).toBe('none');
      expect(await page.locator('#readerMeta').evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px');
    }
    expect(await page.locator('#readerCount').textContent()).toBe('Empty');
    expect(await page.locator('#readerCount').isVisible()).toBe(true);
    expect(await page.locator('#children').isVisible()).toBe(false);
  });
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
  it('verifies the review states in both themes at desktop and phone sizes', async () => {
    await open();
    await createLive('review-markup');
    const evidence: unknown[] = [];
    for (const theme of ['dark', 'light']) {
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport);
        await open();
        await page.evaluate((theme) => {
          localStorage.setItem('codeman:skin', theme === 'light' ? 'paper-gray' : 'og');
          window.dispatchEvent(new StorageEvent('storage', { key: 'codeman:skin' }));
          window.canvasView.dispatch({ kind: 'focus', id: 'research' });
          window.canvasView.dispatch({ kind: 'selection', ids: ['research'] });
        }, theme);
        await page.locator('#fit').click();
        await page.locator('#board').focus();
        await page.keyboard.press('ArrowRight');
        await page.waitForSelector('[data-object-id="frame-one"].keyboard-focus');
        const slug = `${theme}-${viewport.width}`;
        expect(await page.locator('[data-object-id="research"]').getAttribute('class')).toContain('selected');
        expect(
          await page.locator('[data-object-id="research"]').evaluate((el) => getComputedStyle(el, '::after').content)
        ).toBe('none');
        const boundary = await page.locator('[data-object-id="research"] > .selection-bounds').evaluate((el) => {
          const css = getComputedStyle(el);
          const zoom = window.canvasView.read().viewport.zoom;
          return {
            color: css.borderColor,
            secondary: css.getPropertyValue('--secondary').trim(),
            width: parseFloat(css.borderWidth) * new DOMMatrix(css.transform).a * zoom,
          };
        });
        expect(boundary.color).toBe(theme === 'dark' ? 'rgb(178, 181, 188)' : 'rgb(80, 82, 79)');
        expect(boundary.width).toBeCloseTo(1, 0);
        const typography = await page.locator('[data-type="text"] > .object-body').evaluateAll((nodes) =>
          nodes.map((el) => {
            const css = getComputedStyle(el);
            return [el.tagName, css.fontFamily, css.fontWeight, css.fontSize];
          })
        );
        expect(typography.every((value) => JSON.stringify(value) === JSON.stringify(typography[0]))).toBe(true);
        expect(await page.locator('[data-object-id="review-markup"] > .object-body').textContent()).toBe(
          '<img onerror="alert(1)">'
        );
        expect(await page.locator('[data-object-id="review-markup"] img').count()).toBe(0);
        expect(await page.locator('[data-object-id="research"] > [data-type="text"]').count()).toBe(2);
        await shot(page, `${slug}-selection-focus`);
        if (viewport.width === 390) await page.locator('#sectionsTool').click();
        await page.locator('#board').focus();
        expect(await page.locator('.search-hint').isVisible()).toBe(true);
        await page.locator('#search').focus();
        expect(await page.locator('.search-hint').isVisible()).toBe(false);
        await page.locator('#search').fill('Reading');
        expect(await page.locator('.search-hint').isVisible()).toBe(false);
        await page
          .locator('#search')
          .fill('A USEFUL EXCERPT AND A NOTE IN YOUR OWN WORDS. KEEP THE REASON YOU WANTED TO RETURN.');
        expect(await page.locator('#tree button:visible').allTextContents()).toEqual([
          'What a saved page should remember',
        ]);
        const searchGap = await page.locator('#search').evaluate((el) => {
          const css = getComputedStyle(el),
            rect = el.getBoundingClientRect();
          const clear = document.getElementById('clearSearch')!.getBoundingClientRect();
          return clear.left - (rect.right - parseFloat(css.borderRightWidth) - parseFloat(css.paddingRight));
        });
        expect(searchGap).toBeGreaterThanOrEqual(8);
        expect(await page.getByRole('button', { name: 'Clear search', exact: true }).isVisible()).toBe(true);
        await shot(page, `${slug}-outline-search`);
        await page.getByRole('button', { name: 'Clear search', exact: true }).click();
        expect(await page.locator('#search').inputValue()).toBe('');
        expect(await page.evaluate(() => document.activeElement?.id)).toBe('search');
        await page.locator('#search').fill('');
        await page.locator('#board').focus();
        expect(await page.locator('#tree .keyboard-focus').textContent()).toBe('Reading patterns');
        expect(await page.locator('#tree [aria-pressed="true"]').textContent()).toBe('Design exploration');
        const clipping = await page.locator('#tree button').evaluateAll((rows) =>
          rows.map((row) => ({
            ellipsis: getComputedStyle(row).textOverflow,
            nowrap: getComputedStyle(row).whiteSpace,
            height: row.clientHeight,
            line: parseFloat(getComputedStyle(row).lineHeight),
          }))
        );
        expect(clipping.every((r) => r.ellipsis === 'ellipsis' && r.nowrap === 'nowrap' && r.height >= r.line)).toBe(
          true
        );
        await shot(page, `${slug}-outline-focus`);
        if (viewport.width === 390) await page.locator('#closeOutline').click();
        expect(await page.locator('#chatTool').getAttribute('aria-disabled')).toBeNull();
        if (viewport.width === 390)
          await page.evaluate(() => window.canvasView.dispatch({ kind: 'rail', view: 'keys' }));
        else await page.locator('#keys').click();
        await page.waitForSelector('#keysView:not([hidden])');
        expect(await page.locator('#keysView h1').count()).toBe(0);
        expect(await page.getByRole('img', { name: 'Right arrow', exact: true }).textContent()).toBe('→');
        expect(await page.locator('#keyRows').textContent()).not.toContain('Ctrl/Cmd');
        const checked = await page.locator('#letters').getAttribute('aria-checked');
        await page.locator('#letters').click();
        await page.waitForFunction(
          (before) => document.getElementById('letters')?.getAttribute('aria-checked') !== before,
          checked
        );
        await shot(page, `${slug}-keys`);
        await page.keyboard.press('Escape');
        await page.waitForSelector('#rail', { state: 'hidden' });
        await page.evaluate(() => window.canvasView.dispatch({ kind: 'focus', id: 'brief' }));
        await page.locator('#board').focus();
        await page.keyboard.press('Enter');
        await page.waitForSelector('#readerView:not([hidden])');
        expect(await page.locator('#railTitle').textContent()).toBe('Text');
        expect(await page.locator('#readerView h1').count()).toBe(0);
        expect(await page.locator('#readerMeta time').count()).toBe(1);
        expect(await page.locator('#readerMeta time').getAttribute('title')).toBe(
          await page.locator('#readerMeta time').getAttribute('datetime')
        );
        await shot(page, `${slug}-reader`);
        await page.keyboard.press('Escape');
        await page.waitForSelector('#rail', { state: 'hidden' });
        // Inspect actual rendered controls without firing their actions.
        const session = await page.context().newCDPSession(page);
        await session.send('DOM.enable');
        await session.send('CSS.enable');
        const states: unknown[] = [];
        for (const view of ['board', 'outline', 'keys', 'reader', 'container', 'error']) {
          if (view === 'outline' && viewport.width === 390) await page.locator('#sectionsTool').click();
          if (view === 'keys') {
            if (viewport.width === 390) {
              await page.locator('#closeOutline').click();
              await page.evaluate(() => window.canvasView.dispatch({ kind: 'rail', view: 'keys' }));
            } else await page.locator('#keys').click();
          }
          if (view === 'reader') {
            await page.keyboard.press('Escape');
            await page.waitForSelector('#rail', { state: 'hidden' });
            await page.evaluate(() => window.canvasView.dispatch({ kind: 'rail', view: 'reader' }));
            await page.waitForSelector('#readerView:not([hidden])');
          }
          if (view === 'container') {
            await page.evaluate(() => window.canvasView.dispatch({ kind: 'focus', id: 'research' }));
            await page.waitForFunction(
              () => document.getElementById('railTitle')?.textContent === 'Design exploration'
            );
            expect(await page.locator('#readerText').isVisible()).toBe(false);
            expect(await page.locator('#children').isVisible()).toBe(true);
            expect(await page.locator('#readerCount').textContent()).toBe('4 items');
            expect(await page.locator('#readerText').evaluate((el) => getComputedStyle(el).display)).toBe('none');
            expect(await page.locator('#readerMeta').evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px');
            await shot(page, `${slug}-container-reader`);
          }
          if (view === 'error') {
            await page.route('**/api/canvas/*/objects', (route) => route.fulfill({ status: 500, body: '{}' }));
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForSelector('#retry:not([hidden])');
            await shot(page, `${slug}-retry`);
          }
          const { root } = await session.send('DOM.getDocument');
          await page.mouse.move(viewport.width - 1, viewport.height - 1);
          const { nodeIds } = await session.send('DOM.querySelectorAll', {
            nodeId: root.nodeId,
            selector: 'button,input',
          });
          for (const nodeId of nodeIds) {
            const { object } = await session.send('DOM.resolveNode', { nodeId });
            if (!object.objectId) continue;
            const readStyle = async () => {
              const { result } = await session.send('Runtime.callFunctionOn', {
                objectId: object.objectId,
                functionDeclaration: `function() { const s = getComputedStyle(this); return { visible: !!this.getClientRects().length, name: this.id || this.className, color: s.color, background: s.backgroundColor, border: s.borderColor, outline: s.outlineColor, outlineWidth: s.outlineWidth, outlineOffset: s.outlineOffset }; }`,
                returnByValue: true,
              });
              return result.value;
            };
            await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
            const rest = await readStyle();
            if (!rest.visible) continue;
            for (const pseudo of ['hover', 'active', 'focus-visible']) {
              await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [pseudo] });
              const styled = await readStyle();
              if (pseudo === 'focus-visible') expect(styled.outlineWidth, `${slug} ${rest.name} focus`).toBe('2px');
              else
                expect(
                  styled.background !== rest.background || styled.border !== rest.border || styled.color !== rest.color,
                  `${slug} ${rest.name} ${pseudo}`
                ).toBe(true);
              states.push({ view, name: rest.name, pseudo, rest, styled });
            }
            await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
          }
        }
        await session.detach();
        await page.emulateMedia({ reducedMotion: 'reduce' });
        expect(
          await page
            .locator('*')
            .evaluateAll((els) =>
              els.every(
                (el) =>
                  getComputedStyle(el).animationName === 'none' &&
                  parseFloat(getComputedStyle(el).transitionDuration) === 0
              )
            )
        ).toBe(true);
        const native = await page.locator('#search').evaluate((el) => {
          const style = getComputedStyle(el),
            selection = getComputedStyle(el, '::selection');
          const root = getComputedStyle(document.documentElement);
          return {
            caret: style.caretColor,
            selection: selection.backgroundColor,
            scrollbars: style.scrollbarColor,
            accent: root.getPropertyValue('--accent').trim(),
            muted: root.getPropertyValue('--muted').trim(),
            panel: root.getPropertyValue('--panel').trim(),
          };
        });
        expect(native.caret).toBe(theme === 'dark' ? 'rgb(245, 138, 69)' : 'rgb(181, 71, 2)');
        expect(native.selection).toBe(native.caret);
        expect(native.scrollbars).toBe(
          theme === 'dark' ? 'rgb(151, 157, 166) rgb(30, 33, 37)' : 'rgb(91, 94, 89) rgb(242, 241, 237)'
        );
        evidence.push({ theme, viewport, states, clipping, native, reducedMotion: true });
        await page.keyboard.press('Escape');
        await page.waitForSelector('#rail', { state: 'hidden' });
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.unroute('**/api/canvas/*/objects');
        await page.route('**/api/canvas/*/objects', (route) =>
          route.fulfill({ json: { success: true, data: { seq: 1000, objects: [] } } })
        );
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.querySelector('#state h1')?.textContent === 'A place for your work');
        const position = await page.locator('#state').evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        expect(position.x).toBeCloseTo((viewport.width + (viewport.width > 600 ? 192 : 0)) / 2);
        expect(position.y).toBeCloseTo(viewport.height / 2);
        await shot(page, `${slug}-empty`);
        await page.unroute('**/api/canvas/*/objects');
      }
    }
    writeFileSync(resolve(MEDIA, `pc3-review-${stamp}-states.json`), JSON.stringify(evidence, null, 2));
  }, 120000);
  it('gates the canvas page with the synced setting and normal authentication', async () => {
    await page.request.put(`${origin}/x/api/settings`, { data: { canvasEnabled: false } });
    expect((await page.request.get(`${origin}/x/canvas/${workspace}`)).status()).toBe(404);
    expect((await page.request.get(`${origin}/x/canvas.html`)).status()).toBe(404);
    await page.request.put(`${origin}/x/api/settings`, { data: { canvasEnabled: true } });
  });
  it('serves an actionable plain-text error when the canvas bundle is missing', async () => {
    const bundle = resolve('src/web/public/canvas.js');
    const saved = resolve(MEDIA, `pc3-bundle-${stamp}.js`);
    renameSync(bundle, saved);
    try {
      const response = await page.request.get(`${origin}/x/canvas/${workspace}`);
      expect(response.status()).toBe(503);
      expect(response.headers()['content-type']).toContain('text/plain');
      expect(await response.text()).toContain('npm run build:canvas');
    } finally {
      renameSync(saved, bundle);
    }
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
