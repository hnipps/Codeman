/**
 * Background tasks (PC12) through the real routes: creation order and its undo, dedupe, the cap, cancel and remove.
 * Worktrees are made and removed by real git in a temporary repository; sessions are the test port's stand-ins, so no
 * agent runs here.
 */
import Fastify from 'fastify';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCanvasRoutes } from '../src/web/routes/canvas-routes.js';
import {
  conversationTurnEnded,
  forgetReplyPasses,
  forgetTaskResults,
  replyRouting,
  settleDeliveries,
  settleReplies,
} from '../src/web/routes/canvas-conversation-routes.js';
import { taskHooks } from '../src/web/routes/canvas-task-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';
import { CanvasStores } from '../src/canvas/canvas-store.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { conversationsPath, readConversations } from '../src/canvas/conversations.js';
import { CONTEXT_NOTICE } from '../src/canvas/conversation-schema.js';
import { MAX_ACTIVE_TASKS, taskPart, type TaskRow } from '../src/canvas/tasks.js';
import { approvalInbox } from '../src/web/approval-inbox.js';
import { deployRole } from '../src/deploy-role.js';
import { safeRmHomeTree } from './mocks/test-helpers.js';
import { create, human } from './canvas-fixtures.js';

let dir: string;
const cases: string[] = [];
const originalName = taskHooks.worktreeName;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const uuid = () => crypto.randomUUID();
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-task-'));
  vi.stubEnv('CODEMAN_DATA_DIR', dir);
  Object.assign(replyRouting, { settleDelayMs: 2, retryDelaysMs: [], maxAgeMs: 24 * 60 * 60 * 1000 });
  forgetReplyPasses();
  forgetTaskResults();
});
afterEach(() => {
  deployRole.enter('live');
  taskHooks.worktreeName = originalName;
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
  for (const path of cases.splice(0)) safeRmHomeTree(path);
});

type Row = { role: string; text: string };
const prompt = (id: string, text: string): Row => ({
  role: 'user',
  text: `<canvas-context workspace="w" seq="1" message="${id}">\n[note1 rev=1 type=text path=""] note1\n</canvas-context>\n${CONTEXT_NOTICE}\n${text}`,
});
const said = (text: string): Row => ({ role: 'assistant', text });

