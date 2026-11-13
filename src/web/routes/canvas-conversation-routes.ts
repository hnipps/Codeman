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
  threadOrigin,
  threadReply,
  type Conversation,
  type ConversationMessage,
  type ThreadReply,
} from '../../canvas/conversation-schema.js';
import { cutReply, extractReply, replyCommentId } from '../../canvas/thread-reply.js';
import { commentCommand } from '../../canvas/commands.js';
import {
  addConversation,
  findConversation,
  messageState,
  setMessageState,
  namedHash,
  readConversations,
  recordMessage,
  setMessageReply,
  sha256,
} from '../../canvas/conversations.js';
import type { Author } from '../../canvas/model.js';
import type { Workspace } from '../../canvas/workspace-registry.js';

export type Outcome = { code: number; body: unknown };
const ok = (data: unknown): Outcome => ({ code: 200, body: { success: true, data } });
const refuse = (code: number, errorCode: ApiErrorCode, message: string): Outcome => ({
  code,
  body: createErrorResponse(errorCode, message),
});
const conflict = (message: string): Outcome => refuse(409, ApiErrorCode.CONFLICT, message);
const notFound = (message: string): Outcome => refuse(404, ApiErrorCode.NOT_FOUND, message);

/** Writes need the live colour, and only the workspace's own owner may start or message a conversation. */
async function writeGuard(req: FastifyRequest, workspaceId: string): Promise<Outcome | Workspace> {
  if (!deployRole.allows('persist')) return conflict('Only the live colour may write canvas data');
  const { readWorkspaces } = await import('../../canvas/workspace-registry.js');
  const workspace = readWorkspaces().find((w) => w.id === workspaceId);
  if (!workspace || workspace.owner !== ownerFor(req)) return notFound('Workspace not found');
  return workspace;
}
const isOutcome = (value: Outcome | Workspace): value is Outcome => 'code' in value;

/** Session state as the rail shows it. A session that ended is still a conversation; it just cannot take messages. */
function sessionState(ctx: CanvasPort, req: FastifyRequest, sessionId: string): 'live' | 'ended' {
  const session = ctx.sessions.get(sessionId);
  if (!session || !canAccessOwned(getAuthUser(req), session.owner)) return 'ended';
  return session.paneExit ? 'ended' : 'live';
}
const summary = (ctx: CanvasPort, req: FastifyRequest, c: Conversation) => ({
  id: c.id,
  sessionId: c.sessionId,
  cliId: c.cliId,
  cliLabel: getCli(c.cliId)?.label ?? c.cliId,
  ...(c.model ? { model: c.model } : {}),
  ...(c.title ? { title: c.title } : {}),
  createdAt: c.createdAt,
  createdBy: c.createdBy,
  messageCount: c.messages.length,
  session: sessionState(ctx, req, c.sessionId),
  working: ctx.sessions.get(c.sessionId)?.hookTurnRunning === true,
  ...(threadOrigin(c) ? { origin: threadOrigin(c) } : {}),
  ...(threadRequests(c).length ? { requests: threadRequests(c) } : {}),
});
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
        ...(reply && reply !== 'unknown' ? { reply } : {}),
      },
    ];
  });

export function listConversations(ctx: CanvasPort, req: FastifyRequest, workspaceId: string): Outcome {
  const file = readConversations(workspaceId);
  if (!file.ok) return ok({ conversations: [], unreadable: file.reason });
  for (const c of file.conversations) reconcileReplies(ctx, workspaceId, c);
  return ok({ conversations: file.conversations.map((c) => summary(ctx, req, c)) });
}
export function readConversation(ctx: CanvasPort, req: FastifyRequest, workspaceId: string, id: string): Outcome {
  const conversation = findConversation(workspaceId, id);
  if (!conversation) return notFound('Conversation not found');
  reconcileReplies(ctx, workspaceId, conversation);
  return ok({ conversation: { ...summary(ctx, req, conversation), messages: conversation.messages } });
}

const awaitsReply = (m: ConversationMessage): boolean =>
  threadOrigin(m) !== undefined && threadReply(m) === undefined && messageState(m) === 'delivered';
