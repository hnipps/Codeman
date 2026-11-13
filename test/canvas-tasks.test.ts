import { readFileSync } from 'node:fs';
import {
  KEPT_REASON,
  MAX_SENT_TASKS,
  RUN_INTERRUPTED,
  STATE_LABEL,
  attemptPending,
  nextTaskAttempt,
  parseSentTasks,
  parseSeen,
  parseTaskAttempt,
  seenAfterOpen,
  sortTasks,
  taskActionFailure,
  taskAsides,
  taskCount,
  taskFailure,
  taskMeta,
} from '../packages/canvas/src/task.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CreateTaskBodySchema,
  cutResult,
  DEFAULT_TASK_NAME,
  deriveTaskName,
  deriveTaskState,
  isolationLabel,
  MAX_TASK_NAME_CHARS,
  taskActive,
  taskPart,
  type TaskEvidence,
  type TaskState,
} from '../src/canvas/tasks.js';
import { ConversationsFileSchema } from '../src/canvas/conversation-schema.js';

const live: TaskEvidence = { message: 'delivered', session: 'live', approval: false, working: false };

describe('deriveTaskState', () => {
  const table: [string, Partial<TaskEvidence>, TaskState][] = [
    ['a request waiting behind another is queued', { message: 'queued' }, 'queued'],
    ['a request being written to the pane is queued', { message: 'sending' }, 'queued'],
    ['a delivered request whose turn has not ended is running', {}, 'running'],
    ['a pending question is waiting for the person', { approval: true }, 'waiting'],
    [
      'a question pending while the request is still queued is waiting',
      { message: 'queued', approval: true },
      'waiting',
    ],
    ['a recorded turn end is completed', { completedAt: 5 }, 'completed'],
    ['completed stays completed when the session is later gone', { completedAt: 5, session: 'gone' }, 'completed'],
    ['a completed task whose session asks again is waiting', { completedAt: 5, approval: true }, 'waiting'],
    ['a completed task whose turn resumed by itself is running again', { completedAt: 5, working: true }, 'running'],
    [
      'a completed task whose session exited stays completed',
      { completedAt: 5, session: 'exited', working: true },
      'completed',
    ],
    ['work does not make an undelivered request running', { message: 'queued', working: true }, 'queued'],
    ['a request that was not delivered is failed', { message: 'failed' }, 'failed'],
    ['a record without its request is failed', { message: 'none' }, 'failed'],
    ['an agent that exited before its turn ended is failed', { session: 'exited' }, 'failed'],
    ['a session the server no longer holds is failed', { session: 'gone' }, 'failed'],
    ['a failure beats a pending question', { session: 'exited', approval: true }, 'failed'],
    ['a recorded cancel is cancelled', { cancelledAt: 3 }, 'cancelled'],
    ['a cancel beats a later turn end', { cancelledAt: 3, completedAt: 5 }, 'cancelled'],
    ['a cancel beats a failed delivery', { cancelledAt: 3, message: 'failed' }, 'cancelled'],
    ['a cancel beats a session that is gone', { cancelledAt: 3, session: 'gone' }, 'cancelled'],
    ['a cancel beats a pending question', { cancelledAt: 3, approval: true }, 'cancelled'],
  ];
  it.each(table)('%s', (_name, evidence, expected) => {
    expect(deriveTaskState({ ...live, ...evidence })).toBe(expected);
  });
  it('reaches all six states and only those', () => {
    const seen = new Set<TaskState>();
    for (const message of ['none', 'queued', 'sending', 'delivered', 'failed'] as const)
      for (const session of ['live', 'exited', 'gone'] as const)
        for (const approval of [false, true])
          for (const cancelledAt of [undefined, 1])
            for (const completedAt of [undefined, 2])
              seen.add(deriveTaskState({ message, session, approval, cancelledAt, completedAt }));
    expect([...seen].sort()).toEqual(['cancelled', 'completed', 'failed', 'queued', 'running', 'waiting']);
  });
  it('counts queued, running and waiting as active', () => {
    expect((['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled'] as const).map(taskActive)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});

describe('deriveTaskName', () => {
  it('uses the first non-empty line on one line', () => {
    expect(deriveTaskName('\n\n  Fix   the\tlogin page  \nand more')).toBe('Fix the login page');
  });
  it('cuts a long request at a word and marks the cut', () => {
    const name = deriveTaskName('Rewrite the onboarding flow so that every screen explains itself without help text');
    expect([...name].length).toBeLessThanOrEqual(MAX_TASK_NAME_CHARS);
    expect(name.endsWith('…')).toBe(true);
    expect(name).toBe('Rewrite the onboarding flow so that every screen explains…');
  });
  it('cuts one very long word without splitting a surrogate pair', () => {
    const name = deriveTaskName('😀'.repeat(200));
    expect([...name].length).toBe(MAX_TASK_NAME_CHARS);
    expect(name).toBe('😀'.repeat(MAX_TASK_NAME_CHARS - 1) + '…');
  });
  it('falls back when there are no words', () => {
    expect(deriveTaskName(' \n\t\n')).toBe(DEFAULT_TASK_NAME);
  });
  it('drops control characters', () => {
    expect(deriveTaskName('Fix\u0007 this\u001b now')).toBe('Fix this now');
  });
});

describe('task part and body', () => {
  const stored = {
    name: 'Fix it',
    requestId: '11111111-1111-4111-8111-111111111111',
    messageId: '22222222-2222-4222-8222-222222222222',
    isolation: { kind: 'worktree', name: 'task-ab12cd34', branch: 'worktree-task-ab12cd34' },
  };
  it('reads a stored part and keeps only what it knows', () => {
    expect(taskPart({ task: { ...stored, cancelledAt: 4, future: { anything: true } } })).toEqual({
      ...stored,
      cancelledAt: 4,
    });
  });
  it('reads an unknown hint as absent and an unknown shape as no task', () => {
    expect(taskPart({ task: { ...stored, completedAt: 'soon', kept: 'elsewhere' } })).toEqual(stored);
    expect(taskPart({ task: { ...stored, isolation: { kind: 'container' } } })).toBeUndefined();
    expect(taskPart({ task: 'yes' })).toBeUndefined();
    expect(taskPart({})).toBeUndefined();
  });
  it('labels isolation inside the case folder, never as a path from the root', () => {
    expect(isolationLabel({ kind: 'worktree', name: 'task-ab12cd34', branch: 'b' })).toBe(
      '.claude/worktrees/task-ab12cd34'
    );
    expect(isolationLabel({ kind: 'shared' })).toBe('Case folder, shared');
  });
  it('accepts only the documented body', () => {
    const requestId = '33333333-3333-4333-8333-333333333333';
    expect(CreateTaskBodySchema.parse({ requestId, text: 'go' })).toEqual({ requestId, text: 'go', refIds: [] });
    expect(CreateTaskBodySchema.safeParse({ requestId, text: 'go', shared: false }).success).toBe(false);
    expect(CreateTaskBodySchema.safeParse({ requestId, text: 'go', name: 'a\u0007b' }).success).toBe(false);
    expect(CreateTaskBodySchema.safeParse({ requestId, text: 'go', name: 'x'.repeat(61) }).success).toBe(false);
    expect(CreateTaskBodySchema.safeParse({ requestId, text: 'go', workingDir: '/tmp' }).success).toBe(false);
    expect(CreateTaskBodySchema.safeParse({ requestId, text: '' }).success).toBe(false);
  });
  it('cuts a result without splitting a surrogate pair', () => {
    expect(cutResult('abc', 10)).toEqual({ text: 'abc', truncated: false });
    expect(cutResult('ab😀cd', 3)).toEqual({ text: 'ab', truncated: true });
  });
});

describe('stored data', () => {
  // The conversation file shape of the release before tasks, copied as it shipped: every level passes unknown keys through.
  const Message = z
    .object({
      messageId: z.uuid(),
      sentAt: z.number().int().nonnegative(),
      deliveredAt: z.number().int().nonnegative().nullable(),
      submittedAt: z.number().int().nonnegative().optional().catch(undefined),
      state: z.enum(['queued', 'sending', 'delivered', 'failed']).optional(),
      author: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('human'), userId: z.string().min(1).max(128) }).passthrough(),
        z.object({ kind: z.literal('agent'), sessionId: z.string() }).passthrough(),
      ]),
      textSha256: z.string().regex(/^[a-f0-9]{64}$/),
      textBytes: z.number().int().nonnegative(),
      namedSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      refs: z.array(z.unknown()).max(200),
      seq: z.number().int().nonnegative(),
      origin: z.unknown().optional(),
      reply: z.unknown().optional(),
    })
    .passthrough();
  const PreviousFile = z
    .object({
      version: z.literal(1),
      conversations: z
        .array(
          z
            .object({
              id: z.uuid(),
              sessionId: z.string().min(1).max(128),
              cliId: z.string().min(1).max(64),
              model: z.string().max(100).optional(),
              title: z.string().max(200).optional(),
              origin: z.unknown().optional(),
              requestId: z.uuid().optional(),
              createdAt: z.number().int().nonnegative(),
              createdBy: z.string().min(1).max(128),
              messages: z.array(Message).max(2000),
            })
            .passthrough()
        )
        .max(50),
    })
    .passthrough();
  const file = {
    version: 1,
    conversations: [
      {
        id: '44444444-4444-4444-8444-444444444444',
        sessionId: 'session-1',
        cliId: 'claude',
        requestId: '11111111-1111-4111-8111-111111111111',
        createdAt: 10,
        createdBy: '@single',
        task: {
          name: 'Fix it',
          requestId: '11111111-1111-4111-8111-111111111111',
          messageId: '22222222-2222-4222-8222-222222222222',
          isolation: { kind: 'worktree', name: 'task-ab12cd34', branch: 'worktree-task-ab12cd34' },
          completedAt: 30,
        },
        messages: [
          {
            messageId: '22222222-2222-4222-8222-222222222222',
            sentAt: 11,
            deliveredAt: 12,
            submittedAt: 11,
            state: 'delivered',
            author: { kind: 'human', userId: 'admin' },
            textSha256: 'a'.repeat(64),
            textBytes: 2,
            namedSha256: 'b'.repeat(64),
            refs: [],
            seq: 1,
          },
        ],
      },
    ],
  };
  it('a file with a task parses under the previous release, which keeps the task part untouched', () => {
    const previous = PreviousFile.parse(file);
    expect(previous.conversations[0].sessionId).toBe('session-1');
    expect((previous.conversations[0] as { task?: unknown }).task).toEqual(file.conversations[0].task);
    // What the previous release writes back still reads as the same task here.
    const back = ConversationsFileSchema.parse(JSON.parse(JSON.stringify(previous)));
    expect(taskPart(back.conversations[0])).toEqual(file.conversations[0].task);
  });
  it('a file from before tasks reads as conversations with no task', () => {
    const before = structuredClone(file) as { conversations: { task?: unknown }[] };
    delete before.conversations[0].task;
    const parsed = ConversationsFileSchema.parse(before);
    expect(taskPart(parsed.conversations[0])).toBeUndefined();
  });
});

