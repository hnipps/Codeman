/**
 * Canvas shell (PC13) in the browser, part 2: the outline's workspace list, New workspace, the Sessions section,
 * New session, Go to, the notice line, the classic links and the first-run page. Under a reverse-proxy base path.
 * Sessions are the server's test stand-ins (no agent runs); they are started through the real quick-start route.
 */
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import puppeteer from 'puppeteer';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebServer } from '../src/web/server.js';
import { dataPath } from '../src/config/instance.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';
import { CanvasStores } from '../src/canvas/canvas-store.js';
import { CommandSchema } from '../src/canvas/operations.js';
import { approvalInbox } from '../src/web/approval-inbox.js';

const installed = vi.hoisted(() => ({ map: { claude: true } as Record<string, boolean> }));
vi.mock('../src/utils/cli-installed-probes.js', async (original) => ({
  ...(await original<typeof import('../src/utils/cli-installed-probes.js')>()),
  probeStockCliAvailability: async () => installed.map,
}));

const note = (id: string, x: number, text: string) =>
  CommandSchema.parse({
    kind: 'create',
    opId: `create-${id}`,
    objectId: id,
    patch: {
      parentId: null,
      order: x / 1000,
      position: { x, y: 0 },
      size: { width: 180, height: 90 },
      content: { type: 'text', text },
    },
  });

