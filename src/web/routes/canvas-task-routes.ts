/**
 * @fileoverview Canvas background tasks (PC12). A task is a conversation record with a `task` part: one real session
 * started through the conversation create path, one request sent through the conversation send path and, in a case
 * that is a git repository, a managed worktree of that case made and removed by the functions behind the worktree
 * routes. Nothing here spawns, writes to a pane or runs git on its own.
 *
 *   GET    /api/canvas/:workspaceId/tasks                         the tasks with their derived state
 *   POST   /api/canvas/:workspaceId/tasks                         start one (people only, deduped by `requestId`)
 *   POST   /api/canvas/:workspaceId/tasks/:conversationId/cancel  interrupt that task's session and record the cancel
 *   DELETE /api/canvas/:workspaceId/tasks/:conversationId         remove a finished task: its session, then its worktree
 *   DELETE /api/canvas/:workspaceId/tasks/left-behind/:name       remove a `task-*` worktree no task names (non-force)
 *
 * "Only a person" on the routes that start, cancel, remove or retry rests on the caller-declared agent header
 * (`req.canvasAuthor`), the same check conversations use: a caller that does not declare itself an agent is a person.
 *
 * A task's state is never stored: `deriveTaskState()` reads it from the message's delivery state, the recorded cancel
 * and turn end, the approvals inbox and the session. No answer carries a server path; a worktree is named by its
 * place inside the case folder.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { CanvasPort } from '../ports/canvas-port.js';
import type { SessionPort } from '../ports/session-port.js';
import { canAccessOwned, findSessionOrFail, getAuthUser, ownerFor, parseBody } from '../route-helpers.js';
import { ApiErrorCode } from '../../types.js';
import { SseEvent } from '../sse-events.js';
import { getCli } from '../../config/cli-registry/registry.js';
import {
  createCaseWorktree,
  isPathWithin,
  listCaseWorktrees,
  removeCaseWorktree,
  resolveCaseRepository,
  respellUnder,
  runWorktreeGit,
  WORKTREES_DIR_SEGMENTS,
  type CaseRepository,
  type WorktreeGitRunner,
} from '../../git-worktrees.js';
import { probePathKind } from '../../utils/bounded-path-probe.js';
import { composerIsEmpty } from '../../session-submit-verifier.js';
import { messageState } from '../../canvas/conversations.js';
import { defaultDockerWorkspaces, registryAgentSkillDirs, resolveLocalCaseFolder } from './worktree-routes.js';
import {
  MAX_CONVERSATIONS_PER_WORKSPACE,
  normalizePrompt,
  promptRefusal,
  threadOrigin,
  type Conversation,
} from '../../canvas/conversation-schema.js';
import {
  addConversation,
  findConversation,
  namedHash,
  readConversations,
  removeConversation,
  setTaskHint,
  sha256,
} from '../../canvas/conversations.js';
import {
  CreateTaskBodySchema,
  deriveTaskName,
  isolationLabel,
  MAX_ACTIVE_TASKS,
  NO_ISOLATION,
  taskActive,
  taskPart,
  type CreateTaskBody,
  type LeftBehindRow,
  type NoIsolation,
  type TaskIsolation,
  type TaskKept,
  type TaskPart,
  type TaskRow,
} from '../../canvas/tasks.js';
import type { Workspace } from '../../canvas/workspace-registry.js';
import {
  caseRunsElsewhere,
  conflict,
  deliveryEnded,
  isOutcome,
  notFound,
  ok,
  reconcileReplies,
  refuse,
  resolveLaunch,
  sendMessage,
  serialCreate,
  taskResult,
  taskStateOf,
  writeGuard,
  type Outcome,
} from './canvas-conversation-routes.js';

/** What a test replaces: the generated worktree name, git itself, and the Docker workspaces git must stay out of. */
export const taskHooks: {
  worktreeName: () => string;
  git?: WorktreeGitRunner;
  dockerWorkspaces: () => Promise<string[]>;
} = {
  worktreeName: () => `task-${randomBytes(4).toString('hex')}`,
  dockerWorkspaces: defaultDockerWorkspaces,
};
/** Timing of a cancel; a test shortens it. */
export const taskTiming = {
  /** How long a cancel waits for the delivery it interrupted to stop. */
  deliveryMs: 3_000,
  /** Between the Escapes that clear a pasted, unsubmitted request, and how many are pressed at most. */
  clearMs: 400,
  clearPresses: 3,
  /** How long a list of left-behind worktrees is reused. */
  leftBehindMs: 15_000,
};
/** A worktree name this subsystem generated; nothing else is ever listed or removed as left behind. */
const TASK_WORKTREE = /^task-[0-9a-f]{8}$/;
const MAX_LEFT_BEHIND = 20;
/** Worktrees a create has made and not yet recorded: never listed as left behind. */
const creating = new Set<string>();
const leftBehindCache = new Map<string, { at: number; rows: LeftBehindRow[] }>();
/** Forgets the cached left-behind lists (tests). */
export const forgetLeftBehind = (): void => leftBehindCache.clear();

