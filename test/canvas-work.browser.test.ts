/**
 * Work lanes in the browser after W-48: seven lanes in board order (Done and Not doing share the last column on a
 * desktop), a `work.json` from before the split migrated on read, Ready for work in pickup order with Shift+Up/Down
 * and a drag reordering it, the outline's Human required first, Ask an agent's unsent draft in a new conversation
 * (W-43), attachments in the detail from the Attach button and a drop (W-60), the phone's wrapping lane tabs, and
 * Delete with Undo, Show deleted and Restore on a desktop and a phone (W-22).
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

  it('answers a Needs-you question in the detail, with or without an asker, and keeps the text on a conflict (W-52)', async () => {
    const file = stored();
    const asked = (number: number, title: string, extra: Record<string, unknown>) => ({
      number,
      title,
      status: 'todo',
      todoStatus: 'human-required',
      description: number === 11 ? 'Ship the thing.' : '',
      assignee: null,
      sessions: [],
      author: person,
      createdAt: stamp,
      updatedAt: stamp,
      revision: 1,
      history: [],
      ...extra,
    });
    file.items.push(
      asked(11, 'Asked by a routine', { needs: { question: 'Which port?', at: stamp }, createdFrom: 7 }),
      asked(12, 'Asked by a session', { needs: { question: 'Keep the flag?', sessionId: 'sess-gone', at: stamp } })
    );
    file.next = 13;
    writeFileSync(workPath(workspace), JSON.stringify(file));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-object-id="n1"]');
    await page.locator('#board').focus();
    await page.keyboard.press('Shift+W');
    await page.waitForSelector('#workView:not([hidden]) .work-card[data-number="12"]');
    const box = page.locator('#workDetail [aria-label="Needs you"]');
    const text = page.locator('#workDetail [data-work-detail="answer-text"]');
    const send = page.locator('#workDetail [data-work-detail="answer-send"]');
    const item = (number: number) => stored().items.find((i: { number: number }) => i.number === number);

    await page.locator('.work-card[data-number="12"]').focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('#workDetail [data-work-detail="answer-text"]');
    expect(await box.locator('.work-box-why').textContent()).toBe('Asked by sess-gon.');
    expect(await page.locator('#workDetail [data-work-detail="answer"]').textContent()).toBe('Open conversation');
    expect(await page.getByLabel('Your answer').count()).toBe(1);
    expect(await send.isDisabled()).toBe(true);
    await text.fill('   ');
    expect(await send.isDisabled()).toBe(true);
    await text.fill('Yes, keep it');
    // Another writer saves first: the answer is refused, and the typed text survives the reload.
    const raced = stored();
    raced.items.find((i: { number: number }) => i.number === 12).revision = 2;
    writeFileSync(workPath(workspace), JSON.stringify(raced));
    await text.evaluate((node) => ((node as HTMLElement).dataset.before = 'conflict'));
    await send.click();
    await expect.poll(() => page.locator('#announcement').textContent()).toMatch(/Showing the latest\.$/);
    await page.waitForSelector('#workDetail [data-work-detail="answer-text"]:not([data-before])');
    expect(await text.inputValue()).toBe('Yes, keep it');
    expect(item(12).needs).toMatchObject({ question: 'Keep the flag?' });
    await send.click();
    await expect.poll(() => item(12).needs).toBeUndefined();
    expect(item(12)).toMatchObject({ todoStatus: 'needs-refinement', revision: 3 });
    expect(item(12).description).toMatch(/^\d{4}-\d{2}-\d{2} Q \(Keep the flag\?\): Yes, keep it$/);
    await expect.poll(() => box.count()).toBe(0);
    await page.keyboard.press('Escape');

    await page.locator('.work-card[data-number="11"]').focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('#workDetail [data-work-detail="answer-text"]');
    expect(await box.locator('.work-box-why').textContent()).toBe('Asked by an agent. From W-7.');
    expect(await page.locator('#workDetail [data-work-detail="answer"]').count()).toBe(0);
    await text.fill('3000');
    await page.screenshot({ path: resolve(MEDIA, `w52-${stamp}-answer-needs.png`) });
    await send.click();
    await expect.poll(() => item(11).needs).toBeUndefined();
    expect(item(11)).toMatchObject({ todoStatus: 'needs-refinement', revision: 2 });
    expect(item(11).description).toMatch(/^Ship the thing\.\n\n\d{4}-\d{2}-\d{2} Q \(Which port\?\): 3000$/);
    await page.keyboard.press('Escape');
  });

  it('attaches files from the button and by a drop, shows a thumbnail, opens one and removes one (W-60)', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    const files = () =>
      (stored().items.find((i: { number: number }) => i.number === 7).attachments ?? []) as {
        id: string;
        name: string;
      }[];
    await page.locator('.work-card[data-number="7"]').focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('#workDetail [data-work-detail="attach"]');
    expect(await page.locator('#workDetail .work-file').count()).toBe(0);

    await page.locator('#workFile').setInputFiles([
      { name: 'shot.png', mimeType: 'image/png', buffer: png },
      { name: 'evil.html', mimeType: 'text/html', buffer: Buffer.from('<script>1</script>') },
    ]);
    await expect.poll(() => files().map((f) => f.name)).toEqual(['shot.png']);
    await expect.poll(() => page.locator('#workDetail .work-file').count()).toBe(1);
    const thumb = page.locator('#workDetail .work-file img.work-file-thumb');
    await expect.poll(() => thumb.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(1);
    expect(await page.locator('#workDetail .work-file-size').textContent()).toBe(`${png.length} B`);

    await page.locator('#workDetail').evaluate((detail) => {
      const data = new DataTransfer();
      data.items.add(new File(['line one\n'], 'notes.txt', { type: 'text/plain' }));
      detail.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
      detail.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    await expect.poll(() => files().map((f) => f.name)).toEqual(['shot.png', 'notes.txt']);
    await expect.poll(() => page.locator('#workDetail .work-file').count()).toBe(2);
    expect(await page.locator('#workDetail .work-file-ext').textContent()).toBe('TXT');
    expect(await page.locator('#workDetail #workFilesTitle').textContent()).toBe('Attachments · 2');
    await page.screenshot({ path: resolve(MEDIA, `w60-${stamp}-attachments.png`) });

    const text = files()[1]!;
    const href = await page.locator(`#workDetail [data-work-detail="file-${text.id}"]`).getAttribute('href');
    const served = await page.request.get(`${origin}${href}`);
    expect(served.status()).toBe(200);
    expect(served.headers()['content-type']).toMatch(/^text\/plain/);
    expect(await served.text()).toBe('line one\n');

    await page.locator(`#workDetail [data-work-detail="file-remove-${text.id}"]`).click();
    await expect.poll(() => files().map((f) => f.name)).toEqual(['shot.png']);
    await expect.poll(() => page.locator('#workDetail .work-file').count()).toBe(1);
    expect((await page.request.get(`${origin}${href}`)).status()).toBe(404);

    const shot = files()[0]!;
    await page.locator(`#workDetail [data-work-detail="file-remove-${shot.id}"]`).click();
    await expect.poll(() => files()).toEqual([]);
    await page.keyboard.press('Escape');
  });

  it('attaches the board selection by reference, selects it from the detail, and reads a deleted one as missing (W-59)', async () => {
    const item = () => stored().items.find((i: { number: number }) => i.number === 7);
    const openDetail = async () => {
      await page.locator('#board').focus();
      await page.keyboard.press('Shift+W');
      await page.waitForSelector('#workView:not([hidden]) .work-card[data-number="7"]');
      await page.locator('.work-card[data-number="7"]').focus();
      await page.keyboard.press('Enter');
      await page.waitForSelector('#workDetail [data-work-detail="attach-objects"]');
    };
    const closeAll = async () => {
      await page.keyboard.press('Escape');
      if (await page.locator('#workView').isVisible()) {
        await page.locator('#board').focus();
        await page.keyboard.press('Shift+W');
      }
      await page.waitForSelector('#workView', { state: 'hidden' });
    };
    const command = (tool: string, operations: unknown[]) =>
      page.request.post(`${origin}/x/api/canvas/${workspace}/command`, { data: { tool, arguments: { operations } } });
    const made = await command('canvas_create', [
      {
        kind: 'create',
        opId: 'w59-create',
        objectId: 'w59',
        patch: {
          parentId: null,
          order: 1,
          position: { x: 260, y: 0 },
          size: { width: 180, height: 90 },
          content: { type: 'text', text: 'Spec' },
        },
      },
    ]);
    expect(made.status(), await made.text()).toBe(200);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-object-id="w59"]');
    await openDetail();
    expect(await page.locator('#workDetail .work-sec', { hasText: 'Canvas objects' }).textContent()).toContain(
      'No objects attached'
    );
    // Nothing selected: the press says so and writes nothing.
    await page.locator('#workDetail [data-work-detail="attach-objects"]').click();
    await expect.poll(() => page.locator('#announcement').textContent()).toBe('Select objects on the board first');
    expect(item().attachments).toBeUndefined();
    await closeAll();

    await page.locator('[data-object-id="w59"]').click();
    await expect.poll(() => page.locator('[data-object-id="w59"].selected').count()).toBe(1);
    await openDetail();
    await page.locator('#workDetail [data-work-detail="attach-objects"]').click();
    await expect.poll(() => item().attachments).toMatchObject([{ kind: 'object', id: 'w59' }]);
    const open = page.locator('#workDetail [data-work-detail="object-w59"]');
    await expect.poll(() => open.textContent()).toBe('Spec');
    await page.screenshot({ path: resolve(MEDIA, `w59-${stamp}-object-attached.png`) });

    // Clear the selection, then the link selects the object on the board again and closes the lanes over it.
    await closeAll();
    await page.locator('#board').focus();
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('[data-object-id="w59"].selected').count()).toBe(0);
    await openDetail();
    await open.click();
    await expect.poll(() => page.locator('[data-object-id="w59"].selected').count()).toBe(1);
    expect(await page.locator('#workView').isHidden()).toBe(true);

    const deleted = await page.request.post(`${origin}/x/api/canvas/${workspace}/command`, {
      data: {
        tool: 'canvas_delete',
        arguments: { operations: [{ kind: 'delete', opId: 'w59-del', objectId: 'w59' }] },
      },
    });
    expect(deleted.status(), await deleted.text()).toBe(200);
    await page.waitForSelector('[data-object-id="w59"]', { state: 'detached' });
    await openDetail();
    const row = page.locator('#workDetail [data-work-detail="object-w59"]');
    await expect.poll(() => row.textContent()).toBe('Deleted from the canvas');
    expect(await row.evaluate((n) => n.tagName)).toBe('SPAN');
    await page.screenshot({ path: resolve(MEDIA, `w59-${stamp}-object-deleted.png`) });
    await page.locator('#workDetail [data-work-detail="detach-w59"]').click();
    await expect.poll(() => item().attachments).toBeUndefined();
    await closeAll();
  });

  const openLanes = async (target: Page) => {
    await target.locator('#board').focus();
    await target.keyboard.press('Shift+W');
    await target.waitForSelector('#workView:not([hidden]) .work-card');
  };
  const itemOf = (number: number) => stored().items.find((i: { number: number }) => i.number === number);
  /** A person's delete through the route, as another tab would send it. */
  const deleteByApi = async (key: string, reason?: string) => {
    const number = Number(key.slice(2));
    const answer = await page.request.patch(`${origin}/x/api/canvas/${workspace}/work/${key}`, {
      data: { status: 'deleted', ...(reason ? { reason } : {}), expectedRevision: itemOf(number).revision },
    });
    expect(answer.status(), await answer.text()).toBe(200);
  };

  it('deletes from the detail at 1440px, moves the keyboard on, and Undo puts it back (W-22)', async () => {
    const toggle = page.locator('.work-show-deleted');
    await openLanes(page);
    expect(await toggle.isHidden()).toBe(true);
    await page.locator('.work-card[data-number="10"]').focus();
    await page.keyboard.press('Enter');
    const remove = page.locator('#workDetail [data-work-detail="delete"]');
    await remove.waitFor();
    // The last control of the detail, below History.
    expect(await remove.evaluate((b) => b.closest('.work-sec')?.querySelector('h3')?.textContent)).toBe('History');
    await remove.focus();
    await page.keyboard.press('Enter');

    await expect
      .poll(() => itemOf(10))
      .toMatchObject({
        status: 'not-doing',
        deleted: { from: 'backlog', author: { kind: 'human' } },
      });
    await expect.poll(() => page.locator('#workDetail').isHidden()).toBe(true);
    expect(await page.locator('[data-lane="backlog"] .work-card').count()).toBe(0);
    expect(await page.locator('[data-lane="deleted"]').count()).toBe(0);
    // Backlog is empty now, so its "+ Add item" takes the keyboard.
    await expect
      .poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.workAdd))
      .toBe('backlog');
    await expect.poll(() => page.locator('.work-toast').textContent()).toBe('W-10 deletedUndo');
    expect(await page.locator('#announcement').textContent()).toBe('W-10 deleted');
    await expect.poll(() => toggle.textContent()).toBe('Show deleted (1)');
    expect(await toggle.getAttribute('aria-pressed')).toBe('false');
    await page.screenshot({ path: resolve(MEDIA, `w22-${stamp}-deleted-notice.png`) });

    await page.locator('.work-undo').click();
    await expect.poll(() => itemOf(10).status).toBe('backlog');
    expect(itemOf(10).deleted).toBeUndefined();
    expect(itemOf(10).history.map((e: { text: string }) => e.text)).toContain('Moved from Deleted to Backlog');
    await expect.poll(async () => (await lanesOf(page)).find(([lane]) => lane === 'backlog')?.[1]).toEqual([10]);
    await expect.poll(() => toggle.isHidden()).toBe(true);
    expect(await page.locator('#workDetail').isHidden()).toBe(true);
  });

  it('shows deleted items on request, reads who and why, restores one, and repaints a delete made elsewhere (W-22)', async () => {
    const order = await ready();
    const first = order[0]!;
    await deleteByApi(`W-${first}`, 'Filed twice, see W-4');
    const toggle = page.locator('.work-show-deleted');
    await expect.poll(() => toggle.textContent()).toBe('Show deleted (1)');
    expect(await ready()).toEqual(order.slice(1));
    await toggle.click();
    expect(await toggle.getAttribute('aria-pressed')).toBe('true');
    expect(await page.$$eval('.work-closed [data-lane]', (l) => l.map((n) => (n as HTMLElement).dataset.lane))).toEqual(
      ['done', 'not-doing', 'deleted']
    );
    const card = page.locator(`[data-lane="deleted"] .work-card[data-number="${first}"]`);
    expect(await card.getAttribute('class')).toContain('deleted');
    expect(await card.locator('.work-card-when').textContent()).toMatch(/^Deleted \S/);
    await page.screenshot({ path: resolve(MEDIA, `w22-${stamp}-show-deleted.png`) });

    await card.focus();
    await page.keyboard.press('Enter');
    const restore = page.locator('#workDetail [data-work-detail="restore"]');
    await restore.waitFor();
    const banner = page.locator('#workDetail [aria-label="Deleted"]');
    expect(await banner.locator('.work-box-head').textContent()).toMatch(/^Deleted by you on \S/);
    expect(await banner.locator('.work-box-why').textContent()).toBe('Filed twice, see W-4');
    expect(await restore.textContent()).toBe('Restore to Ready for work');
    expect(await page.locator('#workDetail [data-work-detail="status"]').inputValue()).toBe('deleted');
    expect(await page.locator('#workDetail [data-work-detail="delete"]').count()).toBe(0);
    // Restore is the first control after the title.
    await page.locator('#workDetail [data-work-detail="title"]').focus();
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.workDetail)).toBe(
      'restore'
    );
    await page.screenshot({ path: resolve(MEDIA, `w22-${stamp}-deleted-detail.png`) });

    await page.keyboard.press('Enter');
    // Invariant I8: UndoIsAnOrdinaryMove. Restored to Ready for work, it goes to the bottom.
    await expect.poll(() => itemOf(first)).toMatchObject({ status: 'todo', todoStatus: 'ready-for-work' });
    expect(itemOf(first).deleted).toBeUndefined();
    await expect.poll(ready).toEqual([...order.slice(1), first]);
    expect(await page.locator('#workDetail').isVisible()).toBe(true);
    await expect.poll(() => restore.count()).toBe(0);
    await expect.poll(() => toggle.isHidden()).toBe(true);
    expect(await page.locator('[data-lane="deleted"]').count()).toBe(0);

    // Deleted by someone else while it is open here: the detail turns into the banner and stays open.
    await page.locator('#workDetail [data-work-detail="status"]').focus();
    await deleteByApi(`W-${first}`);
    await restore.waitFor();
    expect(await page.locator('#workDetail').isVisible()).toBe(true);
    expect(await banner.locator('.work-box-why').count()).toBe(0);
    await restore.click();
    await expect.poll(() => itemOf(first).deleted).toBeUndefined();
    await page.keyboard.press('Escape');
    await page.waitForSelector('#workDetail', { state: 'hidden' });
    await page.locator('#board').focus();
    await page.keyboard.press('Shift+W');
    await page.waitForSelector('#workView', { state: 'hidden' });
  });

  it('shows deleted items behind a tab and restores one on a 390px phone (W-22)', async () => {
    await deleteByApi('W-9', 'Out of date');
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
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
    await mobile.locator('.work-count[data-status="done"]').click();
    await mobile.waitForSelector('#workView:not([hidden]) .work-lane.on .work-card');
    const toggle = mobile.locator('.work-show-deleted');
    expect(await toggle.textContent()).toBe('Show deleted (1)');
    expect(await mobile.locator('[data-lane-tab="deleted"]').isHidden()).toBe(true);
    await toggle.click();
    const tab = mobile.locator('[data-lane-tab="deleted"]');
    expect(await tab.isVisible()).toBe(true);
    expect(await tab.getAttribute('aria-pressed')).toBe('true');
    const shown = () =>
      mobile.$$eval('#workView .work-lane', (l) =>
        l.filter((n) => (n as HTMLElement).offsetParent).map((n) => (n as HTMLElement).dataset.lane)
      );
    expect(await shown()).toEqual(['deleted']);
    for (const box of [await toggle.boundingBox(), await tab.boundingBox()]) {
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    }
    expect(await mobile.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await mobile.screenshot({ path: resolve(MEDIA, `w22-${stamp}-phone-deleted.png`) });

    await mobile.locator('[data-lane="deleted"] .work-card[data-number="9"]').click();
    const restore = mobile.locator('#workDetail [data-work-detail="restore"]');
    await restore.waitFor();
    expect(await mobile.locator('#workDetail .work-box-why').textContent()).toBe('Out of date');
    expect(await restore.textContent()).toBe('Restore to Not doing');
    expect((await restore.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await mobile.screenshot({ path: resolve(MEDIA, `w22-${stamp}-phone-detail.png`) });
    await restore.click();
    await expect.poll(() => itemOf(9)).toMatchObject({ status: 'not-doing' });
    expect(itemOf(9).deleted).toBeUndefined();
    const remove = mobile.locator('#workDetail [data-work-detail="delete"]');
    await remove.scrollIntoViewIfNeeded();
    expect((await remove.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await phone.close();
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
    const tabs = await mobile.$$eval('.work-tabs [data-lane-tab]:not([hidden])', (list) =>
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
