/**
 * Work lanes in the browser after W-48: seven lanes in board order (Done and Not doing share the last column on a
 * desktop), a `work.json` from before the split migrated on read, Ready for work in pickup order with Shift+Up/Down
 * and a drag reordering it, the outline's Human required first, Ask an agent's unsent draft in a new conversation
 * (W-43), and the phone's wrapping lane tabs.
 *
 * Port: 0 (WebServer binds an ephemeral port).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import puppeteer from 'puppeteer';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { WebServer } from '../src/web/server.js';
import { dataPath } from '../src/config/instance.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';
import { CanvasStores } from '../src/canvas/canvas-store.js';
import { CommandSchema } from '../src/canvas/operations.js';
import { workPath } from '../src/canvas/work-store.js';

const MEDIA = resolve('pr/media');
const stamp = Date.now();
const person = { kind: 'human', userId: 'admin' };
/** A `work.json` as the release before W-48 wrote it, plus three items a later release split. */
const legacy = () => {
  const item = (number: number, title: string, status: string, extra: Record<string, unknown> = {}) => ({
    number,
    title,
    status,
    description: '',
    assignee: null,
    sessions: [],
    author: person,
    createdAt: number,
    updatedAt: number,
    revision: 1,
    history: [],
    ...extra,
  });
  return {
    version: 1,
    next: 11,
    items: [
      item(1, 'Pick the schema', 'todo', { assignee: { kind: 'person' } }),
      item(2, 'Raw capture', 'todo'),
      item(3, 'Kept by an agent', 'todo', { assignee: { kind: 'session', sessionId: 'sess-gone' } }),
      item(4, 'Ready A', 'todo', { todoStatus: 'ready-for-work' }),
      item(5, 'Ready B', 'todo', { todoStatus: 'ready-for-work' }),
      item(6, 'Ready C', 'todo', { todoStatus: 'ready-for-work' }),
      item(7, 'Building', 'in-progress'),
      item(8, 'Shipped', 'done'),
      item(9, 'Dropped', 'not-doing'),
      item(10, 'Someday', 'backlog'),
    ],
    readyOrder: [4, 5, 6],
  };
};

