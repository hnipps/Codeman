/**
 * Background tasks (PC12) through the real routes: creation order and its undo, dedupe, the cap, cancel and remove.
 * Worktrees are made and removed by real git in a temporary repository; sessions are the test port's stand-ins, so no
 * agent runs here.
 */
import Fastify from 'fastify';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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
import { forgetLeftBehind, taskHooks, taskTiming } from '../src/web/routes/canvas-task-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';
import { CanvasStores } from '../src/canvas/canvas-store.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { conversationsPath, readConversations, setMessageState, setTaskHint } from '../src/canvas/conversations.js';
import { CONTEXT_NOTICE } from '../src/canvas/conversation-schema.js';
import { MAX_ACTIVE_TASKS, taskPart, type TaskRow } from '../src/canvas/tasks.js';
import { approvalInbox } from '../src/web/approval-inbox.js';
import { deployRole } from '../src/deploy-role.js';
import { safeRmHomeTree } from './mocks/test-helpers.js';
import { create, human } from './canvas-fixtures.js';

let dir: string;
const cases: string[] = [];
const originalName = taskHooks.worktreeName;
const homeLinkedCases = join(homedir(), '.codeman', 'linked-cases.json');
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
  Object.assign(replyRouting, { quietMs: 30_000 });
  Object.assign(taskTiming, { deliveryMs: 3_000, clearMs: 5, clearPresses: 3, leftBehindMs: 15_000 });
  forgetReplyPasses();
  forgetTaskResults();
  forgetLeftBehind();
});
afterEach(() => {
  deployRole.enter('live');
  taskHooks.worktreeName = originalName;
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
  rmSync(homeLinkedCases, { force: true });
  for (const path of cases.splice(0)) safeRmHomeTree(path);
});

type Row = { role: string; text: string };
const prompt = (id: string, text: string): Row => ({
  role: 'user',
  text: `<canvas-context workspace="w" seq="1" message="${id}">\n[note1 rev=1 type=text path=""] note1\n</canvas-context>\n${CONTEXT_NOTICE}\n${text}`,
});
const said = (text: string): Row => ({ role: 'assistant', text });

const rule = '─'.repeat(20);
/** A claude pane with a ready composer holding `composer`. */
const frame = (composer: string) =>
  `some output\n${rule}\n❯ ${composer}\n${rule}\n  ⏵⏵ accept edits on (shift+tab to cycle)`;
const commitFirst = (path: string) => {
  writeFileSync(join(path, 'README.md'), 'hello\n');
  git(path, 'add', 'README.md');
  git(path, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'first');
};

/**
 * `repo: 'empty'` is a repository with no commit. `linked` makes the case a linked one whose path is a symlink to a
 * repository elsewhere; `linkedTo` links the case to a folder the test prepared instead.
 */
