/**
 * Phone assistant (PC9c): the same rail, routes and records as desktop, as a full-viewport view with a visible
 * Close, a composer above the software keyboard, Return as a line break and an Add selection button.
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

const MEDIA = resolve('pr/media');
const stamp = Date.now();
const shot = (page: Page, slug: string) =>
  page.screenshot({ animations: 'disabled', path: resolve(MEDIA, `pc9c-${stamp}-phone-${slug}.png`) });
const text = (id: string, x: number, y: number, body: string) =>
  CommandSchema.parse({
    kind: 'create',
    opId: `create-${id}`,
    objectId: id,
    patch: {
      parentId: null,
      order: x + y,
      position: { x, y },
      size: { width: 300, height: 80 },
      content: { type: 'text', text: body },
    },
  });
const providers = {
  success: true,
  data: {
    providers: [
      {
        id: 'claude',
        label: 'Claude Code',
        shortBadge: 'CC',
        available: true,
        model: { editable: true, source: 'claude-settings-file' },
      },
      {
        id: 'codex',
        label: 'Codex',
        shortBadge: 'CX',
        available: false,
        reason: 'Codex cannot confirm a submitted message yet.',
        model: { editable: true, source: 'flag' },
      },
    ],
  },
};

describe('phone assistant', () => {
  let server: WebServer, browser: Browser, context: BrowserContext, page: Page;
  let origin: string, workspace: string, fitWorkspace: string;
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  const view = () => page.evaluate(() => window.canvasView.read());
  beforeAll(async () => {
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-pc9c-phone');
    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasEnabled: true }));
    mkdirSync(resolve(resolveCasesDir(), 'phone-assistant'), { recursive: true });
    workspace = workspaceForCase('phone-assistant').id;
    const stores = new CanvasStores();
    expect(
      stores
        .get(workspace)
        .append(
          [text('brief', 0, 0, 'Readers scan headings first'), text('other', 0, 120, 'Short lines beat long ones')],
          {
            kind: 'human',
            userId: 'admin',
          }
        ).ok
    ).toBe(true);
    mkdirSync(resolve(resolveCasesDir(), 'phone-fit'), { recursive: true });
    fitWorkspace = workspaceForCase('phone-fit').id;
    expect(
      stores.get(fitWorkspace).append([text('top', 0, 0, 'First note'), text('bottom', 0, 480, 'Last note')], {
        kind: 'human',
        userId: 'admin',
      }).ok
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
    await page.route('**/api/canvas/assistant/providers', (route) => route.fulfill({ json: providers }));
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/conversations/.test(r.url()))
        posts.push({ url: r.url(), body: JSON.parse(r.postData() ?? '{}') });
    });
    mkdirSync(MEDIA, { recursive: true });
    await page.goto(`${origin}/x/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-object-id="brief"]');
    await page.waitForFunction(() => !!window.canvasView);
    await page.waitForTimeout(300);
  }, 60000);
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    vi.unstubAllEnvs();
  }, 60000);

  it('puts the assistant in the dock as a named icon control, inside the width, at touch size', async () => {
    const control = page.locator('#assistantTool');
    expect(await control.getAttribute('aria-label')).toBe('Assistant');
    expect(await control.getAttribute('title')).toContain('Assistant');
    for (const width of [390, 375]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(150);
      for (const selector of ['#sectionsTool', '#findTool', '#assistantTool', '#chatTool', '#fit']) {
        const box = (await page.locator(selector).boundingBox())!;
        expect(box.height, `${selector} at ${width}`).toBeGreaterThanOrEqual(44);
        expect(box.x, `${selector} at ${width}`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${selector} at ${width}`).toBeLessThanOrEqual(width);
      }
    }
    await page.setViewportSize({ width: 390, height: 800 });
    await page.waitForTimeout(150);
  });

  it('opens as a full-viewport view with a visible Close, never moving the board, and Close restores focus', async () => {
    const before = (await view()).viewport;
    await page.locator('#assistantTool').tap();
    await page.waitForSelector('#assistantView:not([hidden])');
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    const rail = (await page.locator('#rail').boundingBox())!;
    expect(rail).toMatchObject({ x: 0, y: 0, width: 390 });
    expect(rail.height).toBeGreaterThanOrEqual((await page.evaluate(() => innerHeight)) - 1);
    const close = page.locator('#closeRail');
    expect(await close.isVisible()).toBe(true);
    expect((await close.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.locator('.dock-area').isVisible()).toBe(false);
    // The composer does not take focus by itself: a keyboard that rose as the view opened would cover it.
    expect(await page.evaluate(() => document.activeElement?.id)).not.toBe('assistantDraft');
    await shot(page, 'open');
    await close.tap();
    await page.waitForSelector('#rail', { state: 'hidden' });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('assistantTool');
    expect((await view()).viewport).toEqual(before);
  });

  it('keeps the composer and selectors above the software keyboard', async () => {
    await page.locator('#assistantTool').tap();
    await page.waitForSelector('#assistantView:not([hidden])');
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    await page.waitForFunction(() => document.querySelectorAll('#providerSelect option').length === 2);
    await page.locator('#assistantDraft').tap();
    await page.evaluate(() => (window as unknown as { __keyboard: (h: number) => void }).__keyboard(340));
    await page.waitForTimeout(150);
    const bottom = await page.evaluate(
      () => (window.visualViewport?.height ?? innerHeight) + (window.visualViewport?.offsetTop ?? 0)
    );
    expect(bottom).toBe((await page.evaluate(() => innerHeight)) - 340);
    for (const selector of ['#assistantForm', '#assistantChoice', '#assistantSend']) {
      const box = (await page.locator(selector).boundingBox())!;
      expect(box.y + box.height, selector).toBeLessThanOrEqual(bottom + 0.5);
      expect(box.y, selector).toBeGreaterThanOrEqual(0);
    }
    expect((await page.locator('#assistantDraft').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await shot(page, 'keyboard');
    await page.evaluate(() => (window as unknown as { __keyboard: (h: number) => void }).__keyboard(0));
  });

  it('takes Return as a line break and sends only from the Send button, through the same routes', async () => {
    posts.length = 0;
    await page.route('**/api/canvas/*/conversations', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({
            status: 409,
            json: {
              success: false,
              error: 'CLI_UNAVAILABLE: Codex cannot confirm a submitted message yet.',
              errorCode: 'CONFLICT',
            },
          })
        : route.continue()
    );
    const draft = page.locator('#assistantDraft');
    await draft.fill('first line');
    await draft.press('Enter');
    await draft.type('second line');
    expect(await draft.inputValue()).toBe('first line\nsecond line');
    await page.waitForTimeout(200);
    expect(posts).toEqual([]);
    await page.locator('#assistantSend').tap();
    await page.waitForSelector('#assistantRetry:not([hidden])');
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toMatch(/\/api\/canvas\/[^/]+\/conversations$/);
    expect(posts[0].body).toMatchObject({ cliId: 'claude' });
    expect(await draft.inputValue()).toBe('first line\nsecond line');
    await page.unroute('**/api/canvas/*/conversations');
    await draft.fill('');
    await draft.dispatchEvent('input');
  });

  it('adds the selection from the open assistant with a button, and a failed add says why in line', async () => {
    await page.locator('#assistantView').waitFor({ state: 'visible' });
    await page.locator('#addSelection').tap();
    expect(await page.locator('#assistantStatus').textContent()).toContain('Select an object');
    await page.locator('#closeRail').tap();
    await page.waitForSelector('#rail', { state: 'hidden' });
    const box = (await page.locator('[data-object-id="brief"]').boundingBox())!;
    const cdp = await context.newCDPSession(page);
    const send = (type: 'touchStart' | 'touchEnd', points: { x: number; y: number }[]) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, id) => ({ ...p, id })) });
    await send('touchStart', [{ x: Math.round(box.x + 20), y: Math.round(box.y + 20) }]);
    await send('touchEnd', []);
    await page.waitForFunction(() => window.canvasView.read().selected.length === 1);
    const before = (await view()).viewport;
    await page.locator('#assistantTool').tap();
    await page.locator('#addSelection').tap();
    await page.waitForSelector('#contextChips .chip');
    expect(await page.locator('#contextChips .chip-name').allTextContents()).toEqual(['Readers scan headings first']);
    expect(await page.locator('#assistantDraft').evaluate((el) => el === document.activeElement)).toBe(false);
    await shot(page, 'selection-added');
    await page.locator('#closeRail').tap();
    await page.waitForSelector('#rail', { state: 'hidden' });
    expect((await view()).viewport).toEqual(before);
  });

  it('refuses nothing it should show: an unavailable provider is flagged with its reason, with no dialog', async () => {
    await page.locator('#assistantTool').tap();
    await page.locator('#providerSelect').selectOption('codex');
    await page.waitForSelector('#choiceNote:not([hidden])');
    expect(await page.locator('#choiceNote').textContent()).toContain('cannot confirm a submitted message');
    expect(await page.locator('dialog[open], [role="dialog"]').count()).toBe(0);
    await shot(page, 'unavailable');
  });

  it('computes every text control on the canvas page at 16 px or more, so iOS never zooms on focus', async () => {
    const sizes = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('input, textarea, select')]
        .filter((el) => !['checkbox', 'radio', 'hidden', 'file', 'range'].includes((el as HTMLInputElement).type))
        .map((el) => [el.id || el.tagName, parseFloat(getComputedStyle(el).fontSize)] as const)
    );
    const ids = sizes.map(([id]) => id);
    for (const id of ['search', 'commentDraft', 'assistantDraft', 'providerSelect', 'modelInput', 'conversationPicker'])
      expect(ids, id).toContain(id);
    for (const [id, size] of sizes) expect(size, id).toBeGreaterThanOrEqual(16);
    await page.locator('#assistantView').waitFor({ state: 'visible' });
    for (const id of ['assistantDraft', 'modelInput']) {
      await page.locator(`#${id}`).focus();
      expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);
    }
  });

  it('fits the first view above the dock and inside the safe area on first load', async () => {
    const small = await browser.newContext({
      viewport: { width: 414, height: 714 },
      deviceScaleFactor: 1,
      hasTouch: true,
      isMobile: true,
    });
    await small.addInitScript(() => {
      window.__canvasTouch = true;
      localStorage.setItem('codeman:skin', 'og');
    });
    const p = await small.newPage();
    await p.goto(`${origin}/x/canvas/${fitWorkspace}`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('[data-object-id="top"]');
    await p.waitForTimeout(400);
    const dock = await p.locator('#dock').evaluate((el) => el.getBoundingClientRect().top);
    const boxes = await p.evaluate(() =>
      [...document.querySelectorAll('#layer > [data-object-id]')].map((el) => el.getBoundingClientRect().toJSON())
    );
    expect(boxes).toHaveLength(2);
    for (const box of boxes) {
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(dock + 0.5);
    }
    await p.screenshot({ animations: 'disabled', path: resolve(MEDIA, `pc9c-${stamp}-phone-first-view.png`) });
    await small.close();
  });
});
