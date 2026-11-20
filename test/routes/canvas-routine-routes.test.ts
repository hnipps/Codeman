/**
 * Canvas routines through the real routes and the real runner (W-44): who may do what, and that a fire is an ordinary
 * background task started through the task route, held to AGENT_CAP, deduped per due time, skipped while the previous
 * run is active, and never made on a candidate or retired colour. Worktrees are real git in a temporary repository;
 * sessions are the test port's stand-ins, so no agent runs here.
 */
import Fastify from 'fastify';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCanvasRoutes } from '../../src/web/routes/canvas-routes.js';
import { settleDeliveries, settleReplies } from '../../src/web/routes/canvas-conversation-routes.js';
import { forgetLeftBehind } from '../../src/web/routes/canvas-task-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { resolveCasesDir } from '../../src/web/route-helpers.js';
import { registerInternalPrincipal } from '../../src/web/internal-principal.js';
import { RoutineRunner } from '../../src/web/routine-runner.js';
import { announceRoutines } from '../../src/web/routes/canvas-routine-routes.js';
import { CanvasStores } from '../../src/canvas/canvas-store.js';
import { workspaceForCase } from '../../src/canvas/workspace-registry.js';
import { readConversations } from '../../src/canvas/conversations.js';
import { routineStatePath } from '../../src/canvas/routine-store.js';
import { CLAIM_STATUS, runRequestId, type RoutineRow } from '../../src/canvas/routines.js';
import { WORK_STATUSES, type WorkRow } from '../../src/canvas/work.js';
import type { TaskRow } from '../../src/canvas/tasks.js';
import { deployRole } from '../../src/deploy-role.js';
import { safeRmHomeTree } from '../mocks/test-helpers.js';

let dir: string;
const cases: string[] = [];
const uuid = () => crypto.randomUUID();
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-routine-'));
  vi.stubEnv('CODEMAN_DATA_DIR', dir);
  forgetLeftBehind();
});
afterEach(() => {
  deployRole.initFromEnv({});
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
  for (const path of cases.splice(0)) safeRmHomeTree(path);
});