async function harness(options: { repo?: boolean | 'empty'; linked?: boolean; linkedTo?: string } = {}) {
  const caseName = `task-case-${uuid().slice(0, 8)}`;
  let casePath = join(resolveCasesDir(), caseName);
  if (options.linked || options.linkedTo) {
    const real = options.linkedTo ?? join(dir, `real-${caseName}`);
    mkdirSync(real, { recursive: true });
    casePath = options.linkedTo ?? join(dir, `link-${caseName}`);
    if (!options.linkedTo) symlinkSync(real, casePath);
    // The case routes fixed their registry path when they were imported, before this test chose a data folder.
    for (const registry of [join(dir, 'linked-cases.json'), homeLinkedCases]) {
      mkdirSync(join(registry, '..'), { recursive: true });
      writeFileSync(registry, JSON.stringify({ [caseName]: casePath }));
    }
  } else {
    mkdirSync(casePath, { recursive: true });
    cases.push(casePath);
  }
  if (options.repo !== false && !options.linkedTo) {
    git(casePath, 'init', '-q', '-b', 'main');
    if (options.repo !== 'empty') commitFirst(casePath);
  }
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    req.authUser = { username: 'admin', role: 'admin' };
  });
  const sessions = new Map<string, Record<string, unknown>>();
  const transcripts = new Map<string, Row[]>();
  const stops = new Map<string, number>();
  const modified = new Map<string, number>();
  const stores = new CanvasStores();
  let counter = 0;
  const port = {
    sessions,
    canvasEnabled: async () => true,
    canvasStores: async () => stores,
    broadcast: vi.fn(),
    transcriptRows: vi.fn(async (sessionId: string) => transcripts.get(sessionId) ?? null),
    transcriptStamp: vi.fn(async () => null),
    transcriptModifiedAt: vi.fn(async (sessionId: string) => modified.get(sessionId) ?? null),
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
    modified,
    stops,
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

describe('fix round 1: cancel stops the request', () => {
  /** A pane whose composer takes the paste and ignores Enter; `clearsAfter` Escapes empty it (never, when Infinity). */
  const stubbornPane = (h: Awaited<ReturnType<typeof harness>>, clearsAfter: number) => {
    const writes: string[] = [];
    let pasted = false;
    let escapes = 0;
    const cancelPendingSubmit = vi.fn();
    h.port.startConversationSession.mockImplementationOnce(async (_headers, request) => {
      h.sessions.set('pane', {
        id: 'pane',
        mode: 'claude',
        workingDir: request.workingDir,
        cancelPendingSubmit,
        paneSnapshot: () => frame(pasted && escapes < clearsAfter ? '[Pasted text #1 +4 lines]' : ''),
        writeViaMux: vi.fn(async (data: string) => {
          writes.push(data);
          if (data === '\u001b') {
            if (pasted) escapes++;
          } else if (data !== '\r') pasted = true;
          return true;
        }),
      });
      return { ok: true, sessionId: 'pane' };
    });
    return { writes, cancelPendingSubmit, escapes: () => escapes };
  };
  const startAndPaste = async (h: Awaited<ReturnType<typeof harness>>, writes: string[]) => {
    const response = await h.app.inject({
      method: 'POST',
      url: `${h.base}/tasks`,
      payload: { requestId: uuid(), text: 'Never run this' },
    });
    const { task } = response.json().data as { task: TaskRow };
    for (let i = 0; i < 100 && !writes.length; i++) await pause(20);
    expect(writes).toHaveLength(1);
    return task;
  };

  it('no Enter follows a cancel, the pasted request is cleared from the composer, and the task takes no more messages', async () => {
    const h = await harness();
    try {
      const pane = stubbornPane(h, 2);
      const task = await startAndPaste(h, pane.writes);
      const cancelled = await h.cancel(task.id);
      expect(cancelled.json().data).toMatchObject({ interrupted: true, task: { state: 'cancelled' } });
      expect(cancelled.json().data.task.unsubmitted).toBeUndefined();
      expect(pane.cancelPendingSubmit).toHaveBeenCalled();
      // Past the delivery's first Enter (2 s after the paste) and its next poll.
      await pause(3_500);
      await settleDeliveries();
      expect(pane.writes.slice(1).every((w) => w === '\u001b')).toBe(true);
      expect(pane.writes).not.toContain('\r');
      // Escapes stop once the composer is seen empty: none goes to an empty composer.
      expect(pane.escapes()).toBe(2);
      const more = await h.app.inject({
        method: 'POST',
        url: `${h.base}/conversations/${task.id}/messages`,
        payload: { messageId: uuid(), text: 'And another thing' },
      });
      expect(more.statusCode).toBe(409);
      expect(more.json().error).toMatch(/^TASK_CANCELLED:/);
      expect(pane.writes).toHaveLength(3);
      expect((await h.list()).tasks[0].state).toBe('cancelled');
    } finally {
      await h.app.close();
    }
  }, 20_000);

  it('a request that will not leave the composer is said to be there, after a bounded number of Escapes', async () => {
    const h = await harness();
    try {
      const pane = stubbornPane(h, Infinity);
      const task = await startAndPaste(h, pane.writes);
      const cancelled = await h.cancel(task.id);
      expect(cancelled.json().data.task).toMatchObject({ state: 'cancelled', unsubmitted: true });
      // The interrupt, then at most `clearPresses` more.
      expect(pane.writes.slice(1)).toEqual(Array(1 + taskTiming.clearPresses).fill('\u001b'));
      await pause(3_500);
      await settleDeliveries();
      expect(pane.writes).not.toContain('\r');
      expect((await h.list()).tasks[0]).toMatchObject({ state: 'cancelled', unsubmitted: true });
    } finally {
      await h.app.close();
    }
  }, 20_000);
});

describe('fix round 1: an agent that exits, and what a restart leaves', () => {
  it('an agent that exits mid-turn with a failure is failed with the text it had written; a clean exit completes', async () => {
    const h = await harness();
    try {
      const crashed = ((await h.run()).json().data as { task: TaskRow }).task;
      h.answer(crashed, 'Half way there');
      h.sessions.get(crashed.sessionId)!.paneExit = { status: 1, at: Date.now() };
      await h.list();
      const row = (await h.list()).tasks.find((r) => r.id === crashed.id)!;
      expect(row.state).toBe('failed');
      expect(row.result).toEqual({ text: 'Half way there', truncated: false, partial: true });
      expect(row.retryable).toBeUndefined();
      // No exit status at all is not a clean exit either.
      const killed = ((await h.run()).json().data as { task: TaskRow }).task;
      h.answer(killed, 'Some of it');
      h.sessions.get(killed.sessionId)!.paneExit = { at: Date.now() };
      await h.list();
      expect((await h.list()).tasks.find((r) => r.id === killed.id)).toMatchObject({
        state: 'failed',
        result: { text: 'Some of it', partial: true },
      });
      const clean = ((await h.run()).json().data as { task: TaskRow }).task;
      h.answer(clean, 'All done');
      h.sessions.get(clean.sessionId)!.paneExit = { status: 0, at: Date.now() };
      await h.list();
      expect((await h.list()).tasks.find((r) => r.id === clean.id)).toMatchObject({
        state: 'completed',
        result: { text: 'All done', truncated: false },
      });
    } finally {
      await h.app.close();
    }
  });

  it('live evidence wins over a recorded turn end', async () => {
    const h = await harness();
    try {
      const { task } = (await h.run()).json().data as { task: TaskRow };
      h.answer(task, 'First answer');
      await h.stop(task.sessionId);
      expect((await h.list()).tasks[0].state).toBe('completed');
      h.sessions.get(task.sessionId)!.isWorking = true;
      expect((await h.list()).tasks[0].state).toBe('running');
      expect((await h.list()).tasks[0].result).toBeUndefined();
      h.sessions.get(task.sessionId)!.isWorking = false;
      approvalInbox.notePrompt({ sessionId: task.sessionId, sessionName: 't', kind: 'permission' });
      expect((await h.list()).tasks[0].state).toBe('waiting');
      approvalInbox.resolveForSession(task.sessionId, 'answered');
      expect((await h.list()).tasks[0].state).toBe('completed');
    } finally {
      approvalInbox.resolveForSession('session-1', 'answered');
      await h.app.close();
    }
  });

  it('a turn end nobody saw settles only from a quiet screen and a quiet transcript', async () => {
    const h = await harness();
    try {
      const { task } = (await h.run()).json().data as { task: TaskRow };
      const session = h.sessions.get(task.sessionId)!;
      h.answer(task, 'Finished while nobody watched');
      const settled = async () => {
        forgetReplyPasses();
        await h.list();
        return (await h.list()).tasks[0].state;
      };
      // No screen to read: nothing is inferred.
      h.modified.set(task.sessionId, Date.now() - 60_000);
      expect(await settled()).toBe('running');
      // The transcript was written a moment ago.
      session.paneShowsWork = () => false;
      h.modified.set(task.sessionId, Date.now() - 1_000);
      expect(await settled()).toBe('running');
      // The screen still shows work.
      h.modified.set(task.sessionId, Date.now() - 60_000);
      session.paneShowsWork = () => true;
      expect(await settled()).toBe('running');
      // A question is pending.
      session.paneShowsWork = () => false;
      approvalInbox.notePrompt({ sessionId: task.sessionId, sessionName: 't', kind: 'permission' });
      expect(await settled()).toBe('waiting');
      approvalInbox.resolveForSession(task.sessionId, 'answered');
      // The request never reached the transcript.
      const rows = h.transcripts.get(task.sessionId)!;
      h.transcripts.set(task.sessionId, []);
      expect(await settled()).toBe('running');
      h.transcripts.set(task.sessionId, rows);
      expect(await settled()).toBe('completed');
      expect((await h.list()).tasks[0].result?.text).toBe('Finished while nobody watched');
    } finally {
      approvalInbox.resolveForSession('session-1', 'answered');
      await h.app.close();
    }
  });

  it('an inferred turn end never posts into a thread', async () => {
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
      h.answer(task, 'An answer nobody saw end');
      h.sessions.get(task.sessionId)!.paneShowsWork = () => false;
      h.modified.set(task.sessionId, Date.now() - 60_000);
      await h.list();
      expect((await h.list()).tasks[0].state).toBe('completed');
      expect(h.store.read().comments.filter((c) => c.author.kind === 'agent')).toEqual([]);
    } finally {
      await h.app.close();
    }
  });

  it('a request a process that is gone left on its way is settled from the transcript, and Retry sends it again once', async () => {
    const h = await harness();
    try {
      const requestId = uuid();
      const { task } = (await h.run({ requestId })).json().data as { task: TaskRow };
      const messageId = taskPart(h.file()[0])!.messageId;
      const write = h.sessions.get(task.sessionId)!.writeViaMux as ReturnType<typeof vi.fn>;
      // What a restart finds: the message recorded on its way, and no delivery carrying it.
      setMessageState(h.workspace.id, task.id, messageId, 'sending');
      await h.list();
      const [failed] = (await h.list()).tasks;
      expect(failed).toMatchObject({ state: 'failed', retryable: true });
      expect(write).toHaveBeenCalledTimes(1);
      // The same request id without `retry` only reads.
      expect((await h.run({ requestId })).json().data).toMatchObject({ duplicate: true, task: { state: 'failed' } });
      expect(write).toHaveBeenCalledTimes(1);
      const retried = await h.run({ requestId, retry: true });
      expect(retried.json().data).toMatchObject({ duplicate: true, retried: true });
      expect(write).toHaveBeenCalledTimes(2);
      expect(write.mock.calls[1][0]).toMatch(/Tidy the README\r$/);
      expect((await h.list()).tasks[0].state).toBe('running');
      expect(h.port.startConversationSession).toHaveBeenCalledTimes(1);
      expect(h.worktrees()).toHaveLength(1);
      // An agent cannot retry.
      h.sessions.set('agent-1', { id: 'agent-1', workingDir: h.casePath });
      const asAgent = await h.app.inject({
        method: 'POST',
        url: `${h.base}/tasks`,
        headers: { 'x-codeman-parent-session': 'agent-1' },
        payload: { requestId, text: 'Tidy the README', retry: true },
      });
      expect(asAgent.statusCode).toBe(403);

      // The agent did take it: the transcript holds the request, so it is recorded delivered.
      const second = ((await h.run()).json().data as { task: TaskRow }).task;
      const secondMessage = taskPart(h.file().find((c) => c.id === second.id)!)!.messageId;
      h.transcripts.set(second.sessionId, [prompt(secondMessage, 'Tidy the README')]);
      setMessageState(h.workspace.id, second.id, secondMessage, 'queued');
      await h.list();
      expect((await h.list()).tasks.find((r) => r.id === second.id)!.state).toBe('running');
    } finally {
      await h.app.close();
    }
  });

  it('a count for a closed list reads no transcript of a working task', async () => {
    const h = await harness();
    try {
      const { task } = (await h.run()).json().data as { task: TaskRow };
      h.answer(task, 'Working on it');
      h.sessions.get(task.sessionId)!.isWorking = true;
      await h.stop(task.sessionId);
      h.port.transcriptRows.mockClear();
      h.port.transcriptStamp.mockClear();
      for (let i = 0; i < 5; i++) {
        const brief = await h.app.inject({ method: 'GET', url: `${h.base}/tasks?brief=1` });
        await settleReplies();
        expect(brief.json().data).toEqual({
          brief: true,
          tasks: [
            { id: task.id, requestId: task.requestId, name: task.name, createdAt: task.createdAt, state: 'running' },
          ],
          active: 1,
          cap: MAX_ACTIVE_TASKS,
        });
      }
      expect(h.port.transcriptRows).not.toHaveBeenCalled();
      // A full list of a working task reads none either.
      await h.list();
      expect(h.port.transcriptRows).not.toHaveBeenCalled();
    } finally {
      await h.app.close();
    }
  });
});

