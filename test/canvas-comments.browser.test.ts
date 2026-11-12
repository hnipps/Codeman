import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import puppeteer from 'puppeteer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebServer } from '../src/web/server.js';
import { dataPath } from '../src/config/instance.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';
import { CanvasStores } from '../src/canvas/canvas-store.js';
import { CommandSchema, type Command } from '../src/canvas/operations.js';
import type { Author } from '../src/canvas/model.js';

const MEDIA = resolve('pr/media');
const stamp = Date.now();
const shot = (page: Page, slug: string) =>
  page.screenshot({ animations: 'disabled', path: resolve(MEDIA, `pc6-review-${stamp}-${slug}.png`) });
const human: Author = { kind: 'human', userId: 'admin' };
const agent: Author = { kind: 'agent', sessionId: 'design7f3a-session' };
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
      order: x + y,
      position: { x, y },
      size: { width: w, height: h },
      content: type === 'text' ? { type, text } : { type, label: text },
    },
  });
const edit = (id: string, text: string, opId: string): Command =>
  CommandSchema.parse({ kind: 'update', opId, objectId: id, patch: { content: { type: 'text', text } } });
const comment = (objectId: string, id: string, text: string): Command =>
  CommandSchema.parse({ kind: 'comment', opId: `op-${id}`, objectId, patch: { id, text } });

