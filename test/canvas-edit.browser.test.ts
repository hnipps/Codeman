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
    const p = await objectCenter(id);
    await page.mouse.click(p.x, p.y);
  }
  async function reader(id = 'note') {
    await select(id);
    await page.locator('#board').focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('#textEdit:not([hidden])');
  }
  async function closeReader() {
    if (await page.locator('#rail').isVisible()) await page.locator('#closeRail').click();
  }
  async function drag(id: string, dx: number, dy: number) {
    const p = await objectCenter(id);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x + dx, p.y + dy, { steps: 8 });
    await page.mouse.up();
    await saved();
  }
  async function shot(theme: string, slug: string) {
    await page.screenshot({ path: resolve(media, `pc4-review-${stamp}-${theme}-${slug}.png`), animations: 'disabled' });
  }
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
    await page.locator('#moveMode').click();
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
      await page.waitForFunction(() => document.getElementById('editStatus')?.textContent?.includes('Conflict'));
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
      await page.waitForFunction(() => document.getElementById('editStatus')?.textContent?.includes('Conflict'));
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
        JSON.parse(localStorage.getItem(`codeman:canvas:${location.pathname.split('/').at(-1)}:edits`) ?? '{}')
          .operations[0].opId
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
      await page.evaluate(() => localStorage.getItem(`codeman:canvas:${location.pathname.split('/').at(-1)}:edits`))
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
            { kind: 'move', opId: `reset-note-${theme}`, objectId: 'note', patch: { position: { x: 100, y: 100 } } },
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
      expect(await page.locator('#editStatus').textContent()).toContain('unlock');
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
      await page.waitForFunction(() => document.getElementById('editStatus')?.textContent?.includes('Conflict'));
      await shot(theme, 'conflict');
      await page.locator('#keepDraft').click();
      await saved();
      await closeReader();
      await page.mouse.move(270, 140);
      await page.mouse.down();
      await page.mouse.move(570, 550, { steps: 10 });
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
        localStorage.getItem(`codeman:canvas:${location.pathname.split('/').at(-1)}:edits`)
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