const HUMAN_ONLY =
  'A background task starts an agent session, so only a person can start, cancel or remove one. Ask the person to do it from the canvas.';
const agentCaller = (req: FastifyRequest): boolean => req.canvasAuthor?.kind === 'agent';

/** One list row. `canSee` is false for a session the caller may not read; its task then reads as gone. */
async function taskRow(ctx: CanvasPort, req: FastifyRequest, c: Conversation, task: TaskPart): Promise<TaskRow> {
  const session = ctx.sessions.get(c.sessionId);
  const visible = !session || canAccessOwned(getAuthUser(req), session.owner);
  const message = c.messages.find((m) => m.messageId === task.messageId);
  const origin = message ? threadOrigin(message) : undefined;
  const state = taskStateOf(ctx, c, visible) ?? 'failed';
  // A removed task whose session is gone shows the result that was kept when it was removed.
  const result = (await taskResult(ctx, req, c, state)) ?? (session ? undefined : task.result);
  // Not delivered, and its session can still take it: the same request can be sent again.
  const retryable =
    state === 'failed' &&
    !!message &&
    messageState(message) === 'failed' &&
    task.removedAt === undefined &&
    visible &&
    !!session &&
    !session.paneExit;
  return {
    id: c.id,
    requestId: task.requestId,
    name: task.name,
    sessionId: c.sessionId,
    cliId: c.cliId,
    cliLabel: getCli(c.cliId)?.label ?? c.cliId,
    ...(c.model ? { model: c.model } : {}),
    createdAt: c.createdAt,
    state,
    isolation: {
      kind: task.isolation.kind,
      label: isolationLabel(task.isolation),
      ...(task.isolation.kind === 'worktree' ? { branch: task.isolation.branch } : {}),
    },
    ...(result ? { result } : {}),
    ...(retryable ? { retryable: true as const } : {}),
    ...(task.unsubmitted && state === 'cancelled' ? { unsubmitted: true as const } : {}),
    ...(task.excludeWarning ? { excludeWarning: true as const } : {}),
    refs: (message?.refs ?? []).map((r) => ({ id: r.id, label: r.label })),
    ...(origin ? { origin: { objectId: origin.objectId, commentId: origin.commentId } } : {}),
    ...(task.parentConversationId ? { parentConversationId: task.parentConversationId } : {}),
    ...(task.kept ? { kept: { label: isolationLabel(task.isolation), reason: task.kept } } : {}),
  };
}
const tasksOf = (conversations: readonly Conversation[]): { c: Conversation; task: TaskPart }[] =>
  conversations.flatMap((c) => {
    const task = taskPart(c);
    return task ? [{ c, task }] : [];
  });
const activeCount = (ctx: CanvasPort, conversations: readonly Conversation[]): number =>
  tasksOf(conversations).filter(({ c }) => taskActive(taskStateOf(ctx, c) ?? 'failed')).length;

/** A live session whose folder is at or inside `path`, spelled through the case path or the repository's real one. */
const sessionInside = (ctx: CanvasPort, located: { casePath: string; repo: CaseRepository }, path: string): boolean =>
  [...ctx.sessions.values()].some(
    (s) =>
      typeof s.workingDir === 'string' &&
      s.workingDir.startsWith('/') &&
      isPathWithin(respellUnder(s.workingDir, located.casePath, located.repo.repoRoot), path)
  );
/**
 * Worktrees this subsystem's naming made that no task record names and no live session is inside: what a create that
 * died between `git worktree add` and its record leaves. They are only listed, since one may hold work; removing one
 * is the person's choice and uses the same non-force rule as any task's worktree. One `git worktree list`, reused for
 * `leftBehindMs`, at most `MAX_LEFT_BEHIND` rows.
 */
async function leftBehind(
  ctx: CanvasPort,
  req: FastifyRequest,
  workspace: Workspace,
  tasks: readonly { task: TaskPart }[]
): Promise<LeftBehindRow[]> {
  const cached = leftBehindCache.get(workspace.id);
  if (cached && Date.now() - cached.at < taskTiming.leftBehindMs) return cached.rows;
  const located = await locateCase(req, workspace.caseName).catch(() => undefined);
  if (!located || !located.ok || !located.repo) return [];
  const repo = located.repo;
  const listed = await listCaseWorktrees(repo, { git: taskHooks.git }).catch(() => undefined);
  if (!listed || !listed.ok) return [];
  const named = new Set(tasks.flatMap(({ task }) => (task.isolation.kind === 'worktree' ? [task.isolation.name] : [])));
  const rows: LeftBehindRow[] = [];
  for (const wt of listed.worktrees) {
    if (rows.length >= MAX_LEFT_BEHIND) break;
    if (!wt.managed || !wt.name || !TASK_WORKTREE.test(wt.name)) continue;
    if (named.has(wt.name) || creating.has(`${repo.repoRoot}:${wt.name}`)) continue;
    if (sessionInside(ctx, { casePath: located.casePath, repo }, wt.path)) continue;
    rows.push({
      name: wt.name,
      label: isolationLabel({ kind: 'worktree', name: wt.name, branch: wt.branch ?? '' }),
      ...(wt.branch ? { branch: wt.branch } : {}),
    });
  }
  leftBehindCache.set(workspace.id, { at: Date.now(), rows });
  return rows;
}

