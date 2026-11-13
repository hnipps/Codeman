/** @fileoverview Canvas conversations: a conversation is one real Claude session, started and written through the ordinary session layer. Sending composes the context block server-side, records what was carried (never the text), and pastes the prompt with the session's own write primitive. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CanvasPort, CanvasSession } from '../ports/canvas-port.js';
import type { SessionPort } from '../ports/session-port.js';
import { canAccessOwned, findSessionOrFail, getAuthUser, ownerFor, parseBody } from '../route-helpers.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { deployRole } from '../../deploy-role.js';
import { SseEvent } from '../sse-events.js';
import { approvalInbox } from '../approval-inbox.js';
import { resolveCasePath } from './case-routes.js';
import { resolveContext } from '../../canvas/context-resolve.js';
import { deliver, retryPlan, type DeliveryDeps, type DeliveryResult } from '../../canvas/conversation-delivery.js';
import { SendLimiter } from '../../canvas/send-limit.js';
import { enabledClis, getCli } from '../../config/cli-registry/registry.js';
import { isCliEntryInstalled, probeStockCliAvailability } from '../../utils/cli-installed-probes.js';
import {
  DEFAULT_CONVERSATION_CLI,
  launchFields,
  modelIdRefusal,
  providerRows,
  type ProviderRow,
} from '../../canvas/providers.js';
import { getDataDir } from '../../config/instance.js';
import { readDockerCases } from '../../docker-hosts.js';
import { readRemoteCases } from '../../remote-hosts.js';
import {
  byteLength,
  ConversationToolSchema,
  CreateConversationBodySchema,
  MAX_COMPOSED_BYTES,
  MAX_CONVERSATIONS_PER_WORKSPACE,
  normalizePrompt,
  promptRefusal,
  SendBodySchema,
  replyExtendable,
  threadOrigin,
  threadReply,
  type Conversation,
  type ConversationMessage,
  type PostedThreadReply,
  type ReplyDrop,
  type ThreadOrigin,
  type ThreadReply,
} from '../../canvas/conversation-schema.js';
import {
  cutReply,
  extractReply,
  MAX_REPLY_PARTS,
  REPLY_MORE_NOTE,
  REPLY_SHARED_NOTE,
  replyPartId,
} from '../../canvas/thread-reply.js';
import { commentCommand } from '../../canvas/commands.js';
import {
  addConversation,
  findConversation,
  messageState,
  setMessageState,
  setMessageSubmitted,
  namedHash,
  readConversations,
  recordMessage,
  setMessageReply,
  setTaskHint,
  sha256,
} from '../../canvas/conversations.js';
import { cutResult, deriveTaskState, isolationLabel, taskPart, type TaskState } from '../../canvas/tasks.js';
import type { Author } from '../../canvas/model.js';
import {
  AGENT_START_REFUSALS,
  agentStartedAncestor,
  agentStartRefusal,
  startedBy,
  type StartedBy,
} from '../../canvas/agent-start.js';
import type { Workspace } from '../../canvas/workspace-registry.js';

export type Outcome = { code: number; body: unknown };
export const ok = (data: unknown): Outcome => ({ code: 200, body: { success: true, data } });
export const refuse = (code: number, errorCode: ApiErrorCode, message: string): Outcome => ({
  code,
  body: createErrorResponse(errorCode, message),
});
export const conflict = (message: string): Outcome => refuse(409, ApiErrorCode.CONFLICT, message);
export const notFound = (message: string): Outcome => refuse(404, ApiErrorCode.NOT_FOUND, message);

/** Writes need the live colour, and only the workspace's own owner may start or message a conversation. */
export async function writeGuard(req: FastifyRequest, workspaceId: string): Promise<Outcome | Workspace> {
  if (!deployRole.allows('persist')) return conflict('Only the live colour may write canvas data');
  const { readWorkspaces } = await import('../../canvas/workspace-registry.js');
  const workspace = readWorkspaces().find((w) => w.id === workspaceId);
  if (!workspace || workspace.owner !== ownerFor(req)) return notFound('Workspace not found');
  return workspace;
}
export const isOutcome = (value: Outcome | Workspace): value is Outcome => 'code' in value;

/** Session state as the rail shows it. A session that ended is still a conversation; it just cannot take messages. */
function sessionState(ctx: CanvasPort, req: FastifyRequest, sessionId: string): 'live' | 'ended' {
  const session = ctx.sessions.get(sessionId);
  if (!session || !canAccessOwned(getAuthUser(req), session.owner)) return 'ended';
  return session.paneExit ? 'ended' : 'live';
}
const sessionBusy = (session: { hookTurnRunning?: boolean; isWorking?: boolean } | undefined): boolean =>
  session?.hookTurnRunning === true || session?.isWorking === true;
/** A task's state from what the server holds now. `canSee` is false for a session the caller may not read, which is then as good as gone. */
export function taskStateOf(ctx: CanvasPort, c: Conversation, canSee = true): TaskState | undefined {
  const task = taskPart(c);
  if (!task) return undefined;
  const session = canSee ? ctx.sessions.get(c.sessionId) : undefined;
  const message = c.messages.find((m) => m.messageId === task.messageId);
  const pending = session ? approvalInbox.getForSession(session.id) : undefined;
  return deriveTaskState({
    cancelledAt: task.cancelledAt,
    completedAt: task.completedAt,
    message: message ? messageState(message) : 'none',
    session: !session ? 'gone' : session.paneExit ? 'exited' : 'live',
    approval: !!pending && pending.kind !== 'idle',
    working: sessionBusy(session),
  });
}
/** The agent left its pane and nothing says it left cleanly: an exit status other than 0, a signal, or no status at all. */
const exitedAbnormally = (paneExit: unknown): boolean => {
  if (!paneExit) return false;
  const exit = paneExit as { status?: unknown; signal?: unknown };
  return exit.status !== 0 || exit.signal !== undefined;
};
export const summary = (ctx: CanvasPort, req: FastifyRequest, c: Conversation) => {
  const origin = threadOrigin(c);
  const requests = threadRequests(c);
  const task = taskPart(c);
  const visible = canAccessOwned(getAuthUser(req), ctx.sessions.get(c.sessionId)?.owner);
  return {
    id: c.id,
    sessionId: c.sessionId,
    cliId: c.cliId,
    cliLabel: getCli(c.cliId)?.label ?? c.cliId,
    ...(c.model ? { model: c.model } : {}),
    ...(c.title ? { title: c.title } : {}),
    createdAt: c.createdAt,
    createdBy: c.createdBy,
    ...(startedBy(c) ? { startedBy: startedBy(c) } : {}),
    messageCount: c.messages.length,
    session: sessionState(ctx, req, c.sessionId),
    working: sessionBusy(ctx.sessions.get(c.sessionId)),
    ...(origin ? { origin } : {}),
    ...(requests.length ? { requests } : {}),
    ...(task
      ? {
          task: {
            name: task.name,
            state: taskStateOf(ctx, c, visible),
            isolation: isolationLabel(task.isolation),
            ...(task.removedAt !== undefined ? { removed: true } : {}),
          },
        }
      : {}),
  };
};
/** The requests a conversation took from comment threads: what a thread needs to show a request's state without the transcript. */
const threadRequests = (c: Conversation) =>
  c.messages.flatMap((m) => {
    const origin = threadOrigin(m);
    if (!origin) return [];
    const reply = threadReply(m);
    return [
      {
        messageId: m.messageId,
        objectId: origin.objectId,
        commentId: origin.commentId,
        state: messageState(m),
        ...(reply && reply !== 'unknown'
          ? {
              reply:
                'commentId' in reply
                  ? { commentId: reply.commentId, postedAt: reply.postedAt, parts: reply.parts ?? 1 }
                  : reply,
            }
          : {}),
      },
    ];
  });

