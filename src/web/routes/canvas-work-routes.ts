/**
 * @fileoverview Work items of a canvas workspace (`src/canvas/work.ts`, stored by `src/canvas/work-store.ts`).
 *
 * `GET   /api/canvas/:workspaceId/work`            every item, with the next key.
 * `POST  /api/canvas/:workspaceId/work`            creates one (`CreateWorkSchema`; `requestId` makes a retry safe).
 * `PATCH /api/canvas/:workspaceId/work/:key`       changes one (`UpdateWorkSchema`; `expectedRevision` guards it).
 * `POST  /api/canvas/:workspaceId/work/:key/report` the run-end rule an agent applies (`ReportWorkSchema`).
 *
 * The `canvas_work` tool calls the same functions through the command route, so a person and an agent are held to the
 * same rules. The author is the route's (`req.canvasAuthor`, else the signed-in person). A session may be linked or
 * assigned only when it exists and the caller may see it; `"me"` names the calling agent's own session. Every
 * committed change is announced as `canvas:changed` with `work: true`; nothing here changes an item by itself.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CanvasPort } from '../ports/canvas-port.js';
import { canAccessOwned, getAuthUser } from '../route-helpers.js';
import { ApiErrorCode } from '../../types.js';
import { SseEvent } from '../sse-events.js';
import type { Author } from '../../canvas/model.js';
import {
  createWork,
  CreateWorkSchema,
  findWork,
  parseWorkKey,
  reportWork,
  ReportWorkSchema,
  updateWork,
  UpdateWorkSchema,
  workBrief,
  workKey,
  workRelated,
  workRow,
  type WorkAssignee,
  type WorkTool,
} from '../../canvas/work.js';
import { changeWork, readWork, workFileProblem } from '../../canvas/work-store.js';
import { ok, refuse, type Outcome } from './canvas-conversation-routes.js';

const authorOf = (req: FastifyRequest): Author =>
  req.canvasAuthor ?? { kind: 'human', userId: getAuthUser(req).username };

/** `"me"` resolved, every named session checked; a string is the refusal. */
function resolveSessions(
  ctx: CanvasPort,
  req: FastifyRequest,
  ids: readonly string[]
): { ok: true; ids: string[] } | { ok: false; message: string } {
  const author = authorOf(req);
  const user = getAuthUser(req);
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw === 'me' ? (author.kind === 'agent' ? author.sessionId : null) : raw;
    if (id === null) return { ok: false, message: '"me" names the calling agent session; a person picks a session' };
    const session = ctx.sessions.get(id);
    if (!session || !canAccessOwned(user, session.owner))
      return { ok: false, message: `No session ${id.slice(0, 8)} you can see` };
    out.push(id);
  }
  return { ok: true, ids: out };
}
function resolveAssignee(
  ctx: CanvasPort,
  req: FastifyRequest,
  assignee: WorkAssignee | null | undefined
): { ok: true; assignee: WorkAssignee | null | undefined } | { ok: false; message: string } {
  if (!assignee || assignee.kind === 'person') return { ok: true, assignee };
  const resolved = resolveSessions(ctx, req, [assignee.sessionId]);
  return resolved.ok ? { ok: true, assignee: { kind: 'session', sessionId: resolved.ids[0]! } } : resolved;
}

async function announce(ctx: CanvasPort, workspaceId: string): Promise<void> {
  const { readWorkspaces } = await import('../../canvas/workspace-registry.js');
  const seq = (await ctx.canvasStores()).get(workspaceId).read().seq;
  ctx.broadcast(SseEvent.CanvasChanged, {
    workspaceId,
    seq,
    owner: readWorkspaces().find((w) => w.id === workspaceId)?.owner,
    work: true,
  });
}

type Result = ReturnType<typeof changeWork>;
async function answer(ctx: CanvasPort, workspaceId: string, result: Result, created = false): Promise<Outcome> {
  if (!result.ok) {
    const [status, code] =
      result.code === 'NOT_FOUND'
        ? [404, ApiErrorCode.NOT_FOUND]
        : result.code === 'INVALID_INPUT'
          ? [400, ApiErrorCode.INVALID_INPUT]
          : [409, ApiErrorCode.CONFLICT];
    return refuse(status, code, `${result.code}: ${result.message}`);
  }
  if (!result.duplicate) await announce(ctx, workspaceId);
  const outcome = ok({
    item: workRow(result.item, result.file),
    ...(result.filed.length ? { filed: result.filed.map((i) => workRow(i, result.file)) } : {}),
    ...(result.duplicate ? { duplicate: true } : {}),
  });
  return created && !result.duplicate ? { ...outcome, code: 201 } : outcome;
}

