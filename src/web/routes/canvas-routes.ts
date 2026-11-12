/** @fileoverview Opt-in owner-scoped canvas workspace, object and log routes. */
import { validateBatch, type Command } from '../../canvas/operations.js';
import type { CanvasStore } from '../../canvas/canvas-store.js';
import { randomUUID, createHash } from 'node:crypto';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { probePathKind, describeUnknownPath } from '../../utils/bounded-path-probe.js';
import { z } from 'zod';
import type { CanvasPort } from '../ports/canvas-port.js';
import { abortOnClientHangUp, canAccessOwned, getAuthUser, ownerFor, parseBody } from '../route-helpers.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { deployRole, DeployRoleRefusal } from '../../deploy-role.js';
import { resolveCasePath } from './case-routes.js';
import { loadCanvasSchemas, CanvasWorkspaceSchema } from '../schemas.js';
import {
  toolSchemas,
  canvasToolNames,
  arrange,
  transform,
  historyCommands,
  capabilities,
  commandFailure,
  normalizeTargets,
  deferCreatedLocks,
  commentCommand,
} from '../../canvas/commands.js';
import { readTree, searchObjects, queryObjects, cycleDiagnostics, boundedCanvasData } from '../../canvas/queries.js';
import { IdSchema, type Author } from '../../canvas/model.js';
import { renderContainer, screenshotFailure } from '../../canvas/canvas-screenshot.js';
import { SseEvent } from '../sse-events.js';

/** A request id becomes deterministic op ids; a retry answers the sequences it already wrote. */
function requestIdentity(store: CanvasStore, author: Author, tool: string, args: unknown, requestId?: string) {
  if (!requestId) return { prefix: null, previous: [] as { opId: string; seq: number }[], reused: false };
  const prefix = `request_${requestId}_`;
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([author, tool, args]))
    .digest('hex')
    .slice(0, 24);
  const previous = store.sequencesWithPrefix(prefix);
  return {
    prefix: `${prefix}${fingerprint}_`,
    previous,
    reused: previous.some((o) => !o.opId.startsWith(`${prefix}${fingerprint}_`)),
  };
}

/** What reverting one author would do, validated against the current state without writing. */
function revertPreview(store: CanvasStore, target: Author, actor: Author) {
  const plan = store.revertPlan(target);
  const check = plan.commands.length
    ? validateBatch(store.read(), plan.commands, actor, Date.now())
    : { ok: true as const };
  return { ...plan.summary, refused: check.ok ? [] : check.reasons };
}

