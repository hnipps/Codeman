/**
 * Canvas shell (PC13) in the browser, part 1: `/` lands on the canvas and names the workspace in the address, a
 * canvas that cannot load or start ends on the classic view with a notice after exactly one automatic
 * navigation, the classic view links back, and a saved copy of the canvas page served offline for a classic
 * address does not loop. Everything runs under a reverse-proxy base path.
 */
import { beforeAll, afterAll, afterEach, describe, expect, it } from 'vitest';
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

const note = (id: string, x: number, text: string) =>
  CommandSchema.parse({
    kind: 'create',
    opId: `create-${id}`,
    objectId: id,
    patch: {
      parentId: null,
      order: x / 1000,
      position: { x, y: 0 },
      size: { width: 180, height: 90 },
      content: { type: 'text', text },
    },
  });

describe('canvas shell: landing and fallback', () => {
  let server: WebServer, browser: Browser, context: BrowserContext, page: Page, origin: string;
  let alpha: string, beta: string;
  let navigations: string[] = [];
  const settings = (value: Record<string, unknown>) => writeFileSync(dataPath('settings.json'), JSON.stringify(value));
  const SHELL = { canvasEnabled: true, canvasShellEnabled: true };
  /** Document requests of the top frame: what "a navigation" means for the no-loop rule. */
  function watch(target: Page) {
    target.on('request', (r) => {
      if (r.isNavigationRequest() && r.frame() === target.mainFrame())
        navigations.push(new URL(r.url()).pathname + new URL(r.url()).search);
    });
  }
  async function fresh(): Promise<Page> {
    await page?.close();
    page = await context.newPage();
    navigations = [];
    watch(page);
    return page;
  }
  async function onClassicWithNotice(reason: string) {
    await page.waitForSelector('#canvasShellNotice');
    expect(await page.locator('#canvasShellNotice').getAttribute('data-reason')).toBe(reason);
    expect(await page.locator('#canvasShellNotice').getAttribute('role')).toBe('status');
    expect(await page.locator('.header').count()).toBe(1);
    expect(await page.locator('html[data-canvas]').count()).toBe(0);
    // Nothing retries by itself: the page stays where it is.
    await page.waitForTimeout(700);
  }

  beforeAll(async () => {
    settings(SHELL);
    for (const name of ['alpha', 'beta']) mkdirSync(resolve(resolveCasesDir(), name), { recursive: true });
    alpha = workspaceForCase('alpha').id;
    beta = workspaceForCase('beta').id;
    const stores = new CanvasStores();
    expect(stores.get(alpha).append([note('n1', 0, 'Alpha note')], { kind: 'human', userId: 'a' }).ok).toBe(true);
    expect(stores.get(beta).append([note('n1', 0, 'Beta note')], { kind: 'human', userId: 'a' }).ok).toBe(true);
    stores.flush();
    server = new WebServer(0, false, true, undefined, undefined, undefined, '/x');
    await server.start();
    origin = `http://localhost:${server.boundPort}`;
    browser = await chromium.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: ['--no-sandbox'],
    });
    // No service worker here: a worker fetches the bundle itself, past `page.route`, and the failures below
    // would never happen. The offline case at the end makes its own context with the worker on.
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
    });
    await context.addInitScript(() => {
      if (!localStorage.getItem('codeman:skin')) localStorage.setItem('codeman:skin', 'og');
    });
    await fresh();
  }, 60000);
  afterEach(async () => {
    settings(SHELL);
    await context.clearCookies();
    await context.setOffline(false);
  });
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
  }, 60000);

  it('lands on the canvas at `/`, names the workspace in the address with one load, and remembers it', async () => {
    await page.goto(`${origin}/x/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-object-id="n1"]');
    expect(new URL(page.url()).pathname).toBe(`/x/canvas/${alpha}`);
    expect(navigations).toEqual(['/x/']);
    expect(await page.evaluate(() => window.__canvasBoot?.ok)).toBe(true);
    expect(await page.evaluate(() => window.__canvasBoot?.navigations)).toBe(0);
    const cookies = await context.cookies(`${origin}/x/`);
    expect(cookies.find((c) => c.name === 'codeman_canvas_ws')).toMatchObject({
      value: alpha,
      path: '/x',
      sameSite: 'Lax',
      httpOnly: false,
    });
    // A reload opens the same workspace from its own address.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-object-id="n1"]');
    expect(new URL(page.url()).pathname).toBe(`/x/canvas/${alpha}`);
    // Opening another workspace makes it the one `/` opens next on this device.
    await page.goto(`${origin}/x/canvas/${beta}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('[data-object-id="n1"]')?.textContent?.includes('Beta'));
    await page.goto(`${origin}/x/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('[data-object-id="n1"]')?.textContent?.includes('Beta'));
    expect(new URL(page.url()).pathname).toBe(`/x/canvas/${beta}`);
  });

  it('shows the classic link in the loading state only on a shell page', async () => {
    await fresh();
    await page.route('**/api/canvas/*/objects', () => {});
    await page.goto(`${origin}/x/`, { waitUntil: 'domcontentloaded' });
    const link = page.locator('#classicLink');
    await link.waitFor({ state: 'visible' });
    expect(await link.getAttribute('href')).toBe('./?view=classic');
    expect(new URL(await link.evaluate((a: HTMLAnchorElement) => a.href)).pathname).toBe('/x/');
    settings({ canvasEnabled: true });
    await fresh();
    await page.route('**/api/canvas/*/objects', () => {});
    await page.goto(`${origin}/x/canvas/${alpha}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#state');
    expect(await page.locator('#classicLink').isVisible()).toBe(false);
    expect(await page.evaluate(() => window.__canvasBoot?.shell)).toBe(false);
  });

  it('opens the classic view at its own address with a Canvas link back, and no canvas file', async () => {
    await fresh();
    const requested: string[] = [];
    page.on('request', (r) => requested.push(new URL(r.url()).pathname));
    await page.goto(`${origin}/x/classic`, { waitUntil: 'domcontentloaded' });
    const link = page.locator('#canvasShellLink');
    await link.waitFor({ state: 'visible' });
    expect(new URL(await link.evaluate((a: HTMLAnchorElement) => a.href)).pathname).toBe('/x/');
    expect(await page.locator('#canvasShellNotice').count()).toBe(0);
    await page.waitForTimeout(500);
    expect(requested.filter((p) => /canvas(-home)?\.(js|css)/.test(p))).toEqual([]);
    await link.click();
    await page.waitForSelector('[data-object-id="n1"]');
    expect(new URL(page.url()).pathname).toMatch(/^\/x\/canvas\//);
    // With the shell off the dashboard has no such link.
    settings({ canvasEnabled: true });
    await fresh();
    await page.goto(`${origin}/x/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.header');
    expect(await page.locator('#canvasShellLink').count()).toBe(0);
    expect(await page.evaluate(() => '__CODEMAN_SHELL__' in window)).toBe(false);
  });

  it('falls back to the classic view, once, when the bundle request is blocked', async () => {
    await fresh();
    await page.route('**/canvas.js*', (route) => route.abort());
    await page.goto(`${origin}/x/`, { waitUntil: 'domcontentloaded' });
    await onClassicWithNotice('load');
    expect(navigations).toEqual(['/x/', '/x/?view=classic&canvas=failed&reason=load']);
    // A second load of where the person ended up does not navigate again.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await onClassicWithNotice('load');
    expect(navigations).toHaveLength(3);
    expect(navigations[2]).toBe('/x/?view=classic&canvas=failed&reason=load');
  });

  it('falls back the same way when the server has no bundle to send (404)', async () => {
    await fresh();
    await page.route('**/canvas.js*', (route) =>
      route.fulfill({ status: 404, contentType: 'text/plain', body: 'gone' })
    );
    await page.goto(`${origin}/x/canvas/${alpha}`, { waitUntil: 'domcontentloaded' });
    await onClassicWithNotice('load');
    expect(navigations).toEqual([`/x/canvas/${alpha}`, '/x/?view=classic&canvas=failed&reason=load']);
  });

  it('falls back to the classic view, once, when the bundle throws as it starts', async () => {
    await fresh();
    await page.route('**/canvas.js*', (route) =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: "throw new Error('broken on purpose');" })
    );
    await page.goto(`${origin}/x/`, { waitUntil: 'domcontentloaded' });
    await onClassicWithNotice('boot');
    expect(navigations).toEqual(['/x/', '/x/?view=classic&canvas=failed&reason=boot']);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await onClassicWithNotice('boot');
    expect(navigations).toHaveLength(3);
  });

  it('falls back when the bundle loads and never says it started', async () => {
    await fresh();
    await page.route('**/canvas.js*', (route) =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: 'export {};' })
    );
    await page.goto(`${origin}/x/`, { waitUntil: 'domcontentloaded' });
    await onClassicWithNotice('boot');
    expect(navigations).toHaveLength(2);
  });

  it('gets the classic view with the notice straight from the server when a canvas file is missing', async () => {
    await fresh();
    const present = server.canvasFilesPresent.bind(server);
    server.canvasFilesPresent = () => false;
    try {
      await page.goto(`${origin}/x/`, { waitUntil: 'domcontentloaded' });
      await onClassicWithNotice('missing');
      expect(navigations).toEqual(['/x/']);
    } finally {
      server.canvasFilesPresent = present;
    }
  });

  it('lets the person try the canvas again or dismiss the notice, and never retries by itself', async () => {
    await fresh();
    await page.goto(`${origin}/x/?view=classic&canvas=failed&reason=load`, { waitUntil: 'domcontentloaded' });
    await onClassicWithNotice('load');
    expect(await page.locator('#canvasShellNotice').textContent()).toContain('The canvas did not load');
    await page.locator('.canvas-shell-notice-dismiss').click();
    expect(await page.locator('#canvasShellNotice').count()).toBe(0);
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe('/x/classic');
    await page.goto(`${origin}/x/?view=classic&canvas=failed&reason=%3Cb%3Ex`, { waitUntil: 'domcontentloaded' });
    await onClassicWithNotice('boot');
    expect(await page.locator('#canvasShellNotice b').count()).toBe(0);
    await page.locator('.canvas-shell-notice-retry').click();
    await page.waitForSelector('[data-object-id="n1"]');
    expect(new URL(page.url()).pathname).toMatch(/^\/x\/canvas\//);
  });

  it('does not act inside a frame: a canvas that fails as a dashboard tab stays where it is', async () => {
    await fresh();
    await page.route('**/canvas.js*', (route) => route.abort());
    await page.goto(`${origin}/x/classic`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.header');
    await page.evaluate((src) => {
      const frame = document.createElement('iframe');
      frame.id = 'probe';
      frame.src = src;
      document.body.appendChild(frame);
    }, `${origin}/x/canvas/${alpha}`);
    const frame = page.frameLocator('#probe');
    await frame.locator('#state').waitFor();
    await page.waitForTimeout(800);
    const inner = page.frames().find((f) => f.url().includes(`/canvas/${alpha}`));
    expect(inner).toBeTruthy();
    expect(await inner!.evaluate(() => [window.__canvasBoot?.shell, window.__canvasBoot?.navigations])).toEqual([
      false,
      0,
    ]);
    expect(await frame.locator('#classicLink').isVisible()).toBe(false);
  });

  it('offline, a saved copy of the canvas page served for a classic address stays put and says so', async () => {
    await page.close();
    const withWorker = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    try {
      await offlineCase(withWorker);
    } finally {
      await withWorker.close();
      await fresh();
    }
  });

  async function offlineCase(context: BrowserContext) {
    const page = await context.newPage();
    watch(page);
    // The dashboard registers the service worker; the canvas page is then fetched through it and kept.
    await page.goto(`${origin}/x/classic`, { waitUntil: 'domcontentloaded' });
    const controlled = await page
      .evaluate(async () => {
        if (!('serviceWorker' in navigator)) return false;
        await navigator.serviceWorker.ready;
        for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i++)
          await new Promise((r) => setTimeout(r, 100));
        return !!navigator.serviceWorker.controller;
      })
      .catch(() => false);
    expect(controlled, 'the service worker must control the page for this case to mean anything').toBe(true);
    await page.goto(`${origin}/x/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-object-id="n1"]');
    await context.setOffline(true);
    navigations = [];
    await page.goto(`${origin}/x/?view=classic&canvas=failed&reason=load`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#state h1')?.textContent === 'Codeman cannot be reached');
    await page.waitForTimeout(800);
    expect(navigations).toEqual(['/x/?view=classic&canvas=failed&reason=load']);
    expect(await page.evaluate(() => [window.__canvasBoot?.stale, window.__canvasBoot?.navigations])).toEqual([
      true,
      0,
    ]);
    expect(new URL(page.url()).search).toBe('?view=classic&canvas=failed&reason=load');
    expect(await page.locator('#retry').isVisible()).toBe(true);
  }
});
