/**
 * @fileoverview Canvas routines (W-44): a saved background-task request with triggers. Each due time of an enabled
 * routine starts one ordinary canvas background task through the task route, so every agent-start bound in
 * `agent-start.ts` applies to it unchanged. Nothing here touches disk or a session; the canvas page imports its
 * types only (the run id needs `node:crypto`).
 *
 * Two files per workspace, one writer each: `routines.json` (the definitions, written by the routine routes) and
 * `routine-state.json` (the last due time and the recent fires, written by the runner). The next run time and whether
 * a run is active are derived, never stored. `planFire` is the one decision of a tick; the runner only carries it out.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { computeNextRunAt, parseHHMM, type CronSchedule } from '../cron/cron-time.js';
import { AuthorSchema, type Author } from './model.js';
import type { TaskState } from './tasks.js';

export const MAX_ROUTINES = 20;
export const MAX_ROUTINE_TRIGGERS = 4;
/** Each run is a session, a worktree and real money, so a trigger wakes an agent at most this often. */
export const MIN_INTERVAL_MINUTES = 15;
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
export const MAX_ROUTINE_TITLE_CHARS = 200;
export const MAX_ROUTINE_DESCRIPTION_CHARS = 2000;
/** Leaves room under the task route's 16 KiB message for the reference line the run adds. */
export const MAX_ROUTINE_PROMPT_CHARS = 8000;
export const MAX_KEPT_FIRES = 20;
/** Finished runs of one routine left on the canvas; older ones are removed before a new start (the 50-record cap). */
export const KEEP_FINISHED_RUNS = 3;
/** A fire still marked pending after this long was cut off (a crash or restart) and is recorded as failed. */
export const PENDING_FIRE_MS = 10 * 60_000;

export const routineKey = (number: number): string => `R-${number}`;
export function parseRoutineKey(key: string): number | null {
  const match = /^(?:[rR]-)?([1-9][0-9]{0,8})$/.exec(key.trim());
  return match ? Number(match[1]) : null;
}

// ---- Triggers -------------------------------------------------------------

const Time = z.string().refine((value) => parseHHMM(value) !== null, 'A time looks like 07:30');
export const TriggerSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('interval'),
      minutes: z.number().int().min(MIN_INTERVAL_MINUTES).max(MAX_INTERVAL_MINUTES),
    })
    .strict(),
  z.object({ kind: z.literal('daily'), time: Time }).strict(),
  z
    .object({
      kind: z.literal('weekly'),
      days: z
        .array(z.number().int().min(0).max(6))
        .min(1)
        .max(7)
        .refine((days) => new Set(days).size === days.length, 'Each day once'),
      time: Time,
    })
    .strict(),
]);
/** When a routine wants to run. Adding a kind is one union member, one `asCronSchedule` case and one form row. */
export type RoutineTrigger = z.infer<typeof TriggerSchema>;

export function asCronSchedule(trigger: RoutineTrigger): CronSchedule {
  switch (trigger.kind) {
    case 'interval':
      return { scheduleType: 'interval', intervalMinutes: trigger.minutes };
    case 'daily':
      return { scheduleType: 'daily', dailyTime: trigger.time };
    case 'weekly':
      return { scheduleType: 'weekly', weeklyDays: trigger.days, weeklyTime: trigger.time };
  }
}
/** The triggers this release understands; one a later release added is kept on disk and ignored here. */
export const knownTriggers = (routine: Pick<Routine, 'triggers'>): RoutineTrigger[] =>
  routine.triggers.flatMap((t) => {
    const parsed = TriggerSchema.safeParse(t);
    return parsed.success ? [parsed.data] : [];
  });

/** The first due time strictly after `after` across the triggers, or null when none has one. */
export function dueAt(triggers: readonly RoutineTrigger[], after: number): number | null {
  let best: number | null = null;
  for (const trigger of triggers) {
    const next = computeNextRunAt(asCronSchedule(trigger), after);
    if (next !== null && (best === null || next < best)) best = next;
  }
  return best;
}
/**
 * The latest due time in `(after, now]`, or null when there is none. Missed due times collapse into this one, so a
 * server that was down for a day runs a routine once, not once per missed interval. An interval counts from `after`;
 * a daily or weekly time repeats within a week, so only the last eight days are walked.
 */
