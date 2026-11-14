/**
 * @fileoverview Stored prototypes of a canvas workspace: publish, list, read, remove, check, and the
 * one path their files are served on.
 *
 * Routes (workspace-scoped like the asset routes, behind the canvas setting):
 * - `POST   /api/canvas/:workspaceId/prototypes` — store a version and, in the same request, append the
 *   ONE canvas operation that shows it: a new `embed`, or the address of an existing prototype embed.
 * - `GET    /api/canvas/:workspaceId/prototypes` and `.../prototypes/:id` — records, versions, and the
 *   objects that show each one.
 * - `DELETE /api/canvas/:workspaceId/prototypes/:id` — refused while a live embed shows it.
 * - `POST   /api/canvas/:workspaceId/prototypes/:id/check` — a picture of one version alone in the
 *   headless browser, with its console errors.
 * - `GET    /canvas-prototype/:cap/*` (capability) — the files of exactly one version, sandboxed.
 *
 * ⚠️ `/canvas-prototype/` is the ONLY path that serves a prototype's files to a browser, and it serves
 * only while the workspace lists an open view (`ViewRegistry`): each request re-checks, and a
 * request that finds none revokes its capability. The frame route in canvas-routes.ts is the only
 * place a capability is minted.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PROTOTYPE_CHECKS_PER_MINUTE,
  PROTOTYPE_MAX_FILES,
  PROTOTYPE_PUBLISH_BODY_BYTES,
  PROTOTYPE_PUBLISHES_PER_MINUTE,
} from '../../config/canvas-limits.js';
import { deployRole } from '../../deploy-role.js';
import { checkPrototype, screenshotFailure } from '../../canvas/canvas-screenshot.js';
import type { CanvasStore } from '../../canvas/canvas-store.js';
import { injectFrameBridge } from '../../canvas/frame-bridge.js';
import { IdSchema, PositionSchema, SizeSchema, type Author, type CanvasState } from '../../canvas/model.js';
import { CommandSchema, validateBatch, type Command, type Operation } from '../../canvas/operations.js';
import { isPrototypeId, parsePrototypeAddress, prototypeAddress } from '../../canvas/prototype-address.js';
import { PROTOTYPE_FRAME_PREFIX, prototypeFrames } from '../../canvas/prototype-frames.js';
import {
  PROTOTYPE_CSP,
  PrototypeRefusedError,
  checkPrototypeFiles,
  discardPrototypeVersion,
  findPrototypeFile,
  listPrototypes,
  prototypeReferences,
  prototypeSlug,
  publishPrototype,
  readPrototype,
  readPrototypeFile,
  removePrototype,
  type PrototypeMeta,
  type PrototypeReference,
} from '../../canvas/prototypes.js';
import type { ViewRegistry } from '../../canvas/view-registry.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import type { CanvasPort } from '../ports/canvas-port.js';
import { abortOnClientHangUp, getAuthUser } from '../route-helpers.js';
import { SseEvent } from '../sse-events.js';
import { canvasFailure } from './canvas-failure.js';

/** What canvas-routes.ts lends these routes, so both files answer a retry and retire frames the same way. */
export interface PrototypeRouteDeps {
  views: ViewRegistry;
  callerKey(req: FastifyRequest): string;
  retireFrames(workspaceId: string, operations: Pick<Operation, 'prev'>[]): void;
  requestIdentity(
    store: CanvasStore,
    author: Author,
    tool: string,
    args: unknown,
    requestId?: string
  ): { prefix: string | null; previous: { opId: string; seq: number }[]; reused: boolean };
}

export const DEFAULT_PROTOTYPE_SIZE = { width: 960, height: 640 };
const PLACEMENT_GAP = 48;

const PublishSchema = z
  .object({
    requestId: z.uuid().optional(),
    id: z.string().max(63).optional(),
    name: z.string().trim().min(1).max(120).optional(),
    entry: z.string().max(256).default('index.html'),
    files: z
      .array(z.object({ path: z.string().max(256), base64: z.string() }).strict())
      .min(1)
      .max(PROTOTYPE_MAX_FILES),
    objectId: IdSchema.optional(),
    parentId: IdSchema.nullable().optional(),
    position: PositionSchema.optional(),
    size: SizeSchema.optional(),
  })
  .strict();

const CheckSchema = z
  .object({
    version: z.number().int().positive().optional(),
    width: z.number().int().min(200).max(2400).default(1280),
    height: z.number().int().min(200).max(2400).default(800),
    theme: z.enum(['dark', 'light']).default('dark'),
  })
  .strict();

const refusalStatus = (error: PrototypeRefusedError): number =>
  error.reason === 'size' || error.reason === 'count' || error.reason === 'quota'
    ? 413
    : error.reason === 'limit' || error.reason === 'in-use'
      ? 409
      : error.reason === 'not-found'
        ? 404
        : 400;

