/**
 * @fileoverview A real Vite React app served as a preview, through the web tab proxy, in Chromium.
 *
 * The app comes from `CODEMAN_TEST_VITE_APP` (an installed `npm create vite -- --template react`
 * directory) or is scaffolded with npm in `beforeAll`, which needs the network.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Frame } from 'playwright';
import { WebServer } from '../src/web/server.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { readProcSnapshot } from '../src/preview-proc.js';

vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);

const SANDBOX = 'allow-scripts allow-forms allow-popups allow-downloads allow-modals';

function scaffoldViteApp(root: string): string {
  const npm = (args: string[], cwd: string) =>
    execFileSync('npm', args, {
      cwd,
      stdio: 'ignore',
      timeout: 300_000,
      env: { ...process.env, npm_config_yes: 'true' },
    });
  npm(['create', 'vite@latest', 'app', '--', '--template', 'react'], root);
  const app = join(root, 'app');
  npm(['install'], app);
  return app;
}

async function heading(frame: Frame): Promise<string> {
  return frame.evaluate(() => document.querySelector('h1')?.textContent ?? '');
}

async function waitForHeading(frame: Frame, want: (text: string) => boolean, ms = 20_000): Promise<string> {
  const deadline = Date.now() + ms;
  let text = '';
  while (Date.now() < deadline) {
    text = await heading(frame).catch(() => '');
    if (want(text)) return text;
    await new Promise((r) => setTimeout(r, 200));
  }
  return text;
}

describe('a Vite dev server as a preview', () => {
  let server: WebServer;
  let browser: Browser;
  let scratch: string;
  let app: string;
  let dataDir: string;
  let savedDataDir: string | undefined;
  let appSource = '';

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'preview-vite-'));
    app = process.env.CODEMAN_TEST_VITE_APP ?? scaffoldViteApp(scratch);
    appSource = readFileSync(join(app, 'src/App.jsx'), 'utf-8');
    dataDir = join(scratch, 'data');
    savedDataDir = process.env.CODEMAN_DATA_DIR;
    process.env.CODEMAN_DATA_DIR = dataDir;
    server = new WebServer(0, false, true);
    await server.start();
    browser = await chromium.launch();
  }, 600_000);

  afterAll(async () => {
    if (app && appSource) writeFileSync(join(app, 'src/App.jsx'), appSource);
    await browser?.close();
    for (const preview of server?.previews.list() ?? []) await server.previews.remove(preview.webviewId);
    await server?.stop();
    for (const entry of readProcSnapshot().values()) {
      if (entry.previewOwner !== dataDir) continue;
      try {
        process.kill(entry.pid, 'SIGKILL');
      } catch {}
    }
    if (savedDataDir === undefined) delete process.env.CODEMAN_DATA_DIR;
    else process.env.CODEMAN_DATA_DIR = savedDataDir;
    if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  it('renders the app in a sandboxed frame and applies an edit to src/App.jsx without a reload', async () => {
    const base = `http://127.0.0.1:${server.boundPort}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(base + path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      return res.json();
    };
    const created = await call('POST', '/api/v1/sessions', { workingDir: app, name: 'vite' });
    const sid = created.data.id ?? created.data.session?.id;
    const put = await call('PUT', `/api/v1/sessions/${sid}/previews/vite`, {
      cmd: 'npm run dev -- --port {port} --strictPort',
    });
    expect(put.data).toMatchObject({ state: 'running', ready: true });

    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const sockets: string[] = [];
    page.on('websocket', (ws) => sockets.push(ws.url()));
    await page.goto(`${base}/api/status`);
    await page.setContent(`<iframe id="f" sandbox="${SANDBOX}" src="${base}${put.data.url}"></iframe>`);
    const frame = (await (await page.waitForSelector('#f')).contentFrame())!;

    expect(await waitForHeading(frame, (t) => t.length > 0)).toBe('Get started');
    await frame.evaluate(() => ((window as unknown as Record<string, number>).__notReloaded = 1));

    writeFileSync(join(app, 'src/App.jsx'), appSource.replace(/<h1>[^<]*<\/h1>/, '<h1>HMR through Codeman</h1>'));

    expect(await waitForHeading(frame, (t) => t === 'HMR through Codeman')).toBe('HMR through Codeman');
    expect(await frame.evaluate(() => (window as unknown as Record<string, number>).__notReloaded)).toBe(1);
    expect(sockets.some((url) => url.startsWith(`ws://127.0.0.1:${server.boundPort}${put.data.url}`))).toBe(true);
  }, 120_000);
});
