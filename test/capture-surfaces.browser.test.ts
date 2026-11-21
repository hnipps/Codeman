/**
 * @fileoverview Ambient capture, acceptance check 5 for the canvas surfaces (ticket 2): a capture of the
 * real canvas page, and of the dashboard with that canvas framed in it, shows a text object, a stored
 * prototype (bridged by the prototype route) and a web tab (bridged by the webview proxy, under a page
 * policy that blocks inline scripts) in their places. Each sampled pixel of the frozen picture is compared
 * with the same pixel of a screenshot the browser itself takes. The canvas page does not load capture.js
 * yet (its chord is ticket 6), so the test adds the two scripts the dashboard loads.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { WebServer } from '../src/web/server.js';
import { dataPath } from '../src/config/instance.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';
import { CanvasStores } from '../src/canvas/canvas-store.js';
import { CommandSchema } from '../src/canvas/operations.js';

type Rgb = [number, number, number];
type Point = { name: string; x: number; y: number };
type Shot = { frames: { title: string; depth: number; captured: boolean; selfReported: boolean }[]; pixels: Rgb[] };

const b64 = (text: string) => Buffer.from(text).toString('base64');
const near = (a: Rgb, b: Rgb, tolerance = 16) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance);
const MAGENTA: Rgb = [255, 0, 255];
const CYAN: Rgb = [0, 255, 255];

describe('capture shows the canvas surfaces (acceptance check 5)', () => {
  let server: WebServer, browser: Browser, page: Page, origin: string, ws: string, upstream: http.Server;
  let prototypeId: string;

  beforeAll(async () => {
    upstream = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('content-security-policy', "script-src 'self'");
      res.end(
        '<!doctype html><html><head></head><body style="margin:0;height:100vh;background:rgb(0,255,255)"><p id="w">web</p></body></html>'
      );
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/`;

    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasEnabled: true, canvasShellEnabled: false }));
    mkdirSync(resolve(resolveCasesDir(), 'surfaces'), { recursive: true });
    ws = workspaceForCase('surfaces').id;
    const stores = new CanvasStores();
    const create = (objectId: string, x: number, y: number, width: number, height: number, content: unknown) =>
      CommandSchema.parse({
        kind: 'create',
        opId: `create-${objectId}`,
        objectId,
        patch: { parentId: null, order: 0, position: { x, y }, size: { width, height }, content },
      });
    expect(
      stores
        .get(ws)
        .append(
          [
            create('note', 0, 0, 200, 100, { type: 'text', text: 'A note in the capture' }),
            create('web', 0, 140, 300, 200, { type: 'embed', url: upstreamUrl, label: 'Web' }),
          ],
          { kind: 'human', userId: 'a' }
        ).ok
    ).toBe(true);
    stores.flush();
    server = new WebServer(0, false, true);
    await server.start();
    origin = `http://localhost:${server.boundPort}`;
    const published = await fetch(`${origin}/api/canvas/${ws}/prototypes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Magenta',
        files: [
          {
            path: 'index.html',
            base64: b64(
              '<!doctype html><html><head><style>html,body{margin:0;height:100%;background:rgb(255,0,255)}</style></head><body><p id="v">proto</p></body></html>'
            ),
          },
        ],
        position: { x: 340, y: 0 },
        size: { width: 360, height: 260 },
      }),
    });
    const body = await published.json();
    expect(published.status, JSON.stringify(body)).toBe(200);
    prototypeId = body.data.objectId;
    browser = await chromium.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: ['--no-sandbox'],
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
    });
    page = await context.newPage();
  }, 90000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    await new Promise<void>((done) => upstream?.close(() => done()));
  }, 60000);

  /** The board's two live frames have drawn their pages. */
  async function framesReady(canvas: Page | Frame) {
    const inFrame = (id: string) => canvas.frameLocator(`[data-object-id="${id}"] .embed-stage iframe`);
    await expect.poll(() => inFrame(prototypeId).locator('#v').textContent(), { timeout: 20000 }).toBe('proto');
    await expect.poll(() => inFrame('web').locator('#w').textContent(), { timeout: 20000 }).toBe('web');
    await page.waitForTimeout(500);
  }

  /** Centres of the note and of both embed stages, in the top page's CSS px; `offset` is a framing canvas's place. */
  async function points(canvas: Page | Frame, offset = { x: 0, y: 0 }): Promise<Point[]> {
    const centre = async (name: string, selector: string) => {
      const r = await canvas.locator(selector).evaluate((el) => el.getBoundingClientRect().toJSON());
      return { name, x: Math.round(offset.x + r.x + r.width / 2), y: Math.round(offset.y + r.y + r.height / 2) };
    };
    return [
      await centre('prototype', `[data-object-id="${prototypeId}"] .embed-stage iframe`),
      await centre('web', '[data-object-id="web"] .embed-stage iframe'),
      await centre('note', '[data-object-id="note"]'),
    ];
  }

  /** The frozen picture's pixels at `at`, after loading the capture scripts into the top page when needed. */
  async function freeze(at: Point[]): Promise<Shot> {
    if (!(await page.evaluate(() => 'CodemanCapture' in window))) {
      await page.addScriptTag({ url: `${origin}/vendor/html-to-image.js` });
      await page.addScriptTag({ url: `${origin}/capture.js` });
    }
    return page.evaluate(async (pts) => {
      const capture = (window as unknown as { CodemanCapture: { freeze(): Promise<{ blob: Blob; frames: never }> } })
        .CodemanCapture;
      const result = await capture.freeze();
      const bitmap = await createImageBitmap(result.blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const pixels = pts.map((p) => Array.from(ctx.getImageData(p.x, p.y, 1, 1).data).slice(0, 3));
      return { frames: result.frames, pixels } as never;
    }, at);
  }

  async function truth(at: Point[]): Promise<Rgb[]> {
    const png = PNG.sync.read(await page.screenshot());
    return at.map((p) => {
      const i = (p.y * png.width + p.x) * 4;
      return [png.data[i], png.data[i + 1], png.data[i + 2]];
    });
  }

  function expectSurfaces(at: Point[], shot: Shot, real: Rgb[]) {
    const pixel = Object.fromEntries(at.map((p, i) => [p.name, shot.pixels[i]]));
    expect(pixel.prototype, 'the prototype frame is in the picture').toSatisfy((p: Rgb) => near(p, MAGENTA));
    expect(pixel.web, 'the web tab frame is in the picture').toSatisfy((p: Rgb) => near(p, CYAN));
    at.forEach((p, i) =>
      expect(shot.pixels[i], `${p.name} matches the browser's own screenshot`).toSatisfy((q: Rgb) => near(q, real[i]))
    );
  }

  it('on the canvas page, both bridged frames answer and are painted in place', async () => {
    await page.goto(`${origin}/canvas/${ws}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(`[data-object-id="${prototypeId}"]`);
    await framesReady(page);
    const at = await points(page);
    const real = await truth(at);
    const shot = await freeze(at);
    if (process.env.CAPTURE_SURFACES_SHOTS)
      await page.screenshot({ path: `${process.env.CAPTURE_SURFACES_SHOTS}/canvas-page.png` });
    const bridged = shot.frames.filter((f) => f.selfReported);
    expect(bridged, JSON.stringify(shot.frames)).toHaveLength(2);
    expect(bridged.every((f) => f.captured && f.depth === 1)).toBe(true);
    expectSurfaces(at, shot, real);
  }, 60000);

  it('on the dashboard, a canvas framed in it gets its embeds from depth 2', async () => {
    // A fresh page, so nothing the canvas page left behind slows the dashboard's start.
    const used = page;
    page = await used.context().newPage();
    await used.close();
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => 'CodemanCapture' in window && 'app' in window, null, { timeout: 30000 });
    await page.evaluate((src) => {
      const f = document.createElement('iframe');
      f.id = 'canvas-frame';
      f.title = 'Canvas';
      f.style.cssText =
        'position:fixed;left:40px;top:60px;width:1200px;height:700px;border:0;z-index:2147483000;background:#fff';
      f.src = src;
      document.body.append(f);
    }, `/canvas/${ws}`);
    const canvas = (await (await page.waitForSelector('#canvas-frame')).contentFrame())!;
    await canvas.waitForSelector(`[data-object-id="${prototypeId}"]`);
    await framesReady(canvas);
    const at = await points(canvas, { x: 40, y: 60 });
    const real = await truth(at);
    const shot = await freeze(at);
    const nested = shot.frames.filter((f) => f.depth === 2 && f.selfReported);
    expect(nested, JSON.stringify(shot.frames)).toHaveLength(2);
    expect(nested.every((f) => f.captured)).toBe(true);
    expectSurfaces(at, shot, real);
  }, 60000);
});
