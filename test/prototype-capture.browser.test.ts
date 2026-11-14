/**
 * @fileoverview Prototype capture end to end in a real browser: a tiny app with two states is captured,
 * published, checked alone (no console errors, no request leaves the prototype), and framed the way the
 * canvas frames it, where its hotspot opens the second state and Element Pick picks instead.
 */
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import puppeteer from 'puppeteer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkPrototype, stopScreenshotRenders } from '../src/canvas/canvas-screenshot.js';
import { capturePrototype, type CapturedPrototype } from '../src/canvas/prototype-capture.js';
import { publishPrototype, readPrototypeFile } from '../src/canvas/prototypes.js';
import { dataPath } from '../src/config/instance.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';
import { WebServer } from '../src/web/server.js';
import { human } from './canvas-fixtures.js';

const DOT = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
/** A single-page app: what it shows comes from localStorage and a click, as a real app's would. */
const APP_HTML = `<!doctype html><html><head><title>Fixture app</title>
<link rel="stylesheet" href="/css/site.css"><script>window.booted = true</script></head>
<body><main id="app"></main><script src="/app.js"></script></body></html>`;
const APP_JS = `
const sheet = document.createElement('style'); document.head.append(sheet);
sheet.sheet.insertRule('.title { color: rgb(0, 128, 0); }');
function render() {
  const view = localStorage.getItem('view') || 'none';
  const app = document.getElementById('app');
  if (view === 'home') app.innerHTML = '<h1 class="title">Home</h1><nav><button id="go" type="button">Open settings</button></nav><img alt="dot" src="/img/dot.png" width="16" height="16">';
  else if (view === 'settings') app.innerHTML = '<h1 class="title">Settings</h1><label>Name <input id="name"></label><a href="/elsewhere">Elsewhere</a>';
  else app.innerHTML = '<p>not seeded</p>';
  const go = document.getElementById('go');
  if (go) go.addEventListener('click', () => { localStorage.setItem('view', 'settings'); render(); });
}
render();`;
const SITE_CSS = `@import "theme.css";
body { margin: 0; font-family: Fixture, sans-serif; background: url("../img/dot.png") repeat; }
@font-face { font-family: Fixture; src: url("/fonts/missing.woff2") format("woff2"); }`;

