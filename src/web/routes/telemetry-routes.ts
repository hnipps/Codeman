/**
 * @fileoverview Build health and client-error telemetry routes.
 *
 * - `GET  /api/health`         liveness plus build identity, for a deploy supervisor
 * - `GET  /ws/health`          the same over a WebSocket: says `{ok, buildId}` and closes
 * - `POST /api/client-errors`  an uncaught browser error, appended to `client-errors.jsonl`
 *
 * All three sit behind the normal auth hook. The WebSocket carries the same Host and
 * Origin upgrade guard as the terminal socket.
 *
 * `/api/client-errors` is a write path for anyone who can load the page, so it is bounded
 * three ways: a small body limit, a per-address rate limit, and length-capped fields. With
 * file telemetry off it accepts the report and drops it.
 */

import { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { PACKAGE_VERSION } from '../../telemetry.js';
import { ClientErrorSchema } from '../schemas.js';
import { canAccessOwned, getAuthUser, parseBody } from '../route-helpers.js';
import { isAllowedRequestHost, isAllowedRequestOrigin, type HostPolicy } from '../network-auth-policy.js';
import { takeToken } from './session-routes.js';
import type { SessionPort, TelemetryPort } from '../ports/index.js';

const CLIENT_ERROR_BODY_LIMIT = 16 * 1024;
const CLIENT_ERROR_REPORTS_PER_MINUTE = 30;
const MAX_USER_AGENT_CHARS = 300;

export function registerTelemetryRoutes(
  app: FastifyInstance,
  ctx: SessionPort & TelemetryPort,
  getHostPolicy: () => HostPolicy
): void {
  const clientErrorBuckets = new Map<string, { tokens: number; lastRefill: number }>();

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
      sessions,
      pid: process.pid,
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

  app.post('/api/client-errors', { bodyLimit: CLIENT_ERROR_BODY_LIMIT }, async (req, reply) => {
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