async function harness() {
  const caseName = `routine-case-${uuid().slice(0, 8)}`;
  const casePath = join(resolveCasesDir(), caseName);
  mkdirSync(casePath, { recursive: true });
  cases.push(casePath);
  git(casePath, 'init', '-q', '-b', 'main');
  writeFileSync(join(casePath, 'README.md'), 'hello\n');
  git(casePath, 'add', 'README.md');
  git(casePath, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'first');

  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    req.authUser = { username: 'admin', role: 'admin' };
  });
  registerInternalPrincipal(app);
  const sessions = new Map<string, Record<string, unknown>>();
  const restore = { done: true };
  const stores = new CanvasStores();
  const started: { headers: Record<string, unknown>; request: Record<string, unknown> }[] = [];
  let counter = 0;
  const port: Record<string, unknown> = {
    sessions,
    canvasEnabled: async () => true,
    canvasStores: async () => stores,
    broadcast: vi.fn(),
    transcriptRows: vi.fn(async () => null),
    transcriptStamp: vi.fn(async () => null),
    transcriptModifiedAt: vi.fn(async () => null),
    turnEndObservedAt: () => 0,
    startConversationSession: vi.fn(
      async (headers: Record<string, unknown>, request: { workingDir: string; name: string }) => {
        started.push({ headers, request });
        const id = `session-${++counter}`;
        sessions.set(id, {
          id,
          workingDir: request.workingDir,
          name: request.name,
          writeViaMux: vi.fn(async () => true),
        });
        return { ok: true as const, sessionId: id };
      }
    ),
    discardConversationSession: vi.fn(async (_headers: unknown, sessionId: string) => {
      sessions.delete(sessionId);
    }),
  };
  const runner = new RoutineRunner({
    app,
    canvasEnabled: async () => true,
    ownerUser: async () => ({ username: 'admin', role: 'admin' }),
    mayAutomate: () => deployRole.allows('automate'),
    announce: (workspaceId, changed) => announceRoutines(port as never, workspaceId, changed),
    sessionState: (id) => (!restore.done ? 'unknown' : sessions.has(id) ? 'live' : 'gone'),
  });
  port.runRoutine = (workspace: never, routine: never, requestId: string, ignoreGates?: boolean) =>
    runner.runNow(workspace, routine, requestId, ignoreGates);
  registerCanvasRoutes(app, port as never);
  installRouteErrorHandler(app);
  await app.ready();
  const workspace = workspaceForCase(caseName);
  const base = `/api/canvas/${workspace.id}`;
  sessions.set('agent-1', { id: 'agent-1', workingDir: casePath });

  const call = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, agent = false) => {
    const response = await app.inject({
      method,
      url: `${base}${url}`,
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
      ...(agent ? { headers: { 'x-codeman-parent-session': 'agent-1' } } : {}),
    });
    await settleDeliveries();
    await settleReplies();
    return response;
  };
  const create = async (fields: Record<string, unknown> = {}, agent = false) =>
    call(
      'POST',
      '/routines',
      {
        requestId: uuid(),
        title: 'Refine the backlog',
        prompt: 'Sharpen the Backlog items',
        triggers: [{ kind: 'interval', minutes: 30 }],
        ...fields,
      },
      agent
    );
  const routines = async () => (await call('GET', '/routines')).json().data.routines as RoutineRow[];
  const tasks = async () => (await call('GET', '/tasks')).json().data.tasks as TaskRow[];
  const enable = async (key: string) => {
    const row = (await routines()).find((r) => r.key === key)!;
    return call('PATCH', `/routines/${key}`, { expectedRevision: row.revision, enabled: true });
  };
  const tick = async (now: number) => {
    await runner.tick(now);
    await settleDeliveries();
    await settleReplies();
  };
  return {
    app,
    port,
    runner,
    sessions,
    started,
    workspace,
    base,
    casePath,
    call,
    create,
    routines,
    tasks,
    enable,
    tick,
    restore,
  };
}

describe('who may do what', () => {
  it('lets an agent draft and edit a routine, and keeps enable, run and delete for the person', async () => {
    const h = await harness();
    try {
      const drafted = await h.create({}, true);
      expect(drafted.statusCode).toBe(200);
      const row = drafted.json().data.routine as RoutineRow;
      expect(row).toMatchObject({ key: 'R-1', enabled: false, author: { kind: 'agent', sessionId: 'agent-1' } });
      expect((await h.create({ enabled: true }, true)).json().error).toMatch(/^PERSON_ONLY/);
      const edited = await h.call('PATCH', '/routines/R-1', { expectedRevision: 1, title: 'Renamed' }, true);
      expect(edited.json().data.routine).toMatchObject({ title: 'Renamed', revision: 2 });
      const stale = await h.call('PATCH', '/routines/R-1', { expectedRevision: 1, title: 'Again' }, true);
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error).toMatch(/^CONFLICT/);
      for (const [method, url, payload] of [
        ['PATCH', '/routines/R-1', { expectedRevision: 2, enabled: true }],
        ['POST', '/routines/R-1/run', { requestId: uuid() }],
        ['DELETE', '/routines/R-1', undefined],
      ] as const) {
        const refused = await h.call(method, url, payload, true);
        expect(refused.statusCode).toBe(403);
        expect(refused.json().error).toMatch(/^PERSON_ONLY/);
      }
      // The canvas_routine tool reaches the same functions and the same refusals.
      const viaTool = await h.call(
        'POST',
        '/command',
        { tool: 'canvas_routine', arguments: { action: 'run', key: 'R-1', requestId: uuid() } },
        true
      );
      expect(viaTool.json().error).toMatch(/^PERSON_ONLY/);
      const listed = await h.call('POST', '/command', { tool: 'canvas_routine', arguments: { action: 'list' } }, true);
      expect(listed.json().data.routines).toHaveLength(1);
      expect((await h.enable('R-1')).json().data.routine.enabled).toBe(true);
      expect((await h.call('DELETE', '/routines/R-1')).json().data).toEqual({ deleted: 'R-1' });
      expect(h.started).toHaveLength(0);
    } finally {
      await h.app.close();
    }
  });
  it('keeps a routine principal off every canvas route but the task routes, and off other canvases', async () => {
    const h = await harness();
    try {
      const { internalHeaders } = await import('../../src/web/internal-principal.js');
      const headers = internalHeaders(
        {
          user: { username: 'admin', role: 'admin' },
          routine: { routineId: 'r', runId: uuid(), workspaceId: h.workspace.id },
        },
        Date.now()
      );
      expect((await h.app.inject({ method: 'GET', url: `${h.base}/tasks`, headers })).statusCode).toBe(200);
      expect((await h.app.inject({ method: 'GET', url: `${h.base}/routines`, headers })).statusCode).toBe(404);
      const conversation = await h.app.inject({
        method: 'POST',
        url: `${h.base}/conversations`,
        headers,
        payload: { requestId: uuid() },
      });
      expect(conversation.statusCode).toBe(404);
      const other = workspaceForCase(`other-${uuid().slice(0, 8)}`);
      expect((await h.app.inject({ method: 'GET', url: `/api/canvas/${other.id}/tasks`, headers })).statusCode).toBe(
        404
      );
    } finally {
      await h.app.close();
    }
  });
});

