/**
 * @fileoverview A stored prototype in the real headless renderer: a screenshot draws it as it renders,
 * a check reports what went wrong in it, and neither lets the page reach anything outside its own files.
 */
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkPrototype, renderContainer, stopScreenshotRenders } from '../src/canvas/canvas-screenshot.js';
import { CanvasStore } from '../src/canvas/canvas-store.js';
import { CommandSchema } from '../src/canvas/operations.js';
import { publishPrototype, readPrototypeFile } from '../src/canvas/prototypes.js';
import { dataPath } from '../src/config/instance.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';
import { WebServer } from '../src/web/server.js';
import { human } from './canvas-fixtures.js';

const WS = 'proto-browser';

/** Pixels that are the page's own magenta, which nothing in the canvas chrome uses. */
function magenta(png: Buffer): number {
  const image = PNG.sync.read(png);
  let count = 0;
  for (let i = 0; i < image.data.length; i += 4)
    if (image.data[i] > 240 && image.data[i + 1] < 16 && image.data[i + 2] > 240) count++;
  return count;
}

describe('a stored prototype in the headless renderer', () => {
  let dir: string;
  let outside: http.Server;
  let outsideUrl: string;
  const hits: string[] = [];
  let store: CanvasStore;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'canvas-prototype-browser-'));
    vi.stubEnv('CODEMAN_DATA_DIR', dir);
    // The page under test is this file's own fixture; the sandbox flag is the test host's business.
    writeFileSync(join(dir, 'mermaid-runtime.json'), JSON.stringify({ noSandbox: true }));
    outside = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.end('reached');
    });
    await new Promise<void>((done) => outside.listen(0, '127.0.0.1', done));
    outsideUrl = `http://127.0.0.1:${(outside.address() as AddressInfo).port}`;
    const html = `<!doctype html><html><head><link rel="stylesheet" href="css/site.css"></head>
<body><p id="state">not run</p><script src="app.js"></script></body></html>`;
    const script = `
document.body.style.background = 'rgb(255, 0, 255)';
document.getElementById('state').textContent = 'ran';
console.error('proto-console-error');
fetch(${JSON.stringify(`${outsideUrl}/leak-fetch`)}).catch(() => {});
new Image().src = ${JSON.stringify(`${outsideUrl}/leak-image`)};
fetch('data.json').then((r) => r.json()).then((d) => { if (d.ok !== true) throw new Error('sibling'); });
setTimeout(() => { throw new Error('proto-page-error'); }, 0);
`;
    const file = (path: string, text: string) => ({ path, data: Buffer.from(text) });
    await publishPrototype(
      WS,
      {
        id: 'demo',
        name: 'Demo',
        entry: 'index.html',
        files: [
          file('index.html', html),
          file('app.js', script),
          file('css/site.css', 'html,body{margin:0;height:100%}'),
          file('data.json', '{"ok":true}'),
        ],
        author: human,
      },
      new Set()
    );
    store = new CanvasStore(WS);
    const made = store.append(
      [
        CommandSchema.parse({
          kind: 'create',
          opId: 'section',
          objectId: 'section',
          patch: {
            parentId: null,
            order: 0,
            position: { x: 0, y: 0 },
            size: { width: 600, height: 440 },
            content: { type: 'section', label: 'Prototypes' },
          },
        }),
        CommandSchema.parse({
          kind: 'create',
          opId: 'embed',
          objectId: 'embed',
          patch: {
            parentId: 'section',
            order: 1,
            position: { x: 40, y: 40 },
            size: { width: 480, height: 320 },
            content: { type: 'embed', url: 'https://prototype.invalid/demo/1/index.html', label: 'Demo' },
          },
        }),
      ],
      human
    );
    if (!made.ok) throw new Error(JSON.stringify(made.reasons));
  }, 60_000);

  afterAll(async () => {
    await stopScreenshotRenders();
    await new Promise<void>((done) => outside.close(() => done()));
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('draws the prototype as it renders in a screenshot, and as a card without its files', async () => {
    const live = await renderContainer(store.read(), 'section', {
      readPrototypeFile: (address, path) => readPrototypeFile(WS, address.id, address.version, path),
    });
    // The page's script ran (it sets the colour) and its stylesheet loaded (it fills the frame).
    if (process.env.CANVAS_PROTOTYPE_SHOT) writeFileSync(process.env.CANVAS_PROTOTYPE_SHOT, live.png);
    expect(magenta(live.png)).toBeGreaterThan(480 * 320 * 0.7);
    const card = await renderContainer(store.read(), 'section', {});
    expect(magenta(card.png)).toBe(0);
    expect(hits).toEqual([]);
  }, 90_000);

  it('checks one version alone and reports its errors and the outside requests it refused', async () => {
    const report = await checkPrototype({
      entry: 'index.html',
      width: 400,
      height: 300,
      theme: 'light',
      read: (path) => readPrototypeFile(WS, 'demo', 1, path),
    });
    expect(report.loaded).toBe(true);
    expect(magenta(report.png)).toBeGreaterThan(400 * 300 * 0.9);
    expect(report.consoleErrors.join('\n')).toContain('proto-console-error');
    expect(report.pageErrors.join('\n')).toContain('proto-page-error');
    expect(report.pageErrors.join('\n')).not.toContain('sibling');
    expect(report.failedRequests.join('\n')).toContain(`${outsideUrl}/leak-fetch`);
    expect(report.failedRequests.join('\n')).toContain(`${outsideUrl}/leak-image`);
    expect(hits).toEqual([]);
  }, 90_000);
});

