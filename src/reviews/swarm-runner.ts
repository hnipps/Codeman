/**
 * @fileoverview Starts and finishes pr-swarm runs on reviews (`intent/2026-11-20-pr-swarm-reviews.md`, ticket t3).
 *
 * One run at a time, server-wide (D3): a FIFO of queued runs and one slot. A run gets a detached worktree at the tip
 * it reviews, and one Claude session there, started through the server's ordinary create routes, with the GitHub
 * tokens blank and gh pointed at an empty config (I3). The session is told to run the plugin in Codeman-local mode and
 * to hand its result back with `codeman agent swarm report <runId> --file <json>`; only that session may report.
 *
 * Every change to a run goes through `applySwarmEvent()` (`swarm-model.ts`), and this module only carries out the
 * actions it returns: `enqueue`, `round` (the same session reviews the new tip, I2) and `stop` (the session and the
 * worktree go), `send` (the verdict prompt goes to the agent once, I5), `escalate` (the review's open work items go to
 * Human required, or a notification goes out, I6) and `consider-approve` (every fact is read again and, when
 * `decideAutoApprove()` allows it, the Approve button's own function runs, I4). A session that ends, or stays silent
 * for 30 minutes, ends its run `failed`.
 *
 * A person clears an escalation (`clear()`): Request changes, Approve and Close call it, the Run button's trigger does
 * it in the model, and the minute tick clears one whose work items have all left Human required.
 *
 * Rule 6: only the live deploy colour starts runs, writes run state or takes reports. The slot lives in memory, so a
 * colour that becomes live calls `recover()`: queued runs go back in the queue, a running run whose session is still
 * alive is adopted, and any other running run ends `failed`.
 */
import { SHA } from './review-git.js';
import { isOpen, MAX_NOTE_CHARS, type Review } from './review-model.js';
import {
  activeRun,
  applySwarmEvent,
  decideAutoApprove,
  parseSwarmReport,
  swarmEscalationNote,
  swarmVerdictPrompt,
  type FlaggedRun,
  type SwarmEscalation,
  R3_TRIGGERS,
  type R3Trigger,
  type SwarmAction,
  type SwarmEvent,
  type SwarmFile,
  type SwarmReport,
  type SwarmRun,
  type SwarmTrigger,
  type TipChange,
} from './swarm-model.js';
import { changeSwarm, readSwarm, type SwarmRead } from './swarm-store.js';
import type { PushRemote, R3Plan, ReviewOnlyReason, RunPlan, RunSpec, RunTip } from './swarm-git.js';

/** A run whose session has written nothing and reported nothing for this long has failed. */
export const SILENCE_LIMIT_MS = 30 * 60_000;
export const SWARM_TICK_MS = 60_000;
/** After a final report, the session is left this long, so the report command can print its answer. */
export const FINISH_GRACE_MS = 5_000;
/** After a report asks for another round, the session is given this long to end its turn first. */
export const ROUND_DELAY_MS = 5_000;
const ROUND_SEND_ATTEMPTS = 3;
/** A start or a stop still going after this long is given up, so one hung call cannot hold the slot for ever. */
export const SLOT_STUCK_MS = 15 * 60_000;

/**
 * The run session's own environment (I3). The tokens are blank, and gh reads an empty config folder, because a gh
 * signed in through its own config file would otherwise still write with blank tokens.
 */
export const runSessionEnv = (ghConfigDir: string): Record<string, string> => ({
  GH_TOKEN: '',
  GITHUB_TOKEN: '',
  GH_CONFIG_DIR: ghConfigDir,
});

export type BriefInput = {
  runId: string;
  title: string;
  branch: string;
  tip: string;
  remote: PushRemote;
  plan: Pick<RunPlan, 'base' | 'reviewOnly'>;
  /** The plugin's skills folder, for a session where the slash command is missing or older than `--local`. */
  skillsDir: string;
  /** For a run whose R-3 step can run: the spec file it reads and poteto-mode's SKILL.md. */
  r3?: { spec: string; potetoSkill: string };
};

/**
 * Whether a run's report must carry an R-3 result (I9). `unavailable` says why the run was not given what R-3 needs;
 * then an R-3 result the session reports anyway is not believed, since no step was given the spec to check against.
 * `unknown` is a run adopted after a restart, whose brief may or may not have carried the flags: its reported result
 * stands, and a missing one reads as `unavailable` with that reason.
 */
export type R3Need =
  | { required: false }
  | { required: true }
  | { required: true; unavailable: string }
  | { required: true; unknown: string };

/**
 * What a run does about R-3, from the attribution read at start and the run's plan. R-3 runs only inside
 * `/review-triage`, so a review-only run of attributed work cannot give it and its result is `unavailable`.
 */
export function planR3(plan: R3Plan, reviewOnly: ReviewOnlyReason | null): { need: R3Need; spec?: RunSpec } {
  if (!plan.required || reviewOnly === 'spec') return { need: { required: false } };
  if (reviewOnly === 'checked-out')
    return {
      need: {
        required: true,
        unavailable: 'The branch is checked out in another folder, so the run could only review it and R-3 did not run',
      },
    };
  if (!plan.spec) return { need: { required: true, unavailable: plan.missing } };
  return { need: { required: true }, spec: plan.spec };
}

