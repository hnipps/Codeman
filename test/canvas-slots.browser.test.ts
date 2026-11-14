/**
 * Page slots in the browser: a stored prototype docked in the rail and opened in the full view, by a person
 * and by an agent, and what a tab in the background keeps. Under a reverse-proxy base path. Every claim about
 * a slot's page is read from inside its frame or from the server, never from the canvas's own state alone.
 */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
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
import { HIDDEN_GRACE_MS } from '../packages/canvas/src/presence.js';

const b64 = (text: string) => Buffer.from(text).toString('base64');
const files = (word: string) => [
  {
    path: 'index.html',
    base64: b64(
      '<!doctype html><html><head><style>html,body{margin:0;height:100%;background:rgb(255,0,255)}</style></head>' +
        `<body><p id="v">${word}</p><input id="field"><script src="app.js"></script></body></html>`
    ),
  },
  {
    path: 'app.js',
    // The page tries to take the keyboard by itself, once it has loaded and again later.
    base64: b64(
      'document.body.dataset.ran = "yes"; const grab = () => { window.focus(); document.getElementById("field").focus(); };' +
        ' grab(); setTimeout(grab, 300);'
    ),
  },
];

describe('canvas page slots: a prototype in the rail and in the full view', () => {
  let server: WebServer, browser: Browser, context: BrowserContext, page: Page, origin: string, ws: string;
  let objectId: string, prototypeId: string;
  const api = (path: string) => `${origin}/x/api${path}`;
  const view = () => page.evaluate(() => window.canvasView.read());
  const railFrame = () => page.locator('#pageStage iframe');
  const fullFrame = () => page.locator('#fullViewFrame .slot-stage iframe');
  const boardFrame = () => page.locator(`[data-object-id="${objectId}"] .embed-stage iframe`);
  const active = () => page.evaluate(() => document.activeElement?.tagName);
  const shot = async (name: string) => {
    if (process.env.CANVAS_SLOTS_SHOTS)
      await page.screenshot({ path: `${process.env.CANVAS_SLOTS_SHOTS}/${name}.png` });
  };
  const call = async (args: Record<string, unknown>) =>
    (await page.request.post(api(`/canvas/${ws}/command`), { data: { tool: 'canvas_view', arguments: args } })).json();
  async function viewId(): Promise<string> {
    await vi.waitFor(async () => expect((await call({ action: 'list' })).data.views).toHaveLength(1), {
      timeout: 10000,
    });
    return (await call({ action: 'list' })).data.views[0].viewId;
  }
  async function open() {
    await page.goto(`${origin}/x/canvas/${ws}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(`[data-object-id="${objectId}"]`);
    // The board's own frame is up and its page ran: the workspace is being served to this view.
    await expect
      .poll(() => page.frameLocator(`[data-object-id="${objectId}"] .embed-stage iframe`).locator('#v').textContent(), {
        timeout: 20000,
      })
      .toMatch(/one|two/);
  }

  beforeAll(async () => {
    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasEnabled: true, canvasShellEnabled: true }));
    mkdirSync(resolve(resolveCasesDir(), 'slots'), { recursive: true });
    ws = workspaceForCase('slots').id;
    const stores = new CanvasStores();
    expect(
      stores.get(ws).append(
        [
          CommandSchema.parse({
            kind: 'create',
            opId: 'create-n1',
            objectId: 'n1',
            patch: {
              parentId: null,
              order: 0,
              position: { x: 0, y: 0 },
              size: { width: 180, height: 90 },
              content: { type: 'text', text: 'A note beside the prototype' },
            },
          }),
        ],
        { kind: 'human', userId: 'a' }
      ).ok
    ).toBe(true);
    stores.flush();
    server = new WebServer(0, false, true, undefined, undefined, undefined, '/x');
    await server.start();
    origin = `http://localhost:${server.boundPort}`;
    const published = await fetch(api(`/canvas/${ws}/prototypes`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Rail design',
        files: files('one'),
        position: { x: 240, y: 0 },
        size: { width: 420, height: 300 },
      }),
    });
    const body = await published.json();
    expect(published.status, JSON.stringify(body)).toBe(200);
    ({ objectId, prototypeId } = body.data);
    browser = await chromium.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: ['--no-sandbox'],
    });
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
    });
    await context.addInitScript(() => {
      if (!localStorage.getItem('codeman:skin')) localStorage.setItem('codeman:skin', 'og');
    });
    page = await context.newPage();
  }, 60000);
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
  }, 60000);

  it('names a prototype in its header and the outline, and docks it in the rail and the full view without moving the camera', async () => {
    await open();
    const embed = page.locator(`[data-object-id="${objectId}"]`);
    expect(await embed.locator('.embed-head > .link-host').textContent()).toBe('Prototype · v1');
    // A prototype's address opens nothing in a new tab and is no link to go back to.
    expect(await embed.locator('[data-media-action="open"]').isHidden()).toBe(true);
    expect(await embed.locator('[data-media-action="to-link"]').isHidden()).toBe(true);
    // The outline lists what Codeman stores for this workspace.
    const row = page.locator('#prototypes .prototype-row');
    await row.waitFor();
    expect(await row.textContent()).toMatch(/Rail design.*v1/s);

    await page.evaluate((id) => window.canvasView.dispatch({ kind: 'selection', ids: [id] }), objectId);
    const before = await view();
    await shot('board');
    await embed.locator('[data-media-action="dock"]').click({ timeout: 5000 });
    await page.locator('#pageStage iframe[data-bridge="ready"]').waitFor({ timeout: 20000 });
    expect(await page.locator('#pageView').isVisible()).toBe(true);
    expect(await page.locator('#pageOrigin').textContent()).toBe('Prototype · v1');
    // The slot's frame is the board's frame over again: the same sandbox, a capability address, never same-origin.
    const sandbox = await railFrame().getAttribute('sandbox');
    expect(sandbox).toBe(await boardFrame().getAttribute('sandbox'));
    expect(sandbox).not.toContain('allow-same-origin');
    expect(await railFrame().getAttribute('src')).toMatch(/\/x\/canvas-prototype\/[A-Za-z0-9_-]{32}\/index\.html$/);
    const docked = page.frameLocator('#pageStage iframe');
    expect(await docked.locator('#v').textContent()).toBe('one');
    expect(await docked.locator('body').getAttribute('data-ran')).toBe('yes');
    expect(await docked.locator('body').evaluate(() => window.origin)).toBe('null');
    expect((await view()).viewport).toEqual(before.viewport);
    expect((await view()).selected).toEqual(before.selected);
    await shot('rail');

    // Using the page, then Escape inside it: the keyboard comes back, and the next Escape closes the view.
    // The page is shielded until the person clicks it; from then on it is theirs to use.
    await page.locator('#pageStage .slot-shield').click();
    expect(await active()).toBe('IFRAME');
    await docked.locator('#field').click();
    await page.keyboard.type('typed in the page');
    expect(await docked.locator('#field').inputValue()).toBe('typed in the page');
    expect(await active()).toBe('IFRAME');
    await page.keyboard.press('Escape');
    await vi.waitFor(async () => expect(await active()).not.toBe('IFRAME'), { timeout: 5000 });
    await page.locator('#pageStage .slot-shield').waitFor();
    expect(await page.locator('#pageView').isVisible()).toBe(true);
    await page.keyboard.press('Escape');
    await railFrame().waitFor({ state: 'detached' });
    expect(await page.locator('#pageView').isHidden()).toBe(true);
    expect((await view()).viewport).toEqual(before.viewport);

    // The full view: the same page over the whole canvas, under a slim bar that keeps the keyboard.
    await embed.locator('[data-media-action="full"]').click();
    await page.locator('#fullViewFrame .slot-stage iframe[data-bridge="ready"]').waitFor({ timeout: 20000 });
    expect(await page.locator('#fullViewFrame .page-title').textContent()).toBe('Rail design');
    expect(await page.locator('#fullViewFrame .page-origin').textContent()).toBe('Prototype · v1');
    expect(await fullFrame().getAttribute('sandbox')).toBe(sandbox);
    expect(await page.frameLocator('#fullViewFrame .slot-stage iframe').locator('#v').textContent()).toBe('one');
    expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.pageAction)).toBe('close');
    const box = await fullFrame().boundingBox();
    expect(box!.width).toBeGreaterThan(1000);
    await shot('full');
    await page.keyboard.press('Escape');
    await fullFrame().waitFor({ state: 'detached' });
    expect((await view()).viewport).toEqual(before.viewport);
    expect((await view()).selected).toEqual(before.selected);

    // The outline's own controls open the same slots.
    await page.locator('#prototypes .prototype-slot[data-prototype-slot="rail"]').click();
    await page.locator('#pageStage iframe[data-bridge="ready"]').waitFor({ timeout: 20000 });
    await shot('outline');
    await page.locator('#pageShow').click();
    expect((await view()).selected).toEqual([objectId]);
  }, 120000);

  it('opens and closes a slot for an agent without taking the keyboard, and refuses while the person types', async () => {
    await open();
    const id = await viewId();
    await page.locator('#board').focus();
    // Counts the times a frame held this document's focus, so the next claim is about a page that did grab it.
    await page.evaluate(() => {
      const w = window as unknown as { __grabs: number };
      w.__grabs = 0;
      window.addEventListener('blur', () => document.activeElement?.tagName === 'IFRAME' && w.__grabs++);
    });
    expect((await call({ action: 'open-page', viewId: id, objectId, slot: 'rail' })).success).toBe(true);
    await page.locator('#pageStage iframe[data-bridge="ready"]').waitFor({ timeout: 20000 });
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => (window as unknown as { __grabs: number }).__grabs)).toBeGreaterThan(0);
    expect(await active()).not.toBe('IFRAME');
    expect(await page.locator('#pageStage .slot-shield').isVisible()).toBe(true);
    await vi.waitFor(
      async () =>
        expect((await call({ action: 'read', viewId: id })).data.state.pages).toEqual({ rail: objectId, full: null }),
      { timeout: 10000 }
    );
    // Only a live embed of this workspace can be opened: a note is refused by the server.
    expect((await call({ action: 'open-page', viewId: id, objectId: 'n1', slot: 'rail' })).success).toBe(false);
    expect((await call({ action: 'open-page', viewId: id, objectId: 'nothing-here', slot: 'full' })).success).toBe(
      false
    );
    expect((await call({ action: 'close-page', viewId: id, slot: 'rail' })).success).toBe(true);
    await railFrame().waitFor({ state: 'detached' });

    // The person is writing in the assistant: an agent's open changes nothing and says why.
    await page.evaluate(() => window.canvasView.dispatch({ kind: 'rail', view: 'assistant' }));
    await page.locator('#assistantDraft').fill('half a thought');
    await page.locator('#assistantDraft').focus();
    const sent = await call({ action: 'open-page', viewId: id, objectId, slot: 'full' });
    expect(sent.success).toBe(true);
    await vi.waitFor(
      async () => {
        const state = (await call({ action: 'read', viewId: id })).data.state;
        expect(state.refused?.commandId).toBe(sent.data.commandId);
        expect(state.refused.reason).toMatch(/typing/);
      },
      { timeout: 10000 }
    );
    expect(await fullFrame().count()).toBe(0);
    expect(await page.locator('#assistantDraft').inputValue()).toBe('half a thought');

    // Once they have stopped, the same command opens the full view and still takes no focus.
    await page.locator('#board').focus();
    expect((await call({ action: 'open-page', viewId: id, objectId, slot: 'full' })).success).toBe(true);
    await page.locator('#fullViewFrame .slot-stage iframe[data-bridge="ready"]').waitFor({ timeout: 20000 });
    await page.waitForTimeout(800);
    expect(await active()).not.toBe('IFRAME');
    await vi.waitFor(
      async () => expect((await call({ action: 'read', viewId: id })).data.state.pages.full).toBe(objectId),
      { timeout: 10000 }
    );
    expect((await call({ action: 'close-page', viewId: id, slot: 'full' })).success).toBe(true);
    await fullFrame().waitFor({ state: 'detached' });
  }, 120000);

  it('reloads the board and the slot on a new version, and holds no frame while the tab is in the background', async () => {
    await open();
    await page.evaluate((id) => window.canvasView.dispatch({ kind: 'page', objectId: id }), objectId);
    await page.locator('#pageStage iframe[data-bridge="ready"]').waitFor({ timeout: 20000 });
    const published = await page.request.post(api(`/canvas/${ws}/prototypes`), {
      data: { id: prototypeId, files: files('two') },
    });
    expect(published.status(), await published.text()).toBe(200);
    expect((await published.json()).data.objectId).toBe(objectId);
    const text = (frame: string) => page.frameLocator(frame).locator('#v').textContent({ timeout: 2000 });
    await expect.poll(() => text('#pageStage iframe').catch(() => ''), { timeout: 20000 }).toBe('two');
    await expect
      .poll(() => text(`[data-object-id="${objectId}"] .embed-stage iframe`).catch(() => ''), { timeout: 20000 })
      .toBe('two');
    expect(await page.locator('#pageOrigin').textContent()).toBe('Prototype · v2');
    expect(await page.locator(`[data-object-id="${objectId}"] .embed-head > .link-host`).textContent()).toBe(
      'Prototype · v2'
    );
    await expect.poll(() => page.locator('#prototypes .prototype-row').textContent(), { timeout: 10000 }).toMatch(/v2/);

    // The address the docked frame holds is served while this tab is an open view.
    await page.locator('#pageStage iframe[data-bridge="ready"]').waitFor({ timeout: 20000 });
    const held = (await railFrame().getAttribute('src'))!;
    expect((await fetch(origin + held)).status).toBe(200);
    const visibility = (state: 'hidden' | 'visible') =>
      page.evaluate((to) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => to });
        document.dispatchEvent(new Event('visibilitychange'));
      }, state);
    // A quick look at another tab changes nothing.
    await visibility('hidden');
    await page.waitForTimeout(500);
    await visibility('visible');
    await page.waitForTimeout(HIDDEN_GRACE_MS + 500);
    expect(await railFrame().getAttribute('src')).toBe(held);
    expect(await boardFrame().count()).toBe(1);

    // Left in the background, the tab holds no live frame and is no longer a view the server lists.
    await visibility('hidden');
    await railFrame().waitFor({ state: 'detached', timeout: HIDDEN_GRACE_MS + 5000 });
    expect(await page.locator('#board iframe').count()).toBe(0);
    expect(await page.locator('#pageStage .slot-note').textContent()).toBe('Paused');
    await vi.waitFor(async () => expect((await call({ action: 'list' })).data.views).toEqual([]), { timeout: 10000 });
    // With no view open the old address is retired and no new one is minted.
    expect((await fetch(origin + held)).status).toBe(409);
    expect((await page.request.post(api(`/canvas/${ws}/objects/${objectId}/frame`))).status()).toBe(409);

    // Back in front: the view is published first, then both frames come back and their page runs.
    await visibility('visible');
    await page.locator('#pageStage iframe[data-bridge="ready"]').waitFor({ timeout: 20000 });
    expect(await railFrame().getAttribute('src')).not.toBe(held);
    expect(await text('#pageStage iframe')).toBe('two');
    await expect
      .poll(() => text(`[data-object-id="${objectId}"] .embed-stage iframe`).catch(() => ''), { timeout: 20000 })
      .toBe('two');
    expect((await call({ action: 'list' })).data.views).toHaveLength(1);
    // The slot the person had open is still the one shown.
    expect((await view()).page).toBe(objectId);
  }, 120000);
});
