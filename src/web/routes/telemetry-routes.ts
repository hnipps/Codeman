/**
 * @fileoverview Build health and client-error telemetry routes.
 *
 * - `GET  /api/health`         liveness, uptime, build identity and deploy role, for a deploy supervisor
 * - `GET  /ws/health`          the same over a WebSocket: says `{ok, buildId}` and closes
 * - `GET  /api/logs`           already-redacted lines from one stream, admin-only in multi-user mode
 * - `POST /api/client-errors`  an uncaught browser error, or a `kind: "ui"` canvas / tab-strip event
 *
 * All four sit behind the normal auth hook. The WebSocket carries the same Host and
 * Origin upgrade guard as the terminal socket.
 *
 * `/api/client-errors` is a write path for anyone who can load the page, so it is bounded
 * three ways: a small body limit, a per-address rate limit, and length-capped fields. A
 * `kind: "ui"` body uses its own rate bucket and `ui-events.jsonl`. With file telemetry
 * off the route accepts the report and drops it. `/api/logs` returns an empty list and a
 * reason in that case, and it never accepts a field that would return the raw line.
 */

import { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { PACKAGE_VERSION, readHookSecretForRedaction } from '../../telemetry.js';
import { deployRole } from '../../deploy-role.js';
import { LogQueryError, NO_LOG_DIR_REASON, parseLogsQuery, queryLogs } from '../../telemetry-query.js';
import { ClientErrorSchema } from '../schemas.js';
import { canAccessOwned, getAuthUser, parseBody, requireAdmin } from '../route-helpers.js';
import { isAllowedRequestHost, isAllowedRequestOrigin, type HostPolicy } from '../network-auth-policy.js';
import { takeToken } from './session-routes.js';
import type { SessionPort, TelemetryPort } from '../ports/index.js';

const CLIENT_ERROR_BODY_LIMIT = 16 * 1024;
const CLIENT_ERROR_REPORTS_PER_MINUTE = 30;
const UI_EVENT_REPORTS_PER_MINUTE = 120;
const MAX_USER_AGENT_CHARS = 300;

const UiEventSchema = z
  .object({
    kind: z.literal('ui'),
    surface: z.enum(['canvas', 'tab-strip']),
    action: z.string().regex(/^[a-z][a-z0-9._-]{0,39}$/),
    target: z.string().min(1).max(80).nullish(),
  })
  .strict();

export function registerTelemetryRoutes(
  app: FastifyInstance,
  ctx: SessionPort & TelemetryPort,
  getHostPolicy: () => HostPolicy
): void {
  const clientErrorBuckets = new Map<string, { tokens: number; lastRefill: number }>();
  const uiEventBuckets = new Map<string, { tokens: number; lastRefill: number }>();

  app.get('/api/health', async (req) => {
    const user = getAuthUser(req);
    let sessions = 0;
    for (const session of ctx.sessions.values()) {
      if (canAccessOwned(user, session.owner)) sessions++;
    }
    return {
      status: 'ok',
      version: PACKAGE_VERSION,
      buildId: ctx.buildId,
      uptimeS: Math.round(process.uptime()),
      uptimeSeconds: Math.floor(process.uptime()),
      sessions,
      pid: process.pid,
      deployRole: deployRole.current,
    };
  });

  app.get('/ws/health', { websocket: true }, (socket: WebSocket, req) => {
    const policy = getHostPolicy();
    if (!isAllowedRequestHost(req.headers.host, policy) || !isAllowedRequestOrigin(req.headers.origin, policy)) {
      socket.close(4003, 'Forbidden');
      return;
    }
    socket.send(JSON.stringify({ ok: true, buildId: ctx.buildId }));
    socket.close(1000);
  });

  app.get('/api/logs', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!ctx.telemetry) {
      return { success: true, data: { lines: [], truncated: false, reason: NO_LOG_DIR_REASON } };
    }
    try {
      const parsed = parseLogsQuery(req.query);
      const data = await queryLogs({
        ...parsed,
        dir: ctx.telemetry.dir,
        hookSecret: readHookSecretForRedaction(),
      });
      return { success: true, data };
    } catch (err) {
      if (err instanceof LogQueryError) {
        return reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, err.message));
      }
      return reply.code(500).send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Could not read logs'));
    }
  });

  app.post('/api/client-errors', { bodyLimit: CLIENT_ERROR_BODY_LIMIT }, async (req, reply) => {
    const raw = req.body;
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as { kind?: unknown }).kind === 'ui') {
      if (!takeToken(uiEventBuckets, req.ip, UI_EVENT_REPORTS_PER_MINUTE, Date.now())) {
        return reply.code(429).send(createErrorResponse(ApiErrorCode.RATE_LIMITED, 'Too many UI events'));
      }
      const event = parseBody(UiEventSchema, raw);
      ctx.telemetry?.write('ui-events', {
        buildId: ctx.buildId,
        surface: event.surface,
        action: event.action,
        target: event.target,
      });
      return { success: true };
    }
    if (!takeToken(clientErrorBuckets, req.ip, CLIENT_ERROR_REPORTS_PER_MINUTE, Date.now())) {
      return reply.code(429).send(createErrorResponse(ApiErrorCode.RATE_LIMITED, 'Too many client error reports'));
    }
    const error = parseBody(ClientErrorSchema, req.body);
    ctx.telemetry?.write('client-errors', {
      buildId: ctx.buildId,
      ua: String(req.headers['user-agent'] ?? '').slice(0, MAX_USER_AGENT_CHARS),
      ...error,
    });
    return { success: true };
  });
}