/**
 * The task list. `brief` is what a closed list needs for its count: each task's id and state and nothing read from a
 * transcript beyond what settling a state already needs, so it is cheap to ask on every session event.
 */
export async function listTasks(
  ctx: CanvasPort,
  req: FastifyRequest,
  workspaceId: string,
  brief = false
): Promise<Outcome> {
  const file = readConversations(workspaceId);
  if (!file.ok) return ok({ tasks: [], active: 0, cap: MAX_ACTIVE_TASKS, unreadable: file.reason });
  const tasks = tasksOf(file.conversations);
  for (const { c } of tasks) reconcileReplies(ctx, workspaceId, c);
  if (brief) {
    const user = getAuthUser(req);
    const rows = tasks.map(({ c, task }) => {
      const session = ctx.sessions.get(c.sessionId);
      return {
        id: c.id,
        requestId: task.requestId,
        name: task.name,
        createdAt: c.createdAt,
        state: taskStateOf(ctx, c, !session || canAccessOwned(user, session.owner)) ?? 'failed',
      };
    });
    return ok({
      brief: true,
      tasks: rows,
      active: rows.filter((r) => taskActive(r.state)).length,
      cap: MAX_ACTIVE_TASKS,
    });
  }
  const rows = await Promise.all(tasks.map(({ c, task }) => taskRow(ctx, req, c, task)));
  const { readWorkspaces } = await import('../../canvas/workspace-registry.js');
  const workspace = readWorkspaces().find((w) => w.id === workspaceId);
  const left = workspace && tasksPossible(req, workspace) ? await leftBehind(ctx, req, workspace, tasks) : [];
  return ok({
    tasks: rows.sort((a, b) => b.createdAt - a.createdAt),
    active: rows.filter((r) => taskActive(r.state)).length,
    cap: MAX_ACTIVE_TASKS,
    ...(left.length ? { leftBehind: left } : {}),
  });
}
/** Left-behind worktrees are looked for only for the workspace's own owner, the one caller who could remove one. */
const tasksPossible = (req: FastifyRequest, workspace: Workspace): boolean => workspace.owner === ownerFor(req);

type Located =
  | {
      ok: true;
      casePath: string;
      repo: CaseRepository | null;
      /** Why no worktree can be made here, when `repo` is null. */
      why?: NoIsolation;
      dockerRoots: string[];
    }
  | { ok: false; outcome: Outcome };
/**
 * The case folder and, when it is the top of a git repository that has a commit, that repository. `repo: null` is a
 * folder git cannot make a worktree in, with the reason. The folder is probed bounded by the worktree routes' own
 * resolution, and git never runs for a Docker or remote case or inside a Docker workspace.
 */
async function locateCase(req: FastifyRequest, caseName: string): Promise<Located> {
  const folder = await resolveLocalCaseFolder(req, caseName);
  if (!folder.ok) {
    const outcome =
      folder.code === ApiErrorCode.NOT_FOUND
        ? conflict('CASE_MISSING: the case folder does not exist')
        : folder.code === ApiErrorCode.OPERATION_FAILED
          ? conflict('CASE_UNREACHABLE: the case folder is not answering right now; nothing was started')
          : folder.code === ApiErrorCode.FORBIDDEN
            ? refuse(403, ApiErrorCode.FORBIDDEN, 'The case folder is outside your workspace')
            : conflict('CASE_UNSUPPORTED: background tasks are not available for this case');
    return { ok: false, outcome };
  }
  const dockerRoots = await taskHooks.dockerWorkspaces();
  const git = taskHooks.git;
  const repo = await resolveCaseRepository(folder.casePath, { git, dockerWorkspaces: dockerRoots });
  const none = (why: NoIsolation): Located => ({ ok: true, casePath: folder.casePath, repo: null, why, dockerRoots });
  if (repo.ok) {
    // A repository with no commit has nothing a worktree could start from.
    const head = await (git ?? runWorktreeGit)(
      repo.repo.repoRoot,
      ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
      { timeoutMs: 15_000 }
    );
    if (head.spawnError || head.timedOut)
      return {
        ok: false,
        outcome: conflict('ISOLATION_FAILED: git could not read the case folder, so the task could not be isolated'),
      };
    if (head.code !== 0) return none('NO_COMMITS');
    return { ok: true, casePath: folder.casePath, repo: repo.repo, dockerRoots };
  }
  if (repo.code === 'INVALID_INPUT')
    return none(
      /Docker case workspace/.test(repo.message)
        ? 'DOCKER_WORKSPACE'
        : /bare git repository/.test(repo.message)
          ? 'BARE_REPOSITORY'
          : /top of a git repository/.test(repo.message)
            ? 'REPOSITORY_SUBFOLDER'
            : 'NOT_A_REPOSITORY'
    );
  return {
    ok: false,
    outcome: conflict('ISOLATION_FAILED: git could not read the case folder, so the task could not be isolated'),
  };
}

