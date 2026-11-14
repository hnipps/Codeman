/**
 * @fileoverview Brief review in a real browser: Review from the reader rail, a Comment and a Replace posted from a
 * selection, highlights on the board, the full view on F, and Apply offered once. Serves `src/` by default; with
 * `CODEMAN_TEST_DIST=1` it serves the production build (`npm run build` first), which renames assets to hashed names.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import puppeteer from 'puppeteer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dataPath } from '../src/config/instance.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';
import { CanvasStores } from '../src/canvas/canvas-store.js';
import { CommandSchema } from '../src/canvas/operations.js';
import type { Author } from '../src/canvas/model.js';

const TEXT = [
  'Brief',
  '',
  'The rail is narrow today and opens on the right.',
  '',
  '1. Which surface comes first?',
].join('\n');
const agent: Author = { kind: 'agent', sessionId: 'review-writer-session' };

type Server = { start(): Promise<void>; stop(): Promise<void>; boundPort: number };

describe('canvas brief review', () => {
  let server: Server, browser: Browser, page: Page, workspace: string;
  const failures: string[] = [];

  const select = (words: string) =>
    page.evaluate((target) => {
      for (const line of document.querySelectorAll('.review .review-doc .review-line')) {
        const node = line.firstChild as Text | null;
        const at = node?.data.indexOf(target) ?? -1;
        if (!node || at === -1) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + target.length);
        document.getSelection()!.removeAllRanges();
        document.getSelection()!.addRange(range);
        return true;
      }
      return false;
    }, words);

  beforeAll(async () => {
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-brief-review');
    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasEnabled: true, canvasShellEnabled: false }));
    mkdirSync(resolve(resolveCasesDir(), 'Reviewcase'), { recursive: true });
    workspace = workspaceForCase('Reviewcase').id;
    const stores = new CanvasStores();
    const create = CommandSchema.parse({
      kind: 'create',
      opId: 'create-brief',
      objectId: 'brief',
      patch: {
        parentId: null,
        order: 1,
        position: { x: 0, y: 0 },
        size: { width: 420, height: 220 },
        content: { type: 'text', text: TEXT },
      },
    });
    expect(stores.get(workspace).append([create], agent).ok).toBe(true);
    stores.flush();
    const { WebServer } = (await import(
      process.env.CODEMAN_TEST_DIST === '1' ? '../dist/web/server.js' : '../src/web/server.js'
    )) as { WebServer: new (...args: unknown[]) => Server };
    server = new WebServer(0, false, true, undefined, undefined, undefined, '/x');
    await server.start();
    browser = await chromium.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: ['--no-sandbox'],
    });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => failures.push(String(e)));
    page.on('response', (r) => {
      if (r.status() === 404) failures.push(`404 ${r.url()}`);
    });
    await page.goto(`http://localhost:${server.boundPort}/x/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-object-id="brief"]');
  }, 60000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    vi.unstubAllEnvs();
  }, 60000);

  it('posts a Comment and a Replace from a selection and highlights their words', async () => {
    await page.evaluate(() => {
      window.canvasView.dispatch({ kind: 'selection', ids: ['brief'] });
      window.canvasView.dispatch({ kind: 'focus', id: 'brief' });
      window.canvasView.dispatch({ kind: 'rail', view: 'reader' });
    });
    await page.click('#readerReview');
    await page.waitForSelector('#reviewRail .review-doc');
    expect((await page.locator('#rail').boundingBox())!.width).toBeGreaterThanOrEqual(420);

    expect(await select('opens')).toBe(true);
    await page.click('.review-comment-act');
    await page.fill('.review-composer .review-body', 'Say which side.');
    await page.click('.review-composer button:text-is("Post")');
    await page.waitForSelector('#reviewRail .review-note[data-kind="comment"][data-state="unsent"]');

    expect(await select('narrow')).toBe(true);
    await page.click('.review-replace-act');
    await page.fill('.review-composer .review-replacement', 'too narrow for notes');
    await page.click('.review-composer button:text-is("Post")');
    await page.waitForSelector('#reviewRail .review-note[data-kind="replace"]');

    // The Answer act is offered only inside a numbered question.
    await select('rail is');
    expect(await page.isHidden('.review-answer-act')).toBe(true);
    await select('Which surface');
    expect(await page.isVisible('.review-answer-act')).toBe(true);

    expect(await page.textContent('#reviewRail [data-review-key="send-all"]')).toBe('Send 2');
    const sizes = await page.evaluate(() => CSS.highlights.get('review-unsent')?.size ?? 0);
    expect(sizes).toBeGreaterThanOrEqual(2);
  });

  it('opens the full view on F and offers Apply once', async () => {
    await page.evaluate(() => window.canvasView.dispatch({ kind: 'rail-close', view: 'reader' }));
    await page.evaluate(() => window.canvasView.dispatch({ kind: 'selection', ids: ['brief'] }));
    await page.locator('#board').focus();
    await page.keyboard.press('f');
    await page.waitForSelector('#reviewFull:not([hidden]) .review-doc');
    await page.click('#reviewFull .review-note[data-kind="replace"] button:text-is("Apply")');
    await page.waitForFunction(() =>
      document.querySelector('#reviewFull .review-doc')?.textContent?.includes('too narrow for notes today')
    );
    await page.waitForSelector('#reviewFull .review-note[data-kind="replace"] .review-applied');
    expect(await page.locator('#reviewFull .review-note[data-kind="replace"] button:text-is("Apply")').count()).toBe(0);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#reviewFull', { state: 'hidden' });
    expect(failures).toEqual([]);
  });
});
