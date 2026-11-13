/**
 * Background tasks (PC12) in the browser: Run in background beside Send, the task list as a rail view, the quiet
 * count, cancel and remove. Sessions are the server's test stand-ins and transcripts are written by the test, so no
 * agent runs a task here; worktrees are made by real git in a temporary repository.
 */
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import puppeteer from 'puppeteer';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { RUN_INTERRUPTED } from '../packages/canvas/src/task.js';
import { resolve, join } from 'node:path';
import { WebServer } from '../src/web/server.js';
import { dataPath } from '../src/config/instance.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';
import { CanvasStores } from '../src/canvas/canvas-store.js';
import { CommandSchema } from '../src/canvas/operations.js';
import { CONTEXT_NOTICE } from '../src/canvas/conversation-schema.js';
import { replyRouting } from '../src/web/routes/canvas-conversation-routes.js';
import { forgetLeftBehind } from '../src/web/routes/canvas-task-routes.js';
import { approvalInbox } from '../src/web/approval-inbox.js';
import type { TaskRow } from '../src/canvas/tasks.js';

const installed = vi.hoisted(() => ({ map: { claude: true } as Record<string, boolean> }));
vi.mock('../src/utils/cli-installed-probes.js', async (original) => ({
  ...(await original<typeof import('../src/utils/cli-installed-probes.js')>()),
  probeStockCliAvailability: async () => installed.map,
}));

const MEDIA = resolve('pr/media');
const stamp = Date.now();
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
type Post = { method: string; path: string; body: Record<string, unknown> };

