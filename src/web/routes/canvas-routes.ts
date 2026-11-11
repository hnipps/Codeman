/** @fileoverview Opt-in owner-scoped canvas workspace, object and log routes. */
import type { FastifyInstance } from 'fastify';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import type { CanvasPort } from '../ports/canvas-port.js';
import { canAccessOwned, getAuthUser, ownerFor, parseBody } from '../route-helpers.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { deployRole, DeployRoleRefusal } from '../../deploy-role.js';
import { resolveCasePath } from './case-routes.js';
import { loadCanvasSchemas, CanvasWorkspaceSchema } from '../schemas.js';
import { SseEvent } from '../sse-events.js';

export function registerCanvasRoutes(app: FastifyInstance, ctx: CanvasPort): void {
  void app.register(async (scope) => {
    scope.addHook('onRequest', async (_req, reply) => {
      if (!(await ctx.canvasEnabled()))
        return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Canvas is disabled'));
    });
    scope.setErrorHandler<Error & { statusCode?: number; body?: unknown }>((error, _req, reply) => {
      const code =
        error instanceof DeployRoleRefusal ? 409 : error instanceof z.ZodError ? 400 : (error.statusCode ?? 500);
      return reply
        .code(code)
        .send(
          'body' in error
            ? error.body
            : createErrorResponse(
                code === 409
                  ? ApiErrorCode.CONFLICT
                  : code === 400
                    ? ApiErrorCode.INVALID_INPUT
                    : ApiErrorCode.OPERATION_FAILED,
                error.message
              )
        );
    });
    scope.get('/api/canvas/workspaces', async (req) => {
      const { readWorkspaces } = await import('../../canvas/workspace-registry.js');
      return {
        success: true,
        data: { workspaces: readWorkspaces().filter((w) => canAccessOwned(getAuthUser(req), w.owner)) },
      };
    });
    scope.post('/api/canvas/workspaces', async (req, reply) => {
      if (!deployRole.allows('persist'))
        return reply
          .code(409)
          .send(createErrorResponse(ApiErrorCode.CONFLICT, 'Only the live colour may write canvas data'));
      const { caseName } = parseBody(CanvasWorkspaceSchema, req.body);
      const path = await resolveCasePath(caseName, getAuthUser(req));
      if (
        !(await stat(path).then(
          (s) => s.isDirectory(),
          () => false
        ))
      )
        return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Case not found'));
      const { workspaceForCase } = await import('../../canvas/workspace-registry.js');
      return { success: true, data: { workspace: workspaceForCase(caseName, ownerFor(req)) } };
    });
    void scope.register(async (workspaceScope) => {
      workspaceScope.addHook('preHandler', async (req, reply) => {
        const { workspaceId } = z.object({ workspaceId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/) }).parse(req.params);
        const { readWorkspaces } = await import('../../canvas/workspace-registry.js');
        const workspace = readWorkspaces().find((w) => w.id === workspaceId);
        if (!workspace || !canAccessOwned(getAuthUser(req), workspace.owner))
          return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Workspace not found'));
      });
      workspaceScope.get<{ Params: { workspaceId: string } }>('/api/canvas/:workspaceId/objects', async (req) => {
        const { root, includeDeleted } = z
          .object({ root: z.string().optional(), includeDeleted: z.enum(['true', 'false']).optional() })
          .parse(req.query);
        const state = (await ctx.canvasStores()).get(req.params.workspaceId).read();
        const { descendants } = await import('../../canvas/model.js');
        const objects = (root ? descendants(state, root) : Object.values(state.objects))
          .filter((o) => includeDeleted === 'true' || o.deletedAt === null)
          .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        const ids = new Set(objects.map((o) => o.id));
        return {
          success: true,
          data: { seq: state.seq, objects, comments: state.comments.filter((c) => ids.has(c.objectId)) },
        };
      });
      workspaceScope.get<{ Params: { workspaceId: string } }>('/api/canvas/:workspaceId/ops', async (req) => {
        const { since } = z.object({ since: z.coerce.number().int().nonnegative().default(0) }).parse(req.query);
        const store = (await ctx.canvasStores()).get(req.params.workspaceId);
        return { success: true, data: { seq: store.read().seq, operations: store.operations(since) } };
      });
      for (const action of ['ops', 'revert'] as const) {
        workspaceScope.post<{ Params: { workspaceId: string } }>(
          `/api/canvas/:workspaceId/${action}`,
          { bodyLimit: 2 * 1024 * 1024 },
          async (req, reply) => {
            if (!deployRole.allows('persist'))
              return reply
                .code(409)
                .send(createErrorResponse(ApiErrorCode.CONFLICT, 'Only the live colour may write canvas data'));
            const { CanvasBatchSchema, CanvasRevertSchema } = await loadCanvasSchemas();
            const store = (await ctx.canvasStores()).get(req.params.workspaceId);
            const author = { kind: 'human', userId: getAuthUser(req).username } as const;
            const result =
              action === 'ops'
                ? store.append(parseBody(CanvasBatchSchema, req.body).operations, author)
                : store.revert(parseBody(CanvasRevertSchema, req.body).author, author);
            if (!result.ok)
              return reply.code(409).send({
                ...createErrorResponse(ApiErrorCode.CONFLICT, 'Canvas operation rejected'),
                reasons: result.reasons,
              });
            const seq = result.seq;
            if (result.operations.length) {
              const { readWorkspaces } = await import('../../canvas/workspace-registry.js');
              const workspace = readWorkspaces().find((w) => w.id === req.params.workspaceId);
              ctx.broadcast(SseEvent.CanvasChanged, {
                workspaceId: req.params.workspaceId,
                seq,
                owner: workspace?.owner,
              });
            }
            return { success: true, data: { seq } };
          }
        );
      }
    });
  });
}