async function harness(options: { repo?: boolean } = {}) {
  const caseName = `task-case-${uuid().slice(0, 8)}`;
  const casePath = join(resolveCasesDir(), caseName);
  mkdirSync(casePath, { recursive: true });
  cases.push(casePath);
  if (options.repo !== false) {
    git(casePath, 'init', '-q', '-b', 'main');
    writeFileSync(join(casePath, 'README.md'), 'hello\n');
    git(casePath, 'add', 'README.md');
    git(casePath, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'first');
  }
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    req.authUser = { username: 'admin', role: 'admin' };
  });
  const sessions = new Map<string, Record<string, unknown>>();
  const transcripts = new Map<string, Row[]>();
  const stops = new Map<string, number>();
  const stores = new CanvasStores();
  let counter = 0;
  const port = {
    sessions,
    canvasEnabled: async () => true,
    canvasStores: async () => stores,
    broadcast: vi.fn(),
    transcriptRows: vi.fn(async (sessionId: string) => transcripts.get(sessionId) ?? null),
    transcriptStamp: vi.fn(async () => null),
    turnEndObservedAt: (sessionId: string) => stops.get(sessionId) ?? 0,
    startConversationSession: vi.fn(
      async (
        _headers: unknown,
        request: { workingDir: string; name: string }
      ): Promise<{ ok: true; sessionId: string } | { ok: false; message: string }> => {
        const id = `session-${++counter}`;
        sessions.set(id, {
          id,
          workingDir: request.workingDir,
          name: request.name,
          writeViaMux: vi.fn(async () => true),
        });
        return { ok: true, sessionId: id };
      }
    ),
    discardConversationSession: vi.fn(async (_headers: unknown, sessionId: string) => {
      sessions.delete(sessionId);
    }),
  };
  registerCanvasRoutes(app, port as never);
  installRouteErrorHandler(app);
  await app.ready();
  const workspace = workspaceForCase(caseName);
  const base = `/api/canvas/${workspace.id}`;
  const store = stores.get(workspace.id);
  store.append([create('note1'), create('note2')], human);
  const run = async (payload: Record<string, unknown> = {}) => {
    const response = await app.inject({
      method: 'POST',
      url: `${base}/tasks`,
      payload: { requestId: uuid(), text: 'Tidy the README', ...payload },
    });
    await settleDeliveries();
    await settleReplies();
    return response;
  };
  const list = async () => {
    const response = await app.inject({ method: 'GET', url: `${base}/tasks` });
    await settleReplies();
    return response.json().data as { tasks: TaskRow[]; active: number; cap: number };
  };
  const stop = async (sessionId: string) => {
    await pause(2);
    stops.set(sessionId, Date.now());
    await conversationTurnEnded(port as never, sessionId);
    await settleReplies();
  };
  const file = () => {
    const read = readConversations(workspace.id);
    if (!read.ok) throw new Error('unreadable');
    return read.conversations;
  };
  const worktrees = () => {
    const root = join(casePath, '.claude', 'worktrees');
    return existsSync(root) ? readdirSync(root) : [];
  };
  const branches = () =>
    git(casePath, 'branch', '--format=%(refname:short)')
      .split('\n')
      .filter((b) => b && b !== 'main');
  const cancel = (id: string) => app.inject({ method: 'POST', url: `${base}/tasks/${id}/cancel`, payload: {} });
  const remove = (id: string) => app.inject({ method: 'DELETE', url: `${base}/tasks/${id}` });
  /** The task's own request as its session's transcript would hold it, with the agent's reply. */
  const answer = (task: TaskRow, ...replies: string[]) => {
    const messageId = taskPart(file().find((c) => c.id === task.id)!)!.messageId;
    transcripts.set(task.sessionId, [prompt(messageId, 'Tidy the README'), ...replies.map(said)]);
  };
  return {
    app,
    port,
    sessions,
    transcripts,
    workspace,
    base,
    store,
    casePath,
    run,
    list,
    stop,
    file,
    worktrees,
    branches,
    cancel,
    remove,
    answer,
  };
}