describe('canvas comments and author history', () => {
  let server: WebServer, browser: Browser, page: Page, origin: string, workspace: string;
  const internals = () =>
    server as unknown as {
      getCanvasStores: () => Promise<CanvasStores>;
      broadcast: (event: string, data: unknown) => void;
    };
  async function agentWrite(commands: Command[]) {
    const store = (await internals().getCanvasStores()).get(workspace);
    const result = store.append(commands, agent);
    expect(result.ok).toBe(true);
    internals().broadcast('canvas:changed', { workspaceId: workspace, seq: store.seq });
  }
  beforeAll(async () => {
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-pc6-comments');
    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasEnabled: true }));
    mkdirSync(resolve(resolveCasesDir(), 'Fieldnotes'), { recursive: true });
    workspace = workspaceForCase('Fieldnotes').id;
    const stores = new CanvasStores();
    const store = stores.get(workspace);
    const steps: [Command[], Author][] = [
      [
        [
          item('research', null, 'section', 0, 0, 900, 520, 'Design exploration'),
          item('reading', 'research', 'frame', 24, 56, 420, 420, 'Reading patterns'),
          item('brief', 'reading', 'text', 24, 32, 360, 120, 'Keep the reason you wanted to return.'),
          item('notes', 'reading', 'text', 24, 200, 360, 120, 'Capture first, then choose what deserves a place.'),
          item('caption', 'research', 'text', 480, 88, 380, 80, 'A place for what stays with you.'),
        ],
        human,
      ],
      [
        [
          item('sketches', null, 'frame', 960, 0, 420, 520, 'Agent sketches'),
          ...[1, 2, 3, 4, 5].map((n) =>
            item(`s${n}`, 'sketches', 'text', 24, 24 + (n - 1) * 92, 372, 72, `Sketch ${n}: a quieter shelf layout`)
          ),
          edit('notes', 'Agent rewrite: capture everything automatically.', 'agent-notes'),
          edit('brief', 'Agent rewrite of the brief.', 'agent-brief'),
          comment('brief', 'c-agent', 'I drafted five shelf sketches to the right. <b>Not bold</b>'),
        ],
        agent,
      ],
      [
        [
          edit('brief', 'Keep the reason you wanted to return, in your words.', 'human-brief'),
          comment('brief', 'c-human', 'Thanks. Keep the brief in my words.'),
          ...Array.from({ length: 14 }, (_, i) => comment('caption', `c-long-${i}`, `Reading note ${i + 1}`)),
        ],
        human,
      ],
    ];
    for (const [commands, author] of steps) expect(store.append(commands, author).ok).toBe(true);
    stores.flush();
    server = new WebServer(0, false, true, undefined, undefined, undefined, '/x');
    await server.start();
    origin = `http://localhost:${server.boundPort}`;
    browser = await chromium.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: ['--no-sandbox'],
    });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await page.addInitScript(() => {
      if (!localStorage.getItem('codeman:skin')) localStorage.setItem('codeman:skin', 'og');
    });
    mkdirSync(MEDIA, { recursive: true });
    await page.goto(`${origin}/x/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-object-id="brief"]');
  }, 60000);
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    vi.unstubAllEnvs();
  }, 60000);

  it('marks only objects that have comments, quietly', async () => {
    await page.waitForSelector('[data-object-id="brief"] > .comment-mark');
    expect(await page.locator('[data-object-id="brief"] > .comment-mark').textContent()).toBe('2');
    expect(await page.locator('[data-object-id="caption"] > .comment-mark').textContent()).toBe('14');
    expect(await page.locator('[data-object-id="notes"] > .comment-mark').count()).toBe(0);
    expect(await page.locator('[data-object-id="brief"]').getAttribute('aria-label')).toContain('2 comments');
    await shot(page, 'comment-count');
  });

  it('opens a thread in the rail with authors, inert text and an agent mark', async () => {
    await page.locator('[data-object-id="brief"]').click({ position: { x: 20, y: 60 } });
    await page.locator('#chatTool').click();
    await page.waitForSelector('#threadView:not([hidden])');
    expect(await page.locator('#railTitle').textContent()).toBe('Comments');
    const rows = page.locator('#threadList .comment');
    expect(await rows.count()).toBe(2);
    expect(await rows.nth(0).locator('.author-name').textContent()).toBe('Agent design7f');
    expect(await rows.nth(0).locator('.agent-mark').count()).toBe(1);
    expect(await rows.nth(0).locator('.comment-text').textContent()).toContain('<b>Not bold</b>');
    expect(await page.locator('#threadList b').count()).toBe(0);
    expect(await rows.nth(1).locator('.author-name').textContent()).toBe('admin');
    expect(await rows.nth(1).locator('.agent-mark').count()).toBe(0);
    const time = rows.nth(1).locator('.comment-time');
    expect(await time.textContent()).toBe('just now');
    await time.click();
    expect(await time.textContent()).not.toBe('just now');
    await time.click();
    expect(await page.evaluate(() => document.activeElement?.id)).not.toBe('board');
    await shot(page, 'thread');
  });

  it('posts with Ctrl+Enter, keeps a failed draft with Retry, and never duplicates on retry', async () => {
    await page.locator('#commentDraft').focus();
    await page.keyboard.type('Move the sketches next to the brief.');
    let calls = 0;
    await page.route('**/api/canvas/*/command', async (route) => {
      calls++;
      if (calls === 1) {
        // The server stores the comment, then the answer is lost: Retry must not post it twice.
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        return route.fulfill({ status: 502, body: 'lost' });
      }
      return route.continue();
    });
    await page.keyboard.press('Control+Enter');
    await page.waitForSelector('#retryComment:not([hidden])');
    expect(await page.locator('#commentDraft').inputValue()).toBe('Move the sketches next to the brief.');
    expect(await page.locator('#commentStatus').textContent()).toContain('Not posted');
    await shot(page, 'failed-post');
    await page.locator('#retryComment').click();
    await page.waitForFunction(() => document.querySelectorAll('#threadList .comment').length === 3);
    await page.unroute('**/api/canvas/*/command');
    expect(await page.locator('#commentDraft').inputValue()).toBe('');
    const posted = await page.evaluate(() =>
      window.canvasComments.read().filter((c) => c.text === 'Move the sketches next to the brief.')
    );
    expect(posted).toHaveLength(1);
  });

  it('Escape leaves the composer, then the rail, and restores focus', async () => {
    await page.locator('#commentDraft').focus();
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('threadView');
    expect(await page.locator('#rail').isHidden()).toBe(false);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#rail', { state: 'hidden' });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('chatTool');
  });

  it('shows the designed empty thread', async () => {
    await page.locator('[data-object-id="notes"]').click({ position: { x: 20, y: 40 } });
    await page.locator('#chatTool').click();
    await page.waitForSelector('#threadEmpty:not([hidden])');
    expect(await page.locator('#threadList').isHidden()).toBe(true);
    await shot(page, 'empty-thread');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  });

  it('appends an arriving agent comment without moving camera, focus, selection or scroll', async () => {
    await page.locator('[data-object-id="caption"]').click({ position: { x: 20, y: 30 } });
    await page.locator('#chatTool').click();
    await page.waitForSelector('#threadList .comment');
    await page.locator('#threadList').evaluate((el) => (el.scrollTop = 0));
    const before = await page.evaluate(() => ({
      view: window.canvasView.read(),
      active: document.activeElement?.id,
      scroll: document.getElementById('threadList')!.scrollTop,
    }));
    await agentWrite([comment('caption', 'c-live', 'Arrived while you were reading.')]);
    await page.waitForFunction(() => document.querySelectorAll('#threadList .comment').length === 15);
    const after = await page.evaluate(() => ({
      view: window.canvasView.read(),
      active: document.activeElement?.id,
      scroll: document.getElementById('threadList')!.scrollTop,
    }));
    expect(after.view.viewport).toEqual(before.view.viewport);
    expect(after.view.selected).toEqual(before.view.selected);
    expect(after.view.focusId).toEqual(before.view.focusId);
    expect(after.active).toBe(before.active);
    expect(after.scroll).toBe(0);
    expect(await page.locator('[data-object-id="caption"] > .comment-mark').textContent()).toBe('15');
    await page.keyboard.press('Escape');
  });

  it('lists authors, confirms a session revert inline, and reports what was skipped', async () => {
    await page.locator('#outlineHistory').click();
    await page.waitForSelector('#historyList .history-row');
    const rows = page.locator('#historyList .history-row');
    expect(await rows.count()).toBe(2);
    const agentRow = rows.filter({ has: page.locator('.agent-mark') });
    expect(await agentRow.locator('.history-meta').textContent()).toMatch(/operations · last active/);
    expect(
      await rows
        .filter({ hasNot: page.locator('.agent-mark') })
        .locator('.history-revert')
        .count()
    ).toBe(0);
    await shot(page, 'history');
    await agentRow.locator('.history-revert').click();
    await page.waitForSelector('.revert-confirm .primary[aria-disabled="false"]');
    const sentence = await page.locator('.revert-confirm p').textContent();
    expect(sentence).toContain('removes 6 objects');
    expect(sentence).toContain('Later edits by others stay: 1 change');
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Revert');
    await shot(page, 'revert-confirm');
    await page.locator('.revert-confirm .primary').click();
    await page.waitForSelector('.history-result');
    expect(await page.locator('.history-result').textContent()).toMatch(
      /Reverted: removed 6 objects.*Skipped 1 change/
    );
    await page.waitForFunction(() => !document.querySelector('[data-object-id="s1"]'));
    for (const id of ['sketches', 's1', 's5']) expect(await page.locator(`[data-object-id="${id}"]`).count()).toBe(0);
    expect(await page.locator('[data-object-id="notes"] .object-body').textContent()).toBe(
      'Capture first, then choose what deserves a place.'
    );
    expect(await page.locator('[data-object-id="brief"] .object-body').textContent()).toBe(
      'Keep the reason you wanted to return, in your words.'
    );
    await shot(page, 'revert-result');
  });
});