describe('fix round 1: where a task runs', () => {
  it('a linked case behind a symlink: the session folder is spelled through the case path and resolves to the workspace', async () => {
    const h = await harness({ linked: true });
    try {
      const response = await h.run();
      expect(response.statusCode).toBe(200);
      const { task } = response.json().data as { task: TaskRow };
      const [name] = h.worktrees();
      const session = h.sessions.get(task.sessionId)!;
      expect(session.workingDir).toBe(join(h.casePath, '.claude', 'worktrees', name));
      // The task's own session, as an agent caller, lands on this workspace.
      const own = await h.app.inject({
        method: 'GET',
        url: '/api/canvas/current/tasks',
        headers: { 'x-codeman-parent-session': task.sessionId },
      });
      expect(own.statusCode).toBe(200);
      expect(own.json().data.tasks.map((t: TaskRow) => t.id)).toEqual([task.id]);
      expect(JSON.stringify(own.json())).not.toContain(dir);
      // Its live session is seen inside its worktree whichever way the path is spelled.
      const busy = await h.remove(task.id);
      expect(busy.statusCode).toBe(409);
      await h.cancel(task.id);
      expect((await h.remove(task.id)).json().data).toEqual({ removed: true });
      expect(h.worktrees()).toEqual([]);
    } finally {
      await h.app.close();
    }
  });

  it('says why no worktree can be made: no commit yet, a subfolder of a repository, a bare repository', async () => {
    const empty = await harness({ repo: 'empty' });
    try {
      const requestId = uuid();
      const refused = await empty.run({ requestId });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toMatch(/^NO_COMMITS: /);
      expect(refused.json().error).not.toContain(empty.casePath);
      expect(empty.port.startConversationSession).not.toHaveBeenCalled();
      const shared = await empty.run({ requestId, shared: true });
      expect(shared.statusCode).toBe(200);
      expect(shared.json().data.task.isolation.kind).toBe('shared');
    } finally {
      await empty.app.close();
    }
    const outer = join(dir, 'outer');
    mkdirSync(join(outer, 'inner'), { recursive: true });
    git(outer, 'init', '-q', '-b', 'main');
    commitFirst(outer);
    const sub = await harness({ linkedTo: join(outer, 'inner') });
    try {
      const refused = await sub.run();
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toMatch(/^REPOSITORY_SUBFOLDER: /);
      expect(refused.json().error).not.toContain(dir);
    } finally {
      await sub.app.close();
    }
    const bare = join(dir, 'bare.git');
    mkdirSync(bare);
    git(bare, 'init', '-q', '--bare');
    const b = await harness({ linkedTo: bare });
    try {
      const refused = await b.run();
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toMatch(/^BARE_REPOSITORY: /);
    } finally {
      await b.app.close();
    }
  });

  it('a session start that throws undoes the worktree it was for', async () => {
    const h = await harness();
    try {
      h.port.startConversationSession.mockRejectedValueOnce(new Error(`spawn failed in ${h.casePath}`));
      const response = await h.run();
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe('START_FAILED: the session could not be started');
      expect(h.worktrees()).toEqual([]);
      expect(h.branches()).toEqual([]);
      expect(h.file()).toEqual([]);
      expect((await h.list()) as unknown as { leftBehind?: unknown }).not.toHaveProperty('leftBehind');
    } finally {
      await h.app.close();
    }
  });

  it('a parent that is not a conversation of this workspace is not recorded', async () => {
    const h = await harness();
    try {
      const stranger = ((await h.run({ parentConversationId: uuid() })).json().data as { task: TaskRow }).task;
      expect(stranger.parentConversationId).toBeUndefined();
      const made = await h.app.inject({
        method: 'POST',
        url: `${h.base}/conversations`,
        payload: { requestId: uuid() },
      });
      const parent = made.json().data.conversation.id as string;
      const child = ((await h.run({ parentConversationId: parent })).json().data as { task: TaskRow }).task;
      expect(child.parentConversationId).toBe(parent);
      // A task is not a parent.
      const grandchild = ((await h.run({ parentConversationId: child.id })).json().data as { task: TaskRow }).task;
      expect(grandchild.parentConversationId).toBeUndefined();
    } finally {
      await h.app.close();
    }
  });
});