/** A git or worktree failure in words that never carry a server path. */
const withoutPaths = (message: string, located: { casePath: string; repo: CaseRepository | null }, fallback: string) =>
  [located.casePath, located.repo?.repoRoot ?? located.casePath].some((path) => message.includes(path)) ||
  message.includes('/')
    ? fallback
    : message;

/**
 * Removes a task's worktree with the managed, non-force remove. A worktree whose folder and git record are both gone
 * is as good as removed; a folder still there that git no longer knows is not, and is reported `leftover`.
 */
async function removeTaskWorktree(
  ctx: CanvasPort,
  located: { casePath: string; repo: CaseRepository; dockerRoots: string[] },
  name: string
): Promise<{ removed: true; branchKept?: string } | { removed: false; reason: TaskKept }> {
  let inUse = false;
  const removed = await removeCaseWorktree(
    located.repo,
    {
      name,
      deleteBranch: true,
      isInUse: (path) => (inUse = sessionInside(ctx, located, path)),
    },
    { git: taskHooks.git, dockerWorkspaces: located.dockerRoots }
  );
  if (removed.ok)
    return {
      removed: true,
      ...(removed.removed.branch && !removed.removed.branchDeleted ? { branchKept: removed.removed.branch } : {}),
    };
  if (removed.code === 'NOT_FOUND') {
    const kind = await probePathKind(join(located.repo.repoRoot, ...WORKTREES_DIR_SEGMENTS, name), { pastCap: true });
    return kind === 'absent'
      ? { removed: true }
      : { removed: false, reason: kind === 'unknown' ? 'failed' : 'leftover' };
  }
  // git's own refusal carries its words (changes); without them the refusal was a live session or git's lock.
  if (removed.code === 'CONFLICT')
    return { removed: false, reason: removed.gitMessage ? 'changes' : inUse ? 'in-use' : 'locked' };
  return { removed: false, reason: 'failed' };
}

export async function createTask(
  ctx: CanvasPort,
  req: FastifyRequest,
  workspaceId: string,
  input: unknown
): Promise<Outcome> {
  const body = parseBody(CreateTaskBodySchema, input);
  if (agentCaller(req)) return refuse(403, ApiErrorCode.FORBIDDEN, HUMAN_ONLY);
  const workspace = await writeGuard(req, workspaceId);
  if (isOutcome(workspace)) return workspace;
  const text = normalizePrompt(body.text);
  const refusal = promptRefusal(text);
  if (refusal) return refuse(400, ApiErrorCode.INVALID_INPUT, refusal);
  return serialCreate(workspaceId, () => start(ctx, req, workspace, body, text));
}