export function listConversations(ctx: CanvasPort, req: FastifyRequest, workspaceId: string): Outcome {
  const file = readConversations(workspaceId);
  if (!file.ok) return ok({ conversations: [], unreadable: file.reason });
  for (const c of file.conversations) reconcileReplies(ctx, workspaceId, c);
  return ok({ conversations: file.conversations.map((c) => summary(ctx, req, c)) });
}
export async function readConversation(
  ctx: CanvasPort,
  req: FastifyRequest,
  workspaceId: string,
  id: string
): Promise<Outcome> {
  const conversation = findConversation(workspaceId, id);
  if (!conversation) return notFound('Conversation not found');
  reconcileReplies(ctx, workspaceId, conversation);
  const view = summary(ctx, req, conversation);
  const result = view.task ? await taskResult(ctx, req, conversation, view.task.state) : undefined;
  return ok({
    conversation: {
      ...view,
      ...(view.task && result ? { task: { ...view.task, result } } : {}),
      messages: conversation.messages,
    },
  });
}
/** Result texts already cut for the list, by conversation and by what they were read from, so an unchanged transcript is not read again. */
const results = new Map<string, { stamp: string; result: TaskResultText }>();
const MAX_RESULTS = 200;
type TaskResultText = { text: string; truncated: boolean; partial?: true };
/**
 * A task's result: the reply to its own message, read from the session's transcript the way a thread reply is.
 * A completed task has its reply; a task that failed because its agent exited mid-turn has what was written by then,
 * marked `partial`. Nothing for any other state (a task running again is not shown an old result), a session the
 * caller may not read, or a transcript that is gone. Where the transcript has no stamp the text is kept by the
 * recorded turn end (or the exit), which is when it last could have changed.
 */
export async function taskResult(
  ctx: CanvasPort,
  req: FastifyRequest,
  c: Conversation,
  state: TaskState | undefined
): Promise<TaskResultText | undefined> {
  const task = taskPart(c);
  const session = ctx.sessions.get(c.sessionId);
  if (!task || !session || !ctx.transcriptRows) return undefined;
  const exit = session.paneExit as { at?: unknown } | undefined;
  const partial = state === 'failed' && !!exit && task.completedAt === undefined;
  if (!(state === 'completed' && task.completedAt !== undefined) && !partial) return undefined;
  if (partial && c.messages.find((m) => m.messageId === task.messageId)?.deliveredAt == null) return undefined;
  if (!canAccessOwned(getAuthUser(req), session.owner)) return undefined;
  const fileStamp = (await ctx.transcriptStamp?.(session.id).catch(() => null)) ?? null;
  const stamp = `${fileStamp ?? ''}|${partial ? `exit:${String(exit?.at ?? '')}` : `done:${task.completedAt}`}`;
  const cached = results.get(c.id);
  if (cached?.stamp === stamp) return cached.result;
  const rows = await ctx.transcriptRows(session.id).catch(() => null);
  if (!rows) return undefined;
  const found = extractReply(rows, task.messageId);
  if (!found.found || (partial && !found.text)) return undefined;
  const result: TaskResultText = { ...cutResult(found.text), ...(partial ? { partial: true as const } : {}) };
  results.delete(c.id);
  results.set(c.id, { stamp, result });
  for (const oldest of results.keys()) {
    if (results.size <= MAX_RESULTS) break;
    results.delete(oldest);
  }
  return result;
}

const awaitsReply = (m: ConversationMessage): boolean => {
  if (threadOrigin(m) === undefined || messageState(m) !== 'delivered') return false;
  const reply = threadReply(m);
  return reply === undefined || replyExtendable(reply);
};
/** A task's own message whose turn end is not recorded yet: settled by the same rule as a thread reply. */
const taskPending = (c: Conversation, m: ConversationMessage): boolean => {
  const task = taskPart(c);
  return (
    !!task &&
    task.messageId === m.messageId &&
    task.completedAt === undefined &&
    task.cancelledAt === undefined &&
    task.removedAt === undefined
  );
};
const awaitsResult = (c: Conversation, m: ConversationMessage): boolean =>
  taskPending(c, m) && messageState(m) === 'delivered';
/** Asked from a thread, or a task's request, and still on its way into the pane: its turn can end before the delivery is confirmed. */
const beingDelivered = (c: Conversation, m: ConversationMessage): boolean =>
  ((threadOrigin(m) !== undefined && threadReply(m) === undefined) || taskPending(c, m)) &&
  ['queued', 'sending'].includes(messageState(m));
const textHash = (text: string): string => sha256(text).slice(0, 32);
/** Timing of reply routing; a test shortens it. */
export const replyRouting = {
  /** The transcript is read twice this far apart and a reply is posted only when both reads agree. */
  settleDelayMs: 1_500,
  /** After a stop that found the session still working, routing is tried again this long after each try. */
  retryDelaysMs: [1_500, 4_000, 10_000, 30_000],
  /** A request whose prompt never appears in the transcript is given up after this long. */
  maxAgeMs: 24 * 60 * 60 * 1000,
  /** A task whose turn end this process never saw settles only once its transcript has not been written for this long. */
  quietMs: 30_000,
};
/**
 * Messages a delivery of THIS process is carrying, as `<workspace>:<conversation>:<message>`. A message recorded
 * `queued` or `sending` that is not here was left by a process that is gone, and nothing will ever move it.
 */
