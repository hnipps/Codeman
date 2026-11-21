/**
 * @fileoverview pr-swarm runs on a review: the stored run record and its rules, with no IO (design in
 * `intent/2026-11-20-pr-swarm-reviews.md`; `swarm-store.ts` keeps the files).
 *
 * A review's runs live in their own file beside the review, never in the review, so the previous release reads every
 * review unchanged (I7). Everything that happens to a run arrives as one event, and `applySwarmEvent()` answers with
 * the next file and the side effects the caller must carry out. So the rules that must hold across any interleaving
 * (one run at a time, pushes join the running run, one send per verdict, two in a row escalate) are properties of
 * one pure function.
 *
 * The agent's report is untrusted text: `parseSwarmReport()` validates, caps and cleans it once, here.
 */
import { z } from 'zod';
import {
  cleanLine,
  cleanText,
  MAX_NOTE_CHARS,
  MAX_PATH_CHARS,
  requestChangesEnding,
  ReviewIdSchema,
  ShaSchema,
  sourceOf,
  type Review,
} from './review-model.js';

/** The plugin's round cap (review-triage INV-4): a run sends at most this many rounds. */
export const MAX_ROUNDS = 5;
/** Runs kept per review, newest first. */
export const MAX_RUNS_KEPT = 20;
/** Two non-approve verdicts in a row escalate (I6). */
export const ESCALATE_AT_STREAK = 2;
export const MAX_FINDINGS = 100;
export const MAX_DEFERRED = 100;
export const MAX_DEGRADATIONS = 20;
export const MAX_FIX_COMMITS = 50;
export const MAX_R3_ITEMS = 50;
/** Raw list lengths past which a report is refused rather than trimmed. */
const MAX_RAW_ITEMS = 1000;

const RunIdSchema = z.string().regex(/^[a-z0-9]{8,40}$/);
const SessionIdSchema = z.string().min(1).max(100);
const At = z.number().int().nonnegative();

export const SWARM_VERDICTS = ['APPROVE', 'APPROVE_WITH_NITS', 'REQUEST_CHANGES', 'BLOCKED'] as const;
export type SwarmVerdict = (typeof SWARM_VERDICTS)[number];
export const isApproveVerdict = (v: SwarmVerdict): boolean => v === 'APPROVE' || v === 'APPROVE_WITH_NITS';

export const SWARM_TRIGGERS = ['submit', 'push', 'manual'] as const;
export type SwarmTrigger = (typeof SWARM_TRIGGERS)[number];

/** The spec-first lifecycle's fixed escalation list (`intent/2026-11-18-spec-first-lifecycle.md`). Nothing else escalates. */
export const R3_TRIGGERS = [
  'outcome-changed',
  'constraint-broken',
  'unspecified-visible-change',
  'outgrew-ticket',
  'unresolved-disagreement',
  'unverifiable',
  'deploy-fix-failed',
] as const;
export type R3Trigger = (typeof R3_TRIGGERS)[number];

const FindingSchema = z
  .object({
    file: z.string().max(MAX_PATH_CHARS),
    line: z.union([z.number().int().positive(), z.literal('general')]),
    severity: z.string().max(20),
    reviewer: z.string().max(80),
    body: z.string().max(MAX_NOTE_CHARS),
  })
  .strict();
export type SwarmFinding = z.infer<typeof FindingSchema>;

const DeferredSchema = z
  .object({ location: z.string().max(MAX_PATH_CHARS), reason: z.string().max(MAX_NOTE_CHARS) })
  .strict();
const TriageSchema = z
  .object({
    fixCommits: z.array(ShaSchema).max(MAX_FIX_COMMITS),
    deferred: z.array(DeferredSchema).max(MAX_DEFERRED),
  })
  .strict();
export type SwarmTriage = z.infer<typeof TriageSchema>;

