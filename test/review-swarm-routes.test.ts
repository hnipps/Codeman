/**
 * The pr-swarm routes on a review (`src/web/routes/review-routes.ts`): who may start a run, the 409 that carries the
 * run a start joined, the report route's session check, rule 6, and the run a submit or resubmit triggers. The runner itself is a stub here; its own rules
 * are in `swarm-runner.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../src/config/instance.js';
import { deployRole } from '../src/deploy-role.js';
import { submitReview, type Review } from '../src/reviews/review-model.js';
import { writeReview } from '../src/reviews/review-store.js';
import { writeSwarm } from '../src/reviews/swarm-store.js';
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
const flagged = (send: 'sent' | 'failed'): SwarmRun => ({
  id: RUN_ID,
  trigger: 'manual',
  requestedAt: 1,
  sessionId: 'swarm-session',
  startedAt: 2,
  endedAt: 3,
  rounds: 1,
  reviewedTip: SHA,
  result: { verdict: 'REQUEST_CHANGES', findings: [], degradations: [] },
  state: 'changes',
  send: send === 'sent' ? { state: 'sent', at: 4 } : { state: 'failed', at: 4, reason: 'The session was not ready' },
});

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
      resend: vi.fn(async () => ({ ok: true, run: flagged('sent') })),
      clear: vi.fn(() => undefined),
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
    expect(res.json().data).toEqual({ swarm: emptySwarmFile('aaaaaaaa'), chip: null, live: true, refusal: null });
    expect((await harness.app.inject({ url: '/api/reviews/bbbbbbbb/swarm' })).statusCode).toBe(404);
  });

  it('GET carries the chip the page shows for the runs', async () => {
    runner.view.mockReturnValue({ ok: true, file: { ...emptySwarmFile('aaaaaaaa'), runs: [queued] } });
    const res = await harness.app.inject({ url: '/api/reviews/aaaaaaaa/swarm' });
    expect(res.json().data.chip).toBe('queued');
  });

  it('each queue row carries its chip from the run file, and a review with no runs carries none', async () => {
    const queue = async () => (await harness.app.inject({ url: '/api/reviews' })).json().data;
    expect((await queue()).waiting[0]).not.toHaveProperty('swarm');
    writeSwarm({ ...emptySwarmFile('aaaaaaaa'), runs: [queued] });
    expect((await queue()).waiting[0]).toMatchObject({ id: 'aaaaaaaa', swarm: 'queued' });
    writeSwarm({ ...emptySwarmFile('aaaaaaaa'), escalated: { kind: 'streak', at: 1, runIds: [RUN_ID] } });
    expect((await queue()).waiting[0]).toMatchObject({ swarm: 'escalated' });
    // A run file that does not parse shows no chip and never fails the queue.
    writeFileSync(dataPath('reviews', 'aaaaaaaa.swarm.json'), '{');
    const res = await harness.app.inject({ url: '/api/reviews' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.waiting[0]).not.toHaveProperty('swarm');
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

  const resend = (headers: Record<string, string> = PERSON) =>
    harness.app.inject({ method: 'POST', url: '/api/reviews/aaaaaaaa/swarm/resend', headers, payload: {} });

  it('Send again: a person sends the newest run again; an agent may not', async () => {
    expect((await resend(AGENT)).statusCode).toBe(403);
    expect(runner.resend).not.toHaveBeenCalled();
    const ok = await resend();
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.run).toMatchObject({ id: RUN_ID, send: { state: 'sent' } });
    expect(runner.resend).toHaveBeenCalledWith('aaaaaaaa');
  });

  it('Send again answers 409 with the reason when there is nothing to send or the delivery failed again', async () => {
    runner.resend.mockResolvedValueOnce({ ok: false, code: 'ESCALATED', message: 'escalated' });
    const escalated = await resend();
    expect(escalated.statusCode).toBe(409);
    expect(escalated.json().error).toMatch(/^ESCALATED:/);
    runner.resend.mockResolvedValueOnce({ ok: true, run: flagged('failed') });
    const failed = await resend();
    expect(failed.statusCode).toBe(409);
    expect(failed.json().error).toBe('NOT_SENT: The session was not ready');
  });

  it('I6: closing the review clears its escalation', async () => {
    const res = await harness.app.inject({ method: 'POST', url: '/api/reviews/aaaaaaaa/close', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(runner.clear).toHaveBeenCalledWith('aaaaaaaa');
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

describe('a submit triggers a pr-swarm run', () => {
  let repo: string;
  let harness: RouteTestHarness;
  let trigger: ReturnType<typeof vi.fn>;
  const AGENT = { 'x-codeman-parent-session': 'test-session-1' };

  beforeEach(async () => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'review-swarm-submit-')));
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args],
        {
          cwd: repo,
          stdio: 'ignore',
        }
      );
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'feat/x');
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    git('commit', '-q', '-am', 'work');
    trigger = vi.fn(async () => ({ ok: true, joined: false, run: queued }));
    harness = await createRouteTestHarness((app, ctx) =>
      registerReviewPageRoutes(app, ctx, {
        dockerWorkspaces: async () => [],
        swarm: { trigger } as unknown as SwarmRunner,
      })
    );
    harness.ctx.sessions.get('test-session-1')!.workingDir = repo;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.app.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(dataPath('reviews'), { recursive: true, force: true });
  });

  const submit = (walkthrough = 'W') =>
    harness.app.inject({
      method: 'POST',
      url: '/api/reviews',
      headers: AGENT,
      payload: { title: 'Work', walkthrough },
    });
  const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

  it('a submit and a resubmit each trigger once, for the review at its head', async () => {
    const first = await submit();
    expect(first.statusCode).toBe(201);
    const id = first.json().data.id as string;
    await vi.waitFor(() => expect(trigger).toHaveBeenCalledTimes(1));
    expect(trigger).toHaveBeenCalledWith(id, 'submit', head());
    expect((await submit('Updated')).statusCode).toBe(200);
    await vi.waitFor(() => expect(trigger).toHaveBeenCalledTimes(2));
    expect(trigger).toHaveBeenLastCalledWith(id, 'submit', head());
  });

  it('a trigger that fails or throws never fails the submit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    trigger.mockResolvedValueOnce({ ok: false, code: 'FILE', message: 'The run file is unreadable' });
    expect((await submit()).statusCode).toBe(201);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('FILE')));
    trigger.mockRejectedValueOnce(new Error('boom'));
    expect((await submit('Again')).statusCode).toBe(200);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom')));
    expect(trigger).toHaveBeenCalledTimes(2);
  });

  it('a submit that is refused triggers nothing', async () => {
    vi.spyOn(deployRole, 'allows').mockReturnValue(false);
    expect((await submit()).statusCode).toBe(409);
    await new Promise((done) => setImmediate(done));
    expect(trigger).not.toHaveBeenCalled();
  });
});
