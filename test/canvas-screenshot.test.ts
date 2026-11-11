import Fastify from 'fastify';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasStores } from '../src/canvas/canvas-store.js';
import {
  DOCUMENT_URL,
  SCREENSHOT_FAILED_MESSAGE,
  SCREENSHOT_MISCONFIGURED_MESSAGE,
  ScreenshotAborted,
  ScreenshotNotFound,
  ScreenshotTimeout,
  ScreenshotUnavailable,
  assetUrl,
  buildShotDocument,
  classifyShotRequest,
  clipFor,
  decodeStoredImage,
  fitClip,
  handleShotRequest,
  liveScreenshotBrowserPids,
  renderContainer,
  shotModel,
  stopScreenshotRenders,
  type HeadlessBrowser,
  type HeadlessPage,
  type ShotRequest,
} from '../src/canvas/canvas-screenshot.js';
import { canvasToolNames } from '../src/canvas/commands.js';
import { emptyState, type CanvasObject, type CanvasState } from '../src/canvas/model.js';
import { CommandSchema } from '../src/canvas/operations.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { deployRole } from '../src/deploy-role.js';
import { registerCanvasRoutes } from '../src/web/routes/canvas-routes.js';
import { readable, type ViewObject } from '../packages/canvas/src/model.js';
import { create, human } from './canvas-fixtures.js';

const { launchHeadlessBrowser } = vi.hoisted(() => ({ launchHeadlessBrowser: vi.fn() }));
vi.mock('../src/headless-browser.js', () => ({ launchHeadlessBrowser }));

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const DATA_PNG = `data:image/png;base64,${PNG.toString('base64')}`;
const bundles = async () => ({ css: ':root{--canvas:#111}', script: 'void 0' });

function record(
  id: string,
  parentId: string | null,
  type: string,
  content: CanvasObject['content'],
  size: { width: number; height: number } | null = { width: 100, height: 80 },
  position: { x: number; y: number } = { x: 10, y: 20 }
): CanvasObject {
  return {
    id,
    type,
    parentId,
    order: 0,
    position,
    size,
    rotation: 0,
    lock: null,
    content,
    author: human,
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    deletedAt: null,
    deletionOpId: null,
  };
}

function stateOf(objects: CanvasObject[]): CanvasState {
  return { seq: 1, objects: Object.fromEntries(objects.map((object) => [object.id, object])), comments: [] };
}

const section = () =>
  stateOf([
    record('section', null, 'section', { type: 'section', label: 'Notes' }),
    record('a', 'section', 'text', { type: 'text', text: 'alpha' }),
  ]);

interface FakeCall {
  request: ShotRequest;
  respond: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
}

function request(url: string, resourceType: string, navigation: boolean): FakeCall {
  const respond = vi.fn(async () => undefined);
  const abort = vi.fn(async () => undefined);
  return {
    respond,
    abort,
    request: {
      url: () => url,
      resourceType: () => resourceType,
      isNavigationRequest: () => navigation,
      respond,
      abort,
    },
  };
}

function browser(options: {
  png?: Buffer;
  screenshot?: () => Promise<Uint8Array>;
  pid?: number;
  close?: () => Promise<void>;
  onGoto?: (handler: (request: ShotRequest) => void) => void;
}): { browser: HeadlessBrowser; viewport: { deviceScaleFactor?: number } } {
  const viewport: { deviceScaleFactor?: number } = {};
  let handler: (request: ShotRequest) => void = () => undefined;
  const page: HeadlessPage = {
    async setViewport(next) {
      viewport.deviceScaleFactor = next.deviceScaleFactor;
    },
    async setCacheEnabled() {},
    async setRequestInterception() {},
    on(_event, next) {
      handler = next;
    },
    async goto() {
      options.onGoto?.(handler);
    },
    async evaluate() {
      return undefined;
    },
    async screenshot() {
      if (options.screenshot) return options.screenshot();
      return options.png ?? PNG;
    },
  };
  let closed = false;
  return {
    viewport,
    browser: {
      async newPage() {
        return page;
      },
      async close() {
        closed = true;
        await options.close?.();
      },
      process: () => (options.pid ? { pid: options.pid } : null),
      closed: () => closed,
    } as HeadlessBrowser & { closed: () => boolean },
  };
}

