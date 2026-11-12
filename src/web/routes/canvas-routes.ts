/** @fileoverview Opt-in owner-scoped canvas workspace, object and log routes. */
import type { Command } from '../../canvas/operations.js';
import { randomUUID, createHash } from 'node:crypto';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { readFileSync } from 'node:fs';
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
} from '../../canvas/commands.js';
import { readTree, searchObjects, queryObjects, cycleDiagnostics, boundedCanvasData } from '../../canvas/queries.js';
import { IdSchema, type Author } from '../../canvas/model.js';
import { renderContainer, screenshotFailure } from '../../canvas/canvas-screenshot.js';
import { SseEvent } from '../sse-events.js';
import { LRUMap } from '../../utils/lru-map.js';
import type { Operation } from '../../canvas/operations.js';
import { MAX_OPS_PAGE_RECORDS } from '../../canvas/canvas-store.js';
import type { CanvasStores } from '../../canvas/canvas-store.js';

/** A no-op answer writes nothing, so its request identity is held here instead of in the log. */
const noopRequests = new LRUMap<string, string>({ maxSize: 2000 });

/** Asset ids a batch would reference that this workspace does not hold. */
async function missingAssets(workspaceId: string, operations: Command[]): Promise<Command[]> {
  const { findAsset } = await import('../../canvas/canvas-assets.js');
  return operations.filter((operation) => {
    if (operation.kind !== 'create' && operation.kind !== 'update' && operation.kind !== 'revert') return false;
    const content = operation.patch.content as Record<string, unknown> | undefined;
    return [content?.assetId, content?.thumbnailAssetId].some(
      (id) => typeof id === 'string' && !findAsset(workspaceId, id)
    );
  });
}

/** Embed objects whose live frame must go: deleted, turned back into a link, or pointed at another URL. */
export function retiredEmbeds(operations: Pick<Operation, 'prev'>[]): string[] {
  const ids = new Set<string>();
  for (const operation of operations)
    for (const { objectId, before, after } of operation.prev)
      if (
        before?.type === 'embed' &&
        (after.type !== 'embed' || after.deletedAt !== null || after.content.url !== before.content.url)
      )
        ids.add(objectId);
  return [...ids];
}

async function retireFrames(workspaceId: string, operations: Pick<Operation, 'prev'>[]): Promise<void> {
  const ids = new Set(retiredEmbeds(operations));
  if (!ids.size) return;
  const { removeCanvasWebviews } = await import('./webview-routes.js');
  await removeCanvasWebviews((origin) => origin.workspaceId === workspaceId && ids.has(origin.objectId));
}

/** Boot sweep, like the session-origin one: drop frame records whose object is no longer a live embed. */
export async function sweepCanvasWebviews(stores: () => Promise<CanvasStores>): Promise<void> {
  const { canvasWebviewOrigins, removeCanvasWebviews } = await import('./webview-routes.js');
  const origins = await canvasWebviewOrigins();
  if (!origins.length) return;
  const { readWorkspaces } = await import('../../canvas/workspace-registry.js');
  const known = new Set(readWorkspaces().map((w) => w.id));
  const live = new Map<string, Set<string>>();
  for (const workspaceId of new Set(origins.map((o) => o.workspaceId))) {
    if (!known.has(workspaceId)) continue;
    const state = (await stores()).get(workspaceId).read();
    live.set(
      workspaceId,
      new Set(
        Object.values(state.objects)
          .filter((o) => o.type === 'embed' && o.deletedAt === null)
          .map((o) => o.id)
      )
    );
  }
  await removeCanvasWebviews((origin) => !live.get(origin.workspaceId)?.has(origin.objectId));
}

