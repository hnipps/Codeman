/**
 * The pr-swarm routes on a review (`src/web/routes/review-routes.ts`): who may start a run, the 409 that carries the
 * run a start joined, the report route's session check, and rule 6. The runner itself is a stub here; its own rules
 * are in `swarm-runner.test.ts`.
 */
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../src/config/instance.js';
import { deployRole } from '../src/deploy-role.js';
import { submitReview, type Review } from '../src/reviews/review-model.js';
import { writeReview } from '../src/reviews/review-store.js';
import { emptySwarmFile, type SwarmRun } from '../src/reviews/swarm-model.js';
import type { SwarmRunner } from '../src/reviews/swarm-runner.js';
import { registerReviewPageRoutes } from '../src/web/routes/review-routes.js';
import { createRouteTestHarness, type RouteTestHarness } from './routes/_route-test-utils.js';

const SHA = 'a'.repeat(40);
const RUN_ID = 'run00000001';
const review = (): Review =>
  submitReview(
    undefined,
    { title: 'T', walkthrough: 'W' },
    { repoRoot: '/repo', project: 'repo', branch: 'feat/x', base: 'main', headSha: SHA },
    { owner: null, sessionId: 'test-session-1', sessionName: 'w4' },
    'aaaaaaaa',
    1000
  );
const queued: SwarmRun = { id: RUN_ID, trigger: 'manual', requestedAt: 1, state: 'queued', tip: SHA };

describe('pr-swarm review routes', () => {
  let harness: RouteTestHarness;
  let runner: { [K in keyof SwarmRunner]: ReturnType<typeof vi.fn> };
  const PERSON = {};
  const AGENT = { 'x-codeman-parent-session': 'test-session-1' };

  beforeEach(async () => {
    runner = {
      trigger: vi.fn(async () => ({ ok: true, joined: false, run: queued })),
      report: vi.fn(async () => ({ ok: true, state: 'changes' })),
      view: vi.fn(() => ({ ok: true, file: emptySwarmFile('aaaaaaaa') })),
      tipOf: vi.fn(async () => ({ sha: SHA, remote: 'origin' })),
      recover: vi.fn(async () => undefined),
      tick: vi.fn(async () => undefined),
    };
    harness = await createRouteTestHarness((app, ctx) =>
      registerReviewPageRoutes(app, ctx, {
        dockerWorkspaces: async () => [],
        swarm: runner as unknown as SwarmRunner,
      })
    );
    writeReview(review());
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.app.close();
    rmSync(dataPath('reviews'), { recursive: true, force: true });
  });

  const start = (headers: Record<string, string> = PERSON) =>
    harness.app.inject({ method: 'POST', url: '/api/reviews/aaaaaaaa/swarm', headers, payload: {} });
  const report = (headers: Record<string, string>, runId = RUN_ID, payload: unknown = { report: { verdict: 'x' } }) =>
    harness.app.inject({ method: 'POST', url: `/api/reviews/swarm-runs/${runId}/report`, headers, payload });

  it('GET answers the review’s runs', async () => {
    const res = await harness.app.inject({ url: '/api/reviews/aaaaaaaa/swarm' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ swarm: emptySwarmFile('aaaaaaaa'), live: true });
    expect((await harness.app.inject({ url: '/api/reviews/bbbbbbbb/swarm' })).statusCode).toBe(404);
  });

  it('a person starts a run at the branch tip; an agent may not', async () => {
    const res = await start();
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ run: queued });
    expect(runner.trigger).toHaveBeenCalledWith('aaaaaaaa', 'manual', SHA);
    expect((await start(AGENT)).statusCode).toBe(403);
    expect(runner.trigger).toHaveBeenCalledTimes(1);
  });

  it('a start that joins a run answers 409 RUNNING with that run', async () => {
    runner.trigger.mockResolvedValueOnce({ ok: true, joined: true, run: queued });
    const res = await start();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ success: false, errorCode: 'CONFLICT', data: { run: queued } });
    expect(res.json().error).toMatch(/^RUNNING:/);
  });

  it('a start refuses an unreadable tip and a body that names anything', async () => {
    runner.tipOf.mockResolvedValueOnce(null);
    expect((await start()).json().error).toMatch(/^TIP_UNREADABLE:/);
    const named = await harness.app.inject({
      method: 'POST',
      url: '/api/reviews/aaaaaaaa/swarm',
      payload: { tip: SHA },
    });
    expect(named.statusCode).toBe(400);
  });

  it('a start for a review inside a Docker case is refused before git runs', async () => {
    await harness.app.close();
    harness = await createRouteTestHarness((app, ctx) =>
      registerReviewPageRoutes(app, ctx, {
        dockerWorkspaces: async () => ['/repo'],
        swarm: runner as unknown as SwarmRunner,
      })
    );
    const res = await start();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/^REFUSED:/);
    expect(runner.tipOf).not.toHaveBeenCalled();
    expect(runner.trigger).not.toHaveBeenCalled();
  });

  it('rule 6: a colour that is not live starts nothing', async () => {
    vi.spyOn(deployRole, 'allows').mockReturnValue(false);
    const res = await start();
    expect(res.statusCode).toBe(409);
    expect(runner.trigger).not.toHaveBeenCalled();
  });

  it('resend is not built yet', async () => {
    const res = await harness.app.inject({ method: 'POST', url: '/api/reviews/aaaaaaaa/swarm/resend', payload: {} });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toMatch(/^NOT_BUILT:/);
  });

  it('a report needs the run’s session header and passes the caller’s own session id', async () => {
    expect((await report({})).statusCode).toBe(403);
    expect((await report({ 'x-codeman-parent-session': 'nobody-here' })).statusCode).toBe(403);
    expect(runner.report).not.toHaveBeenCalled();
    const ok = await report(AGENT);
    expect(ok.statusCode).toBe(200);
    expect(runner.report).toHaveBeenCalledWith(RUN_ID, 'test-session-1', { verdict: 'x' });
  });

  it('a report refuses a bad run id and a body that is not one object, and maps the runner’s refusals', async () => {
    expect((await report(AGENT, 'BAD-ID')).statusCode).toBe(400);
    expect((await report(AGENT, RUN_ID, { report: [1] })).statusCode).toBe(400);
    runner.report.mockResolvedValueOnce({ ok: false, code: 'FORBIDDEN', message: 'no' });
    expect((await report(AGENT)).statusCode).toBe(403);
    runner.report.mockResolvedValueOnce({ ok: false, code: 'NOT_LIVE', message: 'no' });
    const notLive = await report(AGENT);
    expect(notLive.statusCode).toBe(409);
    expect(notLive.json().error).toMatch(/^NOT_LIVE:/);
    runner.report.mockResolvedValueOnce({ ok: false, code: 'INVALID', message: 'no' });
    expect((await report(AGENT)).statusCode).toBe(400);
    runner.report.mockResolvedValueOnce({ ok: false, code: 'NOT_RUNNING', message: 'no' });
    expect((await report(AGENT)).statusCode).toBe(404);
  });
});