const buckets = new Map<string, { tokens: number; lastRefill: number }>();

/** Free space to the right of what the parent already holds, level with its topmost object. */
function placement(state: CanvasState, parentId: string | null): { position: { x: number; y: number }; order: number } {
  const siblings = Object.values(state.objects).filter((o) => o.parentId === parentId && o.deletedAt === null);
  if (!siblings.length) return { position: { x: 0, y: 0 }, order: 0 };
  return {
    position: {
      x: Math.max(...siblings.map((o) => o.position.x + (o.size?.width ?? 0))) + PLACEMENT_GAP,
      y: Math.min(...siblings.map((o) => o.position.y)),
    },
    order: Math.max(...siblings.map((o) => o.order)) + 1,
  };
}

const describe = (meta: PrototypeMeta, references: PrototypeReference[] = []) => ({
  id: meta.id,
  name: meta.name,
  latest: meta.latest,
  entry: meta.entry,
  createdAt: meta.createdAt,
  updatedAt: meta.updatedAt,
  author: meta.author,
  bytes: meta.versions.reduce((sum, v) => sum + v.bytes, 0),
  versions: meta.versions,
  objects: references.filter((r) => !r.deleted).map(({ objectId, version }) => ({ objectId, version })),
});

export function registerPrototypeRoutes(scope: FastifyInstance, ctx: CanvasPort, deps: PrototypeRouteDeps): void {
  const limited = async (req: FastifyRequest, reply: FastifyReply, kind: string, perMinute: number) => {
    const { takeToken } = await import('./session-routes.js');
    const workspaceId = (req.params as { workspaceId: string }).workspaceId;
    if (takeToken(buckets, `${kind}\n${deps.callerKey(req)}\n${workspaceId}`, perMinute, Date.now())) return false;
    void reply
      .code(429)
      .send(createErrorResponse(ApiErrorCode.RATE_LIMITED, 'Too many prototype requests. Try again in a minute.'));
    return true;
  };
  const notStored = (reply: FastifyReply) =>
    reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'No prototype with that id is stored here'));

  scope.post<{ Params: { workspaceId: string } }>(
    '/api/canvas/:workspaceId/prototypes',
    { bodyLimit: PROTOTYPE_PUBLISH_BODY_BYTES },
    async (req, reply) => {
      const { workspaceId } = req.params;
      if (!deployRole.allows('persist'))
        return reply
          .code(409)
          .send(createErrorResponse(ApiErrorCode.CONFLICT, 'Only the live colour may write canvas data'));
      if (await limited(req, reply, 'publish', PROTOTYPE_PUBLISHES_PER_MINUTE)) return reply;
      const body = PublishSchema.parse(req.body);
      const invalid = (message: string) =>
        reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, message));
      const conflict = (message: string) => reply.code(409).send(createErrorResponse(ApiErrorCode.CONFLICT, message));
      if (body.files.some((file) => !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)))
        return invalid('Each file needs its bytes as base64');
      const files = body.files.map((file) => ({ path: file.path, data: Buffer.from(file.base64, 'base64') }));
      const store = (await ctx.canvasStores()).get(workspaceId);
      const state = store.read();
      const author: Author = req.canvasAuthor ?? { kind: 'human', userId: getAuthUser(req).username };
      const { files: _bytes, requestId, ...fields } = body;
      const digests = files.map((file) => [file.path, createHash('sha256').update(file.data).digest('hex')]);
      const identity = deps.requestIdentity(store, author, 'canvas_prototype', [fields, digests], requestId);
      if (identity.previous.length) {
        if (identity.reused) return conflict('Request identity was already used for a different command');
        const sequences = identity.previous.map((o) => o.seq);
        const written = (store.records(sequences) as Operation[]).flatMap((record) => record.prev ?? [])[0];
        const url = written?.after.content.url;
        const address = typeof url === 'string' ? parsePrototypeAddress(url) : null;
        if (!written || !address) return conflict('Request identity was already used for a different command');
        return {
          success: true,
          data: {
            prototypeId: address.id,
            version: address.version,
            objectId: written.objectId,
            url,
            seq: state.seq,
            sequences,
            replayed: true,
          },
        };
      }
      // Which object shows the new version: the named one, the only live embed of this prototype, or a new embed.
      let target = body.objectId;
      let id = body.id;
      if (target) {
        const object = state.objects[target];
        const shown =
          object?.deletedAt === null && object.type === 'embed' && typeof object.content.url === 'string'
            ? parsePrototypeAddress(object.content.url)
            : null;
        if (!shown) return conflict('objectId must name a live embed that shows a prototype');
        id ??= shown.id;
      }
      id ??= prototypeSlug(body.name ?? 'prototype');
      if (!isPrototypeId(id)) return invalid('A prototype id is lower-case letters, digits and dashes, 63 at most');
      const references = prototypeReferences(state).get(id) ?? [];
      if (!target) {
        const live = references.filter((r) => !r.deleted);
        if (live.length > 1)
          return conflict(
            `${live.length} embeds show prototype "${id}". Pass objectId to say which one gets the new version.`
          );
        target = live[0]?.objectId;
      }
      const existing = await readPrototype(workspaceId, id);
      const name = body.name ?? existing?.name ?? id;
      const newObjectId = randomUUID();
      const command = (version: number, opId: string): Command => {
        const url = prototypeAddress({ id, version, entry: body.entry });
        if (target)
          return CommandSchema.parse({
            kind: 'update',
            opId,
            objectId: target,
            patch: {
              content: { type: 'embed', url, ...(body.name ? { label: name } : {}) },
              ...(body.size ? { size: body.size } : {}),
            },
          });
        const parentId = body.parentId ?? null;
        const place = placement(state, parentId);
        return CommandSchema.parse({
          kind: 'create',
          opId,
          objectId: newObjectId,
          patch: {
            parentId,
            order: place.order,
            position: body.position ?? place.position,
            size: body.size ?? DEFAULT_PROTOTYPE_SIZE,
            content: { type: 'embed', url, label: name },
          },
        });
      };
      try {
        checkPrototypeFiles(
          files.map((file) => ({ path: file.path, bytes: file.data.length })),
          body.entry
        );
        // Refuse a write the canvas would refuse (a lock, a missing parent) before any byte is stored.
        const rehearsal = validateBatch(state, [command(1, randomUUID())], author, Date.now());
        if (!rehearsal.ok)
          return reply.code(409).send({
            ...createErrorResponse(ApiErrorCode.CONFLICT, 'Canvas operation rejected'),
            reasons: rehearsal.reasons,
          });
        const { version } = await publishPrototype(
          workspaceId,
          { id, name, entry: body.entry, files, author },
          new Set(references.map((r) => r.version))
        );
        const operation = command(version, identity.prefix ? `${identity.prefix}0` : randomUUID());
        const result = store.appendExpanded([operation], author);
        if (!result.ok) {
          await discardPrototypeVersion(workspaceId, id, version);
          return reply.code(409).send({
            ...createErrorResponse(ApiErrorCode.CONFLICT, 'Canvas operation rejected'),
            reasons: result.reasons,
          });
        }
        deps.retireFrames(workspaceId, result.operations);
        const { readWorkspaces } = await import('../../canvas/workspace-registry.js');
        ctx.broadcast(SseEvent.CanvasChanged, {
          workspaceId,
          seq: result.seq,
          owner: readWorkspaces().find((w) => w.id === workspaceId)?.owner,
        });
        return {
          success: true,
          data: {
            prototypeId: id,
            version,
            objectId: operation.objectId,
            url: prototypeAddress({ id, version, entry: body.entry }),
            seq: result.seq,
            sequences: result.sequences,
          },
        };
      } catch (error) {
        if (!(error instanceof PrototypeRefusedError)) throw error;
        return reply
          .code(refusalStatus(error))
          .send({ ...createErrorResponse(ApiErrorCode.INVALID_INPUT, error.message), refusal: error.reason });
      }
    }
  );

  scope.get<{ Params: { workspaceId: string } }>('/api/canvas/:workspaceId/prototypes', async (req) => {
    const state = (await ctx.canvasStores()).get(req.params.workspaceId).read();
    const references = prototypeReferences(state);
    const prototypes = (await listPrototypes(req.params.workspaceId)).map((meta) =>
      describe(meta, references.get(meta.id))
    );
    return { success: true, data: { prototypes } };
  });

  scope.get<{ Params: { workspaceId: string; id: string } }>(
    '/api/canvas/:workspaceId/prototypes/:id',
    async (req, reply) => {
      const meta = await readPrototype(req.params.workspaceId, req.params.id);
      if (!meta) return notStored(reply);
      const state = (await ctx.canvasStores()).get(req.params.workspaceId).read();
      return { success: true, data: describe(meta, prototypeReferences(state).get(meta.id)) };
    }
  );

  scope.delete<{ Params: { workspaceId: string; id: string } }>(
    '/api/canvas/:workspaceId/prototypes/:id',
    async (req, reply) => {
      const { workspaceId, id } = req.params;
      if (!deployRole.allows('persist'))
        return reply
          .code(409)
          .send(createErrorResponse(ApiErrorCode.CONFLICT, 'Only the live colour may write canvas data'));
      if (!(await readPrototype(workspaceId, id))) return notStored(reply);
      // The check and the removal run with nothing awaited between the state read and the delete starting,
      // and an embed can only be pointed at a version the store still holds.
      const state = (await ctx.canvasStores()).get(workspaceId).read();
      const live = (prototypeReferences(state).get(id) ?? []).filter((r) => !r.deleted);
      if (live.length)
        return reply.code(409).send({
          ...createErrorResponse(
            ApiErrorCode.CONFLICT,
            `Prototype "${id}" is shown by ${live.length} object${live.length === 1 ? '' : 's'}. Delete or re-point them first.`
          ),
          objects: live.map((r) => r.objectId),
        });
      const removing = removePrototype(workspaceId, id);
      prototypeFrames.retire((frame) => frame.workspaceId === workspaceId && frame.prototypeId === id);
      await removing;
      return { success: true, data: { removed: id } };
    }
  );

  scope.post<{ Params: { workspaceId: string; id: string } }>(
    '/api/canvas/:workspaceId/prototypes/:id/check',
    { bodyLimit: 16 * 1024 },
    async (req, reply) => {
      const { workspaceId, id } = req.params;
      const input = CheckSchema.parse(req.body ?? {});
      const meta = await readPrototype(workspaceId, id);
      const version = meta?.versions.find((v) => v.version === (input.version ?? meta.latest));
      if (!meta || !version)
        return meta
          ? reply
              .code(404)
              .send(
                createErrorResponse(ApiErrorCode.NOT_FOUND, `Version ${input.version} of "${id}" is not stored here`)
              )
          : notStored(reply);
      if (await limited(req, reply, 'check', PROTOTYPE_CHECKS_PER_MINUTE)) return reply;
      const hangup = abortOnClientHangUp(reply);
      try {
        const { png, ...report } = await checkPrototype(
          {
            entry: version.entry,
            width: input.width,
            height: input.height,
            theme: input.theme,
            read: (path) => readPrototypeFile(workspaceId, id, version.version, path),
          },
          { signal: hangup.signal }
        );
        return {
          success: true,
          data: {
            prototypeId: id,
            version: version.version,
            entry: version.entry,
            ...report,
            png: png.toString('base64'),
          },
        };
      } catch (error) {
        if (hangup.signal.aborted || reply.sent) return reply;
        const failure = screenshotFailure(error);
        if (failure.status >= 500) return canvasFailure(req, reply, failure.status, error, failure.message);
        return reply.code(failure.status).send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, failure.message));
      }
    }
  );
}