/** The report as the model may read it: an R-3 result from a run that was not given R-3's inputs is dropped. */
function given(report: SwarmReport, need: R3Need): SwarmReport {
  if (!('unavailable' in need) || !report.r3) return report;
  const { r3: _, ...rest } = report;
  return rest;
}

const reportFile = (runId: string): string => `/tmp/pr-swarm-${runId}.json`;

/** The command the session runs for round 1. A spec review, or a branch no fix can be pushed to, gets the review half. */
export function swarmCommand(i: BriefInput): string {
  const shared = ['--local', `--base ${i.plan.base}`, `--head-sha ${i.tip}`];
  if (i.plan.reviewOnly) return ['/pr-swarm', ...shared, '--round 1'].join(' ');
  return [
    '/review-triage',
    ...shared,
    `--push-ref HEAD:refs/heads/${i.branch}`,
    ...(i.remote === '.' ? ['--push-remote .'] : []),
    ...(i.r3 ? [`--spec ${i.r3.spec}`, `--poteto-skill ${i.r3.potetoSkill}`] : []),
  ].join(' ');
}

/** The one prompt a run's session starts with. */
export function swarmBrief(i: BriefInput): string {
  const skill = i.plan.reviewOnly ? 'pr-swarm' : 'review-triage';
  const file = reportFile(i.runId);
  const why =
    i.plan.reviewOnly === 'spec'
      ? 'This is a spec review: review it only. Do not edit, commit or push anything.'
      : i.plan.reviewOnly === 'checked-out'
        ? 'This branch is checked out in another folder, so no fix could be pushed to it: review it only. Do not edit, commit or push anything.'
        : `Fix what the triage may fix. Its commits carry the trailer it adds, and it pushes them to ${i.branch} as the command says.`;
  return [
    `You are pr-swarm run ${i.runId} for the Codeman review "${i.title}" (branch ${i.branch}).`,
    `This folder is a detached checkout of ${i.tip}. Work only in this folder. You run unattended: never ask a question.`,
    '',
    'Run this command:',
    '',
    `    ${swarmCommand(i)}`,
    '',
    why,
    '',
    'Rules:',
    '- Codeman-local mode. Nothing is written to GitHub: no comments, reviews, approvals, merges or pull requests, and no gh command at all. The GitHub tokens in this session are blank on purpose.',
    `- If the slash command is not available, or does not know --local, read ${i.skillsDir}/${skill}/SKILL.md and follow it with the same arguments.`,
    '',
    'When it has finished:',
    `1. Save its output, or just the JSON block it printed last, to ${file}. Never save it inside this folder.`,
    `2. Run: codeman agent swarm report ${i.runId} --file ${file}`,
    '3. If that answers that this server is not live, or cannot be reached, wait 30 seconds and run it again, at most 10 times.',
    '4. Then end your turn. When the answer says another round follows, its instructions arrive as your next prompt.',
  ].join('\n');
}