const inFlight = new Set<string>();
const flightKey = (workspaceId: string, conversationId: string, messageId: string): string =>
  `${workspaceId}:${conversationId}:${messageId.toLowerCase()}`;
const orphaned = (workspaceId: string, c: Conversation, m: ConversationMessage): boolean =>
  ['queued', 'sending'].includes(messageState(m)) && !inFlight.has(flightKey(workspaceId, c.id, m.messageId));
/** Reply routing of one workspace runs one conversation at a time, so two signals for the same turn post once. */
const replyChains = new Map<string, Promise<void>>();
const replyRetries = new Set<Promise<void>>();
/** What the last pass over a conversation saw when it settled nothing; an identical state is not read again. */
const idlePasses = new Map<string, string>();
const MAX_IDLE_PASSES = 500;
const rememberIdlePass = (conversationId: string, key: string): void => {
  idlePasses.delete(conversationId);
  idlePasses.set(conversationId, key);
  for (const oldest of idlePasses.keys()) {
    if (idlePasses.size <= MAX_IDLE_PASSES) break;
    idlePasses.delete(oldest);
  }
};
/** Forgets every cached task result (tests). */
export const forgetTaskResults = (): void => results.clear();
/** Resolves when every reply being routed has been (tests). */
export const settleReplies = async (): Promise<void> => {
  while (replyChains.size || replyRetries.size) await Promise.all([...replyChains.values(), ...replyRetries]);
};
/** Forgets every remembered pass, as a restarted process has (tests). */
export const forgetReplyPasses = (): void => idlePasses.clear();
/**
 * Posts the reply of every thread request of this conversation whose turn is provably over into the thread it was
 * asked from. Called when the session's stop hook fires and again whenever the conversation is read. Only the
 * recorded origin decides where a reply goes. A stop that finds the session still working tries again a few times,
 * because idle detection lags the hook and nothing else would run with no browser open.
 */
export function reconcileReplies(
  ctx: CanvasPort,
  workspaceId: string,
  conversation: Conversation,
  retries: number[] = []
): void {
  if (!deployRole.allows('persist') || !ctx.transcriptRows) return;
  if (
    !conversation.messages.some(
      (m) =>
        awaitsReply(m) ||
        awaitsResult(conversation, m) ||
        beingDelivered(conversation, m) ||
        orphaned(workspaceId, conversation, m)
    )
  )
    return;
  const run = () => routeReplies(ctx, workspaceId, conversation.id).catch(() => 'done' as const);
  const job = (replyChains.get(workspaceId) ?? Promise.resolve()).then(run, run);
  const settled = job.then(() => undefined);
  replyChains.set(workspaceId, settled);
  void settled.then(() => {
    if (replyChains.get(workspaceId) === settled) replyChains.delete(workspaceId);
  });
  const [delay, ...later] = retries;
  if (delay === undefined) return;
  const retry: Promise<void> = job.then(async (outcome) => {
    if (outcome !== 'working') return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delay).unref?.();
    });
    const current = findConversation(workspaceId, conversation.id);
    if (current) reconcileReplies(ctx, workspaceId, current, later);
  });
  replyRetries.add(retry);
  void retry.finally(() => replyRetries.delete(retry));
}
type Candidate = {
  message: ConversationMessage;
  /** Absent for a task's request that was not asked from a thread: its turn end is recorded and nothing is posted. */
  origin: ThreadOrigin | undefined;
  result: boolean;
  /** The turn end was not seen by this process; it is inferred from a quiet transcript and an idle screen, for task state only. */
  inferred: boolean;
  text: string;
  shared: boolean;
  prior: PostedThreadReply | undefined;
};
/**
 * `working`: something may settle soon with no further signal (the session is still working, the two reads did not
 * agree, or a reply was posted into a turn that can still add text), so the stop path tries again.
 */