async function start(
  ctx: CanvasPort,
  req: FastifyRequest,
  workspace: Workspace,
  body: CreateTaskBody,
  text: string
): Promise<Outcome> {
  const file = readConversations(workspace.id);
  if (!file.ok) return conflict('FILE_UNREADABLE: tasks cannot be saved right now; nothing was started');
  const prior = file.conversations.find((c) => c.requestId === body.requestId);
  if (prior) {
    const task = taskPart(prior);
    if (!task) return conflict('REQUEST_REUSED: this request id already started a conversation');
    const first = prior.messages.find((m) => m.messageId === task.messageId);
    if (first && (first.textSha256 !== sha256(text) || first.namedSha256 !== namedHash(body.refIds)))
      return conflict('TASK_CHANGED: this request id already started a task with a different request');
    const row = await taskRow(ctx, req, prior, task);
    if (body.retry !== true || !row.retryable || !first) return ok({ task: row, duplicate: true });
    // The same message id through the conversation send path: it looks at the composer first and never pastes twice.
    const again = await sendMessage(ctx, req, workspace.id, prior.id, {
      messageId: task.messageId,
      text,
      refIds: body.refIds,
    }).catch(() => conflict('NOT_DELIVERED: the request could not be sent'));
    if (again.code >= 400) return again;
    const current = findConversation(workspace.id, prior.id) ?? prior;
    return ok({ task: await taskRow(ctx, req, current, task), duplicate: true, retried: true });
  }
  if (file.conversations.length >= MAX_CONVERSATIONS_PER_WORKSPACE)
    return conflict(`TOO_MANY: a canvas keeps at most ${MAX_CONVERSATIONS_PER_WORKSPACE} conversations and tasks`);
  const launch = await resolveLaunch(body.cliId, body.model);
  if (!('ok' in launch)) return launch;
  if (await caseRunsElsewhere(req, workspace.caseName))
    return conflict('CASE_UNSUPPORTED: background tasks are not available for Docker or remote cases yet');
  const startSession = ctx.startConversationSession;
  if (!startSession) return conflict('Background tasks are not available on this server');
  if (body.origin) {
    const state = (await ctx.canvasStores()).get(workspace.id).read();
    const { objectId, commentId } = body.origin;
    const object = state.objects[objectId];
    if (
      !object ||
      object.deletedAt !== null ||
      !state.comments.some((c) => c.id === commentId && c.objectId === objectId)
    )
      return conflict('ORIGIN_GONE: the comment this request was asked from is no longer on the canvas');
  }

  const located = await locateCase(req, workspace.caseName);
  if (!located.ok) return located.outcome;
  // A git case always gets a worktree; the person's consent to share is asked for, and used, only where none can be
  // made, and the refusal says which of the reasons it is.
  if (!located.repo && body.shared !== true) {
    const why = located.why ?? 'NOT_A_REPOSITORY';
    return conflict(`${why}: ${NO_ISOLATION[why]}`);
  }
  if (activeCount(ctx, file.conversations) >= MAX_ACTIVE_TASKS)
    return conflict(`TOO_MANY_TASKS: at most ${MAX_ACTIVE_TASKS} background tasks run at once on a canvas`);

  let isolation: TaskIsolation = { kind: 'shared' };
  let workingDir = located.casePath;
  let excludeWarning = false;
  const repo = located.repo;
  const worktreeName = taskHooks.worktreeName();
  const marker = repo ? `${repo.repoRoot}:${worktreeName}` : '';
  if (repo) {
    // Held until this attempt has recorded or undone the worktree, so the left-behind list never shows one being made.
    creating.add(marker);
    const made = await createCaseWorktree(
      repo,
      { name: worktreeName },
      {
        git: taskHooks.git,
        dockerWorkspaces: located.dockerRoots,
        agentSkillDirs: registryAgentSkillDirs(),
        // The hooks file and the agent skill copy are what a session start writes into its folder; both lines go
        // into the repository's `info/exclude` whatever the machine's own git ignores say.
        excludeAlways: true,
      }
    ).catch(() => undefined);
    if (!made || !made.ok) {
      creating.delete(marker);
      leftBehindCache.delete(workspace.id);
      const why = made
        ? withoutPaths(made.message, located, 'the worktree for this task could not be created')
        : 'the worktree for this task could not be created';
      return conflict(`WORKTREE_FAILED: ${why}`);
    }
    isolation = { kind: 'worktree', name: made.worktree.name, branch: made.worktree.branch };
    // The case path as the case spells it (a linked case can be a symlink), never the real path git reports: the
    // canvas workspace resolver compares a session's folder with that spelling, and the agent's canvas tools need it.
    workingDir = join(located.casePath, ...WORKTREES_DIR_SEGMENTS, made.worktree.name);
    excludeWarning = made.worktree.warnings.length > 0;
  }
  try {
    return await launchTask(ctx, req, workspace, body, text, {
      located,
      repo,
      isolation,
      workingDir,
      excludeWarning,
      launch,
      startSession,
      parent: file.conversations.some((c) => c.id === body.parentConversationId && !taskPart(c)),
    });
  } finally {
    if (marker) creating.delete(marker);
    leftBehindCache.delete(workspace.id);
  }
}

