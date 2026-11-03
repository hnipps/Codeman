/**
 * @fileoverview Rollback from the web UI, through the deploy supervisor's command line.
 *
 * - `GET  /api/deploy/overview`  what is live, the releases kept on disk, the last deploys, whether one runs
 * - `POST /api/deploy/rollback`  `{ target }` queues a rollback and answers 202 `{ requestId }`
 *
 * Behind the normal auth hook only, since people reach these through the deploy's proxy. Both answer
 * "not configured" (404) unless `CODEMAN_SUPERVISOR_CLI` names the command. A rollback is refused
 * from any colour but the live one, which is the colour the browser is talking to and the one
 * a successful rollback stops.
 */

import type { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { deployRole } from '../../deploy-role.js';
import { DeployControlError, readOverview, requestRollback, supervisorCli } from '../../deploy-control.js';
import type { DeployOverview } from '../../deploy-control.js';
import { isAdmin, parseBody } from '../route-helpers.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { DeployRollbackSchema } from '../schemas.js';

const NOT_CONFIGURED = 'Deploy control is not configured on this install';

export function registerDeployControlRoutes(app: FastifyInstance): void {
  app.get('/api/deploy/overview', async (_req, reply) => {
    const cli = supervisorCli();
    if (!cli) return { success: true, data: { configured: false } satisfies DeployOverview };
    try {
      return { success: true, data: await readOverview(cli) };
    } catch (err) {
      const message = err instanceof DeployControlError ? err.message : 'The deploy supervisor failed';
      return reply.code(502).send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, message));
    }
  });

  app.post('/api/deploy/rollback', async (req, reply) => {
    if (isMultiUserMode() && !isAdmin(req)) {
      return reply.code(403).send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'Only an admin can roll back'));
    }
    const cli = supervisorCli();
    if (!cli) return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, NOT_CONFIGURED));
    if (!deployRole.allows('requestDeploy')) {
      return reply
        .code(409)
        .send(
          createErrorResponse(
            ApiErrorCode.CONFLICT,
            `This Codeman is the ${deployRole.current} deploy colour; a rollback can only be requested from the live one`
          )
        );
    }
    const { target } = parseBody(DeployRollbackSchema, req.body);
    try {
      const { requestId } = await requestRollback(cli, target);
      return reply.code(202).send({ success: true, data: { requestId } });
    } catch (err) {
      const message = err instanceof DeployControlError ? err.message : 'The rollback could not be requested';
      return reply.code(502).send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, message));
    }
  });
}