async function routeReplies(ctx: CanvasPort, workspaceId: string, conversationId: string): Promise<'done' | 'working'> {
  let conversation = findConversation(workspaceId, conversationId);
  if (!conversation) return 'done';
  const { readWorkspaces } = await import('../../canvas/workspace-registry.js');
  const owner = readWorkspaces().find((w) => w.id === workspaceId)?.owner;
  const session = ctx.sessions.get(conversation.sessionId);
  let changed = false;
  // A message a process that is gone left on its way in: the transcript says whether the agent took it. Nothing
  // delivers it now, so it is recorded delivered or not delivered, and Retry is the way to send it again.
  const left = conversation.messages.filter((m) => orphaned(workspaceId, conversation!, m));
  if (left.length && session && deployRole.allows('persist')) {
    const rows = session.paneExit ? null : await ctx.transcriptRows?.(session.id).catch(() => null);
    for (const message of left) {
      // A delivery that began while the transcript was read owns the message again.
      if (inFlight.has(flightKey(workspaceId, conversationId, message.messageId))) continue;
      const took = !!rows && extractReply(rows, message.messageId).found;
      try {
        setMessageState(workspaceId, conversationId, message.messageId, took ? 'delivered' : 'failed');
        changed = true;
      } catch {
        /* Tried again on the next pass. */
      }
    }
    conversation = findConversation(workspaceId, conversationId);
    if (!conversation) return 'done';
  }
  const current = conversation;
  const finish = (outcome: 'done' | 'working'): 'done' | 'working' => {
    if (changed) {
      idlePasses.delete(conversationId);
      ctx.broadcast(SseEvent.CanvasConversation, { workspaceId, conversationId, change: 'message', owner });
    }
    return outcome;
  };
  const waiting = current.messages.filter((m) => awaitsReply(m) || awaitsResult(current, m));
  // A stop that came before the delivery was confirmed is looked at again once it is.
  if (!waiting.length) return finish(current.messages.some((m) => beingDelivered(current, m)) ? 'working' : 'done');
  const now = Date.now();
  const expired = (m: ConversationMessage): boolean => now - m.sentAt > replyRouting.maxAgeMs;
  const priorOf = (m: ConversationMessage): PostedThreadReply | undefined => {
    const reply = threadReply(m);
    return replyExtendable(reply) ? reply : undefined;
  };
  const record = (message: ConversationMessage, reply: ThreadReply): void => {
    try {
      changed = setMessageReply(workspaceId, conversationId, message.messageId, reply) || changed;
    } catch {
      /* The comment id is derived from the message id, so the next pass finds the comment and records it then. */
    }
  };
  /** Nothing more is posted for this request: a reply already posted stays as it is, otherwise the reason is kept. */
  const close = (message: ConversationMessage, drop: ReplyDrop): void => {
    if (!awaitsReply(message)) return;
    const prior = priorOf(message);
    record(message, prior ? { ...prior, final: true } : { dropped: drop });
  };
  /** The task's turn is provably over: the one observation its state needs that cannot be derived when it is read. */
  const complete = (): void => {
    try {
      changed = setTaskHint(workspaceId, conversationId, { completedAt: Date.now() }) || changed;
    } catch {
      /* A record that cannot be saved is settled by the next pass. */
    }
  };
  if (!session) {
    // A session this process does not hold may only be late to restore, so nothing is read and only age gives up.
    for (const message of waiting) if (expired(message)) close(message, 'session-ended');
    return finish('done');
  }
  const ended = !!session.paneExit;
  // An agent that left its pane with a failure, a signal or no status did not finish its turn; only a clean exit may have.
  const crashed = exitedAbnormally(session.paneExit);
  const observedAt = ctx.turnEndObservedAt?.(session.id) ?? 0;
  // A turn end this process saw after it began writing the message to the pane: never a flag that is false after a
  // restart, and not the confirmation, which a quick turn can precede.
  const observed = (m: ConversationMessage): boolean => observedAt > (m.submittedAt ?? m.deliveredAt ?? Infinity);
  const busy = (): boolean => sessionBusy(session);
  // The cheap evidence first: a working session's task has nothing to settle, so its transcript, which changes
  // with every line the agent writes, is not read.
  // A thread request is still read: a later prompt can close its turn while the session works on that prompt.
  if (!ended && busy() && !waiting.some((m) => expired(m) || awaitsReply(m)))
    return finish(waiting.some(observed) ? 'working' : 'done');
  // A task whose turn end nobody in this process saw (every task, after a restart) may still be over. That is taken
  // from the screen and the file together: no work on the screen, no question pending, a transcript not written for
  // `quietMs`, and below the prompt row found and two reads that agree. It settles the task's state and posts nothing.
  const unseen = waiting.some((m) => awaitsResult(current, m) && !observed(m));
  let quiet = false;
  if (unseen && !ended && !busy()) {
    const pending = approvalInbox.getForSession(session.id);
    const modifiedAt = (await ctx.transcriptModifiedAt?.(session.id).catch(() => null)) ?? null;
    quiet =
      modifiedAt !== null &&
      now - modifiedAt >= replyRouting.quietMs &&
      !(pending && pending.kind !== 'idle') &&
      session.paneShowsWork?.() === false;
  }
  const stamp = (await ctx.transcriptStamp?.(session.id)) ?? null;
  const key = [
    stamp,
    ended,
    observedAt,
    busy(),
    quiet,
    ...waiting.map((m) => `${m.messageId}:${expired(m)}:${priorOf(m)?.chars ?? ''}`),
  ].join('|');
  if (stamp !== null && idlePasses.get(conversationId) === key) return finish('done');
  const rows = await ctx.transcriptRows?.(session.id);
  if (!rows || !deployRole.allows('persist')) return finish('done');
  const candidates: Candidate[] = [];
  let again = false;
  for (const message of waiting) {
    const asked = awaitsReply(message) ? threadOrigin(message) : undefined;
    const result = awaitsResult(current, message);
    if (!asked && !result) continue;
    const prior = priorOf(message);
    const found = extractReply(rows, message.messageId);
    if (!found.found) {
      if (ended) close(message, 'session-ended');
      else if (expired(message)) close(message, 'timed-out');
      continue;
    }
    const over = found.closed || ended;
    // A task is completed by a turn that closed or a session that did not exit abnormally; a crash leaves it failed.
    const settles = result && (found.closed || !crashed);
    if (!asked && !settles) continue;
    // Where the reply text goes; cleared when there is nothing new to post and only the task's state is left to settle.
    let post = asked;
    if (prior) {
      const posted = prior.chars ?? 0;
      // Text that no longer starts with what was posted cannot be continued without guessing.
      const continues = found.text.length >= posted && textHash(found.text.slice(0, posted)) === prior.hash;
      if (!continues || found.text.length === posted) {
        if (over || expired(message)) close(message, 'no-reply');
        if (!settles) continue;
        post = undefined;
      }
    }
    let inferred = false;
    if (!over) {
      if (!observed(message)) {
        if (!(settles && quiet)) continue;
        inferred = true;
      } else if (busy()) {
        again = true;
        continue;
      }
      // Text may still be on its way to the file; a turn that wrote none is left to the prompt that closes it,
      // except a task settled from a quiet transcript, which has waited long enough for any text to arrive.
      if (!found.text && !inferred) continue;
    }
    if (!found.text && !inferred) {
      // A turn a later prompt closed is over with nothing said; an agent that exited mid-turn is a failure the state derives.
      if (result && found.closed) complete();
      close(message, ended && !found.closed ? 'session-ended' : 'no-reply');
      continue;
    }
    candidates.push({
      message,
      // A turn end that was only inferred never posts into a thread: that waits for one this process sees.
      origin: inferred ? undefined : post,
      result: settles,
      inferred,
      text: found.text,
      shared: found.shared,
      prior,
    });
  }
  if (!candidates.length) {
    if (!changed && stamp !== null && !again) rememberIdlePass(conversationId, key);
    return finish(again ? 'working' : 'done');
  }
  // The stop hook can fire before the last row reaches the file: post only what a second read still says.
  await new Promise<void>((resolve) => setTimeout(resolve, replyRouting.settleDelayMs));
  const second = await ctx.transcriptRows?.(session.id);
  if (!second || !deployRole.allows('persist')) return finish('done');
  for (const { message, origin, result, inferred, text, shared, prior } of candidates) {
    const reread = extractReply(second, message.messageId);
    if (!reread.found || reread.text !== text || reread.shared !== shared) {
      again = true;
      continue;
    }
    const over = reread.closed || !!session.paneExit;
    if (!over && busy()) {
      again = true;
      continue;
    }
    if (inferred && !over && session.paneShowsWork?.() !== false) continue;
    if (result && (reread.closed || !exitedAbnormally(session.paneExit))) complete();
    if (!origin) continue;
    const part = (prior?.parts ?? 0) + 1;
    const last = over || part >= MAX_REPLY_PARTS;
    const added = text.slice(prior?.chars ?? 0).trim();
    const body = added + (shared ? REPLY_SHARED_NOTE : '') + (last && !over ? REPLY_MORE_NOTE : '');
    const progress = { parts: part, chars: text.length, hash: textHash(text), ...(last ? { final: true } : {}) };
    const reply = added
      ? await postReply(ctx, workspaceId, owner, current.sessionId, origin, replyPartId(message.messageId, part), body)
      : null;
    if (!reply) continue;
    if (!prior) record(message, 'commentId' in reply ? { ...reply, ...progress } : reply);
    // A further part that cannot be posted ends the reply where it stands; the first part is still the reply.
    else
      record(
        message,
        'commentId' in reply
          ? { commentId: prior.commentId, postedAt: prior.postedAt, ...progress }
          : { ...prior, final: true }
      );
    // A turn that is still open can add text with no further stop to say so.
    if (!last && 'commentId' in reply) again = true;
  }
  return finish(again ? 'working' : 'done');
}
/**
 * One ordinary `comment` operation authored by the conversation's session. A comment already under this request's id
 * is the reply only when it is on the asked object and written by that session; anything else under the id is not
 * ours and nothing is posted beside it. Null means the attempt failed in passing and a later pass tries again.
 */