const R3Text = z.array(z.string().max(MAX_NOTE_CHARS)).max(MAX_R3_ITEMS);
const R3Judged = { findings: R3Text, deviations: R3Text, tip: ShaSchema };
/** R-3's result. `escalate` always names its trigger; `unavailable` is what a missing or unreadable step gives (I9). */
export const R3ResultSchema = z.discriminatedUnion('verdict', [
  z.object({ verdict: z.literal('pass'), ...R3Judged }).strict(),
  z.object({ verdict: z.literal('changes'), ...R3Judged }).strict(),
  z.object({ verdict: z.literal('escalate'), trigger: z.enum(R3_TRIGGERS), ...R3Judged }).strict(),
  z.object({ verdict: z.literal('unavailable'), reason: z.string().max(500) }).strict(),
]);
export type R3Result = z.infer<typeof R3ResultSchema>;

/** One round's result, as stored. */
const RoundResultSchema = z
  .object({
    verdict: z.enum(SWARM_VERDICTS),
    findings: z.array(FindingSchema).max(MAX_FINDINGS),
    degradations: z.array(z.string().max(500)).max(MAX_DEGRADATIONS),
    /** Absent on a spec review, which gets the review half only. */
    triage: TriageSchema.optional(),
  })
  .strict();
export type RoundResult = z.infer<typeof RoundResultSchema>;

/** Whether the verdict reached the agent. Only a run whose verdict is sent carries it (I5). */
const SendSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('pending') }).strict(),
  z.object({ state: z.literal('sent'), at: At }).strict(),
  z.object({ state: z.literal('failed'), at: At, reason: z.string().max(500) }).strict(),
]);
export type SwarmSend = z.infer<typeof SendSchema>;

const Base = { id: RunIdSchema, trigger: z.enum(SWARM_TRIGGERS), requestedAt: At };
const Ran = { ...Base, sessionId: SessionIdSchema, startedAt: At, endedAt: At, rounds: z.number().int().min(1) };
const Verdicted = { ...Ran, reviewedTip: ShaSchema, result: RoundResultSchema, r3: R3ResultSchema.optional() };

export const SwarmRunSchema = z.discriminatedUnion('state', [
  /** Waiting for the server-wide slot. `tip` is the newest tip seen; the run reviews whatever is current at start. */
  z.object({ ...Base, state: z.literal('queued'), tip: ShaSchema }).strict(),
  z
    .object({
      ...Base,
      state: z.literal('running'),
      sessionId: SessionIdSchema,
      startedAt: At,
      round: z.number().int().min(1).max(MAX_ROUNDS),
      /** The tip the current round was sent for. */
      roundTip: ShaSchema,
      /** A newer tip seen while the round runs (I2). */
      pendingTip: ShaSchema.optional(),
    })
    .strict(),
  z.object({ ...Verdicted, state: z.literal('passed') }).strict(),
  z.object({ ...Verdicted, state: z.literal('changes'), send: SendSchema.optional() }).strict(),
  z.object({ ...Verdicted, state: z.literal('blocked'), send: SendSchema.optional() }).strict(),
  /** The round cap was reached with the branch still moving. No verdict: nothing is sent and the streak stays. */
  z.object({ ...Ran, state: z.literal('incomplete'), reviewedTip: ShaSchema, branchTip: ShaSchema }).strict(),
  z.object({ ...Base, state: z.literal('failed'), endedAt: At, reason: z.string().max(500) }).strict(),
]);
export type SwarmRun = z.infer<typeof SwarmRunSchema>;
export type ActiveRun = Extract<SwarmRun, { state: 'queued' | 'running' }>;
export type FlaggedRun = Extract<SwarmRun, { state: 'changes' | 'blocked' }>;

