/**
 * @fileoverview A work item's pull request on the Reviews page in a real browser: the server finds the item at boot,
 * reviews origin's branch, and the page shows W-n with the pull request link, the work wording on Request changes and
 * Approve, and the empty preview. Request changes lands on the item. Port 0; headless Chromium at scale 1.
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

const URL1 = 'https://github.com/example/repo/pull/58';
const shots = process.env.REVIEW_SHOTS_DIR;
type Server = { start(): Promise<void>; stop(): Promise<void>; boundPort: number };

describe('a work item pull request on the Reviews page', () => {
  let server: Server, browser: Browser, page: Page, workspace: string, origin: string;
  const failures: string[] = [];
  const shoot = async (name: string) => {
    if (shots) await page.screenshot({ path: join(shots, `work-review-${name}-${Date.now()}.png`), fullPage: false });
  };

  beforeAll(async () => {
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-work-review');
    const author = realpathSync(mkdtempSync(join(tmpdir(), 'wrp-author-')));
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(author, 'init', '-q', '-b', 'main');
    git(author, 'config', 'user.name', 't');
    git(author, 'config', 'user.email', 't@example.invalid');
    git(author, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(author, 'outline.md'), '# Outline\n');
    git(author, 'add', '.');
    git(author, 'commit', '-q', '-m', 'base');
    origin = realpathSync(mkdtempSync(join(tmpdir(), 'wrp-origin-')));
    git(origin, 'init', '-q', '--bare', '-b', 'main');
    git(author, 'remote', 'add', 'origin', origin);
    git(author, 'push', '-q', 'origin', 'main');
    git(author, 'checkout', '-q', '-b', 'build/w-1-outline');
    writeFileSync(join(author, 'outline.md'), '# Outline\n\n## Sections\n\nEach section gets a heading.\n');
    git(author, 'commit', '-q', '-am', 'Outline sections');
    git(author, 'push', '-q', 'origin', 'build/w-1-outline');
    rmSync(author, { recursive: true, force: true });

    mkdirSync(resolveCasesDir(), { recursive: true });
    execFileSync('git', ['clone', '-q', origin, resolve(resolveCasesDir(), 'Prcase')], { stdio: 'ignore' });
    workspace = workspaceForCase('Prcase').id;
    const made = changeWork(workspace, (f) =>
      createWork(
        f,
        CreateWorkSchema.parse({
          title: 'Outline sections',
          status: 'in-progress',
          description: 'Each section of the outline gets a heading.',
          pr: { url: URL1, branch: 'build/w-1-outline' },
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
    const base = `http://localhost:${server.boundPort}/x`;
    // The boot catch-up makes the review; nothing in this test asks for it.
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

  it('shows the item and its pull request in the queue row and the header', async () => {
    const row = page.locator('.rv-queue-row');
    expect(await row.locator('.rv-queue-line').textContent()).toContain('W-1 ·');
    expect(await row.locator('.rv-queue-pr').getAttribute('href')).toBe(URL1);
    expect(await row.locator('.rv-queue-pr').getAttribute('rel')).toBe('noopener noreferrer');
    await page.waitForFunction(() => document.getElementById('rvMeta')?.textContent?.includes('files'));
    expect(await page.textContent('#rvTitle')).toBe('Outline sections');
    expect(await page.textContent('#rvMeta')).toMatch(/^W-1 · Prcase · build\/w-1-outline → main · 1 files/);
    expect(await page.isVisible('#rvPr')).toBe(true);
    expect(await page.getAttribute('#rvPr', 'href')).toBe(URL1);
    expect(await page.textContent('#rvWalk .rv-by')).toMatch(/^From W-1 · /);
    expect(await page.textContent('#rvWalk .rv-md')).toContain('Each section of the outline gets a heading.');
    expect(await page.textContent('#rvRequest')).toBe('Send to W-1');
    expect(await page.isDisabled('#rvRequest')).toBe(true);
    expect(await page.getAttribute('#rvApprove', 'title')).toBe(
      'Merges build/w-1-outline into main and marks W-1 done.'
    );
    expect(await page.isHidden('#rvNotice')).toBe(true);
    await shoot('header');
  });

  it('shows the empty preview, since a pull request has no session preview', async () => {
    await page.click('#rvTabPreview');
    expect(await page.textContent('#rvPreview')).toBe(
      'A pull request has no running preview here. Its code is under Changes.'
    );
    await shoot('preview');
    await page.click('#rvTabChanges');
  });

  it('names the item in a short Approve confirmation, with the detail folded away', async () => {
    await page.click('#rvApprove');
    await page.waitForSelector('#rvConfirm[open]');
    expect(await page.textContent('#rvConfirmTitle')).toBe('Merge?');
    expect(await page.textContent('#rvConfirmBody > p')).toBe(
      'Merges 1 commit from build/w-1-outline into main and marks W-1 done.'
    );
    expect(await page.textContent('#rvConfirmGo')).toBe('Merge');
    const more = page.locator('#rvConfirmBody details.rv-confirm-more');
    expect(await more.locator('summary').textContent()).toBe('What is this?');
    expect(await more.getAttribute('open')).toBeNull();
    expect(await more.textContent()).toContain('A merge cannot be undone from this page.');
    await page.click('#rvConfirmCancel');
  });

  it('says Merge and deploy when approving deploys Codeman', async () => {
    // Only Codeman's own repository deploys, and this fixture is not it: the page is told it is.
    const pattern = /\/api\/reviews\/[0-9a-f]{16}$/;
    await page.route(pattern, async (route) => {
      const res = await route.fetch();
      const json = (await res.json()) as { data: { approve?: { deploys: boolean } } };
      json.data.approve = { deploys: true };
      await route.fulfill({ response: res, json });
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('rvMeta')?.textContent?.includes('files'));
    await page.click('#rvApprove');
    await page.waitForSelector('#rvConfirm[open]');
    expect(await page.textContent('#rvConfirmTitle')).toBe('Merge and deploy?');
    expect(await page.textContent('#rvConfirmBody > p')).toBe(
      'Merges 1 commit from build/w-1-outline into main, deploys Codeman and marks W-1 done.'
    );
    expect(await page.textContent('#rvConfirmGo')).toBe('Merge and deploy');
    await shoot('approve');
    await page.click('#rvConfirmBody summary');
    expect(await page.textContent('#rvConfirmBody details')).toContain('switches Codeman to it');
    await shoot('approve-more');
    await page.click('#rvConfirmCancel');
    await page.unroute(pattern);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('rvMeta')?.textContent?.includes('files'));
  });

  it('sends notes to the item and says where they went', async () => {
    const id = (await page.getAttribute('.rv-queue-row .rv-queue-item', 'href'))!.split('/').pop()!;
    const added = await page.evaluate(
      async (reviewId) =>
        (
          await fetch(`api/reviews/${reviewId}/notes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ at: { kind: 'general' }, text: 'Number the sections.' }),
          })
        ).status,
      id
    );
    expect(added).toBe(200);
    await page.waitForFunction(() => document.getElementById('rvRequest')?.textContent === 'Send to W-1 · 1 note');
    await page.click('#rvRequest');
    await page.waitForFunction(() =>
      document.body.textContent?.includes('Sent to W-1. It is first in Ready for work.')
    );
    await shoot('sent');
    const read = readWork(workspace);
    const item = read.ok ? read.file.items[0] : undefined;
    expect(item).toMatchObject({ status: 'ready-for-work' });
    expect(item?.changes?.text).toContain('Number the sections.');
    expect(failures).toEqual([]);
  });
});
