/**
 * Canvas shell (PC13) on a phone: `/` is the canvas home, the outline lists Sessions first, a session row
 * navigates the whole window to the session page (never a frame, so the on-screen keyboard works), typing
 * reaches the pane, and Canvas returns with the camera and rail view the one-use ticket saved.
 * Sessions are the server's test stand-ins (a PTY that echoes, no agent, no tmux): the pane is read from the
 * session's own terminal capture. Headless Chromium reports no touch, so `window.__canvasTouch` forces the
 * canvas's touch branch and `app._localEchoEnabled` the dashboard's local echo, per the testing rules.
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

const installed = vi.hoisted(() => ({ map: { claude: true } as Record<string, boolean> }));
vi.mock('../../src/utils/cli-installed-probes.js', async (original) => ({
  ...(await original<typeof import('../../src/utils/cli-installed-probes.js')>()),
  probeStockCliAvailability: async () => installed.map,
}));

const WIDTH = 390;
describe('phone canvas shell', () => {
  let server: WebServer, browser: Browser, context: BrowserContext, page: Page, origin: string, workspace: string;
  let sessionId: string;
  const api = (path: string) => `${origin}/x/api${path}`;
  const view = () => page.evaluate(() => window.canvasView.read());
  const pane = async () =>
    JSON.stringify(await (await page.request.get(api(`/sessions/${sessionId}/terminal`))).json());
  const row = () => page.locator(`#sessionRows button.session-row[data-session-id="${sessionId}"]`);

  beforeAll(async () => {
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-pc13-phone');
    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasEnabled: true, canvasShellEnabled: true }));
    mkdirSync(resolve(resolveCasesDir(), 'phone-shell'), { recursive: true });
    workspace = workspaceForCase('phone-shell').id;
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
      viewport: { width: WIDTH, height: 844 },
      deviceScaleFactor: 1,
      hasTouch: true,
      isMobile: true,
      serviceWorkers: 'block',
    });
    await context.addInitScript(() => {
      window.__canvasTouch = true;
      if (!localStorage.getItem('codeman:skin')) localStorage.setItem('codeman:skin', 'og');
    });
    page = await context.newPage();
    const started = await (
      await page.request.post(api('/quick-start'), {
        data: { caseName: 'phone-shell', mode: 'shell', sessionName: 'phone-term' },
      })
    ).json();
    sessionId = (started.sessionId ?? started.data?.sessionId) as string;
    expect(sessionId, JSON.stringify(started)).toBeTruthy();
  }, 60000);
  afterAll(async () => {
    await page?.request.delete(api(`/sessions/${sessionId}`)).catch(() => {});
    await browser?.close();
    await server?.stop();
    vi.unstubAllEnvs();
  }, 60000);

  it('lands on the canvas home at `/`, not the phone overview', async () => {
    await page.goto(`${origin}/x/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-object-id="brief"]');
    await page.waitForFunction(() => !!window.canvasView);
    expect(new URL(page.url()).pathname).toBe(`/x/canvas/${workspace}`);
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-phone'))).toBe(true);
    expect(await page.locator('.mobile-overview').count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(WIDTH);
  });

  it('lists Sessions first in the outline, at touch size, with no canvas edit controls', async () => {
    // The dock's Sections control opens the outline on a phone.
    if (!(await view()).outlineOpen) await page.locator('#sectionsTool').tap();
    await row().waitFor();
    const top = async (selector: string) => (await page.locator(selector).boundingBox())!.y;
    const sessions = await top('#sessions');
    expect(sessions).toBeLessThan(await top('.search-wrap'));
    expect(sessions).toBeLessThan(await top('#tree'));
    // The name and the visible Close stay above it.
    expect(await top('#outline .panel-head')).toBeLessThan(sessions);
    expect(await page.locator('#closeOutline').isVisible()).toBe(true);
    const box = (await row().boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x + box.width).toBeLessThanOrEqual(WIDTH);
    expect((await page.locator('#newSession').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.locator('.edit-control:visible').count()).toBe(0);
  });

  it('opens a session row at the top level, types with the on-screen keyboard, and returns to the same view', async () => {
    await page.evaluate(() => {
      window.canvasView.dispatch({ kind: 'viewport', viewport: { x: 21, y: 64, zoom: 0.9 } });
      window.canvasView.dispatch({ kind: 'selection', ids: ['brief'] });
    });
    const before = await view();
    expect(before.outlineOpen).toBe(true);
    await row().tap();
    await page.waitForURL(new RegExp(`/x/session/${sessionId}\\?from=canvas&ws=${workspace}$`));
    // The whole window went: this is the session page itself, not a frame inside the canvas.
    expect(page.frames()).toHaveLength(1);
    expect(await page.evaluate(() => window === window.top)).toBe(true);
    await page.waitForSelector('#soloCanvasBtn');
    await page.waitForFunction(
      (sid) => (window as unknown as { app?: { activeSessionId?: string } }).app?.activeSessionId === sid,
      sessionId
    );
    const canvasButton = (await page.locator('#soloCanvasBtn').boundingBox())!;
    expect(canvasButton.x + canvasButton.width).toBeLessThanOrEqual(WIDTH);
    expect(await page.locator('#soloRedockBtn').isVisible()).toBe(false);
    // No header button was added for phones in the dashboard document; this one is built for this address only.
    expect(await page.locator('#canvasShellLink').count()).toBe(0);

    // On-screen typing: the text waits in the local-echo overlay and reaches the pane on Enter.
    await page.waitForSelector('.xterm-helper-textarea', { state: 'attached' });
    await page.evaluate(() => {
      (window as unknown as { app: { _localEchoEnabled: boolean } }).app._localEchoEnabled = true;
    });
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('echo PHONE-MARK-5527');
    const pending = await page.evaluate(
      () =>
        (window as unknown as { app: { _localEchoOverlay?: { pendingText?: string } } }).app._localEchoOverlay
          ?.pendingText ?? null
    );
    expect(pending).toContain('PHONE-MARK-5527');
    await page.keyboard.press('Enter');
    await vi.waitFor(async () => expect(await pane()).toContain('PHONE-MARK-5527'), { timeout: 10000 });

    await page.locator('#soloCanvasBtn').tap();
    await page.waitForURL(new RegExp(`/x/canvas/${workspace}$`));
    await page.waitForSelector('[data-object-id="brief"]');
    await page.waitForFunction(() => !!window.canvasView);
    const after = await view();
    expect(after.viewport).toEqual(before.viewport);
    expect(after.rail).toEqual(before.rail);
    expect(after.selected).toEqual(before.selected);
    expect(after.outlineOpen).toBe(true);
    expect(after.fullView).toBeNull();
    // Focus is back on the row that opened the session.
    await page.waitForFunction(
      (sid) => (document.activeElement as HTMLElement | null)?.dataset.sessionId === sid,
      sessionId
    );
    // One use: the ticket is gone, and a reload opens the ordinary first view.
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.endsWith(':shell:return')))).toEqual(
      []
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-object-id="brief"]');
    await page.waitForFunction(() => !!window.canvasView);
    expect((await view()).viewport).not.toEqual(before.viewport);
  }, 60000);

  it('restores an open rail view too, and ignores a ticket for another workspace', async () => {
    await page.evaluate(() => {
      window.canvasView.dispatch({ kind: 'outline', open: false });
      window.canvasView.dispatch({ kind: 'rail', view: 'assistant' });
      window.canvasView.dispatch({ kind: 'viewport', viewport: { x: -8, y: 30, zoom: 1.1 } });
    });
    await page.waitForFunction(() => document.querySelectorAll('#sessionRows button.session-row').length === 1);
    const before = await view();
    expect(before.rail).toEqual(['assistant']);
    // The typed command a row sends; on a phone it navigates.
    await page.evaluate((sid) => window.canvasView.dispatch({ kind: 'full-view', sessionId: sid }), sessionId);
    await page.waitForURL(new RegExp(`/x/session/${sessionId}\\?from=canvas`));
    await page.locator('#soloCanvasBtn').tap();
    await page.waitForURL(new RegExp(`/x/canvas/${workspace}$`));
    await page.waitForFunction(() => !!window.canvasView && window.canvasView.read().rail.length === 1);
    const after = await view();
    expect(after.viewport).toEqual(before.viewport);
    expect(after.rail).toEqual(['assistant']);
    expect(after.outlineOpen).toBe(false);
    expect(await page.locator('#assistantView').isVisible()).toBe(true);

    // A ticket written for another workspace is taken and dropped.
    await page.evaluate(() => {
      const scope = `codeman:canvas:user:${encodeURIComponent('@single')}`;
      const ws = location.pathname.split('/').pop()!;
      sessionStorage.setItem(
        `${scope}:${ws}:shell:return`,
        JSON.stringify({
          workspaceId: 'someone-else',
          sessionId: 's',
          viewport: { x: 999, y: 999, zoom: 2 },
          selected: [],
          focusId: null,
          rail: ['history'],
          outlineOpen: true,
          root: null,
          at: Date.now(),
        })
      );
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-object-id="brief"]');
    await page.waitForFunction(() => !!window.canvasView);
    const fresh = await view();
    expect(fresh.viewport.zoom).not.toBe(2);
    expect(fresh.rail).toEqual([]);
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.endsWith(':shell:return')))).toEqual(
      []
    );
  }, 60000);

  it('an agent cannot navigate a phone away, and the classic view gained no header button', async () => {
    const call = async (args: Record<string, unknown>) =>
      (
        await page.request.post(api(`/canvas/${workspace}/command`), { data: { tool: 'canvas_view', arguments: args } })
      ).json();
    await vi.waitFor(async () => expect((await call({ action: 'list' })).data.views.length).toBeGreaterThan(0), {
      timeout: 10000,
    });
    const viewId: string = (await call({ action: 'list' })).data.views[0].viewId;
    await page.waitForFunction(() => document.querySelectorAll('#sessionRows button.session-row').length === 1);
    expect((await call({ action: 'full-view', viewId, sessionId })).success).toBe(true);
    await page.waitForTimeout(1200);
    expect(new URL(page.url()).pathname).toBe(`/x/canvas/${workspace}`);
    expect(await page.locator('#fullViewFrame iframe').count()).toBe(0);

    await page.goto(`${origin}/x/classic`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as { app?: unknown }).app);
    await page.waitForSelector('#canvasShellLink', { state: 'attached' });
    expect(await page.locator('#canvasShellLink').isVisible()).toBe(false);
    expect(await page.locator('#soloCanvasBtn').count()).toBe(0);
  }, 60000);
});