describe('fix round 1: left-behind worktrees', () => {
  const leave = (h: Awaited<ReturnType<typeof harness>>, name: string) => {
    git(h.casePath, 'worktree', 'add', '-q', '-b', `worktree-${name}`, join('.claude', 'worktrees', name));
    forgetLeftBehind();
  };
  const left = async (h: Awaited<ReturnType<typeof harness>>) =>
    ((await h.list()) as unknown as { leftBehind?: { name: string; label: string; branch?: string }[] }).leftBehind;
  const removeLeft = (h: Awaited<ReturnType<typeof harness>>, name: string, headers = {}) =>
    h.app.inject({ method: 'DELETE', url: `${h.base}/tasks/left-behind/${name}`, headers });

  it('lists only task-named worktrees no task names and no session is inside, and removes one without force', async () => {
    const h = await harness();
    try {
      const { task } = (await h.run()).json().data as { task: TaskRow };
      const [own] = h.worktrees();
      expect(await left(h)).toBeUndefined();
      leave(h, 'task-0badc0de');
      leave(h, 'task-feedf00d');
      leave(h, 'mine');
      expect(await left(h)).toEqual([
        { name: 'task-0badc0de', label: '.claude/worktrees/task-0badc0de', branch: 'worktree-task-0badc0de' },
        { name: 'task-feedf00d', label: '.claude/worktrees/task-feedf00d', branch: 'worktree-task-feedf00d' },
      ]);
      expect(JSON.stringify(await h.list())).not.toContain(h.casePath);
      // A live session inside one means it is somebody's.
      h.sessions.set('other', {
        id: 'other',
        workingDir: join(h.casePath, '.claude', 'worktrees', 'task-feedf00d', 'src'),
      });
      forgetLeftBehind();
      expect((await left(h))!.map((r) => r.name)).toEqual(['task-0badc0de']);
      h.sessions.delete('other');

      h.sessions.set('agent-1', { id: 'agent-1', workingDir: h.casePath });
      expect((await removeLeft(h, 'task-0badc0de', { 'x-codeman-parent-session': 'agent-1' })).statusCode).toBe(403);
      h.sessions.delete('agent-1');
      // Only names this subsystem makes, and never one a task still names.
      expect((await removeLeft(h, 'mine')).statusCode).toBe(404);
      const listed = await removeLeft(h, own);
      expect(listed.statusCode).toBe(409);
      expect(listed.json().error).toMatch(/^TASK_LISTED:/);

      writeFileSync(join(h.casePath, '.claude', 'worktrees', 'task-feedf00d', 'work.txt'), 'kept\n');
      const kept = await removeLeft(h, 'task-feedf00d');
      expect(kept.json().data).toEqual({
        removed: false,
        kept: { label: '.claude/worktrees/task-feedf00d', reason: 'changes' },
      });
      expect(JSON.stringify(kept.json())).not.toContain(h.casePath);
      expect((await removeLeft(h, 'task-0badc0de')).json().data).toEqual({ removed: true });
      expect(h.worktrees().sort()).toEqual(['mine', own, 'task-feedf00d'].sort());
      expect(h.branches()).not.toContain('worktree-task-0badc0de');
      expect((await left(h))!.map((r) => r.name)).toEqual(['task-feedf00d']);
      expect((await h.list()).tasks.map((t) => t.id)).toEqual([task.id]);
    } finally {
      await h.app.close();
    }
  });
});