describe('starting a task', () => {
  it('makes a worktree of the case, starts one session in it, records the task and sends the request once', async () => {
    const h = await harness();
    try {
      const response = await h.run({ refIds: ['note1'] });
      expect(response.statusCode).toBe(200);
      const { task, duplicate } = response.json().data as { task: TaskRow; duplicate: boolean };
      expect(duplicate).toBe(false);
      expect(task).toMatchObject({
        name: 'Tidy the README',
        cliId: 'claude',
        refs: [{ id: 'note1', label: 'note1' }],
      });
      expect(task.isolation.kind).toBe('worktree');
      expect((await h.list()).tasks[0].state).toBe('running');
      const [name] = h.worktrees();
      expect(name).toMatch(/^task-[0-9a-f]{8}$/);
      expect(task.isolation).toEqual({
        kind: 'worktree',
        label: `.claude/worktrees/${name}`,
        branch: `worktree-${name}`,
      });
      expect(h.branches()).toEqual([`worktree-${name}`]);
      const session = h.sessions.get(task.sessionId)!;
      expect(session.workingDir).toBe(join(h.casePath, '.claude', 'worktrees', name));
      expect(session.name).toBe('Task · Tidy the README');
      expect(h.port.startConversationSession).toHaveBeenCalledTimes(1);
      const writes = (session.writeViaMux as ReturnType<typeof vi.fn>).mock.calls;
      expect(writes).toHaveLength(1);
      expect(writes[0][0]).toMatch(/Tidy the README\r$/);
      expect(writes[0][1]).toEqual({ fromUser: true });
      const [conversation] = h.file();
      expect(taskPart(conversation)).toMatchObject({ name: 'Tidy the README', isolation: { kind: 'worktree', name } });
      expect(conversation.messages).toHaveLength(1);
      // No answer names a place outside the case folder.
      expect(JSON.stringify(response.json())).not.toContain(h.casePath);
      expect(JSON.stringify(await h.list())).not.toContain(h.casePath);
    } finally {
      await h.app.close();
    }
  });

  it('a retry with the same request id returns the same task and starts nothing more', async () => {
    const h = await harness();
    try {
      const requestId = uuid();
      const first = (await h.run({ requestId })).json().data as { task: TaskRow };
      const again = await h.run({ requestId });
      expect(again.statusCode).toBe(200);
      expect(again.json().data).toMatchObject({ duplicate: true, task: { id: first.task.id } });
      expect(h.port.startConversationSession).toHaveBeenCalledTimes(1);
      expect(h.worktrees()).toHaveLength(1);
      expect(h.file()).toHaveLength(1);
      expect(h.sessions.get(first.task.sessionId)!.writeViaMux).toHaveBeenCalledTimes(1);
      // Two at once are one too.
      const both = uuid();
      const [a, b] = await Promise.all([h.run({ requestId: both }), h.run({ requestId: both })]);
      expect([a.json().data.duplicate, b.json().data.duplicate].sort()).toEqual([false, true]);
      expect(h.file()).toHaveLength(2);
      expect(h.worktrees()).toHaveLength(2);
    } finally {
      await h.app.close();
    }
  });

  it('refuses a request id reused for another request, or for a conversation', async () => {
    const h = await harness();
    try {
      const requestId = uuid();
      await h.run({ requestId });
      const changed = await h.run({ requestId, text: 'Something else' });
      expect(changed.statusCode).toBe(409);
      expect(changed.json().error).toMatch(/^TASK_CHANGED:/);
      const context = await h.run({ requestId, refIds: ['note2'] });
      expect(context.json().error).toMatch(/^TASK_CHANGED:/);
      const conversationRequest = uuid();
      await h.app.inject({
        method: 'POST',
        url: `${h.base}/conversations`,
        payload: { requestId: conversationRequest },
      });
      const reused = await h.run({ requestId: conversationRequest });
      expect(reused.statusCode).toBe(409);
      expect(reused.json().error).toMatch(/^REQUEST_REUSED:/);
      expect(h.worktrees()).toHaveLength(1);
    } finally {
      await h.app.close();
    }
  });

  it('refuses an agent caller, an empty request and anything the body does not declare', async () => {
    const h = await harness();
    try {
      // An agent's own session is how the routes know an agent is asking.
      h.sessions.set('agent-1', { id: 'agent-1', workingDir: h.casePath });
      const asAgent = await h.app.inject({
        method: 'POST',
        url: `${h.base}/tasks`,
        headers: { 'x-codeman-parent-session': 'agent-1' },
        payload: { requestId: uuid(), text: 'Do it for me' },
      });
      expect(asAgent.statusCode).toBe(403);
      expect(asAgent.json().error).toContain('only a person');
      const { task } = (await h.run()).json().data as { task: TaskRow };
      for (const [method, url] of [
        ['POST', `${h.base}/tasks/${task.id}/cancel`],
        ['DELETE', `${h.base}/tasks/${task.id}`],
      ] as const) {
        const refused = await h.app.inject({
          method,
          url,
          headers: { 'x-codeman-parent-session': 'agent-1' },
          ...(method === 'POST' ? { payload: {} } : {}),
        });
        expect(refused.statusCode).toBe(403);
      }
      const message = await h.app.inject({
        method: 'POST',
        url: `${h.base}/conversations/${task.id}/messages`,
        headers: { 'x-codeman-parent-session': 'agent-1' },
        payload: { messageId: uuid(), text: 'Do something else' },
      });
      expect(message.statusCode).toBe(403);
      // The same agent may list them.
      const listed = await h.app.inject({
        method: 'GET',
        url: `${h.base}/tasks`,
        headers: { 'x-codeman-parent-session': 'agent-1' },
      });
      expect(listed.json().data.tasks).toHaveLength(1);
      expect((await h.run({ text: '   ' })).statusCode).toBe(400);
      expect((await h.run({ workingDir: '/tmp' })).statusCode).toBe(400);
      expect((await h.run({ shared: false })).statusCode).toBe(400);
      expect(h.port.startConversationSession).toHaveBeenCalledTimes(1);
      expect(h.worktrees()).toHaveLength(1);
    } finally {
      await h.app.close();
    }
  });

  it('refuses beyond the cap of tasks running at once, and frees a place when one finishes', async () => {
    const h = await harness();
    try {
      const made: TaskRow[] = [];
      for (let i = 0; i < MAX_ACTIVE_TASKS; i++) made.push(((await h.run()).json().data as { task: TaskRow }).task);
      const over = await h.run();
      expect(over.statusCode).toBe(409);
      expect(over.json().error).toMatch(/^TOO_MANY_TASKS:/);
      expect(h.worktrees()).toHaveLength(MAX_ACTIVE_TASKS);
      expect(h.port.startConversationSession).toHaveBeenCalledTimes(MAX_ACTIVE_TASKS);
      expect(await h.list()).toMatchObject({ active: MAX_ACTIVE_TASKS, cap: MAX_ACTIVE_TASKS });
      expect((await h.cancel(made[0].id)).statusCode).toBe(200);
      expect((await h.run()).statusCode).toBe(200);
    } finally {
      await h.app.close();
    }
  });

  it('in a folder that is not a git repository, refuses until the person agrees to share the case folder', async () => {
    const h = await harness({ repo: false });
    try {
      const requestId = uuid();
      const refused = await h.run({ requestId });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toMatch(/^NOT_A_REPOSITORY:/);
      expect(h.port.startConversationSession).not.toHaveBeenCalled();
      expect(h.file()).toHaveLength(0);
      const shared = await h.run({ requestId, shared: true });
      expect(shared.statusCode).toBe(200);
      const { task } = shared.json().data as { task: TaskRow };
      expect(task.isolation).toEqual({ kind: 'shared', label: 'Case folder, shared' });
      expect(h.sessions.get(task.sessionId)!.workingDir).toBe(h.casePath);
      expect(h.worktrees()).toHaveLength(0);
    } finally {
      await h.app.close();
    }
  });

  it('in a git case, sharing is never used: the task still gets its own worktree', async () => {
    const h = await harness();
    try {
      const { task } = (await h.run({ shared: true })).json().data as { task: TaskRow };
      expect(task.isolation.kind).toBe('worktree');
      expect(h.sessions.get(task.sessionId)!.workingDir).not.toBe(h.casePath);
    } finally {
      await h.app.close();
    }
  });

  it('refuses a Docker or remote case before anything is made', async () => {
    const h = await harness();
    try {
      writeFileSync(
        join(dir, 'remote-cases.json'),
        JSON.stringify([{ name: h.workspace.caseName, hostId: 'h', remotePath: '/srv/x' }])
      );
      const refused = await h.run();
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toMatch(/^CASE_UNSUPPORTED:/);
      expect(h.worktrees()).toHaveLength(0);
      expect(h.port.startConversationSession).not.toHaveBeenCalled();
    } finally {
      await h.app.close();
    }
  });
});