async function linkPreview(workspaceId: string, url: string) {
  const { fetchLinkPreview } = await import('../../canvas/link-preview.js');
  const { storeAsset } = await import('../../canvas/canvas-assets.js');
  const { thumbnail, ...preview } = await fetchLinkPreview(url);
  let thumbnailAssetId: string | undefined;
  if (thumbnail && deployRole.allows('persist'))
    try {
      thumbnailAssetId = storeAsset(workspaceId, thumbnail.bytes, thumbnail.type).assetId;
    } catch {
      /* A thumbnail that fails the byte check is dropped; the title still stands. */
    }
  return { ...preview, ...(thumbnailAssetId ? { thumbnailAssetId } : {}) };
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
    scope.addContentTypeParser(
      ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/octet-stream'],
      { parseAs: 'buffer', bodyLimit: 9 * 1024 * 1024 },
      (_req, body, done) => done(null, body)
    );
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
          const prefix = envelope.requestId ? `request_${envelope.requestId}_` : null;
          const fingerprint = createHash('sha256')
            .update(JSON.stringify([author, envelope.tool, envelope.arguments]))
            .digest('hex')
            .slice(0, 24);
          const previous = prefix ? store.sequencesWithPrefix(prefix) : [];
          const noopKey = envelope.requestId ? `${req.params.workspaceId}:${envelope.requestId}` : null;
          const reserved = noopKey ? noopRequests.get(noopKey) : undefined;
          if (reserved !== undefined && !previous.length) {
            if (reserved !== fingerprint)
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
              data: { seq: state.seq, sequences: [], noop: true, hierarchy: boundedCanvasData([]) },
            };
          }
          if (previous.length) {
            if (!previous.every((o) => o.opId.startsWith(`${prefix}${fingerprint}_`)))
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
              data: { seq: state.seq, sequences: previous.map((o) => o.seq), hierarchy: boundedCanvasData([]) },
            };
          }
          const args = envelope.arguments;
          let operations: Command[] | undefined;
          switch (envelope.tool) {
            case 'canvas_link_preview': {
              const { url: link } = toolSchemas.canvas_link_preview.parse(args);
              return { success: true, data: await linkPreview(req.params.workspaceId, link) };
            }
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
              if (input.action === 'read') {
                const records = store.operations(input.since, MAX_OPS_PAGE_RECORDS);
                const more = records.length === MAX_OPS_PAGE_RECORDS && (records.at(-1)?.seq ?? 0) < store.seq;
                return {
                  success: true,
                  data: { ...(boundedCanvasData(records) as object), more, next: records.at(-1)?.seq ?? input.since },
                };
              }
              operations =
                input.action === 'revert'
                  ? store.revertCommands(author)
                  : historyCommands(state, store.records(input.sequences), input.sequences, author);
              break;
            }
          }
          if (!operations?.length) {
            // Nothing to write: no log line, no revision. The identity is held in memory so a retry
            // answers the same no-op and a different payload under it is refused.
            if (noopKey) noopRequests.set(noopKey, fingerprint);
            return {
              success: true,
              data: { seq: state.seq, sequences: [], noop: true, hierarchy: boundedCanvasData([]) },
            };
          }
          operations = deferCreatedLocks(operations);
          const missing = await missingAssets(req.params.workspaceId, operations);
          if (missing.length)
            return reply.code(409).send({
              ...createErrorResponse(ApiErrorCode.CONFLICT, 'Canvas operation rejected'),
              reasons: missing.map((operation) => ({
                code: 'NOT_FOUND',
                objectId: operation.objectId,
                message: 'The image is not stored in this workspace; upload it first',
              })),
            });
          if (prefix) {
            operations = operations.map((operation, index) => ({
              ...operation,
              opId: `${prefix}${fingerprint}_${index}`,
            }));
          }
          const result = store.appendExpanded(operations, author);
          if (!result.ok)
            return reply.code(409).send({
              ...createErrorResponse(ApiErrorCode.CONFLICT, 'Canvas operation rejected'),
              reasons: result.reasons,
            });
          if (!result.operations.length && noopKey) noopRequests.set(noopKey, fingerprint);
          if (result.operations.length) {
            await retireFrames(req.params.workspaceId, result.operations);
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
      workspaceScope.post<{ Params: { workspaceId: string } }>(
        '/api/canvas/:workspaceId/assets',
        { bodyLimit: 9 * 1024 * 1024 },
        async (req, reply) => {
          if (!deployRole.allows('persist'))
            return reply
              .code(409)
              .send(createErrorResponse(ApiErrorCode.CONFLICT, 'Only the live colour may write canvas data'));
          const { storeAsset, AssetRefusedError } = await import('../../canvas/canvas-assets.js');
          if (!Buffer.isBuffer(req.body))
            return reply
              .code(415)
              .send(
                createErrorResponse(
                  ApiErrorCode.INVALID_INPUT,
                  'Send the image bytes with an image Content-Type (PNG, JPEG, GIF or WebP)'
                )
              );
          const declared =
            req.headers['content-type'] === 'application/octet-stream'
              ? z.object({ type: z.string().max(40).optional() }).parse(req.query).type
              : req.headers['content-type'];
          try {
            return { success: true, data: storeAsset(req.params.workspaceId, req.body, declared) };
          } catch (error) {
            if (!(error instanceof AssetRefusedError)) throw error;
            return reply
              .code(error.reason === 'size' ? 413 : error.reason === 'type' ? 415 : 400)
              .send({ ...createErrorResponse(ApiErrorCode.INVALID_INPUT, error.message), refusal: error.reason });
          }
        }
      );
      workspaceScope.get<{ Params: { workspaceId: string; assetId: string } }>(
        '/api/canvas/:workspaceId/assets/:assetId',
        async (req, reply) => {
          const { findAsset } = await import('../../canvas/canvas-assets.js');
          const asset = findAsset(req.params.workspaceId, req.params.assetId);
          if (!asset) return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Image not found'));
          const { sendFileBody, localFileSource } = await import('./file-routes.js');
          reply
            .header('Content-Type', asset.mime)
            .header('Cache-Control', 'private, max-age=31536000, immutable')
            .header('X-Content-Type-Options', 'nosniff');
          sendFileBody(reply, asset.size, req.headers.range, localFileSource(asset.path));
          return reply;
        }
      );
      workspaceScope.post<{ Params: { workspaceId: string; id: string } }>(
        '/api/canvas/:workspaceId/objects/:id/frame',
        async (req, reply) => {
          const { id } = z.object({ id: IdSchema }).parse(req.params);
          const object = (await ctx.canvasStores()).get(req.params.workspaceId).read().objects[id];
          if (!object || object.deletedAt !== null || object.type !== 'embed')
            return reply
              .code(409)
              .send(createErrorResponse(ApiErrorCode.CONFLICT, 'Only a live embed object has a page to show'));
          const { parseWebviewUrl } = await import('../webview-proxy.js');
          const { blockedWebviewHostReason } = await import('../webview-egress-policy.js');
          const target = typeof object.content.url === 'string' ? parseWebviewUrl(object.content.url) : null;
          const blocked = target ? blockedWebviewHostReason(target.hostname) : null;
          if (!target || blocked)
            return reply
              .code(400)
              .send(
                createErrorResponse(
                  ApiErrorCode.INVALID_INPUT,
                  blocked ? 'This address cannot be embedded' : 'The embed has no web address'
                )
              );
          const { readWorkspaces } = await import('../../canvas/workspace-registry.js');
          const { openCanvasWebview } = await import('./webview-routes.js');
          const opened = await openCanvasWebview({
            workspaceId: req.params.workspaceId,
            objectId: id,
            url: target.href,
            name: typeof object.content.label === 'string' && object.content.label ? object.content.label : target.host,
            owner: readWorkspaces().find((w) => w.id === req.params.workspaceId)?.owner,
            basePath: ctx.basePath ?? '',
          });
          return { success: true, data: opened };
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
            const { findAsset } = await import('../../canvas/canvas-assets.js');
            const readAsset = (assetId: string) => {
              const asset = findAsset(req.params.workspaceId, assetId);
              return asset ? { mime: asset.mime, bytes: readFileSync(asset.path) } : null;
            };
            const rendered = await renderContainer(state, id, { theme, signal: hangup.signal, readAsset });
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
            if (action === 'ops') {
              const missing = await missingAssets(
                req.params.workspaceId,
                parseBody(CanvasBatchSchema, req.body).operations as Command[]
              );
              if (missing.length)
                return reply.code(409).send({
                  ...createErrorResponse(ApiErrorCode.CONFLICT, 'Canvas operation rejected'),
                  reasons: missing.map((operation) => ({
                    code: 'NOT_FOUND',
                    objectId: operation.objectId,
                    message: 'The image is not stored in this workspace; upload it first',
                  })),
                });
            }
            const result =
              action === 'ops'
                ? store.append(parseBody(CanvasBatchSchema, req.body).operations, author)
                : store.revert(parseBody(CanvasRevertSchema, req.body).author, author);
            if (result.ok && result.operations.length) await retireFrames(req.params.workspaceId, result.operations);
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
            return { success: true, data: { seq, sequences: result.sequences } };
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
