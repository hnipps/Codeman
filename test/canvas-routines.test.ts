/**
 * Canvas routines, the pure core (src/canvas/routines.ts): due times over triggers, collapsed missed fires, the
 * planner's table, the run request id, who may do what, and the edits. The routes and the runner are covered in
 * test/routes/canvas-routine-routes.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createRoutine,
  CreateRoutineSchema,
  dueAt,
  emptyRoutineFile,
  emptyRoutineState,
  KEEP_FINISHED_RUNS,
  latestDue,
  MAX_KEPT_FIRES,
  MAX_ROUTINES,
  noRuns,
  PENDING_FIRE_MS,
  planFire,
  planManualFire,
  recordFire,
  RoutineFileSchema,
  routineRefusal,
  routineRow,
  runRequestId,
  TriggerSchema,
  updateRoutine,
  type Routine,
  type RoutineFire,
  type RunView,
} from '../src/canvas/routines.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const human = { kind: 'human' as const, userId: 'admin' };
const T0 = new Date(2026, 10, 16, 6, 0, 0, 0).getTime(); // a Monday, 06:00 local

const routine = (fields: Partial<Routine> = {}): Routine => ({
  id: '11111111-1111-4111-8111-111111111111',
  number: 1,
  title: 'Refine',
  description: '',
  prompt: 'Refine the backlog',
  triggers: [{ kind: 'interval', minutes: 30 }],
  enabled: true,
  enabledAt: T0,
  author: human,
  createdAt: T0,
  updatedAt: T0,
  revision: 1,
  ...fields,
});
const runs = (fields: Partial<RunView> = {}): RunView => ({ ...noRuns(), ...fields });

describe('due times', () => {
  it('takes the earliest next time across triggers', () => {
    const at = dueAt(
      [
        { kind: 'interval', minutes: 120 },
        { kind: 'daily', time: '07:00' },
      ],
      T0
    );
    expect(at).toBe(T0 + HOUR);
  });
  it('refuses an interval under the minimum and a bad time or repeated day', () => {
    expect(TriggerSchema.safeParse({ kind: 'interval', minutes: 14 }).success).toBe(false);
    expect(TriggerSchema.safeParse({ kind: 'interval', minutes: 15 }).success).toBe(true);
    expect(TriggerSchema.safeParse({ kind: 'daily', time: '25:00' }).success).toBe(false);
    expect(TriggerSchema.safeParse({ kind: 'weekly', days: [1, 1], time: '07:00' }).success).toBe(false);
  });
  it('collapses missed due times into the latest one', () => {
    expect(latestDue([{ kind: 'interval', minutes: 30 }], T0, T0 + 24 * HOUR + 5 * MIN)).toBe(T0 + 24 * HOUR);
    expect(latestDue([{ kind: 'interval', minutes: 30 }], T0, T0 + 29 * MIN)).toBeNull();
    // Down from Monday 06:00 to Thursday 08:00 with a daily 07:00: Thursday's 07:00 only.
    expect(latestDue([{ kind: 'daily', time: '07:00' }], T0, T0 + 3 * 24 * HOUR + 2 * HOUR)).toBe(
      T0 + 3 * 24 * HOUR + HOUR
    );
  });
});

describe('the planner', () => {
  it('is idle when disabled, and idle until the next due time', () => {
    expect(planFire(routine({ enabled: false }), { fires: [] }, runs(), T0 + 5 * HOUR)).toEqual({
      kind: 'idle',
      nextRunAt: null,
    });
    expect(planFire(routine(), { fires: [] }, runs(), T0 + 10 * MIN)).toEqual({
      kind: 'idle',
      nextRunAt: T0 + 30 * MIN,
    });
  });
  it('never fires a due time from before the routine was switched on', () => {
    const r = routine({ enabledAt: T0 + 10 * HOUR });
    expect(planFire(r, { lastDueAt: T0, fires: [] }, runs(), T0 + 10 * HOUR + MIN).kind).toBe('idle');
  });
  it('starts once for many missed due times, with a run id named after the due time', () => {
    const plan = planFire(routine(), { fires: [] }, runs(), T0 + 5 * HOUR + MIN);
    expect(plan).toMatchObject({ kind: 'start', fire: { dueAt: T0 + 5 * HOUR, trigger: 'schedule' } });
    if (plan.kind !== 'start') throw new Error('expected a start');
    expect(plan.fire.runId).toBe(runRequestId(routine().id, T0 + 5 * HOUR));
    expect(plan.fire.outcome).toEqual({ kind: 'pending' });
  });
  it('skips, and consumes the due time, while a run of the routine is still active', () => {
    const active = runs({ active: [{ runId: 'x', taskId: 't', state: 'running' }] });
    const plan = planFire(routine(), { fires: [] }, active, T0 + HOUR);
    expect(plan).toMatchObject({ kind: 'skip', fire: { outcome: { kind: 'skipped', reason: 'previous-run-active' } } });
    if (plan.kind !== 'skip') throw new Error('expected a skip');
    const after = recordFire(emptyRoutineState(), routine().id, plan.fire);
    expect(planFire(routine(), after.routines[routine().id]!, active, T0 + HOUR + MIN).kind).toBe('idle');
  });
  it('removes finished runs beyond the kept few before a start', () => {
    const finished = Array.from({ length: 5 }, (_, i) => ({ runId: `r${i}`, taskId: `t${i}` }));
    const plan = planFire(routine(), { fires: [] }, runs({ finished }), T0 + HOUR);
    if (plan.kind !== 'start') throw new Error('expected a start');
    expect(plan.removeFirst).toEqual(finished.slice(KEEP_FINISHED_RUNS - 1).map((r) => r.taskId));
  });
  it('settles a pending fire whose task exists, retries a recent one, and fails a stale one', () => {
    const pending: RoutineFire = {
      at: T0 + HOUR,
      dueAt: T0 + HOUR,
      trigger: 'schedule',
      runId: runRequestId(routine().id, T0 + HOUR),
      outcome: { kind: 'pending' },
    };
    const state = { lastDueAt: T0 + HOUR, fires: [pending] };
    const found = runs({ active: [{ runId: pending.runId, taskId: 'task-1', state: 'running' }] });
    expect(planFire(routine(), state, found, T0 + HOUR + MIN)).toMatchObject({
      kind: 'settle',
      fire: { runId: pending.runId, outcome: { kind: 'started', taskId: 'task-1' } },
    });
    expect(planFire(routine(), state, runs(), T0 + HOUR + MIN)).toMatchObject({
      kind: 'start',
      fire: { runId: pending.runId },
    });
    expect(planFire(routine(), state, runs(), T0 + HOUR + PENDING_FIRE_MS + 1)).toMatchObject({
      kind: 'settle',
      fire: { outcome: { kind: 'failed' } },
    });
    // Even a routine switched off since: the pending start is finished first.
    expect(planFire(routine({ enabled: false }), state, found, T0 + 2 * HOUR).kind).toBe('settle');
  });
  it('Run now is held to the same overlap rule', () => {
    const id = crypto.randomUUID();
    expect(planManualFire(runs(), id, T0)).toMatchObject({ kind: 'start', fire: { runId: id, trigger: 'manual' } });
    expect(planManualFire(runs({ active: [{ runId: 'x', taskId: 't', state: 'queued' }] }), id, T0).kind).toBe('skip');
  });
});

describe('the run request id', () => {
  it('is stable per due time, differs across due times and routines, and is a valid uuid', () => {
    const a = runRequestId('r1', T0);
    expect(runRequestId('r1', T0)).toBe(a);
    expect(runRequestId('r1', T0 + 1)).not.toBe(a);
    expect(runRequestId('r2', T0)).not.toBe(a);
    expect(z.uuid().safeParse(a).success).toBe(true);
  });
});

describe('fires recorded', () => {
  it('replaces a fire by run id, keeps the newest few, and advances lastDueAt only for schedule fires', () => {
    let state = emptyRoutineState();
    const fire = (i: number, trigger: 'schedule' | 'manual' = 'schedule'): RoutineFire => ({
      at: T0 + i,
      dueAt: T0 + i,
      trigger,
      runId: runRequestId('r', i),
      outcome: { kind: 'pending' },
    });
    for (let i = 0; i < MAX_KEPT_FIRES + 5; i++) state = recordFire(state, 'r', fire(i));
    expect(state.routines.r!.fires).toHaveLength(MAX_KEPT_FIRES);
    state = recordFire(state, 'r', { ...fire(MAX_KEPT_FIRES + 4), outcome: { kind: 'started', taskId: 't' } });
    expect(state.routines.r!.fires).toHaveLength(MAX_KEPT_FIRES);
    expect(state.routines.r!.fires.at(-1)!.outcome).toEqual({ kind: 'started', taskId: 't' });
    const lastDueAt = state.routines.r!.lastDueAt;
    state = recordFire(state, 'r', fire(10_000, 'manual'));
    expect(state.routines.r!.lastDueAt).toBe(lastDueAt);
  });
});

describe('who may do what', () => {
  it('lets an agent draft and edit, never enable, run or delete', () => {
    expect(routineRefusal('agent', 'create')).toBeUndefined();
    expect(routineRefusal('agent', 'update', { enabled: false })).toBeUndefined();
    expect(routineRefusal('agent', 'update', { enabled: true })).toBe('PERSON_ONLY');
    expect(routineRefusal('agent', 'create', { enabled: true })).toBe('PERSON_ONLY');
    expect(routineRefusal('agent', 'run')).toBe('PERSON_ONLY');
    expect(routineRefusal('agent', 'delete')).toBe('PERSON_ONLY');
    expect(routineRefusal('person', 'run')).toBeUndefined();
  });
});

describe('edits', () => {
  const body = (fields: Record<string, unknown> = {}) =>
    CreateRoutineSchema.parse({
      requestId: crypto.randomUUID(),
      title: 'Ship one',
      prompt: 'Take the oldest Todo item',
      triggers: [{ kind: 'daily', time: '07:00' }],
      ...fields,
    });
  it('creates with a key, dedupes by request id, and caps the count', () => {
    const input = body();
    const first = createRoutine(emptyRoutineFile(), input, { author: human, now: T0 });
    if (!first.ok) throw new Error('refused');
    expect(routineRow(first.routine, undefined)).toMatchObject({ key: 'R-1', enabled: false, nextRunAt: null });
    const again = createRoutine(first.file, input, { author: human, now: T0 + 1 });
    expect(again).toMatchObject({ ok: true, duplicate: true });
    let file = emptyRoutineFile();
    for (let i = 0; i < MAX_ROUTINES; i++) {
      const made = createRoutine(file, body(), { author: human, now: T0 });
      if (!made.ok) throw new Error('refused');
      file = made.file;
    }
    expect(createRoutine(file, body(), { author: human, now: T0 })).toEqual({ ok: false, code: 'TOO_MANY' });
  });
  it('guards a change with its revision and stamps enabledAt only when switched on', () => {
    const made = createRoutine(emptyRoutineFile(), body(), { author: human, now: T0 });
    if (!made.ok) throw new Error('refused');
    expect(updateRoutine(made.file, 1, { expectedRevision: 2, title: 'x' }, T0)).toEqual({
      ok: false,
      code: 'CONFLICT',
    });
    const on = updateRoutine(made.file, 1, { expectedRevision: 1, enabled: true }, T0 + HOUR);
    if (!on.ok) throw new Error('refused');
    expect(on.routine).toMatchObject({ enabled: true, enabledAt: T0 + HOUR, revision: 2 });
    const edited = updateRoutine(on.file, 1, { expectedRevision: 2, title: 'Renamed' }, T0 + 2 * HOUR);
    if (!edited.ok) throw new Error('refused');
    expect(edited.routine.enabledAt).toBe(T0 + HOUR);
  });
  it('keeps fields and trigger kinds a later release wrote', () => {
    const made = createRoutine(emptyRoutineFile(), body(), { author: human, now: T0 });
    if (!made.ok) throw new Error('refused');
    const later = JSON.parse(JSON.stringify(made.file));
    later.flag = 1;
    later.routines[0].colour = 'red';
    later.routines[0].triggers.push({ kind: 'work', status: 'todo' });
    const read = RoutineFileSchema.parse(later);
    const edited = updateRoutine(read, 1, { expectedRevision: 1, title: 'Renamed' }, T0);
    if (!edited.ok) throw new Error('refused');
    const out = JSON.parse(JSON.stringify(edited.file));
    expect(out.flag).toBe(1);
    expect(out.routines[0].colour).toBe('red');
    expect(out.routines[0].triggers).toContainEqual({ kind: 'work', status: 'todo' });
  });
});