const EscalationSchema = z.discriminatedUnion('kind', [
  /** Two non-approve verdicts in a row, newest first. The older one is absent once it has aged out of `runs`. */
  z.object({ kind: z.literal('streak'), at: At, runIds: z.array(RunIdSchema).min(1).max(2) }).strict(),
  z.object({ kind: z.literal('r3'), at: At, runId: RunIdSchema, trigger: z.enum(R3_TRIGGERS) }).strict(),
]);
export type SwarmEscalation = z.infer<typeof EscalationSchema>;

export const SwarmFileSchema = z
  .object({
    version: z.literal(1),
    reviewId: ReviewIdSchema,
    /** Non-approve verdicts since the last approve verdict or clear (I6). */
    streak: z.number().int().nonnegative(),
    escalated: EscalationSchema.nullable(),
    runs: z.array(SwarmRunSchema).max(MAX_RUNS_KEPT),
  })
  .strict();
export type SwarmFile = z.infer<typeof SwarmFileSchema>;

export const emptySwarmFile = (reviewId: string): SwarmFile => ({
  version: 1,
  reviewId,
  streak: 0,
  escalated: null,
  runs: [],
});

/** The run in `queued` or `running`, if any. There is at most one (I1), and it is always the newest. */
export const activeRun = (file: SwarmFile): ActiveRun | undefined => {
  const run = file.runs[0];
  return run && (run.state === 'queued' || run.state === 'running') ? run : undefined;
};

// --- The agent's report -------------------------------------------------------------------------------------------

const rawText = (max: number) => z.string().max(max);
const RawFindingSchema = z.object({
  file: rawText(MAX_PATH_CHARS * 4).optional(),
  line: z.union([z.number(), z.string().max(40)]).optional(),
  severity: rawText(200).optional(),
  reviewer: rawText(400).optional(),
  body: rawText(MAX_NOTE_CHARS * 4),
});
const RawR3Schema = z.object({
  verdict: z.enum(['pass', 'changes', 'escalate', 'unavailable']),
  trigger: z.enum(R3_TRIGGERS).optional(),
  findings: z
    .array(rawText(MAX_NOTE_CHARS * 4))
    .max(MAX_RAW_ITEMS)
    .default([]),
  deviations: z
    .array(rawText(MAX_NOTE_CHARS * 4))
    .max(MAX_RAW_ITEMS)
    .default([]),
  tip: ShaSchema.optional(),
  reason: rawText(2000).optional(),
});
/** The JSON a run's session reports for one round: pr-swarm's return contract, plus triage and R-3 when they ran. */
const RawReportSchema = z.object({
  head_sha: ShaSchema,
  round: z.number().int().min(1).max(MAX_ROUNDS),
  verdict: z.string().max(40),
  findings: z.array(RawFindingSchema).max(MAX_RAW_ITEMS).default([]),
  degradations: z.array(rawText(4000)).max(MAX_RAW_ITEMS).default([]),
  triage: z
    .object({
      fix_commits: z.array(ShaSchema).max(MAX_RAW_ITEMS).default([]),
      deferred: z
        .array(z.object({ location: rawText(MAX_PATH_CHARS * 4), reason: rawText(MAX_NOTE_CHARS * 4) }))
        .max(MAX_RAW_ITEMS)
        .default([]),
    })
    .optional(),
  r3: RawR3Schema.optional(),
});

export type SwarmReport = { headSha: string; round: number; result: RoundResult; r3?: R3Result };
export type ReportParse = { ok: true; report: SwarmReport } | { ok: false; error: string };

const items = (list: string[], max: number, each: number): string[] =>
  list
    .map((s) => cleanText(s, each).trim())
    .filter(Boolean)
    .slice(0, max);

/**
 * Validates and cleans a round report. The verdict is matched as the plugin does: case-insensitive, `-` read as `_`.
 * Lists past the stored caps are trimmed, every text is capped and stripped of control characters, and an `escalate`
 * that names no trigger from the lifecycle's list is refused (I9).
 */
