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
  providerRow,
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
  type Conversation,
  type ConversationMessage,
} from '../../canvas/conversation-schema.js';
import {
  addConversation,
  findConversation,
  messageState,
  setMessageState,
  namedHash,
  readConversations,
  recordMessage,
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
});

export function listConversations(ctx: CanvasPort, req: FastifyRequest, workspaceId: string): Outcome {
  const file = readConversations(workspaceId);
  if (!file.ok) return ok({ conversations: [], unreadable: file.reason });
  return ok({ conversations: file.conversations.map((c) => summary(ctx, req, c)) });
}
export function readConversation(ctx: CanvasPort, req: FastifyRequest, workspaceId: string, id: string): Outcome {
  const conversation = findConversation(workspaceId, id);
  if (!conversation) return notFound('Conversation not found');
  return ok({ conversation: { ...summary(ctx, req, conversation), messages: conversation.messages } });
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
export async function listProviders(): Promise<Outcome> {
  return ok({ providers: await currentProviders() });
}
/**
 * Which CLI and launch fields a create request means. A request naming no CLI is what every conversation was before
 * the choice existed and is not probed; one that names a CLI must name an enabled, installed agent that delivery can
 * confirm, and a model id that CLI's launch accepts. Refusals are stated, never replaced by another CLI.
 */
async function resolveLaunch(
  cliId: string | undefined,
  model: string | undefined
): Promise<{ ok: true; entryId: string; model: string; launch: Record<string, unknown> } | Outcome> {
  const wanted = model ?? '';
  if (cliId !== undefined) {
    const row = (await currentProviders()).find((r) => r.id === cliId);
    if (!row)
      return refuse(
        400,
        ApiErrorCode.INVALID_INPUT,
        `UNKNOWN_CLI: ${cliId} is not an enabled, installed agent CLI on this server`
      );
    if (!row.available) return conflict(`CLI_UNAVAILABLE: ${row.reason ?? `${row.label} cannot start a conversation`}`);
  }
  const entry = getCli(cliId ?? DEFAULT_CONVERSATION_CLI);
  if (!entry) return refuse(400, ApiErrorCode.INVALID_INPUT, 'UNKNOWN_CLI: the default CLI is not available');
  if (wanted !== '' && !providerRow(entry).model.editable)
    return refuse(
      400,
      ApiErrorCode.INVALID_INPUT,
      `INVALID_MODEL: ${providerRow(entry).model.reason ?? 'no model choice'}`
    );
  const fields = launchFields(entry, wanted);
  if (!fields.ok) return refuse(400, ApiErrorCode.INVALID_INPUT, `INVALID_MODEL: ${fields.reason}`);
  return { ok: true, entryId: entry.id as string, model: wanted, launch: fields.fields };
}
async function start(
  ctx: CanvasPort,
  req: FastifyRequest,
  workspace: Workspace,
  body: { requestId: string; cliId?: string; model?: string }
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

/** The `canvas_conversation` tool: the same operations as the routes, for an agent caller. */
export async function conversationTool(
  ctx: CanvasPort,
  req: FastifyRequest,
  workspaceId: string,
  args: unknown
): Promise<Outcome> {
  const input = ConversationToolSchema.parse(args);
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
    case 'model':
      return refuse(400, ApiErrorCode.INVALID_INPUT, 'The model action is handled with the view it steers');
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
