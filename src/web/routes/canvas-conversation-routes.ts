/** @fileoverview Canvas conversations: a conversation is one real Claude session, started and written through the ordinary session layer. Sending composes the context block server-side, records what was carried (never the text), and pastes the prompt with the session's own write primitive. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CanvasPort } from '../ports/canvas-port.js';
import type { SessionPort } from '../ports/session-port.js';
import { canAccessOwned, findSessionOrFail, getAuthUser, ownerFor, parseBody } from '../route-helpers.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { deployRole } from '../../deploy-role.js';
import { SseEvent } from '../sse-events.js';
import { approvalInbox } from '../approval-inbox.js';
import { resolveCasePath } from './case-routes.js';
import { resolveContext } from '../../canvas/context-resolve.js';
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
} from '../../canvas/conversation-schema.js';
import {
  addConversation,
  findConversation,
  markDelivered,
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
  ...(c.title ? { title: c.title } : {}),
  createdAt: c.createdAt,
  createdBy: c.createdBy,
  messageCount: c.messages.length,
  session: sessionState(ctx, req, c.sessionId),
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

const startsInFlight = new Map<string, Promise<Outcome>>();
export async function createConversation(
  ctx: CanvasPort,
  req: FastifyRequest,
  workspaceId: string,
  input: unknown
): Promise<Outcome> {
  const body = parseBody(CreateConversationBodySchema, input);
  const workspace = await writeGuard(req, workspaceId);
  if (isOutcome(workspace)) return workspace;
  const key = `${workspaceId}:${body.requestId}`;
  const running = startsInFlight.get(key);
  if (running) return running;
  const work = start(ctx, req, workspace, body.requestId).finally(() => startsInFlight.delete(key));
  startsInFlight.set(key, work);
  return work;
}
async function start(ctx: CanvasPort, req: FastifyRequest, workspace: Workspace, requestId: string): Promise<Outcome> {
  const file = readConversations(workspace.id);
  if (!file.ok) return conflict('FILE_UNREADABLE: conversations cannot be saved right now; nothing was started');
  const prior = file.conversations.find((c) => c.requestId === requestId);
  if (prior) return ok({ conversation: summary(ctx, req, prior), duplicate: true });
  if (file.conversations.length >= MAX_CONVERSATIONS_PER_WORKSPACE)
    return conflict(`TOO_MANY: a canvas keeps at most ${MAX_CONVERSATIONS_PER_WORKSPACE} conversations`);
  if (!ctx.startConversationSession) return conflict('Conversations are not available on this server');
  const workingDir = await resolveCasePath(workspace.caseName, getAuthUser(req));
  const started = await ctx.startConversationSession(req.headers, {
    workingDir,
    name: `Canvas · ${workspace.caseName}`.slice(0, 100),
  });
  if (!started.ok) return refuse(409, ApiErrorCode.OPERATION_FAILED, `START_FAILED: ${started.message}`);
  const created = addConversation(
    workspace.id,
    () => ({
      id: randomUUID(),
      sessionId: started.sessionId,
      cliId: 'claude',
      createdAt: Date.now(),
      createdBy: ownerFor(req) ?? '@single',
    }),
    requestId
  );
  if (!created.ok) return conflict('TOO_MANY: a canvas keeps a limited number of conversations');
  ctx.broadcast(SseEvent.CanvasConversation, {
    workspaceId: workspace.id,
    conversationId: created.conversation.id,
    change: 'created',
    owner: workspace.owner,
  });
  return ok({ conversation: summary(ctx, req, created.conversation), duplicate: created.duplicate });
}

const delivering = new Set<string>();
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
  if (author.kind === 'agent' && author.sessionId === conversation.sessionId)
    return conflict('An agent cannot message its own conversation');

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

  const slot = `${workspaceId}:${body.messageId}`;
  if (delivering.has(slot)) return conflict('BUSY: this message is already being delivered');
  const recorded = recordMessage(
    workspaceId,
    conversationId,
    {
      messageId: body.messageId,
      sentAt: Date.now(),
      deliveredAt: null,
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
  const answer = (deliveredAt: number, duplicate: boolean) =>
    ok({ messageId: body.messageId, deliveredAt, duplicate, refs: recorded.message.refs, missing: resolved.missing });
  if (recorded.message.deliveredAt !== null) return answer(recorded.message.deliveredAt, true);

  // Pasting while a permission or question dialog is open would answer it with this text's Enter.
  const pending = approvalInbox.getForSession(conversation.sessionId);
  if (pending && pending.kind !== 'idle') return conflict('APPROVAL_PENDING: answer the pending question first');

  delivering.add(slot);
  try {
    // The mux pastes the text as one block and presses Enter separately; never write a prompt as one burst.
    const written = (await session.writeViaMux?.(composed + '\r', { fromUser: true }).catch(() => false)) ?? false;
    if (!written) return conflict('NOT_DELIVERED: the session did not take the message; nothing was sent');
    const deliveredAt = Date.now();
    markDelivered(workspaceId, conversationId, body.messageId, deliveredAt);
    ctx.broadcast(SseEvent.CanvasConversation, {
      workspaceId,
      conversationId,
      change: 'message',
      owner: workspace.owner,
    });
    return answer(deliveredAt, false);
  } finally {
    delivering.delete(slot);
  }
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
      return createConversation(ctx, req, workspaceId, { requestId: input.requestId });
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