export function latestDue(triggers: readonly RoutineTrigger[], after: number, now: number): number | null {
  let best: number | null = null;
  for (const trigger of triggers) {
    let latest: number | null = null;
    if (trigger.kind === 'interval') {
      const step = trigger.minutes * 60_000;
      const count = Math.floor((now - after) / step);
      if (count >= 1) latest = after + count * step;
    } else {
      let cursor = Math.max(after, now - 8 * 24 * 60 * 60_000);
      for (let next = dueAt([trigger], cursor); next !== null && next <= now; next = dueAt([trigger], cursor)) {
        latest = next;
        cursor = next;
      }
    }
    if (latest !== null && (best === null || latest > best)) best = latest;
  }
  return best;
}

// ---- Stored shapes --------------------------------------------------------

const at = z.number().int().nonnegative();
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const oneLine = (text: string): string =>
  text
    .replace(/[\r\n\t]/g, ' ')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const multiLine = (text: string): string =>
  text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(CONTROL, '').trim();

const StoredRoutine = z
  .object({
    id: z.uuid(),
    number: z.number().int().positive(),
    title: z.string().min(1).max(MAX_ROUTINE_TITLE_CHARS),
    description: z.string().max(MAX_ROUTINE_DESCRIPTION_CHARS).catch(''),
    prompt: z.string().min(1).max(MAX_ROUTINE_PROMPT_CHARS),
    /** Loose on disk: a trigger kind a later release adds survives a write by this one (`knownTriggers`). */
    triggers: z.array(z.object({ kind: z.string() }).passthrough()).max(MAX_ROUTINE_TRIGGERS),
    cliId: z.string().min(1).max(64).optional().catch(undefined),
    model: z.string().max(100).optional().catch(undefined),
    enabled: z.boolean(),
    /** When it was last switched on: no due time at or before this one fires, so enabling never replays missed runs. */
    enabledAt: at.optional().catch(undefined),
    author: AuthorSchema,
    createdAt: at,
    updatedAt: at,
    revision: z.number().int().positive(),
    requestId: z.uuid().optional().catch(undefined),
  })
  .passthrough();
export type Routine = z.infer<typeof StoredRoutine>;
/** `routines.json`. Unknown keys of the file and of each routine are kept on every write. */
export const RoutineFileSchema = z
  .object({
    version: z.literal(1),
    next: z.number().int().positive(),
    routines: z.array(StoredRoutine).max(MAX_ROUTINES),
  })
  .passthrough();
export type RoutineFile = z.infer<typeof RoutineFileSchema>;
export const emptyRoutineFile = (): RoutineFile => ({ version: 1, next: 1, routines: [] });

const FireOutcome = z.discriminatedUnion('kind', [
  /** Recorded before the task route is asked, so a crash mid-start is visible to the next tick. */
  z.object({ kind: z.literal('pending') }).passthrough(),
  z.object({ kind: z.literal('started'), taskId: z.string().min(1).max(128) }).passthrough(),
  z.object({ kind: z.literal('skipped'), reason: z.literal('previous-run-active') }).passthrough(),
  z.object({ kind: z.literal('refused'), code: z.string().max(64), message: z.string().max(400) }).passthrough(),
  z.object({ kind: z.literal('failed'), message: z.string().max(400) }).passthrough(),
]);
const StoredFire = z
  .object({
    at,
    /** The due time it was for; a manual fire uses its own time. */
    dueAt: at,
    trigger: z.enum(['schedule', 'manual']),
    /** The task's `requestId`, so the task row and the fire name each other. */
    runId: z.uuid(),
    outcome: FireOutcome,
  })
  .passthrough();
export type RoutineFire = z.infer<typeof StoredFire>;
export type FireOutcome = RoutineFire['outcome'];
const StoredRoutineState = z
  .object({ lastDueAt: at.optional().catch(undefined), fires: z.array(StoredFire).max(MAX_KEPT_FIRES).catch([]) })
  .passthrough();
export type RoutineState = z.infer<typeof StoredRoutineState>;
/** `routine-state.json`, keyed by routine id. An entry for a deleted routine is ignored. */
export const RoutineStateFileSchema = z
  .object({ version: z.literal(1), routines: z.record(z.string(), StoredRoutineState) })
  .passthrough();