describe('a fire is an ordinary background task', () => {
  it('Run now starts one task through the task route, attributed to the routine', async () => {
    const h = await harness();
    try {
      await h.create();
      await h.enable('R-1');
      const requestId = uuid();
      const ran = await h.call('POST', '/routines/R-1/run', { requestId });
      expect(ran.statusCode).toBe(200);
      const fire = ran.json().data.fire;
      if (fire.outcome.kind !== 'started') throw new Error(JSON.stringify(fire.outcome));
      expect(fire).toMatchObject({ trigger: 'manual', runId: requestId, outcome: { kind: 'started' } });
      const [task] = await h.tasks();
      expect(task).toMatchObject({ id: fire.outcome.taskId, requestId, name: 'Routine R-1 · Refine the backlog' });
      const routineId = (await h.routines())[0]!.id;
      expect(task!.startedBy).toEqual({ kind: 'routine', routineId, runId: requestId });
      expect(task!.isolation.kind).toBe('worktree');
      // Stored as an agent start naming the run's own session, which the previous release counts and depth-limits.
      const read = readConversations(h.workspace.id);
      if (!read.ok) throw new Error('unreadable');
      expect(read.conversations[0]!.startedBy).toEqual({
        kind: 'agent',
        sessionId: task!.sessionId,
        routineId,
        runId: requestId,
      });
      // The session was created under the routine principal, with no spawn parent, and given the prompt.
      expect(h.started[0]!.headers['x-codeman-internal']).toEqual(expect.any(String));
      expect(h.started[0]!.request).not.toHaveProperty('parentSessionId');
      const written = (h.sessions.get(task!.sessionId)!.writeViaMux as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(written).toContain('Sharpen the Backlog items');
      expect(written).toContain('Routine R-1');
      // The same request again is the same fire, not a second task.
      expect((await h.call('POST', '/routines/R-1/run', { requestId })).json().data.fire.runId).toBe(requestId);
      expect(await h.tasks()).toHaveLength(1);
    } finally {
      await h.app.close();
    }
  });
  it('shares the agents two places: AGENT_CAP is recorded as a refused fire', async () => {
    const h = await harness();
    try {
      for (let i = 0; i < 2; i++) {
        const agentTask = await h.call(
          'POST',
          '/command',
          { tool: 'canvas_task', arguments: { action: 'start', requestId: uuid(), text: `Agent work ${i}` } },
          true
        );
        expect(agentTask.statusCode).toBe(200);
      }
      await h.create();
      await h.enable('R-1');
      const ran = await h.call('POST', '/routines/R-1/run', { requestId: uuid() });
      expect(ran.json().data.fire.outcome).toMatchObject({ kind: 'refused', code: 'AGENT_CAP' });
      expect(await h.tasks()).toHaveLength(2);
      const row = (await h.routines())[0]!;
      expect(row.fires[0]!.outcome).toMatchObject({ kind: 'refused', code: 'AGENT_CAP' });
    } finally {
      await h.app.close();
    }
  });
  it('a routine run counts against agents too: the third agent start is refused', async () => {
    const h = await harness();
    try {
      await h.create();
      await h.enable('R-1');
      await h.call('POST', '/routines/R-1/run', { requestId: uuid() });
      const agentStart = (text: string) =>
        h.call(
          'POST',
          '/command',
          { tool: 'canvas_task', arguments: { action: 'start', requestId: uuid(), text } },
          true
        );
      expect((await agentStart('one')).statusCode).toBe(200);
      const capped = await agentStart('two');
      expect(capped.statusCode).toBe(409);
      expect(capped.json().error).toMatch(/^AGENT_CAP/);
    } finally {
      await h.app.close();
    }
  });
});

describe('the schedule', () => {
  const MIN = 60_000;
  it('fires a due time once, repeats a cut-off start as the same request, and skips while a run is active', async () => {
    const h = await harness();
    try {
      await h.create();
      const enabledAt = Date.now();
      await h.enable('R-1');
      const routine = (await h.routines())[0]!;
      await h.tick(enabledAt + 10 * MIN);
      expect(await h.tasks()).toHaveLength(0);

      const due = routine.enabledAt! + 30 * MIN;
      await h.tick(due + MIN);
      const [task] = await h.tasks();
      expect(task!.requestId).toBe(runRequestId(routine.id, due));
      await h.tick(due + 2 * MIN);
      expect(await h.tasks()).toHaveLength(1);

      // A crash after the pending record and before the start finished: the next tick asks for the same request.
      const statePath = routineStatePath(h.workspace.id);
      const state = JSON.parse((await import('node:fs')).readFileSync(statePath, 'utf8'));
      state.routines[routine.id].fires.at(-1).outcome = { kind: 'pending' };
      writeFileSync(statePath, JSON.stringify(state));
      await h.tick(due + 3 * MIN);
      expect(await h.tasks()).toHaveLength(1);
      const settled = (await h.routines())[0]!.fires[0]!;
      expect(settled).toMatchObject({ runId: task!.requestId, outcome: { kind: 'started', taskId: task!.id } });

      // The next due time arrives while that run is still active.
      await h.tick(due + 31 * MIN);
      expect(await h.tasks()).toHaveLength(1);
      expect((await h.routines())[0]!.fires[0]!.outcome).toEqual({ kind: 'skipped', reason: 'previous-run-active' });
    } finally {
      await h.app.close();
    }
  });
  it('never fires on a candidate or retired colour, and writes nothing there', async () => {
    const h = await harness();
    try {
      await h.create();
      await h.enable('R-1');
      const routine = (await h.routines())[0]!;
      deployRole.initFromEnv({ CODEMAN_DEPLOY_ROLE: 'candidate' });
      await h.tick(routine.enabledAt! + 31 * MIN);
      expect(existsSync(routineStatePath(h.workspace.id))).toBe(false);
      deployRole.initFromEnv({});
      deployRole.enter('retired');
      await h.tick(routine.enabledAt! + 31 * MIN);
      expect(existsSync(routineStatePath(h.workspace.id))).toBe(false);
      deployRole.initFromEnv({});
      expect(await h.tasks()).toHaveLength(0);
      expect(h.started).toHaveLength(0);
    } finally {
      await h.app.close();
    }
  });
  it('a gate that says no records the fire and wakes no agent; an agent may set gates', async () => {
    const h = await harness();
    try {
      const gates = [
        { kind: 'work-count', status: 'ready-for-work', assignee: 'none', min: 1 },
        { kind: 'work-count', status: 'in-progress', assignee: 'routine', max: 2 },
      ];
      // An agent drafts the gated routine through the tool; gates are not the enable switch.
      const drafted = await h.call(
        'POST',
        '/command',
        {
          tool: 'canvas_routine',
          arguments: {
            action: 'create',
            requestId: uuid(),
            title: 'Pick up',
            prompt: 'Take one Ready for work item',
            triggers: [{ kind: 'interval', minutes: 30 }],
            gates,
          },
        },
        true
      );
      expect(drafted.statusCode).toBe(200);
      const routine = (await h.routines())[0]!;
      expect(routine.gates).toEqual(gates);
      expect(routine.enabled).toBe(false);
      await h.enable('R-1');
      const enabled = (await h.routines())[0]!;
      const due = enabled.enabledAt! + 30 * MIN;

      // Nothing in Ready for work: the due time is consumed and no task, session or prompt is made.
      await h.tick(due + MIN);
      expect(await h.tasks()).toHaveLength(0);
      expect(h.started).toHaveLength(0);
      expect((await h.routines())[0]!.fires[0]).toMatchObject({
        dueAt: due,
        outcome: { kind: 'skipped', reason: 'gate', gate: 0, count: 0 },
      });

      // Run now meets the same gate, unless the person asks to ignore it.
      const held = await h.call('POST', '/routines/R-1/run', { requestId: uuid() });
      expect(held.json().data.fire.outcome).toMatchObject({ kind: 'skipped', reason: 'gate', gate: 0 });
      expect(h.started).toHaveLength(0);
      const agentIgnores = await h.call('POST', '/routines/R-1/run', { requestId: uuid(), ignoreGates: true }, true);
      expect(agentIgnores.statusCode).toBe(403);

      // An unassigned Ready for work item opens the gate at the next due time; the started fire names the run's session.
      expect((await h.call('POST', '/work', { title: 'Ready item', status: 'ready-for-work' })).statusCode).toBe(201);
      await h.tick(due + 31 * MIN);
      const [task] = await h.tasks();
      expect(task).toBeDefined();
      expect((await h.routines())[0]!.fires[0]!.outcome).toEqual({
        kind: 'started',
        taskId: task!.id,
        sessionId: task!.sessionId,
      });
      expect((h.sessions.get(task!.sessionId)!.writeViaMux as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain(
        'assignee "me"'
      );
    } finally {
      await h.app.close();
    }
  });
  it('a claiming work-item trigger takes one item per fire, claims it, and a WIP gate stops the next', async () => {
    const h = await harness();
    try {
      const lane = WORK_STATUSES.find((s) => s !== 'backlog' && s !== CLAIM_STATUS)!;
      for (const title of ['First', 'Second'])
        expect((await h.call('POST', '/work', { title, status: lane })).statusCode).toBe(201);
      await h.create({
        triggers: [{ kind: 'work-item', status: lane, unassignedOnly: true, claim: true }],
        gates: [{ kind: 'work-count', status: CLAIM_STATUS, assignee: 'routine', max: 1 }],
      });
      await h.enable('R-1');
      await h.tick(Date.now());
      const [task] = await h.tasks();
      expect(task).toBeDefined();
      const prompt = (h.sessions.get(task!.sessionId)!.writeViaMux as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(prompt).toContain('W-1');
      expect(prompt).not.toContain('First');
      const items = async () => (await h.call('GET', '/work')).json().data.items as WorkRow[];
      expect((await items())[0]).toMatchObject({
        status: CLAIM_STATUS,
        assignee: { kind: 'session', sessionId: task!.sessionId },
      });
      expect((await h.routines())[0]!.fires[0]).toMatchObject({
        trigger: 'work-item',
        work: { number: 1 },
        outcome: { kind: 'started', claimed: true, sessionId: task!.sessionId },
      });
      expect(h.port.broadcast).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ work: true }));

      // W-2 is due, but one claimed item already fills the gate: recorded once, no agent woken, and it stays due.
      await h.tick(Date.now());
      await h.tick(Date.now());
      expect(await h.tasks()).toHaveLength(1);
      const fires = (await h.routines())[0]!.fires;
      expect(fires).toHaveLength(2);
      expect(fires[0]).toMatchObject({ work: { number: 2 }, outcome: { kind: 'skipped', reason: 'gate', count: 1 } });
    } finally {
      await h.app.close();
    }
  });
  // Invariant I2: EndedRunReleasesItsItem
  // Invariant I4: RepeatedReleaseAsks
  it('a run that ends without a report releases its item, a new run claims it, and the second release asks', async () => {
    const h = await harness();
    try {
      expect((await h.call('POST', '/work', { title: 'Build it', status: 'ready-for-work' })).statusCode).toBe(201);
      await h.create({
        triggers: [{ kind: 'work-item', status: 'ready-for-work', unassignedOnly: true, claim: true }],
      });
      await h.create({
        title: 'Asks',
        triggers: [{ kind: 'work-item', status: 'human-required', unassignedOnly: true, claim: true }],
      });
      await h.enable('R-1');
      await h.enable('R-2');
      const item = async () => (await h.call('GET', '/work')).json().data.items[0] as WorkRow;
      const cancelNewest = async () => {
        const [task] = (await h.tasks()).sort((a, b) => b.createdAt - a.createdAt);
        expect((await h.call('POST', `/tasks/${task!.id}/cancel`, {})).statusCode).toBe(200);
        return task!;
      };

      await h.tick(Date.now());
      const first = (await h.tasks())[0]!;
      expect(await item()).toMatchObject({ status: 'in-progress', assignee: { sessionId: first.sessionId } });

      // While the restore after a boot is unfinished, nothing is released.
      await cancelNewest();
      h.restore.done = false;
      await h.tick(Date.now());
      const held = await item();
      expect(held).toMatchObject({ status: 'in-progress', assignee: { sessionId: first.sessionId } });
      expect(held.history.some((e) => e.text.startsWith('Released: '))).toBe(false);
      expect(await h.tasks()).toHaveLength(1);
      h.restore.done = true;

      await h.tick(Date.now());
      const tasks = await h.tasks();
      expect(tasks).toHaveLength(2);
      const second = tasks.find((t) => t.id !== first.id)!;
      const reclaimed = await item();
      expect(reclaimed).toMatchObject({ status: 'in-progress', assignee: { sessionId: second.sessionId } });
      expect(reclaimed.history.map((e) => e.text)).toContain(`Released: run ${first.requestId} ended without a report`);

      await cancelNewest();
      await h.tick(Date.now());
      await h.tick(Date.now());
      const asked = await item();
      expect(asked).toMatchObject({
        status: 'human-required',
        assignee: null,
        needs: { question: expect.stringMatching(/^W-1 was released twice: runs /) },
      });
      expect(await h.tasks()).toHaveLength(2);
    } finally {
      await h.app.close();
    }
  });

  it('Run now with ignoreGates starts a run the gates would hold', async () => {
    const h = await harness();
    try {
      await h.create({ gates: [{ kind: 'work-count', status: 'ready-for-work', assignee: 'any', min: 1 }] });
      await h.enable('R-1');
      const ran = await h.call('POST', '/routines/R-1/run', { requestId: uuid(), ignoreGates: true });
      expect(ran.json().data.fire.outcome.kind).toBe('started');
      expect(await h.tasks()).toHaveLength(1);
    } finally {
      await h.app.close();
    }
  });
  it('does not fire a disabled routine', async () => {
    const h = await harness();
    try {
      await h.create();
      await h.tick(Date.now() + 24 * 60 * MIN);
      expect(h.started).toHaveLength(0);
    } finally {
      await h.app.close();
    }
  });
});