describe('a failure part-way leaves nothing behind', () => {
  const nothingLeft = (h: Awaited<ReturnType<typeof harness>>) => {
    expect(h.worktrees()).toEqual([]);
    expect(h.branches()).toEqual([]);
    expect(h.sessions.size).toBe(0);
    expect(h.file()).toEqual([]);
  };
  it('the worktree cannot be made', async () => {
    const h = await harness();
    try {
      git(h.casePath, 'branch', 'worktree-task-taken');
      taskHooks.worktreeName = () => 'task-taken';
      const response = await h.run();
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/^WORKTREE_FAILED:/);
      expect(response.json().error).not.toContain(h.casePath);
      expect(h.port.startConversationSession).not.toHaveBeenCalled();
      expect(h.worktrees()).toEqual([]);
      expect(h.file()).toEqual([]);
    } finally {
      await h.app.close();
    }
  });
  it('the session cannot be started', async () => {
    const h = await harness();
    try {
      h.port.startConversationSession.mockResolvedValueOnce({ ok: false, message: 'no room' });
      const response = await h.run();
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe('START_FAILED: no room');
      nothingLeft(h);
    } finally {
      await h.app.close();
    }
  });
  it('the task cannot be recorded', async () => {
    const h = await harness();
    try {
      const start = h.port.startConversationSession.getMockImplementation()!;
      h.port.startConversationSession.mockImplementationOnce(async (headers, request) => {
        const started = await start(headers, request);
        mkdirSync(join(dir, 'canvas', h.workspace.id), { recursive: true });
        writeFileSync(conversationsPath(h.workspace.id), '{ not json');
        return started;
      });
      const response = await h.run();
      expect(response.statusCode).toBe(409);
      expect(h.port.discardConversationSession).toHaveBeenCalledTimes(1);
      rmSync(conversationsPath(h.workspace.id));
      nothingLeft(h);
    } finally {
      await h.app.close();
    }
  });
  it('the request cannot be sent', async () => {
    const h = await harness();
    try {
      // A session the server does not hold cannot take the message.
      h.port.startConversationSession.mockResolvedValueOnce({ ok: true, sessionId: 'never-registered' });
      const response = await h.run();
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/^SESSION_ENDED:/);
      expect(h.port.discardConversationSession).toHaveBeenCalledWith(expect.anything(), 'never-registered');
      nothingLeft(h);
      // The same request id can then be tried again.
      expect((await h.run()).statusCode).toBe(200);
    } finally {
      await h.app.close();
    }
  });
  it('a request whose comment is gone is refused before anything is made', async () => {
    const h = await harness();
    try {
      const response = await h.run({ origin: { kind: 'thread', objectId: 'note1', commentId: 'missing' } });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/^ORIGIN_GONE:/);
      expect(h.port.startConversationSession).not.toHaveBeenCalled();
      nothingLeft(h);
    } finally {
      await h.app.close();
    }
  });
});

