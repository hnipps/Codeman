/**
 * @fileoverview Ambient capture, ticket 2: a sandboxed frame rasterises itself through the frame bridge,
 * and the dashboard's `CodemanCapture.freeze()` paints the answer into place only when it passes I8.
 * Frame pages are served by Playwright routes on the dashboard's own origin and framed with the canvas
 * sandbox (no `allow-same-origin`), so the parent cannot read them. Pixels are read at ratio 1.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import puppeteer from 'puppeteer';
import { writeFileSync } from 'node:fs';
import { WebServer } from '../src/web/server.js';
import { dataPath } from '../src/config/instance.js';
import { injectFrameBridge } from '../src/canvas/frame-bridge.js';
import { CAPTURE_RASTERISER_SCRIPT } from '../src/canvas/capture-rasteriser.js';

type Rgba = [number, number, number, number];
type Box = { x: number; y: number; width: number; height: number };
type Frame = { title: string; box: Box; depth: number; captured: boolean; selfReported: boolean };

declare global {
  interface Window {
    CodemanCapture: { freeze(): Promise<{ blob: Blob; pixelRatio: number; freezeMs: number; frames: Frame[] }> };
    htmlToImage: { toCanvas: (...args: unknown[]) => Promise<HTMLCanvasElement> };
    __shot: { frames: Frame[]; freezeMs: number; pixels: Record<string, Rgba> };
  }
}

const near = (a: Rgba, b: number[], tolerance = 12) => a.slice(0, 3).every((v, i) => Math.abs(v - b[i]) <= tolerance);
const PLACEHOLDER = [
  [0x2a, 0x2b, 0x3a],
  [0x24, 0x25, 0x3a],
];
const isPlaceholder = (p: Rgba) => PLACEHOLDER.some((c) => near(p, c, 4));

/** A page that answers `codeman:capture` itself with a picture made by `make(width, height)`. */
const liar = (make: string) => `<!doctype html><html><head><script>
addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.type !== 'codeman:capture') return;
  const c = document.createElement('canvas');
  const url = (${make})(c, d.width, d.height);
  e.source.postMessage({ type: 'codeman:frame-capture', requestId: d.requestId, dataUrl: url }, '*');
});
</script></head><body style="margin:0;background:rgb(255,0,255)"></body></html>`;

const PAGES: Record<string, string> = {
  good: injectFrameBridge(
    '<!doctype html><html><head></head><body style="margin:0;background:rgb(0,200,0)"><div style="width:40px;height:40px;background:rgb(0,0,255)"></div></body></html>'
  ),
  jpeg: liar(
    "(c, w, h) => { c.width = w; c.height = h; const x = c.getContext('2d'); x.fillStyle = 'rgb(255,0,255)'; x.fillRect(0, 0, w, h); return c.toDataURL('image/jpeg'); }"
  ),
  big: liar(
    "(c, w, h) => { c.width = w * 3; c.height = h * 3; const x = c.getContext('2d'); x.fillStyle = 'rgb(255,0,255)'; x.fillRect(0, 0, c.width, c.height); return c.toDataURL('image/png'); }"
  ),
  silent: '<!doctype html><html><head></head><body style="margin:0;background:rgb(255,0,255)"></body></html>',
};