describe('fix round 1: remove says what it kept and why', () => {
  it('a folder git no longer knows, a locked worktree, and a session still inside each keep the row with their reason', async () => {
    const h = await harness();
    try {
      const tasks: TaskRow[] = [];
      for (let i = 0; i < 3; i++) tasks.push(((await h.run()).json().data as { task: TaskRow }).task);
      const nameOf = (t: TaskRow) => t.isolation.label.split('/').at(-1)!;
      for (const t of tasks) await h.cancel(t.id);
      // git's record is gone and the folder is still there.
      rmSync(join(h.casePath, '.git', 'worktrees', nameOf(tasks[0])), { recursive: true, force: true });
      expect((await h.remove(tasks[0].id)).json().data).toMatchObject({ removed: false, kept: { reason: 'leftover' } });
      expect(existsSync(join(h.casePath, '.claude', 'worktrees', nameOf(tasks[0])))).toBe(true);
      // Once the folder is gone too, there is nothing left to keep.
      rmSync(join(h.casePath, '.claude', 'worktrees', nameOf(tasks[0])), { recursive: true, force: true });
      expect((await h.remove(tasks[0].id)).json().data).toEqual({ removed: true });

      git(h.casePath, 'worktree', 'lock', join('.claude', 'worktrees', nameOf(tasks[1])));
      expect((await h.remove(tasks[1].id)).json().data).toMatchObject({ removed: false, kept: { reason: 'locked' } });
      git(h.casePath, 'worktree', 'unlock', join('.claude', 'worktrees', nameOf(tasks[1])));
      expect((await h.remove(tasks[1].id)).json().data).toEqual({ removed: true });

      h.sessions.set('visitor', {
        id: 'visitor',
        workingDir: join(h.casePath, '.claude', 'worktrees', nameOf(tasks[2])),
      });
      expect((await h.remove(tasks[2].id)).json().data).toMatchObject({ removed: false, kept: { reason: 'in-use' } });
      h.sessions.delete('visitor');
      expect((await h.remove(tasks[2].id)).json().data).toEqual({ removed: true });
      expect(h.file()).toEqual([]);
    } finally {
      await h.app.close();
    }
  });

  it('a session that will not close keeps the record, in a shared task too, and the kept row keeps its result', async () => {
    const h = await harness({ repo: false });
    try {
      const { task } = (await h.run({ shared: true })).json().data as { task: TaskRow };
      h.answer(task, 'The answer to keep');
      await h.stop(task.sessionId);
      expect((await h.list()).tasks[0].state).toBe('completed');
      h.port.discardConversationSession.mockImplementationOnce(async () => undefined);
      const kept = await h.remove(task.id);
      expect(kept.json().data).toMatchObject({ removed: false, kept: { reason: 'session' } });
      expect(h.file()).toHaveLength(1);
      expect(taskPart(h.file()[0])!.result).toEqual({ text: 'The answer to keep', truncated: false });
      expect((await h.remove(task.id)).json().data).toEqual({ removed: true });
      expect(h.file()).toEqual([]);
    } finally {
      await h.app.close();
    }
  });

  it('a kept worktree row still shows the result after its session is gone, and an exclude warning rides the row', async () => {
    const h = await harness();
    try {
      const { task } = (await h.run()).json().data as { task: TaskRow };
      const [name] = h.worktrees();
      h.answer(task, 'Wrote notes.txt');
      await h.stop(task.sessionId);
      writeFileSync(join(h.casePath, '.claude', 'worktrees', name, 'notes.txt'), 'work\n');
      expect((await h.remove(task.id)).json().data).toMatchObject({ removed: false, kept: { reason: 'changes' } });
      expect(h.sessions.has(task.sessionId)).toBe(false);
      forgetTaskResults();
      const [row] = (await h.list()).tasks;
      expect(row.result).toEqual({ text: 'Wrote notes.txt', truncated: false });
      expect(row.excludeWarning).toBeUndefined();
      setTaskHint(h.workspace.id, task.id, { excludeWarning: true });
      expect((await h.list()).tasks[0].excludeWarning).toBe(true);
    } finally {
      await h.app.close();
    }
  });
});

