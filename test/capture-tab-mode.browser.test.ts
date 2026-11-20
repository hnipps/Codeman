/**
 * @fileoverview Ambient capture, ticket 7: the tab-capture path of `CodemanCapture.freeze()`
 * (intent/2026-11-20-ambient-capture-tab-mode.md, T1 to T5) on the real dashboard.
 *
 * getDisplayMedia needs the full Chromium binary (the headless shell answers NotSupportedError),
 * so this launches Playwright's `chromium` channel with `--auto-accept-this-tab-capture`, which
 * accepts a preferCurrentTab prompt with this tab. A freeze is started from a button click
 * because the prompt needs user activation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { writeFileSync } from 'node:fs';
import { WebServer } from '../src/web/server.js';
import { dataPath } from '../src/config/instance.js';

type Rgba = [number, number, number, number];
type Shot = { source: string; freezeMs: number; frames: { title: string; captured: boolean }[]; width: number };

declare global {
  interface Window {
    CodemanCapture: { freeze(): Promise<Shot & { blob: Blob; pixelRatio: number }>; stopTabCapture(): void };
    __asks: number;
    __tracks: MediaStreamTrack[];
    __shot: Promise<Shot & { blob: Blob; pixelRatio: number }>;
    __pixel(x: number, y: number): Promise<Rgba>;
  }
}

// The tab stream goes through a video encoder, so colours move by a few tens of levels.
const near = (a: Rgba, b: Rgba, tolerance = 48) => a.slice(0, 3).every((v, i) => Math.abs(v - b[i]) <= tolerance);

describe('capture freeze in tab mode', () => {
  let server: WebServer, browser: Browser, page: Page;

  beforeAll(async () => {
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-capture-tab-mode');
    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasShellEnabled: false }));
    server = new WebServer(0, false, true);
    await server.start();
    browser = await chromium.launch({
      channel: 'chromium',
      args: ['--no-sandbox', '--auto-accept-this-tab-capture'],
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    page = await context.newPage();
  }, 60000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    vi.unstubAllEnvs();
  }, 60000);

  /** Load the dashboard with the setting on or off, counting getDisplayMedia calls and the tracks they return. */
  const load = async (tabMode: boolean, answer: 'real' | 'decline' | 'other-tab' = 'real') => {
    await page.goto(`http://localhost:${server.boundPort}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.CodemanCapture && !!window.app && !!window.htmlToImage);
    await page.waitForTimeout(1500);
    await page.evaluate(
      ([on, mode]) => {
        const settings = { ...window.app.loadAppSettingsFromStorage(), captureTabMode: on };
        localStorage.setItem(window.app.getSettingsStorageKey(), JSON.stringify(settings));
        window.app._cachedAppSettings = settings;
        window.__asks = 0;
        window.__tracks = [];
        const real = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getDisplayMedia = async (options) => {
          window.__asks++;
          if (mode === 'decline') throw new DOMException('Permission denied', 'NotAllowedError');
          const stream = await real(options);
          const track = stream.getVideoTracks()[0];
          if (mode === 'other-tab') track.getCaptureHandle = () => ({ handle: 'another-tab', origin: '' });
          window.__tracks.push(track);
          return stream;
        };
        const btn = document.createElement('button');
        btn.id = 'cap-go';
        btn.style.cssText = 'position:fixed;right:0;bottom:0;width:4px;height:4px;opacity:0;z-index:2147483000';
        btn.onclick = () => (window.__shot = window.CodemanCapture.freeze());
        document.body.appendChild(btn);
      },
      [tabMode, answer] as const
    );
  };

  /** Freeze from a click, decode the PNG, and return the result's summary. */
  const freeze = async (): Promise<Shot> => {
    await page.click('#cap-go');
    return page.evaluate(async () => {
      const result = await window.__shot;
      const bitmap = await createImageBitmap(result.blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bitmap, 0, 0);
      window.__pixel = async (x, y) =>
        [...ctx.getImageData(Math.round(x * result.pixelRatio), Math.round(y * result.pixelRatio), 1, 1).data] as Rgba;
      return {
        source: result.source,
        freezeMs: result.freezeMs,
        frames: result.frames.map(({ title, captured }) => ({ title, captured })),
        width: bitmap.width,
      };
    });
  };
  const pixel = (x: number, y: number) => page.evaluate(([px, py]) => window.__pixel(px, py), [x, y]);
  const asks = () => page.evaluate(() => window.__asks);

  beforeEach(() => vi.setConfig({ testTimeout: 60000 }));

  // Invariant T1: TabModeIsOptIn
  it('never asks for the tab with the setting off', async () => {
    await load(false);
    const shot = await freeze();
    expect(shot.source).toBe('raster');
    expect(await asks()).toBe(0);
  });

  // Invariant T3: OneConsentPerPageLoad
  // Invariant T5: SameResultShape
  it('asks once, then reuses the stream, and draws the page from the tab', async () => {
    await load(true);
    await page.evaluate(() => {
      const el = document.createElement('div');
      el.id = 'cap-mark';
      el.style.cssText =
        'position:fixed;left:300px;top:300px;width:200px;height:120px;background:rgb(255,0,255);z-index:2147483000';
      document.body.appendChild(el);
    });
    const shots = [await freeze(), await freeze(), await freeze()];
    expect(shots.map((s) => s.source)).toEqual(['tab', 'tab', 'tab']);
    expect(await asks()).toBe(1);
    expect(shots[2].width).toBe(1280);
    expect(await pixel(400, 360)).toSatisfy((p: Rgba) => near(p, [255, 0, 255, 255]));

    await page.evaluate(() => (document.getElementById('cap-mark')!.style.background = 'rgb(0,0,255)'));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await freeze();
    expect(await pixel(400, 360), 'a later freeze reads the current page, not a stale frame').toSatisfy((p: Rgba) =>
      near(p, [0, 0, 255, 255])
    );
    await page.evaluate(() => document.getElementById('cap-mark')!.remove());
  });

  // Invariant T3: OneConsentPerPageLoad
  it('asks again after the stream ended, and not after a decline', async () => {
    await load(true);
    await freeze();
    await page.evaluate(() => window.__tracks[0].stop());
    expect((await freeze()).source).toBe('tab');
    expect(await asks()).toBe(2);

    await load(true, 'decline');
    expect((await freeze()).source).toBe('raster');
    expect((await freeze()).source).toBe('raster');
    expect(await asks(), 'a declined prompt is not shown again in the page load').toBe(1);
  });

  // Invariant T2: OnlyThisTab
  it('stops a stream that is not this tab and rasterises instead', async () => {
    await load(true, 'other-tab');
    const shot = await freeze();
    expect(shot.source).toBe('raster');
    expect(await page.evaluate(() => window.__tracks[0].readyState)).toBe('ended');
  });

  // Invariant T4: FreezeComesFirstInTabMode
  it('keeps a held toast in a tab picture and leaves capture UI to the rasteriser', async () => {
    await load(true);
    await freeze();
    const toast = await page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = '.toast{transition:none!important}.toast-error.cap-test{background:rgb(255,0,255)!important}';
      document.head.appendChild(style);
      window.app.showToast('Capture test toast', 'error', { duration: 50 });
      const el = document.querySelector('.toast-container .toast:last-child')!;
      el.classList.add('show', 'cap-test');
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, height: r.height };
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 10)));
    expect((await freeze()).source).toBe('tab');
    expect(await pixel(toast.x + 6, toast.y + toast.height / 2)).toSatisfy((p: Rgba) => near(p, [255, 0, 255, 255]));

    await page.evaluate(() => {
      const el = document.createElement('div');
      el.id = 'cap-ui';
      el.setAttribute('data-codeman-capture', '');
      el.style.cssText =
        'position:fixed;left:40px;top:500px;width:80px;height:80px;background:rgb(0,255,0);z-index:2147483000';
      document.body.appendChild(el);
    });
    expect((await freeze()).source, 'capture UI on screen sends the capture to the rasteriser').toBe('raster');
    await page.evaluate(() => document.getElementById('cap-ui')!.remove());
  });

  // Invariant T5: SameResultShape
  it('marks a sandboxed frame captured, since the browser drew it', async () => {
    await load(true);
    await page.evaluate(async () => {
      const f = document.createElement('iframe');
      f.title = 'sealed';
      f.setAttribute('sandbox', '');
      f.style.cssText = 'position:fixed;left:700px;top:200px;width:200px;height:100px;border:0;z-index:2147483000';
      f.srcdoc = '<body style="margin:0;background:rgb(255,255,0)"></body>';
      document.body.appendChild(f);
      await new Promise((r) => (f.onload = r));
      await new Promise((r) => setTimeout(r, 200));
    });
    const shot = await freeze();
    expect(shot.source).toBe('tab');
    expect(shot.frames.find((f) => f.title === 'sealed')).toEqual({ title: 'sealed', captured: true });
    expect(await pixel(800, 250), 'the sandboxed frame is in the picture').toSatisfy((p: Rgba) =>
      near(p, [255, 255, 0, 255])
    );
  });

  it('measures freeze time after consent', async () => {
    await load(true);
    await freeze();
    const times: number[] = [];
    for (let i = 0; i < 10; i++) times.push((await freeze()).freezeMs);
    times.sort((a, b) => a - b);
    writeFileSync(process.env.CAPTURE_TIMES_OUT || '/dev/null', times.join(','));
    expect(times[Math.ceil(0.95 * times.length) - 1]).toBeLessThan(400);
  });
});
