/**
 * @fileoverview Chat Graph routes (intent/2026-11-18-chat-graph.md, ticket 4), all under `/api/chat-graph`:
 *
 * - `POST /messages` `{ text, signal? }` stores and files one message and answers its chips
 *   (`ChatGraphService.post`), then broadcasts `chat-graph:routed`. A text starting with `>` is a capture,
 *   answered with `ack` and never written to an agent session (I10).
 * - `POST /messages/:id/reassign` `{ to, from?, add?, opId? }` moves a message (a correction) or, with `add`,
 *   files it to a second topic. `opId` makes a retry idempotent.
 * - `GET /topics`, `GET /topics/:id`, `GET /corrections?limit=` read the sidecar.
 *
 * Every route answers 503 `CHAT_GRAPH_UNAVAILABLE` when the sidecar is not running here (a candidate or retired
 * colour never runs it), and 403 in multi-user mode, which Chat Graph does not support. Chat text never goes to
 * the log: failures are logged by message id only.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { ChatGraphUnavailable } from '../../chat-graph/supervisor.js';
import { ChatGraphRefused, type ChatGraphCaller, type ChatGraphService } from '../../chat-graph/chat-service.js';
import { SseEvent } from '../sse-events.js';
import { parseBody } from '../route-helpers.js';
import { ChatGraphIdSchema, ChatGraphMessageSchema, ChatGraphReassignSchema } from '../schemas.js';

export interface ChatGraphRoutesDeps {
  service: ChatGraphService;
  sidecar: ChatGraphCaller;
  broadcast(event: string, data: unknown): void;
}

const CorrectionsQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() });

function refusedCode(status: number): ApiErrorCode {
  if (status === 400) return ApiErrorCode.INVALID_INPUT;
  if (status === 404) return ApiErrorCode.NOT_FOUND;
  if (status === 409) return ApiErrorCode.CONFLICT;
  return ApiErrorCode.OPERATION_FAILED;
}

/** Answers an error this module knows; rethrows the rest for the central handler. */
function sendFailure(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ChatGraphUnavailable) {
    return reply.code(503).send(createErrorResponse(ApiErrorCode.CHAT_GRAPH_UNAVAILABLE, err.message));
  }
  if (err instanceof ChatGraphRefused) {
    const status = err.status >= 400 && err.status < 500 ? err.status : 422;
    return reply.code(status).send(createErrorResponse(refusedCode(err.status), err.message));
  }
  throw err;
}

export function registerChatGraphRoutes(app: FastifyInstance, deps: ChatGraphRoutesDeps): void {
  const refuseMultiUser = (reply: FastifyReply): FastifyReply | null =>
    isMultiUserMode()
      ? reply
          .code(403)
          .send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'Chat Graph is not available in multi-user mode'))
      : null;

  const read = async (reply: FastifyReply, path: string) => {
    try {
      const answer = await deps.sidecar.call('GET', path);
      if (answer.status !== 200) {
        const error = (answer.body as { error?: unknown } | null)?.error;
        throw new ChatGraphRefused(answer.status, typeof error === 'string' ? error : 'Chat Graph refused the request');
      }
      return { success: true, data: answer.body };
    } catch (err) {
      return sendFailure(reply, err);
    }
  };

  app.post('/api/chat-graph/messages', async (req, reply) => {
    if (refuseMultiUser(reply)) return reply;
    const { text, signal } = parseBody(ChatGraphMessageSchema, req.body);
    try {
      const posted = await deps.service.post(text, signal);
      if (posted.routing !== 'pending') {
        deps.broadcast(SseEvent.ChatGraphRouted, {
          messageId: posted.messageId,
          kind: posted.kind,
          routing: posted.routing,
          chips: posted.chips,
        });
      }
      return { success: true, data: posted };
    } catch (err) {
      return sendFailure(reply, err);
    }
  });

  app.post('/api/chat-graph/messages/:id/reassign', async (req, reply) => {
    if (refuseMultiUser(reply)) return reply;
    const id = parseBody(ChatGraphIdSchema, (req.params as { id?: unknown }).id);
    const body = parseBody(ChatGraphReassignSchema, req.body);
    try {
      const op = await deps.service.reassign(id, body.to, body);
      return { success: true, data: op };
    } catch (err) {
      return sendFailure(reply, err);
    }
  });

  app.get('/api/chat-graph/topics', async (_req, reply) => refuseMultiUser(reply) ?? read(reply, '/topics'));

  app.get('/api/chat-graph/topics/:id', async (req, reply) => {
    if (refuseMultiUser(reply)) return reply;
    const id = parseBody(ChatGraphIdSchema, (req.params as { id?: unknown }).id);
    return read(reply, `/topics/${encodeURIComponent(id)}`);
  });

  app.get('/api/chat-graph/corrections', async (req, reply) => {
    if (refuseMultiUser(reply)) return reply;
    const { limit } = parseBody(CorrectionsQuerySchema, req.query);
    return read(reply, limit === undefined ? '/corrections' : `/corrections?limit=${limit}`);
  });
}
