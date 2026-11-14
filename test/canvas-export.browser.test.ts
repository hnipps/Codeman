/**
 * A person's export of the open canvas and of one selected object, in a real browser: by keyboard on a laptop and
 * by touch at phone width. Every file is compared with what an agent's route answers for the same target.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Download, type Page } from 'playwright';
import puppeteer from 'puppeteer';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebServer } from '../src/web/server.js';
import { dataPath } from '../src/config/instance.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';
import { CanvasStores } from '../src/canvas/canvas-store.js';
import { CommandSchema } from '../src/canvas/operations.js';

const MEDIA = resolve(import.meta.dirname, '../pr/media/canvas-export');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const note = (id: string, x: number, text: string, parentId: string | null = null) =>
  CommandSchema.parse({
    kind: 'create',
    opId: `create-${id}`,
    objectId: id,
    patch: {
      parentId,
      order: x / 1000,
      position: { x, y: 40 },
      size: { width: 180, height: 90 },
      content: { type: 'text', text },
    },
  });
const section = CommandSchema.parse({
  kind: 'create',
  opId: 'create-plan',
  objectId: 'plan',
  patch: {
    parentId: null,
    order: 0,
    position: { x: 0, y: 0 },
    size: { width: 520, height: 220 },
    content: { type: 'section', label: 'Release plan' },
  },
});

describe('canvas export', () => {
  let server: WebServer, browser: Browser, context: BrowserContext, page: Page, origin: string, alpha: string;
  const api = (path: string) => `${origin}/x/api${path}`;
  const menu = () => page.locator('#exportMenu');
  const status = () => page.locator('#exportStatus');
  const focused = (p: Page = page) =>
    p.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el ? `${el.dataset.exportScope ?? el.id}:${el.dataset.exportFormat ?? ''}` : '';
    });
  const bytes = async (download: Download) => readFileSync(await download.path());
  const read = async (root?: string) =>
    (
      await (
        await page.request.post(api(`/canvas/${alpha}/command`), {
          data: { tool: 'canvas_read', arguments: root ? { root } : {} },
        })
      ).json()
    ).data;
  async function open(p: Page = page) {
    await p.goto(`${origin}/x/canvas/${alpha}`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('[data-object-id="a"]');
    await p.waitForFunction(() => document.querySelector('#workspaceName')?.textContent?.trim() === 'alpha');
  }

  beforeAll(async () => {
    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasEnabled: true, canvasShellEnabled: false }));
    // The server renders with its own headless browser, sandboxed by default; this test's browser is not either.
    writeFileSync(dataPath('mermaid-runtime.json'), JSON.stringify({ noSandbox: true }));
    mkdirSync(resolve(resolveCasesDir(), 'alpha'), { recursive: true });
    mkdirSync(MEDIA, { recursive: true });
    alpha = workspaceForCase('alpha').id;
    const stores = new CanvasStores();
    expect(
      stores.get(alpha).append(
        [
          section,
          note('a', 20, 'Ship the export', 'plan'),
          note('b', 260, 'Tell the agents', 'plan'),
          CommandSchema.parse({
            kind: 'create',
            opId: 'create-inner',
            objectId: 'inner',
            patch: {
              parentId: null,
              order: 1,
              position: { x: 600, y: 0 },
              size: { width: 240, height: 160 },
              content: { type: 'subcanvas', workspaceId: alpha, label: 'Inner board' },
            },
          }),
          note('deep', 0, 'Only inside the sub-canvas', 'inner'),
        ],
        { kind: 'human', userId: 'a' }
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
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
    });
    page = await context.newPage();
  }, 60000);
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
  }, 60000);

  it('exports the open canvas as objects by keyboard alone, without leaving the page', async () => {
    await open();
    const address = page.url();
    await page.locator('#board').focus();
    await page.keyboard.press('e');
    await menu().waitFor();
    // Nothing is selected: the selection rows say why, and the keyboard starts on the canvas rows.
    expect(await page.locator('[data-export-heading="selection"]').textContent()).toBe('Select one object first.');
    expect(await page.locator('[data-export-heading="canvas"]').textContent()).toBe('alpha');
    expect(await focused()).toBe('canvas:png');
    await page.keyboard.press('ArrowDown');
    expect(await focused()).toBe('canvas:json');
    const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
    expect(download.suggestedFilename()).toMatch(/^alpha-\d{8}-\d{6}\.json$/);
    const file = JSON.parse((await bytes(download)).toString('utf8'));
    expect(file).toEqual(await read());
    expect(file.tree[0].object.id).toBe('plan');
    expect(file.tree[0].children.map((child: { object: { id: string } }) => child.object.id)).toEqual(['a', 'b']);
    await expect.poll(() => status().textContent()).toContain(`Exported ${download.suggestedFilename()}`);
    expect(page.url()).toBe(address);
    await page.screenshot({ animations: 'disabled', path: resolve(MEDIA, `export-${stamp}-desktop-menu.png`) });
    await page.keyboard.press('Escape');
    await menu().waitFor({ state: 'hidden' });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('board');
    // A disabled row answers with its reason and saves nothing.
    await page.keyboard.press('e');
    await page.keyboard.press('Home');
    expect(await focused()).toBe('selection:png');
    let saved = 0;
    page.on('download', () => saved++);
    await page.keyboard.press('Enter');
    await expect.poll(() => status().textContent()).toBe('Select one object first.');
    expect(saved).toBe(0);
    await page.keyboard.press('Escape');
  });

  it('does not open while the person types an e into a field, and closes when the keyboard leaves it', async () => {
    await open();
    await page.locator('#board').focus();
    await page.keyboard.press('e');
    await menu().waitFor();
    await page.locator('#search').focus();
    await menu().waitFor({ state: 'hidden' });
    await page.keyboard.type('release');
    expect(await page.locator('#search').inputValue()).toBe('release');
    expect(await menu().isHidden()).toBe(true);
  });

  it('exports the one selected object as the same image and objects an agent gets', async () => {
    await open();
    await page.locator('[data-object-id="plan"] > .object-title').click();
    await page.waitForFunction(() => window.canvasView.read().selected.join() === 'plan');
    await page.locator('#board').focus();
    await page.keyboard.press('e');
    await menu().waitFor();
    expect(await page.locator('[data-export-heading="selection"]').textContent()).toBe('Release plan');
    expect(await focused()).toBe('selection:png');
    const theme = await page.evaluate(() => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'));
    const agent = await page.request.get(api(`/canvas/${alpha}/objects/plan/screenshot?theme=${theme}`));
    if (agent.status() === 503) {
      // No headless browser on this machine: the person is told what the agent is told, and nothing is saved.
      await page.keyboard.press('Enter');
      await expect.poll(() => status().textContent()).toBe(`Not exported. ${(await agent.json()).error}`);
    } else {
      expect(agent.status()).toBe(200);
      const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
      expect(download.suggestedFilename()).toMatch(/^release-plan-\d{8}-\d{6}\.png$/);
      const image = await bytes(download);
      expect(image.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(image.equals(await agent.body())).toBe(true);
      // The whole top level is one more row down, and it is the route an agent calls with no object.
      await page.keyboard.press('End');
      await page.keyboard.press('ArrowUp');
      expect(await focused()).toBe('canvas:png');
      const whole = await page.request.get(api(`/canvas/${alpha}/screenshot?theme=${theme}`));
      const [top] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
      expect((await bytes(top)).equals(await whole.body())).toBe(true);
      // The top level is wider than the section alone: it frames the sub-canvas beside it too.
      const width = (response: typeof whole) =>
        JSON.parse(response.headers()['x-canvas-screenshot-meta']).clip.width as number;
      expect(width(whole)).toBeGreaterThan(width(agent));
      writeFileSync(resolve(MEDIA, `export-${stamp}-file-selection.png`), image);
      writeFileSync(resolve(MEDIA, `export-${stamp}-file-top-level.png`), await bytes(top));
    }
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    expect(await focused()).toBe('selection:json');
    const [objects] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
    const file = JSON.parse((await bytes(objects)).toString('utf8'));
    expect(file).toEqual(await read('plan'));
    expect(file.tree).toHaveLength(1);
    // Inside a sub-canvas, "Canvas" is that sub-canvas, drawn open as an agent's screenshot of it is.
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.canvasView.dispatch({ kind: 'enter', id: 'inner' }));
    await page.locator('#board').focus();
    await page.keyboard.press('e');
    expect(await page.locator('[data-export-heading="canvas"]').textContent()).toBe('Inner board');
    const inner = await page.request.get(api(`/canvas/${alpha}/objects/inner/screenshot?theme=${theme}`));
    if (inner.status() === 200) {
      expect(await focused()).toBe('canvas:png');
      const [opened] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
      expect(opened.suggestedFilename()).toMatch(/^inner-board-/);
      expect((await bytes(opened)).equals(await inner.body())).toBe(true);
      writeFileSync(resolve(MEDIA, `export-${stamp}-file-sub-canvas.png`), await bytes(opened));
    }
    // Leaving the sub-canvas moves the keyboard to it on the board, and a menu the keyboard left closes.
    await page.evaluate(() => window.canvasView.dispatch({ kind: 'leave' }));
    await menu().waitFor({ state: 'hidden' });
    expect(await page.evaluate(() => window.canvasView.read().root)).toBeNull();
    // Two selected objects are not one target: the row says what to do instead.
    await page.evaluate(() => window.canvasView.dispatch({ kind: 'selection', ids: ['a', 'b'] }));
    await page.waitForFunction(() => window.canvasView.read().selected.join() === 'a,b');
    await page.locator('#outlineExport').click();
    expect(await page.locator('[data-export-heading="selection"]').textContent()).toBe(
      'Select one object, or group the selection first.'
    );
    expect(await page.locator('#outlineExport').getAttribute('aria-expanded')).toBe('true');
    await page.mouse.click(900, 400);
    await menu().waitFor({ state: 'hidden' });
  });

  it('exports from a phone: the tapped object from its sheet, the canvas from the outline', async () => {
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      hasTouch: true,
      isMobile: true,
      serviceWorkers: 'block',
    });
    await phone.addInitScript(() => {
      window.__canvasTouch = true;
    });
    const p = await phone.newPage();
    try {
      await open(p);
      const address = p.url();
      await p.locator('[data-object-id="a"]').tap();
      await p.locator('#sheetExport').tap();
      await p.locator('#exportMenu').waitFor();
      const box = (await p.locator('#exportMenu').boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
      for (const row of await p.locator('#exportMenu button').all())
        expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(await p.locator('[data-export-heading="selection"]').textContent()).toBe('Ship the export');
      await p.screenshot({ animations: 'disabled', path: resolve(MEDIA, `export-${stamp}-phone-menu.png`) });
      const [one] = await Promise.all([
        p.waitForEvent('download'),
        p.locator('#exportMenu [data-export-scope="selection"][data-export-format="json"]').tap(),
      ]);
      const file = JSON.parse((await bytes(one)).toString('utf8'));
      expect(file.tree.map((node: { object: { id: string } }) => node.object.id)).toEqual(['a']);
      await p.locator('#board').tap({ position: { x: 20, y: 120 } });
      await p.locator('#exportMenu').waitFor({ state: 'hidden' });
      await p.locator('#sectionsTool').tap();
      await p.locator('#outlineExport').tap();
      await p.locator('#exportMenu').waitFor();
      const [all] = await Promise.all([
        p.waitForEvent('download'),
        p.locator('#exportMenu [data-export-scope="canvas"][data-export-format="json"]').tap(),
      ]);
      expect(JSON.parse((await bytes(all)).toString('utf8'))).toEqual(await read());
      expect(p.url()).toBe(address);
    } finally {
      await phone.close();
    }
  });
});