describe('canvas shell: the outline', () => {
  let server: WebServer, browser: Browser, context: BrowserContext, page: Page, origin: string;
  let alpha: string, beta: string;
  const SHELL = { canvasEnabled: true, canvasShellEnabled: true };
  const settings = (value: Record<string, unknown>) => writeFileSync(dataPath('settings.json'), JSON.stringify(value));
  const api = (path: string) => `${origin}/x/api${path}`;
  const started: string[] = [];
  /** A session in a case, through the route the Run button uses. */
  async function start(caseName: string, sessionName: string): Promise<string> {
    const response = await page.request.post(api('/quick-start'), {
      data: { caseName, mode: 'shell', sessionName },
    });
    const body = await response.json();
    const id = (body.sessionId ?? body.data?.sessionId) as string;
    expect(id, JSON.stringify(body)).toBeTruthy();
    started.push(id);
    return id;
  }
  const liveSessions = async () => {
    const body = await (await page.request.get(api('/sessions'))).json();
    return (Array.isArray(body) ? body : (body.data ?? body.sessions ?? [])) as { id: string; workingDir: string }[];
  };
  const rowIds = () =>
    page
      .locator('#sessionRows button.session-row')
      .evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.sessionId));
  async function fresh(): Promise<Page> {
    await page?.close();
    page = await context.newPage();
    return page;
  }
  async function open(workspace = alpha) {
    await page.goto(`${origin}/x/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-object-id="n1"]');
    await page.waitForFunction(() => document.querySelector('#workspaceSwitch')?.textContent?.trim() !== 'Canvas');
  }

  beforeAll(async () => {
    settings(SHELL);
    for (const name of ['alpha', 'beta', 'gamma']) mkdirSync(resolve(resolveCasesDir(), name), { recursive: true });
    alpha = workspaceForCase('alpha').id;
    beta = workspaceForCase('beta').id;
    const stores = new CanvasStores();
    expect(
      stores.get(alpha).append([note('n1', 0, 'Alpha plan'), note('n2', 300, 'Budget')], { kind: 'human', userId: 'a' })
        .ok
    ).toBe(true);
    expect(stores.get(beta).append([note('n1', 0, 'Beta note')], { kind: 'human', userId: 'a' }).ok).toBe(true);
    stores.flush();
    server = new WebServer(0, false, true, undefined, undefined, undefined, '/x');
    await server.start();
    origin = `http://localhost:${server.boundPort}`;
    browser = await chromium.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: ['--no-sandbox'],
    });
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
    });
    await context.addInitScript(() => {
      if (!localStorage.getItem('codeman:skin')) localStorage.setItem('codeman:skin', 'og');
    });
    await fresh();
  }, 60000);
  afterEach(async () => {
    settings(SHELL);
    await context.setOffline(false);
    for (const id of started.splice(0)) {
      approvalInbox.resolveForSession(id, 'answered');
      await page.request.delete(api(`/sessions/${id}`)).catch(() => {});
    }
  });
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
  }, 60000);

  it('lists exactly the sessions of this workspace, and follows one made or ended elsewhere within five seconds', async () => {
    const mine = await start('alpha', 'alpha-shell');
    const theirs = await start('beta', 'beta-shell');
    await open();
    await page.waitForSelector(`#sessionRows button[data-session-id="${mine}"]`);
    expect(await rowIds()).toEqual([mine]);
    const row = page.locator(`#sessionRows button[data-session-id="${mine}"]`);
    expect(await row.getAttribute('aria-label')).toMatch(/^alpha-shell, Terminal, (Idle|Working)$/);
    expect(await row.locator('.session-meta').textContent()).toMatch(/^Terminal · (Idle|Working)$/);
    expect((await row.locator('.session-glyph').textContent())!.trim()).toHaveLength(1);
    // Made elsewhere (another client of the same server).
    const second = await start('alpha', 'second-shell');
    await page.waitForSelector(`#sessionRows button[data-session-id="${second}"]`, { timeout: 5000 });
    expect((await rowIds()).sort()).toEqual([mine, second].sort());
    expect(await rowIds()).not.toContain(theirs);
    // Ended elsewhere.
    await page.request.delete(api(`/sessions/${second}`));
    await page.waitForFunction(
      (id) => !document.querySelector(`#sessionRows button[data-session-id="${id}"]`),
      second,
      { timeout: 5000 }
    );
    expect(await rowIds()).toEqual([mine]);
  });

  it('moves a session that needs the person to the top, says so once, and counts it in the workspace list', async () => {
    const first = await start('alpha', 'first');
    const second = await start('alpha', 'second');
    await open();
    await page.waitForSelector(`#sessionRows button[data-session-id="${second}"]`);
    approvalInbox.notePrompt({ sessionId: second, sessionName: 'second', kind: 'permission' });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForSelector(`#sessionRows button.session-row[data-session-id="${second}"][data-state="needs"]`);
    const top = page.locator('#sessionRows button.session-row').first();
    expect(await top.getAttribute('data-state')).toBe('needs');
    expect(await top.getAttribute('aria-label')).toBe('second, Terminal, Needs you');
    expect(await page.locator('#sessionsAnnounce').textContent()).toBe('second needs you');
    expect((await rowIds())[1]).toBe(first);
    await page.keyboard.press('w');
    const current = page.locator('#workspaceRows a[aria-current="page"]');
    await current.waitFor();
    expect(await current.locator('.workspace-count').textContent()).toBe('1');
    expect(await current.getAttribute('aria-label')).toBe('alpha, open, 1 session needs you');
    expect(await page.locator(`#workspaceRows a[data-workspace-id="${beta}"] .workspace-count`).count()).toBe(0);
  });

  it('starts exactly one session from New session, with one row, and opens its terminal page', async () => {
    await open();
    await page.waitForFunction(() => document.querySelector('#sessionsState')?.textContent === 'No sessions');
    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/api/quick-start')) posts.push(r.postData() ?? '');
    });
    const before = (await liveSessions()).length;
    await page.locator('#newSession').click();
    expect(await page.locator('#newSession').getAttribute('aria-expanded')).toBe('true');
    const choices = page.locator('#newSessionList button');
    await choices.first().waitFor();
    expect(await choices.evaluateAll((list) => list.map((b) => (b as HTMLElement).dataset.mode))).toContain('shell');
    expect(await choices.last().textContent()).toBe('Shell');
    const shell = page.locator('#newSessionList button[data-mode="shell"]');
    // Pressed twice in one breath: still one request.
    await shell.evaluate((b: HTMLElement) => {
      b.click();
      b.click();
    });
    // The new session's terminal opens as a full view over the canvas; the window stays where it is.
    const src = new URL((await page.locator('#fullViewFrame iframe').getAttribute('src', { timeout: 10000 }))!, origin);
    expect(src.pathname).toMatch(/^\/x\/session\/[^/?]+$/);
    const id = decodeURIComponent(src.pathname.split('/').pop()!);
    started.push(id);
    expect(src.searchParams.get('from')).toBe('canvas');
    expect(src.searchParams.get('ws')).toBe(alpha);
    expect(new URL(page.url()).pathname).toBe(`/x/canvas/${alpha}`);
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]!)).toEqual({ caseName: 'alpha', mode: 'shell' });
    const after = await liveSessions();
    expect(after.length).toBe(before + 1);
    await open();
    await page.waitForSelector(`#sessionRows button[data-session-id="${id}"]`);
    expect(await rowIds()).toEqual([id]);
    // The classic view shows the same session.
    await page.goto(`${origin}/x/classic`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      (sid) => (window as unknown as { app?: { sessions?: Map<string, unknown> } }).app?.sessions?.has(sid),
      id
    );
  });

  it('opens the workspace list with W, moves with arrows, closes with Escape and switches with Enter', async () => {
    await open();
    await page.locator('#board').focus();
    await page.keyboard.press('w');
    const list = page.locator('#workspaceList');
    await list.waitFor({ state: 'visible' });
    expect(await page.locator('#workspaceSwitch').getAttribute('aria-expanded')).toBe('true');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-current') === 'page');
    expect(await page.locator('#workspaceRows a').evaluateAll((rows) => rows.map((r) => r.textContent))).toEqual([
      'alpha',
      'beta',
    ]);
    await page.keyboard.press('Escape');
    expect(await list.isVisible()).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('workspaceSwitch');
    expect(await page.locator('#workspaceSwitch').getAttribute('aria-expanded')).toBe('false');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-current') === 'page');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.workspaceId)).toBe(beta);
    await page.keyboard.press('Enter');
    await page.waitForURL(new RegExp(`/x/canvas/${beta}$`));
    await page.waitForFunction(() => document.querySelector('#workspaceSwitch')?.textContent === 'beta');
    expect(await page.title()).toBe('beta · Canvas');
    const cookies = await context.cookies(`${origin}/x/`);
    expect(cookies.find((c) => c.name === 'codeman_canvas_ws')?.value).toBe(beta);
  });

  it('makes a workspace for a case without one, and a new case from a typed name; a refusal keeps the text', async () => {
    await open();
    await page.locator('#workspaceSwitch').click();
    await page.locator('#newWorkspace').click();
    expect(await page.locator('#newWorkspace').getAttribute('aria-expanded')).toBe('true');
    await page.locator('#caseRows button[data-case-name="gamma"]').waitFor();
    expect(await page.locator('#caseRows button').evaluateAll((rows) => rows.map((r) => r.textContent))).toEqual([
      'gamma',
    ]);
    expect(await page.locator('#moreCases').getAttribute('href')).toBe('classic');
    // A name the server refuses: its sentence, under the field, and the text stays.
    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST') posts.push(new URL(r.url()).pathname);
    });
    await page.locator('#newCaseName').fill('two words');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() =>
      document.querySelector('#newCaseReason')?.textContent?.startsWith('Invalid case name')
    );
    expect(await page.locator('#newCaseName').inputValue()).toBe('two words');
    expect(posts).toEqual([]);
    await page.locator('#newCaseName').fill('alpha');
    await page.locator('#createCase').click();
    await page.waitForFunction(() => document.querySelector('#newCaseReason')?.textContent === 'Case already exists');
    expect(await page.locator('#newCaseName').inputValue()).toBe('alpha');
    expect(new URL(page.url()).pathname).toBe(`/x/canvas/${alpha}`);
    // A fresh name: the case, then its workspace, then its canvas.
    await page.locator('#newCaseName').fill('delta-1');
    await page.keyboard.press('Enter');
    await page.waitForURL((url) => /\/x\/canvas\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith(alpha));
    await page.waitForFunction(() => document.querySelector('#workspaceSwitch')?.textContent === 'delta-1');
    expect(existsSync(resolve(resolveCasesDir(), 'delta-1'))).toBe(true);
    // An existing case: only its workspace is made.
    await page.locator('#workspaceSwitch').click();
    await page.locator('#newWorkspace').click();
    await page.locator('#caseRows button[data-case-name="gamma"]').click();
    await page.waitForFunction(() => document.querySelector('#workspaceSwitch')?.textContent === 'gamma');
    const registry = JSON.parse(readFileSync(dataPath('workspaces.json'), 'utf8')) as {
      workspaces: { caseName: string }[];
    };
    expect(registry.workspaces.map((w) => w.caseName).sort()).toEqual(['alpha', 'beta', 'delta-1', 'gamma']);
  });

  it('goes to a session, a workspace or an object from Cmd/Ctrl+K, by literal text', async () => {
    const id = await start('alpha', 'api (v2)');
    await open();
    await page.waitForSelector(`#sessionRows button[data-session-id="${id}"]`);
    await page.locator('#board').focus();
    await page.keyboard.press('Control+k');
    await page.waitForFunction(() => document.activeElement?.id === 'search');
    const results = page.locator('#gotoResults');
    await results.waitFor({ state: 'visible' });
    expect(await page.locator('#search').getAttribute('placeholder')).toBe('Go to…');
    expect(await page.locator('#search').getAttribute('aria-label')).toBe('Go to a session, workspace or object');
    expect(await results.locator('.goto-title').allTextContents()).toEqual([
      'Sessions in this workspace',
      'Workspaces',
    ]);
    expect(await results.locator('.goto-more').getAttribute('href')).toBe('classic');
    await page.keyboard.type('(v2)');
    expect(
      await results.locator('button.goto-row').evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.id))
    ).toEqual([id]);
    await page.locator('#search').fill('.*');
    expect(await results.locator('button.goto-row').count()).toBe(0);
    expect(await results.locator('.shell-note').textContent()).toBe('Nothing here matches');
    // An object: Enter opens the first result, which focuses it on the board.
    await page.locator('#search').fill('budget');
    expect(await results.locator('.goto-title').allTextContents()).toEqual(['Objects on this canvas']);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.canvasView.read().focusId === 'n2');
    expect(await results.isVisible()).toBe(false);
    expect(await page.locator('#search').getAttribute('placeholder')).toBe('Search canvas');
    // Alt+K is the same command; a workspace result opens that workspace; arrows reach it.
    await page.locator('#board').focus();
    await page.keyboard.press('Alt+k');
    await page.waitForFunction(() => document.activeElement?.id === 'search');
    await page.locator('#search').fill('bet');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.group)).toBe('workspaces');
    await page.keyboard.press('Enter');
    await page.waitForURL(new RegExp(`/x/canvas/${beta}$`));
  });

  it('leaves Go to with Escape and keeps the plain search as it was', async () => {
    await open();
    await page.locator('#board').focus();
    await page.keyboard.press('Control+k');
    await page.locator('#gotoResults').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    expect(await page.locator('#gotoResults').isVisible()).toBe(false);
    await page.locator('#board').focus();
    await page.keyboard.press('/');
    await page.keyboard.type('budget');
    expect(await page.locator('#gotoResults').isVisible()).toBe(false);
    expect(await page.locator('#tree .tree-row:visible').count()).toBeGreaterThan(0);
  });

  it('reaches Sessions with S and walks the rows from the keyboard alone', async () => {
    const a = await start('alpha', 'one');
    const b = await start('alpha', 'two');
    await open();
    await page.waitForSelector(`#sessionRows button[data-session-id="${b}"]`);
    await page.locator('#board').focus();
    await page.keyboard.press('s');
    await page.waitForFunction(() => document.activeElement?.classList.contains('session-row'));
    const order = await rowIds();
    expect(order.sort()).toEqual([a, b].sort());
    const firstFocused = await page.evaluate(() => (document.activeElement as HTMLElement).dataset.sessionId);
    await page.keyboard.press('ArrowDown');
    const secondFocused = await page.evaluate(() => (document.activeElement as HTMLElement).dataset.sessionId);
    expect(new Set([firstFocused, secondFocused])).toEqual(new Set([a, b]));
    // S and W type into a field instead of acting.
    await page.locator('#search').focus();
    await page.keyboard.type('sw');
    expect(await page.locator('#search').inputValue()).toBe('sw');
    expect(await page.locator('#workspaceList').isVisible()).toBe(false);
    // The Keys view lists the shell's bindings.
    await page.locator('#search').fill('');
    await page.locator('#board').focus();
    await page.keyboard.press('?');
    expect(await page.locator('#keyRows').textContent()).toContain('Go to a session, workspace or object');
  });

  it('links to the classic view and to its settings from the foot of the outline', async () => {
    await open();
    expect(await page.locator('#classicView').isVisible()).toBe(true);
    expect(await page.locator('#classicView').getAttribute('href')).toBe('classic');
    await page.locator('#classicSettings').click();
    await page.waitForURL(/\/x\/classic/);
    await page.waitForFunction(() => document.getElementById('appSettingsModal')?.classList.contains('active'));
    expect(new URL(page.url()).search).toBe('');
    // A reload does not open Settings again.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#canvasShellLink');
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => document.getElementById('appSettingsModal')?.classList.contains('active'))).toBe(
      false
    );
  });

  it('shows one quiet line for what the classic view is waiting to say, and writes nothing', async () => {
    const today = new Date();
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const fixture = {
      notices: [{ id: 'fixture-notice', message: 'Check a thing', published: iso(today), expires: iso(today) }],
    };
    await fresh();
    await page.route('**/security-notices.json*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) })
    );
    await open();
    const line = page.locator('#shellLine');
    await line.waitFor({ state: 'visible' });
    expect(await line.textContent()).toBe('Security notice');
    expect(await page.locator('#shellLineLink').getAttribute('href')).toBe('classic');
    expect(await page.evaluate(() => localStorage.getItem('codeman-security-notices-seen'))).toBeNull();
    // Closed in the classic view: the line goes, and an unseen release takes its place.
    await page.evaluate(() => {
      localStorage.setItem('codeman-security-notices-seen', '["fixture-notice"]');
      localStorage.setItem('codeman-whats-new-seen', '0.0.1');
    });
    await open();
    await line.waitFor({ state: 'visible' });
    expect(await line.textContent()).toBe('Codeman was updated');
    expect(await page.evaluate(() => localStorage.getItem('codeman-whats-new-seen'))).toBe('0.0.1');
    await page.evaluate(() => localStorage.removeItem('codeman-whats-new-seen'));
    await open();
    await page.waitForTimeout(800);
    expect(await line.isVisible()).toBe(false);
  });

  it('offline, keeps the last list readable and says why starting and creating are unavailable', async () => {
    const id = await start('alpha', 'kept');
    await open();
    await page.waitForSelector(`#sessionRows button[data-session-id="${id}"]`);
    await context.setOffline(true);
    await page.waitForFunction(() => document.querySelector('#sessionsState')?.textContent?.startsWith('Last known'));
    expect(await rowIds()).toEqual([id]);
    expect(await page.locator('#newSession').getAttribute('aria-disabled')).toBe('true');
    expect(await page.locator('#newSession').getAttribute('title')).toBe('Unavailable while Codeman cannot be reached');
    expect(await page.locator(`#sessionRows button[data-session-id="${id}"]`).getAttribute('aria-disabled')).toBe(
      'true'
    );
    await page.locator('#newSession').evaluate((b: HTMLElement) => b.click());
    expect(await page.locator('#newSessionList').isVisible()).toBe(false);
    expect(await page.locator('#newSessionReason').textContent()).toBe('Unavailable while Codeman cannot be reached');
    await page.locator(`#sessionRows button[data-session-id="${id}"]`).evaluate((b: HTMLElement) => b.click());
    await page.waitForTimeout(300);
    expect(new URL(page.url()).pathname).toBe(`/x/canvas/${alpha}`);
    expect(await page.locator('#classicView').isVisible()).toBe(true);
    await context.setOffline(false);
    await page.waitForFunction(() => document.querySelector('#newSession')?.getAttribute('aria-disabled') === 'false');
  });

  it('says so when the session list cannot load, and tries again on request; the board is unaffected', async () => {
    await fresh();
    let fail = true;
    await page.route('**/api/canvas/*/sessions', (route) =>
      fail
        ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"success":false,"error":"x"}' })
        : route.continue()
    );
    await open();
    await page.waitForFunction(
      () => document.querySelector('#sessionsState')?.textContent === 'Sessions could not load'
    );
    expect(await page.locator('[data-object-id="n1"]').isVisible()).toBe(true);
    fail = false;
    await page.locator('#sessionsRetry').click();
    await page.waitForFunction(() => document.querySelector('#sessionsState')?.textContent === 'No sessions');
    expect(await page.locator('#sessionsRetry').isVisible()).toBe(false);
  });

  it('has no Sessions section, workspace list or classic links with the shell off or inside a frame', async () => {
    await fresh();
    const asked: string[] = [];
    page.on('request', (r) => asked.push(new URL(r.url()).pathname));
    settings({ canvasEnabled: true });
    await page.goto(`${origin}/x/canvas/${alpha}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-object-id="n1"]');
    await page.waitForFunction(() => document.querySelector('#workspaceName')?.textContent === 'alpha');
    for (const id of ['sessions', 'workspaceSwitch', 'classicView', 'classicSettings', 'shellLine'])
      expect(await page.locator(`#${id}`).isVisible(), id).toBe(false);
    expect(await page.locator('#workspaceName').isVisible()).toBe(true);
    await page.locator('#board').focus();
    await page.keyboard.press('Control+k');
    await page.keyboard.press('s');
    await page.keyboard.press('w');
    await page.waitForTimeout(300);
    expect(await page.locator('#gotoResults').isVisible()).toBe(false);
    expect(await page.locator('#workspaceList').isVisible()).toBe(false);
    expect(asked.filter((p) => p.endsWith('/sessions') || p.endsWith('/reboot-restore'))).toEqual([]);
    // Shell on, but the canvas is a frame inside the dashboard.
    settings(SHELL);
    await page.goto(`${origin}/x/classic`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.header');
    await page.evaluate((src) => {
      const frame = document.createElement('iframe');
      frame.id = 'probe';
      frame.src = src;
      frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:99999';
      document.body.appendChild(frame);
    }, `${origin}/x/canvas/${alpha}`);
    const frame = page.frameLocator('#probe');
    await frame.locator('[data-object-id="n1"]').waitFor();
    for (const id of ['sessions', 'workspaceSwitch', 'classicView'])
      expect(await frame.locator(`#${id}`).isVisible(), `framed ${id}`).toBe(false);
  });

  it('shows the first-run page when there is no workspace, and creates nothing by itself', async () => {
    writeFileSync(dataPath('workspaces.json'), JSON.stringify({ version: 1, workspaces: [] }));
    await fresh();
    await page.goto(`${origin}/x/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#firstRun');
    expect(await page.evaluate(() => window.__canvasBoot?.ok)).toBe(true);
    expect(await page.locator('#state h1').textContent()).toBe('Start with a workspace');
    expect(await page.locator('#state p').first().textContent()).toContain('A workspace is the canvas of one case');
    await page.locator('#firstRunCases button').first().waitFor();
    const names = await page.locator('#firstRunCases .case-name').allTextContents();
    expect(names).toEqual(expect.arrayContaining(['alpha', 'beta', 'gamma']));
    expect(await page.locator('#classicLink').isVisible()).toBe(true);
    expect(await page.locator('#outline').isVisible()).toBe(false);
    await page.waitForTimeout(500);
    expect(JSON.parse(readFileSync(dataPath('workspaces.json'), 'utf8')).workspaces).toEqual([]);
    // A refused name keeps the text; nothing was created.
    await page.locator('#firstRunName').fill('no good');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() =>
      document.querySelector('#firstRunReason')?.textContent?.startsWith('Invalid case name')
    );
    expect(await page.locator('#firstRunName').inputValue()).toBe('no good');
    expect(JSON.parse(readFileSync(dataPath('workspaces.json'), 'utf8')).workspaces).toEqual([]);
    // Open canvas beside a case makes that case's workspace and opens it.
    await page.locator('#firstRunCases button[data-case-name="beta"]').click();
    await page.waitForURL(/\/x\/canvas\/[^/]+$/);
    await page.waitForFunction(() => document.querySelector('#workspaceSwitch')?.textContent === 'beta');
    expect(
      JSON.parse(readFileSync(dataPath('workspaces.json'), 'utf8')).workspaces.map(
        (w: { caseName: string }) => w.caseName
      )
    ).toEqual(['beta']);
  });
});
