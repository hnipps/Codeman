/**
 * pr-swarm runs on reviews (`intent/2026-11-20-pr-swarm-reviews.md`): the pure run model (`src/reviews/swarm-model.ts`)
 * against invariants I1, I2, I4, I5, I6, I8 and I9, and the run store (`swarm-store.ts`) against I7.
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { dataPath } from '../src/config/instance.js';
import { deployRole } from '../src/deploy-role.js';
import {
  addNote,
  requestChangesPrompt,
  ReviewFileSchema,
  storedSource,
  submitReview,
  type Review,
} from '../src/reviews/review-model.js';
import { listReviews, readReview, writeReview } from '../src/reviews/review-store.js';
import {
  activeRun,
  applySwarmEvent,
  attributedSpec,
  classifyTipChange,
  decideAutoApprove,
  emptySwarmFile,
  isSpecReview,
  MAX_ROUNDS,
  MAX_RUNS_KEPT,
  parseSwarmReport,
  SwarmFileSchema,
  swarmChip,
  swarmVerdictPrompt,
  SWARM_TRAILER,
  type SwarmAction,
  type SwarmEvent,
  type SwarmFile,
  type SwarmReport,
  type SwarmRun,
  type SwarmVerdict,
} from '../src/reviews/swarm-model.js';
import { changeSwarm, readSwarm } from '../src/reviews/swarm-store.js';
import frozenReviewFile from './fixtures/review-file-schema.v1.json' with { type: 'json' };

const sha = (n: number): string => n.toString(16).padStart(40, '0');
const REVIEW_ID = 'aaaaaaaaaaaaaaaa';
const NOW = 1_000_000;

const report = (round: number, headSha: string, verdict: SwarmVerdict, extra: object = {}): SwarmReport => {
  const parsed = parseSwarmReport({
    head_sha: headSha,
    round,
    verdict,
    findings: [{ file: 'src/a.ts', line: 3, severity: 'high', reviewer: 'xp', body: 'Fix the guard.' }],
    triage: { fix_commits: [], deferred: [{ location: 'src/b.ts:9', reason: 'Needs a design call.' }] },
    ...extra,
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.report;
};

type Driver = { file: SwarmFile; actions: SwarmAction[]; step(e: SwarmEvent): SwarmAction[] };
const driver = (file: SwarmFile = emptySwarmFile(REVIEW_ID)): Driver => {
  let t = NOW;
  const d: Driver = {
    file,
    actions: [],
    step(e) {
      const out = applySwarmEvent(d.file, e, ++t);
      d.file = out.file;
      d.actions.push(...out.actions);
      expect(SwarmFileSchema.safeParse(d.file).success).toBe(true);
      return out.actions;
    },
  };
  return d;
};
let ids = 0;
const newId = (): string => `run${(++ids).toString().padStart(8, '0')}`;

/** Queues, starts and reports one run that the branch does not move under. Returns the report step's actions. */
const runOnce = (d: Driver, verdict: SwarmVerdict, tip = sha(1), r3?: object): SwarmAction[] => {
  d.step({ type: 'trigger', trigger: 'submit', tip, runId: newId() });
  const run = activeRun(d.file)!;
  d.step({ type: 'started', runId: run.id, sessionId: 's1', tip });
  return d.step({
    type: 'report',
    runId: run.id,
    report: report(1, tip, verdict, r3 ? { r3 } : {}),
    branchTip: tip,
    r3Required: r3 !== undefined,
    newRunId: newId(),
  });
};
const kinds = (actions: SwarmAction[]): string[] => actions.map((a) => a.kind);
/** A seeded `rand(n)` in [0, n), so a failing walk repeats. */
const mulberry32 =
  (seed: number) =>
  (n: number): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 2 ** 32) * n);
  };