describe('state, result and thread reply', () => {
  it('goes from running to waiting for you to completed, with the result text bounded', async () => {
    const h = await harness();
    try {
      const { task } = (await h.run()).json().data as { task: TaskRow };
      expect((await h.list()).tasks[0].state).toBe('running');
      approvalInbox.notePrompt({ sessionId: task.sessionId, sessionName: 't', kind: 'permission' });
      expect((await h.list()).tasks[0].state).toBe('waiting');
      approvalInbox.resolveForSession(task.sessionId, 'answered');
      h.answer(task, 'Done. ' + 'x'.repeat(5000));
      // A transcript alone is not a turn end.
      expect((await h.list()).tasks[0].state).toBe('running');
      await h.stop(task.sessionId);
      const [row] = (await h.list()).tasks;
      expect(row.state).toBe('completed');
      expect(row.result?.truncated).toBe(true);
      expect(row.result?.text).toHaveLength(4000);
      expect(row.result?.text.startsWith('Done. ')).toBe(true);
      // The conversation list and read name the task too, which is how an agent reads it.
      const listed = (await h.app.inject({ method: 'GET', url: `${h.base}/conversations` })).json().data.conversations;
      expect(listed[0].task).toEqual({
        name: 'Tidy the README',
        state: 'completed',
        isolation: row.isolation.label,
      });
      const read = (await h.app.inject({ method: 'GET', url: `${h.base}/conversations/${task.id}` })).json().data;
      expect(read.conversation.task.result.text).toHaveLength(4000);
    } finally {
      approvalInbox.resolveForSession('session-1', 'answered');
      await h.app.close();
    }
  });

  it('does not complete while the session is still working, and fails when the agent exits first', async () => {
    const h = await harness();
    try {
      const { task } = (await h.run()).json().data as { task: TaskRow };
      h.answer(task, 'Half way');
      h.sessions.get(task.sessionId)!.isWorking = true;
      await h.stop(task.sessionId);
      expect((await h.list()).tasks[0].state).toBe('running');
      const second = ((await h.run()).json().data as { task: TaskRow }).task;
      h.sessions.get(second.sessionId)!.paneExit = { status: 1, at: Date.now() };
      const rows = (await h.list()).tasks;
      expect(rows.find((r) => r.id === second.id)!.state).toBe('failed');
      h.sessions.delete(second.sessionId);
      expect((await h.list()).tasks.find((r) => r.id === second.id)!.state).toBe('failed');
    } finally {
      await h.app.close();
    }
  });

  it('a task asked from a thread posts its reply there once and links back', async () => {
    const h = await harness();
    try {
      const commentId = uuid();
      await h.app.inject({
        method: 'POST',
        url: `${h.base}/command`,
        payload: {
          tool: 'canvas_comment',
          requestId: uuid(),
          arguments: { objectId: 'note1', text: 'Look', commentId },
        },
      });
      const origin = { kind: 'thread', objectId: 'note1', commentId };
      const { task } = (await h.run({ refIds: ['note1'], origin })).json().data as { task: TaskRow };
      expect(task.origin).toEqual({ objectId: 'note1', commentId });
      h.answer(task, 'Here is what I found.');
      await h.stop(task.sessionId);
      await h.stop(task.sessionId);
      await h.list();
      const replies = h.store.read().comments.filter((c) => c.objectId === 'note1' && c.author.kind === 'agent');
      expect(replies.map((c) => c.text)).toEqual(['Here is what I found.']);
      expect((await h.list()).tasks[0]).toMatchObject({
        state: 'completed',
        result: { text: 'Here is what I found.' },
      });
    } finally {
      await h.app.close();
    }
  });
});