export function parseSwarmReport(json: unknown): ReportParse {
  const raw = RawReportSchema.safeParse(json);
  if (!raw.success) return { ok: false, error: `INVALID_REPORT: ${raw.error.issues[0]?.message ?? 'bad report'}` };
  const r = raw.data;
  const verdict = r.verdict.toUpperCase().replace(/-/g, '_');
  if (!(SWARM_VERDICTS as readonly string[]).includes(verdict))
    return { ok: false, error: `INVALID_REPORT: unknown verdict "${cleanLine(r.verdict, 40)}"` };
  const findings: SwarmFinding[] = r.findings.slice(0, MAX_FINDINGS).map((f) => ({
    file: cleanLine(f.file ?? '', MAX_PATH_CHARS),
    line: typeof f.line === 'number' && Number.isInteger(f.line) && f.line > 0 ? f.line : 'general',
    severity: cleanLine(f.severity ?? '', 20).toUpperCase(),
    reviewer: cleanLine(f.reviewer ?? '', 80),
    body: cleanText(f.body, MAX_NOTE_CHARS),
  }));
  const result: RoundResult = {
    verdict: verdict as SwarmVerdict,
    findings,
    degradations: items(r.degradations, MAX_DEGRADATIONS, 500),
    ...(r.triage
      ? {
          triage: {
            fixCommits: r.triage.fix_commits.slice(0, MAX_FIX_COMMITS),
            deferred: r.triage.deferred.slice(0, MAX_DEFERRED).map((d) => ({
              location: cleanLine(d.location, MAX_PATH_CHARS),
              reason: cleanText(d.reason, MAX_NOTE_CHARS),
            })),
          },
        }
      : {}),
  };
  let r3: R3Result | undefined;
  if (r.r3) {
    const x = r.r3;
    if (x.verdict === 'unavailable') r3 = { verdict: 'unavailable', reason: cleanLine(x.reason ?? '', 500) };
    else if (!x.tip) return { ok: false, error: 'INVALID_REPORT: r3 needs the tip it judged' };
    else {
      const judged = {
        findings: items(x.findings, MAX_R3_ITEMS, MAX_NOTE_CHARS),
        deviations: items(x.deviations, MAX_R3_ITEMS, MAX_NOTE_CHARS),
        tip: x.tip,
      };
      if (x.verdict === 'escalate') {
        if (!x.trigger) return { ok: false, error: 'INVALID_REPORT: r3 escalate must name a trigger from the list' };
        r3 = { verdict: 'escalate', trigger: x.trigger, ...judged };
      } else r3 = { verdict: x.verdict, ...judged };
    }
  }
  return { ok: true, report: { headSha: r.head_sha, round: r.round, result, ...(r3 ? { r3 } : {}) } };
}

// --- Events and the reducer ---------------------------------------------------------------------------------------

export type SwarmEvent =
  /** A submit, a push seen by the watcher, or a person's button. `tip` is the branch tip at that moment. */
  | { type: 'trigger'; trigger: SwarmTrigger; tip: string; runId: string }
  /** The watcher saw the tip move. `change` is `classifyTipChange()`'s answer (I8); `newRunId` names a run it queues. */
  | { type: 'tip'; tip: string; change: TipChange; newRunId: string }
  /** The runner took the server-wide slot and started the run's session on `tip`. */
  | { type: 'started'; runId: string; sessionId: string; tip: string }
  /**
   * The session reported a round. `branchTip` is the branch's tip read just after; `r3Required` is whether the review
   * is non-spec work attributed to an approved spec, and `r3Unavailable` why the run could not give R-3 what it needs.
   * `newRunId` names the run queued when the round cap ends this one.
   */
  | {
      type: 'report';
      runId: string;
      report: SwarmReport;
      branchTip: string;
      r3Required: boolean;
      r3Unavailable?: string;
      newRunId: string;
    }
  /** The session died, went silent, or the run could not start. */
  | { type: 'failed'; runId: string; reason: string }
  /** The outcome of delivering a run's verdict. */
  | { type: 'sent'; runId: string; ok: true }
  | { type: 'sent'; runId: string; ok: false; reason: string }
  /** A person sent notes, approved, closed, or moved the item out of Human required. */
  | { type: 'clear' };