describe('fix round 1: a reply-only task is always removable', () => {
  const globalConfig = (name: string, ignores: string) => {
    const excludes = join(dir, `${name}.ignore`);
    writeFileSync(excludes, ignores);
    const config = join(dir, `${name}.gitconfig`);
    writeFileSync(config, `[core]\n\texcludesFile = ${excludes}\n`);
    return config;
  };
  /** What a session start writes into its folder. */
  const sessionFiles = (tree: string) => {
    mkdirSync(join(tree, '.claude', 'skills', 'codeman'), { recursive: true });
    writeFileSync(join(tree, '.claude', 'settings.local.json'), '{"hooks":{}}\n');
    writeFileSync(join(tree, '.claude', 'skills', 'codeman', 'SKILL.md'), '# skill\n');
  };

  it("writes Codeman's own files into the repository's exclude whatever the machine ignores, so removal does not depend on it", async () => {
    // The machine ignores the files when the worktree is made, and not when it is removed.
    vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null');
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig('covers', '.claude/settings.local.json\n.claude/skills/codeman/\n'));
    const h = await harness();
    try {
      const reply = ((await h.run()).json().data as { task: TaskRow }).task;
      const work = ((await h.run()).json().data as { task: TaskRow }).task;
      const exclude = readFileSync(join(h.casePath, '.git', 'info', 'exclude'), 'utf8');
      expect(exclude).toContain('.claude/settings.local.json');
      expect(exclude).toContain('.claude/skills/codeman');
      expect(reply.excludeWarning).toBeUndefined();
      vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig('empty', ''));
      const treeOf = (t: TaskRow) => join(h.casePath, t.isolation.label);
      sessionFiles(treeOf(reply));
      sessionFiles(treeOf(work));
      writeFileSync(join(treeOf(work), 'report.md'), 'a real new file\n');
      await h.cancel(reply.id);
      await h.cancel(work.id);
      expect((await h.remove(reply.id)).json().data).toEqual({ removed: true });
      expect(existsSync(treeOf(reply))).toBe(false);
      expect((await h.remove(work.id)).json().data).toMatchObject({ removed: false, kept: { reason: 'changes' } });
      expect(existsSync(join(treeOf(work), 'report.md'))).toBe(true);
    } finally {
      await h.app.close();
    }
  });
});
