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
 *
 * A task's state is never stored: `deriveTaskState()` reads it from the message's delivery state, the recorded cancel
 * and turn end, the approvals inbox and the session. No answer carries a server path; a worktree is named by its
 * place inside the case folder.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
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
  removeCaseWorktree,
  resolveCaseRepository,
  respellUnder,
  type CaseRepository,
  type WorktreeGitRunner,
} from '../../git-worktrees.js';
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
  taskActive,
  taskPart,
  type CreateTaskBody,
  type TaskIsolation,
  type TaskKept,
  type TaskPart,
  type TaskRow,
} from '../../canvas/tasks.js';
import type { Workspace } from '../../canvas/workspace-registry.js';
import {
  caseRunsElsewhere,
  conflict,
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

const HUMAN_ONLY =
  'A background task starts an agent session, so only a person can start, cancel or remove one. Ask the person to do it from the canvas.';
const agentCaller = (req: FastifyRequest): boolean => req.canvasAuthor?.kind === 'agent';

/** One list row. `canSee` is false for a session the caller may not read; its task then reads as gone. */
async function taskRow(ctx: CanvasPort, req: FastifyRequest, c: Conversation, task: TaskPart): Promise<TaskRow> {
  const session = ctx.sessions.get(c.sessionId);
  const visible = !session || canAccessOwned(getAuthUser(req), session.owner);
  const message = c.messages.find((m) => m.messageId === task.messageId);
  const origin = message ? threadOrigin(message) : undefined;
  const result = await taskResult(ctx, req, c);
  return {
    id: c.id,
    requestId: task.requestId,
    name: task.name,
    sessionId: c.sessionId,
    cliId: c.cliId,
    cliLabel: getCli(c.cliId)?.label ?? c.cliId,
    ...(c.model ? { model: c.model } : {}),
    createdAt: c.createdAt,
    state: taskStateOf(ctx, c, visible) ?? 'failed',
    isolation: {
      kind: task.isolation.kind,
      label: isolationLabel(task.isolation),
      ...(task.isolation.kind === 'worktree' ? { branch: task.isolation.branch } : {}),
    },
    ...(result ? { result } : {}),
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

export async function listTasks(ctx: CanvasPort, req: FastifyRequest, workspaceId: string): Promise<Outcome> {
  const file = readConversations(workspaceId);
  if (!file.ok) return ok({ tasks: [], active: 0, cap: MAX_ACTIVE_TASKS, unreadable: file.reason });
  const tasks = tasksOf(file.conversations);
  for (const { c } of tasks) reconcileReplies(ctx, workspaceId, c);
  const rows = await Promise.all(tasks.map(({ c, task }) => taskRow(ctx, req, c, task)));
  return ok({
    tasks: rows.sort((a, b) => b.createdAt - a.createdAt),
    active: rows.filter((r) => taskActive(r.state)).length,
    cap: MAX_ACTIVE_TASKS,
  });
}

type Located =
  | { ok: true; casePath: string; repo: CaseRepository | null; dockerRoots: string[] }
  | { ok: false; outcome: Outcome };
/**
 * The case folder and, when it is the top of a git repository, that repository. `repo: null` is a folder git cannot
 * make a worktree in. The folder is probed bounded by the worktree routes' own resolution, and git never runs for a
 * Docker or remote case.
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
  const repo = await resolveCaseRepository(folder.casePath, { git: taskHooks.git, dockerWorkspaces: dockerRoots });
  if (repo.ok) return { ok: true, casePath: folder.casePath, repo: repo.repo, dockerRoots };
  if (repo.code === 'INVALID_INPUT') return { ok: true, casePath: folder.casePath, repo: null, dockerRoots };
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

/** Removes a task's worktree with the managed, non-force remove. A worktree git no longer knows is as good as removed. */
async function removeTaskWorktree(
  ctx: CanvasPort,
  located: { casePath: string; repo: CaseRepository; dockerRoots: string[] },
  name: string
): Promise<{ removed: true; branchKept?: string } | { removed: false; reason: TaskKept }> {
  const removed = await removeCaseWorktree(
    located.repo,
    {
      name,
      deleteBranch: true,
      isInUse: (path) =>
        [...ctx.sessions.values()].some(
          (s) =>
            typeof s.workingDir === 'string' &&
            s.workingDir.startsWith('/') &&
            isPathWithin(respellUnder(s.workingDir, located.casePath, located.repo.repoRoot), path)
        ),
    },
    { git: taskHooks.git, dockerWorkspaces: located.dockerRoots }
  );
  if (removed.ok)
    return {
      removed: true,
      ...(removed.removed.branch && !removed.removed.branchDeleted ? { branchKept: removed.removed.branch } : {}),
    };
  if (removed.code === 'NOT_FOUND') return { removed: true };
  if (removed.code === 'CONFLICT') return { removed: false, reason: removed.gitMessage ? 'changes' : 'in-use' };
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
    return ok({ task: await taskRow(ctx, req, prior, task), duplicate: true });
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
  // A git case always gets a worktree; the person's consent to share is asked for, and used, only where none can be made.
  if (!located.repo && body.shared !== true)
    return conflict(
      'NOT_A_REPOSITORY: this case folder is not a git repository, so a background task cannot get a checkout of its own'
    );
  if (activeCount(ctx, file.conversations) >= MAX_ACTIVE_TASKS)
    return conflict(`TOO_MANY_TASKS: at most ${MAX_ACTIVE_TASKS} background tasks run at once on a canvas`);

  let isolation: TaskIsolation = { kind: 'shared' };
  let workingDir = located.casePath;
  const repo = located.repo;
  if (repo) {
    const made = await createCaseWorktree(
      repo,
      { name: taskHooks.worktreeName() },
      { git: taskHooks.git, dockerWorkspaces: located.dockerRoots, agentSkillDirs: registryAgentSkillDirs() }
    );
    if (!made.ok)
      return conflict(
        `WORKTREE_FAILED: ${withoutPaths(made.message, located, 'the worktree for this task could not be created')}`
      );
    isolation = { kind: 'worktree', name: made.worktree.name, branch: made.worktree.branch };
    workingDir = made.worktree.path;
  }
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
  const started = await startSession(req.headers, {
    workingDir,
    name: `Task · ${name}`.slice(0, 100),
    mode: launch.entryId,
    launch: launch.launch,
  });
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
    ...(body.parentConversationId ? { parentConversationId: body.parentConversationId } : {}),
    isolation,
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
  // Recorded first, so a request still waiting to be written is never pasted after the cancel.
  setTaskHint(workspaceId, conversationId, { cancelledAt: Date.now() });
  // The session's own interrupt: one Esc, no Enter, to this task's session and no other.
  const live = ctx.sessions.get(conversation.sessionId);
  const interrupted =
    session && live && !live.paneExit ? ((await live.writeViaMux?.('\u001b').catch(() => false)) ?? false) : false;
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
    await ctx.discardConversationSession?.(req.headers, conversation.sessionId);
  }
  let kept: TaskKept | undefined;
  let branchKept: string | undefined;
  if (task.isolation.kind === 'worktree') {
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

export function registerTaskRoutes(scope: FastifyInstance, ctx: CanvasPort): void {
  const params = z.object({ workspaceId: z.string(), conversationId: z.uuid() });
  scope.get<{ Params: { workspaceId: string } }>('/api/canvas/:workspaceId/tasks', async (req, reply) => {
    const outcome = await listTasks(ctx, req, req.params.workspaceId);
    return reply.code(outcome.code).send(outcome.body);
  });
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