/** What the caller must do. The reducer itself does nothing. */
export type SwarmAction =
  /** Put the run in the server-wide FIFO. */
  | { kind: 'enqueue'; runId: string }
  /** Ask the run's session for another round on `tip` (I2). */
  | { kind: 'round'; runId: string; round: number; tip: string }
  /** Deliver the verdict prompt (`swarmVerdictPrompt`) for this run, once (I5). */
  | { kind: 'send'; runId: string }
  /** Move the review's open items to Human required, or notify when it has none (I6). */
  | { kind: 'escalate'; runId: string; escalation: SwarmEscalation }
  /** A passed run that may merge: re-read every fact and ask `decideAutoApprove()` (I4). */
  | { kind: 'consider-approve'; runId: string }
  /** End the run's session and remove its worktree. */
  | { kind: 'stop'; runId: string };

export type SwarmStep = { file: SwarmFile; actions: SwarmAction[] };

const withRuns = (file: SwarmFile, runs: SwarmRun[]): SwarmFile => ({ ...file, runs: runs.slice(0, MAX_RUNS_KEPT) });
const replaceRun = (file: SwarmFile, run: SwarmRun): SwarmFile =>
  withRuns(
    file,
    file.runs.map((r) => (r.id === run.id ? run : r))
  );
const unchanged = (file: SwarmFile): SwarmStep => ({ file, actions: [] });

/** The one function every run change goes through. `now` stamps the times; nothing else is read. */
export function applySwarmEvent(file: SwarmFile, event: SwarmEvent, now: number): SwarmStep {
  const active = activeRun(file);
  switch (event.type) {
    case 'trigger': {
      // A person's press clears an escalation (I6), whether or not it joins a run.
      const base = event.trigger === 'manual' && file.escalated ? { ...file, escalated: null, streak: 0 } : file;
      if (active) return unchanged(noteTip(base, active, event.tip));
      const run: SwarmRun = {
        id: event.runId,
        trigger: event.trigger,
        requestedAt: now,
        state: 'queued',
        tip: event.tip,
      };
      return { file: withRuns(base, [run, ...base.runs]), actions: [{ kind: 'enqueue', runId: run.id }] };
    }
    case 'tip': {
      if (active) return unchanged(noteTip(file, active, event.tip));
      // The watcher measures a move from the newest tip the runs recorded, so a finished run's own reviewed push never
      // arrives here. `own` with no run means the run ended after the watcher read it, and its report read that tip
      // or a newer one.
      if (event.change === 'own') return unchanged(file);
      return applySwarmEvent(file, { type: 'trigger', trigger: 'push', tip: event.tip, runId: event.newRunId }, now);
    }
    case 'started': {
      if (active?.id !== event.runId || active.state !== 'queued') return unchanged(file);
      const run: SwarmRun = {
        id: active.id,
        trigger: active.trigger,
        requestedAt: active.requestedAt,
        state: 'running',
        sessionId: event.sessionId,
        startedAt: now,
        round: 1,
        roundTip: event.tip,
      };
      return unchanged(replaceRun(file, run));
    }
    case 'failed': {
      if (active?.id !== event.runId) return unchanged(file);
      const run: SwarmRun = {
        id: active.id,
        trigger: active.trigger,
        requestedAt: active.requestedAt,
        state: 'failed',
        endedAt: now,
        reason: cleanLine(event.reason, 500),
      };
      return {
        file: replaceRun(file, run),
        actions: active.state === 'running' ? [{ kind: 'stop', runId: run.id }] : [],
      };
    }
    case 'report':
      if (active?.id !== event.runId || active.state !== 'running') return unchanged(file);
      return applyReport(file, active, event, now);
    case 'sent': {
      const run = file.runs.find((r) => r.id === event.runId);
      if (!run || (run.state !== 'changes' && run.state !== 'blocked') || !run.send) return unchanged(file);
      const send: SwarmSend = event.ok
        ? { state: 'sent', at: now }
        : { state: 'failed', at: now, reason: cleanLine(event.reason, 500) };
      return unchanged(replaceRun(file, { ...run, send }));
    }
    case 'clear':
      return unchanged(file.escalated || file.streak ? { ...file, escalated: null, streak: 0 } : file);
  }
}

