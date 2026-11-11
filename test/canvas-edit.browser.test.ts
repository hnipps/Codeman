import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import puppeteer from 'puppeteer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebServer } from '../src/web/server.js';
import { dataPath } from '../src/config/instance.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';
import { SnapshotSchema } from '../packages/canvas/src/model.js';
import { selectionBox } from '../packages/canvas/src/arrange.js';
import { CommandSchema } from '../src/canvas/operations.js';

const stamp = Date.now();
const media = resolve('pr/media');
const create = (id: string, type: 'text' | 'frame', x: number, y: number, parentId: string | null = null) =>
  CommandSchema.parse({
    kind: 'create',
    opId: `seed-${id}`,
    objectId: id,
    patch: {
      parentId,
      order: x + y,
      position: { x, y },
      size: type === 'frame' ? { width: 360, height: 300 } : { width: 240, height: 140 },
      content:
        type === 'text'
          ? { type, text: id === 'note' ? 'Keep the reason you wanted to return.' : 'A quiet place for references.' }
          : { type, label: 'Design exploration' },
    },
  });
describe('desktop canvas editing', () => {
  let server: WebServer,
    browser: Browser,
    page: Page,
    origin: string,
    workspace: string,
    serial = 0;
  beforeAll(async () => {
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-pc4-edit');
    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasEnabled: true }));
    server = new WebServer(0, false, true, undefined, undefined, undefined, '/x');
    await server.start();
    origin = `http://localhost:${server.boundPort}`;
    browser = await chromium.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: ['--no-sandbox'],
    });
    mkdirSync(media, { recursive: true });
  }, 60000);
  beforeEach(async () => {
    const name = `Canvas editing ${++serial}`;
    mkdirSync(resolve(resolveCasesDir(), name), { recursive: true });
    workspace = workspaceForCase(name).id;
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await page.request.post(`${origin}/x/api/canvas/${workspace}/ops`, {
      data: {
        operations: [
          create('frame', 'frame', 500, 100),
          create('note', 'text', 100, 100),
          create('other', 'text', 100, 320),
          create('child', 'text', 24, 56, 'frame'),
        ],
      },
    });
    await open();
  });
  afterEach(async () => {
    await page?.context().setOffline(false);
    await page?.unrouteAll({ behavior: 'wait' });
    await page?.close();
  });
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    vi.unstubAllEnvs();
  }, 60000);
  async function open() {
    await page.goto(`${origin}/x/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-object-id="note"]');
    await page.waitForFunction(() => window.canvasEdit?.read().status === 'saved');
    await page.evaluate(() => window.canvasView.dispatch({ kind: 'viewport', viewport: { x: 200, y: 80, zoom: 1 } }));
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await page.waitForTimeout(50);
  }
  async function stored(includeDeleted = false) {
    const response = await page.request.get(
      `${origin}/x/api/canvas/${workspace}/objects${includeDeleted ? '?includeDeleted=true' : ''}`
    );
    const data: unknown = await response.json();
    if (typeof data !== 'object' || data === null || !('data' in data)) throw new Error('Missing objects');
    return SnapshotSchema.parse(data.data).objects;
  }
  async function saved() {
    await page.waitForFunction(() => window.canvasEdit.read().status === 'saved' && !window.canvasEdit.read().pending);
  }
  async function objectCenter(id: string) {
    const box = await page.locator(`[data-object-id="${id}"]`).boundingBox();
    if (!box) throw new Error('Missing object');
    return { x: box.x + Math.min(box.width / 2, 100), y: box.y + Math.min(box.height / 2, 100) };
  }
  async function select(id: string) {
    const heading = page.locator(`[data-object-id="${id}"] > .object-title:not([hidden])`);
    if (await heading.count()) {
      await heading.click();
      return;
    }
    const p = await objectCenter(id);
    await page.mouse.click(p.x, p.y);
  }
  async function reader(id = 'note') {
    await page.locator(`[data-row-id="${id}"]`).click();
    await page.locator('#board').focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('#textEdit:not([hidden])');
  }
  async function closeReader() {
    if (await page.locator('#rail').isVisible()) {
      await page.locator('#closeRail').click();
      await page.waitForSelector('#rail', { state: 'hidden' });
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
  }
  async function drag(id: string, dx: number, dy: number) {
    await page.keyboard.down('Control');
    const p = await objectCenter(id);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x + dx, p.y + dy, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up('Control');
    await saved();
  }
  async function shot(theme: string, slug: string) {
    await page.screenshot({ path: resolve(media, `pc4-review-${stamp}-${theme}-${slug}.png`), animations: 'disabled' });
  }
  it('keeps selection chrome outside content at every zoom and shows eight handles for the combined selection', async () => {
    const before = await stored();
    expect(await page.locator('.selection-bounds:visible').count()).toBe(0);
    for (const zoom of [0.5, 1, 2]) {
      await page.evaluate((zoom) => {
        window.canvasView.dispatch({ kind: 'viewport', viewport: { x: 200, y: 80, zoom } });
        window.canvasView.dispatch({ kind: 'selection', ids: ['note'] });
      }, zoom);
      await page.evaluate(() => new Promise(requestAnimationFrame));
      const object = page.locator('[data-object-id="note"]');
      const boundary = object.locator(':scope > .selection-bounds');
      const box = await object.boundingBox(),
        outline = await boundary.boundingBox();
      if (!box || !outline) throw new Error('Missing selection bounds');
      expect(outline.x).toBeCloseTo(box.x - 6, 1);
      expect(outline.y).toBeCloseTo(box.y - 6, 1);
      expect(outline.width).toBeCloseTo(box.width + 12, 1);
      expect(outline.height).toBeCloseTo(box.height + 12, 1);
      expect(await page.locator('.resize-handle:visible').count()).toBe(8);
      const handle = await object.locator('.handle-nw').boundingBox();
      if (!handle) throw new Error('Missing handle');
      expect(handle.width).toBeCloseTo(16);
      expect(handle.x + 8).toBeCloseTo(box.x - 6, 1);
      expect(handle.y + 8).toBeCloseTo(box.y - 6, 1);
      await page.locator('#board').focus();
      await page.evaluate(() => window.canvasView.dispatch({ kind: 'focus', id: 'note' }));
      await page.keyboard.press('x');
      await page.keyboard.press('x');
      await page.waitForSelector('[data-object-id="note"].keyboard-focus');
      const focus = await boundary.evaluate((el) => ({
        offset: getComputedStyle(el).outlineOffset,
        width: getComputedStyle(el).outlineWidth,
      }));
      expect(parseFloat(focus.offset)).toBeCloseTo(3, 1);
      expect(parseFloat(focus.width)).toBeCloseTo(2, 1);
      await page.evaluate(() => window.canvasView.dispatch({ kind: 'selection', ids: ['note', 'other'] }));
      await page.evaluate(() => new Promise(requestAnimationFrame));
      expect(await page.locator('.resize-handle:visible').count()).toBe(8);
      expect(await page.locator('.object.selected > .selection-bounds > .corner:visible').count()).toBe(8);
      const combined = await page.locator('#selectionBounds').boundingBox();
      const other = await page.locator('[data-object-id="other"]').boundingBox();
      if (!combined || !other) throw new Error('Missing combined bounds');
      expect(combined.x).toBeCloseTo(box.x - 6, 1);
      expect(combined.y).toBeCloseTo(box.y - 6, 1);
      expect(combined.width).toBeCloseTo(box.width + 12, 1);
      expect(combined.height).toBeCloseTo(other.y + other.height - box.y + 12, 1);
    }
    const combinedBefore = await page.locator('#selectionBounds').boundingBox();
    await page.locator('#board').focus();
    await page.keyboard.press('m');
    await page.keyboard.press('ArrowRight');
    const combinedMoving = await page.locator('#selectionBounds').boundingBox();
    if (!combinedBefore || !combinedMoving) throw new Error('Missing moving selection');
    expect(combinedMoving.x - combinedBefore.x).toBeCloseTo(20);
    await page.keyboard.press('Escape');
    expect(await page.locator('#selectionBounds').boundingBox()).toEqual(combinedBefore);
    expect(await stored()).toEqual(before);
  });
  it('anchors selection actions and Add to the dock and exposes available history with icons', async () => {
    expect(await page.locator('#undoEdit').getAttribute('aria-disabled')).toBe('true');
    expect(await page.locator('#redoEdit').getAttribute('aria-disabled')).toBe('true');
    await page.locator('#undoEdit').focus();
    await page.keyboard.press('Enter');
    expect(await page.locator('#announcement').textContent()).toBe('Nothing to undo.');
    expect(await page.locator('#dock > #undoEdit svg').count()).toBe(1);
    expect(await page.locator('#dock > #redoEdit svg').count()).toBe(1);
    await select('note');
    expect(await page.locator('#contextRow #undoEdit, #contextRow #redoEdit').count()).toBe(0);
    for (const ids of [['note'], ['note', 'other']]) {
      await page.evaluate((ids) => window.canvasView.dispatch({ kind: 'selection', ids }), ids);
      await page.evaluate(() => new Promise(requestAnimationFrame));
      const row = await page.locator('#contextRow').boundingBox(),
        dock = await page.locator('#dock').boundingBox();
      if (!row || !dock) throw new Error('Missing toolbar');
      expect(dock.y - row.y - row.height).toBeCloseTo(8);
      expect(row.x + row.width / 2).toBeCloseTo(dock.x + dock.width / 2);
      expect(await page.locator('#editSelection').isVisible()).toBe(ids.length === 1);
    }
    await page.locator('#addTool').click();
    const menu = await page.locator('#addMenu').boundingBox(),
      add = await page.locator('#addTool').boundingBox(),
      dock = await page.locator('#dock').boundingBox();
    if (!menu || !add || !dock) throw new Error('Missing Add menu');
    expect(menu.x + menu.width / 2).toBeCloseTo(add.x + add.width / 2);
    expect(dock.y - menu.y - menu.height).toBeCloseTo(8);
    expect(await page.locator('#addTool').getAttribute('aria-pressed')).toBe('true');
    await page.keyboard.press('ArrowDown');
    expect(await page.locator('#addFrame').evaluate((el) => el === document.activeElement)).toBe(true);
    await page.keyboard.press('ArrowUp');
    expect(await page.locator('#addText').evaluate((el) => el === document.activeElement)).toBe(true);
    await page.keyboard.press('Escape');
    expect(await page.locator('#addMenu').isVisible()).toBe(false);
    expect(await page.locator('#addTool').getAttribute('aria-pressed')).toBe('false');
    expect(await page.locator('#addTool').evaluate((el) => el === document.activeElement)).toBe(true);
    await drag('note', 20, 10);
    expect(await page.locator('#undoEdit').getAttribute('aria-disabled')).toBe('false');
    const moved = (await stored()).find((o) => o.id === 'note')?.position;
    await page.locator('#undoEdit').click();
    await saved();
    expect((await stored()).find((o) => o.id === 'note')?.position).toEqual({ x: 100, y: 100 });
    expect(await page.locator('#redoEdit').getAttribute('aria-disabled')).toBe('false');
    await page.locator('#redoEdit').click();
    await saved();
    expect((await stored()).find((o) => o.id === 'note')?.position).toEqual(moved);
  });
  it('creates every Add kind and saves plain text as a human author', async () => {
    for (const [control, type] of [
      ['addText', 'text'],
      ['addFrame', 'frame'],
      ['addSection', 'section'],
      ['addSubcanvas', 'subcanvas'],
    ]) {
      const before = new Set((await stored()).map((o) => o.id));
      await page.locator('#addTool').click();
      await page.locator(`#${control}`).click();
      await saved();
      const object = (await stored()).find((o) => !before.has(o.id));
      expect(object?.type).toBe(type);
      expect(object?.author.kind).toBe('human');
      expect(await page.locator('#textEditor').getAttribute('aria-label')).toBe(type === 'text' ? 'Text' : 'Name');
      await page
        .locator('#textEditor')
        .fill(type === 'text' ? '<img onerror="alert(1)"> A useful excerpt.' : `Named ${type}`);
      await page.locator('#textEditor').blur();
      await saved();
      expect((await stored()).find((o) => o.id === object?.id)?.content[type === 'text' ? 'text' : 'label']).toContain(
        type === 'text' ? '<img' : 'Named'
      );
      expect(await page.locator('#layer img').count()).toBe(0);
      await closeReader();
    }
  });
  it('keeps ordinary drag parents, reparents on a named header, moves a container once and returns to root explicitly', async () => {
    await drag('note', 450, 40);
    expect((await stored()).find((o) => o.id === 'note')?.parentId).toBeNull();
    await page.locator('#board').focus();
    await page.keyboard.press('Control+z');
    await saved();
    const p = await objectCenter('note'),
      header = await page.locator('[data-object-id="frame"] > .object-title').boundingBox();
    if (!header) throw new Error('Missing header');
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(header.x + 40, header.y + 12, { steps: 10 });
    await page.waitForSelector('#dropName:not([hidden])');
    expect(await page.locator('#dropName').textContent()).toContain('Design exploration');
    await page.mouse.up();
    await saved();
    expect((await stored()).find((o) => o.id === 'note')?.parentId).toBe('frame');
    const childPosition = (await stored()).find((o) => o.id === 'note')?.position;
    await page.locator('[data-object-id="frame"] > .object-title').click();
    const bounds = await page.locator('[data-object-id="frame"] > .object-title').boundingBox();
    if (!bounds) throw new Error('Missing heading');
    const frameBefore = (await stored()).find((o) => o.id === 'frame')?.position;
    await page.mouse.move(bounds.x + 30, bounds.y + 12);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 70, bounds.y + 42, { steps: 8 });
    await page.mouse.up();
    await saved();
    expect((await stored()).find((o) => o.id === 'frame')?.position).toEqual({
      x: (frameBefore?.x ?? 0) + 40,
      y: (frameBefore?.y ?? 0) + 30,
    });
    expect((await stored()).find((o) => o.id === 'note')?.position).toEqual(childPosition);
    await page.locator('#search').fill('Keep the reason');
    await page.locator('#tree button:visible').click();
    await page.locator('#search').fill('');
    await page.locator('#moveTo').click();
    await page.locator('#moveDestination').selectOption('');
    await page.locator('#commitMoveTo').click();
    await saved();
    expect((await stored()).find((o) => o.id === 'note')?.parentId).toBeNull();
    const log = await (await page.request.get(`${origin}/x/api/canvas/${workspace}/ops?since=0`)).json();
    expect(
      log.data.operations.filter(
        (o: { kind: string; objectId: string }) => o.kind === 'reparent' && o.objectId === 'note'
      )
    ).toHaveLength(2);
  });
  it('resizes at 50% and 200%, keeps child geometry, and undoes/redo soft delete through restore', async () => {
    for (const zoom of [0.5, 2]) {
      await page.evaluate(
        (zoom) =>
          window.canvasView.dispatch({
            kind: 'viewport',
            viewport: { x: 220 - 500 * zoom, y: 100 - 100 * zoom, zoom },
          }),
        zoom
      );
      await page.locator('[data-object-id="frame"] > .object-title').click();
      const before = (await stored()).find((o) => o.id === 'frame'),
        child = (await stored()).find((o) => o.id === 'child');
      const handle = page.locator('[data-object-id="frame"] > .handle-se');
      await handle.waitFor({ state: 'visible' });
      const box = await handle.boundingBox();
      if (!box) throw new Error('Missing resize handle');
      expect(box.width).toBeCloseTo(16);
      await page.mouse.move(box.x + 8, box.y + 8);
      await page.mouse.down();
      await page.mouse.move(box.x + 8 + 40 * zoom, box.y + 8 + 20 * zoom, { steps: 8 });
      await page.mouse.up();
      await saved();
      expect((await stored()).find((o) => o.id === 'frame')?.size).toEqual({
        width: (before?.size?.width ?? 0) + 40,
        height: (before?.size?.height ?? 0) + 20,
      });
      expect((await stored()).find((o) => o.id === 'child')?.position).toEqual(child?.position);
      expect((await stored()).find((o) => o.id === 'child')?.size).toEqual(child?.size);
      await page.locator('#board').focus();
      await page.keyboard.press('Control+z');
      await saved();
      expect((await stored()).find((o) => o.id === 'frame')?.size).toEqual(before?.size);
    }
    const beforeAgentResize = (await stored()).find((o) => o.id === 'frame')?.size;
    expect(
      await page.evaluate(() =>
        window.canvasEdit.resize({
          objectId: 'frame',
          handle: 'e',
          delta: { x: 40, y: 0 },
          proportional: false,
          fromCenter: false,
        })
      )
    ).toBe(true);
    await saved();
    expect((await stored()).find((o) => o.id === 'frame')?.size?.width).toBe((beforeAgentResize?.width ?? 0) + 40);
    await page.evaluate(() => window.canvasEdit.undo());
    await saved();
    expect((await stored()).find((o) => o.id === 'frame')?.size).toEqual(beforeAgentResize);
    await page.locator('#board').focus();
    await page.keyboard.press('Delete');
    await saved();
    expect((await stored()).some((o) => o.id === 'frame')).toBe(false);
    await page.keyboard.press('Control+z');
    await saved();
    expect((await stored()).some((o) => o.id === 'frame')).toBe(true);
    await page.keyboard.press('Control+Shift+z');
    await saved();
    expect((await stored()).some((o) => o.id === 'frame')).toBe(false);
    const log = await (await page.request.get(`${origin}/x/api/canvas/${workspace}/ops?since=0`)).json();
    expect(log.data.operations.some((o: { kind: string }) => o.kind === 'restore')).toBe(true);
  });
  it('cancels marquee/lasso and move mode without writes, supports scoped select all, and edits numeric geometry', async () => {
    const before = await stored();
    await page.locator('#board').focus();
    await page.mouse.move(270, 140);
    await page.mouse.down();
    await page.mouse.move(580, 500, { steps: 8 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    expect(await page.evaluate(() => window.canvasView.read().selected)).toEqual([]);
    await page.keyboard.down('Alt');
    await page.mouse.move(270, 140);
    await page.mouse.down();
    for (const p of [
      { x: 570, y: 140 },
      { x: 570, y: 550 },
      { x: 270, y: 550 },
      { x: 270, y: 140 },
    ])
      await page.mouse.move(p.x, p.y, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up('Alt');
    expect((await page.evaluate(() => window.canvasView.read().selected)).sort()).toEqual(['note', 'other']);
    await page.locator('#board').focus();
    await page.keyboard.press('m');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Escape');
    expect(await stored()).toEqual(before);
    await select('child');
    await page.keyboard.press('Control+a');
    expect(await page.evaluate(() => window.canvasView.read().selected)).toEqual(['child']);
    await reader();
    await page.locator('#positionX').fill('144');
    await page.locator('#positionX').press('Tab');
    await saved();
    expect((await stored()).find((o) => o.id === 'note')?.position.x).toBe(144);
    const selection = await page.evaluate(() => window.canvasView.read().selected);
    await page.locator('#textEditor').focus();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Draft with native keys');
    await page.keyboard.press('Control+z');
    expect(await page.evaluate(() => window.canvasView.read().selected)).toEqual(selection);
  });
  it('preserves a draft when another tab edits the field and resolves explicitly without reload', async () => {
    await reader();
    await page.locator('#textEditor').fill('My preserved draft');
    const second = await browser.newPage();
    try {
      await second.goto(`${origin}/x/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
      await second.waitForSelector('[data-object-id="note"]');
      const response = await second.request.post(`${origin}/x/api/canvas/${workspace}/ops`, {
        data: {
          operations: [
            {
              kind: 'update',
              opId: 'other-tab-text',
              objectId: 'note',
              patch: { content: { type: 'text', text: 'Another tab changed this field' } },
            },
          ],
        },
      });
      expect(response.ok()).toBe(true);
      await page.waitForFunction(() => document.getElementById('editStatus')?.dataset.state === 'conflict');
      const author = (await stored()).find((o) => o.id === 'note')?.author;
      if (!author) throw new Error('Missing fixture author');
      const writer = author.kind === 'human' ? author.userId : `Agent ${author.sessionId}`;
      expect(await page.locator('#editStatus').textContent()).toBe(
        `${writer} changed this text while you were editing. Your draft is kept.`
      );
      expect(await page.locator('#keepDraft').textContent()).toBe('Keep my draft');
      expect(await page.locator('#useServer').textContent()).toBe('Use saved text');
      expect(await page.locator('#textEditor').inputValue()).toBe('My preserved draft');
      await page.locator('#keepDraft').click();
      await saved();
      expect((await stored()).find((o) => o.id === 'note')?.content.text).toBe('My preserved draft');
      await second.waitForFunction(
        () => document.querySelector('[data-object-id="note"] .object-body')?.textContent === 'My preserved draft'
      );
      await page.locator('#textEditor').fill('Discard this local wording');
      await second.request.post(`${origin}/x/api/canvas/${workspace}/ops`, {
        data: {
          operations: [
            {
              kind: 'update',
              opId: 'other-tab-text-two',
              objectId: 'note',
              patch: { content: { type: 'text', text: 'Keep the server wording' } },
            },
          ],
        },
      });
      await page.waitForFunction(() => document.getElementById('editStatus')?.dataset.state === 'conflict');
      await page.locator('#useServer').click();
      await saved();
      expect(await page.locator('#textEditor').inputValue()).toBe('Keep the server wording');
      expect((await stored()).find((o) => o.id === 'note')?.content.text).toBe('Keep the server wording');
    } finally {
      await second.close();
    }
  });
  it('recovers a lost acknowledgement after SSE advances and reload resends the original ID once', async () => {
    await reader();
    await page.route('**/api/canvas/*/ops', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      await route.fetch();
      await route.abort();
    });
    await page.locator('#textEditor').fill('Acknowledged only by history.');
    await page.locator('#textEditor').blur();
    await page.waitForFunction(() => window.canvasEdit.read().status === 'failed');
    expect((await stored()).find((o) => o.id === 'note')?.content.text).toBe('Acknowledged only by history.');
    const pending = await page.evaluate(
      () =>
        JSON.parse(
          localStorage.getItem(`codeman:canvas:user:%40single:${location.pathname.split('/').at(-1)}:edits`) ?? '{}'
        ).operations[0].opId
    );
    expect(typeof pending).toBe('string');
    await page.unrouteAll({ behavior: 'wait' });
    await open();
    await saved();
    await reader();
    expect(await page.locator('#textEditor').inputValue()).toBe('Acknowledged only by history.');
    expect(await page.locator('#conflictActions').isVisible()).toBe(false);
    const log = await (await page.request.get(`${origin}/x/api/canvas/${workspace}/ops?since=0`)).json();
    expect(log.data.operations.filter((op: { opId: string }) => op.opId === pending)).toHaveLength(1);
    expect(
      await page.evaluate(() =>
        localStorage.getItem(`codeman:canvas:user:%40single:${location.pathname.split('/').at(-1)}:edits`)
      )
    ).toBeNull();
  });
  it('normalizes line-mode wheel zoom and keeps shortcuts after the focused object disappears', async () => {
    const before = await page.evaluate(() => window.canvasView.read().viewport);
    await page.locator('#board').dispatchEvent('wheel', { deltaY: -3, deltaMode: 1, clientX: 600, clientY: 400 });
    await page.waitForTimeout(30);
    expect(await page.evaluate(() => window.canvasView.read().viewport.zoom)).toBeGreaterThan(before.zoom * 1.05);
    await page.locator('#board').focus();
    await page.keyboard.press('ArrowDown');
    const id = await page.evaluate(() => window.canvasView.read().focusId);
    await page.request.post(`${origin}/x/api/canvas/${workspace}/ops`, {
      data: { operations: [{ kind: 'delete', opId: 'external-delete-focus', objectId: id }] },
    });
    await page.waitForFunction(() => document.activeElement?.id === 'board');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => window.canvasView.read().focusId)).not.toBe(id);
  });
  it('captures the interaction states in both themes and retains an offline pending draft', async () => {
    for (const theme of ['dark', 'light']) {
      await page.request.post(`${origin}/x/api/canvas/${workspace}/ops`, {
        data: {
          operations: [
            {
              kind: 'revert',
              opId: `reset-note-${theme}`,
              objectId: 'note',
              patch: {
                position: { x: 100, y: 100 },
                order: 200,
                content: { type: 'text', text: 'Keep the reason you wanted to return.' },
              },
            },
            { kind: 'move', opId: `reset-frame-${theme}`, objectId: 'frame', patch: { position: { x: 500, y: 100 } } },
            {
              kind: 'update',
              opId: `reset-size-${theme}`,
              objectId: 'frame',
              patch: { size: { width: 360, height: 300 } },
            },
          ],
        },
      });
      await open();
      await page.evaluate((theme) => {
        localStorage.setItem('codeman:skin', theme === 'light' ? 'paper-gray' : 'og');
        window.dispatchEvent(new Event('storage'));
      }, theme);
      await page.locator('#addTool').click();
      await shot(theme, 'add-menu');
      await page.keyboard.press('Escape');
      await reader();
      const contrast = await page.locator('#positionX').evaluate((el) => {
        const css = getComputedStyle(el);
        const luminance = (color: string) => {
          const channels = (color.match(/[\d.]+/g) ?? [])
            .slice(0, 3)
            .map(Number)
            .map((v) => {
              const c = v / 255;
              return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
            });
          return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        };
        const a = luminance(css.color),
          b = luminance(css.backgroundColor);
        return {
          ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
          color: css.color,
          primary: css.getPropertyValue('--text').trim(),
        };
      });
      expect(contrast.ratio).toBeGreaterThanOrEqual(4.5);
      let release: (() => void) | undefined;
      await page.route('**/api/canvas/*/ops', async (route) => {
        if (route.request().method() !== 'POST') {
          await route.continue();
          return;
        }
        await new Promise<void>((resolve) => {
          release = resolve;
          setTimeout(resolve, 3000);
        });
        await route.continue();
      });
      await page.locator('#textEditor').fill(`A useful excerpt in ${theme}.`);
      await page.locator('#textEditor').blur();
      await page.waitForFunction(() => document.getElementById('editStatus')?.textContent === 'Saving…');
      await shot(theme, 'saving');
      release?.();
      await saved();
      await page.unrouteAll({ behavior: 'wait' });
      await shot(theme, 'saved');
      await page.route('**/api/canvas/*/ops', async (route) => {
        if (route.request().method() === 'POST')
          await route.fulfill({
            status: 409,
            json: {
              success: false,
              error: 'Canvas operation rejected',
              reasons: [{ code: 'LOCKED', message: 'Explicitly unlock the protected object first' }],
            },
          });
        else await route.continue();
      });
      const beforeRefusal = (await stored()).find((o) => o.id === 'note')?.content.text;
      await page.locator('#textEditor').fill('A failed save keeps this draft.');
      await page.locator('#textEditor').blur();
      await page.waitForFunction(() => window.canvasEdit.read().status === 'refused');
      expect(await page.locator('#editStatus').textContent()).toBe(
        `"A useful excerpt in ${theme}." is locked. Unlock it to edit it.`
      );
      expect((await stored()).find((o) => o.id === 'note')?.content.text).toBe(beforeRefusal);
      expect(await page.locator('#textEditor').inputValue()).toBe('A failed save keeps this draft.');
      await shot(theme, 'failed-save');
      await page.unrouteAll({ behavior: 'wait' });
      await page.locator('#retryEdit').click();
      await saved();
      await page.locator('#textEditor').fill('My local wording stays here.');
      await page.request.post(`${origin}/x/api/canvas/${workspace}/ops`, {
        data: {
          operations: [
            {
              kind: 'update',
              opId: `conflict-${theme}`,
              objectId: 'note',
              patch: { content: { type: 'text', text: 'A different wording from another tab.' } },
            },
          ],
        },
      });
      await page.waitForFunction(() => document.getElementById('editStatus')?.dataset.state === 'conflict');
      await shot(theme, 'conflict');
      await page.locator('#keepDraft').click();
      await saved();
      await closeReader();
      await page.mouse.move(270, 140);
      await page.mouse.down();
      await page.mouse.move(570, 550, { steps: 10 });
      await page.waitForFunction(() => !document.querySelector('#layer .keyboard-focus'));
      const previewOutlines = await page
        .locator('.selection-preview')
        .evaluateAll((objects) => objects.map((object) => getComputedStyle(object).outlineStyle));
      expect(previewOutlines).toEqual(['none', 'none']);
      await shot(theme, 'marquee');
      await page.mouse.up();
      expect((await page.evaluate(() => window.canvasView.read().selected)).sort()).toEqual(['note', 'other']);
      await shot(theme, 'multi-selection');
      await page.keyboard.down('Alt');
      const loop = Array.from({ length: 33 }, (_, i) => {
        const angle = (i * Math.PI) / 16;
        return {
          x: 420 + (174 + 8 * Math.sin(angle * 3)) * Math.cos(angle),
          y: 345 + (224 + 7 * Math.cos(angle * 2)) * Math.sin(angle),
        };
      });
      await page.mouse.move(loop[0].x, loop[0].y);
      await page.mouse.down();
      for (const p of loop.slice(1)) await page.mouse.move(p.x, p.y, { steps: 2 });
      await shot(theme, 'lasso');
      await page.mouse.up();
      await page.keyboard.up('Alt');
      await page.evaluate(() =>
        window.canvasView.dispatch({ kind: 'viewport', viewport: { x: -780, y: -40, zoom: 2 } })
      );
      await page.locator('[data-object-id="frame"] > .object-title').click();
      await page.locator('[data-object-id="frame"] > .handle-se').waitFor({ state: 'visible' });
      const handle = await page.locator('[data-object-id="frame"] > .handle-se').boundingBox();
      if (!handle) throw new Error('No handle');
      await page.mouse.move(handle.x + 8, handle.y + 8);
      await page.mouse.down();
      await page.mouse.move(handle.x + 56, handle.y + 32, { steps: 6 });
      await shot(theme, 'resize-200');
      await page.mouse.up();
      await saved();
      await page.evaluate(() => window.canvasView.dispatch({ kind: 'viewport', viewport: { x: 200, y: 80, zoom: 1 } }));
      await page.evaluate(() => new Promise(requestAnimationFrame));
      const p = await objectCenter('note'),
        title = await page.locator('[data-object-id="frame"] > .object-title').boundingBox();
      if (!title) throw new Error('No destination heading');
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      await page.mouse.move(title.x + 40, title.y + 12, { steps: 10 });
      await page.waitForSelector('#dropName:not([hidden])');
      await shot(theme, 'drop-target');
      await page.mouse.up();
      await saved();
      await page.locator('#moveTo').click();
      await shot(theme, 'move-to');
      await page.locator('#moveDestination').selectOption('');
      await page.locator('#commitMoveTo').click();
      await saved();
      await reader();
      await page.route('**/api/canvas/*/ops', async (route) => {
        if (route.request().method() === 'POST') await route.abort();
        else await route.continue();
      });
      await page.locator('#textEditor').fill('Offline draft retained.');
      await page.locator('#textEditor').blur();
      await page.waitForFunction(() => window.canvasEdit.read().status === 'failed');
      await page.context().setOffline(true);
      await page.waitForSelector('#notice:not([hidden])');
      expect(await page.locator('#textEditor').inputValue()).toBe('Offline draft retained.');
      expect(await page.locator('#addTool').isDisabled()).toBe(true);
      const pending = await page.evaluate(() =>
        localStorage.getItem(`codeman:canvas:user:%40single:${location.pathname.split('/').at(-1)}:edits`)
      );
      expect(pending).toContain('Offline draft retained.');
      expect(
        await page.evaluate(
          (theme) =>
            window.canvasEdit.apply([
              { kind: 'move', opId: `offline-new-${theme}`, objectId: 'note', patch: { position: { x: 1, y: 1 } } },
            ]),
          theme
        )
      ).toBe(false);
      await shot(theme, 'offline-draft');
      await page.unrouteAll({ behavior: 'wait' });
      await page.context().setOffline(false);
      await page.waitForFunction(() => window.canvasEdit.read().status === 'saved');
      expect((await stored()).find((o) => o.id === 'note')?.content.text).toBe('Offline draft retained.');
      const history = await (await page.request.get(`${origin}/x/api/canvas/${workspace}/ops?since=0`)).json();
      for (const edit of JSON.parse(pending ?? '{}').operations)
        expect(history.data.operations.filter((op: { opId: string }) => op.opId === edit.opId)).toHaveLength(1);
      expect(history.data.operations.some((op: { opId: string }) => op.opId === `offline-new-${theme}`)).toBe(false);

      await closeReader();
    }
  }, 120000);
  const layoutCases = [
    ...(['x', 'y'] as const).flatMap((axis) =>
      (['start', 'center', 'end'] as const).map((anchor) => ({
        name: `align-${axis}-${anchor}`,
        selector: `[data-align="${axis}-${anchor}"]`,
        tool: 'canvas_arrange',
        arguments: { action: 'align', targetIds: ['note', 'other', 'third'], axis, anchor },
      }))
    ),
    ...(['x', 'y'] as const).map((axis) => ({
      name: `distribute-${axis}`,
      selector: `[data-distribute="${axis}"]`,
      tool: 'canvas_arrange',
      arguments: { action: 'distribute', targetIds: ['note', 'other', 'third'], axis },
    })),
    ...(['front', 'back', 'forward', 'backward'] as const).map((placement) => ({
      name: `order-${placement}`,
      selector: `[data-order="${placement}"]`,
      tool: 'canvas_arrange',
      arguments: { action: 'order', targetIds: ['note', 'other', 'third'], placement },
    })),
    {
      name: 'equal-spacing-x',
      selector: null,
      tool: 'canvas_arrange',
      arguments: { action: 'distribute', targetIds: ['note', 'other', 'third'], axis: 'x', spacing: 32 },
    },
  ];
  async function invoke(tool: string, args: unknown, targetWorkspace = workspace) {
    const response = await page.request.post(`${origin}/x/api/canvas/${targetWorkspace}/command`, {
      data: { tool, arguments: args },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  }
  async function twin() {
    const name = `Canvas twin ${serial}-${crypto.randomUUID()}`;
    mkdirSync(resolve(resolveCasesDir(), name), { recursive: true });
    const id = workspaceForCase(name).id;
    const response = await page.request.post(`${origin}/x/api/canvas/${id}/ops`, {
      data: {
        operations: [
          create('frame', 'frame', 500, 100),
          create('note', 'text', 100, 100),
          create('other', 'text', 100, 320),
          create('child', 'text', 24, 56, 'frame'),
        ],
      },
    });
    expect(response.ok()).toBe(true);
    return id;
  }
  async function storedAt(id: string) {
    const response = await page.request.get(`${origin}/x/api/canvas/${id}/objects`);
    return SnapshotSchema.parse((await response.json()).data).objects;
  }
  function material(objects: ReturnType<typeof SnapshotSchema.parse>['objects']) {
    const path = (object: (typeof objects)[number], seen = new Set<string>()): string => {
      if (seen.has(object.id)) throw new Error('Unexpected cycle');
      seen.add(object.id);
      const parent = objects.find((p) => p.id === object.parentId);
      return `${parent ? path(parent, seen) : ''}/${JSON.stringify(object.content)}`;
    };
    return objects
      .map((o) => ({
        path: path(o),
        position: { x: Math.round(o.position.x * 1e6) / 1e6, y: Math.round(o.position.y * 1e6) / 1e6 },
        size: o.size,
        rotation: o.rotation,
        order: o.order,
        lock: o.lock ?? null,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  async function selectMany(ids: string[]) {
    await select(ids[0]);
    for (const id of ids.slice(1)) {
      await page.keyboard.down('Shift');
      await select(id);
      await page.keyboard.up('Shift');
    }
    await page.locator('#board').focus();
    await page.waitForFunction((count) => window.canvasView.read().selected.length === count, ids.length);
  }
  it.each(layoutCases)('matches endpoint geometry and order for $name', async (action) => {
    const mirror = await twin();
    for (const id of [workspace, mirror])
      await page.request.post(`${origin}/x/api/canvas/${id}/ops`, {
        data: { operations: [create('third', 'text', 420, 530)] },
      });
    await open();
    await selectMany(['note', 'other', 'third']);
    const requests: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST') requests.push(r.url());
    });
    if (action.selector) {
      await page.locator('#arrangeSelection').click();
      await page.locator(action.selector).click();
    } else
      // Explicit spacing is a command-endpoint capability without a pointer control.
      await page.evaluate(
        (args) => window.canvasEdit.command({ tool: 'canvas_arrange', arguments: args }),
        action.arguments as never
      );
    await saved();
    await invoke(action.tool, action.arguments, mirror);
    expect(material(await stored())).toEqual(material(await storedAt(mirror)));
    expect(requests.some((url) => url.endsWith('/command'))).toBe(true);
    expect(requests.some((url) => url.endsWith('/ops'))).toBe(false);
  });
  it('groups, renames, nests, ungroups and wraps with equivalent endpoint state and stable child identities', async () => {
    const mirror = await twin();
    await selectMany(['note', 'other']);
    await page.keyboard.press('Control+g');
    await saved();
    await invoke(
      'canvas_arrange',
      {
        action: 'group',
        targetIds: ['note', 'other'],
        groupId: 'mirror-group',
        parentId: null,
        label: 'Untitled group',
      },
      mirror
    );
    expect(material(await stored())).toEqual(material(await storedAt(mirror)));
    const group = (await stored()).find((o) => o.type === 'group');
    if (!group) throw new Error('Missing group');
    await page.locator('#editSelection').click();
    await page.locator('#textEditor').fill('References');
    await page.locator('#textEditor').blur();
    await saved();
    await invoke(
      'canvas_update',
      {
        operations: [
          {
            kind: 'update',
            objectId: 'mirror-group',
            opId: 'rename',
            patch: { content: { type: 'group', label: 'References' } },
          },
        ],
      },
      mirror
    );
    expect(material(await stored())).toEqual(material(await storedAt(mirror)));
    await closeReader();
    await page.locator('#board').focus();
    await page.keyboard.press('Control+g');
    await saved();
    await invoke(
      'canvas_arrange',
      {
        action: 'group',
        targetIds: ['mirror-group'],
        groupId: 'mirror-outer',
        parentId: null,
        label: 'Untitled group',
      },
      mirror
    );
    expect(material(await stored())).toEqual(material(await storedAt(mirror)));
    await page.locator('#board').focus();
    await page.keyboard.press('Control+Shift+g');
    await saved();
    await invoke('canvas_arrange', { action: 'ungroup', targetIds: ['mirror-outer'] }, mirror);
    expect(material(await stored())).toEqual(material(await storedAt(mirror)));
    await page.locator('#board').focus();
    await page.keyboard.press('Control+Shift+g');
    await saved();
    await invoke('canvas_arrange', { action: 'ungroup', targetIds: ['mirror-group'] }, mirror);
    expect(material(await stored())).toEqual(material(await storedAt(mirror)));
    expect((await stored()).filter((o) => ['note', 'other'].includes(o.id)).map((o) => o.position)).toEqual([
      { x: 100, y: 100 },
      { x: 100, y: 320 },
    ]);
    for (const type of ['frame', 'section']) {
      await selectMany(['note', 'other']);
      await page.locator('#arrangeSelection').click();
      await page.locator(type === 'frame' ? '#wrapFrame' : '#wrapSection').click();
      await saved();
      await invoke(
        'canvas_arrange',
        {
          action: 'group',
          targetIds: ['note', 'other'],
          groupId: `wrap-${type}`,
          parentId: type === 'frame' ? null : 'wrap-frame',
          label: `Untitled ${type}`,
          containerType: type,
        },
        mirror
      );
      expect(material(await stored())).toEqual(material(await storedAt(mirror)));
    }
  });
  it('locks explicitly, refuses protected moves and content, unlocks, and supports background-only locks', async () => {
    const mirror = await twin();
    await select('note');
    await page.locator('#lockSelection').click();
    await saved();
    await invoke('canvas_lock', { targetIds: ['note'], mode: 'subtree' }, mirror);
    expect(material(await stored())).toEqual(material(await storedAt(mirror)));
    expect(await page.locator('[data-object-id="note"] > .selection-bounds .lock-mark').count()).toBe(1);
    await dragRefusal('note', 30, 20);
    const refused = await page.request.post(`${origin}/x/api/canvas/${mirror}/command`, {
      data: {
        tool: 'canvas_transform',
        arguments: {
          targetIds: ['note'],
          space: 'world',
          anchor: { x: 0, y: 0 },
          translation: { x: 30, y: 20 },
          scale: { width: 1, height: 1 },
          rotation: 0,
        },
      },
    });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).reasons[0].code).toBe('LOCKED');
    expect(material(await stored())).toEqual(material(await storedAt(mirror)));
    expect(await page.locator('#actionMessage').textContent()).toBe(
      '"Keep the reason you wanted to r…" is locked. Unlock it to move it.'
    );
    await reader('note');
    await page.locator('#textEditor').fill('Protected text');
    await page.locator('#textEditor').blur();
    await page.waitForFunction(() => window.canvasEdit.read().status === 'refused');
    const protectedContent = await page.request.post(`${origin}/x/api/canvas/${mirror}/command`, {
      data: {
        tool: 'canvas_update',
        arguments: {
          operations: [
            {
              kind: 'update',
              opId: 'locked-content',
              objectId: 'note',
              patch: { content: { type: 'text', text: 'Protected text' } },
            },
          ],
        },
      },
    });
    expect(protectedContent.status()).toBe(409);
    expect(material(await stored())).toEqual(material(await storedAt(mirror)));
    expect(await page.locator('#editStatus').textContent()).toBe(
      '"Keep the reason you wanted to r…" is locked. Unlock it to edit it.'
    );
    await page.locator('#lockSelection').click();
    await saved();
    await invoke('canvas_lock', { targetIds: ['note'], mode: 'unlock' }, mirror);
    expect(material(await stored())).toEqual(material(await storedAt(mirror)));
    await closeReader();
    await select('frame');
    await page.locator('#arrangeSelection').click();
    await page.locator('#backgroundLock').click();
    await saved();
    await invoke('canvas_lock', { targetIds: ['frame'], mode: 'background' }, mirror);
    expect(material(await stored())).toEqual(material(await storedAt(mirror)));
    await drag('child', 30, 20);
    await invoke(
      'canvas_transform',
      {
        targetIds: ['child'],
        space: 'world',
        anchor: { x: 0, y: 0 },
        translation: { x: 30, y: 20 },
        scale: { width: 1, height: 1 },
        rotation: 0,
      },
      mirror
    );
    expect(material(await stored())).toEqual(material(await storedAt(mirror)));
  });
  async function rowFits() {
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const tops = await page
      .locator('#contextRow > button:visible')
      .evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(1);
    expect(await page.locator('#contextRow').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  }
  it('keeps text typed behind a refused drag, saves it in order, and saves later typing', async () => {
    await invoke('canvas_lock', { targetIds: ['other'], mode: 'subtree' });
    await page.waitForFunction(() =>
      window.canvasEdit.read().locks.some((lock) => lock.id === 'other' && lock.local === 'subtree')
    );
    await reader('note');
    const editor = page.locator('#textEditor');
    await editor.fill('Typed while the drag was in flight');
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let commands = 0;
    await page.route('**/api/canvas/*/command', async (route) => {
      commands++;
      await held;
      await route.continue();
    });
    expect(await page.evaluate(() => window.canvasEdit.move({ targetIds: ['other'], delta: { x: 30, y: 20 } }))).toBe(
      true
    );
    await page.waitForFunction(() => window.canvasEdit.read().pending);
    await editor.blur();
    await page.waitForFunction(() => window.canvasEdit.read().drafts.note?.sent !== undefined);
    release();
    await saved();
    expect(commands).toBe(1);
    expect((await stored()).find((o) => o.id === 'note')?.content.text).toBe('Typed while the drag was in flight');
    await editor.focus();
    await editor.fill('And this came after the refusal');
    await editor.blur();
    await page.waitForFunction(
      () =>
        window.canvasEdit.read().status === 'saved' &&
        !window.canvasEdit.read().pending &&
        window.canvasEdit.read().drafts.note?.base === 'And this came after the refusal'
    );
    expect((await stored()).find((o) => o.id === 'note')?.content.text).toBe('And this came after the refusal');
    expect(await page.locator('#editStatus').textContent()).toBe('Saved');
    const keys = await page.evaluate(() => Object.keys(localStorage));
    expect(keys.filter((key) => key.startsWith('codeman:canvas:') && !key.startsWith('codeman:canvas:user:'))).toEqual(
      []
    );
    expect(keys).toContain(`codeman:canvas:user:%40single:${workspace}:drafts`);
  });
  async function dragRefusal(id: string, dx: number, dy: number) {
    const p = await objectCenter(id);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x + dx, p.y + dy, { steps: 5 });
    await page.mouse.up();
    await page.waitForFunction(() => window.canvasEdit.read().status === 'refused');
  }
  it('copies and pastes structure with fresh IDs, cuts and duplicates as single undoable commands', async () => {
    const mirror = await twin();
    await select('frame');
    await page.locator('#board').focus();
    await page.keyboard.press('Control+c');
    await page.keyboard.press('Control+v');
    await saved();
    await invoke('canvas_arrange', { action: 'duplicate', targetIds: ['frame'], offset: { x: 24, y: 24 } }, mirror);
    expect(material(await stored())).toEqual(material(await storedAt(mirror)));
    const after = await stored();
    expect(after).toHaveLength(6);
    const pastedFrame = after.find((o) => o.type === 'frame' && o.id !== 'frame');
    expect(after.some((o) => o.parentId === pastedFrame?.id && o.id !== 'child')).toBe(true);
    await page.locator('#board').focus();
    await page.keyboard.press('Control+z');
    await saved();
    expect(await stored()).toHaveLength(4);
    await page.keyboard.press('Control+Shift+z');
    await saved();
    expect(await stored()).toHaveLength(6);
    await select('note');
    await page.locator('#board').focus();
    await page.keyboard.press('Control+x');
    await saved();
    await invoke('canvas_delete', { operations: [{ kind: 'delete', opId: 'cut-note', objectId: 'note' }] }, mirror);
    expect(material(await stored())).toEqual(material(await storedAt(mirror)));
    await select('other');
    await page.locator('#board').focus();
    await page.keyboard.press('Control+d');
    await saved();
    await invoke('canvas_arrange', { action: 'duplicate', targetIds: ['other'], offset: { x: 24, y: 24 } }, mirror);
    expect(material(await stored())).toEqual(material(await storedAt(mirror)));
  });
  it('resizes a combined selection, scales groups uniformly, rotates, and keeps frame children fixed', async () => {
    const mirror = await twin();
    await selectMany(['note', 'other']);
    await page.locator('#selectionBounds > .handle-se').waitFor({ state: 'visible' });
    const handle = await page.locator('#selectionBounds > .handle-se').boundingBox();
    if (!handle) throw new Error('Missing combined handle');
    await page.keyboard.down('Control');
    await page.mouse.move(handle.x + 8, handle.y + 8);
    await page.mouse.down();
    await page.mouse.move(handle.x + 128, handle.y + 188, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up('Control');
    await saved();
    await invoke(
      'canvas_transform',
      {
        targetIds: ['note', 'other'],
        space: 'world',
        anchor: { x: 100, y: 100 },
        translation: { x: 0, y: 0 },
        scale: { width: 1.5, height: 1.5 },
        rotation: 0,
      },
      mirror
    );
    expect(material(await stored())).toEqual(material(await storedAt(mirror)));
    await page.locator('#board').focus();
    await page.keyboard.press('Control+g');
    await saved();
    const group = (await stored()).find((o) => o.type === 'group');
    if (!group) throw new Error('Missing group');
    await invoke(
      'canvas_arrange',
      {
        action: 'group',
        targetIds: ['note', 'other'],
        groupId: 'mirror-group',
        parentId: null,
        label: 'Untitled group',
      },
      mirror
    );
    const g = await page.locator('#selectionBounds > .handle-e').boundingBox();
    if (!g) throw new Error('Missing group handle');
    const box = selectionBox(await stored(), [group.id]);
    await page.keyboard.down('Control');
    await page.mouse.move(g.x + 8, g.y + 8);
    await page.mouse.down();
    await page.mouse.move(g.x + 8 + box.width / 2, g.y + 8);
    await page.mouse.up();
    await page.keyboard.up('Control');
    await saved();
    expect((await stored()).find((o) => o.id === 'note')?.size?.width).toBe(540);
    await invoke(
      'canvas_transform',
      {
        targetIds: ['mirror-group'],
        space: 'world',
        anchor: { x: box.x, y: box.y },
        translation: { x: 0, y: 0 },
        scale: { width: 1.5, height: 1.5 },
        rotation: 0,
      },
      mirror
    );
    expect(material(await stored())).toEqual(material(await storedAt(mirror)));
    const rotationBox = selectionBox(await storedAt(mirror), ['mirror-group']);
    await page.locator('#editSelection').click();
    await page.locator('#rotationDegrees').fill('90');
    await page.locator('#rotationDegrees').press('Tab');
    await saved();
    expect((await stored()).find((o) => o.id === group.id)?.rotation).toBe(90);
    await invoke(
      'canvas_transform',
      {
        targetIds: ['mirror-group'],
        space: 'world',
        anchor: { x: rotationBox.x + rotationBox.width / 2, y: rotationBox.y + rotationBox.height / 2 },
        translation: { x: 0, y: 0 },
        scale: { width: 1, height: 1 },
        rotation: 90,
      },
      mirror
    );
    expect(material(await stored())).toEqual(material(await storedAt(mirror)));
    expect(await page.evaluate(() => window.canvasEdit.capabilities.flip)).toContain('Unsupported');
    await closeReader();
    await select('frame');
    await page.locator('[data-object-id="frame"] > .handle-se').waitFor({ state: 'visible' });
    const frameHandle = await page.locator('[data-object-id="frame"] > .handle-se').boundingBox();
    if (!frameHandle) throw new Error('Missing frame handle');
    const child = (await stored()).find((o) => o.id === 'child');
    await page.keyboard.down('Control');
    await page.mouse.move(frameHandle.x + 8, frameHandle.y + 8);
    await page.mouse.down();
    await page.mouse.move(frameHandle.x + 48, frameHandle.y + 28, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up('Control');
    await saved();
    await invoke(
      'canvas_update',
      {
        operations: [
          { kind: 'update', opId: 'resize-frame', objectId: 'frame', patch: { size: { width: 400, height: 320 } } },
        ],
      },
      mirror
    );
    expect(material(await stored())).toEqual(material(await storedAt(mirror)));
    expect((await stored()).find((o) => o.id === 'child')?.position).toEqual(child?.position);
    expect((await stored()).find((o) => o.id === 'child')?.size).toEqual(child?.size);
  });
  it('retains a compound retry identity across reload and refuses history with later dependents', async () => {
    await selectMany(['note', 'other']);
    let lost = true;
    await page.route('**/api/canvas/*/command', async (route) => {
      if (lost) {
        const committed = await route.fetch();
        expect(committed.ok()).toBe(true);
        await route.fulfill({ status: 503, json: { error: 'Acknowledgement lost' } });
      } else await route.continue();
    });
    await page.keyboard.press('Control+g');
    await page.waitForFunction(() => window.canvasEdit.read().status === 'failed');
    lost = false;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await saved();
    expect((await stored()).filter((o) => o.type === 'group')).toHaveLength(1);
    await page.unrouteAll({ behavior: 'wait' });
    await select('frame');
    await page.locator('#board').focus();
    await page.keyboard.press('Control+d');
    await saved();
    const duplicate = (await stored()).find((o) => o.type === 'frame' && o.id !== 'frame');
    if (!duplicate) throw new Error('Missing duplicate');
    await invoke('canvas_create', { operations: [create('later-child', 'text', 10, 20, duplicate.id)] });
    await page.locator('#board').focus();
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => window.canvasEdit.read().status === 'refused');
    expect(await page.locator('#actionMessage').textContent()).toBe(
      `Can't undo: "A quiet place for references." was added to "Design exploration" later.`
    );
    expect((await stored()).some((o) => o.id === 'later-child')).toBe(true);
  });
  it('captures the six compound interaction states in both themes and scopes new shortcuts', async () => {
    for (const theme of ['dark', 'light']) {
      workspace = await twin();
      await open();
      await page.evaluate((theme) => {
        localStorage.setItem('codeman:skin', theme === 'light' ? 'paper-gray' : 'og');
        window.dispatchEvent(new Event('storage'));
      }, theme);
      await selectMany(['note', 'other']);
      await rowFits();
      expect(await page.locator('#groupSelection').textContent()).toBe('Group');
      expect(await page.locator('#groupSelection').isVisible()).toBe(true);
      await page.locator('#board').focus();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowLeft');
      await selectMany(['note', 'other']);
      await page.locator('#selectionBounds > .handle-se').waitFor({ state: 'visible' });
      const handle = await page.locator('#selectionBounds > .handle-se').boundingBox();
      if (!handle) throw new Error('Missing resize handle');
      await page.keyboard.down('Control');
      await page.mouse.move(handle.x + 8, handle.y + 8);
      await page.mouse.down();
      await page.mouse.move(handle.x + 68, handle.y + 98, { steps: 8 });
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('board');
      expect(await page.locator('#board').evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none');
      await shot(theme, 'combined-resize');
      await page.keyboard.press('Escape');
      await page.mouse.up();
      await page.keyboard.up('Control');
      expect(await page.locator('#board').evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none');
      await page.locator('#board').focus();
      await page.keyboard.press('Control+g');
      await saved();
      await rowFits();
      expect(await page.locator('#groupSelection').textContent()).toBe('Ungroup');
      await shot(theme, 'grouped-selection');
      await page.locator('#arrangeSelection').click();
      const menu = await page.locator('#arrangeMenu').boundingBox();
      if (!menu) throw new Error('Missing Arrange menu');
      expect(menu.height).toBeLessThanOrEqual(320);
      expect(menu.width).toBeLessThanOrEqual(248);
      expect(await page.locator('#arrangeMenu [data-align]').count()).toBe(6);
      expect(await page.locator('#arrangeMenu [data-distribute]').count()).toBe(2);
      expect(await page.locator('#arrangeMenu [data-align][aria-disabled="true"]').count()).toBe(6);
      expect(await page.locator('#arrangeMenu input').count()).toBe(0);
      const labels = await page
        .locator('#arrangeMenu button:visible')
        .evaluateAll((items) => items.map((item) => item.getAttribute('aria-label') ?? item.textContent ?? ''));
      for (const removed of ['Copy', 'Cut', 'Paste', 'Duplicate', 'Move with arrows', 'Rotate'])
        expect(labels.some((label) => label.includes(removed))).toBe(false);
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Align left');
      await page.keyboard.press('ArrowRight');
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Centre horizontally');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe('Wrap in section');
      await shot(theme, 'arrange-menu');
      await page.keyboard.press('Escape');
      expect(await page.locator('#arrangeMenu').isHidden()).toBe(true);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('arrangeSelection');
      await page.locator('#board').focus();
      await page.keyboard.press('Control+c');
      await page.keyboard.press('Control+v');
      await saved();
      await shot(theme, 'paste-result');
      await page.locator('#board').focus();
      await page.keyboard.press('Control+z');
      await saved();
      await selectMany(['note', 'other']);
      await page.locator('#arrangeSelection').click();
      expect(await page.locator('#arrangeMenu [data-align][aria-disabled="false"]').count()).toBe(6);
      expect(await page.locator('#arrangeMenu [data-distribute][aria-disabled="true"]').count()).toBe(2);
      await page.keyboard.press('Escape');
      await select('note');
      await rowFits();
      expect(await page.locator('#groupSelection').isHidden()).toBe(true);
      await page.locator('#lockSelection').click();
      await saved();
      await dragRefusal('note', 30, 20);
      expect(await page.locator('#actionMessage').textContent()).toBe(
        '"Keep the reason you wanted to r…" is locked. Unlock it to move it.'
      );
      await rowFits();
      await shot(theme, 'locked-refusal');
      for (const [id, verb] of [
        ['moveTo', 'move'],
        ['arrangeSelection', 'move'],
        ['editSelection', 'edit'],
        ['deleteSelection', 'delete'],
      ]) {
        const control = page.locator(`#${id}`);
        expect(await control.getAttribute('aria-disabled')).toBe('true');
        expect(
          await control.evaluate(
            (el) => document.getElementById(el.getAttribute('aria-describedby') ?? '')?.textContent
          )
        ).toBe(`"Keep the reason you wanted to r…" is locked. Unlock it to ${verb} it.`);
      }
      expect(await page.locator('#lockSelection').textContent()).toBe('Unlock');
      const unlock = await page.locator('#lockSelection').evaluate((el) => {
        const probe = document.createElement('i');
        probe.style.color = 'var(--accent)';
        el.append(probe);
        const accent = getComputedStyle(probe).color;
        probe.remove();
        return { fill: getComputedStyle(el).backgroundColor, accent };
      });
      expect(unlock.fill).toBe(unlock.accent);
      const before = await stored();
      await page.locator('#deleteSelection').focus();
      await page.keyboard.press('Enter');
      expect(await stored()).toEqual(before);
      expect(await page.locator('#actionMessage').textContent()).toBe(
        '"Keep the reason you wanted to r…" is locked. Unlock it to delete it.'
      );
      const bounds = await page.locator('[data-object-id="note"] > .selection-bounds').boundingBox();
      const lock = await page.locator('[data-object-id="note"] > .selection-bounds > .lock-mark').boundingBox();
      if (!bounds || !lock) throw new Error('Missing lock mark');
      expect(lock.width).toBeCloseTo(12, 0);
      expect(lock.x).toBeGreaterThanOrEqual(bounds.x + bounds.width);
      expect(lock.y + lock.height).toBeLessThanOrEqual(bounds.y - 4);
      const row = page.locator('[data-row-id="note"]');
      const rowBox = await row.boundingBox(),
        rowLock = await row.locator('.lock-mark').boundingBox();
      if (!rowBox || !rowLock) throw new Error('Missing outline lock');
      expect(rowLock.width).toBeCloseTo(12, 0);
      expect(await row.evaluate((el) => parseFloat(getComputedStyle(el).paddingRight))).toBeGreaterThanOrEqual(
        rowBox.x + rowBox.width - rowLock.x
      );
      await shot(theme, 'locked-row');
      await page.evaluate(() => {
        window.canvasView.dispatch({ kind: 'selection', ids: [] });
        window.canvasView.dispatch({ kind: 'focus', id: null });
      });
      // The refusal named the cleared selection, so it leaves with it.
      await page.locator('#actionMessage').waitFor({ state: 'hidden', timeout: 2000 });
      await page.mouse.move((await objectCenter('note')).x, (await objectCenter('note')).y);
      await page.locator('[data-object-id="note"] > .selection-bounds > .lock-mark').waitFor({ state: 'visible' });
      await shot(theme, 'locked-hover');
      await page.mouse.move(700, 700);
      expect(await page.locator('[data-object-id="note"] > .selection-bounds > .lock-mark').isVisible()).toBe(false);
      const p = await objectCenter('other');
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      await page.mouse.move(p.x, p.y + 30, { steps: 8 });
      expect(await page.locator('.alignment-guide').count()).toBeGreaterThan(0);
      await shot(theme, 'alignment-guide');
      await page.keyboard.press('Escape');
      await page.mouse.up();
    }
    await page.locator('#search').fill('');
    await page.locator('#search').focus();
    const before = await stored();
    for (const key of ['Control+g', 'Control+Shift+g', 'Control+d', 'Control+x', 'Control+v'])
      await page.keyboard.press(key);
    expect(await stored()).toEqual(before);
    await page.locator('#board').focus();
    await page.locator('#board').dispatchEvent('compositionstart');
    await page.keyboard.press('Control+g');
    await page.locator('#board').dispatchEvent('compositionend');
    expect(await stored()).toEqual(before);
  }, 60000);
  it('omits every edit control at phone width, including a desktop-to-phone change', async () => {
    await reader();
    await page.setViewportSize({ width: 390, height: 844 });
    for (const selector of [
      '#addTool',
      '#contextRow',
      '#textEdit',
      '#writeFeedback',
      '#geometryEdit',
      '.resize-handle',
    ])
      expect(await page.locator(`${selector}:visible`).count()).toBe(0);
    const before = await stored();
    expect(
      await page.evaluate(() => window.canvasEdit.apply([{ kind: 'delete', opId: 'phone-write', objectId: 'note' }]))
    ).toBe(false);
    expect(await stored()).toEqual(before);
    expect(await page.locator('#readerText').isVisible()).toBe(true);
  });
});