async function postReply(
  ctx: CanvasPort,
  workspaceId: string,
  owner: string | undefined,
  sessionId: string,
  origin: ThreadOrigin,
  commentId: string,
  text: string
): Promise<{ commentId: string; postedAt: number } | { dropped: ReplyDrop } | null> {
  try {
    const store = (await ctx.canvasStores()).get(workspaceId);
    const state = store.read();
    const existing = state.comments.find((c) => c.id === commentId);
    if (existing) {
      const ours =
        existing.objectId === origin.objectId &&
        existing.author.kind === 'agent' &&
        existing.author.sessionId === sessionId;
      return ours ? { commentId, postedAt: existing.createdAt } : { dropped: 'refused' };
    }
    const object = state.objects[origin.objectId];
    if (!object || object.deletedAt !== null) return { dropped: 'object-removed' };
    const result = store.appendExpanded(
      [commentCommand({ objectId: origin.objectId, text: cutReply(text), commentId })],
      { kind: 'agent', sessionId }
    );
    if (!result.ok) return { dropped: result.reasons[0]?.code === 'NOT_FOUND' ? 'object-removed' : 'refused' };
    ctx.broadcast(SseEvent.CanvasChanged, { workspaceId, seq: result.seq, owner });
    return { commentId, postedAt: Date.now() };
  } catch {
    return null;
  }
}
/** The session's stop hook fired: route the replies of every conversation that session is. */
export async function conversationTurnEnded(ctx: CanvasPort, sessionId: string): Promise<void> {
  if (!deployRole.allows('persist') || !ctx.transcriptRows || !(await ctx.canvasEnabled())) return;
  const { readWorkspaces } = await import('../../canvas/workspace-registry.js');
  for (const workspace of readWorkspaces()) {
    const file = readConversations(workspace.id);
    if (!file.ok) continue;
    for (const c of file.conversations)
      if (c.sessionId === sessionId) reconcileReplies(ctx, workspace.id, c, replyRouting.retryDelaysMs);
  }
}

/**
 * Sessions this process started for an agent. A removed task's record is gone, but a worker its session spawned may
 * still run; remembering the id keeps that worker below agent-started work. Bounded; a restart forgets it.
 */
const agentStartedHere = new Set<string>();
const MAX_REMEMBERED_AGENT_STARTS = 10_000;
export function noteAgentStarted(sessionId: string): void {
  agentStartedHere.add(sessionId);
  if (agentStartedHere.size > MAX_REMEMBERED_AGENT_STARTS)
    agentStartedHere.delete(agentStartedHere.values().next().value as string);
}
/** Every session an agent started, in any canvas: what the depth rule looks for above a caller. */
async function agentStartedSessions(): Promise<Set<string>> {
  const { readWorkspaces } = await import('../../canvas/workspace-registry.js');
  const found = new Set<string>(agentStartedHere);
  for (const workspace of readWorkspaces()) {
    const file = readConversations(workspace.id);
    if (!file.ok) continue;
    for (const c of file.conversations) if (startedBy(c)) found.add(c.sessionId);
  }
  return found;
}
/**
 * The bounds an agent caller is held to before it starts a conversation or a task: depth one (no start from a session
 * an agent started, or from below one in its spawn chain) and the agents' share of the canvas's places. Undefined for a
 * person and for an agent within bounds; the agent it returns is who the record names as having started the work. Run
 * it inside `serialCreate`, so the count and the add are one step. `agentLive` counts what agents already hold here.
 */
export async function agentStartGate(
  ctx: CanvasPort,
  req: FastifyRequest,
  kind: 'conversation' | 'task',
  agentLive: number
): Promise<Outcome | StartedBy | undefined> {
  const author = req.canvasAuthor;
  if (author?.kind !== 'agent') return undefined;
  const above = agentStartedAncestor(
    author.sessionId,
    (id) => ctx.sessions.get(id)?.parentSessionId,
    await agentStartedSessions()
  );
  const refused = agentStartRefusal({ kind, inLineage: above, agentLive });
  if (refused)
    return refused === 'NESTED_AGENT'
      ? refuse(403, ApiErrorCode.FORBIDDEN, AGENT_START_REFUSALS[refused])
      : conflict(AGENT_START_REFUSALS[refused]);
  return { kind: 'agent', sessionId: author.sessionId };
}
/** A conversation an agent started whose session can still take a message. */
const agentLiveConversation = (ctx: CanvasPort, c: Conversation): boolean => {
  const session = ctx.sessions.get(c.sessionId);
  return !!startedBy(c) && !taskPart(c) && !!session && !session.paneExit;
};