describe('the browser side of a run', () => {
  const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  it('keeps the request id for the same request and makes another for a changed one', () => {
    let made = 0;
    const make = () => id(++made);
    const first = nextTaskAttempt(null, 'Tidy', ['a'], make);
    expect(first).toEqual({ requestId: id(1), text: 'Tidy', refIds: ['a'] });
    expect(nextTaskAttempt(first, 'Tidy', ['a'], make)).toBe(first);
    expect(nextTaskAttempt(first, 'Tidy up', ['a'], make).requestId).toBe(id(2));
    expect(nextTaskAttempt(first, 'Tidy', ['a', 'b'], make).requestId).toBe(id(3));
    expect(nextTaskAttempt(first, 'Tidy', ['b'], make).requestId).toBe(id(4));
  });
  it('reads a stored attempt back exactly, and anything else as none', () => {
    const attempt = { requestId: id(1), text: 'Tidy', refIds: ['a'] };
    expect(parseTaskAttempt(JSON.stringify(attempt))).toEqual(attempt);
    expect(parseTaskAttempt(JSON.stringify({ ...attempt, extra: 1 }))).toEqual(attempt);
    for (const raw of [null, '', 'x', '[]', '{}', JSON.stringify({ ...attempt, requestId: 'no' })])
      expect(parseTaskAttempt(raw)).toBeNull();
    expect(parseTaskAttempt(JSON.stringify({ ...attempt, refIds: [1] }))).toBeNull();
  });
  it('asks about sharing only for a folder that is not a repository, and starts over only when the id is spent', () => {
    expect(taskFailure('NOT_A_REPOSITORY: no', 409)).toMatchObject({ share: true, fresh: false });
    expect(taskFailure('TOO_MANY_TASKS: four', 409)).toMatchObject({ share: false, fresh: false });
    expect(taskFailure('TASK_CHANGED: x', 409).fresh).toBe(true);
    expect(taskFailure('REQUEST_REUSED: x', 409).fresh).toBe(true);
    expect(taskFailure('ORIGIN_GONE: x', 409).fresh).toBe(true);
    for (const code of ['START_FAILED', 'WORKTREE_FAILED', 'SESSION_ENDED', 'CASE_UNREACHABLE'])
      expect(taskFailure(`${code}: /srv/secret/path`, 409).text).not.toContain('/srv');
    expect(taskFailure('', 500).text).toContain('kept');
    expect(taskActionFailure('TASK_ACTIVE: x', 409)).toBe('Cancel the task before removing it.');
    expect(taskActionFailure('', 404)).toBe('This task is no longer listed.');
  });
  it('counts tasks that wait for the person or finished unseen, and opening the list clears the finished ones', () => {
    const rows = [
      { id: 'a', state: 'running' },
      { id: 'b', state: 'waiting' },
      { id: 'c', state: 'completed' },
      { id: 'd', state: 'failed' },
      { id: 'e', state: 'cancelled' },
      { id: 'f', state: 'queued' },
    ] as const;
    expect(taskCount(rows, new Set())).toBe(4);
    const seen = new Set(seenAfterOpen(rows));
    expect([...seen]).toEqual(['c', 'd', 'e']);
    // A question still waits after the list was looked at.
    expect(taskCount(rows, seen)).toBe(1);
    expect(taskCount([], seen)).toBe(0);
    expect(parseSeen(JSON.stringify(['c', 4, 'd']))).toEqual(['c', 'd']);
    expect(parseSeen('{')).toEqual([]);
  });
  it('orders running tasks first, then newest, and names every state', () => {
    const rows = [
      { state: 'completed', createdAt: 5 },
      { state: 'running', createdAt: 1 },
      { state: 'waiting', createdAt: 3 },
      { state: 'failed', createdAt: 9 },
    ] as const;
    expect(sortTasks(rows).map((r) => r.createdAt)).toEqual([3, 1, 9, 5]);
    expect(Object.keys(STATE_LABEL).sort()).toEqual(
      ['cancelled', 'completed', 'failed', 'queued', 'running', 'waiting'].sort()
    );
    expect(
      taskMeta({
        cliId: 'claude',
        cliLabel: 'Claude Code',
        model: 'opus',
        isolation: { kind: 'worktree', label: '.claude/worktrees/task-1' },
      })
    ).toBe('Claude Code · opus · .claude/worktrees/task-1');
    expect(
      taskMeta({ cliId: 'claude', cliLabel: '', isolation: { kind: 'shared', label: 'Case folder, shared' } })
    ).toBe('claude · Case folder, shared');
  });
  it("says why a folder cannot be isolated in the server's own words, and that a cancelled task takes nothing more", () => {
    for (const code of ['NO_COMMITS', 'REPOSITORY_SUBFOLDER', 'BARE_REPOSITORY', 'DOCKER_WORKSPACE']) {
      const said = taskFailure(`${code}: this repository has no commit yet`, 409);
      expect(said).toMatchObject({ share: true, fresh: false });
      expect(said.text).toContain('this repository has no commit yet');
    }
    expect(taskFailure('TASK_CANCELLED: x', 409)).toEqual({
      text: 'This task was cancelled. Start a new one.',
      share: false,
      fresh: false,
    });
  });
  it('keeps the requests it sent so one can be retried, bounded, and reads anything else as none', () => {
    const sent = Array.from({ length: MAX_SENT_TASKS + 3 }, (_, n) => ({
      id: `task-${n}`,
      requestId: id(n % 10),
      text: `Request ${n}`,
      refIds: ['a'],
    }));
    const read = parseSentTasks(JSON.stringify(sent));
    expect(read).toHaveLength(MAX_SENT_TASKS);
    expect(read.at(-1)).toEqual(sent.at(-1));
    expect(parseSentTasks(JSON.stringify([{ ...sent[0], id: 4 }, { id: 'x' }, 'no', sent[1]]))).toEqual([sent[1]]);
    for (const raw of [null, '', '{', '{}']) expect(parseSentTasks(raw)).toEqual([]);
    expect(RUN_INTERRUPTED).toContain('task list');
  });
  it('a row says what a cancel left, that a request was not delivered, and why a worktree will be kept', () => {
    expect(taskAsides({ state: 'cancelled' })).toEqual([
      'Cancelled. Its session is kept for inspection only and takes no more messages.',
    ]);
    expect(taskAsides({ state: 'cancelled', unsubmitted: true })[0]).toContain(
      'may still be in this session’s input box'
    );
    expect(taskAsides({ state: 'cancelled', kept: { label: 'x', reason: 'changes' } })).toEqual([]);
    expect(taskAsides({ state: 'failed', retryable: true })).toEqual(['The request was not delivered to the agent.']);
    expect(taskAsides({ state: 'running', excludeWarning: true })[0]).toContain('kept on Remove');
    expect(taskAsides({ state: 'completed' })).toEqual([]);
    expect(Object.keys(KEPT_REASON).sort()).toEqual(['changes', 'failed', 'in-use', 'leftover', 'locked', 'session']);
  });
  it('a run and a send never carry the same text: each refuses while the other travels, and a spoken countdown is cancelled', () => {
    const source = (name: string) => readFileSync(`packages/canvas/src/${name}`, 'utf8');
    const assistant = source('assistant.ts');
    // Run refuses while a send or a spoken send is on its way; Send refuses while a run is.
    expect(assistant).toMatch(/if \(this\.sending \|\| this\.inflight\) return fail\(/);
    expect(assistant).toMatch(/if \(this\.options\.voicePending\?\.\(\)\)\s+return fail\(/);
    expect(assistant).toMatch(/if \(this\.runningTask\) return \{ ok: false, refusal:/);
    expect(assistant).toMatch(
      /node\('assistantSend'\)\.toggleAttribute\('disabled', this\.sending \|\| this\.runningTask !== null\)/
    );
    const entry = source('entry.ts');
    expect(entry).toMatch(/voicePending: \(\) => voice\.pending\(\)/);
    expect(entry).toMatch(/runStarting: \(\) => voice\.cancelPending\(\)/);
    expect(entry).toMatch(/taskShown: \(\) => assistant\.showsTask\(\)/);
    expect(attemptPending(JSON.stringify({ requestId: id(1), text: 'x', refIds: [], pending: true }))).toBe(true);
    expect(attemptPending(JSON.stringify({ requestId: id(1), text: 'x', refIds: [] }))).toBe(false);
    expect(attemptPending('{')).toBe(false);
  });
  it('a task cannot be started by voice or by a view command: only the assistant view calls the route', () => {
    const source = (name: string) => readFileSync(`packages/canvas/src/${name}`, 'utf8');
    for (const name of [
      'voice.ts',
      'voice-view.ts',
      'voice-capture.ts',
      'view-sync.ts',
      'commands.ts',
      'tasks-view.ts',
    ])
      expect(source(name)).not.toMatch(/runInBackground|\/tasks`, \{\s*method: 'POST'/);
    // The list view only cancels and removes; it never posts a new task.
    expect(source('tasks-view.ts')).not.toMatch(/tasks`,\s*\{/);
    expect(source('entry.ts').match(/runInBackground/g)).toHaveLength(1);
  });
});