export type RoutineStateFile = z.infer<typeof RoutineStateFileSchema>;
export const emptyRoutineState = (): RoutineStateFile => ({ version: 1, routines: {} });

// ---- Planning -------------------------------------------------------------

/** A routine's runs as the task list shows them, found by `startedBy.routineId`. Derived, never stored. */
export type RunView = {
  active: { runId: string; taskId: string; state: TaskState }[];
  /** Newest first. */
  finished: { runId: string; taskId: string }[];
};
export const noRuns = (): RunView => ({ active: [], finished: [] });

/** What one tick decides for one routine. The runner carries it out and decides nothing itself. */
export type FirePlan =
  | { kind: 'idle'; nextRunAt: number | null }
  /** Close a pending fire: its task exists (`started`) or it was cut off (`failed`). */
  | { kind: 'settle'; fire: RoutineFire }
  /** Recorded, and the due time consumed. */
  | { kind: 'skip'; fire: RoutineFire }
  | { kind: 'start'; fire: RoutineFire; removeFirst: string[] };

/** The time due times count from: the last one consumed, never before the routine was switched on. */
const baseOf = (routine: Routine, state: RoutineState): number =>
  Math.max(state.lastDueAt ?? 0, routine.enabledAt ?? routine.updatedAt);

/** The next run time a person sees, or null when the routine is off or has no trigger this release knows. */
export function nextRunAt(routine: Routine, state: RoutineState): number | null {
  return routine.enabled ? dueAt(knownTriggers(routine), baseOf(routine, state)) : null;
}

const surplus = (runs: RunView): string[] => runs.finished.slice(KEEP_FINISHED_RUNS - 1).map((r) => r.taskId);

/**
 * The tick's decision for one routine at `now`. First match wins:
 *   1. the newest fire is pending      -> settle it as started when its task exists, as failed once it is stale,
 *                                         else start it again with the same runId (the task route answers duplicate)
 *   2. disabled                        -> idle
 *   3. no due time in (base, now]      -> idle until the next one
 *   4. a run of this routine is active -> skip (the due time is consumed)
 *   5. otherwise                       -> start, removing finished runs beyond KEEP_FINISHED_RUNS first
 * The caps are not checked here: the task route checks them inside its create queue and its refusal becomes a
 * `refused` fire. A second copy of the rule here could drift from the one agents are held to.
 */
export function planFire(routine: Routine, state: RoutineState, runs: RunView, now: number): FirePlan {
  const pending = state.fires.at(-1);
  if (pending?.outcome.kind === 'pending') {
    const run = [...runs.active, ...runs.finished].find((r) => r.runId === pending.runId);
    if (run) return { kind: 'settle', fire: { ...pending, outcome: { kind: 'started', taskId: run.taskId } } };
    if (now - pending.at > PENDING_FIRE_MS)
      return {
        kind: 'settle',
        fire: { ...pending, outcome: { kind: 'failed', message: 'The start was interrupted before it finished' } },
      };
    return { kind: 'start', fire: { ...pending, at: now }, removeFirst: surplus(runs) };
  }
  if (!routine.enabled) return { kind: 'idle', nextRunAt: null };
  const triggers = knownTriggers(routine);
  const base = baseOf(routine, state);
  const due = latestDue(triggers, base, now);
  if (due === null) return { kind: 'idle', nextRunAt: dueAt(triggers, base) };
  const fire = { at: now, dueAt: due, trigger: 'schedule' as const, runId: runRequestId(routine.id, due) };
  if (runs.active.length > 0)
    return { kind: 'skip', fire: { ...fire, outcome: { kind: 'skipped', reason: 'previous-run-active' } } };
  return { kind: 'start', fire: { ...fire, outcome: { kind: 'pending' } }, removeFirst: surplus(runs) };
}

/** Run now: the same overlap rule as a schedule, and the person's request id as the run id. */
export function planManualFire(runs: RunView, requestId: string, now: number): FirePlan {
  const fire = { at: now, dueAt: now, trigger: 'manual' as const, runId: requestId };
  if (runs.active.length > 0)
    return { kind: 'skip', fire: { ...fire, outcome: { kind: 'skipped', reason: 'previous-run-active' } } };
  return { kind: 'start', fire: { ...fire, outcome: { kind: 'pending' } }, removeFirst: surplus(runs) };
}