describe('canvas background tasks', () => {
  let server: WebServer, browser: Browser, desktop: BrowserContext, page: Page, origin: string, workspace: string;
  let casePath: string;
  const posts: Post[] = [];
  const shot = (name: string) =>
    page.screenshot({ animations: 'disabled', path: resolve(MEDIA, `pc12-${stamp}-${name}.png`) });
  const api = (path: string) => `${origin}/x/api${path}`;
  const view = () => page.evaluate(() => window.canvasView.read());
  const tasks = async (ws = workspace) =>
    (await (await page.request.get(api(`/canvas/${ws}/tasks`))).json()).data.tasks as TaskRow[];
  const conversations = async () =>
    (await (await page.request.get(api(`/canvas/${workspace}/conversations`))).json()).data.conversations as {
      id: string;
      sessionId: string;
      task?: unknown;
      messages?: unknown;
    }[];
  const worktrees = () => {
    const root = join(casePath, '.claude', 'worktrees');
    return existsSync(root) ? readdirSync(root) : [];
  };
  const hook = (event: string, sessionId: string) =>
    page.request.post(api('/hook-event'), { data: { event, sessionId, data: { session_id: sessionId } } });
  /** The task session's transcript as Claude Code writes it: the request, then the agent's reply. */
  async function transcript(task: TaskRow, prompt: string, replies: string[]) {
    const record = (await (await page.request.get(api(`/canvas/${workspace}/conversations/${task.id}`))).json()).data
      .conversation as { messages: { messageId: string }[] };
    const dir = join(process.env.HOME!, '.claude', 'projects', 'fixture');
    mkdirSync(dir, { recursive: true });
    const lines = [
      {
        type: 'user',
        timestamp: '2026-11-13T10:00:00Z',
        message: {
          role: 'user',
          content: `<canvas-context workspace="${workspace}" seq="2" message="${record.messages[0].messageId}">\n[n1 rev=1 type=text path=""] x\n</canvas-context>\n${CONTEXT_NOTICE}\n${prompt}`,
        },
      },
      ...replies.map((text) => ({
        type: 'assistant',
        timestamp: '2026-11-13T10:00:30Z',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      })),
    ];
    writeFileSync(join(dir, `${task.sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  async function closeRail() {
    for (let i = 0; i < 3 && (await page.locator('#rail').isVisible()); i++) await page.keyboard.press('Escape');
    await page.waitForSelector('#rail', { state: 'hidden' });
  }
  async function openAssistant() {
    if (!(await page.locator('#assistantView').isVisible())) {
      await closeRail();
      await page.locator('#assistantTool').click();
    }
    await page.waitForSelector('#assistantView:not([hidden])');
  }
  async function openTasks() {
    if (!(await page.locator('#tasksView').isVisible())) await page.locator('#tasksTool').click();
    await page.waitForSelector('#tasksView:not([hidden])');
  }
  const rowText = (id: string, part: string) => page.locator(`.task-row[data-task-id="${id}"] .task-${part}`);
  const count = () =>
    page.locator('#tasksCount').evaluate((el) => ((el as HTMLElement).hidden ? '' : (el.textContent ?? '')));
  function repo(name: string, git: boolean): string {
    const path = resolve(resolveCasesDir(), name);
    mkdirSync(path, { recursive: true });
    if (git) {
      const run = (...args: string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf8' });
      run('init', '-q', '-b', 'main');
      writeFileSync(join(path, 'README.md'), 'hello\n');
      run('add', 'README.md');
      run('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'first');
    }
    return path;
  }
  function seed(name: string): string {
    const id = workspaceForCase(name).id;
    const stores = new CanvasStores();
    expect(
      stores.get(id).append([note('n1', 0, 'Reading patterns'), note('n2', 220, 'Reference notes')], {
        kind: 'human',
        userId: 'a',
      }).ok
    ).toBe(true);
    stores.flush();
    return id;
  }
  async function load(target: Page, ws: string) {
    await target.goto(`${origin}/x/canvas/${ws}`, { waitUntil: 'domcontentloaded' });
    await target.waitForSelector('[data-object-id="n1"]');
    await target.waitForFunction(() => !!window.canvasView);
    await target.waitForFunction(
      () => document.querySelectorAll('#providerSelect option[value="claude"]').length === 1
    );
  }
  function watch(target: Page) {
    target.on('request', (r) => {
      const path = /\/api\/canvas\/[^/]+(\/(?:command|conversations|tasks)[^?]*)/.exec(r.url())?.[1];
      if (r.method() !== 'GET' && path)
        posts.push({
          method: r.method(),
          path: path.replace(/[0-9a-f-]{36}/, ':id'),
          body: JSON.parse(r.postData() || '{}'),
        });
    });
  }

  beforeAll(async () => {
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-pc12-tasks');
    Object.assign(replyRouting, { settleDelayMs: 50, retryDelaysMs: [200, 600] });
    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasEnabled: true }));
    casePath = repo('Tasknotes', true);
    repo('Plainnotes', false);
    workspace = seed('Tasknotes');
    seed('Plainnotes');
    server = new WebServer(0, false, true, undefined, undefined, undefined, '/x');
    await server.start();
    origin = `http://localhost:${server.boundPort}`;
    browser = await chromium.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: ['--no-sandbox'],
    });
    desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await desktop.addInitScript(() => {
      if (!localStorage.getItem('codeman:skin')) localStorage.setItem('codeman:skin', 'og');
    });
    page = await desktop.newPage();
    watch(page);
    mkdirSync(MEDIA, { recursive: true });
    await load(page, workspace);
  }, 60000);
  afterEach(() => {
    posts.length = 0;
  });
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    vi.unstubAllEnvs();
  }, 60000);

  it('Run in background sits beside Send, is off for an empty request, and Keys lists both bindings as live', async () => {
    await openAssistant();
    const run = page.locator('#runBackground');
    expect(await run.isVisible()).toBe(true);
    expect(await run.isDisabled()).toBe(true);
    expect(await run.textContent()).toContain('Run in background');
    const [runBox, sendBox] = [await run.boundingBox(), await page.locator('#assistantSend').boundingBox()];
    expect(Math.abs(runBox!.y - sendBox!.y)).toBeLessThan(4);
    expect(runBox!.x + runBox!.width).toBeLessThanOrEqual(sendBox!.x);
    await page.locator('#assistantDraft').fill('   ');
    expect(await run.isDisabled()).toBe(true);
    await page.locator('#assistantDraft').press('Control+Shift+Enter');
    await page.waitForTimeout(200);
    expect(posts).toEqual([]);
    await page.locator('#assistantDraft').fill('');
    await closeRail();
    await page.keyboard.press('?');
    const rows = await page
      .locator('#keyRows .key-row')
      .evaluateAll((els) => els.map((e) => [e.textContent ?? '', e.classList.contains('key-later')] as const));
    for (const name of ['Inspect chat background agents', 'Run chat message in the background'])
      expect(rows.find(([text]) => text.startsWith(name))?.[1]).toBe(false);
    expect(rows.some(([text]) => text.includes('Not bound yet'))).toBe(false);
    await closeRail();
  });

  it('G opens the task list from the canvas only, and a view command opens it without starting anything', async () => {
    await page.locator('#board').focus();
    await page.keyboard.press('g');
    await page.waitForSelector('#tasksView:not([hidden])');
    expect(await page.locator('#railTitle').textContent()).toBe('Background tasks');
    expect(await page.locator('#tasksEmpty').isVisible()).toBe(true);
    expect(await page.locator('#tasksTool').getAttribute('aria-pressed')).toBe('true');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#rail', { state: 'hidden' });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('board');
    // Typing a g is typing.
    await openAssistant();
    await page.locator('#assistantDraft').click();
    await page.keyboard.type('gg');
    expect(await page.locator('#assistantDraft').inputValue()).toBe('gg');
    expect(await page.locator('#assistantView').isVisible()).toBe(true);
    // A g that ends an IME composition is not the shortcut either.
    await page.locator('#assistantDraft').fill('');
    await closeRail();
    await page.locator('#board').focus();
    await page.evaluate(() =>
      document
        .getElementById('board')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true, isComposing: true }))
    );
    await page.evaluate(() =>
      document
        .getElementById('board')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true, repeat: true }))
    );
    expect(await page.locator('#rail').isVisible()).toBe(false);
    await page.evaluate(() => window.canvasView.dispatch({ kind: 'rail', view: 'tasks' }));
    await page.waitForSelector('#tasksView:not([hidden])');
    await page.waitForTimeout(200);
    expect(posts).toEqual([]);
    expect(await tasks()).toEqual([]);
    await closeRail();
  });

  it('runs the draft and its context as a named task in its own worktree, and leaves the foreground alone', async () => {
    await openAssistant();
    await page.evaluate(() => {
      window.canvasView.dispatch({ kind: 'selection', ids: ['n2'] });
      window.canvasView.dispatch({ kind: 'context-add', ids: ['n1'] });
    });
    await page.waitForSelector('#contextChips .chip');
    await page.locator('#assistantDraft').click();
    await page.keyboard.type('Summarise the reading patterns note');
    const before = await view();
    await shot('composer');
    await page.locator('#runBackground').click();
    await page.waitForFunction(() => (document.getElementById('assistantDraft') as HTMLTextAreaElement).value === '');
    await page.waitForFunction(() => document.querySelectorAll('#contextChips .chip').length === 0);
    expect(posts.map((p) => [p.method, p.path])).toEqual([['POST', '/tasks']]);
    expect(posts[0].body).toMatchObject({
      text: 'Summarise the reading patterns note',
      refIds: ['n1'],
      cliId: 'claude',
    });
    expect(posts[0].body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(posts[0].body).not.toHaveProperty('shared');
    // The foreground conversation, the rail view, the selection and the camera are as they were; focus is back in the composer.
    const after = await view();
    expect(after.conversationId).toBe(before.conversationId);
    expect(after.rail).toEqual(before.rail);
    expect(after.selected).toEqual(['n2']);
    expect(after.viewport).toEqual(before.viewport);
    expect(await page.locator('#assistantView').isVisible()).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('assistantDraft');
    expect(await page.locator('#assistantStatus').textContent()).toBe(
      'Running in the background: Summarise the reading patterns note'
    );
    expect(await page.locator('#runBackground').isDisabled()).toBe(true);
    expect(await page.locator('dialog[open], [role="dialog"]').count()).toBe(0);
    // The stored request id is gone once the server acknowledged it.
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.endsWith(':task:outbox')).length)).toBe(
      0
    );
    const [task] = await tasks();
    expect(task).toMatchObject({
      name: 'Summarise the reading patterns note',
      cliId: 'claude',
      refs: [{ id: 'n1', label: 'Reading patterns' }],
    });
    const [name] = worktrees();
    expect(task.isolation).toEqual({
      kind: 'worktree',
      label: `.claude/worktrees/${name}`,
      branch: `worktree-${name}`,
    });
    // One session, and the rail's conversation picker is not flooded by it.
    const listed = await conversations();
    expect(listed).toHaveLength(1);
    expect(listed[0].task).toBeTruthy();
    expect(await page.locator('#conversationPicker option').allTextContents()).toEqual(['New conversation']);
    expect((await view()).conversationId).toBeNull();
    await shot('started');
  });

  it('lists the task with its name, provider, isolation and state, and never shows a server path', async () => {
    const [task] = await tasks();
    await openTasks();
    await page.waitForSelector(`.task-row[data-task-id="${task.id}"]`);
    expect(await rowText(task.id, 'name').textContent()).toBe('Summarise the reading patterns note');
    await page.waitForFunction(() => document.querySelector('.task-state')?.textContent === 'Running');
    const meta = await rowText(task.id, 'meta').first().textContent();
    expect(meta).toContain('Claude');
    expect(meta).toContain(task.isolation.label);
    const text = (await page.locator('#tasksView').textContent()) ?? '';
    expect(text).not.toContain(casePath);
    expect(text).not.toContain(process.env.HOME!);
    const controls = await page
      .locator(`.task-row[data-task-id="${task.id}"] button`)
      .evaluateAll((els) => els.map((e) => e.textContent));
    expect(controls).toEqual(['Context: Reading patterns', 'Inspect', 'Cancel']);
    // The context link selects the object where it is.
    const before = await view();
    await page.locator('.task-links button').first().click();
    const after = await view();
    expect(after.selected).toEqual(['n1']);
    expect(after.viewport).toEqual(before.viewport);
    await shot('list-running');
    await closeRail();
  });

  it('shows waiting for you, then the result when the turn ends, and counts it quietly until the list is opened', async () => {
    const [task] = await tasks();
    expect(await count()).toBe('');
    await page.request.post(api('/hook-event'), {
      data: {
        event: 'permission_prompt',
        sessionId: task.sessionId,
        data: { session_id: task.sessionId, message: 'May I run git status?' },
      },
    });
    await page.waitForFunction(() => document.getElementById('tasksCount')?.textContent === '1');
    expect((await tasks())[0].state).toBe('waiting');
    expect(await page.locator('#tasksTool').getAttribute('aria-label')).toBe('Background tasks, 1 to look at');
    await openTasks();
    await page.waitForFunction(() => document.querySelector('.task-state')?.textContent === 'Waiting for you');
    await closeRail();
    approvalInbox.resolveForSession(task.sessionId, 'answered');
    await hook('prompt_submitted', task.sessionId);
    await transcript(task, 'Summarise the reading patterns note', ['Readers scan headings first.', 'Then the lede.']);
    const before = await view();
    await hook('stop', task.sessionId);
    await page.waitForFunction(() => document.getElementById('tasksCount')?.textContent === '1', undefined, {
      timeout: 15000,
    });
    await expect.poll(async () => (await tasks())[0].state, { timeout: 15000 }).toBe('completed');
    // The arrival moved nothing.
    const after = await view();
    expect(after.viewport).toEqual(before.viewport);
    expect(after.selected).toEqual(before.selected);
    expect(after.rail).toEqual(before.rail);
    await openTasks();
    await page.waitForFunction(() => document.querySelector('.task-state')?.textContent === 'Completed');
    expect(await rowText(task.id, 'result').textContent()).toBe('Readers scan headings first.\n\nThen the lede.');
    expect(await count()).toBe('');
    await shot('list-completed');
    await closeRail();
    expect(await count()).toBe('');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.canvasView);
    await page.waitForSelector('[data-object-id="n1"]');
    await page.waitForTimeout(600);
    expect(await count()).toBe('');
  }, 60000);

  it('Inspect shows the task session in the assistant rail without moving the camera', async () => {
    const [task] = await tasks();
    await openTasks();
    const before = await view();
    await page.locator(`.task-row[data-task-id="${task.id}"] [data-task-control$=":inspect"]`).click();
    await page.waitForSelector('#assistantView:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('#thread .turn').length >= 2);
    const after = await view();
    expect(after.conversationId).toBe(task.id);
    expect(after.viewport).toEqual(before.viewport);
    expect(
      await page.locator('#conversationPicker').evaluate((el) => (el as HTMLSelectElement).selectedOptions[0].text)
    ).toBe('Task · Summarise the reading patterns note');
    const turns = await page.locator('#thread .turn').evaluateAll((els) => els.map((e) => e.textContent ?? ''));
    expect(turns[0]).toContain('Summarise the reading patterns note');
    expect(turns[0]).not.toContain('canvas-context');
    await page.locator('#newConversation').click();
    expect((await view()).conversationId).toBeNull();
    await closeRail();
  });

  it('a failed run keeps the draft and its request id, and the retry starts one task', async () => {
    await openAssistant();
    await page.locator('#assistantDraft').click();
    await page.keyboard.type('Check the reference notes');
    let failed = 0;
    await page.route('**/api/canvas/*/tasks', async (route) => {
      if (route.request().method() === 'POST' && failed++ === 0) await route.abort();
      else await route.continue();
    });
    await page.keyboard.press('Control+Shift+Enter');
    await page.waitForSelector('#backgroundNote:not([hidden])');
    expect(await page.locator('#backgroundNote').textContent()).toBe(
      'Could not reach the server. Your message is kept.'
    );
    expect(await page.locator('#assistantDraft').inputValue()).toBe('Check the reference notes');
    expect(await tasks()).toHaveLength(1);
    // The id survives a reload with the draft.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.canvasView);
    await page.waitForFunction(() => document.querySelectorAll('#providerSelect option[value="claude"]').length === 1);
    await openAssistant();
    expect(await page.locator('#assistantDraft').inputValue()).toBe('Check the reference notes');
    await page.locator('#assistantDraft').click();
    await page.keyboard.press('Control+Shift+Enter');
    await page.waitForFunction(() => (document.getElementById('assistantDraft') as HTMLTextAreaElement).value === '');
    await page.unroute('**/api/canvas/*/tasks');
    const sent = posts.filter((p) => p.path === '/tasks');
    expect(sent).toHaveLength(2);
    expect(sent[1].body.requestId).toBe(sent[0].body.requestId);
    expect(await tasks()).toHaveLength(2);
    expect(worktrees()).toHaveLength(2);
    expect(await page.locator('#backgroundNote').isVisible()).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('assistantDraft');
  });

  it('Cancel stops only that task; Remove asks inline, ends the session and removes the clean worktree', async () => {
    const all = await tasks();
    const running = all.find((t) => t.state !== 'completed')!;
    const done = all.find((t) => t.state === 'completed')!;
    await openTasks();
    await page.waitForSelector(`.task-row[data-task-id="${running.id}"] [data-task-control$=":cancel"]`);
    await page.locator(`.task-row[data-task-id="${running.id}"] [data-task-control$=":cancel"]`).click();
    await page.waitForFunction(
      (id) => document.querySelector(`.task-row[data-task-id="${id}"] .task-state`)?.textContent === 'Cancelled',
      running.id
    );
    expect((await tasks()).find((t) => t.id === done.id)!.state).toBe('completed');
    expect(posts.filter((p) => p.path.endsWith('/cancel'))).toHaveLength(1);
    // Cancelling keeps the session and the worktree for inspection.
    expect(worktrees()).toHaveLength(2);
    const remove = page.locator(`.task-row[data-task-id="${running.id}"] [data-task-control$=":remove"]`);
    await remove.click();
    await page.waitForSelector('.revert-confirm');
    expect(await page.locator('dialog[open], [role="dialog"]').count()).toBe(0);
    expect(posts.filter((p) => p.method === 'DELETE')).toEqual([]);
    expect(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.taskControl)).toBe(
      `${running.id}:keep`
    );
    await shot('remove-confirm');
    await page.locator('[data-task-control$=":keep"]').click();
    await page.waitForSelector('.revert-confirm', { state: 'detached' });
    expect(await tasks()).toHaveLength(2);
    await remove.click();
    await page.locator('[data-task-control$=":confirm"]').click();
    await page.waitForSelector(`.task-row[data-task-id="${running.id}"]`, { state: 'detached' });
    expect(await page.locator('#tasksStatus').textContent()).toBe('Task removed.');
    expect((await tasks()).map((t) => t.id)).toEqual([done.id]);
    expect(worktrees()).toHaveLength(1);
    expect((await conversations()).map((c) => c.id)).toEqual([done.id]);
    await closeRail();
  });

  it('Remove keeps a worktree that has changes and says where it is inside the case', async () => {
    const [task] = await tasks();
    const [name] = worktrees();
    writeFileSync(join(casePath, '.claude', 'worktrees', name, 'notes.txt'), 'kept\n');
    await openTasks();
    await page.locator(`.task-row[data-task-id="${task.id}"] [data-task-control$=":remove"]`).click();
    await page.locator('[data-task-control$=":confirm"]').click();
    await page.waitForSelector('.task-kept');
    expect(await page.locator('.task-kept').textContent()).toBe(
      `The worktree .claude/worktrees/${name} has changes, so it was kept.`
    );
    expect((await page.locator('#tasksView').textContent()) ?? '').not.toContain(casePath);
    expect(existsSync(join(casePath, '.claude', 'worktrees', name, 'notes.txt'))).toBe(true);
    await shot('kept');
    await closeRail();
  });

  it('in a folder that is not a git repository, asks before sharing the case folder', async () => {
    const plain = workspaceForCase('Plainnotes').id;
    const other = await desktop.newPage();
    watch(other);
    try {
      await load(other, plain);
      await other.locator('#assistantTool').click();
      await other.waitForSelector('#assistantView:not([hidden])');
      await other.locator('#assistantDraft').click();
      await other.keyboard.type('Tidy this folder');
      posts.length = 0;
      await other.locator('#runBackground').click();
      await other.waitForSelector('#backgroundShareRow:not([hidden])');
      expect(await other.locator('#backgroundNote').textContent()).toContain('not a git repository');
      expect(await other.locator('#assistantDraft').inputValue()).toBe('Tidy this folder');
      expect(await tasks(plain)).toEqual([]);
      await other.screenshot({ animations: 'disabled', path: resolve(MEDIA, `pc12-${stamp}-shared-ask.png`) });
      // Pressing again without agreeing still starts nothing.
      await other.locator('#runBackground').click();
      await other.waitForFunction(() => !document.getElementById('runBackground')!.hasAttribute('disabled'));
      expect(await tasks(plain)).toEqual([]);
      await other.locator('#backgroundShared').check();
      await other.locator('#runBackground').click();
      await other.waitForFunction(
        () => (document.getElementById('assistantDraft') as HTMLTextAreaElement).value === ''
      );
      const sent = posts.filter((p) => p.path === '/tasks');
      expect(sent.at(-1)!.body).toMatchObject({ shared: true, requestId: sent[0].body.requestId });
      const [task] = await tasks(plain);
      expect(task.isolation).toEqual({ kind: 'shared', label: 'Case folder, shared' });
      expect(await other.locator('#backgroundShareRow').isVisible()).toBe(false);
    } finally {
      await other.close();
    }
  });

  describe('fix round 1', () => {
    const ready = async () => {
      await page.waitForFunction(() => !!window.canvasView);
      await page.waitForFunction(
        () => document.querySelectorAll('#providerSelect option[value="claude"]').length === 1
      );
    };
    const draft = () => page.locator('#assistantDraft').inputValue();

    it('while a run is on its way Send is off, a second press starts nothing, and a reload in between is said', async () => {
      await load(page, workspace);
      await openAssistant();
      await page.locator('#assistantDraft').click();
      await page.keyboard.type('Draft the outline');
      const before = (await tasks()).length;
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      await page.route('**/api/canvas/*/tasks', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        await held;
        await route.continue().catch(() => undefined);
      });
      await page.keyboard.press('Control+Shift+Enter');
      await page.waitForFunction(() => document.getElementById('assistantSend')!.hasAttribute('disabled'));
      expect(await page.locator('#runBackground').isDisabled()).toBe(true);
      await page.locator('#assistantDraft').press('Enter');
      await page.locator('#assistantDraft').press('Control+Shift+Enter');
      await page.waitForTimeout(300);
      expect(posts.filter((p) => p.path.startsWith('/conversations'))).toEqual([]);
      expect(posts.filter((p) => p.path === '/tasks')).toHaveLength(1);
      // The page goes away before any answer: the request never reached the server.
      await page.reload({ waitUntil: 'domcontentloaded' });
      release();
      await page.unroute('**/api/canvas/*/tasks');
      await ready();
      await openAssistant();
      await page.waitForSelector('#backgroundNote:not([hidden])');
      expect(await page.locator('#backgroundNote').textContent()).toBe(RUN_INTERRUPTED);
      expect(await draft()).toContain('Draft the outline');
      expect(await tasks()).toHaveLength(before);
      // Pressing again is the same request, and one task.
      await page.locator('#assistantDraft').fill('Draft the outline');
      await page.locator('#assistantDraft').press('Control+Shift+Enter');
      await page.waitForFunction(() => (document.getElementById('assistantDraft') as HTMLTextAreaElement).value === '');
      const sent = posts.filter((p) => p.path === '/tasks');
      expect(sent.at(-1)!.body.requestId).toBe(sent[0].body.requestId);
      expect(await tasks()).toHaveLength(before + 1);
      expect(await page.locator('#backgroundNote').isVisible()).toBe(false);
    });

    it('a reload after the server started the task settles by itself: the text leaves the composer and nothing runs twice', async () => {
      await openAssistant();
      await page.locator('#assistantDraft').click();
      await page.keyboard.type('Collect the references');
      const before = (await tasks()).length;
      let started!: () => void;
      const reached = new Promise<void>((r) => (started = r));
      await page.route('**/api/canvas/*/tasks', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        // The server takes the request; its answer never reaches the page.
        await route.fetch().catch(() => undefined);
        started();
      });
      await page.keyboard.press('Control+Shift+Enter');
      await reached;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.unroute('**/api/canvas/*/tasks');
      await ready();
      await page.waitForFunction(
        () => (document.getElementById('assistantDraft') as HTMLTextAreaElement).value === '',
        undefined,
        { timeout: 15_000 }
      );
      await openAssistant();
      expect(await page.locator('#backgroundNote').isVisible()).toBe(false);
      const all = await tasks();
      expect(all).toHaveLength(before + 1);
      expect(all.filter((t) => t.name === 'Collect the references')).toHaveLength(1);
    });

    it('a cancelled task says its session is kept for inspection only, takes no message, and leaves the picker when the rail moves on', async () => {
      const task = (await tasks()).find((t) => t.name === 'Collect the references')!;
      await openTasks();
      await page.locator(`.task-row[data-task-id="${task.id}"] [data-task-control$=":cancel"]`).click();
      await page.waitForFunction(
        (id) => document.querySelector(`.task-row[data-task-id="${id}"] .task-state`)?.textContent === 'Cancelled',
        task.id
      );
      expect(await page.locator(`.task-row[data-task-id="${task.id}"] .task-kept`).first().textContent()).toContain(
        'kept for inspection only and takes no more messages'
      );
      await page.locator(`.task-row[data-task-id="${task.id}"] [data-task-control$=":inspect"]`).click();
      await page.waitForSelector('#assistantView:not([hidden])');
      await page.waitForFunction((id) => window.canvasView.read().conversationId === id, task.id);
      const options = () =>
        page.locator('#conversationPicker option').evaluateAll((els) => els.map((e) => e.textContent ?? ''));
      expect((await options()).filter((text) => text.startsWith('Task ·'))).toHaveLength(1);
      posts.length = 0;
      await page.locator('#assistantDraft').fill('One more thing');
      await page.locator('#assistantDraft').press('Enter');
      await page.waitForFunction(() =>
        (document.getElementById('assistantView')!.textContent ?? '').includes(
          'This task was cancelled. Start a new one.'
        )
      );
      expect(posts).toEqual([]);
      expect(await draft()).toBe('One more thing');
      await page.locator('#assistantDraft').fill('');
      // Choosing another entry in the picker drops the task from it.
      await page.locator('#conversationPicker').selectOption({ index: 0 });
      await page.waitForFunction((id) => window.canvasView.read().conversationId !== id, task.id);
      expect((await options()).filter((text) => text.startsWith('Task ·'))).toEqual([]);
      await closeRail();
    });

    it('G pressed inside the task list closes it', async () => {
      await closeRail();
      await openTasks();
      await page.locator('#taskList [data-task-control]').first().focus();
      await page.keyboard.press('g');
      await page.waitForSelector('#tasksView', { state: 'hidden' });
      expect(await page.locator('#rail').isVisible()).toBe(false);
      await page.locator('#board').focus();
      await page.keyboard.press('g');
      await page.waitForSelector('#tasksView:not([hidden])');
      await closeRail();
    });

    it('a worktree a failed start left behind is listed and removed only when it is clean', async () => {
      const run = (...args: string[]) => execFileSync('git', args, { cwd: casePath, encoding: 'utf8' });
      run('worktree', 'add', '-q', '-b', 'worktree-task-0badc0de', join('.claude', 'worktrees', 'task-0badc0de'));
      forgetLeftBehind();
      await openTasks();
      const row = page.locator('.task-row[data-left-behind="task-0badc0de"]');
      await row.waitFor();
      expect(await row.locator('.task-meta').textContent()).toBe(
        '.claude/worktrees/task-0badc0de · worktree-task-0badc0de'
      );
      expect((await page.locator('#tasksView').textContent()) ?? '').not.toContain(casePath);
      writeFileSync(join(casePath, '.claude', 'worktrees', 'task-0badc0de', 'work.txt'), 'kept\n');
      await row.locator('[data-task-control$=":remove"]').click();
      await row.locator('[data-task-control$=":confirm"]').click();
      await page.waitForFunction(() => (document.getElementById('tasksStatus')!.textContent ?? '').includes('kept'));
      expect(await page.locator('#tasksStatus').textContent()).toBe(
        'The worktree .claude/worktrees/task-0badc0de has changes, so it was kept.'
      );
      execFileSync('rm', [join(casePath, '.claude', 'worktrees', 'task-0badc0de', 'work.txt')]);
      await row.locator('[data-task-control$=":remove"]').click();
      await row.locator('[data-task-control$=":confirm"]').click();
      await row.waitFor({ state: 'detached' });
      expect(await page.locator('#tasksStatus').textContent()).toBe('Worktree removed.');
      expect(existsSync(join(casePath, '.claude', 'worktrees', 'task-0badc0de'))).toBe(false);
      await closeRail();
    });
  });
});