/** A tip seen while a run is active: a queued run takes it, a running one records it for the next round (I2). */
function noteTip(file: SwarmFile, active: ActiveRun, tip: string): SwarmFile {
  if (active.state === 'queued') return active.tip === tip ? file : replaceRun(file, { ...active, tip });
  if (tip === active.roundTip) {
    if (!active.pendingTip) return file;
    const { pendingTip: _, ...rest } = active;
    return replaceRun(file, rest);
  }
  return active.pendingTip === tip ? file : replaceRun(file, { ...active, pendingTip: tip });
}

function applyReport(
  file: SwarmFile,
  run: Extract<SwarmRun, { state: 'running' }>,
  event: Extract<SwarmEvent, { type: 'report' }>,
  now: number
): SwarmStep {
  const { report, branchTip } = event;
  const ran = {
    id: run.id,
    trigger: run.trigger,
    requestedAt: run.requestedAt,
    sessionId: run.sessionId,
    startedAt: run.startedAt,
    endedAt: now,
    rounds: run.round,
  };
  if (report.round !== run.round) {
    const failed: SwarmRun = {
      id: run.id,
      trigger: run.trigger,
      requestedAt: run.requestedAt,
      state: 'failed',
      endedAt: now,
      reason: `The session reported round ${report.round} while round ${run.round} was running`,
    };
    return { file: replaceRun(file, failed), actions: [{ kind: 'stop', runId: run.id }] };
  }
  // I2: the branch moved past what this round reviewed. Another round, until the cap.
  if (report.headSha !== branchTip) {
    if (run.round < MAX_ROUNDS) {
      const { pendingTip: _, ...current } = run;
      const next: SwarmRun = { ...current, round: run.round + 1, roundTip: branchTip };
      return {
        file: replaceRun(file, next),
        actions: [{ kind: 'round', runId: run.id, round: run.round + 1, tip: branchTip }],
      };
    }
    const incomplete: SwarmRun = { ...ran, state: 'incomplete', reviewedTip: report.headSha, branchTip };
    const ended = replaceRun(file, incomplete);
    const queued = applySwarmEvent(
      ended,
      { type: 'trigger', trigger: 'push', tip: branchTip, runId: event.newRunId },
      now
    );
    return { file: queued.file, actions: [{ kind: 'stop', runId: run.id }, ...queued.actions] };
  }

  // I9: R-3 counts only where it must run. Required but missing is `unavailable`, which never merges.
  const r3: R3Result | undefined = event.r3Required
    ? (report.r3 ?? {
        verdict: 'unavailable',
        reason: cleanLine(event.r3Unavailable ?? 'The run reported no R-3 result', 500),
      })
    : undefined;
  const verdicted = { ...ran, reviewedTip: report.headSha, result: report.result, ...(r3 ? { r3 } : {}) };
  const stop: SwarmAction = { kind: 'stop', runId: run.id };

  if (isApproveVerdict(report.result.verdict) && r3?.verdict !== 'changes' && r3?.verdict !== 'escalate') {
    const passed: SwarmRun = { ...verdicted, state: 'passed' };
    const next = { ...replaceRun(file, passed), streak: 0 };
    const merge = r3?.verdict === 'pass' && !file.escalated;
    return { file: next, actions: merge ? [stop, { kind: 'consider-approve', runId: run.id }] : [stop] };
  }

  const state = report.result.verdict === 'BLOCKED' ? 'blocked' : 'changes';
  const streak = file.streak + 1;
  const escalation: SwarmEscalation | null = file.escalated
    ? null
    : r3?.verdict === 'escalate'
      ? { kind: 'r3', at: now, runId: run.id, trigger: r3.trigger }
      : streak >= ESCALATE_AT_STREAK
        ? { kind: 'streak', at: now, runIds: [run.id, ...previousFlagged(file, run.id)] }
        : null;
  // I6: escalating, or already escalated, sends nothing to an agent.
  const sends = !file.escalated && !escalation;
  const flagged: SwarmRun = { ...verdicted, state, ...(sends ? { send: { state: 'pending' as const } } : {}) };
  const next: SwarmFile = {
    ...replaceRun(file, flagged),
    streak,
    escalated: escalation ?? file.escalated,
  };
  const actions: SwarmAction[] = [stop];
  if (escalation) actions.push({ kind: 'escalate', runId: run.id, escalation });
  if (sends) actions.push({ kind: 'send', runId: run.id });
  return { file: next, actions };
}