/** The part of a start after the worktree exists: the session, the record and the request, each undone if a later one fails. */
async function launchTask(
  ctx: CanvasPort,
  req: FastifyRequest,
  workspace: Workspace,
  body: CreateTaskBody,
  text: string,
  made: {
    located: Extract<Located, { ok: true }>;
    repo: CaseRepository | null;
    isolation: TaskIsolation;
    workingDir: string;
    excludeWarning: boolean;
    launch: { entryId: string; model: string; launch: Record<string, unknown> };
    startSession: NonNullable<CanvasPort['startConversationSession']>;
    /** The parent conversation the request named is an ordinary conversation of this workspace. */
    parent: boolean;
  }
): Promise<Outcome> {
  const { located, repo, isolation, workingDir, launch, startSession } = made;
  /** Undoes what this attempt made, newest first; what cannot be undone is named in the answer, never left silent. */
  const undo = async (made: { sessionId?: string; conversationId?: string }): Promise<string> => {
    if (made.conversationId) {
      try {
        removeConversation(workspace.id, made.conversationId);
      } catch {
        /* The record names a session that is deleted below; the list then shows it failed and Remove clears it. */
      }
    }
    if (made.sessionId) await ctx.discardConversationSession?.(req.headers, made.sessionId);
    if (!repo || isolation.kind !== 'worktree') return '';
    const gone = await removeTaskWorktree(ctx, { ...located, repo }, isolation.name).catch(
      () => ({ removed: false }) as const
    );
    return gone.removed ? '' : ` Its worktree was left at ${isolationLabel(isolation)}.`;
  };

  const name = body.name ?? deriveTaskName(text);
  // A start that throws is a start that failed: the worktree it was for is undone like any other failure's.
  const started = await startSession(req.headers, {
    workingDir,
    name: `Task · ${name}`.slice(0, 100),
    mode: launch.entryId,
    launch: launch.launch,
  }).catch(() => ({ ok: false as const, message: 'the session could not be started' }));
  if (!started.ok) {
    const left = await undo({});
    const why = withoutPaths(started.message, located, 'the session could not be started');
    return refuse(409, ApiErrorCode.OPERATION_FAILED, `START_FAILED: ${why}${left}`);
  }
  const messageId = randomUUID();
  const task: TaskPart = {
    name,
    requestId: body.requestId,
    messageId,
    // A parent that is not a conversation of this workspace is not recorded.
    ...(body.parentConversationId && made.parent ? { parentConversationId: body.parentConversationId } : {}),
    isolation,
    ...(made.excludeWarning ? { excludeWarning: true as const } : {}),
  };
  let created: ReturnType<typeof addConversation> | undefined;
  try {
    created = addConversation(
      workspace.id,
      () => ({
        id: randomUUID(),
        sessionId: started.sessionId,
        cliId: launch.entryId,
        ...(launch.model ? { model: launch.model } : {}),
        ...(body.origin ? { origin: body.origin } : {}),
        task,
        createdAt: Date.now(),
        createdBy: ownerFor(req) ?? '@single',
      }),
      body.requestId
    );
  } catch {
    created = undefined;
  }
  if (!created || !created.ok || created.duplicate) {
    const left = await undo({ sessionId: started.sessionId });
    return conflict(`TOO_MANY: the task could not be recorded; nothing was started.${left}`);
  }
  const conversation = created.conversation;
  let sent: Outcome;
  try {
    sent = await sendMessage(ctx, req, workspace.id, conversation.id, {
      messageId,
      text,
      refIds: body.refIds,
      ...(body.origin ? { origin: body.origin } : {}),
    });
  } catch {
    sent = conflict('NOT_DELIVERED: the request could not be sent');
  }
  if (sent.code >= 400) {
    const left = await undo({ sessionId: started.sessionId, conversationId: conversation.id });
    if (!left) return sent;
    const failure = sent.body as { error?: string };
    return refuse(
      sent.code,
      ApiErrorCode.OPERATION_FAILED,
      `${failure.error ?? 'The request could not be sent.'}${left}`
    );
  }
  ctx.broadcast(SseEvent.CanvasConversation, {
    workspaceId: workspace.id,
    conversationId: conversation.id,
    change: 'created',
    owner: workspace.owner,
  });
  const current = findConversation(workspace.id, conversation.id) ?? conversation;
  return ok({ task: await taskRow(ctx, req, current, task), duplicate: false });
}

/** The task a route names, for a person who owns the workspace; an agent caller is refused before anything is read. */
async function locateTask(
  req: FastifyRequest,
  workspaceId: string,
  conversationId: string
): Promise<Outcome | { workspace: Workspace; conversation: Conversation; task: TaskPart }> {
  if (agentCaller(req)) return refuse(403, ApiErrorCode.FORBIDDEN, HUMAN_ONLY);
  const workspace = await writeGuard(req, workspaceId);
  if (isOutcome(workspace)) return workspace;
  const conversation = findConversation(workspaceId, conversationId);
  const task = conversation ? taskPart(conversation) : undefined;
  if (!conversation || !task) return notFound('Task not found');
  return { workspace, conversation, task };
}