describe('I1 OneRunPerReview', () => {
  it('never holds more than one queued or running run, across random interleavings', () => {
    const rand = mulberry32(42);
    const verdicts: SwarmVerdict[] = ['APPROVE', 'APPROVE_WITH_NITS', 'REQUEST_CHANGES', 'BLOCKED'];
    const r3s = (judged: string) => [
      undefined,
      { verdict: 'pass', tip: judged },
      { verdict: 'changes', findings: ['x'], tip: judged },
      { verdict: 'escalate', trigger: 'outcome-changed', tip: judged },
    ];
    const actionsSeen = new Set<string>();
    const statesSeen = new Set<string>();
    for (let trial = 0; trial < 400; trial++) {
      const d = driver();
      let tip = 1;
      for (let i = 0; i < 60; i++) {
        const active = activeRun(d.file);
        const pick = rand(7);
        if (pick === 0) {
          const trigger = (['submit', 'push', 'manual'] as const)[rand(3)]!;
          d.step({ type: 'trigger', trigger, tip: sha(rand(2) ? ++tip : tip), runId: newId() });
          if (active) expect(activeRun(d.file)?.id).toBe(active.id);
        } else if (pick === 1) {
          d.step({ type: 'tip', tip: sha(++tip), change: rand(2) ? 'own' : 'change', newRunId: newId() });
        } else if (pick === 2 && active) {
          d.step({ type: 'started', runId: active.id, sessionId: 's', tip: sha(tip) });
        } else if (pick === 3 && active?.state === 'running') {
          const head = rand(4) ? active.roundTip : sha(tip);
          const r3 = r3s(head)[rand(4)];
          d.step({
            type: 'report',
            runId: active.id,
            report: report(active.round, head, verdicts[rand(4)]!, r3 ? { r3 } : {}),
            branchTip: rand(2) ? head : sha(++tip),
            r3Required: rand(2) === 1,
            newRunId: newId(),
          });
        } else if (pick === 4 && active && rand(4) === 0) {
          // Rarer than a report, or a run almost never survives the five moved rounds that end it incomplete.
          d.step({ type: 'failed', runId: active.id, reason: 'session died' });
        } else if (pick === 5) {
          d.step({ type: 'clear' });
        } else if (pick === 6) {
          const run = d.file.runs[rand(Math.max(1, d.file.runs.length))];
          if (run) d.step({ type: 'sent', runId: run.id, ok: true });
        }
        const live = d.file.runs.filter((r) => r.state === 'queued' || r.state === 'running');
        expect(live.length).toBeLessThanOrEqual(1);
        for (const r of d.file.runs) statesSeen.add(r.state);
      }
      for (const k of kinds(d.actions)) actionsSeen.add(k);
    }
    expect([...actionsSeen]).toEqual(expect.arrayContaining(['consider-approve', 'escalate', 'round']));
    expect([...statesSeen]).toEqual(expect.arrayContaining(['blocked', 'changes', 'failed', 'incomplete', 'passed']));
  });

  it('a manual request during a run joins it instead of creating one', () => {
    const d = driver();
    d.step({ type: 'trigger', trigger: 'submit', tip: sha(1), runId: 'first0001' });
    const actions = d.step({ type: 'trigger', trigger: 'manual', tip: sha(1), runId: 'second001' });
    expect(actions).toEqual([]);
    expect(d.file.runs.map((r) => r.id)).toEqual(['first0001']);
  });

  it('a manual request during a running round joins it, records the new tip, and clears an escalation', () => {
    const d = driver();
    runOnce(d, 'REQUEST_CHANGES');
    runOnce(d, 'REQUEST_CHANGES');
    d.step({ type: 'trigger', trigger: 'push', tip: sha(1), runId: 'live00001' });
    d.step({ type: 'started', runId: 'live00001', sessionId: 's1', tip: sha(1) });
    expect(d.file.escalated).not.toBeNull();

    expect(d.step({ type: 'trigger', trigger: 'manual', tip: sha(2), runId: 'press0001' })).toEqual([]);
    expect(d.file).toMatchObject({ escalated: null, streak: 0 });
    expect(d.file.runs.filter((r) => r.state === 'running' || r.state === 'queued')).toEqual([
      expect.objectContaining({ id: 'live00001', state: 'running', roundTip: sha(1), pendingTip: sha(2) }),
    ]);
  });
});

