import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import puppeteer from 'puppeteer';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { WebServer } from '../src/web/server.js';
import { dataPath } from '../src/config/instance.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';
import { SnapshotSchema } from '../packages/canvas/src/model.js';
import { CommandSchema } from '../src/canvas/operations.js';
import { findAsset } from '../src/canvas/canvas-assets.js';

const stamp = Date.now();
const media = resolve('pr/media');

/** A real PNG: a soft diagonal gradient, so a capture shows the image and not a flat block. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = y * (width * 3 + 1) + 1 + x * 3,
        t = (x / width + y / height) / 2;
      rows[at] = Math.round(70 + 120 * t);
      rows[at + 1] = Math.round(110 + 60 * (1 - t));
      rows[at + 2] = Math.round(150 + 80 * t);
    }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const picture = png(640, 400);

type Seed = {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  content: object;
  parentId?: string;
};
const create = (s: Seed) =>
  CommandSchema.parse({
    kind: 'create',
    opId: `seed-${s.id}`,
    objectId: s.id,
    patch: {
      parentId: s.parentId ?? null,
      order: s.x + s.y,
      position: { x: s.x, y: s.y },
      size: { width: s.w, height: s.h },
      content: { type: s.type, ...s.content },
    },
  });

describe('canvas media', () => {
  let server: WebServer,
    pages: Server,
    site: string,
    browser: Browser,
    page: Page,
    origin: string,
    workspace: string,
    serial = 0;
  beforeAll(async () => {
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-pc5-media');
    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasEnabled: true }));
    server = new WebServer(0, false, true, undefined, undefined, undefined, '/x');
    await server.start();
    origin = `http://localhost:${server.boundPort}`;
    pages = createServer((req, res) => {
      if (req.url === '/notes') {
        res.setHeader('Content-Type', 'text/html');
        res.end(
          '<!doctype html><title>Field notes on quiet tools</title><meta property="og:image" content="/thumb.png">'
        );
      } else if (req.url === '/thumb.png') {
        res.setHeader('Content-Type', 'image/png');
        res.end(png(240, 160));
      } else if (req.url?.startsWith('/page')) {
        res.setHeader('Content-Type', 'text/html');
        res.end(
          '<!doctype html><title>Dashboard</title><body style="margin:0;font:15px system-ui;background:#f4f1ea;color:#222">' +
            '<main style="padding:20px"><h2 style="margin:0 0 8px">Build status</h2><p>All checks passed.</p>' +
            '<input id="field" placeholder="Type here"></main></body>'
        );
      } else {
        res.statusCode = 404;
        res.end('missing');
      }
    });
    await new Promise<void>((done) => pages.listen(0, '127.0.0.1', done));
    site = `http://127.0.0.1:${(pages.address() as AddressInfo).port}`;
    browser = await chromium.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: ['--no-sandbox'],
    });
    mkdirSync(media, { recursive: true });
  }, 60000);
  beforeEach(async () => {
    const name = `Canvas media ${++serial}`;
    mkdirSync(resolve(resolveCasesDir(), name), { recursive: true });
    workspace = workspaceForCase(name).id;
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  });
  afterEach(async () => {
    await page?.context().setOffline(false);
    await page?.unrouteAll({ behavior: 'wait' });
    await page?.close();
  });
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    await new Promise((done) => pages?.close(done));
    vi.unstubAllEnvs();
  }, 60000);

  async function seed(objects: Seed[]) {
    const response = await page.request.post(`${origin}/x/api/canvas/${workspace}/ops`, {
      data: { operations: objects.map(create) },
    });
    expect(response.ok()).toBe(true);
  }
  async function upload(bytes = picture): Promise<string> {
    const response = await page.request.post(`${origin}/x/api/canvas/${workspace}/assets`, {
      data: bytes,
      headers: { 'Content-Type': 'image/png' },
    });
    const body = await response.json();
    return body.data.assetId;
  }
  async function open(viewport = { x: 220, y: 0, zoom: 1 }) {
    await page.goto(`${origin}/x/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.canvasEdit?.read().status === 'saved');
    await page.evaluate((v) => window.canvasView.dispatch({ kind: 'viewport', viewport: v }), viewport);
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  async function stored() {
    const data = await (await page.request.get(`${origin}/x/api/canvas/${workspace}/objects`)).json();
    return SnapshotSchema.parse(data.data).objects;
  }
  async function saved() {
    await page.waitForFunction(() => window.canvasEdit.read().status === 'saved' && !window.canvasEdit.read().pending);
  }
  async function shot(slug: string) {
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await page.screenshot({ path: resolve(media, `pc5-review-${stamp}-${slug}.png`), animations: 'disabled' });
  }
  /** A paste event as the browser delivers it, with the given clipboard items. */
  async function paste(items: { files?: { name: string; type: string; base64: string }[]; text?: string }) {
    await page.locator('#board').focus();
    await page.evaluate((items) => {
      const data = new DataTransfer();
      for (const f of items.files ?? [])
        data.items.add(new File([Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
      if (items.text) data.setData('text/plain', items.text);
      document
        .getElementById('board')!
        .dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, items);
  }

  it('pastes an image at its own aspect ratio and shows a quiet note when bytes are missing', async () => {
    const lost = await upload(png(300, 200));
    await seed([
      {
        id: 'missing',
        type: 'image',
        x: 760,
        y: 220,
        w: 320,
        h: 200,
        content: { url: '', alt: 'Lost sketch', assetId: lost },
      },
    ]);
    // The bytes went missing on disk after the object was written.
    unlinkSync(findAsset(workspace, lost)!.path);
    await open();
    await paste({ files: [{ name: 'moodboard.png', type: 'image/png', base64: picture.toString('base64') }] });
    await expect.poll(async () => (await stored()).filter((o) => o.type === 'image').length).toBe(2);
    await saved();
    const image = (await stored()).find((o) => o.type === 'image' && o.id !== 'missing');
    expect(image?.content.alt).toBe('moodboard');
    expect(image?.size).toEqual({ width: 480, height: 300 });
    const body = page.locator(`[data-object-id="${image?.id}"] .object-body`);
    await page.waitForFunction(
      (id) =>
        document.querySelector(`[data-object-id="${id}"] .object-body`)?.getAttribute('data-media-state') === 'ready',
      image?.id
    );
    expect(await body.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(640);
    expect(await body.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe('6px');
    const missing = page.locator('[data-object-id="missing"] .object-body');
    await page.waitForFunction(
      () =>
        document.querySelector('[data-object-id="missing"] .object-body')?.getAttribute('data-media-state') === 'failed'
    );
    expect(await missing.locator('.media-note').textContent()).toBe('Image unavailable');
    await page.evaluate(() => window.canvasView.dispatch({ kind: 'selection', ids: [] }));
    await shot('desktop-image-pasted');
    await page.evaluate(() => window.canvasView.dispatch({ kind: 'selection', ids: ['missing'] }));
    await page.waitForSelector('#replaceImage:not([hidden])');
    await shot('desktop-image-failed');
  });

  it('turns a pasted address into a link card with a preview, a bare card without one, and refuses other files', async () => {
    await open();
    await paste({ text: `${site}/notes` });
    await page.waitForFunction(
      () =>
        document.querySelector('.object[data-type="link"] .link-title')?.textContent === 'Field notes on quiet tools'
    );
    await saved();
    const link = (await stored()).find((o) => o.type === 'link');
    expect(link?.content).toMatchObject({ preview: 'ready', label: 'Field notes on quiet tools' });
    expect(link?.content.thumbnailAssetId).toMatch(/^[a-f0-9]{64}$/);
    expect(await page.locator('.object[data-type="link"] img').count()).toBe(1);
    expect(await page.locator('.object[data-type="link"] [class*="favicon"]').count()).toBe(0);
    await page.evaluate(() => window.canvasView.dispatch({ kind: 'selection', ids: [] }));
    await shot('desktop-link-preview');

    await page.evaluate(() => window.canvasView.dispatch({ kind: 'viewport', viewport: { x: 220, y: -200, zoom: 1 } }));
    await paste({ text: `${site}/gone` });
    await page.waitForFunction(() => {
      const links = window.canvasEdit.read();
      return links.status === 'saved' && !links.pending;
    });
    await expect
      .poll(async () => (await stored()).filter((o) => o.type === 'link' && o.content.preview === 'unavailable').length)
      .toBe(1);
    const bare = (await stored()).find((o) => o.content.preview === 'unavailable');
    await page.waitForFunction((id) => !!document.querySelector(`[data-object-id="${id}"] .link-url`), bare?.id);
    expect(await page.locator(`[data-object-id="${bare?.id}"] .link-url`).textContent()).toBe(`${site}/gone`);
    await shot('desktop-link-bare');

    await paste({
      files: [{ name: 'notes.txt', type: 'text/plain', base64: Buffer.from('hello').toString('base64') }],
    });
    await page.waitForSelector('#actionMessage:not([hidden])');
    expect(await page.locator('#actionMessage').textContent()).toBe(
      'Only PNG, JPEG, GIF and WebP images can be added to the canvas.'
    );
    await shot('desktop-refusal');
    await paste({ text: 'A pasted thought' });
    await saved();
    expect((await stored()).some((o) => o.type === 'text' && o.content.text === 'A pasted thought')).toBe(true);
  });

  it('highlights the container a drop lands in and places the drop inside it', async () => {
    await seed([{ id: 'frame', type: 'frame', x: 200, y: 200, w: 480, h: 360, content: { label: 'References' } }]);
    await open();
    const box = await page.locator('[data-object-id="frame"]').boundingBox();
    if (!box) throw new Error('Missing frame');
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const handle = await page.evaluateHandle((url) => {
      const data = new DataTransfer();
      data.setData('text/uri-list', url);
      return data;
    }, `${site}/notes`);
    await page.dispatchEvent('[data-object-id="frame"] > .object-body', 'dragover', {
      dataTransfer: handle,
      clientX: at.x,
      clientY: at.y,
    });
    expect(await page.locator('[data-object-id="frame"]').evaluate((el) => el.classList.contains('drop-target'))).toBe(
      true
    );
    await page.dispatchEvent('[data-object-id="frame"] > .object-body', 'drop', {
      dataTransfer: handle,
      clientX: at.x,
      clientY: at.y,
    });
    expect(await page.locator('.drop-target').count()).toBe(0);
    await saved();
    const link = (await stored()).find((o) => o.type === 'link');
    expect(link?.parentId).toBe('frame');
  });

  it('keeps at most six frames live, never takes focus, lets a drag cross a frame, and Escape hands keys back', async () => {
    const embeds: Seed[] = Array.from({ length: 8 }, (_, i) => ({
      id: `embed-${i}`,
      type: 'embed',
      x: 40 + (i % 4) * 340,
      y: 40 + Math.floor(i / 4) * 300,
      w: 320,
      h: 260,
      content: { url: `${site}/page?n=${i}`, label: `Dashboard ${i + 1}` },
    }));
    await seed([
      ...embeds,
      { id: 'note', type: 'text', x: 60, y: 640, w: 240, h: 120, content: { text: 'Drag me across the page' } },
    ]);
    await open({ x: 230, y: 20, zoom: 0.85 });
    await page.waitForFunction(() => document.querySelectorAll('.embed-stage > iframe').length === 6);
    await page.waitForTimeout(800);
    expect(await page.locator('.embed-stage > iframe').count()).toBe(6);
    expect(await page.locator('.embed-stage .embed-card').count()).toBe(2);
    expect(await page.locator('.embed-stage .embed-card').first().textContent()).toContain('Paused');
    for (const sandbox of await page
      .locator('.embed-stage > iframe')
      .evaluateAll((f) => f.map((x) => x.getAttribute('sandbox'))))
      expect(sandbox).not.toContain('allow-same-origin');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('board');
    await shot('desktop-embed-live');

    const frameBox = await page.locator('[data-object-id="embed-1"]').boundingBox();
    const noteBox = await page.locator('[data-object-id="note"]').boundingBox();
    if (!frameBox || !noteBox) throw new Error('Missing objects');
    await page.mouse.move(noteBox.x + 40, noteBox.y + 40);
    await page.mouse.down();
    await page.mouse.move(frameBox.x + frameBox.width / 2, frameBox.y + frameBox.height / 2, { steps: 10 });
    await shot('desktop-embed-drag');
    await page.mouse.move(noteBox.x + 40, noteBox.y - 160, { steps: 10 });
    await page.mouse.up();
    await saved();
    expect((await stored()).find((o) => o.id === 'note')?.position.y).toBeLessThan(640);

    await page.evaluate(() => window.canvasView.dispatch({ kind: 'selection', ids: ['embed-0'] }));
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const shield = page.locator('[data-object-id="embed-0"] .embed-shield');
    await shield.click();
    await page.waitForFunction(() => document.activeElement instanceof HTMLIFrameElement);
    expect(await page.locator('[data-object-id="embed-0"] .embed-stage').getAttribute('class')).toContain(
      'interacting'
    );
    // Keys reach the page while it is in use; the frame's own Escape relay hands them back.
    const field = page.frameLocator('[data-object-id="embed-0"] iframe').locator('#field');
    await field.waitFor();
    await field.click();
    await page.keyboard.type('hello');
    expect(await field.inputValue()).toBe('hello');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.id === 'board');
    expect(await page.locator('.embed-stage.interacting').count()).toBe(0);

    // Over the cap, the embeds furthest from the middle show their card with "Paused".
    await page.evaluate(() => window.canvasView.dispatch({ kind: 'selection', ids: ['embed-3'] }));
    await page.waitForSelector('#embedSelection:not([hidden])');
    expect(await page.locator('[data-object-id="embed-3"] .embed-card').textContent()).toContain('Paused');
    expect(await page.locator('#embedSelection').textContent()).toBe('Back to link');
    await shot('desktop-embed-paused');
    // Panned off screen, a frame stops; panned back, it loads again.
    await page.evaluate(() => window.canvasView.dispatch({ kind: 'viewport', viewport: { x: -900, y: 20, zoom: 1 } }));
    await page.waitForFunction(() => document.querySelectorAll('.embed-stage > iframe').length <= 2);
    await page.evaluate(() =>
      window.canvasView.dispatch({ kind: 'viewport', viewport: { x: 230, y: 20, zoom: 0.85 } })
    );
    await page.waitForFunction(() => document.querySelectorAll('.embed-stage > iframe').length === 6);
    await page.locator('#embedSelection').click();
    await saved();
    expect((await stored()).find((o) => o.id === 'embed-3')?.type).toBe('link');
  });

  it('opens a sub-canvas into its own view with a breadcrumb and leaves with Escape', async () => {
    const image = await upload();
    await seed([
      {
        id: 'sub',
        type: 'subcanvas',
        x: 300,
        y: 200,
        w: 360,
        h: 240,
        content: { workspaceId: 'sub', label: 'Research' },
      },
      { id: 'outside', type: 'text', x: 760, y: 220, w: 240, h: 120, content: { text: 'On the workspace' } },
      {
        id: 'inner',
        type: 'text',
        x: 40,
        y: 40,
        w: 260,
        h: 120,
        content: { text: 'Inside research' },
        parentId: 'sub',
      },
      {
        id: 'pic',
        type: 'image',
        x: 340,
        y: 40,
        w: 320,
        h: 200,
        content: { url: '', alt: 'Reference', assetId: image },
        parentId: 'sub',
      },
    ]);
    await open();
    expect(await page.locator('[data-object-id="inner"]').isVisible()).toBe(false);
    expect(await page.locator('[data-object-id="sub"] .subcanvas-open').isVisible()).toBe(true);
    await shot('desktop-subcanvas-closed');
    await page.locator('[data-object-id="sub"] .subcanvas-open').click();
    await page.waitForFunction(() => window.canvasView.read().root === 'sub');
    await page.evaluate(() => new Promise(requestAnimationFrame));
    expect(await page.locator('#viewPath').isVisible()).toBe(true);
    expect(await page.locator('#viewPath').textContent()).toContain('Research');
    expect(await page.locator('[data-object-id="inner"]').isVisible()).toBe(true);
    expect(await page.locator('[data-object-id="outside"]').isVisible()).toBe(false);
    await page.waitForTimeout(400);
    await shot('desktop-subcanvas-open');
    await page.locator('#board').focus();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.canvasView.read().root === null);
    expect(await page.locator('#viewPath').isHidden()).toBe(true);
    await page.evaluate(() => window.canvasView.dispatch({ kind: 'selection', ids: ['sub'] }));
    await page.keyboard.press('Alt+ArrowDown');
    await page.waitForFunction(() => window.canvasView.read().root === 'sub');
    await paste({ text: 'Pasted inside' });
    await saved();
    expect((await stored()).find((o) => o.content.text === 'Pasted inside')?.parentId).toBe('sub');
    await page.keyboard.press('Alt+ArrowUp');
    await page.waitForFunction(() => window.canvasView.read().root === null);
  });

  it('shows media read-only at phone width with no live frames', async () => {
    const image = await upload();
    await seed([
      { id: 'pic', type: 'image', x: 20, y: 20, w: 320, h: 200, content: { url: '', alt: 'Board', assetId: image } },
      {
        id: 'link',
        type: 'link',
        x: 20,
        y: 250,
        w: 320,
        h: 96,
        content: { url: `${site}/notes`, label: 'Field notes on quiet tools', preview: 'ready' },
      },
      {
        id: 'embed',
        type: 'embed',
        x: 20,
        y: 380,
        w: 320,
        h: 240,
        content: { url: `${site}/page`, label: 'Dashboard' },
      },
    ]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/x/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-object-id="pic"] .object-body[data-media-state="ready"]');
    await page.evaluate(() => window.canvasView.dispatch({ kind: 'viewport', viewport: { x: 20, y: 40, zoom: 1 } }));
    await page.waitForTimeout(600);
    expect(await page.locator('.embed-stage > iframe').count()).toBe(0);
    expect(await page.locator('#addTool').isVisible()).toBe(false);
    expect(await page.locator('.embed-actions').first().isVisible()).toBe(false);
    await shot('phone-media');
  });

  describe('restored text drafts', () => {
    async function restore(value: string) {
      const objects = await stored();
      const note = objects.find((o) => o.id === 'note');
      await page.addInitScript(({ key, draft }) => localStorage.setItem(key, JSON.stringify({ note: draft })), {
        key: `codeman:canvas:user:%40single:${workspace}:drafts`,
        draft: {
          base: 'Before',
          value,
          revision: typeof note?.revision === 'number' ? note.revision : 0,
          conflict: false,
        },
      });
    }
    async function updates() {
      const history = await (await page.request.get(`${origin}/x/api/canvas/${workspace}/ops?since=0`)).json();
      return history.data.operations.filter(
        (op: { kind: string; objectId: string }) => op.kind === 'update' && op.objectId === 'note'
      ).length;
    }
    beforeEach(async () => {
      await seed([{ id: 'note', type: 'text', x: 100, y: 100, w: 240, h: 140, content: { text: 'Before' } }]);
    });
    it('sends a restored unsent draft once on load, not again on reconnect', async () => {
      await restore('Written before the tab closed');
      await open();
      await saved();
      expect((await stored()).find((o) => o.id === 'note')?.content.text).toBe('Written before the tab closed');
      expect(await updates()).toBe(1);
      await page.context().setOffline(true);
      await page.waitForSelector('#notice:not([hidden])');
      await page.context().setOffline(false);
      await page.waitForSelector('#notice', { state: 'hidden' });
      await saved();
      await page.waitForTimeout(500);
      expect(await updates()).toBe(1);
    });
    it('sends a draft that could not save on load exactly once after reconnect', async () => {
      await restore('Written while offline');
      await page.route('**/api/canvas/*/ops', async (route) => {
        if (route.request().method() === 'POST') await route.abort();
        else await route.continue();
      });
      await page.goto(`${origin}/x/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.canvasEdit?.read().status === 'failed');
      expect(await updates()).toBe(0);
      await page.context().setOffline(true);
      await page.waitForFunction(() => !navigator.onLine);
      await page.waitForTimeout(300);
      await page.unrouteAll({ behavior: 'wait' });
      await page.context().setOffline(false);
      await page.waitForFunction(
        () => window.canvasEdit.read().status === 'saved' && !window.canvasEdit.read().pending
      );
      await page.waitForTimeout(500);
      expect((await stored()).find((o) => o.id === 'note')?.content.text).toBe('Written while offline');
      expect(await updates()).toBe(1);
    });
  });
});
