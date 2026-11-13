/**
 * UI events end to end: a person uses the canvas and the classic tab strip in a real browser, the pages post
 * what they did to `POST /api/client-errors`, the server writes `ui-events.jsonl`, and an agent reads the lines
 * back through the `logs_query` MCP tool. The stream holds tokens only: none of the typed draft, the object
 * text or the session names reaches it.
 *
 * Sessions are the server's test stand-ins (a PTY that echoes, no agent, no tmux).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import puppeteer from 'puppeteer';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebServer } from '../src/web/server.js';
import { dataPath } from '../src/config/instance.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';
import { CanvasStores } from '../src/canvas/canvas-store.js';
import { CommandSchema } from '../src/canvas/operations.js';
import { createMcpServer } from '../src/mcp-server.js';

type Line = { surface: string; action: string; target?: string; n?: number; agoMs?: number; buildId: string };

const OBJECT_TEXT = 'Readers scan headings first';
const DRAFT_TEXT = 'a draft nobody sent about the login bug';
const NAMES = ['alpha-private-name', 'beta-private-name'];

describe('UI events from a real browser to logs_query', () => {
  let server: WebServer, browser: Browser, page: Page, origin: string, workspace: string, logDir: string;
  const sessions: string[] = [];
  const api = (path: string) => `${origin}/x/api${path}`;

  async function logsQuery(args: Record<string, unknown>): Promise<Line[]> {
    const out: Array<{ result?: { content?: Array<{ text: string }>; isError?: boolean } }> = [];
    const mcp = createMcpServer({
      config: { apiUrl: `${origin}/x`, allowAnySession: false, version: '0.0.0-test' },
      write: (message) => out.push(message as (typeof out)[number]),
      modes: ['claude', 'shell'],
    });
    await mcp.handleLine(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'logs_query', arguments: args } })
    );
    const result = out[0]?.result;
    expect(result?.isError, JSON.stringify(out)).not.toBe(true);
    const data = JSON.parse(result!.content![0].text) as { lines: string[] };
    return data.lines.map((line) => JSON.parse(line) as Line);
  }
  const has = (lines: Line[], surface: string, action: string, target?: string) =>
    lines.some((l) => l.surface === surface && l.action === action && (target === undefined || l.target === target));

  beforeAll(async () => {
    logDir = mkdtempSync(join(tmpdir(), 'codeman-ui-events-'));
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-ui-events');
    vi.stubEnv('CODEMAN_LOG_DIR', logDir);
    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasEnabled: true, canvasShellEnabled: true }));
    mkdirSync(resolve(resolveCasesDir(), 'events-case'), { recursive: true });
    workspace = workspaceForCase('events-case').id;
    const stores = new CanvasStores();
    expect(
      stores.get(workspace).append(
        [
          CommandSchema.parse({
            kind: 'create',
            opId: 'create-brief',
            objectId: 'brief',
            patch: {
              parentId: null,
              order: 0,
              position: { x: 0, y: 0 },
              size: { width: 300, height: 80 },
              content: { type: 'text', text: OBJECT_TEXT },
            },
          }),
        ],
        { kind: 'human', userId: 'admin' }
      ).ok
    ).toBe(true);
    stores.flush();
    server = new WebServer(0, false, true, undefined, undefined, undefined, '/x');
    await server.start();
    origin = `http://localhost:${server.boundPort}`;
    browser = await chromium.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: ['--no-sandbox'],
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
    });
    await context.addInitScript(() => {
      if (!localStorage.getItem('codeman:skin')) localStorage.setItem('codeman:skin', 'og');
    });
    page = await context.newPage();
    for (const sessionName of NAMES) {
      const started = await (
        await page.request.post(api('/quick-start'), { data: { caseName: 'events-case', mode: 'shell', sessionName } })
      ).json();
      sessions.push((started.sessionId ?? started.data?.sessionId) as string);
    }
    expect(sessions.every(Boolean)).toBe(true);
  }, 60000);

  afterAll(async () => {
    for (const id of sessions) await page?.request.delete(api(`/sessions/${id}`)).catch(() => {});
    await browser?.close();
    await server?.stop();
    vi.unstubAllEnvs();
    rmSync(logDir, { recursive: true, force: true });
  }, 60000);

  it('records what a person does on the canvas, and nothing they typed or read', async () => {
    await page.goto(`${origin}/x/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-object-id="brief"]');
    await page.waitForFunction(() => !!window.canvasView);
    await page.locator('#board').focus();
    await page.locator('#panTool').click();
    await page.locator('#selectTool').click();
    await page.locator('[data-object-id="brief"]').click();
    await page.keyboard.press('c');
    await page.waitForFunction(() => window.canvasView.read().rail.at(-1) === 'assistant');
    await page.locator('#assistantDraft').click();
    await page.keyboard.type(DRAFT_TEXT);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.canvasView.read().rail.includes('assistant'));
    if (process.env.CANVAS_UI_EVENTS_SHOT)
      await page.screenshot({ path: `${process.env.CANVAS_UI_EVENTS_SHOT}-canvas.png` });

    await expect
      .poll(async () => (await logsQuery({ stream: 'ui-events' })).map((l) => l.action), { timeout: 10000 })
      .toEqual(expect.arrayContaining(['page.open', 'tool', 'rail.open', 'rail.close']));
    const lines = await logsQuery({ stream: 'ui-events' });
    expect(has(lines, 'canvas', 'page.open', 'desktop')).toBe(true);
    expect(has(lines, 'canvas', 'tool', 'pan')).toBe(true);
    expect(has(lines, 'canvas', 'tool', 'select')).toBe(true);
    expect(has(lines, 'canvas', 'rail.open', 'assistant')).toBe(true);
    // Selecting, focusing and moving the camera are not events.
    expect(lines.map((l) => l.action)).not.toEqual(expect.arrayContaining(['selection']));
    for (const line of lines) {
      expect(Object.keys(line).sort().join()).toMatch(/^action,(agoMs,)?buildId,(n,)?pid,surface,(target,)?ts$/);
      expect(line.agoMs).toBeLessThan(10000);
    }
    // The literal filter an agent would use finds one kind of event.
    const rails = await logsQuery({ stream: 'ui-events', text: '"action":"rail.open"' });
    expect(rails.length).toBeGreaterThan(0);
    expect(rails.every((l) => l.action === 'rail.open')).toBe(true);
  });

  it('records a tab the person selects and the click back to the canvas, by id', async () => {
    await page.goto(`${origin}/x/classic`, { waitUntil: 'domcontentloaded' });
    const tab = (id: string) => page.locator(`#sessionTabs .session-tab[data-id="${id}"]`);
    await tab(sessions[0]).waitFor();
    await tab(sessions[1]).waitFor();
    await page.waitForFunction(
      () => !!(window as unknown as { app?: { activeSessionId?: string } }).app?.activeSessionId
    );
    const active = await page.evaluate(
      () => (window as unknown as { app: { activeSessionId: string } }).app.activeSessionId
    );
    const other = sessions.find((id) => id !== active)!;
    await tab(other).click();
    await page.waitForFunction(
      (id) => (window as unknown as { app: { activeSessionId: string } }).app.activeSessionId === id,
      other
    );
    if (process.env.CANVAS_UI_EVENTS_SHOT)
      await page.screenshot({ path: `${process.env.CANVAS_UI_EVENTS_SHOT}-classic.png` });
    // The link leaves the page: its own event is sent on the way out.
    await page.locator('#canvasShellLink').click();
    await page.waitForURL(new RegExp(`/x/canvas/${workspace}$`));

    await expect
      .poll(async () => (await logsQuery({ stream: 'ui-events', text: 'tab-strip' })).map((l) => l.action), {
        timeout: 10000,
      })
      .toEqual(expect.arrayContaining(['page.open', 'tab.select', 'canvas.open']));
    const lines = await logsQuery({ stream: 'ui-events', text: 'tab-strip' });
    expect(has(lines, 'tab-strip', 'page.open', 'dashboard')).toBe(true);
    expect(has(lines, 'tab-strip', 'tab.select', other)).toBe(true);
    // The session the app selected by itself at load is not something the person did.
    expect(has(lines, 'tab-strip', 'tab.select', active)).toBe(false);
  });

  it('holds no typed text, object content or session name on disk', async () => {
    const raw = readFileSync(join(logDir, 'ui-events.jsonl'), 'utf8');
    expect(raw.split('\n').filter(Boolean).length).toBeGreaterThan(5);
    for (const secret of [DRAFT_TEXT, 'login bug', OBJECT_TEXT, 'Readers', ...NAMES, 'events-case']) {
      expect(raw).not.toContain(secret);
    }
  });
});
