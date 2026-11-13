/**
 * Phone background tasks (PC12): Run in background in the phone assistant, the task list as a full-screen view with
 * touch-size controls, and Cancel and Remove by tap. Sessions are the server's test stand-ins, so no agent runs here.
 * Headless Chromium reports no touch even with touch emulation, so `window.__canvasTouch` forces the touch branch.
 */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import puppeteer from 'puppeteer';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WebServer } from '../../src/web/server.js';
import { dataPath } from '../../src/config/instance.js';
import { workspaceForCase } from '../../src/canvas/workspace-registry.js';
import { resolveCasesDir } from '../../src/web/route-helpers.js';
import { CanvasStores } from '../../src/canvas/canvas-store.js';
import { CommandSchema } from '../../src/canvas/operations.js';
import type { TaskRow } from '../../src/canvas/tasks.js';

const installed = vi.hoisted(() => ({ map: { claude: true } as Record<string, boolean> }));
vi.mock('../../src/utils/cli-installed-probes.js', async (original) => ({
  ...(await original<typeof import('../../src/utils/cli-installed-probes.js')>()),
  probeStockCliAvailability: async () => installed.map,
}));

const MEDIA = resolve('pr/media');
const stamp = Date.now();
const WIDTH = 390;
describe('phone background tasks', () => {
  let server: WebServer, browser: Browser, context: BrowserContext, page: Page, origin: string, workspace: string;
  const posts: { method: string; url: string; body: Record<string, unknown> }[] = [];
  const shot = (slug: string) =>
    page.screenshot({ animations: 'disabled', path: resolve(MEDIA, `pc12-${stamp}-phone-${slug}.png`) });
  const tasks = async () =>
    (await (await page.request.get(`${origin}/x/api/canvas/${workspace}/tasks`)).json()).data.tasks as TaskRow[];
  const view = () => page.evaluate(() => window.canvasView.read());
  async function touchSized(selector: string) {
    const box = (await page.locator(selector).first().boundingBox())!;
    expect(box.height, selector).toBeGreaterThanOrEqual(44);
    expect(box.x, selector).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, selector).toBeLessThanOrEqual(WIDTH);
  }
  beforeAll(async () => {
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-pc12-phone');
    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasEnabled: true, canvasShellEnabled: false }));
    const casePath = resolve(resolveCasesDir(), 'phone-tasks');
    mkdirSync(casePath, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: casePath, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(casePath, 'README.md'), 'hello\n');
    git('add', 'README.md');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'first');
    workspace = workspaceForCase('phone-tasks').id;
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
    });
    await context.addInitScript(() => {
      window.__canvasTouch = true;
      if (!localStorage.getItem('codeman:skin')) localStorage.setItem('codeman:skin', 'og');
    });
    page = await context.newPage();
    page.on('request', (r) => {
      if (r.method() !== 'GET' && /\/api\/canvas\/[^/]+\/(tasks|conversations)/.test(r.url()))
        posts.push({ method: r.method(), url: r.url(), body: JSON.parse(r.postData() || '{}') });
    });
    mkdirSync(MEDIA, { recursive: true });
    await page.goto(`${origin}/x/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-object-id="brief"]');
    await page.waitForFunction(() => !!window.canvasView);
    await page.waitForFunction(() => document.querySelectorAll('#providerSelect option[value="claude"]').length === 1);
    await page.locator('#assistantTool').tap();
    await page.waitForSelector('#assistantView:not([hidden])');
  }, 60000);
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    vi.unstubAllEnvs();
  }, 60000);

  it('offers Run in background at touch size inside the width, off while the message is empty', async () => {
    await touchSized('#runBackground');
    await touchSized('#assistantSend');
    expect(await page.locator('#runBackground').isDisabled()).toBe(true);
    // The dock keeps to the phone's controls: the list is reached from the assistant.
    expect(await page.locator('#tasksTool').isVisible()).toBe(false);
    expect(await page.locator('#tasksOpen').isVisible()).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(WIDTH);
  });

  it('a hardware G does nothing on a phone', async () => {
    await page.evaluate(() =>
      document.getElementById('board')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true }))
    );
    expect(await page.locator('#tasksView').isVisible()).toBe(false);
  });

  it('runs the message as a task by tap and keeps the assistant where it was', async () => {
    await page.locator('#assistantDraft').fill('Summarise the brief');
    const before = await view();
    await page.locator('#runBackground').tap();
    await page.waitForFunction(() => (document.getElementById('assistantDraft') as HTMLTextAreaElement).value === '');
    expect(posts.filter((p) => p.method === 'POST').map((p) => new URL(p.url).pathname.split('/').at(-1))).toEqual([
      'tasks',
    ]);
    const after = await view();
    expect(after.rail).toEqual(before.rail);
    expect(after.conversationId).toBe(before.conversationId);
    expect(after.viewport).toEqual(before.viewport);
    expect(await tasks()).toHaveLength(1);
    await page.waitForSelector('#tasksOpen:not([hidden])');
    await touchSized('#tasksOpen');
    await shot('assistant');
  });

  it('shows the list full-screen with a visible Close and touch-size controls, then cancels and removes by tap', async () => {
    const [task] = await tasks();
    await page.locator('#tasksOpen').tap();
    await page.waitForSelector(`.task-row[data-task-id="${task.id}"]`);
    const rail = (await page.locator('#rail').boundingBox())!;
    expect(rail.x).toBe(0);
    expect(rail.width).toBe(WIDTH);
    expect(rail.height).toBeGreaterThanOrEqual(800);
    expect(await page.locator('#railTitle').textContent()).toBe('Background tasks');
    await touchSized('#closeRail');
    for (const control of ['inspect', 'cancel']) await touchSized(`[data-task-control$=":${control}"]`);
    const size = (selector: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(await size('.task-name')).toBeGreaterThanOrEqual(16);
    expect(await size('.task-state')).toBeGreaterThanOrEqual(14);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(WIDTH);
    await shot('list');
    await page.locator('[data-task-control$=":cancel"]').tap();
    await page.waitForFunction(() => document.querySelector('.task-state')?.textContent === 'Cancelled');
    await page.locator('[data-task-control$=":remove"]').tap();
    await page.waitForSelector('.revert-confirm');
    await touchSized('[data-task-control$=":keep"]');
    await touchSized('[data-task-control$=":confirm"]');
    expect(await page.locator('dialog[open], [role="dialog"]').count()).toBe(0);
    await shot('remove-confirm');
    await page.locator('[data-task-control$=":confirm"]').tap();
    await page.waitForSelector('.task-row', { state: 'detached' });
    expect(await tasks()).toEqual([]);
    expect(await page.locator('#tasksEmpty').isVisible()).toBe(true);
    await page.locator('#closeRail').tap();
    await page.waitForSelector('#assistantView:not([hidden])');
  });
});