describe('canvas work lanes (W-48)', () => {
  let server: WebServer, browser: Browser, page: Page, origin: string, workspace: string;
  const lanesOf = (target: Page) =>
    target.$$eval('#workView [data-lane]', (lanes) =>
      lanes.map((l) => [
        (l as HTMLElement).dataset.lane,
        [...l.querySelectorAll<HTMLElement>('.work-card')].map((c) => Number(c.dataset.number)),
      ])
    );
  const ready = async () => Object.fromEntries((await lanesOf(page)) as [string, number[]][])['ready-for-work'] ?? [];
  const stored = () => JSON.parse(readFileSync(workPath(workspace), 'utf8'));

  beforeAll(async () => {
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-w48-work');
    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasEnabled: true, canvasShellEnabled: false }));
    mkdirSync(resolve(resolveCasesDir(), 'Worknotes'), { recursive: true });
    workspace = workspaceForCase('Worknotes').id;
    const stores = new CanvasStores();
    const note = CommandSchema.parse({
      kind: 'create',
      opId: 'create-n1',
      objectId: 'n1',
      patch: {
        parentId: null,
        order: 0,
        position: { x: 0, y: 0 },
        size: { width: 180, height: 90 },
        content: { type: 'text', text: 'Plan' },
      },
    });
    expect(stores.get(workspace).append([note], person as never).ok).toBe(true);
    stores.flush();
    mkdirSync(dirname(workPath(workspace)), { recursive: true });
    writeFileSync(workPath(workspace), JSON.stringify(legacy()));
    server = new WebServer(0, false, true, undefined, undefined, undefined, '/x');
    await server.start();
    origin = `http://localhost:${server.boundPort}`;
    browser = await chromium.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: ['--no-sandbox'],
    });
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    page = await desktop.newPage();
    await page.goto(`${origin}/x/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-object-id="n1"]');
    await page.waitForSelector('.work-count[data-status="ready-for-work"]');
    mkdirSync(MEDIA, { recursive: true });
  }, 60000);
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    vi.unstubAllEnvs();
  }, 60000);

  it('migrates Todo by assignee and shows seven lanes in board order, all on a 1440px screen', async () => {
    // The outline: Human required first, then In progress; Ready for work counts the items nobody has.
    expect(await page.locator('.work-active .work-key').allTextContents()).toEqual(['W-1', 'W-7']);
    expect(await page.locator('.work-count[data-status="ready-for-work"]').getAttribute('aria-label')).toBe(
      'Ready for work: 3, 3 unassigned'
    );
    await page.locator('#board').focus();
    await page.keyboard.press('Shift+W');
    await page.waitForSelector('#workView:not([hidden]) .work-card');
    expect(await lanesOf(page)).toEqual([
      ['backlog', [10]],
      ['needs-refinement', [3, 2]],
      ['human-required', [1]],
      ['ready-for-work', [4, 5, 6]],
      ['in-progress', [7]],
      ['done', [8]],
      ['not-doing', [9]],
    ]);
    expect(await page.$$eval('.work-closed [data-lane]', (l) => l.map((n) => (n as HTMLElement).dataset.lane))).toEqual(
      ['done', 'not-doing']
    );
    const fit = await page.locator('.work-lanes').evaluate((el) => ({
      scroll: el.scrollWidth,
      client: el.clientWidth,
      heads: [...el.querySelectorAll('.work-lane-head')].map((h) => h.getBoundingClientRect().right),
    }));
    expect(fit.scroll).toBeLessThanOrEqual(fit.client + 1);
    for (const right of fit.heads) expect(right).toBeLessThanOrEqual(1440);
    expect(await page.locator('[data-lane="ready-for-work"] .work-rank').allTextContents()).toEqual(['1', '2', '3']);
    expect(await page.locator('[data-lane="ready-for-work"] .work-flag').textContent()).toBe('3 unassigned');
    // A read never writes: the file still holds the old form.
    expect(stored().items[0]).toMatchObject({ status: 'todo' });
    await page.screenshot({ path: resolve(MEDIA, `w48-${stamp}-desktop-lanes.png`) });
  });

  it('reorders Ready for work with Shift+Up and with a drag, and stores the order', async () => {
    await page.locator('.work-card[data-number="6"]').focus();
    await page.keyboard.press('Shift+ArrowUp');
    await expect.poll(ready).toEqual([4, 6, 5]);
    expect(stored().readyOrder).toEqual([4, 6, 5]);
    await expect
      .poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.number))
      .toBe('6');

    // The change's own announcement reloads the list 150 ms later; let that repaint land before the drag starts.
    await page.waitForTimeout(500);
    const from = (await page.locator('.work-card[data-number="4"]').boundingBox())!;
    const last = (await page.locator('.work-card[data-number="5"]').boundingBox())!;
    await page.mouse.move(from.x + 40, from.y + 10);
    await page.mouse.down();
    await page.mouse.move(from.x + 40, from.y + 30, { steps: 4 });
    await page.mouse.move(last.x + 40, last.y + last.height - 4, { steps: 8 });
    await page.mouse.up();
    await expect.poll(ready).toEqual([6, 5, 4]);
    expect(stored().readyOrder).toEqual([6, 5, 4]);
    // The whole file was written in the form the previous release reads.
    expect(stored().items.map((i: { status: string }) => i.status)).toEqual([
      'todo',
      'todo',
      'todo',
      'todo',
      'todo',
      'todo',
      'in-progress',
      'done',
      'not-doing',
      'backlog',
    ]);
    expect(stored().items[0].todoStatus).toBe('human-required');
  });

  it('shows the position in the detail with Move up and Move down', async () => {
    await page.locator('.work-card[data-number="5"]').focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('#workDetail [data-work-detail="up"]');
    expect(await page.locator('#workDetail .work-place-n').textContent()).toBe('2 of 3, top is picked up first');
    await page.locator('#workDetail [data-work-detail="up"]').click();
    await expect.poll(ready).toEqual([5, 6, 4]);
    await expect.poll(() => page.locator('#workDetail [data-work-detail="up"]').isDisabled()).toBe(true);
    await page.keyboard.press('Escape');
  });

  it('opens a new conversation with an unsent draft from Ask an agent (W-43)', async () => {
    const posts: string[] = [];
    const onRequest = (r: { method(): string; url(): string }) => {
      if (r.method() === 'POST' && /\/(conversations|tasks)\b/.test(r.url())) posts.push(r.url());
    };
    page.on('request', onRequest);
    await page.locator('#assistantDraft').evaluate((el) => ((el as HTMLTextAreaElement).value = 'older draft'));
    await page.locator('.work-card[data-number="5"]').focus();
    await page.keyboard.press('Enter');
    await page.locator('#workDetail [data-work-detail="ask"]').click();
    await page.waitForSelector('#assistantView:not([hidden])');
    const draft =
      'Work on W-5: Ready B. Read it with canvas_work (action read, key W-5), assign it to yourself and follow its acceptance checks.';
    expect(await page.locator('#assistantDraft').inputValue()).toBe(draft);
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('assistantDraft');
    expect(await page.locator('#conversationPicker').inputValue()).toBe('');
    expect(await page.locator('#workView').isVisible()).toBe(true);
    const rail = (await page.locator('#rail').boundingBox())!;
    const room = await page.locator('.work-lanes').evaluate((el) => parseFloat(getComputedStyle(el).paddingRight));
    expect(room).toBeGreaterThanOrEqual(rail.width);
    await page.waitForTimeout(500);
    expect(posts).toEqual([]);
    page.off('request', onRequest);
    await page.screenshot({ path: resolve(MEDIA, `w43-${stamp}-ask-agent.png`) });
    await page.locator('#assistantDraft').fill('');
  });

  it('puts every lane one tap away behind wrapping tabs on a phone', async () => {
    const phone = await browser.newContext({
      viewport: { width: 375, height: 812 },
      deviceScaleFactor: 1,
      hasTouch: true,
      isMobile: true,
    });
    await phone.addInitScript(() => {
      (window as unknown as { __canvasTouch: boolean }).__canvasTouch = true;
    });
    const mobile = await phone.newPage();
    await mobile.goto(`${origin}/x/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
    await mobile.waitForSelector('[data-object-id="n1"]');
    await mobile.locator('#sectionsTool').click();
    await mobile.locator('.work-count[data-status="human-required"]').click();
    await mobile.waitForSelector('#workView:not([hidden]) .work-lane.on .work-card');
    const tabs = await mobile.$$eval('.work-tabs [data-lane-tab]', (list) =>
      list.map((b) => {
        const box = b.getBoundingClientRect();
        return { lane: (b as HTMLElement).dataset.laneTab, right: box.right, height: box.height };
      })
    );
    expect(tabs.map((t) => t.lane)).toEqual([
      'backlog',
      'needs-refinement',
      'human-required',
      'ready-for-work',
      'in-progress',
      'done',
      'not-doing',
    ]);
    for (const tab of tabs) {
      expect(tab.right).toBeLessThanOrEqual(375);
      expect(tab.height).toBeGreaterThanOrEqual(44);
    }
    expect(await mobile.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    const shown = () =>
      mobile.$$eval('#workView .work-lane', (l) =>
        l.filter((n) => (n as HTMLElement).offsetParent).map((n) => (n as HTMLElement).dataset.lane)
      );
    expect(await shown()).toEqual(['human-required']);
    await mobile.locator('[data-lane-tab="not-doing"]').click();
    expect(await shown()).toEqual(['not-doing']);
    await mobile.locator('[data-lane-tab="ready-for-work"]').click();
    expect(await shown()).toEqual(['ready-for-work']);
    await mobile.screenshot({ path: resolve(MEDIA, `w48-${stamp}-phone-ready.png`) });
    await phone.close();
  });
});