/** Creates in one workspace run one at a time, so the cap check and the add are one step and a retry finds the first's conversation. */
const createChains = new Map<string, Promise<unknown>>();
export async function createConversation(
  ctx: CanvasPort,
  req: FastifyRequest,
  workspaceId: string,
  input: unknown
): Promise<Outcome> {
  const body = parseBody(CreateConversationBodySchema, input);
  // The tool's create carries no origin; an agent reaching the route directly is held to the same.
  if (req.canvasAuthor?.kind === 'agent' && body.origin)
    return refuse(400, ApiErrorCode.INVALID_INPUT, 'An agent cannot start a conversation from a comment thread');
  const workspace = await writeGuard(req, workspaceId);
  if (isOutcome(workspace)) return workspace;
  return serialCreate(workspaceId, () => start(ctx, req, workspace, body));
}
/** Runs one create of a workspace after the ones before it; conversations and background tasks share the queue and its caps. */
export function serialCreate<T>(workspaceId: string, run: () => Promise<T>): Promise<T> {
  const previous = createChains.get(workspaceId) ?? Promise.resolve();
  const work = previous.then(run);
  const tail = work.catch(() => undefined);
  createChains.set(workspaceId, tail);
  void tail.then(() => {
    if (createChains.get(workspaceId) === tail) createChains.delete(workspaceId);
  });
  return work;
}
/** A Docker or remote case runs its agent elsewhere; the plain create route would run Claude on this host instead. */
export async function caseRunsElsewhere(req: FastifyRequest, caseName: string): Promise<boolean> {
  const user = getAuthUser(req);
  const same = (c: { name: string; owner?: string }) => c.name === caseName && canAccessOwned(user, c.owner);
  return (await readDockerCases(getDataDir())).some(same) || (await readRemoteCases(getDataDir())).some(same);
}
/** The enabled, installed agent CLIs a conversation could start on, each with whether it can and why not. */
export async function currentProviders(): Promise<ProviderRow[]> {
  const installed = await probeStockCliAvailability();
  return providerRows(enabledClis(), (entry) => isCliEntryInstalled(entry, installed));
}
/** The refusal for a named provider and model: not listed, cannot start a conversation, or a model it cannot take. Shared by create and the agent's `model set`, so the texts cannot drift. */
export function checkChoice(rows: readonly ProviderRow[], cliId: string, model: string): Outcome | undefined {
  const row = rows.find((r) => r.id === cliId);
  if (!row)
    return refuse(
      400,
      ApiErrorCode.INVALID_INPUT,
      `UNKNOWN_CLI: ${cliId} is not an enabled, installed agent CLI on this server`
    );
  if (!row.available) return conflict(`CLI_UNAVAILABLE: ${row.reason ?? `${row.label} cannot start a conversation`}`);
  if (model !== '' && !row.model.editable)
    return refuse(400, ApiErrorCode.INVALID_INPUT, `INVALID_MODEL: ${row.model.reason ?? 'no model choice'}`);
  const bad = modelIdRefusal(row.model.source, model);
  return bad ? refuse(400, ApiErrorCode.INVALID_INPUT, `INVALID_MODEL: ${bad}`) : undefined;
}
/**
 * Which CLI and launch fields a create request means. A request naming no CLI is what every conversation was before
 * the choice existed: it is not probed for installation, but the default CLI must still be enabled in the registry.
 * One that names a CLI must name an enabled, installed agent that delivery can confirm, and a model id that CLI's
 * launch accepts. Refusals are stated, never replaced by another CLI.
 */
export async function resolveLaunch(
  cliId: string | undefined,
  model: string | undefined
): Promise<{ ok: true; entryId: string; model: string; launch: Record<string, unknown> } | Outcome> {
  const wanted = model ?? '';
  if (cliId !== undefined) {
    const refused = checkChoice(await currentProviders(), cliId, wanted);
    if (refused) return refused;
  }
  const entry = cliId === undefined ? enabledClis().find((e) => e.id === DEFAULT_CONVERSATION_CLI) : getCli(cliId);
  if (!entry)
    return cliId === undefined
      ? conflict('CLI_UNAVAILABLE: the default CLI is not enabled on this server')
      : refuse(400, ApiErrorCode.INVALID_INPUT, 'UNKNOWN_CLI: the default CLI is not available');
  const fields = launchFields(entry, wanted);
  if (!fields.ok) return refuse(400, ApiErrorCode.INVALID_INPUT, `INVALID_MODEL: ${fields.reason}`);
  return { ok: true, entryId: entry.id as string, model: wanted, launch: fields.fields };
}
async function start(
  ctx: CanvasPort,
  req: FastifyRequest,
  workspace: Workspace,
  body: z.infer<typeof CreateConversationBodySchema>
): Promise<Outcome> {
  const { requestId } = body;
  const file = readConversations(workspace.id);
  if (!file.ok) return conflict('FILE_UNREADABLE: conversations cannot be saved right now; nothing was started');
  const prior = file.conversations.find((c) => c.requestId === requestId);
  if (prior) return ok({ conversation: summary(ctx, req, prior), duplicate: true });
  if (file.conversations.length >= MAX_CONVERSATIONS_PER_WORKSPACE)
    return conflict(`TOO_MANY: a canvas keeps at most ${MAX_CONVERSATIONS_PER_WORKSPACE} conversations`);
  const agent = await agentStartGate(
    ctx,
    req,
    'conversation',
    file.conversations.filter((c) => agentLiveConversation(ctx, c)).length
  );
  if (agent && 'code' in agent) return agent;
  const launch = await resolveLaunch(body.cliId, body.model);
  if (!('ok' in launch)) return launch;
  if (await caseRunsElsewhere(req, workspace.caseName))
    return conflict('CASE_UNSUPPORTED: conversations are not available for Docker or remote cases yet');
  if (!ctx.startConversationSession) return conflict('Conversations are not available on this server');
  const workingDir = await resolveCasePath(workspace.caseName, getAuthUser(req));
  const started = await ctx.startConversationSession(req.headers, {
    workingDir,
    name: `Canvas · ${workspace.caseName}`.slice(0, 100),
    mode: launch.entryId,
    launch: launch.launch,
    ...(agent ? { parentSessionId: agent.sessionId } : {}),
  });
  if (!started.ok) return refuse(409, ApiErrorCode.OPERATION_FAILED, `START_FAILED: ${started.message}`);
  if (agent) noteAgentStarted(started.sessionId);
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
        ...(agent ? { startedBy: agent } : {}),
        createdAt: Date.now(),
        createdBy: ownerFor(req) ?? '@single',
      }),
      requestId
    );
  } catch {
    created = undefined;
  }
  if (!created || !created.ok || created.duplicate) {
    // The session exists but nothing records it; leaving it would strand a tab nobody asked for.
    await ctx.discardConversationSession?.(req.headers, started.sessionId);
    if (created?.ok) return ok({ conversation: summary(ctx, req, created.conversation), duplicate: true });
    return conflict('TOO_MANY: the conversation could not be recorded; nothing was started');
  }
  ctx.broadcast(SseEvent.CanvasConversation, {
    workspaceId: workspace.id,
    conversationId: created.conversation.id,
    change: 'created',
    owner: workspace.owner,
  });
  return ok({ conversation: summary(ctx, req, created.conversation), duplicate: false });
}