const children: ChildProcess[] = [];
function sleeper(): ChildProcess {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  children.push(child);
  return child;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-shot-'));
  vi.stubEnv('CODEMAN_DATA_DIR', dir);
  vi.stubEnv('CODEMAN_MULTIUSER', '0');
  deployRole.enter('live');
  launchHeadlessBrowser.mockReset();
});
afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.length = 0;
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('canvas screenshot geometry and hostile page', () => {
  it('clips world bounds with a 48px margin and scales only past 4096', () => {
    const placed = section();
    const fit = shotModel(placed, 'section').fit;
    expect(fit.clip).toEqual(clipFor({ x: 10, y: 20, width: 100, height: 80 }));
    expect(fit.clip).toEqual({ x: -38, y: -28, width: 196, height: 176 });
    expect(fit.scaled).toBe(false);
    expect(fitClip({ x: 0, y: 0, width: 4096, height: 10 }).scaled).toBe(false);
    const wide = stateOf([
      record(
        'section',
        null,
        'section',
        { type: 'section', label: 'Wide' },
        { width: 5000, height: 100 },
        { x: 0, y: 0 }
      ),
    ]);
    const scaled = shotModel(wide, 'section').fit;
    expect(scaled.scaled).toBe(true);
    expect(scaled.width).toBe(4096);
    expect(scaled.scale).toBeCloseTo(4096 / scaled.clip.width);
    expect(scaled.height).toBe(Math.max(1, Math.floor(scaled.clip.height * scaled.scale)));
  });

  it('renders a non-container alone, drops a deleted child, and 404s an unknown or deleted root', () => {
    const model = shotModel(section(), 'a');
    expect(model.objects.map((object) => object.id)).toEqual(['a']);
    expect(model.objects[0]?.parentId).toBeNull();
    expect(model.objects[0]?.position).toEqual({ x: 20, y: 40 });
    const deletedChild = section();
    deletedChild.objects.a!.deletedAt = 5;
    expect(shotModel(deletedChild, 'section').objects.map((object) => object.id)).toEqual(['section']);
    expect(() => shotModel(section(), 'missing')).toThrow(ScreenshotNotFound);
    const deleted = section();
    deleted.objects.section!.deletedAt = 5;
    expect(() => shotModel(deleted, 'section')).toThrow(ScreenshotNotFound);
    const empty = stateOf([record('group', null, 'group', { type: 'group', label: 'Empty' }, null)]);
    expect(shotModel(empty, 'group').fit.width).toBe(97);
    expect(shotModel(empty, 'group').fit.height).toBe(97);
  });

  it('screenshots five thousand descendants without a browser', () => {
    const objects = [
      record(
        'section',
        null,
        'section',
        { type: 'section', label: 'Bulk' },
        { width: 400, height: 400 },
        { x: 0, y: 0 }
      ),
    ];
    for (let index = 0; index < 5000; index++) {
      objects.push(
        record(
          `t${index}`,
          'section',
          'text',
          { type: 'text', text: `row ${index}` },
          { width: 20, height: 10 },
          { x: index % 50, y: Math.floor(index / 50) }
        )
      );
    }
    const started = Date.now();
    const model = shotModel(stateOf(objects), 'section');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(model.objects).toHaveLength(5001);
    expect(launchHeadlessBrowser).not.toHaveBeenCalled();
  });

  it('refuses an outside image and keeps markup as text', () => {
    const hostile = stateOf([
      record('section', null, 'section', { type: 'section', label: 'Hostile' }),
      record('note', 'section', 'text', { type: 'text', text: '<img src="https://evil.example/leak.png">' }),
      record('remote', 'section', 'image', { type: 'image', url: 'https://evil.example/leak.png', alt: 'remote' }),
      record('pic', 'section', 'image', { type: 'image', url: DATA_PNG, alt: 'dot' }),
      record('embed', 'section', 'embed', { type: 'embed', url: 'https://videos.example/clip' }),
    ]);
    expect(decodeStoredImage('https://evil.example/leak.png')).toBeNull();
    expect(decodeStoredImage('data:image/svg+xml;base64,AAAA')).toBeNull();
    expect(decodeStoredImage(DATA_PNG)?.bytes.equals(PNG)).toBe(true);
    const model = shotModel(hostile, 'section');
    expect([...model.assets.keys()]).toEqual(['pic']);
    const html = buildShotDocument(model, 'css', 'script', 'dark');
    expect(html).not.toContain('<img');
    expect(html).toContain('\\u003cimg');
    expect(html).not.toContain('data-theme');
    expect(buildShotDocument(model, 'css', 'script', 'light')).toContain('data-theme="light"');
    expect(classifyShotRequest('https://evil.example/leak.png', 'image', new Set(['pic']))).toBe('refuse');
    expect(classifyShotRequest(assetUrl('pic'), 'image', new Set(['pic']))).toBe('asset');
    expect(classifyShotRequest(assetUrl('pic'), 'document', new Set(['pic']))).toBe('refuse');
    const embed = model.objects.find((object) => object.id === 'embed') as ViewObject;
    expect(readable(embed)).toBe('Embed · https://videos.example/clip');
    const calls = [
      request(DOCUMENT_URL, 'document', true),
      request('https://evil.example/leak.png', 'image', false),
      request(assetUrl('pic'), 'image', true),
      request(assetUrl('pic'), 'image', false),
    ];
    for (const call of calls) handleShotRequest(call.request, html, model.assets);
    expect(calls[0]?.respond).toHaveBeenCalledOnce();
    expect(calls[1]?.abort).toHaveBeenCalledOnce();
    expect(calls[2]?.abort).toHaveBeenCalledOnce();
    expect(calls[3]?.respond).toHaveBeenCalledOnce();
    const body = calls[3]?.respond.mock.calls[0]?.[0].body as Buffer;
    expect(body.equals(PNG)).toBe(true);
  });
});

