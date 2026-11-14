/**
 * @fileoverview Agent text on the canvas page renders as Markdown, and its Mermaid fences become diagrams through the
 * shared renderer frame: Claude's turns in the assistant rail and an agent's comment in a thread. A person's text
 * stays plain. The transcript read is stubbed; the parser, sanitizer and Mermaid frame are the real ones.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import puppeteer from 'puppeteer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebServer } from '../src/web/server.js';
import { dataPath } from '../src/config/instance.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';
import { CanvasStores } from '../src/canvas/canvas-store.js';
import { CommandSchema } from '../src/canvas/operations.js';

const REPLY = [
  '## Plan',
  '',
  'Two **steps**, then `ship`:',
  '',
  '1. Draft',
  '2. Review',
  '',
  '```mermaid',
  'graph LR; Draft-->Review',
  '```',
].join('\n');

describe('canvas agent Markdown and Mermaid', () => {
  let server: WebServer, browser: Browser, page: Page, origin: string, workspace: string;
  beforeAll(async () => {
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-canvas-markdown');
    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasEnabled: true, canvasShellEnabled: false }));
    mkdirSync(resolve(resolveCasesDir(), 'Notes'), { recursive: true });
    workspace = workspaceForCase('Notes').id;
    const stores = new CanvasStores();
    const store = stores.get(workspace);
    const create = CommandSchema.parse({
      kind: 'create',
      opId: 'create-n1',
      objectId: 'n1',
      patch: {
        parentId: null,
        order: 0,
        position: { x: 0, y: 0 },
        size: { width: 180, height: 90 },
        content: { type: 'text', text: 'Plan note' },
      },
    });
    const comment = (id: string, text: string) =>
      CommandSchema.parse({ kind: 'comment', opId: `op-${id}`, objectId: 'n1', patch: { id, text } });
    expect(store.append([create, comment('c-human', '**not bold**')], { kind: 'human', userId: 'a' }).ok).toBe(true);
    expect(store.append([comment('c-agent', REPLY)], { kind: 'agent', sessionId: 'agent-session-1' }).ok).toBe(true);
    stores.flush();
    server = new WebServer(0, false, true);
    await server.start();
    origin = `http://localhost:${server.boundPort}`;
    browser = await chromium.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: ['--no-sandbox'],
    });
    page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })).newPage();
  }, 60000);
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    vi.unstubAllEnvs();
  }, 60000);

  const diagram = (scope: string) =>
    page.waitForFunction(
      (s) => {
        const img = document.querySelector<HTMLImageElement>(`${s} .rv-mermaid-preview img`);
        return !!img && img.src.startsWith('data:image/svg+xml') && img.naturalWidth > 0;
      },
      scope,
      { timeout: 20000 }
    );

  it("renders Claude's turn as Markdown with a Mermaid diagram, and keeps the person's prompt plain", async () => {
    await page.goto(`${origin}/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-object-id="n1"]');
    await page.waitForFunction(() => !!window.canvasView);
    await page.evaluate(() => window.canvasView.dispatch({ kind: 'rail', view: 'assistant' }));
    await page.locator('#assistantDraft').fill('**plan** it');
    await page.locator('#assistantDraft').press('Enter');
    await page.waitForFunction(() => (document.getElementById('assistantDraft') as HTMLTextAreaElement).value === '');
    await page.route('**/last-response*', (route) =>
      route.fulfill({
        json: {
          success: true,
          data: {
            messages: [
              { role: 'user', text: '**plan** it' },
              { role: 'assistant', text: REPLY },
            ],
          },
        },
      })
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.canvasView);
    await page.evaluate(() => window.canvasView.dispatch({ kind: 'rail', view: 'assistant' }));
    await page.waitForSelector('#thread .turn[data-who="claude"] .md h2');
    const claude = page.locator('#thread .turn[data-who="claude"] .turn-text');
    expect(await claude.locator('h2').textContent()).toBe('Plan');
    expect(await claude.locator('strong').textContent()).toBe('steps');
    expect(await claude.locator('ol > li').count()).toBe(2);
    await diagram('#thread .turn[data-who="claude"]');
    const you = page.locator('#thread .turn[data-who="you"] .turn-text').first();
    expect(await you.textContent()).toBe('**plan** it');
    expect(await you.locator('strong').count()).toBe(0);
    mkdirSync(resolve('test-results'), { recursive: true });
    await page.locator('#rail').screenshot({ path: resolve('test-results', `canvas-markdown-rail-${Date.now()}.png`) });
    await page.unroute('**/last-response*');
  }, 60000);

  it("renders an agent's comment as Markdown with its diagram, and a person's comment as typed", async () => {
    await page.evaluate(() => {
      window.canvasView.dispatch({ kind: 'focus', id: 'n1' });
      window.canvasView.dispatch({ kind: 'selection', ids: ['n1'] });
      window.canvasView.dispatch({ kind: 'rail', view: 'thread' });
    });
    await page.waitForSelector('#threadView:not([hidden]) [data-comment-id="c-agent"] .md h2');
    await diagram('[data-comment-id="c-agent"]');
    const human = page.locator('[data-comment-id="c-human"] .comment-text');
    expect(await human.textContent()).toBe('**not bold**');
    expect(await human.locator('strong').count()).toBe(0);
    await page
      .locator('#rail')
      .screenshot({ path: resolve('test-results', `canvas-markdown-thread-${Date.now()}.png`) });
  }, 60000);
});
