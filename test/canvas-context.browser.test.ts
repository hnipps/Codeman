import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import puppeteer from 'puppeteer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebServer } from '../src/web/server.js';
import { dataPath } from '../src/config/instance.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';
import { CanvasStores } from '../src/canvas/canvas-store.js';
import { CommandSchema } from '../src/canvas/operations.js';

const MEDIA = resolve('pr/media');
const stamp = Date.now();
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
      order: x + y / 1000,
      position: { x, y },
      size: type === 'group' ? null : { width: w, height: h },
      content: type === 'text' ? { type, text } : { type, label: text },
    },
  });
describe('canvas direct context and the view registry', () => {
  let server: WebServer, browser: Browser, desktop: BrowserContext, page: Page, origin: string, workspace: string;
  const writes: string[] = [];
  const shot = (p: Page, name: string) =>
    p.screenshot({ animations: 'disabled', path: resolve(MEDIA, `pc9a-review-${stamp}-${name}.png`) });
  beforeAll(async () => {
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-pc9a-owner');
    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasEnabled: true }));
    mkdirSync(resolve(resolveCasesDir(), 'Fieldnotes'), { recursive: true });
    workspace = workspaceForCase('Fieldnotes').id;
    const stores = new CanvasStores();
    const made = stores
      .get(workspace)
      .append(
        [
          item('n1', null, 'text', 0, 0, 180, 90, 'Reading patterns'),
          item('n2', null, 'text', 220, 0, 180, 90, 'Reference notes'),
          item('n3', null, 'text', 440, 0, 180, 90, 'Quiet capture'),
          item('cluster', null, 'group', 0, 220, 0, 0, 'Archive'),
          item('c1', 'cluster', 'text', 0, 0, 180, 90, 'Older idea'),
          item('c2', 'cluster', 'text', 220, 0, 180, 90, 'Another idea'),
          item('solo', null, 'text', 700, 220, 180, 90, 'A loose note'),
        ],
        { kind: 'agent', sessionId: 'design-agent' }
      );
    expect(made.ok).toBe(true);
    stores.flush();
    server = new WebServer(0, false, true, undefined, undefined, undefined, '/x');
    await server.start();
    origin = `http://localhost:${server.boundPort}`;
    browser = await chromium.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: ['--no-sandbox'],
    });
    desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await desktop.addInitScript(() => {
      if (!localStorage.getItem('codeman:skin')) localStorage.setItem('codeman:skin', 'og');
    });
    page = await desktop.newPage();
    page.on('request', (r) => {
      if (r.method() !== 'GET' && !r.url().includes('/views/') && !r.url().includes('/api/events'))
        writes.push(`${r.method()} ${r.url()}`);
    });
    mkdirSync(MEDIA, { recursive: true });
  }, 60000);
  afterEach(() => {
    writes.length = 0;
  });
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    vi.unstubAllEnvs();
  }, 60000);
  async function open(p: Page = page) {
    // Same-origin, script-free page: clear the stored assistant state before the canvas can rewrite it.
    await p.goto(`${origin}/x/manifest.json`, { waitUntil: 'domcontentloaded' });
    await p.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.includes(':assistant:')) localStorage.removeItem(key);
    });
    await p.goto(`${origin}/x/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('[data-object-id="n1"]');
    await p.waitForFunction(() => !!window.canvasView);
  }
  const view = () => page.evaluate(() => window.canvasView.read());
  const box = async (id: string) => (await page.locator(`[data-object-id="${id}"]`).first().boundingBox())!;
  const seq = async () =>
    (await (await page.request.get(`${origin}/x/api/canvas/${workspace}/ops?since=0`)).json()).data.seq as number;
  async function loop(ids: string[], margin = 14) {
    const boxes = await Promise.all(ids.map(box));
    const left = Math.min(...boxes.map((b) => b.x)) - margin,
      right = Math.max(...boxes.map((b) => b.x + b.width)) + margin,
      top = Math.min(...boxes.map((b) => b.y)) - margin,
      bottom = Math.max(...boxes.map((b) => b.y + b.height)) + margin;
    return [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ];
  }
  async function draw(points: { x: number; y: number }[], release = true) {
    await page.mouse.move(points[0].x, points[0].y);
    await page.mouse.down();
    for (const p of [...points.slice(1), points[0]]) await page.mouse.move(p.x, p.y, { steps: 6 });
    if (release) await page.mouse.up();
  }
  const chips = async () => {
    await page.waitForTimeout(150);
    return page.locator('#contextChips .chip-name').allTextContents();
  };

  it('circling three notes with Q held adds three named chips and opens the rail without moving the board', async () => {
    await open();
    const before = await view();
    const ops = await seq();
    await page.locator('#board').focus();
    await page.keyboard.down('q');
    expect(await page.locator('#board.lasso-armed').count()).toBe(1);
    const points = await loop(['n1', 'n2', 'n3']);
    await draw(points, false);
    expect(await page.locator('.context-preview').count()).toBe(3);
    await shot(page, 'lasso');
    await page.mouse.up();
    await page.keyboard.up('q');
    expect(await chips()).toEqual(['Reading patterns', 'Reference notes', 'Quiet capture']);
    expect((await view()).rail).toEqual(['assistant']);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('assistantDraft');
    const after = await view();
    expect(after.viewport).toEqual(before.viewport);
    expect(after.selected).toEqual(before.selected);
    expect(await seq()).toBe(ops);
    expect(writes).toEqual([]);
    await shot(page, 'chips');
  });
  it('captures a group as one chip with its count and a loose note beside it', async () => {
    await open();
    await page.locator('#board').focus();
    await page.keyboard.down('q');
    await draw(await loop(['c1', 'c2', 'solo'], 30));
    await page.keyboard.up('q');
    expect(await chips()).toEqual(['Archive', 'A loose note']);
    expect(await page.locator('#contextChips .chip-count').first().textContent()).toBe('2 inside');
    await page.locator('.chip-remove').first().click();
    expect(await chips()).toEqual(['A loose note']);
  });
  it('every way out of a lasso leaves context, selection, camera and the log unchanged', async () => {
    await open();
    const before = await view();
    const ops = await seq();
    const points = await loop(['n1', 'n2']);
    const cancels: [string, () => Promise<void>][] = [
      ['key release', () => page.keyboard.up('q')],
      ['Escape', () => page.keyboard.press('Escape')],
      ['blur', () => page.evaluate(() => window.dispatchEvent(new Event('blur')))],
      [
        'hidden',
        () =>
          page.evaluate(() => {
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
            document.dispatchEvent(new Event('visibilitychange'));
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
          }),
      ],
      ['composition', () => page.evaluate(() => document.dispatchEvent(new Event('compositionstart')))],
      [
        'pointer cancel',
        () =>
          page.evaluate(() => {
            document.getElementById('board')!.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }));
          }),
      ],
    ];
    for (const [name, cancel] of cancels) {
      await page.locator('#board').focus();
      await page.keyboard.down('q');
      await draw(points, false);
      expect(await page.locator('.context-preview').count(), name).toBeGreaterThan(0);
      await cancel();
      await page.mouse.up();
      await page.keyboard.up('q');
      await page.evaluate(() => document.dispatchEvent(new Event('compositionend')));
      const after = await view();
      expect(after.context, name).toEqual([]);
      expect(after.selected, name).toEqual(before.selected);
      expect(after.viewport, name).toEqual(before.viewport);
      expect(await page.locator('.context-preview').count(), name).toBe(0);
      expect(await page.locator('#board.lasso-armed').count(), name).toBe(0);
    }
    expect(await seq()).toBe(ops);
    await shot(page, 'lasso-cancel');
  });
  it('a lasso at 50 and 200 percent zoom after a pan captures what canvas_query reports for the same loop', async () => {
    await open();
    for (const zoom of [0.5, 2]) {
      await page.evaluate(
        (z) => window.canvasView.dispatch({ kind: 'viewport', viewport: { x: 260, y: 150, zoom: z } }),
        zoom
      );
      await page.evaluate(() => window.canvasView.dispatch({ kind: 'context-clear-sent' }));
      const polygon = await page.evaluate(() => {
        const v = window.canvasView.read().viewport;
        // World loop around n2's centre (310, 45) and n3's (530, 45), both in view at either zoom.
        return [
          { x: 250, y: -20 },
          { x: 600, y: -20 },
          { x: 600, y: 120 },
          { x: 250, y: 120 },
        ].map((p) => ({ screen: { x: p.x * v.zoom + v.x, y: p.y * v.zoom + v.y }, world: p }));
      });
      await page.locator('#board').focus();
      await page.keyboard.down('q');
      await draw(polygon.map((p) => p.screen));
      await page.keyboard.up('q');
      const captured = (await view()).context.sort();
      const query = await page.request.post(`${origin}/x/api/canvas/${workspace}/command`, {
        data: {
          tool: 'canvas_query',
          arguments: { shape: 'polygon', points: polygon.map((p) => p.world), semantics: 'center' },
        },
      });
      const ids = (await query.json()).data.data.map((o: { id: string }) => o.id).sort();
      expect(captured).toEqual(ids);
      expect(captured).toEqual(['n2', 'n3']);
      if (zoom === 0.5) await shot(page, 'lasso-zoom');
    }
  });
  it('Cmd/Ctrl+Enter and the selection row add context and focus the composer without sending', async () => {
    await open();
    await page.locator('[data-object-id="n1"]').first().click();
    await page
      .locator('[data-object-id="n2"]')
      .first()
      .click({ modifiers: ['Shift'] });
    expect((await view()).selected).toEqual(['n1', 'n2']);
    await page.locator('#board').focus();
    await page.keyboard.press('Control+Enter');
    expect(await chips()).toEqual(['Reading patterns', 'Reference notes']);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('assistantDraft');
    expect((await view()).selected).toEqual(['n1', 'n2']);
    expect(writes).toEqual([]);
    await page.locator('#board').focus();
    await page.locator('[data-object-id="n3"]').first().click();
    await page.locator('#addToChat').click();
    expect(await chips()).toEqual(['Reading patterns', 'Reference notes', 'Quiet capture']);
    await page.locator('#assistantDraft').fill('summarise these');
    expect(await page.locator('#assistantDraft').inputValue()).toBe('summarise these');
    expect(await chips()).toHaveLength(3);
    expect(writes).toEqual([]);
  });
  it('C toggles the assistant five times with the camera, selection and board unchanged and the closed rail zero wide', async () => {
    await open();
    await page.locator('[data-object-id="n3"]').first().click();
    await page.locator('#board').focus();
    const before = await view();
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('c');
      expect((await view()).rail).toEqual(i % 2 === 0 ? ['assistant'] : []);
    }
    await page.keyboard.press('c');
    expect(await page.locator('#rail').evaluate((el) => el.getBoundingClientRect().width)).toBe(0);
    const after = await view();
    expect({ viewport: after.viewport, selected: after.selected, focusId: after.focusId }).toEqual({
      viewport: before.viewport,
      selected: before.selected,
      focusId: before.focusId,
    });
    await page.keyboard.press('Control+.');
    expect((await view()).rail).toEqual(['assistant']);
    await shot(page, 'collapse');
    await page.keyboard.press('Escape');
    expect((await view()).rail).toEqual([]);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('board');
  });
  it('reload restores the chips and the draft, per viewer and workspace', async () => {
    await open();
    await page.locator('#board').focus();
    await page.keyboard.down('q');
    await draw(await loop(['n1']));
    await page.keyboard.up('q');
    await page.locator('#assistantDraft').fill('draft that survives');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.canvasView);
    await page.waitForSelector('[data-object-id="n1"]');
    await page.keyboard.press('Control+.').catch(() => {});
    await page.evaluate(() => window.canvasView.dispatch({ kind: 'rail', view: 'assistant' }));
    await page.waitForSelector('#contextChips .chip');
    expect(await chips()).toEqual(['Reading patterns']);
    expect(await page.locator('#assistantDraft').inputValue()).toBe('draft that survives');
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.includes(':assistant:')).length)).toBe(
      2
    );
    await shot(page, 'restore');
  });
  it('typing "quick cat" in the composer or in outline search toggles nothing and arms nothing', async () => {
    await open();
    await page.evaluate(() => window.canvasView.dispatch({ kind: 'rail', view: 'assistant' }));
    await page.locator('#assistantDraft').click();
    await page.keyboard.type('quick cat');
    expect(await page.locator('#assistantDraft').inputValue()).toBe('quick cat');
    expect((await view()).rail).toEqual(['assistant']);
    expect(await page.locator('#board.lasso-armed').count()).toBe(0);
    await page.locator('#search').click();
    await page.keyboard.type('quick cat');
    expect(await page.locator('#search').inputValue()).toBe('quick cat');
    expect((await view()).rail).toEqual(['assistant']);
    expect(await page.locator('#board.lasso-armed').count()).toBe(0);
    // Under IME composition the board ignores its letter shortcuts too.
    await page.locator('#board').focus();
    await page.evaluate(() => document.dispatchEvent(new Event('compositionstart')));
    await page.keyboard.down('q');
    expect(await page.locator('#board.lasso-armed').count()).toBe(0);
    await page.keyboard.up('q');
    await page.keyboard.press('c');
    expect((await view()).rail).toEqual(['assistant']);
    await page.evaluate(() => document.dispatchEvent(new Event('compositionend')));
    await shot(page, 'input-isolation');
  });
  it('an agent reads and steers this view through the same tools without moving the human focus', async () => {
    await open();
    await page.locator('#board').focus();
    await page.waitForTimeout(700);
    const call = async (tool: string, args: Record<string, unknown>) =>
      (
        await page.request.post(`${origin}/x/api/canvas/${workspace}/command`, { data: { tool, arguments: args } })
      ).json();
    const listed = await call('canvas_view', { action: 'list' });
    expect(listed.data.views).toHaveLength(1);
    const viewId: string = listed.data.views[0].viewId;
    const focused = await page.evaluate(() => document.activeElement?.id);
    expect((await call('canvas_view', { action: 'select', viewId, targetIds: ['n1', 'n2'] })).success).toBe(true);
    await page.waitForFunction(() => window.canvasView.read().selected.length === 2);
    expect((await view()).selected).toEqual(['n1', 'n2']);
    expect(
      (await call('canvas_view', { action: 'set-viewport', viewId, viewport: { x: 10, y: 20, zoom: 0.8 } })).success
    ).toBe(true);
    await page.waitForFunction(() => window.canvasView.read().viewport.zoom === 0.8);
    expect((await call('canvas_view', { action: 'fit', viewId, targetIds: ['solo'] })).success).toBe(true);
    await page.waitForFunction(() => window.canvasView.read().viewport.zoom !== 0.8);
    expect((await call('canvas_context', { action: 'add', viewId, targetIds: ['cluster', 'solo'] })).success).toBe(
      true
    );
    await page.waitForFunction(() => window.canvasView.read().context.length === 2);
    await page.waitForTimeout(700);
    const read = await call('canvas_context', { action: 'read', viewId });
    expect(read.data.references.map((r: { id: string }) => r.id)).toEqual(['cluster', 'solo']);
    expect(read.data.references[0].descendants.map((d: { id: string }) => d.id).sort()).toEqual(['c1', 'c2']);
    expect((await call('canvas_context', { action: 'remove', viewId, targetIds: ['solo'] })).success).toBe(true);
    await page.waitForFunction(() => window.canvasView.read().context.length === 1);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe(focused);
    expect((await view()).rail).toEqual([]);
    await call('canvas_view', { action: 'rail', viewId, view: 'assistant' });
    await page.waitForFunction(() => window.canvasView.read().rail.includes('assistant'));
    expect(await page.evaluate(() => document.activeElement?.id)).toBe(focused);
    const missing = await page.request.post(`${origin}/x/api/canvas/${workspace}/command`, {
      data: {
        tool: 'canvas_view',
        arguments: { action: 'select', viewId: '99999999-9999-4999-8999-999999999999', targetIds: ['n1'] },
      },
    });
    expect(missing.status()).toBe(404);
    expect((await missing.json()).error).toContain('VIEW_GONE');
    await shot(page, 'agent-view');
  });
  it('publishes at most four times a second during a five second pan', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const p = await context.newPage();
    let publishes = 0;
    p.on('request', (r) => {
      if (r.method() === 'PUT' && r.url().includes('/views/')) publishes++;
    });
    await open(p);
    await p.evaluate(() => window.canvasView.dispatch({ kind: 'rail', view: 'assistant' }));
    const start = Date.now();
    let frames = 0;
    while (Date.now() - start < 5000) {
      await p.evaluate(() => window.canvasView.dispatch({ kind: 'pan', delta: { x: 3, y: 1 } }));
      frames++;
      await p.waitForTimeout(16);
    }
    expect(frames).toBeGreaterThan(50);
    expect(publishes / 5).toBeLessThanOrEqual(4);
    await context.close();
  });
  it('a phone has the assistant in its dock, but no lasso, no rail from C and still no edits', async () => {
    const context = await browser.newContext({
      viewport: { width: 414, height: 714 },
      deviceScaleFactor: 1,
      hasTouch: true,
    });
    await context.addInitScript(() => {
      (window as unknown as { __canvasTouch: boolean }).__canvasTouch = true;
      localStorage.setItem('codeman:skin', 'og');
    });
    const p = await context.newPage();
    await open(p);
    expect(await p.locator('#assistantTool').isVisible()).toBe(true);
    expect(await p.locator('#addToChat').isVisible()).toBe(false);
    await p.locator('#board').focus();
    await p.keyboard.press('c');
    await p.keyboard.down('q');
    expect(await p.locator('#board.lasso-armed').count()).toBe(0);
    await p.keyboard.up('q');
    expect(await p.evaluate(() => window.canvasView.read().rail)).toEqual([]);
    await p.evaluate(() => window.canvasView.dispatch({ kind: 'rail', view: 'assistant' }));
    expect(await p.evaluate(() => window.canvasView.read().rail)).toEqual(['assistant']);
    expect(
      await p.evaluate(() => window.canvasEdit.apply([{ kind: 'delete', opId: 'phone-delete', objectId: 'n1' }]))
    ).toBe(false);
    await shot(p, 'phone');
    await context.close();
  });
});
