/**
 * @fileoverview The outline's sections collapse to their header and resize from the boundary under them, and both
 * survive a reload. A phone collapses them but draws no handle.
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

describe('canvas outline sections', () => {
  let server: WebServer, browser: Browser, page: Page, origin: string, workspace: string;
  beforeAll(async () => {
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-canvas-outline-sections');
    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasEnabled: true, canvasShellEnabled: false }));
    mkdirSync(resolve(resolveCasesDir(), 'Sections'), { recursive: true });
    workspace = workspaceForCase('Sections').id;
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

  const open = async (p: Page = page) => {
    await p.goto(`${origin}/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => !!window.canvasView && !!document.querySelector('#work .section-toggle'));
  };
  const height = (id: string) => page.evaluate((i) => document.getElementById(i)!.getBoundingClientRect().height, id);
  const workHandle = '#work + .section-resize';

  it('gives every drawn section a toggle, the object tree an Objects header, and starts expanded', async () => {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.removeItem('codeman:canvas:outline-sections'));
    await open();
    expect(await page.locator('#objects .section-toggle').textContent()).toBe('Objects');
    expect(await page.locator('#work .section-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(await page.locator('#objects .section-toggle').getAttribute('aria-controls')).toBe('tree');
    expect(await page.locator('#objectsTitle').textContent()).toBe('Objects');
    expect(await page.locator(workHandle).isVisible()).toBe(true);
  });

  it('collapses Work to its header, counts included, and keeps it collapsed across a reload', async () => {
    await page.locator('#work .section-toggle').click();
    expect(await page.locator('#work .section-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(await page.locator('#workCounts').isVisible()).toBe(false);
    expect(await page.locator(workHandle).isVisible()).toBe(false);
    await open();
    expect(await page.locator('#work .section-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(await page.locator('#workCounts').isVisible()).toBe(false);
    await page.locator('#work .section-toggle').click();
    expect(await page.locator('#workCounts').isVisible()).toBe(true);
  });

  it('leaves Work at its own size after a click on its boundary without a move', async () => {
    const box = (await page.locator(workHandle).boundingBox())!;
    await page.mouse.click(box.x + 40, box.y + box.height / 2);
    expect(await page.evaluate(() => document.getElementById('work')!.style.height)).toBe('');
    expect(await page.evaluate(() => localStorage.getItem('codeman:canvas:outline-sections') ?? '')).not.toContain(
      'heights":{"work'
    );
  });

  it('drags the boundary under Work to set its height, and keeps it across a reload', async () => {
    const top = await page.evaluate(() => document.getElementById('work')!.getBoundingClientRect().top);
    const box = (await page.locator(workHandle).boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 40, top + 300, { steps: 6 });
    await page.mouse.up();
    expect(await height('work')).toBe(300);
    await open();
    expect(await height('work')).toBe(300);
    expect(await page.locator(workHandle).getAttribute('aria-valuenow')).toBe('300');
  });

  it('answers the arrow keys and Enter on a focused boundary', async () => {
    await page.locator(workHandle).focus();
    await page.keyboard.press('ArrowDown');
    expect(await height('work')).toBe(316);
    await page.keyboard.press('Shift+ArrowUp');
    expect(await height('work')).toBe(252);
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => document.getElementById('work')!.style.height)).toBe('');
  });

  it('keeps a stored height inside a shorter window, with room for the objects below', async () => {
    await page.evaluate(() =>
      localStorage.setItem('codeman:canvas:outline-sections', JSON.stringify({ heights: { work: 3000 } }))
    );
    await open();
    expect(await height('objects')).toBeGreaterThanOrEqual(64);
    const bottom = await page.evaluate(() => document.getElementById('objects')!.getBoundingClientRect().bottom);
    const foot = await page.evaluate(() => document.querySelector('.outline-foot')!.getBoundingClientRect().top);
    expect(bottom).toBeLessThanOrEqual(foot + 1);
  });

  it('lets the last expanded section take the room when Objects is collapsed', async () => {
    await page.evaluate(() =>
      localStorage.setItem('codeman:canvas:outline-sections', JSON.stringify({ collapsed: ['objects'] }))
    );
    await open();
    expect(await page.locator('#tree').isVisible()).toBe(false);
    expect(await page.locator(workHandle).isVisible()).toBe(false);
    const workBottom = await page.evaluate(() => document.getElementById('work')!.getBoundingClientRect().bottom);
    const objectsTop = await page.evaluate(() => document.getElementById('objects')!.getBoundingClientRect().top);
    expect(Math.abs(workBottom - objectsTop)).toBeLessThanOrEqual(1);
    expect(await height('work')).toBeGreaterThan(300);
  });

  it('opens a collapsed Objects section when the person searches', async () => {
    await page.locator('#search').fill('anything');
    expect(await page.locator('#objects .section-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(await page.locator('#tree').isVisible()).toBe(true);
    await page.locator('#search').fill('');
  });

  it('collapses on a phone but draws no handle', async () => {
    const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await phone.goto(origin, { waitUntil: 'domcontentloaded' });
    await phone.evaluate(() => localStorage.removeItem('codeman:canvas:outline-sections'));
    await open(phone);
    await phone.evaluate(() => window.canvasView.dispatch({ kind: 'outline', open: true }));
    await phone.waitForSelector('#outline:not([hidden])');
    expect(await phone.locator('.section-resize:visible').count()).toBe(0);
    await phone.locator('#work .section-toggle').click();
    expect(await phone.locator('#workCounts').isVisible()).toBe(false);
    expect(await phone.locator('.section-resize:visible').count()).toBe(0);
    await phone.context().close();
  });
});