describe('canvas screenshot lifetime', () => {
  it('runs one render at a time and does not launch a caller that already timed out', async () => {
    let release: (png: Buffer) => void = () => undefined;
    const held = new Promise<Buffer>((resolve) => {
      release = resolve;
    });
    let shots = 0;
    const opened = browser({ screenshot: () => held });
    const launch = vi.fn(async () => {
      shots += 1;
      return opened.browser;
    });
    const placed = section();
    const first = renderContainer(placed, 'section', { launch, readAssets: bundles, timeoutMs: 5000 });
    await vi.waitUntil(() => shots === 1);
    const second = renderContainer(placed, 'section', { launch, readAssets: bundles, timeoutMs: 40 });
    await expect(second).rejects.toBeInstanceOf(ScreenshotTimeout);
    await expect(second).rejects.toThrow('Canvas screenshot timed out after 20 seconds.');
    expect(shots).toBe(1);
    release(PNG);
    const rendered = await first;
    expect(rendered.png.equals(PNG)).toBe(true);
    expect(rendered.meta.scaled).toBe(false);
    expect(opened.viewport.deviceScaleFactor).toBe(1);
    expect(shots).toBe(1);
  });

  it('kills a browser process that survives close on timeout and on a thrown paint', async () => {
    const timeoutChild = sleeper();
    const timeoutExit = new Promise<NodeJS.Signals | null>((resolve) => {
      timeoutChild.once('exit', (_code, signal) => resolve(signal));
    });
    const hanging = browser({
      pid: timeoutChild.pid,
      screenshot: () => new Promise<Uint8Array>(() => undefined),
      close: async () => undefined,
    });
    await expect(
      renderContainer(section(), 'section', {
        launch: async () => hanging.browser,
        readAssets: bundles,
        timeoutMs: 50,
      })
    ).rejects.toBeInstanceOf(ScreenshotTimeout);
    expect(await timeoutExit).toBe('SIGKILL');
    expect(liveScreenshotBrowserPids()).toEqual([]);

    const thrownChild = sleeper();
    const thrownExit = new Promise<NodeJS.Signals | null>((resolve) => {
      thrownChild.once('exit', (_code, signal) => resolve(signal));
    });
    const exploding = browser({
      pid: thrownChild.pid,
      screenshot: async () => {
        throw new Error('paint exploded');
      },
      close: async () => undefined,
    });
    await expect(
      renderContainer(section(), 'section', {
        launch: async () => exploding.browser,
        readAssets: bundles,
        timeoutMs: 2000,
      })
    ).rejects.toThrow('paint exploded');
    expect(await thrownExit).toBe('SIGKILL');
    expect(liveScreenshotBrowserPids()).toEqual([]);
  });

  it('launches the next render after a close that never settles and leaves no browser pid', async () => {
    const child = sleeper();
    const exit = new Promise<NodeJS.Signals | null>((resolve) => {
      child.once('exit', (_code, signal) => resolve(signal));
    });
    const hanging = browser({
      pid: child.pid,
      screenshot: async () => {
        throw new Error('paint exploded');
      },
      close: () => new Promise<void>(() => undefined),
    });
    const next = browser({});
    const launch = vi.fn();
    launch.mockResolvedValueOnce(hanging.browser).mockResolvedValueOnce(next.browser);
    const first = renderContainer(section(), 'section', { launch, readAssets: bundles, timeoutMs: 8000 });
    const second = renderContainer(section(), 'section', { launch, readAssets: bundles, timeoutMs: 8000 });
    await expect(first).rejects.toThrow('paint exploded');
    await expect((await second).png.equals(PNG)).toBe(true);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(await exit).toBe('SIGKILL');
    expect(liveScreenshotBrowserPids()).toEqual([]);
  });

  it('kills the browser on shutdown when close never settles', async () => {
    const child = sleeper();
    const exit = new Promise<NodeJS.Signals | null>((resolve) => {
      child.once('exit', (_code, signal) => resolve(signal));
    });
    let started: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      started = resolve;
    });
    const hanging = browser({
      pid: child.pid,
      screenshot: () => {
        started();
        return new Promise<Uint8Array>(() => undefined);
      },
      close: () => new Promise<void>(() => undefined),
    });
    const pending = renderContainer(section(), 'section', {
      launch: async () => hanging.browser,
      readAssets: bundles,
      timeoutMs: 8000,
    });
    await gate;
    await stopScreenshotRenders();
    await expect(pending).rejects.toBeInstanceOf(ScreenshotAborted);
    expect(await exit).toBe('SIGKILL');
    expect(liveScreenshotBrowserPids()).toEqual([]);
    const rendered = await renderContainer(section(), 'section', {
      launch: async () => browser({}).browser,
      readAssets: bundles,
      timeoutMs: 2000,
    });
    expect(rendered.png.equals(PNG)).toBe(true);
  });

  it('kills the browser when the caller aborts and close never settles', async () => {
    const child = sleeper();
    const exit = new Promise<NodeJS.Signals | null>((resolve) => {
      child.once('exit', (_code, signal) => resolve(signal));
    });
    let started: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      started = resolve;
    });
    const hanging = browser({
      pid: child.pid,
      screenshot: () => {
        started();
        return new Promise<Uint8Array>(() => undefined);
      },
      close: () => new Promise<void>(() => undefined),
    });
    const controller = new AbortController();
    const pending = renderContainer(section(), 'section', {
      launch: async () => hanging.browser,
      readAssets: bundles,
      timeoutMs: 8000,
      signal: controller.signal,
    });
    await gate;
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(ScreenshotAborted);
    expect(await exit).toBe('SIGKILL');
    expect(liveScreenshotBrowserPids()).toEqual([]);
  });

  it('names mermaid setup when Chromium is missing and the canvas build when the bundle is missing', async () => {
    await expect(
      renderContainer(section(), 'section', {
        launch: async () => {
          throw new Error('Could not find Chrome (ver. 1)');
        },
        readAssets: bundles,
        timeoutMs: 1000,
      })
    ).rejects.toThrow('No headless browser is available. Run codeman mermaid setup.');
    await expect(
      renderContainer(section(), 'a', {
        launch: async () => {
          throw new Error('Browser launch intercepted');
        },
        readAssets: bundles,
        timeoutMs: 1000,
      })
    ).rejects.toThrow('Browser launch intercepted');
    await expect(renderContainer(emptyState(), 'missing', { readAssets: bundles })).rejects.toBeInstanceOf(
      ScreenshotNotFound
    );
    let launched = false;
    try {
      await renderContainer(section(), 'section', {
        launch: async () => {
          launched = true;
          return browser({}).browser;
        },
        timeoutMs: 1000,
      });
      expect(launched).toBe(true);
    } catch (error) {
      expect(error).toBeInstanceOf(ScreenshotUnavailable);
      expect((error as Error).message).toContain('npm run build:canvas');
      expect(launched).toBe(false);
    }
  });
});

