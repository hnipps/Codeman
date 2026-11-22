/**
 * @fileoverview Ambient capture, ticket 3: the highlight layer on the real dashboard. The overlay opens
 * only after the freeze, an outline drawn on it opens the note panel, Redraw / Escape / Send behave,
 * the `under` reader names what the outline covers, and the marked pictures are the clean picture plus
 * the stored path and nothing else (I2). Device pixel ratio 1.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import puppeteer from 'puppeteer';
import { writeFileSync } from 'node:fs';
import { WebServer } from '../src/web/server.js';
import { dataPath } from '../src/config/instance.js';

type Point = [number, number];
type Bundle = { json: Record<string, unknown>; files: { name: string; blob: Blob }[] };

declare global {
  interface Window {
    CodemanCapture: { freeze(): Promise<{ blob: Blob; pixelRatio: number; width: number; height: number }> };
    CodemanCaptureLayer: {
      open(frozen?: unknown): Promise<boolean>;
      close(): boolean;
      isOpen(): boolean;
      setSender(fn: ((input: { bundle: Bundle; note: string }) => Promise<void>) | null): void;
      drawForTest(points: Point[]): boolean;
      renderMarked(bitmap: ImageBitmap, path: Point[], ratio: number, crop: unknown): Promise<Blob>;
    };
    __frozen: { blob: Blob; pixelRatio: number };
    __sent: { bundle: Bundle; note: string } | null;
  }
}

const square = (x: number, y: number, size: number): Point[] => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size],
];

describe('capture highlight layer on the dashboard', () => {
  let server: WebServer, browser: Browser, page: Page;

  beforeAll(async () => {
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-capture-layer');
    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasShellEnabled: false }));
    server = new WebServer(0, false, true);
    await server.start();
    browser = await chromium.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: ['--no-sandbox'],
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    page = await context.newPage();
    await page.goto(`http://localhost:${server.boundPort}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.CodemanCaptureLayer && !!window.app && !!window.htmlToImage);
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      const el = document.createElement('div');
      el.id = 'cap-target';
      el.className = 'cap-target-box';
      el.textContent = 'Attachment count is off by one';
      el.style.cssText =
        'position:fixed;left:300px;top:300px;width:200px;height:120px;background:rgb(30,90,200);color:#fff;z-index:50';
      document.body.appendChild(el);
    });
  }, 60000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    vi.unstubAllEnvs();
  }, 60000);

  const openFrozen = () =>
    page.evaluate(async () => {
      window.__frozen = await window.CodemanCapture.freeze();
      await window.CodemanCaptureLayer.open(window.__frozen);
    });

  it('opens the overlay after the freeze and shows the hint, not the panel', async () => {
    await openFrozen();
    const shown = await page.evaluate(() => {
      const root = document.querySelector('.capture-layer')!;
      return {
        marked: root.hasAttribute('data-codeman-capture'),
        hint: !(root.querySelector('.capture-hint') as HTMLElement).hidden,
        panel: !(root.querySelector('.capture-panel') as HTMLElement).hidden,
        z: getComputedStyle(root).zIndex,
      };
    });
    expect(shown).toEqual({ marked: true, hint: true, panel: false, z: '10020' });
  });

  it('opens the note panel beside a drawn outline with the note focused, and Redraw clears it', async () => {
    await page.evaluate((path) => window.CodemanCaptureLayer.drawForTest(path), square(280, 280, 240));
    const panel = await page.evaluate(() => {
      const p = document.querySelector('.capture-panel') as HTMLElement;
      const r = p.getBoundingClientRect();
      return { hidden: p.hidden, left: r.left, focused: document.activeElement?.className };
    });
    expect(panel.hidden).toBe(false);
    expect(panel.left).toBeGreaterThanOrEqual(520);
    expect(panel.focused).toBe('capture-note');
    await page.click('.capture-panel button:has-text("Redraw")');
    expect(await page.evaluate(() => (document.querySelector('.capture-panel') as HTMLElement).hidden)).toBe(true);
  });

  it('draws with the pointer: a drag closes into an outline on release', async () => {
    await page.mouse.move(290, 290);
    await page.mouse.down();
    for (const [x, y] of [
      [510, 290],
      [510, 430],
      [290, 430],
      [292, 292],
    ])
      await page.mouse.move(x, y, { steps: 4 });
    await page.mouse.up();
    expect(await page.evaluate(() => (document.querySelector('.capture-panel') as HTMLElement).hidden)).toBe(false);
  });

  it('refuses Send without a sender and keeps the capture', async () => {
    await page.evaluate(() => window.CodemanCaptureLayer.setSender(null));
    await page.click('.capture-panel button:has-text("Send")');
    const status = await page.evaluate(() => document.querySelector('.capture-status')?.textContent);
    expect(status).toMatch(/not available yet/);
    expect(await page.evaluate(() => window.CodemanCaptureLayer.isOpen())).toBe(true);
  });

  it('closes on Escape through the global handler and gives focus back', async () => {
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.CodemanCaptureLayer.isOpen())).toBe(false);
    expect(await page.evaluate(() => document.querySelectorAll('.capture-layer').length)).toBe(0);
  });

  // Invariant I2: LayersStaySeparate
  it('sends clean.png byte for byte and marked pictures that the stored path redraws exactly', async () => {
    await openFrozen();
    await page.evaluate(() => {
      window.__sent = null;
      window.CodemanCaptureLayer.setSender(async (input) => {
        window.__sent = input;
      });
    });
    await page.evaluate((path) => window.CodemanCaptureLayer.drawForTest(path), square(280, 280, 240));
    await page.fill('.capture-note', 'Attachment count is off by one\nSecond line');
    await page.click('.capture-panel button:has-text("Send")');
    await page.waitForFunction(() => !!window.__sent);

    const result = await page.evaluate(async () => {
      const sent = window.__sent!;
      const file = (name: string) => sent.bundle.files.find((f) => f.name === name)!.blob;
      const bytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
      const pixels = async (b: Blob) => {
        const bitmap = await createImageBitmap(b);
        const c = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = c.getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0);
        return { w: bitmap.width, h: bitmap.height, data: ctx.getImageData(0, 0, bitmap.width, bitmap.height).data };
      };
      const same = (a: { w: number; h: number; data: Uint8ClampedArray }, b: typeof a) =>
        a.w === b.w && a.h === b.h && a.data.every((v, i) => v === b.data[i]);

      const frozen = await bytes(window.__frozen.blob);
      const clean = await bytes(file('clean.png'));
      const json = JSON.parse(await file('capture.json').text());
      const cleanBitmap = await createImageBitmap(file('clean.png'));
      const wideAgain = await window.CodemanCaptureLayer.renderMarked(cleanBitmap, json.path, json.dpr, null);
      const cropAgain = await window.CodemanCaptureLayer.renderMarked(cleanBitmap, json.path, json.dpr, json.crop);
      const cleanPx = await pixels(file('clean.png'));
      const widePx = await pixels(file('marked-wide.png'));
      return {
        names: sent.bundle.files.map((f) => f.name),
        note: sent.note,
        cleanIsFrozen: clean.length === frozen.length && clean.every((v, i) => v === frozen[i]),
        wideRedraws: same(widePx, await pixels(wideAgain)),
        cropRedraws: same(await pixels(file('marked-crop.png')), await pixels(cropAgain)),
        wideCarriesMark: !same(widePx, cleanPx),
        crop: json.crop,
        json: { version: json.version, source: json.source, dpr: json.dpr, scale: json.scale, page: json.page },
        under: json.under,
        open: window.CodemanCaptureLayer.isOpen(),
      };
    });

    expect(result.names).toEqual(['clean.png', 'marked-crop.png', 'marked-wide.png', 'capture.json']);
    expect(result.note).toBe('Attachment count is off by one\nSecond line');
    expect(result.cleanIsFrozen, 'clean.png is the frozen blob itself').toBe(true);
    expect(result.wideRedraws, 'marked-wide = clean.png + stored path').toBe(true);
    expect(result.cropRedraws, 'marked-crop = clean.png + stored path, cropped').toBe(true);
    expect(result.wideCarriesMark).toBe(true);
    expect(result.crop).toEqual({ x: 232, y: 232, width: 336, height: 336 });
    expect(result.json).toMatchObject({ version: 1, source: 'dom', dpr: 1, scale: 1 });
    expect(result.json.page).toMatchObject({ path: '/', viewport: { width: 1280, height: 800 } });
    expect(result.under).toContainEqual(
      expect.objectContaining({ kind: 'element', selector: 'div#cap-target', text: 'Attachment count is off by one' })
    );
    expect(JSON.stringify(result.under)).not.toContain('capture-');
    expect(result.open, 'a resolved send closes the overlay').toBe(false);
  });

  it('keeps the capture open with a reason when the sender fails', async () => {
    await openFrozen();
    await page.evaluate(() =>
      window.CodemanCaptureLayer.setSender(async () => {
        throw new Error('server unreachable');
      })
    );
    await page.evaluate((path) => window.CodemanCaptureLayer.drawForTest(path), square(280, 280, 240));
    await page.click('.capture-panel button:has-text("Send")');
    await page.waitForFunction(() => /unreachable/.test(document.querySelector('.capture-status')?.textContent || ''));
    expect(await page.evaluate(() => window.CodemanCaptureLayer.isOpen())).toBe(true);
    await page.click('.capture-panel button:has-text("Cancel")');
    expect(await page.evaluate(() => window.CodemanCaptureLayer.isOpen())).toBe(false);
  });
  it('asks a bridged frame what the outline covers, with at most 1024 points, and keeps its answer', async () => {
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.id = 'cap-bridged';
      frame.title = 'Bridged page';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.style.cssText = 'position:fixed;left:700px;top:300px;width:300px;height:200px;border:0;z-index:50';
      frame.srcdoc =
        '<body><script>addEventListener("message",function(e){var d=e.data;if(!d||d.type!=="codeman:query-polygon")return;' +
        'parent.postMessage({type:"codeman:frame-elements",requestId:d.requestId,' +
        'elements:[{selector:"button.buy",text:"Buy "+d.points.length+" "+d.points[0][0]}]},"*");});<\/script></body>';
      document.body.appendChild(frame);
    });
    await page.waitForTimeout(500);
    await openFrozen();
    const ring: Point[] = Array.from({ length: 2000 }, (_, i) => {
      const a = (i / 2000) * Math.PI * 2;
      return [850 + Math.cos(a) * 120, 400 + Math.sin(a) * 80];
    });
    const under = await page.evaluate(async (path) => {
      window.CodemanCaptureLayer.drawForTest(path);
      return (window.CodemanCaptureLayer as unknown as { readUnder(p: Point[]): Promise<unknown[]> }).readUnder(path);
    }, ring);
    expect(under).toContainEqual({
      kind: 'frame',
      title: 'Bridged page',
      depth: 1,
      elements: [{ selector: 'button.buy', text: 'Buy 1024 270' }],
    });
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.getElementById('cap-bridged')!.remove());
  });
});
