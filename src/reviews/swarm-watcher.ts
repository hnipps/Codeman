/**
 * @fileoverview The branch-tip watcher that starts pr-swarm runs when a review's code changes after it was submitted
 * (`intent/2026-11-20-pr-swarm-reviews.md`, ticket t4; the submit hook is in `review-routes.ts`).
 *
 * Each pass reads the tip of every OPEN review, at most `WATCH_CONCURRENCY` at a time, each read bounded by a
 * deadline. A tip that differs from the one last known is fed to the runner as the model's `tip` event, with I8's
 * answer from `classifyTipChange()` over the new commits, so a push during a run joins that run (I2) and the run's own
 * trailer commits never queue another (I8).
 *
 * The tip last known is, in order: what this watcher read last, the newest tip the review's runs recorded, and the
 * head the review was submitted at. A tip the newest run already recorded or reviewed is not a move. So a restart
 * notices a push made while Codeman was down, and the fix a run pushed and then reviewed starts nothing after the run.
 *
 * It never syncs a work review and never runs on the review-sync timer. Only the live colour reads anything (rule 6).
 * A review whose repository fails the git checks (a remote or Docker case) is not read, and the reason is kept for the
 * page (`refusalOf`), in memory: nothing is added to the review file (rule 5).
 */
import { mapLimited } from '../git-workspace-status.js';
import { SHA } from './review-git.js';
import { isOpen, type Review } from './review-model.js';
import { activeRun, classifyTipChange, type SwarmFile, type SwarmRun, type TipChange } from './swarm-model.js';
import type { SwarmTipResult } from './swarm-runner.js';

export const WATCH_CONCURRENCY = 2;

/** Reads a review's branch for the watcher. Every git call must end by `deadline` (ms since the epoch). */
export interface TipReader {
  /** The branch tip now, or null when it cannot be read. */
  tip(review: Review, deadline: number): Promise<string | null>;
  /** The messages of the commits in `from..to`, or null when they cannot be listed. */
  commits(review: Review, from: string, to: string, deadline: number): Promise<readonly { message: string }[] | null>;
}

export interface SwarmWatcherDeps {
  /** The live deploy colour (rule 6). */
  mayAct(): boolean;
  reviews(): Review[];
  /** The review's run file, or null when it cannot be read. */
  runs(reviewId: string): SwarmFile | null;
  /** Why git must not run for this review (a remote or Docker case), or null. The runner's own check. */
  refusal(review: Review): Promise<string | null>;
  reader: TipReader;
  /** The runner's `tipMoved`. */
  feed(reviewId: string, tip: string, change: TipChange): Promise<SwarmTipResult>;
  log(line: string): void;
  /** One review's read, every git call in it together. The reader kills what is still running then. */
  readTimeoutMs: number;
  /** A review's look still going after this is given up, past the reader's own kill. Default: 5 s past the read's. */
  giveUpMs?: number;
  now?: () => number;
}

export interface SwarmWatcher {
  /** One look at every open review. A pass still going when the next is due makes the next one do nothing. */
  pass(): Promise<void>;
  /** Why the last pass did not read this review's branch, or null. */
  refusalOf(reviewId: string): string | null;
  /** No read or run starts after this, including from a pass already going. */
  stop(): void;
}

/** The tips a run recorded, freshest first. */
function runTips(run: SwarmRun | undefined): string[] {
  if (!run) return [];
  switch (run.state) {
    case 'failed':
      return [];
    case 'queued':
      return [run.tip];
    case 'running':
      return run.pendingTip ? [run.pendingTip, run.roundTip] : [run.roundTip];
    case 'incomplete':
      return [run.branchTip, run.reviewedTip];
    default:
      return [run.reviewedTip];
  }
}

export type TipMove = { kind: 'none' } | { kind: 'moved'; from: string; runActive: boolean };

/** Whether `tip` is new for this review, and since which tip. */
export function tipMove(tip: string, review: Review, file: SwarmFile, lastSeen: string | undefined): TipMove {
  const from = lastSeen ?? file.runs.map(runTips).find((tips) => tips.length)?.[0] ?? review.headSha;
  if (tip === from || runTips(file.runs[0]).includes(tip)) return { kind: 'none' };
  return { kind: 'moved', from, runActive: activeRun(file) !== undefined };
}

export function createSwarmWatcher(deps: SwarmWatcherDeps): SwarmWatcher {
  const now = deps.now ?? Date.now;
  /** The tip each open review was last read at. */
  const seen = new Map<string, string>();
  const refusals = new Map<string, string>();
  let stopped = false;
  let passing = false;

  const watchOne = async (review: Review, alive: () => boolean): Promise<void> => {
    const refused = await deps.refusal(review);
    if (refused) {
      refusals.set(review.id, refused);
      return;
    }
    refusals.delete(review.id);
    if (!alive()) return;
    const deadline = now() + deps.readTimeoutMs;
    const tip = await deps.reader.tip(review, deadline);
    if (!tip || !SHA.test(tip) || !alive()) return;
    const file = deps.runs(review.id);
    if (!file) return;
    const move = tipMove(tip, review, file, seen.get(review.id));
    if (move.kind === 'none') {
      seen.set(review.id, tip);
      return;
    }
    // With no run going every move is a change, so the commits are only listed when a run could own them.
    const commits = move.runActive ? await deps.reader.commits(review, move.from, tip, deadline) : [];
    if (!alive()) return;
    const fed = await deps.feed(review.id, tip, classifyTipChange(commits ?? [], move.runActive));
    if (fed.ok) seen.set(review.id, tip);
    else if (fed.code === 'REFUSED') refusals.set(review.id, fed.message);
    else if (fed.code !== 'NOT_LIVE' && fed.code !== 'DECIDED' && fed.code !== 'NOT_FOUND')
      deps.log(`[pr-swarm] the new tip of review ${review.id} was not recorded: ${fed.code}: ${fed.message}`);
  };

  /** One review's read under its deadline. Given up, its slot frees and nothing it finds afterwards is used. */
  const watchBounded = async (review: Review): Promise<void> => {
    let late = false;
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<void>((done) => {
      timer = setTimeout(
        () => {
          late = true;
          done();
        },
        deps.giveUpMs ?? deps.readTimeoutMs + 5_000
      );
    });
    const alive = () => !late && !stopped && deps.mayAct();
    try {
      await Promise.race([
        watchOne(review, alive).catch((err: unknown) =>
          deps.log(
            `[pr-swarm] the tip of review ${review.id} could not be read: ${err instanceof Error ? err.message : String(err)}`
          )
        ),
        expired,
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async pass() {
      if (stopped || passing || !deps.mayAct()) return;
      passing = true;
      try {
        const open = deps.reviews().filter(isOpen);
        const ids = new Set(open.map((r) => r.id));
        for (const map of [seen, refusals]) for (const id of [...map.keys()]) if (!ids.has(id)) map.delete(id);
        await mapLimited(open, WATCH_CONCURRENCY, watchBounded);
      } finally {
        passing = false;
      }
    },
    refusalOf: (reviewId) => refusals.get(reviewId) ?? null,
    stop() {
      stopped = true;
    },
  };
}