/** The prompt that asks the same session to review the branch's new tip (I2). */
export function swarmRoundPrompt(i: { runId: string; round: number; tip: string }): string {
  const file = reportFile(i.runId);
  return [
    `pr-swarm run ${i.runId}, round ${i.round}: the branch moved to ${i.tip} while you reviewed it.`,
    `1. If this repository has an origin, run: git fetch --quiet origin. Then run: git checkout --detach ${i.tip}`,
    `2. Run the same command as before, with --head-sha ${i.tip} (and --round ${i.round} for /pr-swarm).`,
    `3. Save its JSON result to ${file} and run: codeman agent swarm report ${i.runId} --file ${file}`,
    '4. Then end your turn.',
  ].join('\n');
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** `/review-triage`'s trigger ids that name one of the lifecycle's under another id. */
const R3_TRIGGER_ALIASES: Record<string, R3Trigger> = { 'undescribed-change': 'unspecified-visible-change' };

/**
 * `/review-triage`'s `r3` block (pr-swarm 0.5.0, Step 5b) as the model reads it. Findings (`ref`, `location`, `body`,
 * `deferred`) and deviations (`ref`, `what`, `why`) become one line each (cut to the note cap, so a long one cannot refuse the whole report), and a `null` tip or reason is left
 * out. An
 * escalation whose trigger the lifecycle's list does not hold becomes `unavailable` naming it, so the pr-swarm result
 * still lands and nothing it would gate merges. Anything else passes through for the model to judge.
 */
export function r3Input(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const line = (parts: string[]): string => parts.filter(Boolean).join(' ').slice(0, MAX_NOTE_CHARS);
  const finding = (f: unknown): unknown => {
    if (!isRecord(f)) return f;
    const where = text(f.location) && text(f.location) !== 'general' ? `(${text(f.location)})` : '';
    return line([text(f.ref) ? `${text(f.ref)}:` : '', text(f.body), where, f.deferred === true ? '[deferred]' : '']);
  };
  const deviation = (d: unknown): unknown =>
    isRecord(d)
      ? line([
          text(d.ref) ? `${text(d.ref)}:` : '',
          text(d.what),
          text(d.why) ? `Why it still holds: ${text(d.why)}` : '',
        ])
      : d;
  const out: Record<string, unknown> = { verdict: raw.verdict };
  if (Array.isArray(raw.findings)) out.findings = raw.findings.map(finding);
  if (Array.isArray(raw.deviations)) out.deviations = raw.deviations.map(deviation);
  if (raw.tip !== null && raw.tip !== undefined) out.tip = raw.tip;
  if (raw.reason !== null && raw.reason !== undefined) out.reason = raw.reason;
  if (raw.verdict === 'escalate') {
    const id = text(raw.trigger);
    const trigger = (R3_TRIGGERS as readonly string[]).includes(id)
      ? (id as R3Trigger)
      : Object.hasOwn(R3_TRIGGER_ALIASES, id)
        ? R3_TRIGGER_ALIASES[id]
        : undefined;
    if (!trigger)
      return {
        verdict: 'unavailable',
        reason: `R-3 escalated with a trigger Codeman does not know: ${id.slice(0, 200) || 'none'}`,
      };
    out.trigger = trigger;
  }
  return out;
}

/**
 * Turns what the session reports into pr-swarm's return contract. pr-swarm's own result passes through. A
 * `/review-triage --local` result carries the last pr-swarm result in `pr_swarm_result`: its pushed fix commits and
 * deferred units become `triage`, and the round is the run's, since the triage counts its own rounds inside one call.
 */
export function reportInput(json: unknown, round: number): unknown {
  if (!isRecord(json) || !isRecord(json.pr_swarm_result)) return json;
  const commits = Array.isArray(json.commits) ? json.commits.filter(isRecord) : [];
  const units = Array.isArray(json.dispositions) ? json.dispositions.filter(isRecord) : [];
  return {
    ...json.pr_swarm_result,
    round,
    triage: {
      fix_commits: commits.filter((c) => c.pushed !== false && SHA.test(text(c.sha))).map((c) => c.sha as string),
      deferred: units
        .filter((u) => u.bucket === 'deferred')
        .map((u) => ({
          location: text(u.location) || text(u.id) || 'general',
          reason: text(u.reason) || text(u.gate) || 'deferred',
        })),
    },
    ...(json.r3 !== undefined ? { r3: r3Input(json.r3) } : {}),
  };
}

export type SessionLiveness = { state: 'live'; lastActivityAt: number } | { state: 'gone' };

/** Everything the runner does to the world. The server wires the real ones; tests pass fakes. */
export interface SwarmRunnerDeps {
  /** The live deploy colour (rule 6). */
  mayAct(): boolean;
  /** The server's sessions are restored, so a run's session can be judged alive or gone. */
  restored(): boolean;
  now(): number;
  newRunId(): string;
  reviews(): Review[];
  review(id: string): Review | null;
  /** Why git must not run for this review (a remote or Docker case), or null. */
  refusal(review: Review): Promise<string | null>;
  tip(review: Review): Promise<RunTip | null>;
  /** Whether a run of this review at `tip` must give an R-3 result, and the spec it reads (I9). */
  r3Plan(review: Review, tip: string): Promise<R3Plan>;
  /** Writes the run's copy of its spec outside the worktree; its path, or null when it could not be written. */
  stageSpec(review: Review, runId: string, spec: RunSpec): Promise<string | null>;
  prepare(
    review: Review,
    runId: string,
    tip: RunTip
  ): Promise<{ ok: true; plan: RunPlan } | { ok: false; reason: string }>;
  removeWorktree(review: Review, runId: string): Promise<void>;
  startSession(
    review: Review,
    request: { workingDir: string; name: string; internalEnv: Record<string, string> }
  ): Promise<{ ok: true; sessionId: string } | { ok: false; message: string }>;
  /** Pastes a prompt into the session and submits it; false when it never reached the pane. */
  send(sessionId: string, text: string): Promise<boolean>;
  session(sessionId: string): SessionLiveness;
  stopSession(review: Review, sessionId: string): Promise<void>;
  announce(review: Review): void;
  /**
   * Carries a non-approve verdict to the agent (I5): pasted into the author session of a session review, put on the
   * item of a work review. Never retried here; a failure is recorded and a person may send again.
   */
  deliverVerdict(review: Review, run: FlaggedRun, text: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Escalates to the owner (I6): each open work item of the review moves to Human required with `note` as a comment,
   * or a notification carries `note` when it has none (or none could be moved). Answers a line for the log.
   */
  escalate(review: Review, run: FlaggedRun, note: string): Promise<string>;
  /**
   * Whether the review's escalation still waits in a work item: true while one of its open items is in Human
   * required, false once all have left it, null when the review has no open item to wait in.
   */
  escalationHeld(review: Review): boolean | null;
  /** The Approve button's own function, for a run whose automatic Approve `decideAutoApprove()` allowed (I4). */
  approve(
    review: Review,
    run: Extract<SwarmRun, { state: 'passed' }>,
    tip: string
  ): Promise<{ ok: true } | { ok: false; message: string }>;
  log(line: string): void;
  later(ms: number, fn: () => void): void;
  skillsDir: string;
  /** poteto-mode's SKILL.md, which R-3 reads. Passed even when it is missing: the step then reports `unavailable`. */
  potetoSkill: string;
  ghConfigDir: string;
}

type QueueEntry = { reviewId: string; runId: string };
/** The server-wide slot. `starting` and `stopping` hold it too, so a run's setup and cleanup never overlap another run. */
type Slot =
  | { kind: 'idle' }
  | ({ kind: 'starting'; since: number } & QueueEntry)
  | ({ kind: 'running'; sessionId: string; heardAt: number; r3: R3Need; lastReport?: string } & QueueEntry)
  | ({ kind: 'stopping'; since: number } & QueueEntry);

export type SwarmTriggerResult =
  | { ok: true; joined: boolean; run: SwarmRun }
  | { ok: false; code: 'NOT_LIVE' | 'NOT_FOUND' | 'DECIDED' | 'REFUSED' | 'BAD_TIP' | 'FILE'; message: string };

type TriggerRefusal = Extract<SwarmTriggerResult, { ok: false }>;
export type SwarmTipResult = { ok: true; run: SwarmRun | null } | TriggerRefusal;

export type SwarmResendResult =
  | { ok: true; run: SwarmRun }
  | {
      ok: false;
      code: 'NOT_LIVE' | 'NOT_FOUND' | 'NOTHING_TO_SEND' | 'ESCALATED' | 'SENDING' | 'FILE';
      message: string;
    };

export type SwarmReportResult =
  | { ok: true; state: SwarmRun['state']; round?: number; tip?: string; duplicate?: true }
  | {
      ok: false;
      code: 'NOT_LIVE' | 'NOT_RUNNING' | 'FORBIDDEN' | 'INVALID' | 'REFUSED' | 'TIP_UNREADABLE' | 'FILE';
      message: string;
    };

export interface SwarmRunner {
  /**
   * The one entry point for a run: a submit, a push the watcher saw, or a person's button. `tip` is the branch tip at
   * that moment. A review with a run queued or running joins it (I1) and the tip is recorded on it (I2).
   */
  trigger(reviewId: string, source: SwarmTrigger, tip: string): Promise<SwarmTriggerResult>;
  /**
   * The tip watcher saw the branch move to `tip`; `change` is `classifyTipChange()`'s answer (I8). A running run records
   * the tip (I2), a `change` with no run going queues one, and the run's own commits with no run going queue nothing.
   * `run` is the run the tip went to, or null when it went to none.
   */
  tipMoved(reviewId: string, tip: string, change: TipChange): Promise<SwarmTipResult>;
  /** A run's session hands back its result. Only the run's own session may (`callerSessionId`). */
  report(runId: string, callerSessionId: string, json: unknown): Promise<SwarmReportResult>;
  /** A review's runs, read only. */
  view(reviewId: string): SwarmRead;
  /** A person sends the newest run's verdict again after its delivery failed (I5's Send again). */
  resend(reviewId: string): Promise<SwarmResendResult>;
  /** A person acted on the review (notes sent, approved, closed): the escalation and the streak are cleared (I6). */
  clear(reviewId: string): void;
  /** The tip a run of this review would review now; null when it cannot be read or git may not run there. */
  tipOf(review: Review): Promise<RunTip | null>;
  /**
   * Rebuilds the slot and the queue from the run files. `tick()` calls it the first time it finds this colour live
   * with its sessions restored, and again whenever the colour has just become live. Until then nothing starts.
   */
  recover(): Promise<void>;
  /** The minute check: recovery when due, a dead or silent session fails its run, and the queue moves. */
  tick(): Promise<void>;
}

export function createSwarmRunner(deps: SwarmRunnerDeps): SwarmRunner {
  let slot: Slot = { kind: 'idle' };
  const queue: QueueEntry[] = [];
  let ready = false;
  let wasLive = false;
  let pumping = false;
  /** Bumped when a hung start is given up, so its loop stops and a new one may run. */
  let pumpGeneration = 0;

  /** One event, written in one tick, then its actions carried out. */
  const apply = (
    reviewId: string,
    event: SwarmEvent
  ): { ok: true; file: SwarmFile } | { ok: false; message: string } => {
    let step: ReturnType<typeof changeSwarm<{ file: SwarmFile; actions: SwarmAction[] }>>;
    try {
      step = changeSwarm(reviewId, (file) => applySwarmEvent(file, event, deps.now()));
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'The run file could not be written' };
    }
    if (!step.ok) return { ok: false, message: `The run file is ${step.reason}` };
    const review = deps.review(reviewId);
    if (review) deps.announce(review);
    for (const action of step.actions) carryOut(reviewId, action);
    return { ok: true, file: step.file };
  };

  const carryOut = (reviewId: string, action: SwarmAction): void => {
    switch (action.kind) {
      case 'enqueue':
        if (!queue.some((q) => q.runId === action.runId)) queue.push({ reviewId, runId: action.runId });
        void pump();
        return;
      case 'round':
        sendRound(reviewId, action.runId, action.round, action.tip);
        return;
      case 'stop':
        stopRun(reviewId, action.runId);
        return;
      case 'send':
        void sendVerdict(reviewId, action.runId);
        return;
      case 'escalate':
        void escalate(reviewId, action.runId, action.escalation);
        return;
      case 'consider-approve':
        void considerApprove(reviewId, action.runId);
        return;
    }
  };

  /** Runs whose verdict is being delivered, so one delivery is never started twice (I5). */
  const sending = new Set<string>();
  /** Reviews whose escalation is being written, so the tick does not clear it before the items have moved. */
  const escalating = new Set<string>();

  const flaggedRun = (reviewId: string, runId: string): { review: Review; run: FlaggedRun } | null => {
    const review = deps.review(reviewId);
    const read = readSwarm(reviewId);
    const run = read.ok ? read.file.runs.find((r) => r.id === runId) : undefined;
    return review && run && (run.state === 'changes' || run.state === 'blocked') ? { review, run } : null;
  };

  const sendVerdict = async (reviewId: string, runId: string): Promise<SwarmResendResult> => {
    const found = flaggedRun(reviewId, runId);
    if (!found?.run.send) return { ok: false, code: 'NOTHING_TO_SEND', message: 'That run has no verdict to send' };
    if (sending.has(runId)) return { ok: false, code: 'SENDING', message: 'The verdict is being sent' };
    sending.add(runId);
    try {
      let outcome: { ok: true } | { ok: false; reason: string };
      try {
        outcome = await deps.deliverVerdict(found.review, found.run, swarmVerdictPrompt(found.review, found.run));
      } catch (err) {
        outcome = { ok: false, reason: err instanceof Error ? err.message : 'The verdict could not be delivered' };
      }
      const done = apply(
        reviewId,
        outcome.ok ? { type: 'sent', runId, ok: true } : { type: 'sent', runId, ok: false, reason: outcome.reason }
      );
      if (!done.ok) return { ok: false, code: 'FILE', message: done.message };
      if (!outcome.ok)
        deps.log(`[pr-swarm] review ${reviewId} run ${runId}: the verdict was not sent: ${outcome.reason}`);
      const run = done.file.runs.find((r) => r.id === runId);
      return run ? { ok: true, run } : { ok: false, code: 'FILE', message: 'The run is no longer recorded' };
    } finally {
      sending.delete(runId);
    }
  };

  const escalate = async (reviewId: string, runId: string, escalation: SwarmEscalation): Promise<void> => {
    const found = flaggedRun(reviewId, runId);
    const read = readSwarm(reviewId);
    if (!found || !read.ok) {
      deps.log(`[pr-swarm] review ${reviewId} run ${runId}: escalated, but the review or its run could not be read`);
      return;
    }
    escalating.add(reviewId);
    try {
      const note = swarmEscalationNote(found.review, read.file, escalation);
      const line = await deps.escalate(found.review, found.run, note);
      deps.log(`[pr-swarm] review ${reviewId} run ${runId}: escalated: ${line}`);
    } catch (err) {
      deps.log(
        `[pr-swarm] review ${reviewId} run ${runId}: escalated, but it could not be written: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      escalating.delete(reviewId);
    }
  };

  /** I4: every fact is read again now; only `decideAutoApprove()`'s yes runs the Approve button's function. */
  const considerApprove = async (reviewId: string, runId: string): Promise<void> => {
    const say = (text: string) => deps.log(`[pr-swarm] review ${reviewId} run ${runId}: no automatic Approve: ${text}`);
    try {
      if (!deps.mayAct()) return say('this colour is not live');
      const review = deps.review(reviewId);
      const read = readSwarm(reviewId);
      const run = read.ok ? read.file.runs.find((r) => r.id === runId) : undefined;
      if (!review || !read.ok || !run) return say('the review or its run could not be read');
      const refused = await deps.refusal(review);
      if (refused) return say(refused);
      const tip = await deps.tip(review);
      if (!tip) return say('the branch tip could not be read');
      const plan = await deps.r3Plan(review, tip.sha);
      const decision = decideAutoApprove({
        run,
        // The plan needs R-3 exactly when the review is non-spec work attributed to an approved spec.
        specReview: false,
        attributed: plan.required,
        reviewOpen: isOpen(review),
        escalated: read.file.escalated !== null,
        branchTip: tip.sha,
      });
      if (!decision.approve) return say(decision.refusal);
      if (run.state !== 'passed') return say('NOT_APPROVED');
      const approved = await deps.approve(review, run, decision.tip);
      if (!approved.ok) return say(approved.message);
      deps.log(`[pr-swarm] review ${reviewId} run ${runId}: approved automatically at ${decision.tip.slice(0, 12)}`);
    } catch (err) {
      say(err instanceof Error ? err.message : String(err));
    }
  };

  /** The tick's clear: an escalation whose work items have all left Human required was answered by a person. */
  const clearAnswered = (): void => {
    for (const review of deps.reviews()) {
      if (!isOpen(review) || escalating.has(review.id)) continue;
      const read = readSwarm(review.id);
      if (!read.ok || !read.file.escalated) continue;
      if (deps.escalationHeld(review) === false) apply(review.id, { type: 'clear' });
    }
  };

  const failRun = (reviewId: string, runId: string, reason: string): void => {
    const done = apply(reviewId, { type: 'failed', runId, reason });
    if (!done.ok) deps.log(`[pr-swarm] review ${reviewId} run ${runId} could not be marked failed: ${done.message}`);
  };

  /** Ends the slot's run: the session after a grace, then the worktree, then the next run. */
  const stopRun = (reviewId: string, runId: string): void => {
    if (slot.kind !== 'running' || slot.runId !== runId) {
      const review = deps.review(reviewId);
      if (review) void deps.removeWorktree(review, runId).catch(() => undefined);
      return;
    }
    const { sessionId } = slot;
    slot = { kind: 'stopping', reviewId, runId, since: deps.now() };
    deps.later(FINISH_GRACE_MS, () => {
      void (async () => {
        const review = deps.review(reviewId);
        if (review) {
          await deps.stopSession(review, sessionId).catch(() => undefined);
          await deps.removeWorktree(review, runId).catch(() => undefined);
        }
      })().finally(() => {
        if (slot.kind === 'stopping' && slot.runId === runId) slot = { kind: 'idle' };
        void pump();
      });
    });
  };

  const sendRound = (reviewId: string, runId: string, round: number, tip: string): void => {
    const current = () => slot.kind === 'running' && slot.runId === runId;
    if (!current() || slot.kind !== 'running') return;
    const { sessionId } = slot;
    deps.later(ROUND_DELAY_MS, () => {
      void (async () => {
        for (let attempt = 0; attempt < ROUND_SEND_ATTEMPTS; attempt++) {
          if (!current() || !deps.mayAct()) return;
          if (await deps.send(sessionId, swarmRoundPrompt({ runId, round, tip }))) return;
        }
        if (current() && deps.mayAct())
          failRun(reviewId, runId, `Round ${round} could not be sent to the run's session`);
      })();
    });
  };

  /** A plan that cannot be read fails closed: R-3 is required and `unavailable`, so nothing it would gate merges. */
  const readR3Plan = (review: Review, tip: string): Promise<R3Plan> =>
    deps
      .r3Plan(review, tip)
      .catch(() => ({ required: true, spec: null, missing: 'Whether this work answers to a spec could not be read' }));

  const start = async ({ reviewId, runId }: QueueEntry): Promise<void> => {
    const read = readSwarm(reviewId);
    const active = read.ok ? activeRun(read.file) : undefined;
    if (active?.id !== runId || active.state !== 'queued') return;
    const fail = (reason: string) => failRun(reviewId, runId, reason);
    const review = deps.review(reviewId);
    if (!review || !isOpen(review)) return fail('The review was decided or removed before the run started');
    const refusal = await deps.refusal(review);
    if (refusal) return fail(refusal);
    const tip = await deps.tip(review);
    if (!tip) return fail('The branch tip could not be read');
    // A start this process died in the middle of may have left the worktree; the name is the run's own.
    await deps.removeWorktree(review, runId).catch(() => undefined);
    const prepared = await deps.prepare(review, runId, tip);
    if (!prepared.ok) return fail(prepared.reason);
    const r3 = planR3(await readR3Plan(review, tip.sha), prepared.plan.reviewOnly);
    let need = r3.need;
    let specFile: string | null = null;
    if (r3.spec) {
      specFile = await deps.stageSpec(review, runId, r3.spec).catch(() => null);
      if (!specFile) need = { required: true, unavailable: "The run's copy of the spec could not be written" };
    }
    const started = await deps
      .startSession(review, {
        workingDir: prepared.plan.workingDir,
        name: `pr-swarm · ${review.title}`.slice(0, 100),
        internalEnv: runSessionEnv(deps.ghConfigDir),
      })
      .catch(() => ({ ok: false as const, message: 'the session could not be started' }));
    if (!started.ok) {
      await deps.removeWorktree(review, runId).catch(() => undefined);
      return fail(`The run's session could not be started: ${started.message}`);
    }
    const marked = apply(reviewId, { type: 'started', runId, sessionId: started.sessionId, tip: tip.sha });
    const now = marked.ok ? activeRun(marked.file) : undefined;
    if (now?.id !== runId || now.state !== 'running' || now.sessionId !== started.sessionId) {
      await deps.stopSession(review, started.sessionId).catch(() => undefined);
      await deps.removeWorktree(review, runId).catch(() => undefined);
      return;
    }
    slot = { kind: 'running', reviewId, runId, sessionId: started.sessionId, heardAt: deps.now(), r3: need };
    const brief = swarmBrief({
      runId,
      title: review.title,
      branch: review.branch,
      tip: tip.sha,
      remote: tip.remote,
      plan: prepared.plan,
      skillsDir: deps.skillsDir,
      ...(specFile ? { r3: { spec: specFile, potetoSkill: deps.potetoSkill } } : {}),
    });
    if (!(await deps.send(started.sessionId, brief)) && slot.kind === 'running' && slot.runId === runId)
      fail("The brief could not be sent to the run's session");
  };

  const pump = async (): Promise<void> => {
    if (pumping || !ready) return;
    pumping = true;
    const generation = pumpGeneration;
    try {
      while (generation === pumpGeneration && slot.kind === 'idle' && queue.length && deps.mayAct()) {
        const entry = queue.shift()!;
        slot = { kind: 'starting', ...entry, since: deps.now() };
        try {
          await start(entry);
        } catch (err) {
          deps.log(`[pr-swarm] run ${entry.runId} did not start: ${err instanceof Error ? err.message : String(err)}`);
          failRun(entry.reviewId, entry.runId, 'The run could not be started');
        } finally {
          if (slot.kind === 'starting' && slot.runId === entry.runId) slot = { kind: 'idle' };
        }
      }
    } finally {
      if (generation === pumpGeneration) pumping = false;
    }
  };

  async function recover(): Promise<void> {
    if (!deps.mayAct() || !deps.restored()) return;
    ready = true;
    wasLive = true;
    queue.length = 0;
    // A run this process was running is judged again from its file and its session, like any other.
    if (slot.kind === 'running') slot = { kind: 'idle' };
    const found: { review: Review; run: NonNullable<ReturnType<typeof activeRun>> }[] = [];
    for (const review of deps.reviews()) {
      const read = readSwarm(review.id);
      const run = read.ok ? activeRun(read.file) : undefined;
      if (run) found.push({ review, run });
    }
    found.sort((a, b) => a.run.requestedAt - b.run.requestedAt);
    for (const { review, run } of found) {
      if (run.state === 'queued') {
        if (!queue.some((q) => q.runId === run.id)) queue.push({ reviewId: review.id, runId: run.id });
        continue;
      }
      if (slot.kind !== 'idle' && slot.runId === run.id) continue;
      if (slot.kind === 'idle' && deps.session(run.sessionId).state === 'live') {
        const adopted: Extract<Slot, { kind: 'running' }> = {
          kind: 'running',
          reviewId: review.id,
          runId: run.id,
          sessionId: run.sessionId,
          heardAt: deps.now(),
          r3: { required: true, unknown: 'Whether this work answers to a spec was not read again after a restart' },
        };
        slot = adopted;
        // The plan is not stored, so it is read again, after the slot is taken so nothing else starts meanwhile.
        // Whether the brief carried the flags is not known here; a run not given them reports no R-3 result, which
        // reads as `unavailable`.
        if (!(await deps.refusal(review).catch(() => 'refused'))) {
          const plan = await readR3Plan(review, run.roundTip);
          adopted.r3 = !plan.required
            ? { required: false }
            : { required: true, unknown: plan.spec ? 'The run reported no R-3 result' : plan.missing };
        }
        continue;
      }
      // The session goes first, so the worktree the failed run's stop removes is no longer in use.
      await deps.stopSession(review, run.sessionId).catch(() => undefined);
      failRun(review.id, run.id, "The run's session did not survive a restart of Codeman");
    }
    void pump();
  }

  /** The checks every automatic or manual start makes, then one event applied: a trigger or a watched tip. */
  const startEvent = async (
    reviewId: string,
    tip: string,
    event: (runId: string) => SwarmEvent
  ): Promise<{ ok: true; joined: boolean; run: SwarmRun | undefined } | TriggerRefusal> => {
    if (!deps.mayAct()) return { ok: false, code: 'NOT_LIVE', message: 'Only the live colour starts pr-swarm runs' };
    if (!SHA.test(tip)) return { ok: false, code: 'BAD_TIP', message: 'The tip is not a commit id' };
    const review = deps.review(reviewId);
    if (!review) return { ok: false, code: 'NOT_FOUND', message: 'Review not found' };
    if (!isOpen(review)) return { ok: false, code: 'DECIDED', message: 'This review has been decided' };
    const refusal = await deps.refusal(review);
    if (refusal) return { ok: false, code: 'REFUSED', message: refusal };
    const before = readSwarm(reviewId);
    if (!before.ok) return { ok: false, code: 'FILE', message: `The run file is ${before.reason}` };
    const joined = activeRun(before.file) !== undefined;
    const done = apply(reviewId, event(deps.newRunId()));
    if (!done.ok) return { ok: false, code: 'FILE', message: done.message };
    return { ok: true, joined, run: activeRun(done.file) };
  };

  return {
    async trigger(reviewId, source, tip) {
      const done = await startEvent(reviewId, tip, (runId) => ({ type: 'trigger', trigger: source, tip, runId }));
      if (!done.ok) return done;
      if (!done.run) return { ok: false, code: 'FILE', message: 'The run was not recorded' };
      return { ok: true, joined: done.joined, run: done.run };
    },

    async tipMoved(reviewId, tip, change) {
      const done = await startEvent(reviewId, tip, (newRunId) => ({ type: 'tip', tip, change, newRunId }));
      return done.ok ? { ok: true, run: done.run ?? null } : done;
    },

    async report(runId, callerSessionId, json) {
      if (!deps.mayAct())
        return { ok: false, code: 'NOT_LIVE', message: 'This server is not the live colour; report again shortly' };
      const running = () => (slot.kind === 'running' && slot.runId === runId ? slot : undefined);
      const run = running();
      if (!run) return { ok: false, code: 'NOT_RUNNING', message: 'No running pr-swarm run has that id' };
      if (callerSessionId !== run.sessionId)
        return { ok: false, code: 'FORBIDDEN', message: "Only the run's own session may report it" };
      const stored = readSwarm(run.reviewId);
      const active = stored.ok ? activeRun(stored.file) : undefined;
      // The verb is told to retry when it hears nothing back, so a report the server already applied can arrive
      // again, after its round has moved on. The same result twice is answered, never counted a second time.
      const digest = JSON.stringify(json);
      if (digest === run.lastReport && active?.id === runId)
        return active.state === 'running'
          ? { ok: true, state: active.state, round: active.round, tip: active.roundTip, duplicate: true }
          : { ok: true, state: active.state, duplicate: true };
      const round = active?.state === 'running' ? active.round : 1;
      const parsed = parseSwarmReport(reportInput(json, round));
      if (!parsed.ok) return { ok: false, code: 'INVALID', message: parsed.error };
      const review = deps.review(run.reviewId);
      // The same refusal as a start, before git fetches anything for this review.
      const refused = review ? await deps.refusal(review) : 'The review is gone';
      if (refused) return { ok: false, code: 'REFUSED', message: refused };
      const tip = review ? await deps.tip(review) : null;
      if (!tip) return { ok: false, code: 'TIP_UNREADABLE', message: 'The branch tip could not be read; report again' };
      if (!running()) return { ok: false, code: 'NOT_RUNNING', message: 'The run ended while the report was read' };
      run.heardAt = deps.now();
      run.lastReport = digest;
      const done = apply(run.reviewId, {
        type: 'report',
        runId,
        report: given(parsed.report, run.r3),
        branchTip: tip.sha,
        r3Required: run.r3.required,
        ...('unavailable' in run.r3 ? { r3Unavailable: run.r3.unavailable } : {}),
        ...('unknown' in run.r3 ? { r3Unavailable: run.r3.unknown } : {}),
        newRunId: deps.newRunId(),
      });
      if (!done.ok) return { ok: false, code: 'FILE', message: done.message };
      const after = done.file.runs.find((r) => r.id === runId);
      if (!after) return { ok: false, code: 'FILE', message: 'The run is no longer recorded' };
      return after.state === 'running'
        ? { ok: true, state: after.state, round: after.round, tip: after.roundTip }
        : { ok: true, state: after.state };
    },

    view: (reviewId) => readSwarm(reviewId),

    async resend(reviewId) {
      if (!deps.mayAct())
        return { ok: false, code: 'NOT_LIVE', message: 'Only the live colour sends pr-swarm verdicts' };
      if (!deps.review(reviewId)) return { ok: false, code: 'NOT_FOUND', message: 'Review not found' };
      const read = readSwarm(reviewId);
      if (!read.ok) return { ok: false, code: 'FILE', message: `The run file is ${read.reason}` };
      // I6: while the review is escalated nothing goes to an agent, a person's press included.
      if (read.file.escalated)
        return { ok: false, code: 'ESCALATED', message: 'The review is escalated; send notes or approve instead' };
      const latest = read.file.runs[0];
      if (!latest || (latest.state !== 'changes' && latest.state !== 'blocked') || latest.send?.state !== 'failed')
        return { ok: false, code: 'NOTHING_TO_SEND', message: 'The newest run has no failed delivery to send again' };
      return sendVerdict(reviewId, latest.id);
    },

    clear(reviewId) {
      if (!deps.mayAct()) return;
      const read = readSwarm(reviewId);
      if (!read.ok || (!read.file.escalated && !read.file.streak)) return;
      const done = apply(reviewId, { type: 'clear' });
      if (!done.ok) deps.log(`[pr-swarm] review ${reviewId}: the escalation could not be cleared: ${done.message}`);
    },

    tipOf: async (review) => ((await deps.refusal(review)) ? null : deps.tip(review)),

    recover,

    async tick() {
      if (!deps.mayAct()) {
        wasLive = false;
        return;
      }
      if (!ready || !wasLive) return recover();
      if ((slot.kind === 'starting' || slot.kind === 'stopping') && deps.now() - slot.since >= SLOT_STUCK_MS) {
        const { kind, reviewId, runId } = slot;
        deps.log(
          `[pr-swarm] review ${reviewId} run ${runId}: the ${kind === 'starting' ? 'start' : 'stop'} hung; the slot is freed`
        );
        slot = { kind: 'idle' };
        pumpGeneration++;
        pumping = false;
        if (kind === 'starting') failRun(reviewId, runId, 'The run took too long to start');
      }
      if (slot.kind === 'running') {
        const { reviewId, runId, heardAt } = slot;
        const session = deps.session(slot.sessionId);
        if (session.state === 'gone') failRun(reviewId, runId, "The run's session ended before it reported");
        else if (deps.now() - Math.max(session.lastActivityAt, heardAt) >= SILENCE_LIMIT_MS)
          failRun(reviewId, runId, "The run's session was silent for 30 minutes");
      }
      clearAnswered();
      await pump();
    },
  };
}
