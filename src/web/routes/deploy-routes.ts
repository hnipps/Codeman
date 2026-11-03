/**
 * @fileoverview Deploy role route, for a blue-green deploy supervisor's handoff script.
 *
 * - `POST /api/deploy/role` `{ role: 'live' | 'retired' }` moves this process to that deploy
 *   role (see deploy-role.ts) and answers `{ role, previous }`. Asking for the current role
 *   is a no-op 200; a transition the role machine refuses is a 409.
 *
 * Behind the normal auth hook, and local only: the caller must connect from a loopback
 * address and not through a proxy. A colour sits behind the deploy's reverse proxy, which
 * also connects from loopback, so a request carrying forwarding headers came from outside
 * and is refused (403) even with valid credentials.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import type { DeployRole, DeployRoleOutcome } from '../../deploy-role.js';
import { isLoopbackBindHost } from '../network-auth-policy.js';
import { parseBody } from '../route-helpers.js';
import { DeployRoleChangeSchema } from '../schemas.js';

const FORWARDING_HEADERS = ['forwarded', 'x-forwarded-for', 'x-real-ip'];

export interface DeployRoutesDeps {
  changeDeployRole(role: DeployRole): Promise<DeployRoleOutcome>;
}

function isLocalRequest(req: FastifyRequest): boolean {
  const remote = req.socket.remoteAddress;
  if (!remote || !isLoopbackBindHost(remote)) return false;
  return FORWARDING_HEADERS.every((name) => req.headers[name] === undefined);
}

export function registerDeployRoutes(app: FastifyInstance, deps: DeployRoutesDeps): void {
  app.post('/api/deploy/role', async (req, reply) => {
    if (!isLocalRequest(req)) {
      return reply
        .code(403)
        .send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'The deploy role can only be changed from this machine'));
    }
    const { role } = parseBody(DeployRoleChangeSchema, req.body);
    const outcome = await deps.changeDeployRole(role);
    if (outcome.kind === 'refused') {
      return reply.code(409).send(createErrorResponse(ApiErrorCode.CONFLICT, outcome.reason));
    }
    return { success: true, data: { role: outcome.role, previous: outcome.previous } };
  });
}
