/**
 * @fileoverview Ambient capture, ticket 1: `CodemanCapture.freeze()` on the real dashboard.
 * Pixels are read back from the frozen PNG in the page, at device pixel ratio 1.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import puppeteer from 'puppeteer';
import { writeFileSync } from 'node:fs';
import { WebServer } from '../src/web/server.js';
import { dataPath } from '../src/config/instance.js';

type Rgba = [number, number, number, number];
type Box = { x: number; y: number; width: number; height: number };

declare global {
  interface Window {
    CodemanCapture: {
      freeze(): Promise<{
        blob: Blob;
        width: number;
        height: number;
        pixelRatio: number;
        freezeMs: number;
        frames: { title: string; box: Box; depth: number; captured: boolean }[];
      }>;
    };
    htmlToImage: { toSvg(node: Element): Promise<string> };
    __capture: { pixel(x: number, y: number): Rgba; region(box: Box): number[]; freezeMs: number };
    __pending: Promise<unknown>;
    __frameShot: Promise<{ frames: { title: string; box: Box; depth: number; captured: boolean }[] }>;
    __settled: boolean;
  }
}

const near = (a: Rgba, b: Rgba, tolerance = 12) => a.slice(0, 3).every((v, i) => Math.abs(v - b[i]) <= tolerance);

describe('capture freeze on the dashboard', () => {
  let server: WebServer, browser: Browser, page: Page;

  beforeAll(async () => {
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-capture-freeze');
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
    await page.waitForFunction(() => !!window.CodemanCapture && !!window.app && !!window.htmlToImage);
    await page.waitForTimeout(1500);
  }, 60000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    vi.unstubAllEnvs();
  }, 60000);

  /** Decode a freeze result into `window.__capture`, read in CSS px. */
  const decode = (resultExpr: string) =>
    page.evaluate(async (expr) => {
      const result = await (0, eval)(expr);
      const bitmap = await createImageBitmap(result.blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const r = result.pixelRatio;
      const at = (x: number, y: number) => {
        const i = (Math.round(y * r) * bitmap.width + Math.round(x * r)) * 4;
        return [data[i], data[i + 1], data[i + 2], data[i + 3]];
      };
      window.__capture = {
        freezeMs: result.freezeMs,
        pixel: at as never,
        region: (box) => {
          const out: number[] = [];
          for (let y = box.y; y < box.y + box.height; y++)
            for (let x = box.x; x < box.x + box.width; x++) out.push(...at(x, y).slice(0, 3));
          return out;
        },
      };
      return { freezeMs: result.freezeMs, width: bitmap.width, height: bitmap.height, ratio: r };
    }, resultExpr);
  const pixel = (x: number, y: number) =>
    page.evaluate(([px, py]) => window.__capture.pixel(px, py), [x, y]) as Promise<Rgba>;

  // Invariant I1: FreezeComesFirst
  it('keeps a toast whose timer runs out during the freeze in the picture, then lets it go', async () => {
    const toast = await page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = '.toast{transition:none!important}.toast-error.cap-test{background:rgb(255,0,255)!important}';
      document.head.appendChild(style);
      window.app.showToast('Capture test toast', 'error', { duration: 50 });
      const el = document.querySelector('.toast-container .toast:last-child')!;
      el.classList.add('show', 'cap-test');
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 10)));
    const shot = await decode('window.CodemanCapture.freeze()');
    expect(shot.freezeMs, 'the toast timer fired while the freeze ran').toBeGreaterThan(50);
    expect(await pixel(toast.x + 6, toast.y + toast.height / 2)).toSatisfy((p: Rgba) => near(p, [255, 0, 255, 255]));
    expect(
      await page.evaluate(() => document.querySelector('.toast.cap-test')?.classList.contains('show') ?? false)
    ).toBe(false);
  });

  // Invariant I1: FreezeComesFirst
  it('leaves capture UI out of the picture', async () => {
    await page.evaluate(() => {
      for (const [id, left, mark] of [
        ['cap-ui', 40, true],
        ['cap-control', 160, false],
      ] as const) {
        const el = document.createElement('div');
        el.id = id;
        if (mark) el.setAttribute('data-codeman-capture', '');
        el.style.cssText = `position:fixed;left:${left}px;top:500px;width:80px;height:80px;background:rgb(0,255,0);z-index:2147483000`;
        document.body.appendChild(el);
      }
    });
    await decode('window.CodemanCapture.freeze()');
    const green: Rgba = [0, 255, 0, 255];
    expect(near(await pixel(200, 540), green), 'an unmarked element is painted').toBe(true);
    expect(near(await pixel(80, 540), green), 'a [data-codeman-capture] element is not').toBe(false);
    await page.evaluate(() => ['cap-ui', 'cap-control'].forEach((id) => document.getElementById(id)!.remove()));
  });

  // Invariant I1: FreezeComesFirst
  it('keeps a hover colour when the pointer leaves before the freeze resolves', async () => {
    await page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent =
        '#cap-hover{position:fixed;left:400px;top:500px;width:120px;height:60px;background:rgb(0,0,255);border:0;z-index:2147483000}' +
        '#cap-hover:hover{background:rgb(255,128,0)}';
      document.head.appendChild(style);
      const btn = document.createElement('button');
      btn.id = 'cap-hover';
      document.body.appendChild(btn);
    });
    await page.mouse.move(460, 530);
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('cap-hover')!).backgroundColor)).toBe(
      'rgb(255, 128, 0)'
    );
    await page.evaluate(() => {
      window.__settled = false;
      window.__pending = window.CodemanCapture.freeze().then((r) => ((window.__settled = true), r));
    });
    await page.mouse.move(5, 795);
    expect(await page.evaluate(() => window.__settled), 'the pointer left before the freeze resolved').toBe(false);
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('cap-hover')!).backgroundColor)).toBe(
      'rgb(0, 0, 255)'
    );
    await decode('window.__pending');
    expect(await pixel(460, 530)).toSatisfy((p: Rgba) => near(p, [255, 128, 0, 255]));
    await page.evaluate(() => document.getElementById('cap-hover')!.remove());
  });

  it('paints same-origin frames at their content box to depth 2 and records unreadable ones', async () => {
    const layout = await page.evaluate(async () => {
      const wrap = document.createElement('div');
      wrap.id = 'cap-frames';
      wrap.style.cssText = 'position:fixed;left:40px;top:120px;z-index:2147483000;background:#fff;width:300px';
      const frame = (title: string, html: string, sandbox?: string) => {
        const f = document.createElement('iframe');
        f.title = title;
        if (sandbox !== undefined) f.setAttribute('sandbox', sandbox);
        f.style.cssText =
          'display:block;box-sizing:content-box;width:200px;height:100px;border:3px solid rgb(0,0,0);margin:0';
        f.srcdoc = html;
        wrap.appendChild(f);
        return new Promise<void>((ok) => (f.onload = () => ok()));
      };
      const inner = '<body style="margin:0;background:rgb(0,255,255)"></body>';
      const loaded = [
        frame(
          'outer',
          '<body style="margin:0;background:rgb(255,255,0)"><iframe title="inner" style="position:absolute;left:20px;top:20px;width:60px;height:40px;border:0" srcdoc=\'' +
            inner +
            "'></iframe></body>"
        ),
        frame('sealed', '<body style="background:rgb(255,0,255)"></body>', ''),
      ];
      const marker = document.createElement('div');
      marker.style.cssText = 'height:20px;background:rgb(255,0,0)';
      wrap.appendChild(marker);
      document.body.appendChild(wrap);
      await Promise.all(loaded);
      await new Promise((r) => setTimeout(r, 200));
      const r = (el: Element) => el.getBoundingClientRect();
      return { outer: r(wrap.children[0]), marker: r(marker) };
    });
    await decode('(window.__frameShot = window.CodemanCapture.freeze())');
    const frames = await page.evaluate(async () => (await window.__frameShot).frames);
    const { outer, marker } = layout;
    expect(frames.filter((f) => ['outer', 'inner', 'sealed'].includes(f.title))).toEqual([
      { title: 'outer', box: { x: outer.x + 3, y: outer.y + 3, width: 200, height: 100 }, depth: 1, captured: true },
      { title: 'inner', box: { x: outer.x + 23, y: outer.y + 23, width: 60, height: 40 }, depth: 2, captured: true },
      { title: 'sealed', box: expect.any(Object), depth: 1, captured: false },
    ]);
    expect(await pixel(outer.x + 150, outer.y + 80)).toSatisfy((p: Rgba) => near(p, [255, 255, 0, 255]));
    expect(await pixel(outer.x + 3 + 50, outer.y + 3 + 40)).toSatisfy((p: Rgba) => near(p, [0, 255, 255, 255]));
    expect(await pixel(outer.x + 1, outer.y + 50), 'the frame keeps its border').toSatisfy((p: Rgba) =>
      near(p, [0, 0, 0, 255])
    );
    expect(await pixel(marker.x + 100, marker.y + 10), 'content after a frame keeps its place').toSatisfy((p: Rgba) =>
      near(p, [255, 0, 0, 255])
    );
    await page.evaluate(() => document.getElementById('cap-frames')!.remove());
  });

  // Invariant I3: NoPasswordLeavesThePage
  it('masks a password value in the cloned markup and in the picture', async () => {
    const SECRET = 'hunter2xyz';
    const boxes = await page.evaluate((secret) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;left:600px;top:200px;z-index:2147483000;background:#fff;padding:8px';
      const make = (type: string, value: string) => {
        const input = document.createElement('input');
        input.type = type;
        input.value = value;
        input.style.cssText =
          'display:block;width:220px;height:28px;margin:4px 0;padding:0 6px;border:0;outline:0;font:16px monospace;color:#000;background:#fff;caret-color:transparent';
        wrap.appendChild(input);
        return input;
      };
      const password = make('password', secret);
      const bullets = make('text', '•'.repeat(secret.length));
      const plain = make('text', secret);
      wrap.id = 'cap-inputs';
      document.body.appendChild(wrap);
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
      };
      return { password: box(password), bullets: box(bullets), plain: box(plain) };
    }, SECRET);

    const svg = await page.evaluate(async () => {
      const solo = document.createElement('div');
      solo.appendChild(document.querySelector('#cap-inputs input[type=password]')!.cloneNode());
      (solo.firstChild as HTMLInputElement).value = (
        document.querySelector('#cap-inputs input[type=password]') as HTMLInputElement
      ).value;
      document.body.appendChild(solo);
      try {
        return decodeURIComponent((await window.htmlToImage.toSvg(solo)).split(',').slice(1).join(','));
      } finally {
        solo.remove();
      }
    });
    expect(svg).not.toContain(SECRET);
    expect(svg.match(/value="([^"]*)"/)?.[1]).toBe('•'.repeat(SECRET.length));

    await decode('window.CodemanCapture.freeze()');
    const region = (box: Box) => page.evaluate((b) => window.__capture.region(b), box);
    const [password, bullets, plain] = await Promise.all([
      region(boxes.password),
      region(boxes.bullets),
      region(boxes.plain),
    ]);
    const meanDiff = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;
    expect(meanDiff(password, bullets), 'the password box renders as the same count of bullets').toBeLessThan(0.5);
    expect(meanDiff(password, plain), 'and not as the plain string').toBeGreaterThan(5);
    await page.evaluate(() => document.getElementById('cap-inputs')!.remove());
  });
});
