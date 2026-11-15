/**
 * @fileoverview Carries out canvas routines (W-44). `tick()` asks `planFire` what each routine of each canvas should
 * do and does exactly that; `runNow()` is a person's Run now. Every action goes through the server's own routes with
 * `app.inject` under the in-process principal (`internal-principal.ts`): the task list to see a routine's runs, the
 * task remove for its surplus finished runs, and `POST /api/canvas/:ws/tasks` for a run, so a run meets the same
 * create queue, caps, AGENT_CAP, worktree and attribution as a person's click.
 *
 * A start is recorded as pending before the route is asked, so the due time is consumed even if the process dies
 * mid-start; the next tick finds the pending fire and settles or repeats it with the same run id, which the task route
 * answers as a duplicate. `mayAutomate` (the live deploy colour, rule 6) is checked before every write and every call.
 */
import type { FastifyInstance } from 'fastify';
import { readWorkspaces, type Workspace } from '../canvas/workspace-registry.js';
import { changeRoutineState, readRoutines, readRoutineState } from '../canvas/routine-store.js';
import { changeWork, readWork } from '../canvas/work-store.js';
import { findWork, updateWork, type WorkFile, type WorkItem } from '../canvas/work.js';
import { readConversations } from '../canvas/conversations.js';
import { startedBy } from '../canvas/agent-start.js';
import {
  CLAIM_STATUS,
  countWork,
  noRuns,
  pruneFiredItems,
  workItemTriggers,
  planFire,
  planManualFire,
  recordFire,
  routineRequestText,
  routineTaskName,
  type FirePlan,
  type Routine,
  type RoutineFire,
  type RoutineStateFile,
  type RunView,
  type WorkCounts,
} from '../canvas/routines.js';
import { taskActive, type TaskState } from '../canvas/tasks.js';
import { getErrorMessage, type AuthUser } from '../types.js';
import { internalHeaders } from './internal-principal.js';

export const ROUTINE_TICK_MS = 30_000;

export type RoutineRunnerDeps = {
  app: Pick<FastifyInstance, 'inject'>;
  canvasEnabled: () => Promise<boolean>;
  /** The workspace owner as a signed-in user, or undefined when that user is gone or disabled. */
  ownerUser: (workspace: Workspace) => Promise<AuthUser | undefined>;
  mayAutomate: () => boolean;
  /** Tells open canvases that routines or their fires changed, and with `work` that a Work item did too. */
  announce: (workspaceId: string, changed?: { work?: true }) => Promise<void>;
};

type BriefTask = { id: string; requestId: string; createdAt: number; state: TaskState; startedBy?: unknown };

/** A refused start's code: the `CODE:` the task route puts at the head of its message. */
const refusalCode = (message: string): string | undefined => /^([A-Z][A-Z_]{2,40}):/.exec(message)?.[1];

export class RoutineRunner {
  private ticking = false;
  constructor(private readonly deps: RoutineRunnerDeps) {}