describe('I2 PushesJoinTheRunningRun', () => {
  it('a push mid-round gets another round, and a report on the new tip finishes the run', () => {
    const d = driver();
    d.step({ type: 'trigger', trigger: 'submit', tip: sha(1), runId: 'run000001' });
    d.step({ type: 'started', runId: 'run000001', sessionId: 's1', tip: sha(1) });
    d.step({ type: 'tip', tip: sha(2), change: 'change', newRunId: 'never0001' });
    expect(activeRun(d.file)).toMatchObject({ state: 'running', pendingTip: sha(2) });
    expect(d.file.runs).toHaveLength(1);

    const again = d.step({
      type: 'report',
      runId: 'run000001',
      report: report(1, sha(1), 'APPROVE'),
      branchTip: sha(2),
      r3Required: false,
      newRunId: 'never0002',
    });
    expect(again).toEqual([{ kind: 'round', runId: 'run000001', round: 2, tip: sha(2) }]);
    expect(activeRun(d.file)).toMatchObject({ state: 'running', round: 2, roundTip: sha(2) });

    d.step({
      type: 'report',
      runId: 'run000001',
      report: report(2, sha(2), 'APPROVE'),
      branchTip: sha(2),
      r3Required: false,
      newRunId: 'never0003',
    });
    expect(d.file.runs).toHaveLength(1);
    expect(d.file.runs[0]).toMatchObject({ state: 'passed', reviewedTip: sha(2), rounds: 2 });
  });

  it('a report is judged by the tip it names, not the tip its round was sent for', () => {
    const started = (): Driver => {
      const d = driver();
      d.step({ type: 'trigger', trigger: 'submit', tip: sha(1), runId: 'run000001' });
      d.step({ type: 'started', runId: 'run000001', sessionId: 's1', tip: sha(1) });
      return d;
    };
    const event = (branchTip: string): SwarmEvent => ({
      type: 'report',
      runId: 'run000001',
      report: report(1, sha(2), 'APPROVE'),
      branchTip,
      r3Required: false,
      newRunId: 'never0001',
    });

    const caughtUp = started();
    expect(caughtUp.step(event(sha(2)))).toEqual([{ kind: 'stop', runId: 'run000001' }]);
    expect(caughtUp.file.runs[0]).toMatchObject({ state: 'passed', reviewedTip: sha(2) });

    const behind = started();
    expect(behind.step(event(sha(3)))).toEqual([{ kind: 'round', runId: 'run000001', round: 2, tip: sha(3) }]);
  });

  it('a branch that keeps moving ends the run incomplete at the cap and queues one new run', () => {
    const d = driver();
    d.step({ type: 'trigger', trigger: 'submit', tip: sha(1), runId: 'run000001' });
    d.step({ type: 'started', runId: 'run000001', sessionId: 's1', tip: sha(1) });
    let rounds = 0;
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const actions = d.step({
        type: 'report',
        runId: 'run000001',
        report: report(round, sha(round), 'REQUEST_CHANGES'),
        branchTip: sha(round + 1),
        r3Required: false,
        newRunId: 'next00001',
      });
      rounds += actions.filter((a) => a.kind === 'round').length;
    }
    expect(rounds).toBe(MAX_ROUNDS - 1);
    expect(d.file.runs.map((r) => [r.id, r.state])).toEqual([
      ['next00001', 'queued'],
      ['run000001', 'incomplete'],
    ]);
    expect(d.actions.filter((a) => a.kind === 'enqueue')).toHaveLength(2);
    expect(d.actions.some((a) => a.kind === 'send' || a.kind === 'escalate')).toBe(false);
    expect(d.file.streak).toBe(0);
  });
});