const WORKSPACE_CLOSED_PAGE =
  '<!doctype html><meta charset="utf-8"><title>Prototype paused</title>' +
  '<body style="font:14px system-ui,sans-serif;margin:24px;color:#555">' +
  'This prototype is shown only while its canvas workspace is open. Reload the canvas to see it again.</body>';

/**
 * `GET|HEAD /canvas-prototype/:cap/*`: the files of the one version a capability names. Registered
 * beside the canvas API (so the canvas setting gates it) but outside the workspace scope: the frame
 * that asks carries no login, only the capability.
 */
export function registerPrototypeServeRoute(scope: FastifyInstance, views: ViewRegistry): void {
  scope.get<{ Params: { cap: string; '*': string } }>(`${PROTOTYPE_FRAME_PREFIX}/:cap/*`, async (req, reply) => {
    const { cap, '*': rest } = req.params;
    const frame = prototypeFrames.resolve(cap);
    reply
      .header('Content-Security-Policy', PROTOTYPE_CSP)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('Cache-Control', 'no-store');
    const notFound = () => reply.code(404).type('text/plain; charset=utf-8').send('Not found');
    if (!frame) return notFound();
    if (!views.list(frame.workspaceId, () => true).length) {
      prototypeFrames.revoke(cap);
      return reply.code(409).type('text/html; charset=utf-8').send(WORKSPACE_CLOSED_PAGE);
    }
    // Fastify has already percent-decoded the wildcard; the store applies the publish rules to it again.
    const file = await findPrototypeFile(frame.workspaceId, frame.prototypeId, frame.version, rest ?? '');
    if (!file) return notFound();
    // The page has an opaque origin, so its fetch() of a sibling file is cross-origin. `*` widens
    // nothing: whoever holds the capability URL can already read these bytes.
    reply.header('Access-Control-Allow-Origin', '*').header('Content-Type', file.mime);
    if (file.mime.startsWith('text/html')) return reply.send(injectFrameBridge(await readFile(file.path, 'utf8')));
    // A version never changes, and a new version is a new address and a new capability.
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    const { sendFileBody, localFileSource } = await import('./file-routes.js');
    sendFileBody(reply, file.size, req.headers.range, localFileSource(file.path));
    return reply;
  });
}