/** The newest flagged run before `runId`, as a list: it may have aged out of the kept runs. */
function previousFlagged(file: SwarmFile, runId: string): string[] {
  const prev = file.runs.find((r) => r.id !== runId && (r.state === 'changes' || r.state === 'blocked'));
  return prev ? [prev.id] : [];
}

// --- Decisions ----------------------------------------------------------------------------------------------------

export type AutoApproveInputs = {
  run: SwarmRun;
  /** Each read fresh when the decision is made. */
  specReview: boolean;
  attributed: boolean;
  reviewOpen: boolean;
  escalated: boolean;
  branchTip: string;
};
export type AutoApproveRefusal =
  | 'NOT_APPROVED'
  | 'SPEC_REVIEW'
  | 'NOT_ATTRIBUTED'
  | 'NOT_OPEN'
  | 'ESCALATED'
  | 'R3_NOT_PASSED'
  | 'TIP_MOVED';
export type AutoApproveDecision = { approve: true; tip: string } | { approve: false; refusal: AutoApproveRefusal };

/**
 * I4 and I9: the one test for an automatic Approve. Only spec-attributed work whose run passed and whose R-3 passed the
 * very tip the branch is at now may merge itself. A spec review never does. The caller then runs the Approve button's
 * own function, so its refusals still apply.
 */
export function decideAutoApprove(i: AutoApproveInputs): AutoApproveDecision {
  const no = (refusal: AutoApproveRefusal): AutoApproveDecision => ({ approve: false, refusal });
  if (i.specReview) return no('SPEC_REVIEW');
  if (i.run.state !== 'passed' || !isApproveVerdict(i.run.result.verdict)) return no('NOT_APPROVED');
  if (!i.attributed) return no('NOT_ATTRIBUTED');
  if (!i.reviewOpen) return no('NOT_OPEN');
  if (i.escalated) return no('ESCALATED');
  if (i.run.r3?.verdict !== 'pass' || i.run.r3.tip !== i.branchTip) return no('R3_NOT_PASSED');
  if (i.run.reviewedTip !== i.branchTip) return no('TIP_MOVED');
  return { approve: true, tip: i.branchTip };
}

const SPEC_FILE = /^intent\/[^/]+\.md$/;
/**
 * A spec review changes spec files under `intent/` and, beside them, only files the spec links (canvas prototypes and
 * docs). A heuristic until reviews carry a kind; a wrong "no" only gives a spec the full triage, and I4 still needs
 * attribution before anything merges.
 */
export function isSpecReview(changedPaths: readonly string[], linkedPaths: readonly string[]): boolean {
  if (!changedPaths.some((p) => SPEC_FILE.test(p))) return false;
  const linked = new Set(linkedPaths);
  return changedPaths.every((p) => SPEC_FILE.test(p) || linked.has(p));
}