/**
 * The task `requestId` for one due time of one routine: a name-based UUID (SHA-256 of `routineId:dueAt`, version 8,
 * RFC variant). The same due time planned twice asks the task route for the same request, which answers `duplicate`.
 */
export function runRequestId(routineId: string, due: number): string {
  const hex = createHash('sha256').update(`${routineId}:${due}`).digest('hex').slice(0, 32).split('');
  hex[12] = '8';
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** What a run is sent: the prompt, then one line naming the routine, the due time and what it may not do. */
export function routineRequestText(routine: Routine, due: number): string {
  return `${routine.prompt}\n\n(Routine ${routineKey(routine.number)} "${routine.title}", run for ${new Date(due).toISOString()}. You were started by a routine: you cannot start canvas conversations or tasks; work in this worktree, use canvas_work for Work items, and end with a report.)`;
}
export const routineTaskName = (routine: Routine): string =>
  `Routine ${routineKey(routine.number)} · ${routine.title}`.slice(0, 100);

/** A fire added to the state, replacing one with the same runId; schedule fires advance `lastDueAt`. */
export function recordFire(state: RoutineStateFile, routineId: string, fire: RoutineFire): RoutineStateFile {
  const current = state.routines[routineId] ?? { fires: [] };
  const fires = [...current.fires.filter((f) => f.runId !== fire.runId), fire].slice(-MAX_KEPT_FIRES);
  const lastDueAt = fire.trigger === 'schedule' ? Math.max(current.lastDueAt ?? 0, fire.dueAt) : current.lastDueAt;
  return {
    ...state,
    routines: { ...state.routines, [routineId]: { ...current, fires, ...(lastDueAt ? { lastDueAt } : {}) } },
  };
}

// ---- Requests and edits ---------------------------------------------------

const Title = z.string().transform(oneLine).pipe(z.string().min(1, 'A title is needed').max(MAX_ROUTINE_TITLE_CHARS));
const Description = z.string().transform(multiLine).pipe(z.string().max(MAX_ROUTINE_DESCRIPTION_CHARS));
const Prompt = z
  .string()
  .transform(multiLine)
  .pipe(z.string().min(1, 'A prompt is needed').max(MAX_ROUTINE_PROMPT_CHARS));
const Triggers = z.array(TriggerSchema).min(1, 'A routine needs a trigger').max(MAX_ROUTINE_TRIGGERS);
const Launch = {
  cliId: z.string().min(1).max(64).optional(),
  model: z.string().max(100).optional(),
};
export const CreateRoutineSchema = z
  .object({
    requestId: z.uuid(),
    title: Title,
    description: Description.optional(),
    prompt: Prompt,
    triggers: Triggers,
    ...Launch,
    enabled: z.boolean().optional(),
  })
  .strict();
export const UpdateRoutineSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    title: Title.optional(),
    description: Description.optional(),
    prompt: Prompt.optional(),
    triggers: Triggers.optional(),
    ...Launch,
    enabled: z.boolean().optional(),
  })
  .strict();
export type CreateRoutine = z.infer<typeof CreateRoutineSchema>;
export type UpdateRoutine = z.infer<typeof UpdateRoutineSchema>;
const Key = z.union([z.string().max(16), z.number().int()]).transform((value, ctx) => {
  const n = typeof value === 'number' ? (value > 0 ? value : null) : parseRoutineKey(value);
  if (n === null) {
    ctx.addIssue({ code: 'custom', message: 'A routine key looks like R-3' });
    return z.NEVER;
  }
  return n;
});
export const RoutineToolSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('read'), key: Key }).strict(),
  z.object({ action: z.literal('create'), ...CreateRoutineSchema.shape }).strict(),
  z.object({ action: z.literal('update'), key: Key, ...UpdateRoutineSchema.shape }).strict(),
  z.object({ action: z.literal('run'), key: Key, requestId: z.uuid() }).strict(),
  z.object({ action: z.literal('delete'), key: Key }).strict(),
]);
export type RoutineTool = z.infer<typeof RoutineToolSchema>;