describe('a stored prototype over HTTP, framed the way the canvas frames it', () => {
  const USER = 'prototype-browser-test';
  const PASSWORD = 'prototype-browser-test-password';
  let server: WebServer;
  let browser: Browser;
  let origin: string;
  let workspace: string;

  beforeAll(async () => {
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-canvas-prototype');
    vi.stubEnv('CODEMAN_USERNAME', USER);
    vi.stubEnv('CODEMAN_PASSWORD', PASSWORD);
    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasEnabled: true, canvasShellEnabled: false }));
    mkdirSync(resolve(resolveCasesDir(), 'Prototype case'), { recursive: true });
    workspace = workspaceForCase('Prototype case').id;
    // Mounted under a base path, so the frame address has to carry it.
    server = new WebServer(0, false, true, undefined, undefined, undefined, '/x');
    await server.start();
    origin = `http://localhost:${server.boundPort}`;
    browser = await chromium.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: ['--no-sandbox'],
    });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    vi.unstubAllEnvs();
  }, 60_000);

  it('serves the page to a sandboxed frame with no login, only while a view is open and the embed lives', async () => {
    const context = await browser.newContext({ httpCredentials: { username: USER, password: PASSWORD } });
    const page = await context.newPage();
    const api = `${origin}/x/api/canvas/${workspace}`;
    const b64 = (text: string) => Buffer.from(text).toString('base64');
    try {
      const published = await page.request.post(`${api}/prototypes`, {
        data: {
          name: 'Counter',
          files: [
            {
              path: 'index.html',
              base64: b64(
                '<!doctype html><html><head></head><body><button id="b">0</button><p id="out"></p>' +
                  '<script src="js/app.js"></script></body></html>'
              ),
            },
            {
              path: 'js/app.js',
              base64: b64(
                `const b = document.getElementById('b'); b.onclick = () => { b.textContent = String(+b.textContent + 1); };
                 let cookie = 'readable'; try { void document.cookie; } catch { cookie = 'refused'; }
                 fetch('data.json').then((r) => r.json()).then((d) => {
                   document.getElementById('out').textContent = [d.word, window.origin, cookie].join('|');
                 });`
              ),
            },
            { path: 'data.json', base64: b64('{"word":"sibling"}') },
          ],
        },
      });
      expect(published.status(), await published.text()).toBe(200);
      const { objectId } = (await published.json()).data;

      // No browser has the workspace open: nothing is minted.
      expect((await page.request.post(`${api}/objects/${objectId}/frame`)).status()).toBe(409);
      const view = await page.request.put(`${api}/views/22222222-2222-4222-8222-222222222222`, {
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
      expect(embedUrl).toMatch(/^\/x\/canvas-prototype\/[A-Za-z0-9_-]{32}\/index\.html$/);

      // A client with no login reads the page through the capability and nothing else.
      const anonymous = await fetch(`${origin}${embedUrl}`);
      expect(anonymous.status).toBe(200);
      expect(anonymous.headers.get('content-security-policy')).toContain('sandbox');
      expect(anonymous.headers.get('content-security-policy')).not.toContain('allow-same-origin');
      expect((await fetch(`${api}/prototypes`)).status).toBe(401);
      expect((await fetch(`${origin}${embedUrl}`, { method: 'POST' })).status).toBe(401);

      // The canvas frames it without allow-same-origin; the page runs, is interactive, and reads its own files.
      // Framed from Codeman's own page, as the canvas does (the response refuses any other framer).
      const host = await context.newPage();
      await host.goto(`${origin}/x/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
      await host.evaluate((src) => {
        const frame = document.createElement('iframe');
        frame.id = 'f';
        frame.setAttribute('sandbox', 'allow-scripts allow-forms');
        frame.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:400px;z-index:99999';
        frame.src = src;
        document.body.append(frame);
      }, `${origin}${embedUrl}`);
      const frame = host.frameLocator('#f');
      await expect.poll(() => frame.locator('#out').textContent(), { timeout: 15_000 }).toBe('sibling|null|refused');
      await frame.locator('#b').click();
      await frame.locator('#b').click();
      expect(await frame.locator('#b').textContent()).toBe('2');
      await host.close();

      // Deleting the embed ends the address at once.
      const deleted = await page.request.post(`${api}/command`, {
        data: {
          tool: 'canvas_delete',
          arguments: { operations: [{ kind: 'delete', opId: 'del-proto', objectId }] },
        },
      });
      expect(deleted.status(), await deleted.text()).toBe(200);
      expect((await fetch(`${origin}${embedUrl}`)).status).toBe(401);
    } finally {
      await context.close();
    }
  }, 90_000);
});
