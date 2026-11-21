/**
 * The pr-swarm runner (`src/reviews/swarm-runner.ts`, ticket t3 of `intent/2026-11-20-pr-swarm-reviews.md`), over a
 * fake session layer: one run server-wide (D3), joins (I1), an extra round on a moved tip (I2), a session with no
 * GitHub tokens told to stay local (I3), the 30-minute silence, reports from the run's own session only, and rule 6.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { submitReview, type Review } from '../src/reviews/review-model.js';
import type { R3Plan, RunTip } from '../src/reviews/swarm-git.js';
import { activeRun } from '../src/reviews/swarm-model.js';
import {
  createSwarmRunner,
  FINISH_GRACE_MS,
  planR3,
  reportInput,
  ROUND_DELAY_MS,
  SILENCE_LIMIT_MS,
  SLOT_STUCK_MS,
  swarmBrief,
  swarmCommand,
  swarmRoundPrompt,
  type SwarmRunner,
  type SwarmRunnerDeps,
} from '../src/reviews/swarm-runner.js';
import { readSwarm } from '../src/reviews/swarm-store.js';

const sha = (n: number): string => n.toString(16).padStart(40, '0');
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((done) => setImmediate(done));
};
let reviewIds = 0;
const makeReview = (): Review =>
  submitReview(
    undefined,
    { title: 'Swarm me', walkthrough: 'W' },
    { repoRoot: '/r', project: 'r', branch: 'feat/x', base: 'master', headSha: sha(1) },
    { owner: null, sessionId: 'author', sessionName: 'w9' },
    `rev${(++reviewIds).toString().padStart(13, '0')}`,
    1
  );
const result = (round: number, headSha: string, verdict = 'REQUEST_CHANGES') => ({
  head_sha: headSha,
  round,
  verdict,
  findings: [],
  triage: { fix_commits: [], deferred: [] },
});

type Fake = {
  runner: SwarmRunner;
  deps: SwarmRunnerDeps;
  reviews: Map<string, Review>;
  tips: Map<string, RunTip>;
  live: boolean;
  now: number;
  started: { reviewId: string; sessionId: string; internalEnv: Record<string, string>; workingDir: string }[];
  sent: { sessionId: string; text: string }[];
  stopped: string[];
  removed: string[];
  staged: string[];
  r3: R3Plan;
  dead: Set<string>;
  activity: Map<string, number>;
  timers: (() => void)[];
  flush(): Promise<void>;
};

function fake(): Fake {
  let n = 0;
  let runs = 0;
  const f = {
    reviews: new Map<string, Review>(),
    tips: new Map<string, RunTip>(),
    live: true,
    now: 1_000_000,
    started: [],
    sent: [],
    stopped: [],
    removed: [],
    staged: [],
    r3: { required: false },
    dead: new Set<string>(),
    activity: new Map<string, number>(),
    timers: [],
    async flush() {
      await settle();
      while (f.timers.length) {
        f.timers.shift()!();
        await settle();
      }
    },
  } as unknown as Fake;
  f.deps = {
    mayAct: () => f.live,
    restored: () => true,
    now: () => f.now,
    newRunId: () => `run${(++runs).toString().padStart(8, '0')}`,
    reviews: () => [...f.reviews.values()],
    review: (id) => f.reviews.get(id) ?? null,
    refusal: async () => null,
    tip: async (review) => f.tips.get(review.id) ?? null,
    r3Plan: async () => f.r3,
    stageSpec: async (_review, runId) => {
      f.staged.push(runId);
      return `/data/reviews/swarm-spec/swarm-${runId}.md`;
    },
    prepare: async (_review, runId) => ({
      ok: true,
      plan: { workingDir: `/r/.claude/worktrees/swarm-${runId}`, base: sha(100), reviewOnly: null },
    }),
    removeWorktree: async (_review, runId) => {
      f.removed.push(runId);
    },
    startSession: async (review, request) => {
      const sessionId = `session-${++n}`;
      f.started.push({
        reviewId: review.id,
        sessionId,
        internalEnv: request.internalEnv,
        workingDir: request.workingDir,
      });
      f.activity.set(sessionId, f.now);
      return { ok: true, sessionId };
    },
    send: async (sessionId, text) => {
      f.sent.push({ sessionId, text });
      return true;
    },
    session: (sessionId) =>
      f.dead.has(sessionId) || !f.activity.has(sessionId)
        ? { state: 'gone' }
        : { state: 'live', lastActivityAt: f.activity.get(sessionId)! },
    stopSession: async (_review, sessionId) => {
      f.stopped.push(sessionId);
      f.dead.add(sessionId);
    },
    announce: () => undefined,
    log: () => undefined,
    later: (_ms, fn) => {
      f.timers.push(fn);
    },
    skillsDir: '/skills',
    potetoSkill: '/home/u/.claude/skills/poteto-mode/SKILL.md',
    ghConfigDir: '/data/reviews/swarm-gh',
  };
  f.runner = createSwarmRunner(f.deps);
  return f;
}

const addReview = (f: Fake, tip = sha(1), remote: RunTip['remote'] = 'origin'): Review => {
  const review = makeReview();
  f.reviews.set(review.id, review);
  f.tips.set(review.id, { sha: tip, remote });
  return review;
};

describe('swarm runner', () => {
  let f: Fake;
  beforeEach(async () => {
    f = fake();
    await f.runner.recover();
  });

  it('D3: runs one at a time server-wide; the next starts once the first has stopped', async () => {
    const a = addReview(f);
    const b = addReview(f);
    expect((await f.runner.trigger(a.id, 'submit', sha(1))).ok).toBe(true);
    expect((await f.runner.trigger(b.id, 'submit', sha(1))).ok).toBe(true);
    await settle();
    expect(f.started.map((s) => s.reviewId)).toEqual([a.id]);
    const bRun = readSwarm(b.id);
    expect(bRun.ok && activeRun(bRun.file)?.state).toBe('queued');

    const runA = readSwarm(a.id);
    const runId = runA.ok ? activeRun(runA.file)!.id : '';
    const reported = await f.runner.report(runId, f.started[0].sessionId, result(1, sha(1)));
    expect(reported).toMatchObject({ ok: true, state: 'changes' });
    // Nothing else starts while the first run's session and worktree are still going.
    expect(f.started).toHaveLength(1);
    await f.flush();
    expect(f.stopped).toEqual([f.started[0].sessionId]);
    expect(f.removed).toContain(runId);
    expect(f.started.map((s) => s.reviewId)).toEqual([a.id, b.id]);
  });

  it('I1: a trigger while a run is queued or running joins it', async () => {
    const a = addReview(f);
    const first = await f.runner.trigger(a.id, 'submit', sha(1));
    await settle();
    const second = await f.runner.trigger(a.id, 'manual', sha(1));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.joined).toBe(false);
    expect(second.joined).toBe(true);
    expect(second.run.id).toBe(first.run.id);
    expect(f.started).toHaveLength(1);
  });

  it('I2 and I8: a watched tip joins the running run, and with no run going only a change queues one', async () => {
    const a = addReview(f);
    await f.runner.trigger(a.id, 'submit', sha(1));
    await settle();
    const joined = await f.runner.tipMoved(a.id, sha(2), 'own');
    expect(joined).toMatchObject({ ok: true, run: { state: 'running', roundTip: sha(1), pendingTip: sha(2) } });

    const b = addReview(f);
    expect(await f.runner.tipMoved(b.id, sha(2), 'own')).toEqual({ ok: true, run: null });
    expect(readSwarm(b.id)).toMatchObject({ ok: true, file: { runs: [] } });
    expect(await f.runner.tipMoved(b.id, sha(3), 'change')).toMatchObject({
      ok: true,
      run: { state: 'queued', trigger: 'push', tip: sha(3) },
    });

    f.deps.refusal = async () => 'A Docker session cannot be reviewed here';
    expect(await f.runner.tipMoved(addReview(f).id, sha(2), 'change')).toMatchObject({ ok: false, code: 'REFUSED' });
    f.live = false;
    expect(await f.runner.tipMoved(addReview(f).id, sha(2), 'change')).toMatchObject({ ok: false, code: 'NOT_LIVE' });
    expect(f.started).toHaveLength(1);
  });

  it('I2: a report on a tip the branch has moved past asks the same session for another round', async () => {
    const a = addReview(f);
    await f.runner.trigger(a.id, 'submit', sha(1));
    await settle();
    const read = readSwarm(a.id);
    const runId = read.ok ? activeRun(read.file)!.id : '';
    f.tips.set(a.id, { sha: sha(2), remote: 'origin' });
    const reported = await f.runner.report(runId, f.started[0].sessionId, result(1, sha(1)));
    expect(reported).toEqual({ ok: true, state: 'running', round: 2, tip: sha(2) });
    await f.flush();
    const round = f.sent.at(-1)!;
    expect(round.sessionId).toBe(f.started[0].sessionId);
    expect(round.text).toContain(`git checkout --detach ${sha(2)}`);
    expect(round.text).toContain(`codeman agent swarm report ${runId}`);
    expect(f.stopped).toEqual([]);
    expect(f.started).toHaveLength(1);
  });

  it('I3: the session has blank GitHub tokens and an empty gh config, and is told to stay local', async () => {
    const a = addReview(f);
    await f.runner.trigger(a.id, 'submit', sha(1));
    await settle();
    expect(f.started[0].internalEnv).toEqual({
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      GH_CONFIG_DIR: '/data/reviews/swarm-gh',
    });
    const brief = f.sent[0].text;
    expect(brief).toContain('--local');
    expect(brief).toContain(`--head-sha ${sha(1)}`);
    expect(brief).toContain(`--base ${sha(100)}`);
    expect(brief).toContain('--push-ref HEAD:refs/heads/feat/x');
    const forbidden = /gh pr review|gh pr merge|gh api/;
    expect(brief).not.toMatch(forbidden);
    expect(swarmRoundPrompt({ runId: 'run00000001', round: 2, tip: sha(2) })).not.toMatch(forbidden);
    for (const file of ['src/reviews/swarm-runner.ts', 'src/reviews/swarm-git.ts'])
      expect(readFileSync(file, 'utf8')).not.toMatch(forbidden);
  });

  it('builds the command for each kind of run', () => {
    const base = { runId: 'run00000001', title: 'T', branch: 'feat/x', tip: sha(1), skillsDir: '/skills' };
    const plan = (reviewOnly: 'spec' | 'checked-out' | null) => ({ base: sha(100), reviewOnly });
    expect(swarmCommand({ ...base, remote: 'origin', plan: plan(null) })).toBe(
      `/review-triage --local --base ${sha(100)} --head-sha ${sha(1)} --push-ref HEAD:refs/heads/feat/x`
    );
    expect(swarmCommand({ ...base, remote: '.', plan: plan(null) })).toBe(
      `/review-triage --local --base ${sha(100)} --head-sha ${sha(1)} --push-ref HEAD:refs/heads/feat/x --push-remote .`
    );
    expect(swarmCommand({ ...base, remote: 'origin', plan: plan('spec') })).toBe(
      `/pr-swarm --local --base ${sha(100)} --head-sha ${sha(1)} --round 1`
    );
    const spec = swarmBrief({ ...base, remote: 'origin', plan: plan('spec') });
    expect(spec).toContain('spec review');
    expect(spec).not.toContain('/review-triage');
    expect(swarmBrief({ ...base, remote: '.', plan: plan('checked-out') })).toContain('checked out in another folder');
  });

  it('a session silent for 30 minutes ends its run failed, and the session goes', async () => {
    const a = addReview(f);
    await f.runner.trigger(a.id, 'submit', sha(1));
    await settle();
    f.now += SILENCE_LIMIT_MS - 1;
    await f.runner.tick();
    let read = readSwarm(a.id);
    expect(read.ok && activeRun(read.file)?.state).toBe('running');
    f.now += 1;
    await f.runner.tick();
    read = readSwarm(a.id);
    expect(read.ok && read.file.runs[0]).toMatchObject({ state: 'failed', reason: expect.stringContaining('silent') });
    await f.flush();
    expect(f.stopped).toEqual([f.started[0].sessionId]);
  });

  it('a session that ends before it reports fails the run', async () => {
    const a = addReview(f);
    await f.runner.trigger(a.id, 'submit', sha(1));
    await settle();
    f.dead.add(f.started[0].sessionId);
    await f.runner.tick();
    const read = readSwarm(a.id);
    expect(read.ok && read.file.runs[0]).toMatchObject({ state: 'failed', reason: expect.stringContaining('ended') });
  });

  it('refuses a report from any session but the run’s own, and an unknown run', async () => {
    const a = addReview(f);
    await f.runner.trigger(a.id, 'submit', sha(1));
    await settle();
    const read = readSwarm(a.id);
    const runId = read.ok ? activeRun(read.file)!.id : '';
    expect(await f.runner.report(runId, 'someone-else', result(1, sha(1)))).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    });
    expect(await f.runner.report('run99999999', f.started[0].sessionId, result(1, sha(1)))).toMatchObject({
      ok: false,
      code: 'NOT_RUNNING',
    });
    expect(await f.runner.report(runId, f.started[0].sessionId, { verdict: 'nope' })).toMatchObject({
      ok: false,
      code: 'INVALID',
    });
    const after = readSwarm(a.id);
    expect(after.ok && activeRun(after.file)?.state).toBe('running');
  });

  it('a report while the tip cannot be read changes nothing', async () => {
    const a = addReview(f);
    await f.runner.trigger(a.id, 'submit', sha(1));
    await settle();
    const read = readSwarm(a.id);
    const runId = read.ok ? activeRun(read.file)!.id : '';
    f.tips.delete(a.id);
    expect(await f.runner.report(runId, f.started[0].sessionId, result(1, sha(1)))).toMatchObject({
      ok: false,
      code: 'TIP_UNREADABLE',
    });
    const after = readSwarm(a.id);
    expect(after.ok && activeRun(after.file)?.state).toBe('running');
  });

  it('rule 6: a colour that is not live starts nothing, writes nothing and takes no report', async () => {
    const a = addReview(f);
    await f.runner.trigger(a.id, 'submit', sha(1));
    await settle();
    const read = readSwarm(a.id);
    const runId = read.ok ? activeRun(read.file)!.id : '';
    const b = addReview(f);
    f.live = false;
    expect(await f.runner.trigger(b.id, 'submit', sha(1))).toMatchObject({ ok: false, code: 'NOT_LIVE' });
    expect(readSwarm(b.id)).toMatchObject({ ok: true, file: { runs: [] } });
    // The run is really running here, so only the live check can refuse its own session's report.
    expect(await f.runner.report(runId, f.started[0].sessionId, result(1, sha(1)))).toMatchObject({
      ok: false,
      code: 'NOT_LIVE',
    });
    // Nor does a colour that is not live judge a silent session.
    f.now += SILENCE_LIMIT_MS * 2;
    await f.runner.tick();
    const after = readSwarm(a.id);
    expect(after.ok && activeRun(after.file)?.state).toBe('running');
    expect(f.started).toHaveLength(1);
    expect(f.stopped).toEqual([]);
  });

  it('a report that arrives twice is answered once and counted once', async () => {
    const a = addReview(f);
    await f.runner.trigger(a.id, 'submit', sha(1));
    await settle();
    const read = readSwarm(a.id);
    const runId = read.ok ? activeRun(read.file)!.id : '';
    f.tips.set(a.id, { sha: sha(2), remote: 'origin' });
    const triage = { mode: 'local', pr: null, pr_swarm_result: result(1, sha(1)), commits: [], dispositions: [] };
    const first = await f.runner.report(runId, f.started[0].sessionId, triage);
    expect(first).toMatchObject({ ok: true, state: 'running', round: 2 });
    const again = await f.runner.report(runId, f.started[0].sessionId, triage);
    expect(again).toMatchObject({ ok: true, state: 'running', round: 2, duplicate: true });
  });

  it('a report for a review git may no longer run on is refused before the tip is read', async () => {
    const a = addReview(f);
    await f.runner.trigger(a.id, 'submit', sha(1));
    await settle();
    const read = readSwarm(a.id);
    const runId = read.ok ? activeRun(read.file)!.id : '';
    let tipReads = 0;
    f.deps.tip = async () => {
      tipReads++;
      return { sha: sha(1), remote: 'origin' };
    };
    f.deps.refusal = async () => 'A repository inside a Docker case cannot be reviewed here';
    expect(await f.runner.report(runId, f.started[0].sessionId, result(1, sha(1)))).toMatchObject({
      ok: false,
      code: 'REFUSED',
    });
    expect(await f.runner.tipOf(a)).toBeNull();
    expect(tipReads).toBe(0);
  });

  it('a start that hangs is given up, and the queue moves on', async () => {
    const hang = fake();
    let calls = 0;
    const real = hang.deps.startSession;
    hang.deps.startSession = async (review, request) => {
      if (++calls === 1) return new Promise(() => undefined);
      return real(review, request);
    };
    const runner = createSwarmRunner(hang.deps);
    await runner.recover();
    const a = addReview(hang);
    const b = addReview(hang);
    await runner.trigger(a.id, 'submit', sha(1));
    await runner.trigger(b.id, 'submit', sha(1));
    await settle();
    expect(hang.started).toEqual([]);
    hang.now += SLOT_STUCK_MS;
    await runner.tick();
    await settle();
    const first = readSwarm(a.id);
    expect(first.ok && first.file.runs[0]).toMatchObject({ state: 'failed' });
    expect(hang.started.map((s) => s.reviewId)).toEqual([b.id]);
  });

  it('does not start before recovery, and recovery starts what was queued', async () => {
    const g = fake();
    const a = addReview(g);
    expect((await g.runner.trigger(a.id, 'push', sha(1))).ok).toBe(true);
    await settle();
    expect(g.started).toEqual([]);
    await g.runner.tick();
    await settle();
    expect(g.started.map((s) => s.reviewId)).toEqual([a.id]);
  });

  it('recovery adopts a running run whose session is alive and fails one whose session is gone', async () => {
    const a = addReview(f);
    await f.runner.trigger(a.id, 'submit', sha(1));
    await settle();
    const sessionId = f.started[0].sessionId;

    // A new process over the same files: the session still runs.
    const g = fake();
    g.reviews = f.reviews;
    g.activity.set(sessionId, g.now);
    g.deps.reviews = () => [...f.reviews.values()];
    g.deps.review = (id) => f.reviews.get(id) ?? null;
    g.deps.tip = async (review) => f.tips.get(review.id) ?? null;
    const adopted = createSwarmRunner(g.deps);
    await adopted.recover();
    const read = readSwarm(a.id);
    const runId = read.ok ? activeRun(read.file)!.id : '';
    expect(await adopted.report(runId, sessionId, result(1, sha(1)))).toMatchObject({ ok: true, state: 'changes' });

    // And again with the session gone.
    const first = fake();
    await first.runner.recover();
    const b = addReview(first);
    await first.runner.trigger(b.id, 'submit', sha(1));
    await settle();
    expect(first.started).toHaveLength(1);
    const h = fake();
    h.deps.reviews = () => [...first.reviews.values()];
    h.deps.review = (id) => first.reviews.get(id) ?? null;
    await createSwarmRunner(h.deps).recover();
    expect(h.stopped).toEqual([first.started[0].sessionId]);
    const gone = readSwarm(b.id);
    await h.flush();
    expect(h.removed).toContain(gone.ok ? gone.file.runs[0].id : 'missing');
    const failed = readSwarm(b.id);
    expect(failed.ok && failed.file.runs[0]).toMatchObject({ state: 'failed' });
  });

  it('a brief that never reaches the pane fails the run', async () => {
    f.deps.send = async () => false;
    const g = createSwarmRunner(f.deps);
    await g.recover();
    const a = addReview(f);
    await g.trigger(a.id, 'submit', sha(1));
    await settle();
    const read = readSwarm(a.id);
    expect(read.ok && read.file.runs[0]).toMatchObject({ state: 'failed', reason: expect.stringContaining('brief') });
  });

  describe('I9: R-3 on spec-attributed work', () => {
    const SPEC = { path: 'intent/2026-11-20-x.md', mergedSha: sha(50), text: '# X\n' };
    const runIdOf = (reviewId: string): string => {
      const read = readSwarm(reviewId);
      return read.ok ? (activeRun(read.file)?.id ?? read.file.runs[0]!.id) : '';
    };
    const approve = (tip = sha(1), extra: object = {}) => ({ ...result(1, tip, 'APPROVE'), ...extra });

    it('passes --spec and --poteto-skill only to an attributed run, and its missing R-3 result reads unavailable', async () => {
      f.r3 = { required: true, spec: SPEC };
      const a = addReview(f);
      await f.runner.trigger(a.id, 'submit', sha(1));
      await settle();
      const runId = runIdOf(a.id);
      expect(f.staged).toEqual([runId]);
      expect(f.sent[0].text).toContain(
        `--spec /data/reviews/swarm-spec/swarm-${runId}.md --poteto-skill /home/u/.claude/skills/poteto-mode/SKILL.md`
      );
      expect(await f.runner.report(runId, f.started[0].sessionId, approve())).toMatchObject({ state: 'passed' });
      const read = readSwarm(a.id);
      expect(read.ok && read.file.runs[0]).toMatchObject({
        r3: { verdict: 'unavailable', reason: 'The run reported no R-3 result' },
      });
    });

    it('records the R-3 result an attributed run reports', async () => {
      f.r3 = { required: true, spec: SPEC };
      const a = addReview(f);
      await f.runner.trigger(a.id, 'submit', sha(1));
      await settle();
      const r3 = { verdict: 'pass', findings: [], deviations: ['Kept the old route.'], tip: sha(1) };
      await f.runner.report(runIdOf(a.id), f.started[0].sessionId, approve(sha(1), { r3 }));
      const read = readSwarm(a.id);
      expect(read.ok && read.file.runs[0]).toMatchObject({ state: 'passed', r3 });
    });

    it('an unattributed run gets no flags, and an R-3 result it reports anyway is not recorded', async () => {
      const a = addReview(f);
      await f.runner.trigger(a.id, 'submit', sha(1));
      await settle();
      expect(f.sent[0].text).not.toContain('--spec');
      expect(f.sent[0].text).not.toContain('--poteto-skill');
      expect(f.staged).toEqual([]);
      const r3 = { verdict: 'pass', findings: [], deviations: [], tip: sha(1) };
      await f.runner.report(runIdOf(a.id), f.started[0].sessionId, approve(sha(1), { r3 }));
      const read = readSwarm(a.id);
      expect(read.ok && read.file.runs[0]).not.toHaveProperty('r3');
    });

    it('a spec it cannot give R-3 means no flags and an unavailable result that says why', async () => {
      f.r3 = { required: true, spec: null, missing: 'The spec intent/x.md could not be read at 000000000000' };
      const a = addReview(f);
      await f.runner.trigger(a.id, 'submit', sha(1));
      await settle();
      expect(f.sent[0].text).not.toContain('--spec');
      await f.runner.report(runIdOf(a.id), f.started[0].sessionId, approve());
      const read = readSwarm(a.id);
      expect(read.ok && read.file.runs[0]).toMatchObject({
        r3: { verdict: 'unavailable', reason: 'The spec intent/x.md could not be read at 000000000000' },
      });
    });

    it('a spec copy that cannot be written, or a plan that cannot be read, fails closed', async () => {
      f.r3 = { required: true, spec: SPEC };
      f.deps.stageSpec = async () => null;
      const a = addReview(f);
      await f.runner.trigger(a.id, 'submit', sha(1));
      await settle();
      expect(f.sent[0].text).not.toContain('--spec');
      await f.runner.report(runIdOf(a.id), f.started[0].sessionId, approve());
      await f.flush();
      let read = readSwarm(a.id);
      expect(read.ok && read.file.runs[0]).toMatchObject({
        r3: { verdict: 'unavailable', reason: "The run's copy of the spec could not be written" },
      });

      f.deps.r3Plan = async () => {
        throw new Error('boom');
      };
      const b = addReview(f);
      await f.runner.trigger(b.id, 'submit', sha(1));
      await settle();
      await f.runner.report(runIdOf(b.id), f.started[1].sessionId, approve());
      read = readSwarm(b.id);
      expect(read.ok && read.file.runs[0]).toMatchObject({
        r3: { verdict: 'unavailable', reason: expect.stringContaining('could not be read') },
      });
    });

    it('recovery reads the plan again for the run it adopts', async () => {
      f.r3 = { required: true, spec: SPEC };
      const a = addReview(f);
      await f.runner.trigger(a.id, 'submit', sha(1));
      await settle();
      const sessionId = f.started[0].sessionId;
      const g = fake();
      g.r3 = { required: true, spec: SPEC };
      g.activity.set(sessionId, g.now);
      g.deps.reviews = () => [...f.reviews.values()];
      g.deps.review = (id) => f.reviews.get(id) ?? null;
      g.deps.tip = async (review) => f.tips.get(review.id) ?? null;
      const adopted = createSwarmRunner(g.deps);
      await adopted.recover();
      await adopted.report(runIdOf(a.id), sessionId, approve());
      const read = readSwarm(a.id);
      expect(read.ok && read.file.runs[0]).toMatchObject({ r3: { verdict: 'unavailable' } });
    });

    it('planR3: a spec review never needs R-3, and a review-only run of attributed work cannot give it', () => {
      const attributed: R3Plan = { required: true, spec: SPEC };
      expect(planR3({ required: false }, null)).toEqual({ need: { required: false } });
      expect(planR3(attributed, 'spec')).toEqual({ need: { required: false } });
      expect(planR3(attributed, null)).toEqual({ need: { required: true }, spec: SPEC });
      expect(planR3(attributed, 'checked-out')).toEqual({
        need: { required: true, unavailable: expect.stringContaining('R-3 did not run') },
      });
      expect(planR3({ required: true, spec: null, missing: 'why' }, null)).toEqual({
        need: { required: true, unavailable: 'why' },
      });
    });

    it('builds the command with both flags, after the push flags', () => {
      const base = { runId: 'run00000001', title: 'T', branch: 'feat/x', tip: sha(1), skillsDir: '/skills' };
      const r3 = { spec: '/d/spec.md', potetoSkill: '/p/SKILL.md' };
      expect(swarmCommand({ ...base, remote: '.', plan: { base: sha(100), reviewOnly: null }, r3 })).toBe(
        `/review-triage --local --base ${sha(100)} --head-sha ${sha(1)} --push-ref HEAD:refs/heads/feat/x --push-remote . --spec /d/spec.md --poteto-skill /p/SKILL.md`
      );
      expect(swarmCommand({ ...base, remote: 'origin', plan: { base: sha(100), reviewOnly: 'spec' }, r3 })).toBe(
        `/pr-swarm --local --base ${sha(100)} --head-sha ${sha(1)} --round 1`
      );
    });
  });

  it('exports its grace periods', () => {
    expect(FINISH_GRACE_MS).toBeGreaterThan(0);
    expect(ROUND_DELAY_MS).toBeGreaterThan(0);
  });
});

describe('reportInput', () => {
  it('passes a pr-swarm result through', () => {
    const r = result(1, sha(1));
    expect(reportInput(r, 3)).toBe(r);
  });

  it('turns a /review-triage --local result into the pr-swarm contract', () => {
    const out = reportInput(
      {
        mode: 'local',
        pr: null,
        verdict: 'REQUEST_CHANGES',
        pr_swarm_result: { ...result(4, sha(1)), triage: { fix_commits: ['x'], deferred: [] } },
        commits: [
          { sha: sha(7), pushed: true },
          { sha: 'abc1234', pushed: true },
          { sha: sha(8), pushed: false },
        ],
        dispositions: [
          { id: 'f1', bucket: 'fixed', location: 'a.ts:1', reason: 'done' },
          { id: 'f2', bucket: 'deferred', location: 'b.ts:2', reason: 'needs a design call' },
          { id: 'f3', bucket: 'deferred' },
        ],
      },
      2
    ) as Record<string, unknown>;
    expect(out.round).toBe(2);
    expect(out.head_sha).toBe(sha(1));
    expect(out.triage).toEqual({
      fix_commits: [sha(7)],
      deferred: [
        { location: 'b.ts:2', reason: 'needs a design call' },
        { location: 'f3', reason: 'deferred' },
      ],
    });
  });
});