export const ROUTINE_REFUSALS = {
  PERSON_ONLY:
    'PERSON_ONLY: only a person can enable, run or delete a routine; draft it and ask the person to switch it on',
  CONFLICT: 'CONFLICT: the routine changed since you read it; read it again',
  TOO_MANY: `TOO_MANY: a canvas keeps at most ${MAX_ROUTINES} routines`,
  NOT_FOUND: 'NOT_FOUND: no such routine',
  REQUEST_REUSED: 'REQUEST_REUSED: this request id already made a different routine',
} as const;
export type RoutineRefusal = keyof typeof ROUTINE_REFUSALS;

/**
 * Who may do what. An agent may read, create (saved disabled) and change any field but `enabled`. Enabling, Run now
 * and delete are a person's: enabling is the moment a person authorises prompts with no human message
 * (docs/self-building.md rule 4), and an agent that could enable one would start work with no lineage to walk.
 */
export function routineRefusal(
  caller: 'person' | 'agent',
  action: 'create' | 'update' | 'run' | 'delete',
  change?: { enabled?: boolean }
): RoutineRefusal | undefined {
  if (caller === 'person') return undefined;
  if (action === 'run' || action === 'delete') return 'PERSON_ONLY';
  if (change?.enabled === true) return 'PERSON_ONLY';
  return undefined;
}

export type RoutineChange =
  | { ok: true; file: RoutineFile; routine: Routine; duplicate?: true }
  | { ok: false; code: RoutineRefusal };

export function createRoutine(
  file: RoutineFile,
  input: CreateRoutine,
  context: { author: Author; now: number }
): RoutineChange {
  const prior = file.routines.find((r) => r.requestId === input.requestId);
  if (prior)
    return prior.title === input.title && prior.prompt === input.prompt
      ? { ok: true, file, routine: prior, duplicate: true }
      : { ok: false, code: 'REQUEST_REUSED' };
  if (file.routines.length >= MAX_ROUTINES) return { ok: false, code: 'TOO_MANY' };
  const enabled = input.enabled === true;
  const routine: Routine = {
    id: input.requestId,
    number: file.next,
    title: input.title,
    description: input.description ?? '',
    prompt: input.prompt,
    triggers: input.triggers,
    ...(input.cliId ? { cliId: input.cliId } : {}),
    ...(input.model ? { model: input.model } : {}),
    enabled,
    ...(enabled ? { enabledAt: context.now } : {}),
    author: context.author,
    createdAt: context.now,
    updatedAt: context.now,
    revision: 1,
    requestId: input.requestId,
  };
  return { ok: true, file: { ...file, next: file.next + 1, routines: [...file.routines, routine] }, routine };
}

export function updateRoutine(file: RoutineFile, number: number, patch: UpdateRoutine, now: number): RoutineChange {
  const current = file.routines.find((r) => r.number === number);
  if (!current) return { ok: false, code: 'NOT_FOUND' };
  if (current.revision !== patch.expectedRevision) return { ok: false, code: 'CONFLICT' };
  const { expectedRevision: _revision, ...fields } = patch;
  void _revision;
  const switchedOn = patch.enabled === true && !current.enabled;
  const routine: Routine = {
    ...current,
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
    ...(switchedOn ? { enabledAt: now } : {}),
    updatedAt: now,
    revision: current.revision + 1,
  };
  return { ok: true, file: { ...file, routines: file.routines.map((r) => (r === current ? routine : r)) }, routine };
}

export function deleteRoutine(file: RoutineFile, number: number): RoutineChange {
  const current = file.routines.find((r) => r.number === number);
  if (!current) return { ok: false, code: 'NOT_FOUND' };
  return { ok: true, file: { ...file, routines: file.routines.filter((r) => r !== current) }, routine: current };
}

/** A routine as the list and the tool show it: its key, its derived next run and its recent fires, newest first. */
export type RoutineRow = Routine & { key: string; nextRunAt: number | null; fires: RoutineFire[] };
export function routineRow(routine: Routine, state: RoutineState | undefined): RoutineRow {
  const current = state ?? { fires: [] };
  return {
    ...routine,
    key: routineKey(routine.number),
    nextRunAt: nextRunAt(routine, current),
    fires: [...current.fires].reverse(),
  };
}