/** Reply routing of one workspace runs one conversation at a time, so two signals for the same turn post once. */
const replyChains = new Map<string, Promise<void>>();
/** Resolves when every reply being routed has been (tests). */
export const settleReplies = async (): Promise<void> => {
  while (replyChains.size) await Promise.all([...replyChains.values()]);
};
/**
 * Posts the reply of every thread request of this conversation whose turn is over into the thread it was asked from.
 * Called when the session's stop hook fires and again whenever the conversation is read, so a stop missed across a
 * restart is still routed. Only the recorded origin decides where a reply goes.
 */
function reconcileReplies(ctx: CanvasPort, workspaceId: string, conversation: Conversation, turnEnded = false): void {
  if (!deployRole.allows('persist') || !ctx.transcriptRows) return;
  if (!conversation.messages.some(awaitsReply)) return;
  const run = () => routeReplies(ctx, workspaceId, conversation.id, turnEnded).catch(() => undefined);
  const job = (replyChains.get(workspaceId) ?? Promise.resolve()).then(run, run);
  replyChains.set(workspaceId, job);
  void job.then(() => {
    if (replyChains.get(workspaceId) === job) replyChains.delete(workspaceId);
  });
}
async function routeReplies(
  ctx: CanvasPort,
  workspaceId: string,
  conversationId: string,
  turnEnded: boolean
): Promise<void> {
  const conversation = findConversation(workspaceId, conversationId);
  const waiting = conversation?.messages.filter(awaitsReply) ?? [];
  const session = conversation ? ctx.sessions.get(conversation.sessionId) : undefined;
  if (!conversation || !waiting.length || !session) return;
  const rows = await ctx.transcriptRows?.(conversation.sessionId);
  if (!rows || !deployRole.allows('persist')) return;
  // Read after the transcript: a prompt submitted meanwhile means the last request's turn is running again.
  const idle = !session.hookTurnRunning && (turnEnded || !session.isWorking);
  const { readWorkspaces } = await import('../../canvas/workspace-registry.js');
  const owner = readWorkspaces().find((w) => w.id === workspaceId)?.owner;
  let changed = false;
  for (const message of waiting) {
    const origin = threadOrigin(message);
    const found = extractReply(rows, message.messageId);
    if (!origin || !found.found || (!found.closed && !idle)) continue;
    let reply: ThreadReply;
    if (!found.text) {
      // An open turn with no text yet may still be flushing its last row; a closed one will never have any.
      if (!found.closed) continue;
      reply = { dropped: 'no-reply' };
    } else
      reply = await postReply(ctx, workspaceId, owner, conversation.sessionId, origin.objectId, message, found.text);
    try {
      changed = setMessageReply(workspaceId, conversationId, message.messageId, reply) || changed;
    } catch {
      /* The comment id is derived from the message id, so the next pass finds the comment and records it then. */
    }
  }
  if (changed) ctx.broadcast(SseEvent.CanvasConversation, { workspaceId, conversationId, change: 'message', owner });
}
/** One ordinary `comment` operation authored by the conversation's session; a comment already there under this request's id is the reply. */
async function postReply(
  ctx: CanvasPort,
  workspaceId: string,
  owner: string | undefined,
  sessionId: string,
  objectId: string,
  message: ConversationMessage,
  text: string
): Promise<ThreadReply> {
  const commentId = replyCommentId(message.messageId);
  try {
    const store = (await ctx.canvasStores()).get(workspaceId);
    const state = store.read();
    const existing = state.comments.find((c) => c.id === commentId);
    if (existing) return { commentId, postedAt: existing.createdAt };
    const object = state.objects[objectId];
    if (!object || object.deletedAt !== null) return { dropped: 'object-removed' };
    const result = store.appendExpanded([commentCommand({ objectId, text: cutReply(text), commentId })], {
      kind: 'agent',
      sessionId,
    });
    if (!result.ok) return { dropped: result.reasons[0]?.code === 'NOT_FOUND' ? 'object-removed' : 'refused' };
    ctx.broadcast(SseEvent.CanvasChanged, { workspaceId, seq: result.seq, owner });
    return { commentId, postedAt: Date.now() };
  } catch {
    return { dropped: 'refused' };
  }
}
/** The session's stop hook fired: route the replies of every conversation that session is. */
export async function conversationTurnEnded(ctx: CanvasPort, sessionId: string): Promise<void> {
  if (!deployRole.allows('persist') || !ctx.transcriptRows || !(await ctx.canvasEnabled())) return;
  const { readWorkspaces } = await import('../../canvas/workspace-registry.js');
  for (const workspace of readWorkspaces()) {
    const file = readConversations(workspace.id);
    if (!file.ok) continue;
    for (const c of file.conversations) if (c.sessionId === sessionId) reconcileReplies(ctx, workspace.id, c, true);
  }
}