describe('prototype capture in a real browser', () => {
  const USER = 'capture-browser-test';
  const PASSWORD = 'capture-browser-test-password';
  let app: http.Server;
  let appUrl: string;
  let captured: CapturedPrototype;
  let server: WebServer;
  let browser: Browser;
  let origin: string;
  let workspace: string;
  let dir: string;
  const spec = () => ({
    baseUrl: appUrl,
    localStorage: { view: 'home' },
    viewports: [
      { name: 'desktop', width: 900, height: 600 },
      { name: 'phone', width: 390, height: 700, mobile: true },
    ],
    settleMs: 100,
    states: [
      { name: 'home', label: 'Home', steps: [{ goto: '/' }, { waitFor: '#go' }] },
      { name: 'settings', label: 'Settings', from: 'home', steps: [{ click: '#go' }, { type: '#name', text: 'Ada' }] },
    ],
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'prototype-capture-browser-'));
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-prototype-capture');
    vi.stubEnv('CODEMAN_USERNAME', USER);
    vi.stubEnv('CODEMAN_PASSWORD', PASSWORD);
    // The page under test is this file's own fixture; the sandbox flag is the test host's business.
    writeFileSync(dataPath('mermaid-runtime.json'), JSON.stringify({ noSandbox: true }));
    app = http.createServer((req, res) => {
      const send = (type: string, body: string | Buffer) => {
        res.setHeader('content-type', type);
        res.end(body);
      };
      if (req.url === '/app.js') return send('text/javascript', APP_JS);
      if (req.url === '/css/site.css') return send('text/css', SITE_CSS);
      if (req.url === '/css/theme.css') return send('text/css', 'h1 { letter-spacing: 1px; }');
      if (req.url === '/img/dot.png') return send('image/png', DOT);
      if (req.url === '/img/huge.png') return send('image/png', Buffer.alloc(6 * 1024 * 1024));
      if (req.url === '/huge')
        return send('text/html', '<!doctype html><html><body><img src="/img/huge.png"></body></html>');
      if (req.url?.startsWith('/fonts/')) {
        res.statusCode = 404;
        return res.end();
      }
      send('text/html', APP_HTML);
    });
    await new Promise<void>((done) => app.listen(0, '127.0.0.1', done));
    appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}/`;
    captured = await capturePrototype(spec());

    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasEnabled: true, canvasShellEnabled: false }));
    mkdirSync(resolve(resolveCasesDir(), 'Capture case'), { recursive: true });
    workspace = workspaceForCase('Capture case').id;
    server = new WebServer(0, false, true);
    await server.start();
    origin = `http://localhost:${server.boundPort}`;
    browser = await chromium.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: ['--no-sandbox'],
    });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    await stopScreenshotRenders();
    await new Promise<void>((done) => app.close(() => done()));
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('captures every state at every viewport as static pages with local assets and a hotspot', () => {
    const paths = captured.files.map((f) => f.path).sort();
    expect(captured.entry).toBe('desktop/home.html');
    expect(paths).toEqual(
      expect.arrayContaining([
        'desktop/home.html',
        'desktop/settings.html',
        'phone/home.html',
        'phone/settings.html',
        'index.html',
        'capture.json',
      ])
    );
    expect(captured.hotspots).toEqual([{ from: 'home', to: 'settings', selector: '#go' }]);
    // The font the app could not load is reported, not silently dropped.
    expect(captured.warnings.join('\n')).toContain('missing.woff2');
    const page = (path: string) => captured.files.find((f) => f.path === path)!.data.toString('utf8');
    const home = page('desktop/home.html');
    const settings = page('desktop/settings.html');
    expect(home).toContain('<h1 class="title">Home</h1>');
    expect(home).toMatch(/<button id="go" type="button" data-cca-hotspot="settings.html">/);
    expect(settings).toContain('value="Ada"');
    // The app's own scripts are gone; the only script is the capture runtime.
    for (const html of [home, settings]) {
      expect(html.match(/<script/g)).toHaveLength(1);
      expect(html).toContain('<script data-codeman-capture-runtime>');
      expect(html).not.toContain('window.booted');
      expect(html).not.toContain(appUrl);
      expect(html).not.toMatch(/127\.0\.0\.1/);
    }
    // The CSSOM-only rule, the stylesheet and its import all came across; the image is a local file.
    expect(home).toContain('rgb(0, 128, 0)');
    const css = captured.files.filter((f) => f.path.endsWith('.css')).map((f) => f.data.toString('utf8'));
    expect(css.some((text) => text.includes('letter-spacing'))).toBe(true);
    expect(css.join('\n')).not.toMatch(/https?:/);
    expect(captured.files.filter((f) => f.path.endsWith('.png')).length).toBeGreaterThanOrEqual(1);
    expect(home).toMatch(/<img alt="dot" src="\.\.\/assets\/[0-9a-f]{20}\.png"/);
  });

  it('loads a captured page alone with no console error and no request outside its own files', async () => {
    await publishPrototype(workspace, {
      id: 'checked',
      name: 'Checked',
      entry: captured.entry,
      files: captured.files,
      author: human,
    });
    for (const entry of ['desktop/home.html', 'phone/settings.html']) {
      const report = await checkPrototype({
        entry,
        width: 900,
        height: 600,
        theme: 'dark',
        read: (path) => readPrototypeFile(workspace, 'checked', 1, path),
      });
      expect(report.loaded, entry).toBe(true);
      expect(report.consoleErrors, entry).toEqual([]);
      expect(report.pageErrors, entry).toEqual([]);
      expect(report.failedRequests, entry).toEqual([]);
    }
  }, 90_000);

  it('refuses an app whose file breaks a prototype limit, naming the limit', async () => {
    await expect(
      capturePrototype({ baseUrl: appUrl, states: [{ name: 'huge', steps: [{ goto: '/huge' }] }] })
    ).rejects.toThrow(/over the 5 MB limit for one prototype file/);
  }, 60_000);

  it('in a canvas frame, a hotspot opens the next state and Element Pick picks instead of navigating', async () => {
    const context = await browser.newContext({ httpCredentials: { username: USER, password: PASSWORD } });
    const page = await context.newPage();
    const api = `${origin}/api/canvas/${workspace}`;
    try {
      const published = await page.request.post(`${api}/prototypes`, {
        data: {
          name: 'Captured',
          entry: captured.entry,
          files: captured.files.map((f) => ({ path: f.path, base64: f.data.toString('base64') })),
        },
      });
      expect(published.status(), await published.text()).toBe(200);
      const { objectId } = (await published.json()).data;
      const view = await page.request.put(`${api}/views/33333333-3333-4333-8333-333333333333`, {
        data: {
          viewport: { x: 0, y: 0, zoom: 1 },
          selected: [],
          focusId: null,
          rail: [],
          context: [],
          conversationId: null,
          root: null,
          letters: false,
          draftBytes: 0,
          phone: false,
          appliedCommands: [],
        },
      });
      expect(view.status(), await view.text()).toBe(200);
      const minted = await page.request.post(`${api}/objects/${objectId}/frame`);
      expect(minted.status(), await minted.text()).toBe(200);
      const { embedUrl } = (await minted.json()).data;

      const host = await context.newPage();
      const errors: string[] = [];
      // Only the prototype frame's own errors: the canvas page around it is not under test here.
      host.on('console', (message) => {
        if (message.type() === 'error' && message.location().url.includes('/canvas-prototype/'))
          errors.push(message.text());
      });
      await host.goto(`${origin}/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
      await host.evaluate((src) => {
        const w = window as unknown as { __frameMessages: unknown[] };
        w.__frameMessages = [];
        window.addEventListener('message', (e) => w.__frameMessages.push(e.data));
        const frame = document.createElement('iframe');
        frame.id = 'proto';
        // The board's own sandbox for an embed (EMBED_SANDBOX): never allow-same-origin.
        frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-modals allow-downloads');
        frame.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:600px;z-index:99999;background:#fff';
        frame.src = src;
        document.body.append(frame);
      }, `${origin}${embedUrl}`);
      const frame = host.frameLocator('#proto');
      await expect.poll(() => frame.locator('h1').textContent(), { timeout: 15_000 }).toBe('Home');
      const messages = () =>
        host.evaluate(() => (window as unknown as { __frameMessages: { type?: string }[] }).__frameMessages);
      await expect.poll(async () => (await messages()).some((m) => m?.type === 'codeman:frame-ready')).toBe(true);
      // The captured page's own rule still applies.
      expect(await frame.locator('h1').evaluate((el) => getComputedStyle(el).color)).toBe('rgb(0, 128, 0)');

      // Pick mode: the click picks the hotspot element and the page stays on Home.
      await host.evaluate(() =>
        (document.getElementById('proto') as HTMLIFrameElement).contentWindow!.postMessage(
          { type: 'codeman:pick-start' },
          '*'
        )
      );
      await expect.poll(() => frame.locator('[data-codeman-frame-bridge]').count()).toBe(1);
      await frame.locator('#go').click({ force: true });
      await expect
        .poll(async () => (await messages()).find((m) => m?.type === 'codeman:frame-picked'))
        .toMatchObject({ type: 'codeman:frame-picked', element: { selector: '#go', tag: 'button' } });
      await new Promise((r) => setTimeout(r, 500));
      expect(await frame.locator('h1').textContent()).toBe('Home');

      // Out of pick mode, the hotspot opens the second state, served from the same capability.
      await frame.locator('#go').click();
      await expect.poll(() => frame.locator('h1').textContent(), { timeout: 15_000 }).toBe('Settings');
      expect(await frame.locator('#name').inputValue()).toBe('Ada');
      // The page's own link goes nowhere.
      await frame.locator('a').click();
      await new Promise((r) => setTimeout(r, 500));
      expect(await frame.locator('h1').textContent()).toBe('Settings');
      // One switcher, outside the app's body; opening it does not navigate.
      expect(await frame.locator('codeman-capture-switcher').count()).toBe(1);
      expect(await frame.locator('body codeman-capture-switcher').count()).toBe(0);
      await frame.locator('codeman-capture-switcher').click();
      await new Promise((r) => setTimeout(r, 300));
      expect(await frame.locator('h1').textContent()).toBe('Settings');
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120_000);
});