/** A review of the item's parent, with whether it was a spec review (judged by the caller from its changed paths). */
export type ParentReview = { review: Review; spec: boolean };

/**
 * The merged spec review a work review is attributed to, or null: the review must be a work review, its item must
 * have been created from another item, and that parent must have a merged review that was a spec review.
 */
export function attributedSpec(
  review: Review,
  item: { createdFrom?: number | undefined } | undefined,
  parentReviews: readonly ParentReview[]
): Review | null {
  const source = sourceOf(review);
  if (source.kind !== 'work' || !item?.createdFrom) return null;
  const parent = { workspaceId: source.work.workspaceId, number: item.createdFrom };
  const found = parentReviews.find(({ review: r, spec }) => {
    const s = sourceOf(r);
    return (
      spec &&
      s.kind === 'work' &&
      s.work.workspaceId === parent.workspaceId &&
      s.work.number === parent.number &&
      r.decision !== undefined &&
      r.decision.kind !== 'closed' &&
      r.decision.mergedSha !== undefined
    );
  });
  return found?.review ?? null;
}

export type TipChange = 'own' | 'change';
export const SWARM_TRAILER = 'PR-Swarm-Automated: true';

/**
 * I8: a tip change is the running run's own work only when a run is active and every new commit carries the trailer
 * in its final trailer block. A person's or another agent's commit, a rewind (no new commits), or any change while no
 * run is active is a change. This alone does not keep a finished run's pushes from starting a run: the watcher's
 * baseline (`tipMove()`, the newest tip the runs recorded) does, so a push the run reviewed is never fed as a move.
 */
export function classifyTipChange(commits: readonly { message: string }[], runActive: boolean): TipChange {
  if (!runActive || !commits.length) return 'change';
  return commits.every((c) => hasTrailer(c.message)) ? 'own' : 'change';
}
function hasTrailer(message: string): boolean {
  const blocks = message
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n\s*\n/);
  return (blocks[blocks.length - 1] ?? '').split('\n').some((l) => l.trim() === SWARM_TRAILER);
}

/**
 * The one prompt that carries a non-approve verdict to the agent (I5): pr-swarm's findings, the triage's deferred
 * items and R-3's findings, labelled as review notes, ending exactly as Request changes ends for that kind of review.
 */
export function swarmVerdictPrompt(review: Review, run: FlaggedRun): string {
  const { result, r3 } = run;
  const findingLines = result.findings.flatMap((f, i) => [
    `${i + 1}. ${[f.severity, f.reviewer].filter(Boolean).join(' ') || 'Finding'}${
      f.file ? ` on ${f.file}${f.line === 'general' ? '' : `:${f.line}`}` : ''
    }`,
    ...f.body.split('\n').map((l) => `   ${l}`),
    '',
  ]);
  const deferred = result.triage?.deferred ?? [];
  const r3Lines =
    r3 && (r3.verdict === 'changes' || r3.verdict === 'escalate')
      ? [
          'R-3 checked the work against its spec and asked for changes:',
          '',
          ...r3.findings.flatMap((f, i) => [`${i + 1}. ${f}`]),
          ...(r3.deviations.length ? ['', 'Deviations it found:', ...r3.deviations.map((d) => `- ${d}`)] : []),
          '',
        ]
      : [];
  const lines = [
    `pr-swarm notes on "${review.title}" (branch ${review.branch}, tip ${run.reviewedTip.slice(0, 7)}). ` +
      `Its verdict is ${result.verdict}.`,
    '',
    ...(findingLines.length ? ['Findings:', '', ...findingLines] : []),
    ...(deferred.length
      ? ['Items the triage left for you:', '', ...deferred.map((d) => `- ${d.location}: ${d.reason}`), '']
      : []),
    ...r3Lines,
    ...requestChangesEnding(review),
  ];
  return lines.join('\n');
}