export async function cancelTask(
  ctx: CanvasPort,
  req: FastifyRequest,
  workspaceId: string,
  conversationId: string
): Promise<Outcome> {
  const found = await locateTask(req, workspaceId, conversationId);
  if ('code' in found) return found;
  const { workspace, conversation, task } = found;
  const state = taskStateOf(ctx, conversation) ?? 'failed';
  if (state === 'cancelled') return ok({ task: await taskRow(ctx, req, conversation, task), duplicate: true });
  if (!taskActive(state)) return conflict('TASK_FINISHED: this task is no longer running');
  // Ownership as every session route checks it; a session that is gone has nothing to interrupt.
  const session = ctx.sessions.has(conversation.sessionId)
    ? findSessionOrFail({ sessions: ctx.sessions } as unknown as SessionPort, conversation.sessionId, req)
    : undefined;
  // Whether the request was still on its way into the pane when the cancel arrived.
  const first = conversation.messages.find((m) => m.messageId === task.messageId);
  const travelling = !!first && ['queued', 'sending'].includes(messageState(first));
  // Recorded first: from here the delivery writes nothing more, neither the paste nor an Enter.
  setTaskHint(workspaceId, conversationId, { cancelledAt: Date.now() });
  const live =
    session && !ctx.sessions.get(conversation.sessionId)?.paneExit
      ? ctx.sessions.get(conversation.sessionId)
      : undefined;
  const escape = async (): Promise<boolean> => (await live?.writeViaMux?.('\u001b').catch(() => false)) ?? false;
  // The session re-presses Enter by itself for a prompt it wrote with one; that stops too.
  live?.cancelPendingSubmit?.();
  // The session's own interrupt: one Esc, no Enter, to this task's session and no other.
  const interrupted = await escape();
  // A request that was pasted and not yet submitted is still in the composer, where a later Enter would run it.
  const delivery = await deliveryEnded(workspaceId, conversationId, taskTiming.deliveryMs);
  live?.cancelPendingSubmit?.();
  if (live && (delivery.left || !delivery.ended)) {
    const cleared = await clearComposer(live, escape);
    if (cleared !== 'empty') setTaskHint(workspaceId, conversationId, { unsubmitted: true });
  }
  // An Enter that was already on its way when the cancel landed started the turn after the first Esc: interrupt it.
  // Only then: a second Escape to a task that was simply running would land on its idle composer.
  if (live && travelling && (live.hookTurnRunning === true || live.isWorking === true)) await escape();
  ctx.broadcast(SseEvent.CanvasConversation, {
    workspaceId,
    conversationId,
    change: 'task',
    owner: workspace.owner,
  });
  const current = findConversation(workspaceId, conversationId) ?? conversation;
  return ok({
    task: await taskRow(ctx, req, current, taskPart(current) ?? task),
    duplicate: false,
    interrupted,
  });
}

/**
 * Clears a request left in the composer, with Escape and only on evidence: a key goes out only while a fresh read of
 * the screen shows text in the composer, never to an empty one (where a second Escape means something else) and never
 * blind. `empty` is a composer seen empty; `held` is text still there after the last key; `unknown` is a pane with no
 * composer to read.
 */
async function clearComposer(
  session: { mode?: string; paneSnapshot?(styles?: boolean): string | null },
  escape: () => Promise<boolean>
): Promise<'empty' | 'held' | 'unknown'> {
  const glyph = getCli(session.mode ?? 'claude')?.capabilities.workDetect?.promptGlyph ?? '';
  const read = (): boolean | undefined => {
    const screen = session.paneSnapshot?.(true) ?? null;
    return screen === null ? undefined : composerIsEmpty(screen, glyph);
  };
  for (let presses = 0; ; presses++) {
    const empty = read();
    if (empty === undefined) return 'unknown';
    if (empty) return 'empty';
    if (presses >= taskTiming.clearPresses) return 'held';
    await escape();
    await new Promise<void>((resolve) => setTimeout(resolve, taskTiming.clearMs));
  }
}

export async function removeTask(
  ctx: CanvasPort,
  req: FastifyRequest,
  workspaceId: string,
  conversationId: string
): Promise<Outcome> {
  const found = await locateTask(req, workspaceId, conversationId);
  if ('code' in found) return found;
  const { workspace, conversation, task } = found;
  if (taskActive(taskStateOf(ctx, conversation) ?? 'failed'))
    return conflict('TASK_ACTIVE: cancel the task before removing it');
  if (ctx.sessions.has(conversation.sessionId)) {
    findSessionOrFail({ sessions: ctx.sessions } as unknown as SessionPort, conversation.sessionId, req);
    // The result is read from the session's transcript; once the session is gone a kept row would have none.
    const result = await taskResult(ctx, req, conversation, taskStateOf(ctx, conversation)).catch(() => undefined);
    if (result) setTaskHint(workspaceId, conversationId, { result });
    await ctx.discardConversationSession?.(req.headers, conversation.sessionId);
  }
  let kept: TaskKept | undefined;
  let branchKept: string | undefined;
  // A session that would not close keeps the record, whatever the task ran in: it is the only thing that names the session.
  if (ctx.sessions.has(conversation.sessionId)) kept = 'session';
  else if (task.isolation.kind === 'worktree') {
    const located = await locateCase(req, workspace.caseName);
    if (!located.ok || !located.repo) kept = 'failed';
    else {
      const gone = await removeTaskWorktree(ctx, { ...located, repo: located.repo }, task.isolation.name).catch(
        () => ({ removed: false, reason: 'failed' }) as const
      );
      if (gone.removed) branchKept = gone.branchKept;
      else kept = gone.reason;
    }
  }
  leftBehindCache.delete(workspaceId);
  const announce = (): void =>
    ctx.broadcast(SseEvent.CanvasConversation, {
      workspaceId,
      conversationId,
      change: 'task',
      owner: workspace.owner,
    });
  if (kept) {
    setTaskHint(workspaceId, conversationId, { removedAt: task.removedAt ?? Date.now(), kept });
    announce();
    const current = findConversation(workspaceId, conversationId) ?? conversation;
    return ok({
      removed: false,
      kept: { label: isolationLabel(task.isolation), reason: kept },
      task: await taskRow(ctx, req, current, taskPart(current) ?? task),
    });
  }
  removeConversation(workspaceId, conversationId);
  announce();
  return ok({ removed: true, ...(branchKept ? { branchKept } : {}) });
}