describe('I4 and I9: OnlySpecWorkMergesItself, R3FailsClosed', () => {
  const tip = sha(7);
  const passedRun = (r3: object | undefined, reviewedTip = tip): SwarmRun => ({
    id: 'run000001',
    trigger: 'submit',
    requestedAt: 1,
    sessionId: 's',
    startedAt: 1,
    endedAt: 2,
    rounds: 1,
    state: 'passed',
    reviewedTip,
    result: { verdict: 'APPROVE', findings: [], degradations: [] },
    ...(r3 ? { r3: r3 as never } : {}),
  });
  const r3Pass = { verdict: 'pass', findings: [], deviations: [], tip };

  it('only the all-true row approves, a spec review never does, and each row names the first failed check', () => {
    const columns = ['approved', 'notSpec', 'attributed', 'open', 'notEscalated', 'r3Passed', 'tipCurrent'] as const;
    const checks = [
      ['notSpec', 'SPEC_REVIEW'],
      ['approved', 'NOT_APPROVED'],
      ['attributed', 'NOT_ATTRIBUTED'],
      ['open', 'NOT_OPEN'],
      ['notEscalated', 'ESCALATED'],
      ['r3Passed', 'R3_NOT_PASSED'],
      ['tipCurrent', 'TIP_MOVED'],
    ] as const;
    for (let mask = 0; mask < 2 ** columns.length; mask++) {
      const row = Object.fromEntries(columns.map((c, i) => [c, !!(mask & (1 << i))])) as Record<
        (typeof columns)[number],
        boolean
      >;
      const base = passedRun(row.r3Passed ? r3Pass : { ...r3Pass, verdict: 'changes' }, row.tipCurrent ? tip : sha(6));
      const run: SwarmRun = row.approved
        ? base
        : { ...(base as Extract<SwarmRun, { state: 'passed' }>), state: 'changes' };
      const decision = decideAutoApprove({
        run,
        specReview: !row.notSpec,
        attributed: row.attributed,
        reviewOpen: row.open,
        escalated: !row.notEscalated,
        branchTip: tip,
      });
      const failed = checks.find(([column]) => !row[column]);
      expect(decision, JSON.stringify(row)).toEqual(
        failed ? { approve: false, refusal: failed[1] } : { approve: true, tip }
      );
    }
  });

  it('R-3 unavailable, changes, escalate, or a pass on an older tip never merges', () => {
    const facts = { specReview: false, attributed: true, reviewOpen: true, escalated: false, branchTip: tip };
    for (const r3 of [
      { verdict: 'unavailable', reason: 'no SKILL.md' },
      { ...r3Pass, verdict: 'changes' },
      { ...r3Pass, verdict: 'escalate', trigger: 'constraint-broken' },
      { ...r3Pass, tip: sha(6) },
      undefined,
    ])
      expect(decideAutoApprove({ ...facts, run: passedRun(r3) }), JSON.stringify(r3)).toEqual({
        approve: false,
        refusal: 'R3_NOT_PASSED',
      });
    expect(decideAutoApprove({ ...facts, run: passedRun(r3Pass) })).toEqual({ approve: true, tip });
  });

  it('a required R-3 that the run never reported is unavailable, and nothing is offered to merge', () => {
    const d = driver();
    d.step({ type: 'trigger', trigger: 'submit', tip, runId: 'run000001' });
    d.step({ type: 'started', runId: 'run000001', sessionId: 's1', tip });
    const actions = d.step({
      type: 'report',
      runId: 'run000001',
      report: report(1, tip, 'APPROVE'),
      branchTip: tip,
      r3Required: true,
      newRunId: 'next00001',
    });
    expect(d.file.runs[0]).toMatchObject({ state: 'passed', r3: { verdict: 'unavailable' } });
    expect(kinds(actions)).toEqual(['stop']);
  });

  it('a required R-3 the run could not be given reads unavailable with the reason, and never merges', () => {
    const d = driver();
    d.step({ type: 'trigger', trigger: 'submit', tip, runId: 'run000001' });
    d.step({ type: 'started', runId: 'run000001', sessionId: 's1', tip });
    const actions = d.step({
      type: 'report',
      runId: 'run000001',
      report: report(1, tip, 'APPROVE', { r3: r3Pass }),
      branchTip: tip,
      r3Required: true,
      r3Unavailable: 'x'.repeat(900),
      newRunId: 'next00001',
    });
    // A result the run did report wins over the reason; the reason only fills a missing one, capped like the schema.
    expect(d.file.runs[0]).toMatchObject({ r3: { verdict: 'pass' } });
    expect(kinds(actions)).toEqual(['stop', 'consider-approve']);

    const e = driver();
    e.step({ type: 'trigger', trigger: 'submit', tip, runId: 'run000002' });
    e.step({ type: 'started', runId: 'run000002', sessionId: 's1', tip });
    const missing = e.step({
      type: 'report',
      runId: 'run000002',
      report: report(1, tip, 'APPROVE'),
      branchTip: tip,
      r3Required: true,
      r3Unavailable: 'x'.repeat(900),
      newRunId: 'next00002',
    });
    const run = e.file.runs[0]!;
    expect(run).toMatchObject({ state: 'passed', r3: { verdict: 'unavailable' } });
    expect(run.state === 'passed' && run.r3?.verdict === 'unavailable' && run.r3.reason.length).toBe(500);
    expect(kinds(missing)).toEqual(['stop']);
  });

  it('a passed run with R-3 pass is offered to the approve check', () => {
    const d = driver();
    expect(kinds(runOnce(d, 'APPROVE', tip, r3Pass))).toEqual(['stop', 'consider-approve']);
  });

  it('refuses an R-3 escalate that names no trigger from the list', () => {
    const base = { head_sha: tip, round: 1, verdict: 'APPROVE' };
    expect(parseSwarmReport({ ...base, r3: { verdict: 'escalate', findings: ['x'], tip } })).toEqual({
      ok: false,
      error: 'INVALID_REPORT: r3 escalate must name a trigger from the list',
    });
    expect(parseSwarmReport({ ...base, r3: { verdict: 'escalate', trigger: 'vibes', tip } })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^INVALID_REPORT: /),
    });
    expect(parseSwarmReport({ ...base, r3: { verdict: 'escalate', trigger: 'outgrew-ticket', tip } }).ok).toBe(true);
  });

  it('judges spec reviews by their paths and attribution by the parent item', () => {
    expect(isSpecReview(['intent/2026-11-20-x.md'], [])).toBe(true);
    expect(isSpecReview(['intent/2026-11-20-x.md', 'docs/proto.html'], ['docs/proto.html'])).toBe(true);
    expect(isSpecReview(['intent/2026-11-20-x.md', 'src/a.ts'], [])).toBe(false);
    expect(isSpecReview(['docs/proto.html'], ['docs/proto.html'])).toBe(false);
    expect(isSpecReview([], [])).toBe(false);

    const facts = { repoRoot: '/r', project: 'r', branch: 'b', base: 'master', headSha: tip };
    const workReview = (n: number, decision?: Review['decision']): Review => ({
      ...submitReview(
        undefined,
        { title: 'T', walkthrough: 'W' },
        facts,
        { owner: null, sessionId: 'x', sessionName: 'x' },
        `rev${n}00000`,
        1
      ),
      ...storedSource({ kind: 'work', work: { workspaceId: 'ws', number: n } }),
      ...(decision ? { decision } : {}),
    });
    const merged = { kind: 'deployed' as const, at: 2, mergedSha: sha(9) };
    const parent = workReview(1, merged);
    const child = workReview(2);
    expect(attributedSpec(child, { createdFrom: 1 }, [{ review: parent, spec: true }])).toBe(parent);
    expect(attributedSpec(child, { createdFrom: 1 }, [{ review: parent, spec: false }])).toBeNull();
    expect(attributedSpec(child, { createdFrom: 1 }, [{ review: workReview(1), spec: true }])).toBeNull();
    expect(attributedSpec(child, {}, [{ review: parent, spec: true }])).toBeNull();
    expect(attributedSpec(child, { createdFrom: 3 }, [{ review: parent, spec: true }])).toBeNull();
    const sessionReview = { ...child, ...storedSource({ kind: 'session', sessionId: 's', sessionName: 's' }) };
    expect(attributedSpec(sessionReview, { createdFrom: 1 }, [{ review: parent, spec: true }])).toBeNull();
  });
});