  /** One pass over every canvas; a tick still running makes the next a no-op, so two never plan one routine. */
  async tick(now: number): Promise<void> {
    if (this.ticking || !this.deps.mayAutomate() || !(await this.deps.canvasEnabled())) return;
    this.ticking = true;
    try {
      for (const workspace of readWorkspaces()) {
        try {
          await this.tickWorkspace(workspace, now);
        } catch (err) {
          console.error(`[routines] workspace ${workspace.id} failed:`, getErrorMessage(err));
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async tickWorkspace(workspace: Workspace, now: number): Promise<void> {
    const routines = readRoutines(workspace.id);
    const state = readRoutineState(workspace.id);
    if (!routines.ok || !state.ok) return;
    const pending = (r: Routine) => state.file.routines[r.id]?.fires.at(-1)?.outcome.kind === 'pending';
    const due = routines.file.routines.filter((r) => r.enabled || pending(r));
    if (due.length === 0) return;
    const owner = await this.deps.ownerUser(workspace);
    if (!owner) return;
    const runs = await this.runViews(workspace, owner);
    if (!runs) return;
    const needsWork = due.some((r) => r.gates?.length || workItemTriggers(r).length);
    const workFile = needsWork ? readWorkFile(workspace.id) : undefined;
    let file = state.file;
    const pruned = workFile && pruneFiredItems(file, workFile.items);
    if (pruned && this.deps.mayAutomate() && changeRoutineState(workspace.id, () => pruned)) file = pruned;
    const work = workFile ? workCounts(workspace.id, workFile.items, file) : undefined;
    for (const routine of due) {
      const own = file.routines[routine.id] ?? { fires: [] };
      const plan = planFire(routine, own, runs(routine.id), now, work, workFile);
      await this.carryOut(workspace, routine, owner, plan);
    }
  }

  /** Run now: a person's request, held to the same overlap rule and the same route as a scheduled run. */
  async runNow(
    workspace: Workspace,
    routine: Routine,
    requestId: string,
    ignoreGates = false
  ): Promise<RoutineFire | undefined> {
    const owner = await this.deps.ownerUser(workspace);
    if (!owner) return undefined;
    const runs = await this.runViews(workspace, owner);
    if (!runs) return undefined;
    const prior = readRoutineState(workspace.id);
    const known = prior.ok ? prior.file.routines[routine.id]?.fires.find((f) => f.runId === requestId) : undefined;
    if (known && known.outcome.kind !== 'pending') return known;
    const workFile = routine.gates?.length && !ignoreGates && prior.ok ? readWorkFile(workspace.id) : undefined;
    const work = workFile && prior.ok ? workCounts(workspace.id, workFile.items, prior.file) : undefined;
    const plan = planManualFire(routine, runs(routine.id), requestId, Date.now(), work, ignoreGates);
    return this.carryOut(workspace, routine, owner, plan);
  }

  /** The runs of each routine of a canvas, read from its task list; undefined when the list could not be read. */
  private async runViews(workspace: Workspace, owner: AuthUser): Promise<((id: string) => RunView) | undefined> {
    const response = await this.deps.app.inject({
      method: 'GET',
      url: `/api/canvas/${workspace.id}/tasks?brief=1`,
      headers: internalHeaders({ user: owner }, Date.now()),
    });
    if (response.statusCode !== 200) return undefined;
    const body = response.json() as { data?: { tasks?: BriefTask[]; unreadable?: string } };
    if (!body.data?.tasks || body.data.unreadable) return undefined;
    const views = new Map<string, RunView>();
    for (const task of [...body.data.tasks].sort((a, b) => b.createdAt - a.createdAt)) {
      const by = task.startedBy as { kind?: string; routineId?: string } | undefined;
      if (by?.kind !== 'routine' || !by.routineId) continue;
      const view = views.get(by.routineId) ?? noRuns();
      if (taskActive(task.state)) view.active.push({ runId: task.requestId, taskId: task.id, state: task.state });
      else view.finished.push({ runId: task.requestId, taskId: task.id });
      views.set(by.routineId, view);
    }
    return (id) => views.get(id) ?? noRuns();
  }

  private record(workspace: Workspace, routine: Routine, fire: RoutineFire): boolean {
    if (!this.deps.mayAutomate()) return false;
    return changeRoutineState(workspace.id, (state) => recordFire(state, routine.id, fire));
  }

  private async carryOut(
    workspace: Workspace,
    routine: Routine,
    owner: AuthUser,
    plan: FirePlan
  ): Promise<RoutineFire | undefined> {
    if (plan.kind === 'idle') return undefined;
    if (!this.record(workspace, routine, plan.fire)) return undefined;
    if (plan.kind !== 'start') {
      await this.deps.announce(workspace.id);
      return plan.fire;
    }
    const principal = () =>
      internalHeaders(
        { user: owner, routine: { routineId: routine.id, runId: plan.fire.runId, workspaceId: workspace.id } },
        Date.now()
      );
    for (const taskId of plan.removeFirst) {
      if (!this.deps.mayAutomate()) return undefined;
      // The remove route keeps a worktree that has changes and reports it; a failure leaves the run listed.
      await this.deps.app
        .inject({ method: 'DELETE', url: `/api/canvas/${workspace.id}/tasks/${taskId}`, headers: principal() })
        .catch(() => undefined);
    }
    if (!this.deps.mayAutomate()) return undefined;
    let outcome = await this.start(workspace, routine, plan.fire, principal());
    const claimFor = plan.fire.work?.claim ? plan.fire.work : undefined;
    let claimed = false;
    if (claimFor && outcome.kind === 'started') {
      claimed = !!outcome.sessionId && this.deps.mayAutomate() && claim(workspace.id, claimFor, outcome.sessionId);
      outcome = { ...outcome, claimed };
    }
    const fire: RoutineFire = { ...plan.fire, outcome };
    this.record(workspace, routine, fire);
    await this.deps.announce(workspace.id, claimed ? { work: true } : undefined);
    return fire;
  }

  private async start(
    workspace: Workspace,
    routine: Routine,
    fire: RoutineFire,
    headers: Record<string, string>
  ): Promise<RoutineFire['outcome']> {
    try {
      const response = await this.deps.app.inject({
        method: 'POST',
        url: `/api/canvas/${workspace.id}/tasks`,
        headers,
        payload: {
          requestId: fire.runId,
          text: routineRequestText(routine, fire.dueAt, fire.work),
          name: routineTaskName(routine),
          ...(routine.cliId ? { cliId: routine.cliId } : {}),
          ...(routine.model ? { model: routine.model } : {}),
        },
      });
      const body = response.json() as { data?: { task?: { id?: string; sessionId?: string } }; error?: string };
      const task = body.data?.task;
      if (response.statusCode === 200 && task?.id)
        return { kind: 'started', taskId: task.id, ...(task.sessionId ? { sessionId: task.sessionId } : {}) };
      const message = (body.error ?? `The task route answered ${response.statusCode}`).slice(0, 400);
      const code = refusalCode(message);
      return response.statusCode < 500 && code ? { kind: 'refused', code, message } : { kind: 'failed', message };
    } catch (err) {
      return { kind: 'failed', message: getErrorMessage(err).slice(0, 400) };
    }
  }
}

/** The canvas's Work file, or undefined when `work.json` cannot be read (a gate then says no, and no item is due). */
function readWorkFile(workspaceId: string): WorkFile | undefined {
  const work = readWork(workspaceId);
  return work.ok ? work.file : undefined;
}

/**
 * A claiming fire's item assigned to the run's session and moved to `CLAIM_STATUS`, attributed to that session.
 * Refused (false) when the item left the status it fired on, or someone holds it (a claim never takes an item from a
 * person or another session), or it changed under the write (`expectedRevision`). A repeated start whose item this session already holds counts as claimed.
 */
function claim(workspaceId: string, work: NonNullable<RoutineFire['work']>, sessionId: string): boolean {
  const result = changeWork(workspaceId, (file) => {
    const item = findWork(file, work.number);
    if (
      item &&
      item.status === CLAIM_STATUS &&
      item.assignee?.kind === 'session' &&
      item.assignee.sessionId === sessionId
    )
      return { ok: true, file, item, filed: [], duplicate: true };
    if (!item || item.status !== work.status || item.assignee !== null)
      return {
        ok: false,
        code: 'CONFLICT',
        message: 'The item left its status or was taken before the run claimed it',
      };
    return updateWork(
      file,
      work.number,
      { expectedRevision: item.revision, status: CLAIM_STATUS, assignee: { kind: 'session', sessionId } },
      { author: { kind: 'agent', sessionId }, now: Date.now() }
    );
  });
  return result.ok;
}

/**
 * The canvas's Work items counted for gates. A routine run's session is known from the task records (`startedBy`
 * with a routine) and, for runs whose record was removed since, from the started fires the state keeps.
 */
function workCounts(workspaceId: string, items: readonly WorkItem[], state: RoutineStateFile): WorkCounts {
  const sessions = new Set<string>();
  const conversations = readConversations(workspaceId);
  if (conversations.ok)
    for (const c of conversations.conversations) if (startedBy(c)?.kind === 'routine') sessions.add(c.sessionId);
  for (const routine of Object.values(state.routines))
    for (const fire of routine.fires)
      if (fire.outcome.kind === 'started' && fire.outcome.sessionId) sessions.add(fire.outcome.sessionId);
  return countWork(items, sessions);
}