describe('cancel', () => {
  it('interrupts only that task, records it once, and is refused for a finished task', async () => {
    const h = await harness();
    try {
      const a = ((await h.run()).json().data as { task: TaskRow }).task;
      const b = ((await h.run()).json().data as { task: TaskRow }).task;
      const first = await h.cancel(a.id);
      expect(first.statusCode).toBe(200);
      expect(first.json().data).toMatchObject({ duplicate: false, interrupted: true, task: { state: 'cancelled' } });
      const writeA = h.sessions.get(a.sessionId)!.writeViaMux as ReturnType<typeof vi.fn>;
      const writeB = h.sessions.get(b.sessionId)!.writeViaMux as ReturnType<typeof vi.fn>;
      expect(writeA.mock.calls.at(-1)).toEqual(['\u001b']);
      expect(writeB).toHaveBeenCalledTimes(1);
      const recorded = taskPart(h.file().find((c) => c.id === a.id)!)!.cancelledAt;
      const again = await h.cancel(a.id);
      expect(again.json().data).toMatchObject({ duplicate: true, task: { state: 'cancelled' } });
      expect(writeA).toHaveBeenCalledTimes(2);
      expect(taskPart(h.file().find((c) => c.id === a.id)!)!.cancelledAt).toBe(recorded);
      const rows = (await h.list()).tasks;
      expect(rows.find((r) => r.id === b.id)!.state).toBe('running');
      // Its session and worktree are kept for inspection.
      expect(h.sessions.has(a.sessionId)).toBe(true);
      expect(h.worktrees()).toHaveLength(2);
      h.answer(b, 'Finished');
      await h.stop(b.sessionId);
      const finished = await h.cancel(b.id);
      expect(finished.statusCode).toBe(409);
      expect(finished.json().error).toMatch(/^TASK_FINISHED:/);
      expect((await h.cancel(uuid())).statusCode).toBe(404);
    } finally {
      await h.app.close();
    }
  });

  it('a task cancelled while its request waits is never written to the pane', async () => {
    const h = await harness();
    try {
      // A pane that never shows a ready composer keeps the request waiting.
      h.port.startConversationSession.mockImplementationOnce(async (_headers, request) => {
        h.sessions.set('slow', {
          id: 'slow',
          workingDir: request.workingDir,
          writeViaMux: vi.fn(async () => true),
          paneSnapshot: () => 'starting',
          mode: 'claude',
        });
        return { ok: true, sessionId: 'slow' };
      });
      const response = await h.app.inject({
        method: 'POST',
        url: `${h.base}/tasks`,
        payload: { requestId: uuid(), text: 'Wait for it' },
      });
      const { task } = response.json().data as { task: TaskRow };
      expect(task.state).toBe('queued');
      expect((await h.cancel(task.id)).json().data.task.state).toBe('cancelled');
      const write = h.sessions.get('slow')!.writeViaMux as ReturnType<typeof vi.fn>;
      expect(write.mock.calls).toEqual([['\u001b']]);
      // The waiting delivery gives up instead of pasting when a composer appears.
      await settleDeliveries();
      expect(write.mock.calls).toEqual([['\u001b']]);
      expect((await h.list()).tasks[0].state).toBe('cancelled');
    } finally {
      await h.app.close();
    }
  }, 20_000);
});