describe('I5 OneSendPerVerdict', () => {
  it('sends once per non-approve verdict and never for approve, incomplete or failed runs', () => {
    const d = driver();
    expect(kinds(runOnce(d, 'APPROVE')).filter((k) => k === 'send')).toEqual([]);
    expect(kinds(runOnce(d, 'REQUEST_CHANGES')).filter((k) => k === 'send')).toEqual(['send']);
    expect(d.file.runs[0]).toMatchObject({ state: 'changes', send: { state: 'pending' } });
    expect(kinds(runOnce(d, 'APPROVE_WITH_NITS')).filter((k) => k === 'send')).toEqual([]);
    expect(kinds(runOnce(d, 'BLOCKED')).filter((k) => k === 'send')).toEqual(['send']);

    d.step({ type: 'trigger', trigger: 'push', tip: sha(2), runId: 'fail00001' });
    d.step({ type: 'started', runId: 'fail00001', sessionId: 's', tip: sha(2) });
    expect(d.step({ type: 'failed', runId: 'fail00001', reason: 'silent for 30 minutes' })).toEqual([
      { kind: 'stop', runId: 'fail00001' },
    ]);
  });

  it('an R-3 changes on an approve verdict is a non-approve verdict that sends R-3 findings', () => {
    const d = driver();
    const r3 = { verdict: 'changes', findings: ['Outcome 3 is not met.'], deviations: [], tip: sha(1) };
    expect(kinds(runOnce(d, 'APPROVE', sha(1), r3))).toEqual(['stop', 'send']);
    const run = d.file.runs[0] as Extract<SwarmRun, { state: 'changes' }>;
    expect(run.state).toBe('changes');
    expect(swarmVerdictPrompt(fakeReview('session'), run)).toContain('Outcome 3 is not met.');
  });

  it('records a failed delivery on the run, and a later send replaces it', () => {
    const d = driver();
    runOnce(d, 'REQUEST_CHANGES');
    const id = d.file.runs[0]!.id;
    d.step({ type: 'sent', runId: id, ok: false, reason: 'session gone' });
    expect(d.file.runs[0]).toMatchObject({ send: { state: 'failed', reason: 'session gone' } });
    d.step({ type: 'sent', runId: id, ok: true });
    expect(d.file.runs[0]).toMatchObject({ send: { state: 'sent' } });
  });

  for (const kind of ['session', 'work'] as const)
    it(`the verdict prompt ends as Request changes does on a ${kind} review`, () => {
      const review = fakeReview(kind);
      const withNote = addNote(review, { at: { kind: 'general' }, text: 'n' }, 'note00001', 5);
      if (!withNote.ok) throw new Error('note refused');
      const notes = requestChangesPrompt(withNote.review, withNote.review.notes);
      if (!('text' in notes)) throw new Error(notes.refusal);
      const d = driver();
      runOnce(d, 'REQUEST_CHANGES');
      const prompt = swarmVerdictPrompt(review, d.file.runs[0] as Extract<SwarmRun, { state: 'changes' }>);
      const tail = (s: string): string[] => s.split('\n').slice(-2);
      expect(tail(prompt)).toEqual(tail(notes.text));
      expect(prompt).toContain('Fix the guard.');
      expect(prompt).toContain('src/b.ts:9: Needs a design call.');
    });
});

