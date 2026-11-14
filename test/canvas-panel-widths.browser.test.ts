/**
 * @fileoverview Both side panels of the canvas page take their width from the person: the outline's right edge and
 * the rail's left edge drag, answer the arrow keys, and the width survives a reload. The board keeps its room.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import puppeteer from 'puppeteer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebServer } from '../src/web/server.js';
import { dataPath } from '../src/config/instance.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';

describe('canvas side panel widths', () => {
  let server: WebServer, browser: Browser, page: Page, origin: string, workspace: string;
  beforeAll(async () => {
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-canvas-panel-widths');
    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasEnabled: true, canvasShellEnabled: false }));
    mkdirSync(resolve(resolveCasesDir(), 'Widths'), { recursive: true });
    workspace = workspaceForCase('Widths').id;
    server = new WebServer(0, false, true);
    await server.start();
    origin = `http://localhost:${server.boundPort}`;
    browser = await chromium.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: ['--no-sandbox'],
    });
    page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })).newPage();
  }, 60000);
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    vi.unstubAllEnvs();
  }, 60000);

  const width = (id: string) => page.evaluate((i) => document.getElementById(i)!.getBoundingClientRect().width, id);
  const open = async () => {
    await page.goto(`${origin}/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.canvasView);
    await page.evaluate(() => window.canvasView.dispatch({ kind: 'rail', view: 'keys' }));
    await page.waitForSelector('#rail:not([hidden])');
  };
  const drag = async (id: string, toX: number) => {
    const box = (await page.locator(id).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(toX, box.y + 220, { steps: 6 });
    await page.mouse.up();
  };

  it('opens at the old fixed widths', async () => {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.removeItem('codeman:canvas:panel-widths'));
    await open();
    expect(await width('outline')).toBe(192);
    expect(await width('rail')).toBe(320);
  });

  it('widens the outline and the rail by dragging their inner edges, and keeps them across a reload', async () => {
    await drag('#outlineResize', 300);
    await drag('#railResize', 1440 - 560);
    expect(await width('outline')).toBe(300);
    expect(await width('rail')).toBe(560);
    await open();
    expect(await width('outline')).toBe(300);
    expect(await width('rail')).toBe(560);
  });

  it('answers the arrow keys and Enter on a focused edge', async () => {
    await page.locator('#railResize').focus();
    await page.keyboard.press('ArrowLeft');
    expect(await width('rail')).toBe(576);
    expect(await page.locator('#railResize').getAttribute('aria-valuenow')).toBe('576');
    await page.keyboard.press('Enter');
    expect(await width('rail')).toBe(320);
    await page.locator('#outlineResize').focus();
    await page.keyboard.press('Shift+ArrowRight');
    expect(await width('outline')).toBe(364);
  });

  it('leaves the board room when the panels are dragged past it', async () => {
    await drag('#outlineResize', 1400);
    await drag('#railResize', 0);
    const total = (await width('outline')) + (await width('rail'));
    expect(total).toBeLessThanOrEqual(1440 - 320);
  });

  it('shows no handle at phone width', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open();
    expect(await page.locator('#railResize').isVisible()).toBe(false);
    expect(await page.locator('#outlineResize').isVisible()).toBe(false);
    expect(await width('rail')).toBe(390);
  });
});