export function listWork(workspaceId: string, brief = false): Outcome {
  const read = readWork(workspaceId);
  if (!read.ok) return refuse(409, ApiErrorCode.CONFLICT, workFileProblem(read.reason));
  return ok({
    next: workKey(read.file.next),
    items: read.file.items.map((i) => (brief ? workBrief(i, read.file) : workRow(i, read.file))),
  });
}
export function readWorkItem(workspaceId: string, number: number): Outcome {
  const read = readWork(workspaceId);
  if (!read.ok) return refuse(409, ApiErrorCode.CONFLICT, workFileProblem(read.reason));
  const item = findWork(read.file, number);
  if (!item) return refuse(404, ApiErrorCode.NOT_FOUND, `NOT_FOUND: ${workKey(number)} does not exist`);
  return ok({ item: workRow(item, read.file), related: workRelated(read.file, item) });
}
export async function createWorkItem(
  ctx: CanvasPort,
  req: FastifyRequest,
  workspaceId: string,
  body: unknown
): Promise<Outcome> {
  const input = CreateWorkSchema.parse(body);
  const assignee = resolveAssignee(ctx, req, input.assignee);
  if (!assignee.ok) return refuse(400, ApiErrorCode.INVALID_INPUT, `INVALID_INPUT: ${assignee.message}`);
  const sessions = resolveSessions(ctx, req, input.sessions ?? []);
  if (!sessions.ok) return refuse(400, ApiErrorCode.INVALID_INPUT, `INVALID_INPUT: ${sessions.message}`);
  const context = { author: authorOf(req), now: Date.now() };
  const result = changeWork(workspaceId, (file) =>
    createWork(file, { ...input, assignee: assignee.assignee, sessions: sessions.ids }, context)
  );
  return answer(ctx, workspaceId, result, true);
}
export async function updateWorkItem(
  ctx: CanvasPort,
  req: FastifyRequest,
  workspaceId: string,
  number: number,
  body: unknown
): Promise<Outcome> {
  const patch = UpdateWorkSchema.parse(body);
  const assignee = resolveAssignee(ctx, req, patch.assignee);
  if (!assignee.ok) return refuse(400, ApiErrorCode.INVALID_INPUT, `INVALID_INPUT: ${assignee.message}`);
  const linking = resolveSessions(ctx, req, patch.linkSessions ?? []);
  if (!linking.ok) return refuse(400, ApiErrorCode.INVALID_INPUT, `INVALID_INPUT: ${linking.message}`);
  const author = authorOf(req);
  // Unlinking needs no check: a session that has gone can still be taken off an item.
  const unlink = (patch.unlinkSessions ?? []).map((id) =>
    id === 'me' && author.kind === 'agent' ? author.sessionId : id
  );
  const context = { author, now: Date.now() };
  const result = changeWork(workspaceId, (file) =>
    updateWork(
      file,
      number,
      {
        ...patch,
        ...(patch.assignee !== undefined ? { assignee: assignee.assignee } : {}),
        ...(patch.linkSessions ? { linkSessions: linking.ids } : {}),
        ...(patch.unlinkSessions ? { unlinkSessions: unlink } : {}),
      },
      context
    )
  );
  return answer(ctx, workspaceId, result);
}
export async function reportWorkItem(
  ctx: CanvasPort,
  req: FastifyRequest,
  workspaceId: string,
  number: number,
  body: unknown
): Promise<Outcome> {
  const report = ReportWorkSchema.parse(body);
  const context = { author: authorOf(req), now: Date.now() };
  return answer(
    ctx,
    workspaceId,
    changeWork(workspaceId, (file) => reportWork(file, number, report, context))
  );
}

/** The `canvas_work` tool: the routes' own functions. */
export async function workTool(
  ctx: CanvasPort,
  req: FastifyRequest,
  workspaceId: string,
  input: WorkTool
): Promise<Outcome> {
  switch (input.action) {
    case 'list': {
      const listed = listWork(workspaceId, true);
      if (!input.status || listed.code !== 200) return listed;
      const data = (listed.body as { data: { next: string; items: { status: string; position?: number }[] } }).data;
      // Ready for work answers in pickup order, top first.
      const items = data.items.filter((i) => i.status === input.status);
      if (input.status === 'ready-for-work') items.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      return ok({ ...data, items });
    }
    case 'read':
      return readWorkItem(workspaceId, input.key);
    case 'create': {
      const { action: _action, ...body } = input;
      void _action;
      return createWorkItem(ctx, req, workspaceId, body);
    }
    case 'update': {
      const { action: _action, key, ...body } = input;
      void _action;
      return updateWorkItem(ctx, req, workspaceId, key, body);
    }
    case 'report': {
      const { action: _action, key, ...body } = input;
      void _action;
      return reportWorkItem(ctx, req, workspaceId, key, body);
    }
  }
}

const badKey = (): Outcome => refuse(400, ApiErrorCode.INVALID_INPUT, 'INVALID_INPUT: a work key looks like W-12');

export function registerWorkRoutes(scope: FastifyInstance, ctx: CanvasPort): void {
  type Ws = { Params: { workspaceId: string } };
  type One = { Params: { workspaceId: string; key: string } };
  scope.get<Ws>('/api/canvas/:workspaceId/work', async (req, reply) => {
    const outcome = listWork(req.params.workspaceId);
    return reply.code(outcome.code).send(outcome.body);
  });
  scope.get<One>('/api/canvas/:workspaceId/work/:key', async (req, reply) => {
    const number = parseWorkKey(req.params.key);
    const outcome = number === null ? badKey() : readWorkItem(req.params.workspaceId, number);
    return reply.code(outcome.code).send(outcome.body);
  });
  scope.post<Ws>('/api/canvas/:workspaceId/work', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const outcome = await createWorkItem(ctx, req, req.params.workspaceId, req.body);
    return reply.code(outcome.code).send(outcome.body);
  });
  scope.patch<One>('/api/canvas/:workspaceId/work/:key', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const number = parseWorkKey(req.params.key);
    const outcome =
      number === null ? badKey() : await updateWorkItem(ctx, req, req.params.workspaceId, number, req.body);
    return reply.code(outcome.code).send(outcome.body);
  });
  scope.post<One>('/api/canvas/:workspaceId/work/:key/report', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const number = parseWorkKey(req.params.key);
    const outcome =
      number === null ? badKey() : await reportWorkItem(ctx, req, req.params.workspaceId, number, req.body);
    return reply.code(outcome.code).send(outcome.body);
  });
}