describe('I6 TwoInARowEscalates', () => {
  it('R, A, R never escalates', () => {
    const d = driver();
    for (const v of ['REQUEST_CHANGES', 'APPROVE', 'REQUEST_CHANGES'] as const) runOnce(d, v);
    expect(d.actions.some((a) => a.kind === 'escalate')).toBe(false);
    expect(d.file.escalated).toBeNull();
    expect(d.file.streak).toBe(1);
  });

  it('R, R escalates on the second without sending it, sends nothing while escalated, and a clear resets', () => {
    const d = driver();
    expect(kinds(runOnce(d, 'REQUEST_CHANGES'))).toEqual(['stop', 'send']);
    const first = d.file.runs[0]!.id;
    const second = runOnce(d, 'BLOCKED');
    expect(kinds(second)).toEqual(['stop', 'escalate']);
    expect(d.file.escalated).toMatchObject({ kind: 'streak', runIds: [d.file.runs[0]!.id, first] });

    expect(kinds(runOnce(d, 'REQUEST_CHANGES'))).toEqual(['stop']);
    expect(
      kinds(runOnce(d, 'APPROVE', sha(1), { verdict: 'pass', findings: [], deviations: [], tip: sha(1) }))
    ).toEqual(['stop']);

    d.step({ type: 'clear' });
    expect(d.file).toMatchObject({ escalated: null, streak: 0 });
    expect(kinds(runOnce(d, 'REQUEST_CHANGES'))).toEqual(['stop', 'send']);
    expect(kinds(runOnce(d, 'REQUEST_CHANGES'))).toEqual(['stop', 'escalate']);
  });

  it('a person pressing Run pr-swarm clears the escalation', () => {
    const d = driver();
    runOnce(d, 'REQUEST_CHANGES');
    runOnce(d, 'REQUEST_CHANGES');
    expect(d.file.escalated).not.toBeNull();
    d.step({ type: 'trigger', trigger: 'manual', tip: sha(1), runId: newId() });
    expect(d.file).toMatchObject({ escalated: null, streak: 0 });
  });

  it('incomplete and failed runs leave the streak alone', () => {
    const d = driver();
    runOnce(d, 'REQUEST_CHANGES');
    d.step({ type: 'trigger', trigger: 'push', tip: sha(3), runId: 'fail00001' });
    d.step({ type: 'failed', runId: 'fail00001', reason: 'could not start' });
    expect(d.file.streak).toBe(1);
    expect(kinds(runOnce(d, 'REQUEST_CHANGES'))).toEqual(['stop', 'escalate']);
  });

  it('an escalation names only the newest run once the earlier flagged run has aged out of the kept runs', () => {
    const d = driver();
    runOnce(d, 'REQUEST_CHANGES');
    const aged = d.file.runs[0]!.id;
    for (let i = 0; i < MAX_RUNS_KEPT; i++) {
      const id = newId();
      d.step({ type: 'trigger', trigger: 'push', tip: sha(1), runId: id });
      d.step({ type: 'failed', runId: id, reason: 'could not start' });
    }
    expect(d.file.runs.some((r) => r.id === aged)).toBe(false);
    expect(d.file.streak).toBe(1);

    expect(kinds(runOnce(d, 'BLOCKED'))).toEqual(['stop', 'escalate']);
    expect(d.file.escalated).toMatchObject({ kind: 'streak', runIds: [d.file.runs[0]!.id] });
  });

  it('a passed run while escalated resets the streak but keeps the escalation and offers nothing to merge', () => {
    const d = driver();
    runOnce(d, 'REQUEST_CHANGES');
    runOnce(d, 'REQUEST_CHANGES');
    const escalation = d.file.escalated;
    expect(escalation).not.toBeNull();

    const r3 = { verdict: 'pass', findings: [], deviations: [], tip: sha(1) };
    expect(kinds(runOnce(d, 'APPROVE', sha(1), r3))).toEqual(['stop']);
    expect(d.file.runs[0]).toMatchObject({ state: 'passed', r3: { verdict: 'pass' } });
    expect(d.file).toMatchObject({ streak: 0, escalated: escalation });
  });

  it('an R-3 escalate escalates at once, naming its trigger', () => {
    const d = driver();
    const r3 = { verdict: 'escalate', trigger: 'outcome-changed', findings: [], deviations: [], tip: sha(1) };
    const actions = runOnce(d, 'APPROVE', sha(1), r3);
    expect(kinds(actions)).toEqual(['stop', 'escalate']);
    expect(d.file.escalated).toMatchObject({ kind: 'r3', trigger: 'outcome-changed' });
  });
});