export function registerCanvasRoutes(app: FastifyInstance, ctx: CanvasPort): void {
  void app.register(async (scope) => {
    scope.addHook('onRequest', async (_req, reply) => {
      if (!(await ctx.canvasEnabled()))
        return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Canvas is disabled'));
    });
    scope.setErrorHandler<Error & { statusCode?: number; body?: unknown }>((error, _req, reply) => {
      const reasons = commandFailure(error);
      if (reasons)
        return reply
          .code(409)
          .send({ ...createErrorResponse(ApiErrorCode.CONFLICT, 'Canvas operation rejected'), reasons });
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
      const kind = await probePathKind(path, { pastCap: true });
      if (kind === 'unknown')
        return reply
          .code(503)
          .send(
            createErrorResponse(
              ApiErrorCode.OPERATION_FAILED,
              describeUnknownPath('Case folder', path, { pastCap: true })
            )
          );
      if (kind !== 'directory')
        return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Case not found'));
      const { workspaceForCase } = await import('../../canvas/workspace-registry.js');
      return { success: true, data: { workspace: workspaceForCase(caseName, ownerFor(req)) } };
    });
    void scope.register(async (workspaceScope) => {
      workspaceScope.addHook('preHandler', async (req, reply) => {
        let { workspaceId } = z.object({ workspaceId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/) }).parse(req.params);
        const { readWorkspaces } = await import('../../canvas/workspace-registry.js');
        const header = req.headers['x-codeman-parent-session'];
        if (header !== undefined || workspaceId === 'current') {
          const raw = typeof header === 'string' ? header.trim() : '';
          const matches = [...ctx.sessions.values()].filter(
            (s) =>
              canAccessOwned(getAuthUser(req), s.owner) && (s.id === raw || (raw.length >= 8 && s.id.startsWith(raw)))
          );
          const session = matches.find((s) => s.id === raw) ?? (matches.length === 1 ? matches[0] : undefined);
          if (!session)
            return reply
              .code(400)
              .send(
                createErrorResponse(
                  ApiErrorCode.INVALID_INPUT,
                  'Start this MCP server inside a Codeman case session so X-Codeman-Parent-Session resolves to your session.'
                )
              );
          let selected: ReturnType<typeof readWorkspaces>[number] | undefined;
          let length = -1;
          for (const w of readWorkspaces()) {
            if (w.owner !== session.owner || !canAccessOwned(getAuthUser(req), w.owner)) continue;
            const user = getAuthUser(req);
            const caseUser = w.owner
              ? { username: w.owner, role: w.owner === user.username ? user.role : ('user' as const) }
              : user;
            const path = resolve(await resolveCasePath(w.caseName, caseUser));
            const rel = relative(path, resolve(session.workingDir));
            if (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel) && path.length > length) {
              selected = w;
              length = path.length;
            }
          }
          if (!selected)
            return reply
              .code(400)
              .send(
                createErrorResponse(
                  ApiErrorCode.INVALID_INPUT,
                  'Open a Codeman case, create its canvas workspace, and start the agent in that case folder. This session is outside a registered canvas case.'
                )
              );
          if (workspaceId !== 'current' && workspaceId !== selected.id)
            return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Workspace not found'));
          workspaceId = selected.id;
          // Keep :id and every other param. Replacing the object drops them.
          Object.assign(req.params as Record<string, unknown>, { workspaceId });
          req.canvasAuthor = { kind: 'agent', sessionId: session.id };
        }
        const workspace = readWorkspaces().find((w) => w.id === workspaceId);
        if (!workspace || !canAccessOwned(getAuthUser(req), workspace.owner))
          return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Workspace not found'));
      });
      workspaceScope.post<{ Params: { workspaceId: string } }>(
        '/api/canvas/:workspaceId/command',
        { bodyLimit: 2 * 1024 * 1024 },
        async (req, reply) => {
          const envelope = z
            .object({ tool: z.enum(canvasToolNames), arguments: z.unknown(), requestId: z.uuid().optional() })
            .strict()
            .parse(req.body);
          const store = (await ctx.canvasStores()).get(req.params.workspaceId);
          const state = store.read();
          const author: Author = req.canvasAuthor ?? { kind: 'human', userId: getAuthUser(req).username };
          const identity = requestIdentity(store, author, envelope.tool, envelope.arguments, envelope.requestId);
          const prefix = identity.prefix;
          if (identity.previous.length) {
            if (identity.reused)
              return reply
                .code(409)
                .send(
                  createErrorResponse(
                    ApiErrorCode.CONFLICT,
                    'Request identity was already used for a different command'
                  )
                );
            return {
              success: true,
              data: {
                seq: state.seq,
                sequences: identity.previous.map((o) => o.seq),
                hierarchy: boundedCanvasData([]),
              },
            };
          }
          const args = envelope.arguments;
          let operations: Command[] | undefined;
          switch (envelope.tool) {
            case 'canvas_capabilities':
              toolSchemas.canvas_capabilities.parse(args);
              return { success: true, data: { ...capabilities(), truncated: false } };
            case 'canvas_read':
              return { success: true, data: readTree(state, toolSchemas.canvas_read.parse(args)) };
            case 'canvas_search':
              return {
                success: true,
                data: boundedCanvasData(
                  searchObjects(state, toolSchemas.canvas_search.parse(args)),
                  cycleDiagnostics(state)
                ),
              };
            case 'canvas_query':
              return {
                success: true,
                data: boundedCanvasData(
                  queryObjects(state, toolSchemas.canvas_query.parse(args)),
                  cycleDiagnostics(state)
                ),
              };
            case 'canvas_create':
              operations = toolSchemas.canvas_create.parse(args).operations;
              break;
            case 'canvas_update':
              operations = toolSchemas.canvas_update.parse(args).operations;
              break;
            case 'canvas_delete':
              operations = toolSchemas.canvas_delete.parse(args).operations;
              break;
            case 'canvas_arrange':
              operations = arrange(state, toolSchemas.canvas_arrange.parse(args));
              break;
            case 'canvas_comment':
              operations = [commentCommand(toolSchemas.canvas_comment.parse(args))];
              break;
            case 'canvas_transform':
              operations = transform(state, toolSchemas.canvas_transform.parse(args));
              break;
            case 'canvas_lock': {
              const input = toolSchemas.canvas_lock.parse(args);
              operations = normalizeTargets(state, input.targetIds).map((o) =>
                input.mode === 'unlock'
                  ? { kind: 'unlock' as const, objectId: o.id, opId: randomUUID() }
                  : { kind: 'lock' as const, objectId: o.id, opId: randomUUID(), patch: { mode: input.mode } }
              );
              break;
            }
            case 'canvas_history': {
              const input = toolSchemas.canvas_history.parse(args);
              if (input.action === 'read')
                return { success: true, data: boundedCanvasData(store.operations(input.since)) };
              if (input.action === 'authors') return { success: true, data: boundedCanvasData(store.authors()) };
              if (input.action === 'preview')
                return { success: true, data: boundedCanvasData(revertPreview(store, input.author, author)) };
              operations =
                input.action === 'revert'
                  ? store.revertCommands(author)
                  : historyCommands(state, store.records(input.sequences), input.sequences, author);
              break;
            }
          }
          if (!operations?.length)
            // Nothing to write: no log line, no revision. A retry evaluates to the same no-op.
            return {
              success: true,
              data: { seq: state.seq, sequences: [], noop: true, hierarchy: boundedCanvasData([]) },
            };
          operations = deferCreatedLocks(operations);
          if (prefix) {
            operations = operations.map((operation, index) => ({
              ...operation,
              opId: `${prefix}${index}`,
            }));
          }
          const result = store.appendExpanded(operations, author);
          if (!result.ok)
            return reply.code(409).send({
              ...createErrorResponse(ApiErrorCode.CONFLICT, 'Canvas operation rejected'),
              reasons: result.reasons,
            });
          if (result.operations.length) {
            const { readWorkspaces } = await import('../../canvas/workspace-registry.js');
            ctx.broadcast(SseEvent.CanvasChanged, {
              workspaceId: req.params.workspaceId,
              seq: result.seq,
              owner: readWorkspaces().find((w) => w.id === req.params.workspaceId)?.owner,
            });
          }
          const changed = new Map(
            result.operations.flatMap((operation) =>
              operation.prev.map((change) => [change.objectId, change.after] as const)
            )
          );
          const hierarchy = boundedCanvasData(
            [...changed.values()].map(({ id, parentId, order, revision, deletedAt }) => ({
              id,
              parentId,
              order,
              revision,
              deletedAt,
            }))
          );
          return {
            success: true,
            data: { seq: result.seq, sequences: result.operations.map((o) => o.seq), hierarchy },
          };
        }
      );
      workspaceScope.get<{ Params: { workspaceId: string; id: string } }>(
        '/api/canvas/:workspaceId/objects/:id/screenshot',
        async (req, reply) => {
          const { id } = z.object({ id: IdSchema }).parse(req.params);
          const { theme } = z.object({ theme: z.enum(['dark', 'light']).optional() }).parse(req.query);
          const hangup = abortOnClientHangUp(reply);
          try {
            const state = (await ctx.canvasStores()).get(req.params.workspaceId).read();
            const rendered = await renderContainer(state, id, { theme, signal: hangup.signal });
            return reply
              .header('Cache-Control', 'no-store')
              .header('X-Canvas-Screenshot-Meta', JSON.stringify(rendered.meta))
              .type('image/png')
              .send(rendered.png);
          } catch (error) {
            if (hangup.signal.aborted || reply.sent) return;
            const failure = screenshotFailure(error);
            return reply
              .code(failure.status)
              .send(
                createErrorResponse(
                  failure.status === 404 ? ApiErrorCode.NOT_FOUND : ApiErrorCode.OPERATION_FAILED,
                  failure.message
                )
              );
          }
        }
      );
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
      workspaceScope.get<{ Params: { workspaceId: string } }>('/api/canvas/:workspaceId/ops', async (req, reply) => {
        const { since } = z.object({ since: z.coerce.number().int().nonnegative().default(0) }).parse(req.query);
        const store = (await ctx.canvasStores()).get(req.params.workspaceId);
        const page = store.page(since);
        // A capped page omits `seq`: a cursor-unaware client fails its parse and refetches the snapshot
        // instead of adopting a sequence it has not replayed up to.
        const tail = page.more ? `"more":true,"next":${page.next}` : `"seq":${store.seq},"more":false`;
        return reply
          .type('application/json; charset=utf-8')
          .send(`{"success":true,"data":{${tail},"operations":[${page.records.join(',')}]}}`);
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
            const author: Author = req.canvasAuthor ?? { kind: 'human', userId: getAuthUser(req).username };
            let summary: ReturnType<CanvasStore['revertPlan']>['summary'] | undefined;
            let result;
            if (action === 'ops') result = store.append(parseBody(CanvasBatchSchema, req.body).operations, author);
            else {
              const body = parseBody(CanvasRevertSchema, req.body);
              const identity = requestIdentity(store, author, 'revert', body.author, body.requestId);
              if (identity.reused)
                return reply
                  .code(409)
                  .send(
                    createErrorResponse(
                      ApiErrorCode.CONFLICT,
                      'Request identity was already used for a different revert'
                    )
                  );
              if (identity.previous.length)
                return {
                  success: true,
                  data: { seq: store.seq, sequences: identity.previous.map((o) => o.seq), replayed: true },
                };
              const plan = store.revertPlan(body.author);
              summary = plan.summary;
              const commands = identity.prefix
                ? plan.commands.map((command, index) => ({ ...command, opId: `${identity.prefix}${index}` }))
                : plan.commands;
              result = store.revert(body.author, author, commands);
            }
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
            return {
              success: true,
              data: { seq, sequences: result.sequences, ...(summary ? { summary: boundedCanvasData(summary) } : {}) },
            };
          }
        );
      }
    });
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    canvasAuthor?: Author;
  }
}
