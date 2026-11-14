/** @fileoverview Opt-in owner-scoped canvas workspace, object and log routes. */
import { removeCanvasWebviews } from './webview-routes.js';
import { validateBatch, type Command } from '../../canvas/operations.js';
import type { CanvasStore } from '../../canvas/canvas-store.js';
import { randomUUID, createHash } from 'node:crypto';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { probePathKind } from '../../utils/bounded-path-probe.js';
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
import { CommentSchema, IdSchema, descendants, type Author } from '../../canvas/model.js';
import { liveEmbed } from '../../canvas/context-resolve.js';
import { readCommentAnchors, setCommentAnchor } from '../../canvas/comment-anchors.js';
import type { ElementRef } from '../../canvas/element-ref.js';
import { renderContainer, screenshotFailure } from '../../canvas/canvas-screenshot.js';
import { SseEvent } from '../sse-events.js';
import { ViewRegistry } from '../../canvas/view-registry.js';
import { MAX_VIEW_IDS, PublishedViewSchema, ViewActionSchema } from '../../canvas/view-schema.js';
import {
  checkChoice,
  conversationTool,
  currentProviders,
  registerConversationRoutes,
} from './canvas-conversation-routes.js';
import { registerTaskRoutes, taskTool } from './canvas-task-routes.js';
import { registerShellRoutes, sessionCounts } from './canvas-shell-routes.js';
import { ConversationToolSchema } from '../../canvas/conversation-schema.js';
import { LRUMap } from '../../utils/lru-map.js';
import { canvasFailure, caseFolderUnavailable } from './canvas-failure.js';
import type { Operation } from '../../canvas/operations.js';
import { MAX_OPS_PAGE_RECORDS } from '../../canvas/canvas-store.js';

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

/** Synchronous on purpose: a frame minted after the commit must never be retired by this write. */
function retireFrames(workspaceId: string, operations: Pick<Operation, 'prev'>[]): void {
  const ids = new Set(retiredEmbeds(operations));
  if (!ids.size) return;
  removeCanvasWebviews((origin) => origin.workspaceId === workspaceId && ids.has(origin.objectId));
}

/** Who a rate limit counts against: the user in multi-user mode, else the client address. */
const callerKey = (req: FastifyRequest): string => {
  const owner = ownerFor(req);
  return owner === undefined ? `ip:${req.ip}` : `user:${owner}`;
};

let previews: ReturnType<typeof import('../../canvas/link-preview.js').createLinkPreviewService> | undefined;
async function linkPreviews() {
  if (previews) return previews;
  const { createLinkPreviewService } = await import('../../canvas/link-preview.js');
  const { storeAsset } = await import('../../canvas/canvas-assets.js');
  previews = createLinkPreviewService({
    storeThumbnail: async (workspaceId, bytes, type) => {
      if (!deployRole.allows('persist')) return null;
      try {
        return (await storeAsset(workspaceId, bytes, type)).assetId;
      } catch {
        // A thumbnail that fails the byte check or the workspace quota is dropped; the title stands.
        return null;
      }
    },
  });
  return previews;
}

const uploadBuckets = new Map<string, { tokens: number; lastRefill: number }>();