describe('the Reviews page chip', () => {
  it('shows nothing before a verdict, the active run while one goes, and the newest verdict after', () => {
    const d = driver();
    expect(swarmChip(d.file)).toBeNull();
    d.step({ type: 'trigger', trigger: 'manual', tip: sha(1), runId: newId() });
    expect(swarmChip(d.file)).toBe('queued');
    const run = activeRun(d.file)!;
    d.step({ type: 'started', runId: run.id, sessionId: 's1', tip: sha(1) });
    expect(swarmChip(d.file)).toBe('running');
    d.step({ type: 'failed', runId: run.id, reason: 'silent' });
    expect(swarmChip(d.file)).toBeNull();

    runOnce(d, 'APPROVE_WITH_NITS');
    expect(swarmChip(d.file)).toBe('approve');
    // A failed run carries no verdict, so the verdict before it still shows.
    d.step({ type: 'trigger', trigger: 'manual', tip: sha(2), runId: newId() });
    d.step({ type: 'failed', runId: activeRun(d.file)!.id, reason: 'silent' });
    expect(swarmChip(d.file)).toBe('approve');
    runOnce(d, 'BLOCKED');
    expect(swarmChip(d.file)).toBe('changes');
  });

  it('an escalation outranks a run that is going', () => {
    const d = driver();
    runOnce(d, 'REQUEST_CHANGES');
    runOnce(d, 'REQUEST_CHANGES');
    expect(swarmChip(d.file)).toBe('escalated');
    d.step({ type: 'trigger', trigger: 'push', tip: sha(3), runId: newId() });
    expect(swarmChip(d.file)).toBe('escalated');
  });
});

describe('I8 RunOwnCommitsNeverStartARun', () => {
  const own = { message: `fix: guard\n\nPR-Swarm-Automated: true\nCo-Authored-By: x <x@y>` };
  const person = { message: 'fix: by hand' };

  it('returns own only when a run is active and every commit carries the trailer', () => {
    expect(classifyTipChange([own, own], true)).toBe('own');
    expect(classifyTipChange([own, person], true)).toBe('change');
    expect(classifyTipChange([own], false)).toBe('change');
    expect(classifyTipChange([], true)).toBe('change');
    expect(classifyTipChange([{ message: `${SWARM_TRAILER}\n\nbody that mentions nothing` }], true)).toBe('change');
  });

  it('a tip change with no run going queues a run, and a run-own change never does', () => {
    const d = driver();
    d.step({ type: 'tip', tip: sha(2), change: 'own', newRunId: 'own000001' });
    expect(d.file.runs).toEqual([]);
    d.step({ type: 'tip', tip: sha(3), change: 'change', newRunId: 'push00001' });
    expect(d.file.runs.map((r) => [r.id, r.state, r.trigger])).toEqual([['push00001', 'queued', 'push']]);
  });
});