const limiter = new SendLimiter();
/** Deliveries of one conversation run one at a time, in the order sent. */
const chains = new Map<string, Promise<void>>();
/** Conversations whose last message may still sit unsubmitted in the composer: nothing is pasted behind it until it is retried. */
const stuck = new Set<string>();
/** Resolves when every delivery in flight has finished (tests). */
export const settleDeliveries = async (): Promise<void> => {
  while (chains.size) await Promise.all([...chains.values()]);
};
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/**
 * Waits, at most `maxMs`, for the deliveries of one conversation to end. `left` says a pasted prompt may still sit in
 * the composer (it timed out or was abandoned after the paste).
 */
export async function deliveryEnded(
  workspaceId: string,
  conversationId: string,
  maxMs: number
): Promise<{ ended: boolean; left: boolean }> {
  const key = `${workspaceId}:${conversationId}`;
  const job = chains.get(key);
  const ended = job ? await Promise.race([job.then(() => true), delay(maxMs).then(() => false)]) : true;
  return { ended, left: stuck.has(key) };
}

function deliveryDeps(session: CanvasSession, composed: string): DeliveryDeps {
  const capabilities = getCli(session.mode ?? 'claude')?.capabilities;
  return {
    snapshot: () => session.paneSnapshot?.(true) ?? null,
    paste: async () => (await session.writeViaMux?.(composed + '\r', { fromUser: true }).catch(() => false)) ?? false,
    enter: async () => (await session.writeViaMux?.('\r').catch(() => false)) ?? false,
    hookAt: () => session.hookPromptSubmittedAt ?? 0,
    glyph: capabilities?.workDetect?.promptGlyph ?? '',
    readyMark: capabilities?.composerReadyMark ?? '',
    now: Date.now,
    sleep: delay,
  };
}
function enqueue(
  ctx: CanvasPort,
  workspace: Workspace,
  conversation: Conversation,
  session: CanvasSession,
  message: ConversationMessage,
  composed: string,
  retry: boolean
): void {
  const key = `${workspace.id}:${conversation.id}`;
  const announce = () =>
    ctx.broadcast(SseEvent.CanvasConversation, {
      workspaceId: workspace.id,
      conversationId: conversation.id,
      change: 'message',
      owner: workspace.owner,
    });
  const set = (state: Parameters<typeof setMessageState>[3], at?: number) => {
    try {
      setMessageState(workspace.id, conversation.id, message.messageId, state, at);
    } catch {
      /* A record that cannot be saved must not change what the person is told about a write that happened. */
    }
    announce();
  };
  const flight = flightKey(workspace.id, conversation.id, message.messageId);
  inFlight.add(flight);
  const run = async (): Promise<void> => {
    // A newer message never goes in behind one that may still be sitting in the composer.
    if (!retry && stuck.has(key)) return set('failed');
    // A task cancelled while its request waited is never written to the pane.
    const cancelled = (): boolean => {
      const current = findConversation(workspace.id, conversation.id);
      return current !== undefined && taskPart(current)?.cancelledAt !== undefined;
    };
    if (cancelled()) return set('failed');
    set('sending');
    const base = deliveryDeps(session, composed);
    const deps: DeliveryDeps = {
      ...base,
      paste: async () => (cancelled() ? false : base.paste()),
      abandoned: cancelled,
    };
    let result: DeliveryResult;
    try {
      const plan = retry ? retryPlan(deps.snapshot(), deps.glyph, deps.hookAt(), message.sentAt) : ('paste' as const);
      // A retry that writes again starts its turn now; one the pane already took keeps the time of the first write.
      if (retry && plan !== 'confirmed')
        setMessageSubmitted(workspace.id, conversation.id, message.messageId, Date.now());
      result =
        plan === 'confirmed'
          ? 'confirmed'
          : await deliver(deps, plan === 'enter-only' ? 'enter-only' : 'paste', message.sentAt);
    } catch {
      result = 'timeout';
    }
    if (result === 'confirmed' || result === 'unverified') {
      stuck.delete(key);
      set('delivered', Date.now());
      // The turn may already be over: a quick one ends before its delivery is confirmed.
      const current = findConversation(workspace.id, conversation.id);
      if (current) reconcileReplies(ctx, workspace.id, current, replyRouting.retryDelaysMs);
      return;
    }
    // Only a paste that was written and never taken leaves text behind; a refused or never-ready one wrote nothing.
    if (result === 'timeout' || result === 'abandoned') stuck.add(key);
    set('failed');
  };
  const done = (): void => void inFlight.delete(flight);
  const job = (chains.get(key) ?? Promise.resolve())
    .then(run, run)
    .catch(() => undefined)
    .finally(done);
  chains.set(key, job);
  void job.then(() => {
    if (chains.get(key) === job) chains.delete(key);
  });
}

