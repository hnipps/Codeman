/**
 * Canvas routines, the pure core (src/canvas/routines.ts): due times over triggers, collapsed missed fires, the
 * planner's table, the run request id, who may do what, and the edits. The routes and the runner are covered in
 * test/routes/canvas-routine-routes.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createWork,
  emptyWorkFile,
  laneOrder,
  updateWork,
  WORK_STATUSES,
  type WorkFile,
  type WorkStatus,
} from '../src/canvas/work.js';
import {
  CLAIM_STATUS,
  countWork,
  createRoutine,
  dueWorkItem,
  enteredAt,
  pruneFiredItems,
  gateRefusal,
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
  routineRequestText,
  routineRow,
  runRequestId,
  TriggerSchema,
  updateRoutine,
  type Routine,
  type RoutineFire,
  type RoutineGate,
  type RunView,
  type WorkCounts,
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
    expect(planManualFire(routine(), runs(), id, T0)).toMatchObject({
      kind: 'start',
      fire: { runId: id, trigger: 'manual' },
    });
    expect(
      planManualFire(routine(), runs({ active: [{ runId: 'x', taskId: 't', state: 'queued' }] }), id, T0).kind
    ).toBe('skip');
  });
});

describe('gates', () => {
  const gate = (fields: Partial<RoutineGate>): RoutineGate => ({
    kind: 'work-count',
    status: 'todo',
    assignee: 'any',
    ...fields,
  });
  const ROUTINE_RUN = 'sess-routine-run';
  const items = [
    { status: 'todo', assignee: null },
    { status: 'todo', assignee: null },
    { status: 'todo', assignee: { kind: 'person' } },
    { status: 'in-progress', assignee: { kind: 'session', sessionId: ROUTINE_RUN } },
    { status: 'in-progress', assignee: { kind: 'session', sessionId: 'sess-person-chat' } },
    { status: 'done', assignee: { kind: 'session', sessionId: ROUTINE_RUN } },
  ];
  const work = countWork(items, new Set([ROUTINE_RUN]));

  it('counts by status and each assignee filter', () => {
    expect(work('todo', 'any')).toBe(3);
    expect(work('todo', 'none')).toBe(2);
    expect(work('todo', 'routine')).toBe(0);
    expect(work('in-progress', 'any')).toBe(2);
    expect(work('in-progress', 'none')).toBe(0);
    expect(work('in-progress', 'routine')).toBe(1);
    expect(work('backlog', 'any')).toBe(0);
  });

  it.each([
    // [gate, count it sees, passes]
    ['min passes at min', gate({ min: 2, assignee: 'none' }), true],
    ['min fails below min', gate({ min: 3, assignee: 'none' }), false],
    ['max passes below max', gate({ status: 'in-progress', assignee: 'routine', max: 2 }), true],
    ['max fails at max', gate({ status: 'in-progress', assignee: 'routine', max: 1 }), false],
    ['max 0 always fails', gate({ status: 'backlog', max: 0 }), false],
    ['both pass inside the range', gate({ min: 1, max: 4 }), true],
    ['both fail above the range', gate({ min: 1, max: 3 }), false],
    ['both fail below the range', gate({ status: 'backlog', min: 1, max: 3 }), false],
    ['any counts every assignee', gate({ status: 'in-progress', assignee: 'any', min: 2 }), true],
    ['none counts only unassigned', gate({ status: 'in-progress', assignee: 'none', min: 1 }), false],
  ] as const)('%s', (_name, g, passes) => {
    const refusal = gateRefusal({ gates: [g] }, work);
    if (passes) expect(refusal).toBeNull();
    else expect(refusal).toEqual({ gate: 0, count: work(g.status, g.assignee) });
  });

  it("Harry's two cases: a cap on items picked up, and nothing to pick", () => {
    const cap = gate({ status: 'in-progress', assignee: 'routine', max: 2 });
    const something = gate({ status: 'todo', assignee: 'none', min: 1 });
    const busy = countWork(
      [
        { status: 'todo', assignee: null },
        { status: 'in-progress', assignee: { kind: 'session', sessionId: 'a' } },
        { status: 'in-progress', assignee: { kind: 'session', sessionId: 'b' } },
      ],
      new Set(['a', 'b'])
    );
    expect(gateRefusal({ gates: [something, cap] }, busy)).toEqual({ gate: 1, count: 2 });
    const empty = countWork([], new Set());
    expect(gateRefusal({ gates: [something, cap] }, empty)).toEqual({ gate: 0, count: 0 });
  });

  it('says no for a gate it cannot read, and when the items could not be counted', () => {
    expect(gateRefusal({ gates: [{ kind: 'label-count' }] }, work)).toEqual({ gate: 0 });
    expect(gateRefusal({ gates: [gate({ min: 1 })] }, undefined)).toEqual({ gate: 0 });
    expect(gateRefusal({ gates: [] }, undefined)).toBeNull();
    expect(gateRefusal({}, undefined)).toBeNull();
  });

  it('refuses a gate with neither bound, or a negative one', () => {
    const schema = CreateRoutineSchema.shape.gates;
    expect(schema.safeParse([gate({})]).success).toBe(false);
    expect(schema.safeParse([gate({ min: -1 })]).success).toBe(false);
    expect(schema.safeParse([gate({ min: 1.5 })]).success).toBe(false);
    expect(schema.safeParse([gate({ max: 0 })]).success).toBe(true);
  });

  it('skips a due time a gate refuses, consuming it, after the active-run rule', () => {
    const gated = routine({ gates: [gate({ status: 'todo', assignee: 'none', min: 5 })] });
    const plan = planFire(gated, { fires: [] }, runs(), T0 + HOUR, work);
    expect(plan).toMatchObject({
      kind: 'skip',
      fire: { dueAt: T0 + HOUR, trigger: 'schedule', outcome: { kind: 'skipped', reason: 'gate', gate: 0, count: 2 } },
    });
    if (plan.kind !== 'skip') throw new Error('expected a skip');
    const state = recordFire(emptyRoutineState(), gated.id, plan.fire).routines[gated.id]!;
    expect(state.lastDueAt).toBe(T0 + HOUR);
    expect(planFire(gated, state, runs(), T0 + HOUR + MIN, work).kind).toBe('idle');
    const active = runs({ active: [{ runId: 'x', taskId: 't', state: 'running' }] });
    expect(planFire(gated, { fires: [] }, active, T0 + HOUR, work)).toMatchObject({
      fire: { outcome: { reason: 'previous-run-active' } },
    });
    const open: WorkCounts = () => 9;
    expect(planFire(gated, { fires: [] }, runs(), T0 + HOUR, open).kind).toBe('start');
  });

  it('holds Run now to the gates unless the person asks to ignore them', () => {
    const gated = routine({ gates: [gate({ min: 99 })] });
    const id = crypto.randomUUID();
    expect(planManualFire(gated, runs(), id, T0, work)).toMatchObject({
      kind: 'skip',
      fire: { outcome: { reason: 'gate', gate: 0, count: 3 } },
    });
    expect(planManualFire(gated, runs(), id, T0, work, true).kind).toBe('start');
    expect(planManualFire(gated, runs(), id, T0, undefined, true).kind).toBe('start');
  });

  it('tells a run to claim its items only when a gate counts routine-assigned items', () => {
    expect(routineRequestText(routine(), T0)).not.toContain('assignee "me"');
    const capped = routine({ gates: [gate({ status: 'in-progress', assignee: 'routine', max: 2 })] });
    expect(routineRequestText(capped, T0)).toContain('assignee "me"');
  });
});

describe('work-item triggers', () => {
  // Any lane but Backlog and the claim lane, taken from the exported list so a status split keeps this meaningful.
  const LANE = WORK_STATUSES.find((s) => s !== 'backlog' && s !== CLAIM_STATUS)!;
  const OTHER: WorkStatus = 'backlog';
  const agent = { kind: 'agent' as const, sessionId: 'sess-a' };
  const file = (...entries: { status: WorkStatus; at: number; assigned?: boolean }[]): WorkFile => {
    let f = emptyWorkFile();
    for (const [i, e] of entries.entries()) {
      const made = createWork(f, { title: `Item ${i + 1}`, status: e.status }, { author: human, now: e.at });
      if (!made.ok) throw new Error(made.message);
      f = made.file;
      if (e.assigned) {
        const assigned = updateWork(f, i + 1, { assignee: { kind: 'person' } }, { author: human, now: e.at });
        if (!assigned.ok) throw new Error(assigned.message);
        f = assigned.file;
      }
    }
    return f;
  };
  const move = (f: WorkFile, n: number, status: WorkStatus, now: number): WorkFile => {
    const moved = updateWork(f, n, { status }, { author: human, now });
    if (!moved.ok) throw new Error(moved.message);
    return moved.file;
  };
  const picker = (fields: Record<string, unknown> = {}) =>
    routine({ triggers: [{ kind: 'work-item', status: LANE, ...fields } as never] });
  const empty = { fires: [] };

  it('validates the status against the Work statuses', () => {
    expect(TriggerSchema.safeParse({ kind: 'work-item', status: LANE, claim: true }).success).toBe(true);
    expect(TriggerSchema.safeParse({ kind: 'work-item', status: 'someday' }).success).toBe(false);
  });

  it('reads when an item entered its status: the newest move, else its creation, never a later edit', () => {
    let f = file({ status: OTHER, at: T0 });
    expect(enteredAt(f.items[0]!)).toBe(T0);
    f = move(f, 1, LANE, T0 + HOUR);
    expect(enteredAt(f.items[0]!)).toBe(T0 + HOUR);
    const edited = updateWork(f, 1, { title: 'Renamed' }, { author: agent, now: T0 + 2 * HOUR });
    expect(edited.ok && enteredAt(edited.item)).toBe(T0 + HOUR);
    // A history that no longer holds the move (capped) gives no time; the planner then keys on createdAt.
    expect(enteredAt({ ...f.items[0]!, history: [] })).toBeNull();
  });

  it('takes the first item in lane order that it has not fired for, and skips assigned ones when asked', () => {
    const f = file({ status: LANE, at: T0, assigned: true }, { status: OTHER, at: T0 }, { status: LANE, at: T0 });
    expect(laneOrder(f.items).map((i) => i.number)).toEqual([1, 2, 3]);
    expect(dueWorkItem(picker(), empty, f.items)?.item.number).toBe(1);
    expect(dueWorkItem(picker({ unassignedOnly: true }), empty, f.items)?.item.number).toBe(3);
    expect(dueWorkItem(routine(), empty, f.items)).toBeNull();
  });

  it('fires once per entry: a started fire marks the item, a re-entry makes it due again', () => {
    let f = file({ status: LANE, at: T0 });
    const r = picker({ claim: true });
    const plan = planFire(r, empty, noRuns(), T0 + MIN, undefined, f.items);
    expect(plan.kind).toBe('start');
    if (plan.kind !== 'start') return;
    expect(plan.fire).toMatchObject({
      trigger: 'work-item',
      dueAt: T0,
      work: { number: 1, status: LANE, claim: true },
    });
    let state = recordFire(emptyRoutineState(), r.id, plan.fire);
    state = recordFire(state, r.id, { ...plan.fire, outcome: { kind: 'started', taskId: 't1' } });
    const own = () => state.routines[r.id]!;
    expect(planFire(r, own(), noRuns(), T0 + 2 * MIN, undefined, f.items).kind).toBe('idle');
    // An edit that is not a move leaves it fired.
    const edited = updateWork(f, 1, { title: 'Sharper' }, { author: agent, now: T0 + 3 * MIN });
    if (edited.ok) f = edited.file;
    expect(planFire(r, own(), noRuns(), T0 + 4 * MIN, undefined, f.items).kind).toBe('idle');
    // Out and back in: due again with a new run id.
    f = move(move(f, 1, OTHER, T0 + 5 * MIN), 1, LANE, T0 + 6 * MIN);
    const again = planFire(r, own(), noRuns(), T0 + 7 * MIN, undefined, f.items);
    expect(again.kind === 'start' && again.fire.runId !== plan.fire.runId && again.fire.dueAt).toBe(T0 + 6 * MIN);
  });

  it('leaves the item due after a refused start, and a run of another item does not hold it back', () => {
    const f = file({ status: LANE, at: T0 }, { status: LANE, at: T0 });
    const r = picker();
    const first = planFire(r, empty, noRuns(), T0, undefined, f.items);
    if (first.kind !== 'start') throw new Error('expected a start');
    let state = recordFire(emptyRoutineState(), r.id, first.fire);
    state = recordFire(state, r.id, { ...first.fire, outcome: { kind: 'refused', code: 'AGENT_CAP', message: 'x' } });
    const retry = planFire(r, state.routines[r.id]!, noRuns(), T0 + MIN, undefined, f.items);
    expect(retry.kind === 'start' && retry.fire.runId).toBe(first.fire.runId);
    state = recordFire(state, r.id, { ...first.fire, outcome: { kind: 'started', taskId: 't1' } });
    const busy: RunView = { active: [{ runId: first.fire.runId, taskId: 't1', state: 'working' }], finished: [] };
    const second = planFire(r, state.routines[r.id]!, busy, T0 + 2 * MIN, undefined, f.items);
    expect(second.kind === 'start' && second.fire.work?.number).toBe(2);
  });

  it('records a gate skip once per item and count, and never consumes the item', () => {
    const f = file({ status: LANE, at: T0 });
    const r = { ...picker(), gates: [{ kind: 'work-count', status: CLAIM_STATUS, assignee: 'routine', max: 1 }] };
    const full: WorkCounts = () => 1;
    const skip = planFire(r, empty, noRuns(), T0, full, f.items);
    expect(skip.kind === 'skip' && skip.fire.outcome).toMatchObject({ kind: 'skipped', reason: 'gate', count: 1 });
    if (skip.kind !== 'skip') return;
    const state = recordFire(emptyRoutineState(), r.id, skip.fire);
    expect(state.routines[r.id]!.items ?? []).toEqual([]);
    expect(planFire(r, state.routines[r.id]!, noRuns(), T0 + MIN, full, f.items).kind).toBe('idle');
    expect(planFire(r, state.routines[r.id]!, noRuns(), T0 + MIN, () => 0, f.items).kind).toBe('start');
  });

  it('a pending claiming fire whose task exists starts again, so the duplicate answer names the session', () => {
    const f = file({ status: LANE, at: T0 });
    const r = picker({ claim: true });
    const plan = planFire(r, empty, noRuns(), T0, undefined, f.items);
    if (plan.kind !== 'start') throw new Error('expected a start');
    const state = recordFire(emptyRoutineState(), r.id, plan.fire);
    const runs: RunView = { active: [{ runId: plan.fire.runId, taskId: 't1', state: 'working' }], finished: [] };
    expect(planFire(r, state.routines[r.id]!, runs, T0 + MIN, undefined, f.items)).toMatchObject({
      kind: 'start',
      removeFirst: [],
    });
  });

  it('forgets fired items that left their status, and schedules ignore work-item triggers', () => {
    let f = file({ status: LANE, at: T0 });
    const r = picker();
    const plan = planFire(r, empty, noRuns(), T0, undefined, f.items);
    if (plan.kind !== 'start') throw new Error('expected a start');
    const state = recordFire(emptyRoutineState(), r.id, plan.fire);
    expect(pruneFiredItems(state, f.items)).toBeNull();
    f = move(f, 1, OTHER, T0 + MIN);
    expect(pruneFiredItems(state, f.items)!.routines[r.id]!.items).toEqual([]);
    expect(routineRow(r, undefined).nextRunAt).toBeNull();
  });

  it('names the item in the request, never its text', () => {
    const text = routineRequestText(picker(), T0, { number: 7, status: LANE, enteredAt: T0, claim: true });
    expect(text).toContain('W-7');
    expect(text).toContain('canvas_work');
    expect(text).not.toContain('assignee "me"');
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
  it('switches an enabled routine off when an agent changes what it runs, and only then', () => {
    const made = createRoutine(emptyRoutineFile(), body(), { author: human, now: T0 });
    if (!made.ok) throw new Error('refused');
    const on = updateRoutine(made.file, 1, { expectedRevision: 1, enabled: true }, T0);
    if (!on.ok) throw new Error('refused');
    const renamed = updateRoutine(on.file, 1, { expectedRevision: 2, title: 'Renamed' }, T0, 'agent');
    if (!renamed.ok) throw new Error('refused');
    expect(renamed.routine.enabled).toBe(true);
    const same = updateRoutine(
      renamed.file,
      1,
      { expectedRevision: 3, prompt: 'Take the oldest Todo item' },
      T0,
      'agent'
    );
    if (!same.ok) throw new Error('refused');
    expect(same.routine.enabled).toBe(true);
    const rewritten = updateRoutine(same.file, 1, { expectedRevision: 4, prompt: 'Something else' }, T0, 'agent');
    if (!rewritten.ok) throw new Error('refused');
    expect(rewritten.routine.enabled).toBe(false);
    const byPerson = updateRoutine(same.file, 1, { expectedRevision: 4, prompt: 'Something else' }, T0, 'person');
    if (!byPerson.ok) throw new Error('refused');
    expect(byPerson.routine.enabled).toBe(true);
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

describe('the Routines tab', () => {
  it('labels triggers and fires in words', async () => {
    const { triggerLabel, fireLabel, gateLabel } = await import('../packages/canvas/src/routines-view.js');
    expect(gateLabel({ kind: 'work-count', status: 'in-progress', assignee: 'routine', max: 2 })).toBe(
      'In progress, a routine run: fewer than 2'
    );
    expect(gateLabel({ kind: 'work-count', status: 'todo', assignee: 'none', min: 1, max: 5 })).toBe(
      'Todo, unassigned: at least 1 and fewer than 5'
    );
    const gated = { runId: 'r', dueAt: 0, at: 0, trigger: 'schedule' };
    expect(fireLabel({ ...gated, outcome: { kind: 'skipped', reason: 'gate', gate: 1, count: 2 } } as never)).toBe(
      'Scheduled · skipped: gate 2 (count 2)'
    );
    expect(triggerLabel({ kind: 'interval', minutes: 120 })).toBe('Every 2 h');
    expect(triggerLabel({ kind: 'interval', minutes: 45 })).toBe('Every 45 min');
    expect(triggerLabel({ kind: 'daily', time: '07:30' })).toBe('Daily at 07:30');
    expect(triggerLabel({ kind: 'weekly', days: [5, 1], time: '09:00' })).toBe('Mon, Fri at 09:00');
    const fire = { runId: 'r', dueAt: 0, at: 0 };
    expect(fireLabel({ ...fire, trigger: 'manual', outcome: { kind: 'skipped' } } as never)).toBe(
      'Run now · skipped, the last run was still going'
    );
    expect(
      fireLabel({
        ...fire,
        trigger: 'schedule',
        outcome: { kind: 'refused', code: 'AGENT_CAP', message: 'x' },
      } as never)
    ).toBe('Scheduled · refused (AGENT_CAP)');
  });

  it('sets every routine string as text and starts nothing by itself', () => {
    const source = readFileSync(resolve(__dirname, '../packages/canvas/src/routines-view.ts'), 'utf8');
    expect(source).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    // The only writes are the person's presses: Enabled, Run now, Save/Create and Delete.
    expect(source.match(/this\.request\('(POST|PATCH|DELETE)'/g)?.length).toBe(5);
  });
});