describe('the report contract', () => {
  it('caps and cleans agent text and normalises the verdict', () => {
    const parsed = parseSwarmReport({
      head_sha: sha(1),
      round: 1,
      verdict: 'request-changes',
      router: { danger: 'LOW' },
      findings: Array.from({ length: 150 }, () => ({ file: 'a\u0007.ts', line: 'general', body: 'x\u001b[31my' })),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.report.result.verdict).toBe('REQUEST_CHANGES');
    expect(parsed.report.result.findings).toHaveLength(100);
    expect(parsed.report.result.findings[0]).toMatchObject({ file: 'a.ts', line: 'general', body: 'x[31my' });
    expect(parseSwarmReport({ head_sha: sha(1), round: 1, verdict: 'LGTM' })).toEqual({
      ok: false,
      error: 'INVALID_REPORT: unknown verdict "LGTM"',
    });
    expect(parseSwarmReport({ head_sha: 'nope', round: 1, verdict: 'APPROVE' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^INVALID_REPORT: /),
    });
  });
});

describe('I7 ReviewFilesUnchanged', () => {
  beforeEach(() => {
    deployRole.enter('live');
    rmSync(dataPath('reviews'), { recursive: true, force: true });
  });

  it('the review file schema is still the frozen copy key for key, so the previous release reads every file', () => {
    // The fixture is `JSON.stringify(z.toJSONSchema(ReviewFileSchema), null, 2)` plus a newline, written by W-109.
    expect(z.toJSONSchema(ReviewFileSchema)).toEqual(frozenReviewFile);
  });

  it('a frozen copy of the review file schema parses every review file written while runs exist', () => {
    const frozen = z.fromJSONSchema(frozenReviewFile as unknown as Parameters<typeof z.fromJSONSchema>[0]);
    const reviews = [fakeReview('session', 'bbbbbbbbbbbbbbbb'), fakeReview('work', 'cccccccccccccccc')];
    for (const review of reviews) {
      writeReview(review);
      const d = driver(emptySwarmFile(review.id));
      runOnce(d, 'REQUEST_CHANGES');
      runOnce(d, 'APPROVE');
      expect(changeSwarm(review.id, () => ({ file: d.file }))).toMatchObject({ ok: true });
    }

    const names = readdirSync(dataPath('reviews'));
    expect(names.filter((n) => n.endsWith('.swarm.json'))).toHaveLength(2);
    const reviewFiles = names.filter((n) => n.endsWith('.json') && !n.endsWith('.swarm.json'));
    expect(reviewFiles).toHaveLength(2);
    for (const name of reviewFiles) {
      const json = JSON.parse(readFileSync(dataPath('reviews', name), 'utf8'));
      expect(frozen.safeParse(json).success, name).toBe(true);
    }
    // The frozen copy can see a key it does not know.
    const json = JSON.parse(readFileSync(dataPath('reviews', reviewFiles[0]!), 'utf8'));
    expect(frozen.safeParse({ ...json, review: { ...json.review, swarm: {} } }).success).toBe(false);

    expect(
      listReviews()
        .map((r) => r.id)
        .sort()
    ).toEqual(reviews.map((r) => r.id).sort());
    expect(readReview('bbbbbbbbbbbbbbbb')).toMatchObject({ ok: true });
    expect(readSwarm('bbbbbbbbbbbbbbbb')).toMatchObject({
      ok: true,
      file: { runs: [{ state: 'passed' }, { state: 'changes', send: { state: 'pending' } }] },
    });
  });

  it('writes nothing outside the live colour, and never overwrites a file a newer release wrote', () => {
    const id = 'dddddddddddddddd';
    expect(readSwarm(id)).toEqual({ ok: true, file: emptySwarmFile(id) });
    deployRole.enter('retired');
    expect(() => changeSwarm(id, (file) => ({ file: { ...file, streak: 1 } }))).toThrow();
    deployRole.enter('live');
    changeSwarm(id, (file) => ({ file: { ...file, streak: 1 } }));
    expect(readSwarm(id)).toMatchObject({ ok: true, file: { streak: 1 } });

    const path = dataPath('reviews', `${id}.swarm.json`);
    rmSync(path);
    writeFileSync(path, JSON.stringify({ version: 2 }));
    expect(readSwarm(id)).toEqual({ ok: false, reason: 'newer' });
    const result = changeSwarm(id, (file) => ({ file: { ...file, streak: 5 } }));
    expect(result).toEqual({ ok: false, reason: 'newer' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 2 });
  });

  it('a change whose file fails the schema or names another review answers invalid and leaves the file alone', () => {
    const id = 'ffffffffffffffff';
    changeSwarm(id, (file) => ({ file: { ...file, streak: 2 } }));
    const path = dataPath('reviews', `${id}.swarm.json`);
    const before = readFileSync(path, 'utf8');

    expect(changeSwarm(id, (file) => ({ file: { ...file, streak: -1 } }))).toEqual({ ok: false, reason: 'invalid' });
    expect(changeSwarm(id, (file) => ({ file: { ...file, reviewId: 'eeeeeeeeeeeeeeee' } }))).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readdirSync(dataPath('reviews'))).not.toContain('eeeeeeeeeeeeeeee.swarm.json');
  });
});

function fakeReview(kind: 'session' | 'work', id = 'eeeeeeeeeeeeeeee'): Review {
  const review = submitReview(
    undefined,
    { title: 'Swarm me', walkthrough: 'W' },
    { repoRoot: '/r', project: 'r', branch: 'feat/x', base: 'master', headSha: sha(1) },
    { owner: null, sessionId: 'author', sessionName: 'w9' },
    id,
    1
  );
  return kind === 'work'
    ? { ...review, ...storedSource({ kind: 'work', work: { workspaceId: 'ws', number: 4 } }) }
    : review;
}
