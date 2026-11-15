/**
 * @fileoverview Routines of a canvas workspace (W-44; `src/canvas/routines.ts`, stored by `routine-store.ts`).
 *
 * `GET    /api/canvas/:workspaceId/routines`           every routine with its derived next run and recent fires
 * `GET    /api/canvas/:workspaceId/routines/:key`      one
 * `POST   /api/canvas/:workspaceId/routines`           create (`requestId` makes a retry safe)
 * `PATCH  /api/canvas/:workspaceId/routines/:key`      change (`expectedRevision` guards it)
 * `DELETE /api/canvas/:workspaceId/routines/:key`      delete (a person only); its runs stay as ordinary tasks
 * `POST   /api/canvas/:workspaceId/routines/:key/run`  Run now (a person only), body `{ requestId, ignoreGates? }`
 *
 * The `canvas_routine` tool calls the same functions. An agent may read, create (saved disabled), switch one off and
 * change fields; switching one on, Run now and delete are a person's (`routineRefusal`), and an agent's change to the
 * prompt, triggers or launch of an enabled routine switches it off (`updateRoutine`). Writes need the live colour
 * and the workspace owner (`writeGuard`). A routine's own runs never reach these routes: the canvas pre-handler admits
 * the routine principal on the task routes only.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CanvasPort } from '../ports/canvas-port.js';
import { getAuthUser } from '../route-helpers.js';
import { ApiErrorCode } from '../../types.js';
import { SseEvent } from '../sse-events.js';
import type { Author } from '../../canvas/model.js';
import {
  createRoutine,
  CreateRoutineSchema,
  deleteRoutine,
  parseRoutineKey,
  ROUTINE_REFUSALS,
  routineKey,
  routineRefusal,
  routineRow,
  updateRoutine,
  UpdateRoutineSchema,
  type RoutineChange,
  type RoutineRefusal,
  type RoutineTool,
} from '../../canvas/routines.js';
import { changeRoutines, readRoutines, readRoutineState, routineFileProblem } from '../../canvas/routine-store.js';
import { isOutcome, ok, refuse, writeGuard, type Outcome } from './canvas-conversation-routes.js';

const authorOf = (req: FastifyRequest): Author =>
  req.canvasAuthor ?? { kind: 'human', userId: getAuthUser(req).username };
const callerOf = (req: FastifyRequest): 'person' | 'agent' => (req.canvasAuthor?.kind === 'agent' ? 'agent' : 'person');

const STATUS: Record<RoutineRefusal | 'FILE', [number, ApiErrorCode]> = {
  PERSON_ONLY: [403, ApiErrorCode.FORBIDDEN],
  NOT_FOUND: [404, ApiErrorCode.NOT_FOUND],
  CONFLICT: [409, ApiErrorCode.CONFLICT],
  TOO_MANY: [409, ApiErrorCode.CONFLICT],
  REQUEST_REUSED: [409, ApiErrorCode.CONFLICT],
  FILE: [409, ApiErrorCode.CONFLICT],
};
const refused = (code: RoutineRefusal): Outcome => {
  const [status, errorCode] = STATUS[code];
  return refuse(status, errorCode, ROUTINE_REFUSALS[code]);
};
const notFound = (number: number): Outcome =>
  refuse(404, ApiErrorCode.NOT_FOUND, `NOT_FOUND: ${routineKey(number)} does not exist`);

/** Tells open canvases that routines or their fires changed (`canvas:changed` with `routines: true`). */
export async function announceRoutines(
  ctx: Pick<CanvasPort, 'broadcast' | 'canvasStores'>,
  workspaceId: string,
  changed?: { work?: true }
) {
  const { readWorkspaces } = await import('../../canvas/workspace-registry.js');
  const seq = (await ctx.canvasStores()).get(workspaceId).read().seq;
  ctx.broadcast(SseEvent.CanvasChanged, {
    workspaceId,
    seq,
    owner: readWorkspaces().find((w) => w.id === workspaceId)?.owner,
    routines: true,
    ...changed,
  });
}

async function answer(
  ctx: CanvasPort,
  workspaceId: string,
  result: RoutineChange | { ok: false; code: 'FILE'; message: string },
  deleted = false
): Promise<Outcome> {
  if (!result.ok) {
    if (result.code === 'FILE') return refuse(409, ApiErrorCode.CONFLICT, result.message);
    return refused(result.code);
  }
  if (!result.duplicate) await announceRoutines(ctx, workspaceId);
  if (deleted) return ok({ deleted: routineKey(result.routine.number) });
  const state = readRoutineState(workspaceId);
  const row = routineRow(result.routine, state.ok ? state.file.routines[result.routine.id] : undefined);
  return ok({ routine: row, ...(result.duplicate ? { duplicate: true } : {}) });
}

export function listRoutines(workspaceId: string): Outcome {
  const read = readRoutines(workspaceId);
  if (!read.ok) return refuse(409, ApiErrorCode.CONFLICT, routineFileProblem(read.reason));
  const state = readRoutineState(workspaceId);
  return ok({
    routines: read.file.routines.map((r) => routineRow(r, state.ok ? state.file.routines[r.id] : undefined)),
    ...(state.ok ? {} : { stateUnreadable: true }),
  });
}
export function readRoutine(workspaceId: string, number: number): Outcome {
  const listed = listRoutines(workspaceId);
  if (listed.code !== 200) return listed;
  const rows = (listed.body as { data: { routines: { number: number }[] } }).data.routines;
  const row = rows.find((r) => r.number === number);
  return row ? ok({ routine: row }) : notFound(number);
}