export async function sendMessage(
  ctx: CanvasPort,
  req: FastifyRequest,
  workspaceId: string,
  conversationId: string,
  input: unknown,
  /** The request a task carries, sent by the create that just passed `agentStartGate` for this caller. */
  taskStart = false
): Promise<Outcome> {
  const body = parseBody(SendBodySchema, input);
  const workspace = await writeGuard(req, workspaceId);
  if (isOutcome(workspace)) return workspace;
  const conversation = findConversation(workspaceId, conversationId);
  if (!conversation) return notFound('Conversation not found');
  const author: Author = req.canvasAuthor ?? { kind: 'human', userId: getAuthUser(req).username };
  if (author.kind === 'agent' && !taskStart) {
    // A conversation session messaging any conversation is how two of them could answer each other for ever.
    const file = readConversations(workspaceId);
    if (file.ok && file.conversations.some((c) => c.sessionId === author.sessionId))
      return conflict('An agent running in a conversation cannot message a conversation');
    // A task is a person's request to its own session: an agent may read it, never steer it.
    if (taskPart(conversation))
      return refuse(403, ApiErrorCode.FORBIDDEN, 'A background task takes messages only from a person');
  }

  // A cancelled task takes nothing more: its request may still sit unsubmitted in the composer, and any later Enter would run it.
  if (taskPart(conversation)?.cancelledAt !== undefined)
    return conflict('TASK_CANCELLED: this task was cancelled and takes no more messages');
  // A session that is gone is a conflict the rail words; one the caller may not see is simply not found.
  if (!ctx.sessions.has(conversation.sessionId)) return conflict('SESSION_ENDED: the session has ended');
  const session = findSessionOrFail({ sessions: ctx.sessions } as unknown as SessionPort, conversation.sessionId, req);
  if (session.paneExit) return conflict('SESSION_ENDED: the session has ended');

  const text = normalizePrompt(body.text);
  const refusal = promptRefusal(text);
  if (refusal) return refuse(400, ApiErrorCode.INVALID_INPUT, refusal);

  const state = (await ctx.canvasStores()).get(workspaceId).read();
  const resolved = resolveContext(state, workspaceId, body.messageId.toLowerCase(), body.refIds);
  const composed = resolved.block + text;
  if (byteLength(composed) > MAX_COMPOSED_BYTES)
    return refuse(413, ApiErrorCode.INVALID_INPUT, 'TOO_LARGE: the message and its context are too large to send');

  const known = conversation.messages.find((m) => m.messageId === body.messageId);
  const knownState = known ? messageState(known) : undefined;
  if (known && knownState === 'delivered') {
    const same = known.textSha256 === sha256(text) && known.namedSha256 === namedHash(body.refIds);
    if (!same) return conflict('MESSAGE_CHANGED: this message id was already used for different text');
    return accepted(body.messageId, known, resolved.missing, true);
  }
  if (!known && body.origin) {
    const { objectId, commentId } = body.origin;
    const object = state.objects[objectId];
    const asked = state.comments.some((c) => c.id === commentId && c.objectId === objectId);
    if (!object || object.deletedAt !== null || !asked)
      return conflict('ORIGIN_GONE: the comment this request was asked from is no longer on the canvas');
  }
  if (!known && !limiter.take(`${workspaceId}:${conversationId}`, author.kind === 'agent'))
    return refuse(
      429,
      ApiErrorCode.RATE_LIMITED,
      'RATE_LIMITED: too many messages to this conversation; wait a moment'
    );

  const recorded = recordMessage(
    workspaceId,
    conversationId,
    {
      messageId: body.messageId,
      sentAt: Date.now(),
      deliveredAt: null,
      state: 'queued',
      author,
      textSha256: sha256(text),
      textBytes: byteLength(text),
      namedSha256: namedHash(body.refIds),
      refs: resolved.refs,
      seq: state.seq,
      ...(body.origin ? { origin: body.origin } : {}),
    },
    body.refIds
  );
  if (!recorded.ok)
    return recorded.reason === 'CHANGED'
      ? conflict('MESSAGE_CHANGED: this message id was already used for different text')
      : recorded.reason === 'FULL'
        ? conflict('TOO_MANY: this conversation is full; start a new one')
        : notFound('Conversation not found');
  // A message a delivery of this process is carrying is simply on its way; one a process that is gone left behind is sent again.
  if (
    recorded.duplicate &&
    (knownState === 'queued' || knownState === 'sending') &&
    inFlight.has(flightKey(workspaceId, conversationId, body.messageId))
  )
    return accepted(body.messageId, recorded.message, resolved.missing, true);

  // Pasting while a permission or question dialog is open would answer it with this text's Enter.
  const pending = approvalInbox.getForSession(conversation.sessionId);
  if (pending && pending.kind !== 'idle') {
    setMessageState(workspaceId, conversationId, body.messageId, 'failed');
    return conflict('APPROVAL_PENDING: answer the pending question first');
  }
  enqueue(ctx, workspace, conversation, session, recorded.message, composed, recorded.duplicate);
  return accepted(body.messageId, recorded.message, resolved.missing, recorded.duplicate);
}
/** The send is accepted, not yet delivered: delivery is confirmed in the background and the record says when. */
function accepted(messageId: string, message: ConversationMessage, missing: string[], duplicate: boolean): Outcome {
  return ok({
    messageId,
    state:
      duplicate && message.deliveredAt !== null
        ? 'delivered'
        : messageState(message) === 'failed'
          ? 'queued'
          : messageState(message),
    deliveredAt: message.deliveredAt,
    duplicate,
    refs: message.refs,
    missing,
  });
}

/** The `canvas_conversation` tool: the same operations as the routes, for an agent caller. `model` steers a view and is answered by the view route, so it never reaches here. */
export async function conversationTool(
  ctx: CanvasPort,
  req: FastifyRequest,
  workspaceId: string,
  input: Exclude<z.infer<typeof ConversationToolSchema>, { action: 'model' }>
): Promise<Outcome> {
  switch (input.action) {
    case 'list':
      return listConversations(ctx, req, workspaceId);
    case 'read':
      return readConversation(ctx, req, workspaceId, input.conversationId);
    case 'create':
      return createConversation(ctx, req, workspaceId, {
        requestId: input.requestId,
        ...(input.cliId !== undefined ? { cliId: input.cliId } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
      });
    case 'send': {
      const { conversationId, action: _action, ...message } = input;
      void _action;
      return sendMessage(ctx, req, workspaceId, conversationId, message);
    }
  }
}

export function registerConversationRoutes(scope: FastifyInstance, ctx: CanvasPort): void {
  const params = z.object({ workspaceId: z.string(), conversationId: z.uuid() });
  scope.get<{ Params: { workspaceId: string } }>('/api/canvas/:workspaceId/conversations', async (req, reply) => {
    const outcome = listConversations(ctx, req, req.params.workspaceId);
    return reply.code(outcome.code).send(outcome.body);
  });
  scope.get('/api/canvas/:workspaceId/conversations/:conversationId', async (req, reply) => {
    const p = params.parse(req.params);
    const outcome = await readConversation(ctx, req, p.workspaceId, p.conversationId);
    return reply.code(outcome.code).send(outcome.body);
  });
  scope.post<{ Params: { workspaceId: string } }>(
    '/api/canvas/:workspaceId/conversations',
    { bodyLimit: 4 * 1024 },
    async (req, reply) => {
      const outcome = await createConversation(ctx, req, req.params.workspaceId, req.body);
      return reply.code(outcome.code).send(outcome.body);
    }
  );
  scope.post(
    '/api/canvas/:workspaceId/conversations/:conversationId/messages',
    { bodyLimit: 64 * 1024 },
    async (req, reply) => {
      const p = params.parse(req.params);
      const outcome = await sendMessage(ctx, req, p.workspaceId, p.conversationId, req.body);
      return reply.code(outcome.code).send(outcome.body);
    }
  );
}