describe('remove', () => {
  it('is refused while the task runs', async () => {
    const h = await harness();
    try {
      const { task } = (await h.run()).json().data as { task: TaskRow };
      const refused = await h.remove(task.id);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toMatch(/^TASK_ACTIVE:/);
      expect(h.sessions.has(task.sessionId)).toBe(true);
      expect(h.worktrees()).toHaveLength(1);
    } finally {
      await h.app.close();
    }
  });

  it('deletes the session, the clean worktree, its unused branch and the record', async () => {
    const h = await harness();
    try {
      const { task } = (await h.run()).json().data as { task: TaskRow };
      await h.cancel(task.id);
      const removed = await h.remove(task.id);
      expect(removed.statusCode).toBe(200);
      expect(removed.json().data).toEqual({ removed: true });
      expect(h.sessions.has(task.sessionId)).toBe(false);
      expect(h.worktrees()).toEqual([]);
      expect(h.branches()).toEqual([]);
      expect(h.file()).toEqual([]);
      expect((await h.list()).tasks).toEqual([]);
      expect((await h.remove(task.id)).statusCode).toBe(404);
    } finally {
      await h.app.close();
    }
  });

  it('keeps a worktree with changes, says where it is inside the case, and removes it once it is clean', async () => {
    const h = await harness();
    try {
      const { task } = (await h.run()).json().data as { task: TaskRow };
      const [name] = h.worktrees();
      const tree = join(h.casePath, '.claude', 'worktrees', name);
      writeFileSync(join(tree, 'notes.txt'), 'work in progress\n');
      await h.cancel(task.id);
      const kept = await h.remove(task.id);
      expect(kept.statusCode).toBe(200);
      expect(kept.json().data).toMatchObject({
        removed: false,
        kept: { label: `.claude/worktrees/${name}`, reason: 'changes' },
        task: { state: 'cancelled', kept: { label: `.claude/worktrees/${name}`, reason: 'changes' } },
      });
      expect(JSON.stringify(kept.json())).not.toContain(h.casePath);
      expect(existsSync(join(tree, 'notes.txt'))).toBe(true);
      expect(h.sessions.has(task.sessionId)).toBe(false);
      expect((await h.list()).tasks[0].kept).toEqual({ label: `.claude/worktrees/${name}`, reason: 'changes' });
      rmSync(join(tree, 'notes.txt'));
      expect((await h.remove(task.id)).json().data).toEqual({ removed: true });
      expect(h.worktrees()).toEqual([]);
      expect(h.file()).toEqual([]);
    } finally {
      await h.app.close();
    }
  });

  it('keeps a branch that holds commits and says so', async () => {
    const h = await harness();
    try {
      const { task } = (await h.run()).json().data as { task: TaskRow };
      const [name] = h.worktrees();
      const tree = join(h.casePath, '.claude', 'worktrees', name);
      writeFileSync(join(tree, 'done.txt'), 'done\n');
      git(tree, 'add', 'done.txt');
      git(tree, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'work');
      await h.cancel(task.id);
      expect((await h.remove(task.id)).json().data).toEqual({ removed: true, branchKept: `worktree-${name}` });
      expect(h.worktrees()).toEqual([]);
      expect(h.branches()).toEqual([`worktree-${name}`]);
    } finally {
      await h.app.close();
    }
  });

  it('removes a shared task without touching the case folder', async () => {
    const h = await harness({ repo: false });
    try {
      const { task } = (await h.run({ shared: true })).json().data as { task: TaskRow };
      writeFileSync(join(h.casePath, 'kept.txt'), 'mine\n');
      await h.cancel(task.id);
      expect((await h.remove(task.id)).json().data).toEqual({ removed: true });
      expect(existsSync(join(h.casePath, 'kept.txt'))).toBe(true);
    } finally {
      await h.app.close();
    }
  });
});