export async function createRoutineRoute(
  ctx: CanvasPort,
  req: FastifyRequest,
  workspaceId: string,
  body: unknown
): Promise<Outcome> {
  const input = CreateRoutineSchema.parse(body);
  const why = routineRefusal(callerOf(req), 'create', input);
  if (why) return refused(why);
  const guard = await writeGuard(req, workspaceId);
  if (isOutcome(guard)) return guard;
  const context = { author: authorOf(req), now: Date.now() };
  return answer(
    ctx,
    workspaceId,
    changeRoutines(workspaceId, (file) => createRoutine(file, input, context))
  );
}
export async function updateRoutineRoute(
  ctx: CanvasPort,
  req: FastifyRequest,
  workspaceId: string,
  number: number,
  body: unknown
): Promise<Outcome> {
  const patch = UpdateRoutineSchema.parse(body);
  const why = routineRefusal(callerOf(req), 'update', patch);
  if (why) return refused(why);
  const guard = await writeGuard(req, workspaceId);
  if (isOutcome(guard)) return guard;
  const now = Date.now();
  return answer(
    ctx,
    workspaceId,
    changeRoutines(workspaceId, (file) => updateRoutine(file, number, patch, now, callerOf(req)))
  );
}
export async function deleteRoutineRoute(
  ctx: CanvasPort,
  req: FastifyRequest,
  workspaceId: string,
  number: number
): Promise<Outcome> {
  const why = routineRefusal(callerOf(req), 'delete');
  if (why) return refused(why);
  const guard = await writeGuard(req, workspaceId);
  if (isOutcome(guard)) return guard;
  return answer(
    ctx,
    workspaceId,
    changeRoutines(workspaceId, (file) => deleteRoutine(file, number)),
    true
  );
}
export async function runRoutineRoute(
  ctx: CanvasPort,
  req: FastifyRequest,
  workspaceId: string,
  number: number,
  body: unknown
): Promise<Outcome> {
  const { requestId, ignoreGates } = z
    .object({ requestId: z.uuid(), ignoreGates: z.boolean().optional() })
    .strict()
    .parse(body);
  const why = routineRefusal(callerOf(req), 'run');
  if (why) return refused(why);
  const workspace = await writeGuard(req, workspaceId);
  if (isOutcome(workspace)) return workspace;
  if (!ctx.runRoutine) return refuse(409, ApiErrorCode.CONFLICT, 'Routines cannot run on this server');
  const read = readRoutines(workspaceId);
  if (!read.ok) return refuse(409, ApiErrorCode.CONFLICT, routineFileProblem(read.reason));
  const routine = read.file.routines.find((r) => r.number === number);
  if (!routine) return notFound(number);
  const fire = await ctx.runRoutine(workspace, routine, requestId, ignoreGates === true);
  if (!fire) return refuse(409, ApiErrorCode.CONFLICT, 'The routine could not be run right now; nothing was started');
  return ok({ fire });
}

/** The `canvas_routine` tool: the routes' own functions. */
export async function routineTool(
  ctx: CanvasPort,
  req: FastifyRequest,
  workspaceId: string,
  input: RoutineTool
): Promise<Outcome> {
  switch (input.action) {
    case 'list':
      return listRoutines(workspaceId);
    case 'read':
      return readRoutine(workspaceId, input.key);
    case 'create': {
      const { action: _action, ...body } = input;
      void _action;
      return createRoutineRoute(ctx, req, workspaceId, body);
    }
    case 'update': {
      const { action: _action, key, ...body } = input;
      void _action;
      return updateRoutineRoute(ctx, req, workspaceId, key, body);
    }
    case 'run':
      return runRoutineRoute(ctx, req, workspaceId, input.key, { requestId: input.requestId });
    case 'delete':
      return deleteRoutineRoute(ctx, req, workspaceId, input.key);
  }
}

const badKey = (): Outcome => refuse(400, ApiErrorCode.INVALID_INPUT, 'INVALID_INPUT: a routine key looks like R-3');

export function registerRoutineRoutes(scope: FastifyInstance, ctx: CanvasPort): void {
  type Ws = { Params: { workspaceId: string } };
  type One = { Params: { workspaceId: string; key: string } };
  const send = (reply: { code(n: number): { send(b: unknown): unknown } }, outcome: Outcome) =>
    reply.code(outcome.code).send(outcome.body);
  scope.get<Ws>('/api/canvas/:workspaceId/routines', async (req, reply) =>
    send(reply, listRoutines(req.params.workspaceId))
  );
  scope.get<One>('/api/canvas/:workspaceId/routines/:key', async (req, reply) => {
    const number = parseRoutineKey(req.params.key);
    return send(reply, number === null ? badKey() : readRoutine(req.params.workspaceId, number));
  });
  scope.post<Ws>('/api/canvas/:workspaceId/routines', { bodyLimit: 64 * 1024 }, async (req, reply) =>
    send(reply, await createRoutineRoute(ctx, req, req.params.workspaceId, req.body))
  );
  scope.patch<One>('/api/canvas/:workspaceId/routines/:key', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const number = parseRoutineKey(req.params.key);
    return send(
      reply,
      number === null ? badKey() : await updateRoutineRoute(ctx, req, req.params.workspaceId, number, req.body)
    );
  });
  scope.delete<One>('/api/canvas/:workspaceId/routines/:key', async (req, reply) => {
    const number = parseRoutineKey(req.params.key);
    return send(reply, number === null ? badKey() : await deleteRoutineRoute(ctx, req, req.params.workspaceId, number));
  });
  scope.post<One>('/api/canvas/:workspaceId/routines/:key/run', { bodyLimit: 1024 }, async (req, reply) => {
    const number = parseRoutineKey(req.params.key);
    return send(
      reply,
      number === null ? badKey() : await runRoutineRoute(ctx, req, req.params.workspaceId, number, req.body)
    );
  });
}