/**
 * Removes one left-behind worktree: a name this subsystem generated, that no task record names, with no live session
 * inside, by the same non-force remove as a task's. Runs in the create queue, so it never meets a start that is
 * between making a worktree and recording it.
 */
export async function removeLeftBehind(
  ctx: CanvasPort,
  req: FastifyRequest,
  workspaceId: string,
  name: string
): Promise<Outcome> {
  if (agentCaller(req)) return refuse(403, ApiErrorCode.FORBIDDEN, HUMAN_ONLY);
  const workspace = await writeGuard(req, workspaceId);
  if (isOutcome(workspace)) return workspace;
  if (!TASK_WORKTREE.test(name)) return notFound('Worktree not found');
  return serialCreate(workspaceId, async () => {
    const file = readConversations(workspaceId);
    if (!file.ok) return conflict('FILE_UNREADABLE: tasks cannot be read right now; nothing was removed');
    if (
      tasksOf(file.conversations).some(({ task }) => task.isolation.kind === 'worktree' && task.isolation.name === name)
    )
      return conflict('TASK_LISTED: a task still names this worktree; remove the task instead');
    const located = await locateCase(req, workspace.caseName);
    if (!located.ok) return located.outcome;
    if (!located.repo) return notFound('Worktree not found');
    const gone = await removeTaskWorktree(ctx, { ...located, repo: located.repo }, name).catch(
      () => ({ removed: false, reason: 'failed' }) as const
    );
    leftBehindCache.delete(workspaceId);
    ctx.broadcast(SseEvent.CanvasConversation, { workspaceId, change: 'task', owner: workspace.owner });
    const label = isolationLabel({ kind: 'worktree', name, branch: '' });
    return gone.removed
      ? ok({ removed: true, ...(gone.branchKept ? { branchKept: gone.branchKept } : {}) })
      : ok({ removed: false, kept: { label, reason: gone.reason } });
  });
}

export function registerTaskRoutes(scope: FastifyInstance, ctx: CanvasPort): void {
  const params = z.object({ workspaceId: z.string(), conversationId: z.uuid() });
  scope.get<{ Params: { workspaceId: string }; Querystring: { brief?: string } }>(
    '/api/canvas/:workspaceId/tasks',
    async (req, reply) => {
      const outcome = await listTasks(ctx, req, req.params.workspaceId, req.query.brief === '1');
      return reply.code(outcome.code).send(outcome.body);
    }
  );
  scope.delete<{ Params: { workspaceId: string; name: string } }>(
    '/api/canvas/:workspaceId/tasks/left-behind/:name',
    async (req, reply) => {
      const outcome = await removeLeftBehind(ctx, req, req.params.workspaceId, req.params.name);
      return reply.code(outcome.code).send(outcome.body);
    }
  );
  scope.post<{ Params: { workspaceId: string } }>(
    '/api/canvas/:workspaceId/tasks',
    { bodyLimit: 64 * 1024 },
    async (req, reply) => {
      const outcome = await createTask(ctx, req, req.params.workspaceId, req.body);
      return reply.code(outcome.code).send(outcome.body);
    }
  );
  scope.post('/api/canvas/:workspaceId/tasks/:conversationId/cancel', { bodyLimit: 1024 }, async (req, reply) => {
    const p = params.parse(req.params);
    const outcome = await cancelTask(ctx, req, p.workspaceId, p.conversationId);
    return reply.code(outcome.code).send(outcome.body);
  });
  scope.delete('/api/canvas/:workspaceId/tasks/:conversationId', async (req, reply) => {
    const p = params.parse(req.params);
    const outcome = await removeTask(ctx, req, p.workspaceId, p.conversationId);
    return reply.code(outcome.code).send(outcome.body);
  });
}