/** Creates in one workspace run one at a time, so the cap check and the add are one step and a retry finds the first's conversation. */
const createChains = new Map<string, Promise<unknown>>();
export async function createConversation(
  ctx: CanvasPort,
  req: FastifyRequest,
  workspaceId: string,
  input: unknown
): Promise<Outcome> {
  const body = parseBody(CreateConversationBodySchema, input);
  if (req.canvasAuthor?.kind === 'agent')
    return refuse(
      403,
      ApiErrorCode.FORBIDDEN,
      'Starting a conversation starts a Claude session, so only a person can do it. Ask the person to start one from the canvas.'
    );
  const workspace = await writeGuard(req, workspaceId);
  if (isOutcome(workspace)) return workspace;
  const previous = createChains.get(workspaceId) ?? Promise.resolve();
  const work = previous.then(() => start(ctx, req, workspace, body));
  const tail = work.catch(() => undefined);
  createChains.set(workspaceId, tail);
  void tail.then(() => {
    if (createChains.get(workspaceId) === tail) createChains.delete(workspaceId);
  });
  return work;
}
/** A Docker or remote case runs its agent elsewhere; the plain create route would run Claude on this host instead. */
async function caseRunsElsewhere(req: FastifyRequest, caseName: string): Promise<boolean> {
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
async function resolveLaunch(
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
  });
  if (!started.ok) return refuse(409, ApiErrorCode.OPERATION_FAILED, `START_FAILED: ${started.message}`);
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
  const run = async (): Promise<void> => {
    // A newer message never goes in behind one that may still be sitting in the composer.
    if (!retry && stuck.has(key)) return set('failed');
    set('sending');
    const deps = deliveryDeps(session, composed);
    let result: DeliveryResult;
    try {
      const plan = retry ? retryPlan(deps.snapshot(), deps.glyph, deps.hookAt(), message.sentAt) : ('paste' as const);
      result =
        plan === 'confirmed'
          ? 'confirmed'
          : await deliver(deps, plan === 'enter-only' ? 'enter-only' : 'paste', message.sentAt);
    } catch {
      result = 'timeout';
    }
    if (result === 'confirmed' || result === 'unverified') {
      stuck.delete(key);
      return set('delivered', Date.now());
    }
    // Only a paste that was written and never taken leaves text behind; a refused or never-ready one wrote nothing.
    if (result === 'timeout') stuck.add(key);
    set('failed');
  };
  const job = (chains.get(key) ?? Promise.resolve()).then(run, run).catch(() => undefined);
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
  input: unknown
): Promise<Outcome> {
  const body = parseBody(SendBodySchema, input);
  const workspace = await writeGuard(req, workspaceId);
  if (isOutcome(workspace)) return workspace;
  const conversation = findConversation(workspaceId, conversationId);
  if (!conversation) return notFound('Conversation not found');
  const author: Author = req.canvasAuthor ?? { kind: 'human', userId: getAuthUser(req).username };
  if (author.kind === 'agent') {
    // A conversation session messaging any conversation is how two of them could answer each other for ever.
    const file = readConversations(workspaceId);
    if (file.ok && file.conversations.some((c) => c.sessionId === author.sessionId))
      return conflict('An agent running in a conversation cannot message a conversation');
  }

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
  if (recorded.duplicate && (knownState === 'queued' || knownState === 'sending'))
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
    const outcome = readConversation(ctx, req, p.workspaceId, p.conversationId);
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
