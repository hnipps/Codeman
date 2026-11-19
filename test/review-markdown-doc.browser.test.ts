/**
 * @fileoverview A changed Markdown file on the Reviews page, in a real browser: Changes opens it rendered with its
 * changed blocks marked, a repository link goes quiet, words selected in it become a note like any other (listed,
 * highlighted, found again from the list, sent with Request changes), and Diff switches back to the lines. Uses a
 * work item's pull request, so no agent session is needed. Port 0; headless Chromium at scale 1.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import puppeteer from 'puppeteer';
import { createWork, CreateWorkSchema } from '../src/canvas/work.js';
import { changeWork, readWork } from '../src/canvas/work-store.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';

const shots = process.env.REVIEW_SHOTS_DIR;
type Server = { start(): Promise<void>; stop(): Promise<void>; boundPort: number };

const BEFORE = [
  '# Rollout plan',
  '',
  'This plan moves the reviews page to rendered documents.',
  '',
  '## Steps',
  '',
  '1. Read the file at the branch tip.',
  '2. Render it through the one sanitizer.',
  '',
  'See [the spec](docs/spec.md) for detail.',
  '',
].join('\n');
const AFTER = [
  '# Rollout plan',
  '',
  'This plan moves the reviews page to rendered documents.',
  '',
  '## Steps',
  '',
  '1. Read the file at the branch tip.',
  '2. Render it through the one sanitizer.',
  '3. Mark the blocks this branch changed.',
  '',
  '| Step | Owner |',
  '| ---- | ----- |',
  '| Read | server |',
  '| Mark | page |',
  '',
  'See [the spec](docs/spec.md) for detail.',
  '',
].join('\n');

describe('a changed Markdown file on the Reviews page', () => {
  let server: Server, browser: Browser, page: Page, workspace: string, origin: string, base: string;
  const failures: string[] = [];
  const shoot = async (name: string) => {
    if (shots) await page.screenshot({ path: join(shots, `review-doc-${name}-${Date.now()}.png`), fullPage: false });
  };

  beforeAll(async () => {
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-review-doc');
    const author = realpathSync(mkdtempSync(join(tmpdir(), 'rdoc-author-')));
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(author, 'init', '-q', '-b', 'main');
    git(author, 'config', 'user.name', 't');
    git(author, 'config', 'user.email', 't@example.invalid');
    git(author, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(author, 'plan.md'), BEFORE);
    git(author, 'add', '.');
    git(author, 'commit', '-q', '-m', 'base');
    origin = realpathSync(mkdtempSync(join(tmpdir(), 'rdoc-origin-')));
    git(origin, 'init', '-q', '--bare', '-b', 'main');
    git(author, 'remote', 'add', 'origin', origin);
    git(author, 'push', '-q', 'origin', 'main');
    git(author, 'checkout', '-q', '-b', 'build/w-1-plan');
    writeFileSync(join(author, 'plan.md'), AFTER);
    git(author, 'commit', '-q', '-am', 'Plan: mark changes');
    git(author, 'push', '-q', 'origin', 'build/w-1-plan');
    rmSync(author, { recursive: true, force: true });

    mkdirSync(resolveCasesDir(), { recursive: true });
    execFileSync('git', ['clone', '-q', origin, resolve(resolveCasesDir(), 'Doccase')], { stdio: 'ignore' });
    workspace = workspaceForCase('Doccase').id;
    const made = changeWork(workspace, (f) =>
      createWork(
        f,
        CreateWorkSchema.parse({
          title: 'Rollout plan',
          status: 'in-progress',
          description: 'Write the rollout plan.',
          pr: { url: 'https://github.com/example/repo/pull/9', branch: 'build/w-1-plan' },
        }),
        { author: { kind: 'human', userId: 'admin' }, now: Date.now() }
      )
    );
    expect(made.ok).toBe(true);

    const { WebServer } = (await import('../src/web/server.js')) as unknown as {
      WebServer: new (...args: unknown[]) => Server;
    };
    server = new WebServer(0, false, true, undefined, undefined, undefined, '/x');
    await server.start();
    base = `http://localhost:${server.boundPort}/x`;
    await vi.waitFor(
      async () => {
        const queue = (await (await fetch(`${base}/api/reviews`)).json()) as { data: { waiting: unknown[] } };
        expect(queue.data.waiting).toHaveLength(1);
      },
      { timeout: 20_000, interval: 250 }
    );
    browser = await chromium.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: ['--no-sandbox'],
    });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => failures.push(String(e)));
    page.on('response', (r) => {
      if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`);
    });
    await page.goto(`${base}/reviews`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.rv-queue-row .rv-queue-item[aria-current="true"]');
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    if (origin) rmSync(origin, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }, 60_000);

  it('opens the Markdown file rendered, with the changed blocks marked', async () => {
    await page.waitForSelector('#rvDiff .rv-doc-md .rv-blk');
    expect(await page.textContent('#rvDiff .rv-doc-path')).toBe('plan.md');
    expect(await page.getAttribute('#rvDiff .rv-seg-sm button:first-child', 'aria-pressed')).toBe('true');
    expect(await page.textContent('#rvDiff .rv-doc-md h1')).toBe('Rollout plan');
    await page.waitForSelector('#rvDiff .rv-blk-changed');
    const changed = await page.$$eval('#rvDiff .rv-blk-changed', (blocks) => blocks.map((b) => b.textContent));
    // The list gained a step and the table is new; the heading and the first paragraph did not change.
    expect(changed).toHaveLength(2);
    expect(changed[0]).toContain('Mark the blocks this branch changed.');
    expect(changed[1]).toContain('Owner');
    expect(await page.textContent('#rvDiff .rv-doc-key')).toBe('Changed on this branch');
    // A repository link has nowhere to go from this page.
    const link = page.locator('#rvDiff .rv-doc-md a.rv-doc-link');
    expect(await link.textContent()).toBe('the spec');
    expect(await link.getAttribute('href')).toBeNull();
    expect(await link.getAttribute('title')).toBe('docs/spec.md');
    await shoot('rendered');
  });

  it('turns selected words into a note on the document', async () => {
    await page.evaluate(() => {
      const p = [...document.querySelectorAll('#rvDiff .rv-doc-md p')].find((x) =>
        x.textContent?.startsWith('This plan')
      )!;
      const text = p.firstChild as Text;
      const at = text.data.indexOf('rendered documents');
      const range = document.createRange();
      range.setStart(text, at);
      range.setEnd(text, at + 'rendered documents'.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.waitForSelector('#rvSelectNote:not([hidden])');
    await shoot('select');
    await page.click('#rvSelectNote');
    expect(await page.textContent('#rvComposerAt')).toBe('plan.md · “rendered documents”');
    await page.fill('#rvComposerText', 'Say which documents: Markdown only.');
    await page.click('#rvComposer button[type="submit"]');
    await page.waitForSelector('#rvDiff .rv-doc-md mark.rv-mark');
    expect(await page.textContent('#rvDiff .rv-doc-md mark.rv-mark')).toBe('rendered documents');
    const row = page.locator('#rvNoteList .rv-note').first();
    expect(await row.locator('.rv-note-at').textContent()).toBe('plan.md · “rendered documents”');
    expect(await row.textContent()).toContain('Not sent yet');
    expect(await page.textContent('.rv-file[aria-current="true"] .rv-file-notes')).toBe('1');
    await shoot('noted');
  });

  it('switches to the diff and back, and finds the note again from the list', async () => {
    await page.click('#rvDiff .rv-seg-sm button:nth-child(2)');
    await page.waitForSelector('#rvDiff .rv-lines .rv-line-add');
    expect(await page.locator('#rvDiff .rv-doc-md').count()).toBe(0);
    await page.click('#rvNoteList .rv-note .rv-note-at');
    await page.waitForSelector('#rvDiff .rv-doc-md mark.rv-mark');
    expect(await page.getAttribute('#rvDiff .rv-seg-sm button:first-child', 'aria-pressed')).toBe('true');
  });

  it('sends the document note with the others, in one press', async () => {
    const id = (await page.getAttribute('.rv-queue-row .rv-queue-item', 'href'))!.split('/').pop()!;
    const added = await page.evaluate(
      async (reviewId) =>
        (
          await fetch(`api/reviews/${reviewId}/notes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ at: { kind: 'general' }, text: 'Otherwise good.' }),
          })
        ).status,
      id
    );
    expect(added).toBe(200);
    await page.waitForFunction(() => document.getElementById('rvRequest')?.textContent === 'Send to W-1 · 2 notes');
    await page.click('#rvRequest');
    await page.waitForFunction(() => document.body.textContent?.includes('Sent to W-1.'));
    const read = readWork(workspace);
    const item = read.ok ? read.file.items[0] : undefined;
    expect(JSON.stringify(item)).toContain('On plan.md (the rendered document), at \\"rendered documents\\"');
    expect(JSON.stringify(item)).toContain('Say which documents: Markdown only.');
  });

  it('reads on a phone', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('#rvPanes button[data-pane="stage"]');
    await page.waitForSelector('#rvDiff .rv-doc-md');
    expect(await page.isVisible('#rvDiff .rv-seg-sm')).toBe(true);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await shoot('phone');
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  it('raised no page errors and no failed requests', () => {
    expect(failures).toEqual([]);
  });
});