/** A request id becomes deterministic op ids; a retry answers the sequences it already wrote. */
function requestIdentity(store: CanvasStore, author: Author, tool: string, args: unknown, requestId?: string) {
  if (!requestId)
    return { prefix: null, fingerprint: '', previous: [] as { opId: string; seq: number }[], reused: false };
  const prefix = `request_${requestId}_`;
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([author, tool, args]))
    .digest('hex')
    .slice(0, 24);
  const previous = store.sequencesWithPrefix(prefix);
  return {
    prefix: `${prefix}${fingerprint}_`,
    fingerprint,
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

const viewGone = (reply: FastifyReply) =>
  reply
    .code(404)
    .send(
      createErrorResponse(ApiErrorCode.NOT_FOUND, 'VIEW_GONE: that canvas view is closed or has stopped reporting')
    );
/** Applies one view command and answers it: closed view, rate limit, reused request identity, or the broadcast and commandId. */
function applyViewCommand(
  reply: FastifyReply,
  ctx: CanvasPort,
  views: ViewRegistry,
  workspaceId: string,
  viewId: string,
  canSee: (owner: string | undefined) => boolean,
  action: z.infer<typeof ViewActionSchema>,
  requestId: string | undefined
) {
  const result = views.command(workspaceId, viewId, canSee, action, requestId);
  if (!result.ok) {
    if (result.code === 'VIEW_GONE') return viewGone(reply);
    if (result.code === 'RATE_LIMITED')
      return reply
        .code(429)
        .header('Retry-After', '1')
        .send(createErrorResponse(ApiErrorCode.RATE_LIMITED, 'Too many view commands. Try again in a second.'));
    return reply
      .code(409)
      .send(createErrorResponse(ApiErrorCode.CONFLICT, 'Request identity was already used for a different command'));
  }
  if (!result.duplicate)
    ctx.broadcast(SseEvent.CanvasViewCommand, {
      workspaceId,
      viewId,
      commandId: result.commandId,
      owner: result.owner,
      command: action,
    });
  return { success: true, data: { commandId: result.commandId, duplicate: result.duplicate } };
}
const objectLabel = (o: { type: string; content: Record<string, unknown> }): string => {
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  return (text(o.content.label) || text(o.content.alt) || text(o.content.text).split('\n')[0] || o.type).slice(0, 80);
};

const VOICE_RELAY_CACHE_MS = 5000;
export function registerCanvasRoutes(app: FastifyInstance, ctx: CanvasPort, views = new ViewRegistry()): void {
  void app.register(async (scope) => {
    scope.addHook('onRequest', async (_req, reply) => {
      if (!(await ctx.canvasEnabled()))
        return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Canvas is disabled'));
    });
    scope.setErrorHandler<Error & { statusCode?: number; body?: unknown }>((error, req, reply) => {
      const reasons = commandFailure(error);
      if (reasons)
        return reply
          .code(409)
          .send({ ...createErrorResponse(ApiErrorCode.CONFLICT, 'Canvas operation rejected'), reasons });
      const code =
        error instanceof DeployRoleRefusal ? 409 : error instanceof z.ZodError ? 400 : (error.statusCode ?? 500);
      if (code >= 500) return canvasFailure(req, reply, code, error);
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
      const user = getAuthUser(req);
      const mine = readWorkspaces().filter((w) => canAccessOwned(user, w.owner));
      // `sessions` is additive: how many live sessions sit in the case, and how many wait on a person.
      const workspaces = await Promise.all(
        mine.map(async (w) => ({ ...w, sessions: await sessionCounts(ctx, user, w) }))
      );
      return { success: true, data: { workspaces } };
    });
    // `voice.relay` is the one fact the canvas needs about Claude voice: whether the relay would take a stream now.
    // The page asks on every window focus, so the answer (a read of the sign-in file) is kept for a few seconds, and
    // a read that throws is "no relay", never a failed providers answer.
    let relayAnswer: { at: number; relay: boolean } | null = null;
    const voiceRelay = async (): Promise<boolean> => {
      if (relayAnswer && Date.now() - relayAnswer.at < VOICE_RELAY_CACHE_MS) return relayAnswer.relay;
      let relay = false;
      try {
        relay = (await ctx.voiceRelayAvailable?.()) === true;
      } catch {
        relay = false;
      }
      relayAnswer = { at: Date.now(), relay };
      return relay;
    };
    scope.get('/api/canvas/assistant/providers', async () => ({
      success: true,
      data: { providers: await currentProviders(), voice: { relay: await voiceRelay() } },
    }));
    scope.post('/api/canvas/workspaces', async (req, reply) => {
      if (!deployRole.allows('persist'))
        return reply
          .code(409)
          .send(createErrorResponse(ApiErrorCode.CONFLICT, 'Only the live colour may write canvas data'));
      const { caseName } = parseBody(CanvasWorkspaceSchema, req.body);
      const path = await resolveCasePath(caseName, getAuthUser(req));
      const kind = await probePathKind(path, { pastCap: true });
      if (kind === 'unknown') return caseFolderUnavailable(req, reply, path, { pastCap: true });
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
      registerConversationRoutes(workspaceScope, ctx);
      registerTaskRoutes(workspaceScope, ctx);
      registerShellRoutes(workspaceScope, ctx);
      workspaceScope.put<{ Params: { workspaceId: string; viewId: string } }>(
        '/api/canvas/:workspaceId/views/:viewId',
        // Room for the pending elements a view reports (`contextElements`).
        { bodyLimit: 256 * 1024 },
        async (req, reply) => {
          const viewId = z.uuid().parse(req.params.viewId);
          const state = PublishedViewSchema.parse(req.body);
          const result = views.publish(req.params.workspaceId, viewId, ownerFor(req), state);
          if (!result.ok) {
            const code = result.code === 'RATE_LIMITED' ? 429 : result.code === 'FORBIDDEN' ? 404 : 409;
            if (code === 429) reply.header('Retry-After', '1');
            return reply
              .code(code)
              .send(
                createErrorResponse(
                  code === 409
                    ? ApiErrorCode.CONFLICT
                    : code === 429
                      ? ApiErrorCode.RATE_LIMITED
                      : ApiErrorCode.NOT_FOUND,
                  result.code
                )
              );
          }
          return { success: true };
        }
      );
      workspaceScope.get<{ Params: { workspaceId: string; viewId: string } }>(
        '/api/canvas/:workspaceId/views/:viewId',
        async (req, reply) => {
          const viewId = z.uuid().parse(req.params.viewId);
          const record = views.read(req.params.workspaceId, viewId, (owner) => canAccessOwned(getAuthUser(req), owner));
          return record ? { success: true, data: record } : viewGone(reply);
        }
      );
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
          const fingerprint = identity.fingerprint;
          const noopKey = envelope.requestId ? `${req.params.workspaceId}:${envelope.requestId}` : null;
          const reserved = noopKey ? noopRequests.get(noopKey) : undefined;
          if (reserved !== undefined && !identity.previous.length) {
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
            // The comment of this request is written; a first attempt that died before its anchor was stored is finished here.
            if (envelope.tool === 'canvas_comment') {
              const { element } = toolSchemas.canvas_comment.parse(envelope.arguments);
              const written = store.records(identity.previous.map((o) => o.seq))[0];
              const commentId =
                written && 'comment' in written ? CommentSchema.safeParse(written.comment).data?.id : undefined;
              if (
                element &&
                commentId &&
                liveEmbed(state, element.objectId) &&
                state.comments.some((c) => c.id === commentId && c.objectId === element.objectId) &&
                !readCommentAnchors(req.params.workspaceId, state)[commentId]
              )
                setCommentAnchor(req.params.workspaceId, state, commentId, element);
            }
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
          /** The comment this request posts and the element it is about, if any. */
          let anchor: { commentId: string; element: ElementRef | undefined } | undefined;
          switch (envelope.tool) {
            case 'canvas_link_preview': {
              const { url: link } = toolSchemas.canvas_link_preview.parse(args);
              const answer = await (await linkPreviews()).preview(req.params.workspaceId, link, callerKey(req));
              if (answer === 'rate-limited')
                return reply
                  .code(429)
                  .send(
                    createErrorResponse(
                      ApiErrorCode.RATE_LIMITED,
                      'Too many link previews in this canvas. Try again in a minute.'
                    )
                  );
              return { success: true, data: answer };
            }
            case 'canvas_capabilities':
              toolSchemas.canvas_capabilities.parse(args);
              return { success: true, data: { ...capabilities(), truncated: false } };
            case 'canvas_conversation': {
              const conversation = ConversationToolSchema.parse(args);
              if (conversation.action === 'model') {
                const canSee = (owner: string | undefined) => canAccessOwned(getAuthUser(req), owner);
                const { viewId, requestId, operation } = conversation;
                if (operation === 'read') {
                  const record = views.read(req.params.workspaceId, viewId, canSee);
                  if (!record) return viewGone(reply);
                  return {
                    success: true,
                    data: {
                      viewId,
                      choice: record.state.choice ?? { cliId: null, model: '' },
                      providers: await currentProviders(),
                    },
                  };
                }
                if (conversation.cliId === undefined)
                  return reply
                    .code(400)
                    .send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'INVALID_INPUT: set needs a cliId'));
                const model = conversation.model ?? '';
                const refused = checkChoice(await currentProviders(), conversation.cliId, model);
                if (refused) return reply.code(refused.code).send(refused.body);
                const action = ViewActionSchema.parse({ action: 'assistant-choice', cliId: conversation.cliId, model });
                return applyViewCommand(reply, ctx, views, req.params.workspaceId, viewId, canSee, action, requestId);
              }
              const outcome = await conversationTool(ctx, req, req.params.workspaceId, conversation);
              return reply.code(outcome.code).send(outcome.body);
            }
            case 'canvas_task': {
              const outcome = await taskTool(ctx, req, req.params.workspaceId, toolSchemas.canvas_task.parse(args));
              return reply.code(outcome.code).send(outcome.body);
            }
            case 'canvas_view':
            case 'canvas_context': {
              const input: z.infer<typeof toolSchemas.canvas_view> | z.infer<typeof toolSchemas.canvas_context> =
                envelope.tool === 'canvas_view'
                  ? toolSchemas.canvas_view.parse(args)
                  : toolSchemas.canvas_context.parse(args);
              const canSee = (owner: string | undefined) => canAccessOwned(getAuthUser(req), owner);
              if (input.action === 'list')
                return { success: true, data: { views: views.list(req.params.workspaceId, canSee) } };
              if (input.action === 'read') {
                const record = views.read(req.params.workspaceId, input.viewId, canSee);
                if (!record) return viewGone(reply);
                if (envelope.tool === 'canvas_view') return { success: true, data: record };
                const refs = record.state.context.flatMap((id) => {
                  const o = state.objects[id];
                  if (!o || o.deletedAt !== null) return [];
                  const inside = descendants(state, id).filter((d) => d.id !== id && d.deletedAt === null);
                  return [
                    {
                      id,
                      label: objectLabel(o),
                      type: o.type,
                      revision: o.revision,
                      descendantCount: inside.length,
                      descendants: inside.slice(0, MAX_VIEW_IDS).map((d) => ({ id: d.id, revision: d.revision })),
                    },
                  ];
                });
                const elements = (record.state.contextElements ?? []).filter((e) => liveEmbed(state, e.objectId));
                return {
                  success: true,
                  data: { viewId: input.viewId, ageMs: record.ageMs, references: refs, elements },
                };
              }
              const { viewId, requestId, ...rest } = input;
              const action = ViewActionSchema.parse(
                envelope.tool === 'canvas_context' ? { ...rest, action: `context-${rest.action}` } : rest
              );
              if ('targetIds' in action && action.targetIds && action.action !== 'context-remove')
                normalizeTargets(state, action.targetIds);
              if (action.action === 'focus' && action.targetId) normalizeTargets(state, [action.targetId]);
              return applyViewCommand(reply, ctx, views, req.params.workspaceId, viewId, canSee, action, requestId);
            }
            case 'canvas_read':
              return {
                success: true,
                data: readTree(
                  state,
                  toolSchemas.canvas_read.parse(args),
                  readCommentAnchors(req.params.workspaceId, state)
                ),
              };
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
            case 'canvas_comment': {
              const input = toolSchemas.canvas_comment.parse(args);
              if (input.element && !liveEmbed(state, input.objectId))
                return reply
                  .code(400)
                  .send(
                    createErrorResponse(
                      ApiErrorCode.INVALID_INPUT,
                      `NOT_AN_EMBED: ${input.objectId} is not a live embed, so a comment on it cannot name an element`
                    )
                  );
              const commentId = input.commentId ?? randomUUID();
              operations = [commentCommand({ ...input, commentId })];
              anchor = { commentId, element: input.element };
              break;
            }
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
              opId: `${prefix}${index}`,
            }));
          }
          const result = store.appendExpanded(operations, author);
          if (!result.ok)
            return reply.code(409).send({
              ...createErrorResponse(ApiErrorCode.CONFLICT, 'Canvas operation rejected'),
              reasons: result.reasons,
            });
          if (!result.operations.length && noopKey) noopRequests.set(noopKey, fingerprint);
          // After the commit and before the broadcast, so a page that reads the anchors on this event finds it. A
          // comment posted without an element clears what an earlier comment under the same id left behind.
          let anchored = false;
          if (anchor && result.operations.length)
            try {
              anchored = setCommentAnchor(req.params.workspaceId, store.read(), anchor.commentId, anchor.element);
            } catch {
              // The comment is written; one without its anchor is still a comment, and the answer says so.
            }
          if (result.operations.length) {
            retireFrames(req.params.workspaceId, result.operations);
            const { readWorkspaces } = await import('../../canvas/workspace-registry.js');
            ctx.broadcast(SseEvent.CanvasChanged, {
              workspaceId: req.params.workspaceId,
              seq: result.seq,
              owner: readWorkspaces().find((w) => w.id === req.params.workspaceId)?.owner,
              ...(anchor?.element && anchored ? { anchors: true } : {}),
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
            data: {
              seq: result.seq,
              sequences: result.operations.map((o) => o.seq),
              hierarchy,
              ...(anchor?.element ? { anchored } : {}),
            },
          };
        }
      );
      workspaceScope.get<{ Params: { workspaceId: string } }>(
        '/api/canvas/:workspaceId/comment-anchors',
        async (req) => {
          const state = (await ctx.canvasStores()).get(req.params.workspaceId).read();
          return { success: true, data: { anchors: readCommentAnchors(req.params.workspaceId, state) } };
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
          const { CANVAS_UPLOADS_PER_MINUTE } = await import('../../config/canvas-limits.js');
          const { takeToken } = await import('./session-routes.js');
          if (
            !takeToken(
              uploadBuckets,
              `${callerKey(req)}\n${req.params.workspaceId}`,
              CANVAS_UPLOADS_PER_MINUTE,
              Date.now()
            )
          )
            return reply
              .code(429)
              .send(
                createErrorResponse(ApiErrorCode.RATE_LIMITED, 'Too many images added at once. Try again in a minute.')
              );
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
            return { success: true, data: await storeAsset(req.params.workspaceId, req.body, declared) };
          } catch (error) {
            if (!(error instanceof AssetRefusedError)) throw error;
            return reply
              .code(error.reason === 'size' || error.reason === 'quota' ? 413 : error.reason === 'type' ? 415 : 400)
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
          // Everything async happens first. The live-embed check and the mint below then run in
          // one synchronous stretch, so no /ops append can delete or re-point the object between
          // them (appends retire frames synchronously after they commit).
          const store = (await ctx.canvasStores()).get(req.params.workspaceId);
          const { parseWebviewUrl } = await import('../webview-proxy.js');
          const { blockedWebviewHostReason } = await import('../webview-egress-policy.js');
          const { readWorkspaces } = await import('../../canvas/workspace-registry.js');
          const { openCanvasWebview } = await import('./webview-routes.js');
          const object = store.read().objects[id];
          if (!object || object.deletedAt !== null || object.type !== 'embed')
            return reply
              .code(409)
              .send(createErrorResponse(ApiErrorCode.CONFLICT, 'Only a live embed object has a page to show'));
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
          const opened = openCanvasWebview({
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
            // Asynchronous and bounded: an asset larger than what the screenshot may still embed is
            // never read at all.
            const readAsset = async (assetId: string, maxBytes: number) => {
              const asset = findAsset(req.params.workspaceId, assetId);
              if (!asset || asset.size > maxBytes) return null;
              const bytes = await readFile(asset.path);
              return bytes.length > maxBytes ? null : { mime: asset.mime, bytes };
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
            if (failure.status >= 500) return canvasFailure(req, reply, failure.status, error, failure.message);
            return reply.code(failure.status).send(createErrorResponse(ApiErrorCode.NOT_FOUND, failure.message));
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
            if (action === 'ops') {
              const batch = parseBody(CanvasBatchSchema, req.body).operations;
              const missing = await missingAssets(req.params.workspaceId, batch as Command[]);
              if (missing.length)
                return reply.code(409).send({
                  ...createErrorResponse(ApiErrorCode.CONFLICT, 'Canvas operation rejected'),
                  reasons: missing.map((operation) => ({
                    code: 'NOT_FOUND',
                    objectId: operation.objectId,
                    message: 'The image is not stored in this workspace; upload it first',
                  })),
                });
              result = store.append(batch, author);
            } else {
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
            if (result.ok && result.operations.length) retireFrames(req.params.workspaceId, result.operations);
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
