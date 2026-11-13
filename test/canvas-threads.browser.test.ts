/**
 * Ask agent from a comment thread (PC10): Post stays an ordinary comment, Ask agent posts the comment and sends it to
 * a chosen conversation through the rail's own routes, the reply comes back into the asking thread, and the thread and
 * the rail link to each other.
 */
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import puppeteer from 'puppeteer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { WebServer } from '../src/web/server.js';
import { dataPath } from '../src/config/instance.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';
import { CanvasStores } from '../src/canvas/canvas-store.js';
import { CommandSchema } from '../src/canvas/operations.js';
import { CONTEXT_NOTICE } from '../src/canvas/conversation-schema.js';

const installed = vi.hoisted(() => ({ map: { claude: true, copilot: true } as Record<string, boolean> }));
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
type Post = { path: string; body: Record<string, unknown> };
type Listed = {
  id: string;
  sessionId: string;
  origin?: unknown;
  requests?: { messageId: string; commentId: string; objectId: string; state: string; reply?: unknown }[];
};

describe('canvas thread requests', () => {
  let server: WebServer, browser: Browser, desktop: BrowserContext, page: Page, origin: string, workspace: string;
  const posts: Post[] = [];
  const shot = (name: string) =>
    page.screenshot({ animations: 'disabled', path: resolve(MEDIA, `pc10-${stamp}-${name}.png`) });
  const api = (path: string) => `${origin}/x/api${path}`;
  const view = () => page.evaluate(() => window.canvasView.read());
  const conversations = async () =>
    (await (await page.request.get(api(`/canvas/${workspace}/conversations`))).json()).data.conversations as Listed[];
  const comments = (objectId: string) =>
    page.evaluate((id) => window.canvasComments.read().filter((c) => c.objectId === id), objectId);
  async function closeRail() {
    for (let i = 0; i < 3 && (await page.locator('#rail').isVisible()); i++) await page.keyboard.press('Escape');
    await page.waitForSelector('#rail', { state: 'hidden' });
  }
  async function openThread(id: string, name: string) {
    await closeRail();
    await page.evaluate((target) => {
      window.canvasView.dispatch({ kind: 'focus', id: target });
      window.canvasView.dispatch({ kind: 'selection', ids: [target] });
    }, id);
    await page.locator('#chatTool').click();
    await page.waitForSelector('#threadView:not([hidden])');
    await page.waitForFunction((n) => document.getElementById('threadTarget')?.textContent?.includes(n), name);
  }
  const requestLines = () =>
    page
      .locator('#threadList .comment')
      .evaluateAll((items) =>
        items.map((li) => [
          li.querySelector('.comment-text')?.textContent ?? '',
          li.querySelector('.request-state')?.textContent ?? null,
        ])
      );
  /** The session's transcript as Claude Code writes it: each asked prompt followed by its replies. */
  function transcript(sessionId: string, turns: { messageId?: string; prompt: string; replies: string[] }[]) {
    const dir = join(process.env.HOME!, '.claude', 'projects', 'fixture');
    mkdirSync(dir, { recursive: true });
    const lines = turns.flatMap((turn, index) => [
      {
        type: 'user',
        timestamp: `2026-11-12T10:0${index}:00Z`,
        message: {
          role: 'user',
          content: turn.messageId
            ? `<canvas-context workspace="${workspace}" seq="2" message="${turn.messageId}">\n[n1 rev=1 type=text path=""] x\n</canvas-context>\n${CONTEXT_NOTICE}\n${turn.prompt}`
            : turn.prompt,
        },
      },
      ...turn.replies.map((text) => ({
        type: 'assistant',
        timestamp: `2026-11-12T10:0${index}:30Z`,
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      })),
    ]);
    writeFileSync(join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  const hook = (event: string, sessionId: string) =>
    page.request.post(api('/hook-event'), { data: { event, sessionId, data: { session_id: sessionId } } });

  beforeAll(async () => {
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-pc10-threads');
    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasEnabled: true }));
    mkdirSync(resolve(resolveCasesDir(), 'Threadnotes'), { recursive: true });
    workspace = workspaceForCase('Threadnotes').id;
    const stores = new CanvasStores();
    expect(
      stores
        .get(workspace)
        .append(
          [note('n1', 0, 'Reading patterns'), note('n2', 220, 'Reference notes'), note('n3', 440, 'Open questions')],
          { kind: 'human', userId: 'a' }
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
    desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await desktop.addInitScript(() => {
      if (!localStorage.getItem('codeman:skin')) localStorage.setItem('codeman:skin', 'og');
    });
    page = await desktop.newPage();
    page.on('request', (r) => {
      const path = /\/api\/canvas\/[^/]+(\/(?:command|conversations)[^?]*)/.exec(r.url())?.[1];
      if (r.method() === 'POST' && path)
        posts.push({ path: path.replace(/[0-9a-f-]{36}/, ':id'), body: JSON.parse(r.postData() ?? '{}') });
    });
    mkdirSync(MEDIA, { recursive: true });
    await page.goto(`${origin}/x/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-object-id="n1"]');
    await page.waitForFunction(() => !!window.canvasView);
    await page.waitForFunction(() => document.querySelectorAll('#providerSelect option[value="claude"]').length === 1);
  }, 60000);
  afterEach(() => {
    posts.length = 0;
  });
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    vi.unstubAllEnvs();
  }, 60000);

  it('Post and Cmd/Ctrl+Enter store an ordinary comment and start no agent work', async () => {
    await openThread('n2', 'Reference notes');
    expect(await page.locator('#askAgent').isVisible()).toBe(true);
    expect(await page.locator('#askTarget').evaluate((el) => (el as HTMLSelectElement).selectedOptions[0].text)).toBe(
      'New conversation · Claude Code'
    );
    await page.locator('#commentDraft').fill('@agent a plain note');
    await page.locator('#postComment').click();
    await page.waitForFunction(() => document.querySelectorAll('#threadList .comment').length === 1);
    await page.locator('#commentDraft').fill('a second plain note');
    await page.locator('#commentDraft').press('Control+Enter');
    await page.waitForFunction(() => document.querySelectorAll('#threadList .comment').length === 2);
    expect(posts.map((p) => p.path)).toEqual(['/command', '/command']);
    expect(await conversations()).toEqual([]);
    expect(await page.locator('#threadList .comment-request').count()).toBe(0);
  });

  it('Ask agent posts the comment, starts a conversation from the thread and sends it with the object and the origin', async () => {
    await openThread('n1', 'Reading patterns');
    const before = await view();
    await page.locator('#commentDraft').fill('What is this note for?');
    await shot('composer');
    await page.locator('#askAgent').click();
    await page.waitForFunction(() => (document.getElementById('commentDraft') as HTMLTextAreaElement).value === '');
    expect(posts.map((p) => p.path)).toEqual(['/command', '/conversations', '/conversations/:id/messages']);
    const [comment, create, send] = posts.map((p) => p.body);
    const commentId = (comment.arguments as { commentId: string }).commentId;
    expect(comment).toMatchObject({
      tool: 'canvas_comment',
      arguments: { objectId: 'n1', text: 'What is this note for?' },
    });
    const threadOrigin = { kind: 'thread', objectId: 'n1', commentId };
    expect(create).toMatchObject({ cliId: 'claude', origin: threadOrigin });
    expect(send).toMatchObject({ text: 'What is this note for?', refIds: ['n1'], origin: threadOrigin });
    await page.waitForSelector('#threadList .comment-request');
    const [conversation] = await conversations();
    expect(conversation.origin).toEqual(threadOrigin);
    expect(conversation.requests).toEqual([
      { messageId: send.messageId, objectId: 'n1', commentId, state: 'delivered' },
    ]);
    expect(await requestLines()).toEqual([['What is this note for?', expect.stringMatching(/^Asked an agent · /)]]);
    expect(await page.locator('#threadList .request-open').textContent()).toBe('Open conversation');
    const after = await view();
    expect(after.viewport).toEqual(before.viewport);
    expect(after.selected).toEqual(before.selected);
    expect(await page.locator('dialog[open], [role="dialog"]').count()).toBe(0);
    await shot('asked');
  });

  it('shows Working while the turn runs and posts the reply into the asking thread when it ends, once', async () => {
    const [conversation] = await conversations();
    const request = conversation.requests![0];
    await hook('prompt_submitted', conversation.sessionId);
    await page.waitForFunction(() => document.querySelector('.request-state')?.textContent?.endsWith('Working'));
    transcript(conversation.sessionId, [
      {
        messageId: request.messageId,
        prompt: 'What is this note for?',
        replies: ['It collects reading patterns.', 'Keep it short.'],
      },
    ]);
    const before = await view();
    await page.locator('#commentDraft').fill('still typing');
    await hook('stop', conversation.sessionId);
    await page.waitForFunction(() => document.querySelectorAll('#threadList .comment').length === 2);
    await page.waitForFunction(() => document.querySelector('.request-state')?.textContent?.endsWith('Replied'));
    const thread = await comments('n1');
    expect(thread.map((c) => [c.author.kind, c.text])).toEqual([
      ['human', 'What is this note for?'],
      ['agent', 'It collects reading patterns.\n\nKeep it short.'],
    ]);
    expect(thread[1].author).toEqual({ kind: 'agent', sessionId: conversation.sessionId });
    expect(await page.locator('#threadList .comment').nth(1).locator('.agent-mark').count()).toBe(1);
    await hook('stop', conversation.sessionId);
    await hook('stop', conversation.sessionId);
    await page.waitForTimeout(600);
    expect(await comments('n1')).toHaveLength(2);
    expect(await comments('n2')).toHaveLength(2);
    const after = await view();
    expect(after.viewport).toEqual(before.viewport);
    expect(after.selected).toEqual(before.selected);
    expect(await page.locator('#commentDraft').inputValue()).toBe('still typing');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('commentDraft');
    await page.locator('#commentDraft').fill('');
    await shot('replied');
  });

  it('a reply is routed by the recorded origin, not by the thread that is open', async () => {
    await openThread('n1', 'Reading patterns');
    await page.locator('#commentDraft').fill('And who reads it?');
    await page.locator('#askAgent').click();
    await page.waitForFunction(() => document.querySelectorAll('#threadList .comment-request').length === 2);
    expect(posts.map((p) => p.path)).toEqual(['/command', '/conversations/:id/messages']);
    const [conversation] = await conversations();
    expect(await conversations()).toHaveLength(1);
    const [first, second] = conversation.requests!;
    await openThread('n3', 'Open questions');
    transcript(conversation.sessionId, [
      {
        messageId: first.messageId,
        prompt: 'What is this note for?',
        replies: ['It collects reading patterns.', 'Keep it short.'],
      },
      { messageId: second.messageId, prompt: 'And who reads it?', replies: ['The whole team.'] },
    ]);
    await hook('stop', conversation.sessionId);
    await page.waitForFunction(() => window.canvasComments.read().some((c) => c.text === 'The whole team.'));
    expect((await comments('n1')).map((c) => c.text)).toEqual([
      'What is this note for?',
      'It collects reading patterns.\n\nKeep it short.',
      'And who reads it?',
      'The whole team.',
    ]);
    expect(await comments('n3')).toEqual([]);
    expect((await view()).focusId).toBe('n3');
  });

  it('Open conversation shows that same session in the rail without moving the camera or selection, with a backlink', async () => {
    await openThread('n1', 'Reading patterns');
    const [conversation] = await conversations();
    const before = await view();
    await page.locator('#threadList .request-open').first().click();
    await page.waitForSelector('#assistantView:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('#thread .turn-origin').length === 2);
    const after = await view();
    expect(after.conversationId).toBe(conversation.id);
    expect(after.viewport).toEqual(before.viewport);
    expect(after.selected).toEqual(before.selected);
    expect(after.focusId).toBe(before.focusId);
    const turns = await page.locator('#thread .turn').evaluateAll((els) => els.map((e) => e.textContent ?? ''));
    expect(turns).toHaveLength(5);
    expect(turns[0]).toContain('What is this note for?');
    expect(turns[0]).toContain('From a comment on Reading patterns');
    expect(turns[0]).not.toContain('canvas-context');
    expect(turns[1]).toContain('It collects reading patterns.');
    await shot('rail-backlink');
    await page.evaluate(() => {
      window.canvasView.dispatch({ kind: 'focus', id: 'n2' });
      window.canvasView.dispatch({ kind: 'selection', ids: ['n2'] });
    });
    await page.locator('#thread .turn-origin').first().click();
    await page.waitForSelector('#threadView:not([hidden])');
    await page.waitForFunction(() =>
      document.getElementById('threadTarget')?.textContent?.includes('Reading patterns')
    );
    expect((await view()).selected).toEqual(['n1']);
    expect((await view()).focusId).toBe('n1');
  });

  it('offers the conversations of this canvas in line, and says in line why a new one cannot start', async () => {
    await openThread('n3', 'Open questions');
    const options = () =>
      page
        .locator('#askTarget option')
        .evaluateAll((els) => els.map((e) => [(e as HTMLOptionElement).value !== '', e.textContent]));
    expect(await options()).toEqual([
      [true, 'Conversation 1'],
      [false, 'New conversation · Claude Code'],
    ]);
    expect(await page.locator('#askTarget').evaluate((el) => (el as HTMLSelectElement).selectedOptions[0].text)).toBe(
      'Conversation 1'
    );
    await page.evaluate(() =>
      window.canvasView.dispatch({ kind: 'assistant-choice', choice: { cliId: 'copilot', model: '' } })
    );
    await page.locator('#askTarget').selectOption('');
    await page.waitForSelector('#askNote:not([hidden])');
    expect(await page.locator('#askNote').textContent()).toContain('Pick a conversation');
    await page.locator('#commentDraft').fill('Can this start?');
    await page.locator('#askAgent').click();
    await page.waitForFunction(() => document.getElementById('commentStatus')?.textContent?.startsWith('Not asked'));
    expect(posts).toEqual([]);
    expect(await comments('n3')).toEqual([]);
    expect(await page.locator('#commentDraft').inputValue()).toBe('Can this start?');
    expect(await page.locator('dialog[open], [role="dialog"]').count()).toBe(0);
    await shot('unavailable');
    await page.evaluate(() => window.canvasView.dispatch({ kind: 'assistant-choice', choice: null }));
    await page.locator('#commentDraft').fill('');
  });

  it('an ask cut off by a reload comes back with its draft and finishes under the same ids', async () => {
    await openThread('n2', 'Reference notes');
    await page.locator('#askTarget').selectOption({ label: 'Conversation 1' });
    // The comment lands; the message never reaches the server.
    await page.route('**/conversations/*/messages', (route) => route.abort());
    await page.locator('#commentDraft').fill('Does this hold?');
    await page.locator('#askAgent').click();
    await page.waitForSelector('#retryComment:not([hidden])');
    expect(await page.locator('#commentStatus').textContent()).toContain('Your comment is posted');
    const firstTry = posts.map((p) => p.body);
    expect(posts.map((p) => p.path)).toEqual(['/command', '/conversations/:id/messages']);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.canvasView && !!document.querySelector('[data-object-id="n2"]'));
    await page.unroute('**/conversations/*/messages');
    posts.length = 0;
    await openThread('n2', 'Reference notes');
    // Nothing here types the draft again: it comes back from the kept attempt.
    expect(await page.locator('#commentDraft').inputValue()).toBe('Does this hold?');
    await page.waitForSelector('#retryComment:not([hidden])');
    expect(await page.locator('#commentStatus').textContent()).toContain('nothing is posted twice');
    await page.waitForFunction(() => document.querySelectorAll('#askTarget option').length === 2);
    await page.locator('#askTarget').selectOption({ label: 'Conversation 1' });
    await page.locator('#retryComment').click();
    await page.waitForFunction(() => (document.getElementById('commentDraft') as HTMLTextAreaElement).value === '');
    expect(posts.map((p) => p.path)).toEqual(['/command', '/conversations/:id/messages']);
    expect(posts[0].body.requestId).toBe(firstTry[0].requestId);
    expect((posts[0].body.arguments as { commentId: string }).commentId).toBe(
      (firstTry[0].arguments as { commentId: string }).commentId
    );
    expect(posts[1].body.messageId).toBe(firstTry[1].messageId);
    expect((await comments('n2')).filter((c) => c.text === 'Does this hold?')).toHaveLength(1);
    const [conversation] = await conversations();
    expect(conversation.requests!.filter((r) => r.objectId === 'n2')).toHaveLength(1);
  });

  it('Post after a comment that was posted but not asked sends the same comment again, not a second one', async () => {
    await openThread('n2', 'Reference notes');
    await page.locator('#askTarget').selectOption({ label: 'Conversation 1' });
    await page.route('**/conversations/*/messages', (route) => route.abort());
    await page.locator('#commentDraft').fill('Only a note after all');
    await page.locator('#askAgent').click();
    await page.waitForSelector('#retryComment:not([hidden])');
    await page.unroute('**/conversations/*/messages');
    await page.locator('#commentDraft').press('Control+Enter');
    await page.waitForFunction(() => (document.getElementById('commentDraft') as HTMLTextAreaElement).value === '');
    const commands = posts.filter((p) => p.path === '/command').map((p) => p.body);
    expect(commands).toHaveLength(2);
    expect(commands[1].requestId).toBe(commands[0].requestId);
    expect(commands[1].arguments).toEqual(commands[0].arguments);
    expect((await comments('n2')).filter((c) => c.text === 'Only a note after all')).toHaveLength(1);
    expect(await page.locator('#retryComment').isVisible()).toBe(false);
    expect(
      await page.evaluate(() =>
        Object.keys(localStorage)
          .filter((k) => /threadAsk|thread-ask|ask/i.test(k))
          .map((k) => localStorage.getItem(k))
      )
    ).toEqual([]);
    const [conversation] = await conversations();
    expect(conversation.requests!.filter((r) => r.objectId === 'n2')).toHaveLength(1);
  });

  it('an ask whose answer was lost is finished already: nothing is posted or written twice, before or after a reload', async () => {
    await openThread('n3', 'Open questions');
    await page.locator('#askTarget').selectOption({ label: 'Conversation 1' });
    let dropped = 0;
    // The server takes the message; the page never hears back.
    await page.route('**/conversations/*/messages', async (route) => {
      if (dropped++ > 0) return route.continue();
      await route.fetch();
      return route.abort();
    });
    await page.locator('#commentDraft').fill('Is this still open?');
    await page.locator('#askAgent').click();
    await page.waitForSelector('#threadList .comment-request');
    await page.waitForFunction(() => (document.getElementById('commentDraft') as HTMLTextAreaElement).value === '');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.canvasView && !!document.querySelector('[data-object-id="n3"]'));
    await page.unroute('**/conversations/*/messages');
    posts.length = 0;
    await openThread('n3', 'Open questions');
    await page.waitForSelector('#threadList .comment-request');
    await page.waitForFunction(() => (document.getElementById('commentDraft') as HTMLTextAreaElement).value === '');
    expect(await page.locator('#retryComment').isVisible()).toBe(false);
    expect(posts.filter((p) => p.path === '/command' || p.path.endsWith('/messages'))).toEqual([]);
    expect((await comments('n3')).map((c) => c.text)).toEqual(['Is this still open?']);
    const [conversation] = await conversations();
    expect(conversation.requests!.filter((r) => r.objectId === 'n3')).toHaveLength(1);
    expect(await conversations()).toHaveLength(1);
  });

  it('a request for an object that was removed drops the reply and says so, without an error', async () => {
    const [conversation] = await conversations();
    const request = conversation.requests!.find((r) => r.objectId === 'n3')!;
    const removed = await page.request.post(api(`/canvas/${workspace}/command`), {
      data: { tool: 'canvas_delete', arguments: { operations: [{ kind: 'delete', opId: 'drop-n3', objectId: 'n3' }] } },
    });
    expect(removed.status()).toBe(200);
    const [first, second] = conversation.requests!;
    transcript(conversation.sessionId, [
      {
        messageId: first.messageId,
        prompt: 'What is this note for?',
        replies: ['It collects reading patterns.', 'Keep it short.'],
      },
      { messageId: second.messageId, prompt: 'And who reads it?', replies: ['The whole team.'] },
      { messageId: request.messageId, prompt: 'Is this still open?', replies: ['Yes, for now.'] },
    ]);
    expect((await hook('stop', conversation.sessionId)).status()).toBe(200);
    await expect
      .poll(async () => (await conversations())[0].requests!.find((r) => r.objectId === 'n3')?.reply, {
        timeout: 15_000,
      })
      .toEqual({ dropped: 'object-removed' });
    expect(await page.evaluate(() => window.canvasComments.read().some((c) => c.text === 'Yes, for now.'))).toBe(false);
  });

  it('a thread draft survives a reload, per object, and goes once it is posted', async () => {
    await openThread('n2', 'Reference notes');
    await page.locator('#commentDraft').fill('half a thought');
    await openThread('n1', 'Reading patterns');
    expect(await page.locator('#commentDraft').inputValue()).toBe('');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.canvasView && !!document.querySelector('[data-object-id="n2"]'));
    await openThread('n1', 'Reading patterns');
    expect(await page.locator('#commentDraft').inputValue()).toBe('');
    await openThread('n2', 'Reference notes');
    expect(await page.locator('#commentDraft').inputValue()).toBe('half a thought');
    expect(await page.locator('#retryComment').isVisible()).toBe(false);
    expect(await page.locator('#postComment').isVisible()).toBe(true);
    await page.locator('#commentDraft').press('Control+Enter');
    await page.waitForFunction(() => (document.getElementById('commentDraft') as HTMLTextAreaElement).value === '');
    expect((await comments('n2')).filter((c) => c.text === 'half a thought')).toHaveLength(1);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.canvasView && !!document.querySelector('[data-object-id="n2"]'));
    await openThread('n2', 'Reference notes');
    expect(await page.locator('#commentDraft').inputValue()).toBe('');
  });

  it('F1 opens Keys while typing in the thread composer, as it does from the assistant composer', async () => {
    await openThread('n1', 'Reading patterns');
    await page.locator('#commentDraft').focus();
    await page.keyboard.press('F1');
    await page.waitForSelector('#keysView:not([hidden])');
    await closeRail();
    await page.locator('#assistantTool').click();
    await page.locator('#assistantDraft').focus();
    await page.keyboard.press('F1');
    await page.waitForSelector('#keysView:not([hidden])');
    await closeRail();
  });

  it('says Reply removed, and posts nothing again, once the reply comment was reverted', async () => {
    const [conversation] = await conversations();
    await openThread('n1', 'Reading patterns');
    await page.waitForFunction(() => document.querySelector('.request-state')?.textContent?.endsWith('Replied'));
    const reverted = await page.request.post(api(`/canvas/${workspace}/revert`), {
      data: { author: { kind: 'agent', sessionId: conversation.sessionId }, requestId: crypto.randomUUID() },
    });
    expect(reverted.status()).toBe(200);
    await page.waitForFunction(() => document.querySelector('.request-state')?.textContent?.endsWith('Reply removed'));
    await hook('stop', conversation.sessionId);
    await page.waitForTimeout(2500);
    expect((await comments('n1')).filter((c) => c.author.kind === 'agent')).toEqual([]);
    expect(await page.locator('.request-state').first().textContent()).toBe('Asked an agent · Reply removed');
  });
});