describe('canvas screenshot route', () => {
  it('404s a disabled canvas, an unknown object and a deleted object, and keeps the tool out of the command enum', async () => {
    const app = Fastify();
    app.addHook('onRequest', async (req) => {
      req.authUser = { username: 'user-a', role: 'user' };
    });
    let enabled = true;
    const stores = new CanvasStores();
    const workspace = workspaceForCase('shot-case');
    stores.get(workspace.id).append([create('section', null, 'section'), create('gone', 'section')], human);
    stores
      .get(workspace.id)
      .append([CommandSchema.parse({ kind: 'delete', objectId: 'gone', opId: 'delete-gone' })], human);
    registerCanvasRoutes(app, {
      sessions: new Map(),
      canvasEnabled: async () => enabled,
      canvasStores: async () => stores,
      broadcast: vi.fn(),
    });
    await app.ready();
    launchHeadlessBrowser.mockImplementation(async () => browser({}).browser);
    const missing = await app.inject({ method: 'GET', url: `/api/canvas/${workspace.id}/objects/missing/screenshot` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('Canvas object not found');
    const deleted = await app.inject({ method: 'GET', url: `/api/canvas/${workspace.id}/objects/gone/screenshot` });
    expect(deleted.statusCode).toBe(404);
    const command = await app.inject({
      method: 'POST',
      url: `/api/canvas/${workspace.id}/command`,
      payload: { tool: 'canvas_screenshot', arguments: { objectId: 'section' } },
    });
    expect(command.statusCode).toBe(400);
    expect(canvasToolNames).not.toContain('canvas_screenshot');
    const shot = await app.inject({
      method: 'GET',
      url: `/api/canvas/${workspace.id}/objects/section/screenshot?theme=dark`,
    });
    if (shot.statusCode === 503) {
      expect(shot.json().error).toContain('npm run build:canvas');
      expect(launchHeadlessBrowser).not.toHaveBeenCalled();
    } else {
      expect(shot.statusCode).toBe(200);
      expect(String(shot.headers['content-type'])).toContain('image/png');
      expect(shot.headers['cache-control']).toBe('no-store');
      expect(String(shot.headers['x-canvas-screenshot-meta'])).toContain('"scaled":false');
      expect(shot.rawPayload.subarray(0, 4).equals(PNG.subarray(0, 4))).toBe(true);
    }
    enabled = false;
    const off = await app.inject({ method: 'GET', url: `/api/canvas/${workspace.id}/objects/section/screenshot` });
    expect(off.statusCode).toBe(404);
    expect(off.json().error).toBe('Canvas is disabled');
    await app.close();
  });

  it('answers a session-scoped screenshot without dropping the object id', async () => {
    const app = Fastify();
    app.addHook('onRequest', async (req) => {
      req.authUser = { username: 'user-a', role: 'user' };
    });
    const { resolveCasesDir } = await import('../src/web/route-helpers.js');
    const stores = new CanvasStores();
    const workspace = workspaceForCase('shot-case');
    stores.get(workspace.id).append([create('section', null, 'section'), create('a', 'section')], human);
    const sessions = new Map([['agent-a', { id: 'agent-a', workingDir: join(resolveCasesDir(), 'shot-case') }]]);
    registerCanvasRoutes(app, {
      sessions,
      canvasEnabled: async () => true,
      canvasStores: async () => stores,
      broadcast: vi.fn(),
    });
    await app.ready();
    launchHeadlessBrowser.mockImplementation(async () => browser({}).browser);
    try {
      const current = await app.inject({
        method: 'GET',
        url: '/api/canvas/current/objects/section/screenshot',
        headers: { 'x-codeman-parent-session': 'agent-a' },
      });
      expect(current.statusCode).toBe(200);
      expect(String(current.headers['content-type'])).toContain('image/png');
      expect(current.rawPayload.subarray(0, 8).equals(PNG.subarray(0, 8))).toBe(true);
      const explicit = await app.inject({
        method: 'GET',
        url: `/api/canvas/${workspace.id}/objects/a/screenshot?theme=light`,
        headers: { 'x-codeman-parent-session': 'agent-a' },
      });
      expect(explicit.statusCode).toBe(200);
      expect(explicit.rawPayload.subarray(0, 8).equals(PNG.subarray(0, 8))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('kills the browser when the HTTP client hangs up and close never settles', async () => {
    const app = Fastify();
    app.addHook('onRequest', async (req) => {
      req.authUser = { username: 'user-a', role: 'user' };
    });
    const stores = new CanvasStores();
    const workspace = workspaceForCase('hangup-case');
    stores.get(workspace.id).append([create('section', null, 'section')], human);
    registerCanvasRoutes(app, {
      sessions: new Map(),
      canvasEnabled: async () => true,
      canvasStores: async () => stores,
      broadcast: vi.fn(),
    });
    const child = sleeper();
    const exit = new Promise<NodeJS.Signals | null>((resolve) => {
      child.once('exit', (_code, signal) => resolve(signal));
    });
    let started: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      started = resolve;
    });
    launchHeadlessBrowser.mockImplementation(async () => {
      return browser({
        pid: child.pid,
        screenshot: () => {
          started();
          return new Promise<Uint8Array>(() => undefined);
        },
        close: () => new Promise<void>(() => undefined),
      }).browser;
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: `/api/canvas/${workspace.id}/objects/section/screenshot`,
      },
      (res) => {
        res.resume();
      }
    );
    req.on('error', () => undefined);
    try {
      await gate;
      req.destroy();
      expect(await exit).toBe('SIGKILL');
      expect(liveScreenshotBrowserPids()).toEqual([]);
    } finally {
      req.destroy();
      await app.close();
    }
  });

  it('keeps the data directory out of screenshot error bodies', async () => {
    const app = Fastify();
    app.addHook('onRequest', async (req) => {
      req.authUser = { username: 'user-a', role: 'user' };
    });
    const stores = new CanvasStores();
    const workspace = workspaceForCase('path-case');
    stores.get(workspace.id).append([create('section', null, 'section')], human);
    registerCanvasRoutes(app, {
      sessions: new Map(),
      canvasEnabled: async () => true,
      canvasStores: async () => stores,
      broadcast: vi.fn(),
    });
    await app.ready();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const url = `/api/canvas/${workspace.id}/objects/section/screenshot`;
    try {
      launchHeadlessBrowser.mockImplementation(async () => {
        throw new Error(`Could not find Chrome (ver. 1) at ${dir}/chrome`);
      });
      const missing = await app.inject({ method: 'GET', url });
      expect(missing.statusCode).toBe(503);
      expect(missing.body).not.toContain(dir);
      expect(missing.json().error).toBe('No headless browser is available. Run codeman mermaid setup.');

      launchHeadlessBrowser.mockImplementation(async () => {
        throw new Error(`paint failed at ${dir}/page.html`);
      });
      const paint = await app.inject({ method: 'GET', url });
      expect(paint.statusCode).toBe(500);
      expect(paint.body).not.toContain(dir);
      expect(paint.json().error).toBe(SCREENSHOT_FAILED_MESSAGE);

      launchHeadlessBrowser.mockImplementation(
        async () =>
          browser({
            screenshot: async () => {
              throw new Error(`paint failed at ${dir}/shot.html`);
            },
          }).browser
      );
      const duringPaint = await app.inject({ method: 'GET', url });
      expect(duringPaint.statusCode).toBe(500);
      expect(duringPaint.body).not.toContain(dir);
      expect(duringPaint.json().error).toBe(SCREENSHOT_FAILED_MESSAGE);

      writeFileSync(join(dir, 'mermaid-runtime.json'), '{');
      const actual = await vi.importActual<typeof import('../src/headless-browser.js')>('../src/headless-browser.js');
      launchHeadlessBrowser.mockImplementation((options) => actual.launchHeadlessBrowser(options));
      const config = await app.inject({ method: 'GET', url });
      expect(config.statusCode).toBe(500);
      expect(config.body).not.toContain(dir);
      expect(config.json().error).toBe(SCREENSHOT_MISCONFIGURED_MESSAGE);
      expect(spy.mock.calls.some((call) => call.join(' ').includes(dir))).toBe(true);
      expect(spy.mock.calls.some((call) => call.join(' ').includes('mermaid-runtime.json'))).toBe(true);
    } finally {
      spy.mockRestore();
      await app.close();
    }
  });
});