describe('capture through the frame bridge (I8 FramePicturesAreUntrusted)', () => {
  let server: WebServer, browser: Browser, page: Page;

  beforeAll(async () => {
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-capture-frame-bridge');
    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasShellEnabled: false }));
    server = new WebServer(0, false, true);
    await server.start();
    browser = await chromium.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: ['--no-sandbox'],
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    page = await context.newPage();
    await page.route('**/__capture-frames/*', (route) => {
      const name = new URL(route.request().url()).pathname.split('/').pop()!;
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGES[name] ?? '' });
    });
    await page.goto(`http://localhost:${server.boundPort}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.CodemanCapture && !!window.app && !!window.htmlToImage);
    await page.waitForTimeout(1500);
  }, 60000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    vi.unstubAllEnvs();
  }, 60000);

  it('ships the rasteriser with the bridge', () => {
    expect(CAPTURE_RASTERISER_SCRIPT.length).toBeGreaterThan(10_000);
    expect(PAGES.good).toContain(CAPTURE_RASTERISER_SCRIPT);
  });

  // Invariant I8: FramePicturesAreUntrusted
  it('paints an honest frame in its box and every other answer as "Frame not captured", 500 ms after the rest', async () => {
    await page.evaluate(async (names) => {
      const wrap = document.createElement('div');
      wrap.id = 'cap-bridge';
      wrap.style.cssText = 'position:fixed;left:0;top:0;width:1280px;height:800px;z-index:2147483000;background:#fff';
      const loaded = names.map((name, i) => {
        const f = document.createElement('iframe');
        f.title = name;
        f.setAttribute('sandbox', 'allow-scripts');
        f.style.cssText = `position:absolute;left:${100 + i * 260}px;top:300px;width:200px;height:100px;border:0`;
        f.src = `/__capture-frames/${name}`;
        wrap.appendChild(f);
        return new Promise((r) => f.addEventListener('load', r, { once: true }));
      });
      document.body.appendChild(wrap);
      await Promise.all(loaded);
      await new Promise((r) => setTimeout(r, 300));
      // The top document's own raster takes seconds on the dashboard; a blank stand-in settles at once, so the
      // freeze takes only the frames' 500 ms.
      window.htmlToImage.toCanvas = async (...args: unknown[]) => {
        const o = args[1] as { width: number; height: number; pixelRatio: number };
        const c = document.createElement('canvas');
        c.width = Math.round(o.width * o.pixelRatio);
        c.height = Math.round(o.height * o.pixelRatio);
        const x = c.getContext('2d')!;
        x.fillStyle = '#fff';
        x.fillRect(0, 0, c.width, c.height);
        return c;
      };
      const result = await window.CodemanCapture.freeze();
      const bitmap = await createImageBitmap(result.blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const at = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data) as Rgba;
      const pixels: Record<string, Rgba> = {};
      names.forEach((name, i) => {
        const left = 100 + i * 260;
        pixels[`${name}:inside`] = at(left + 150, 380);
        pixels[`${name}:corner`] = at(left + 20, 320);
        pixels[`${name}:corner2`] = at(left + 4, 304);
        pixels[`${name}:outside`] = at(left + 230, 350);
        pixels[`${name}:below`] = at(left + 100, 420);
      });
      window.__shot = { frames: result.frames, freezeMs: result.freezeMs, pixels };
    }, Object.keys(PAGES));

    const { frames, freezeMs, pixels } = await page.evaluate(() => window.__shot);
    const byTitle = Object.fromEntries(frames.map((f) => [f.title, f]));
    expect(byTitle.good).toMatchObject({ captured: true, selfReported: true, box: { width: 200, height: 100 } });
    for (const name of ['jpeg', 'big', 'silent'])
      expect(byTitle[name], name).toMatchObject({ captured: false, selfReported: false });

    expect(pixels['good:inside'], 'the frame body').toSatisfy((p: Rgba) => near(p, [0, 200, 0]));
    expect(pixels['good:corner'], 'the frame content').toSatisfy((p: Rgba) => near(p, [0, 0, 255]));
    for (const name of ['jpeg', 'big', 'silent']) {
      for (const at of ['corner', 'corner2'])
        expect(pixels[`${name}:${at}`], `${name} is a placeholder`).toSatisfy(isPlaceholder);
      expect(pixels[`${name}:inside`], `${name} never shows its own pixels`).not.toSatisfy((p: Rgba) =>
        near(p, [255, 0, 255])
      );
    }
    for (const name of Object.keys(PAGES)) {
      expect(pixels[`${name}:outside`], `${name} paints nothing beside its box`).toSatisfy((p: Rgba) =>
        near(p, [255, 255, 255])
      );
      expect(pixels[`${name}:below`], `${name} paints nothing under its box`).toSatisfy((p: Rgba) =>
        near(p, [255, 255, 255])
      );
    }
    expect(freezeMs, 'a silent frame costs the freeze at most 500 ms').toBeLessThan(800);
    expect(freezeMs).toBeGreaterThanOrEqual(480);
  }, 30000);
});
