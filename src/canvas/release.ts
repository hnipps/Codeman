/**
 * @fileoverview A release the agent asked the deploy supervisor for, and how it went. Pure and read-only.
 *
 * A request is recognised in a shell command the agent ran (`codeman-deploy <sha>` or `codeman-deploy rollback
 * <target>`). Its outcome is the supervisor's own record when the recent runs still list it, else what the command
 * printed, and the view says which. Nothing here can start, queue or cancel a release.
 */

export type ReleaseAction = 'deploy' | 'rollback';
export type ReleaseRequest = { action: ReleaseAction; target: string };
/** What the deploy command wrote to its own output: the supervisor's deploy id and its closing `outcome:` line. */
export type ReleasePrinted = { deployId: string | null; outcome: string | null; failedStep: string | null };
/** One run as the supervisor's status reports it. */
export type ReleaseRecord = {
  id: string;
  action: string;
  sha: string | null;
  outcome: string;
  failedStep: string | null;
  startedAt: string;
  finishedAt: string | null;
};
export type ReleaseState = 'succeeded' | 'failed' | 'rejected' | 'running' | 'unknown';
export type ReleaseView = {
  toolId: string;
  action: ReleaseAction;
  /** Seven characters of the commit, when the record or the command names one. */
  sha: string | null;
  state: ReleaseState;
  failedStep: string | null;
  /** `supervisor` is its recorded run, `printed` is the command's own output, `none` is neither. */
  source: 'supervisor' | 'printed' | 'none';
  finishedAt: string | null;
};

const MAX_TARGET = 80;
/** The command name where a shell starts a command (after `;`, `&&`, `|`, `(` or a line break, past any `VAR=value`), so a mention inside a message or a search pattern asks for nothing. */
const COMMAND =
  /(?:^|[;&|(\n])[ \t]*(?:[A-Za-z_][A-Za-z0-9_]*=\S*[ \t]+)*codeman-deploy[ \t]+(rollback[ \t]+)?("[^"\n]*"|'[^'\n]*'|[^\s;&|)]+)/;
const HEX = /^[0-9a-f]{7,40}$/i;
/** A deploy started this long before the command was recorded is still its own: clocks and the write order differ. */
const SKEW_MS = 5_000;
/** Deploys queue behind one another, so a run may start well after it was asked for. */
const WINDOW_MS = 30 * 60_000;

/** The release a shell command asks for, or null. `status`, help and a flag ask for nothing. */
export function releaseRequest(command: string): ReleaseRequest | null {
  const found = COMMAND.exec(command);
  if (!found) return null;
  const target = found[2].replace(/^["']|["']$/g, '').slice(0, MAX_TARGET);
  if (!target || target.startsWith('-')) return null;
  if (found[1]) return { action: 'rollback', target };
  if (target === 'status' || target === 'help' || target === 'rollback') return null;
  return { action: 'deploy', target };
}

/** Reads the deploy id and the last `outcome:` line out of the command's whole output. */
export function printedOutcome(output: string): ReleasePrinted {
  const deployId = /^deploy (\S+); log /m.exec(output)?.[1] ?? null;
  let line: string | null = null;
  for (const found of output.matchAll(/^outcome: ([^\n]*)$/gm)) line = found[1];
  if (line === null) return { deployId: deployId?.slice(0, 80) ?? null, outcome: null, failedStep: null };
  const failed = /^failed at ([a-z-]+)/.exec(line);
  const outcome = /^[a-z]+/.exec(line)?.[0] ?? null;
  return { deployId: deployId?.slice(0, 80) ?? null, outcome, failedStep: failed ? failed[1] : null };
}

function stateOf(outcome: string | null, finished: boolean): ReleaseState {
  if (outcome === 'success') return 'succeeded';
  if (outcome === 'failed' || outcome === 'interrupted') return 'failed';
  if (outcome === 'rejected') return 'rejected';
  return finished ? 'unknown' : 'running';
}

const short = (sha: string | null): string | null => (sha && HEX.test(sha) ? sha.slice(0, 7).toLowerCase() : null);

/**
 * Joins one request with the supervisor's recent runs. The printed deploy id is the exact key. Without it the run
 * must be the same action, begin after the command was recorded (within the window), and name the same commit when
 * the command named one. A request that matches nothing falls back to what the command printed. With neither, it is
 * Running while its command runs or was recorded inside the window (an agent often runs a deploy in the background,
 * so the call returns at once and prints nothing), and not known after that.
 */
export function joinRelease(
  input: { toolId: string; request: ReleaseRequest; printed: ReleasePrinted; at: string | null; pending: boolean },
  records: readonly ReleaseRecord[] | null,
  now: number = Date.now()
): ReleaseView {
  const { toolId, request, printed } = input;
  const base = { toolId, action: request.action };
  const asked = Date.parse(input.at ?? '');
  const named = HEX.test(request.target) ? request.target.toLowerCase() : null;
  const record =
    (printed.deployId !== null ? records?.find((r) => r.id === printed.deployId) : undefined) ??
    (printed.deployId === null && Number.isFinite(asked)
      ? [...(records ?? [])]
          .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
          .find((r) => {
            const started = Date.parse(r.startedAt);
            if (r.action !== request.action || !Number.isFinite(started)) return false;
            if (started < asked - SKEW_MS || started > asked + WINDOW_MS) return false;
            return named === null || (r.sha ?? '').toLowerCase().startsWith(named);
          })
      : undefined);
  if (record) {
    const finished = record.finishedAt !== null;
    return {
      ...base,
      sha: short(record.sha) ?? short(named),
      state: stateOf(finished ? record.outcome : null, finished),
      failedStep: record.failedStep,
      source: 'supervisor',
      finishedAt: record.finishedAt,
    };
  }
  if (printed.outcome !== null) {
    return {
      ...base,
      sha: short(named),
      state: stateOf(printed.outcome, true),
      failedStep: printed.failedStep,
      source: 'printed',
      finishedAt: null,
    };
  }
  return {
    ...base,
    sha: short(named),
    state: input.pending || (Number.isFinite(asked) && now - asked < WINDOW_MS) ? 'running' : 'unknown',
    failedStep: null,
    source: 'none',
    finishedAt: null,
  };
}

/** The row's words: what was asked for, how it went, and where that is known from. */
export function releaseText(view: ReleaseView): { title: string; note: string } {
  const what = `${view.action === 'rollback' ? 'Rollback' : 'Release'}${view.sha ? ` ${view.sha}` : ''}`;
  const how =
    view.state === 'succeeded'
      ? 'Succeeded'
      : view.state === 'failed'
        ? view.failedStep
          ? `Failed at ${view.failedStep}`
          : 'Failed'
        : view.state === 'rejected'
          ? 'Rejected'
          : view.state === 'running'
            ? 'Running'
            : 'Outcome not known';
  const note =
    view.source === 'supervisor'
      ? "From the deploy supervisor's record."
      : view.source === 'printed'
        ? "As the command printed it. The supervisor's recent runs no longer list this one."
        : view.state === 'running'
          ? 'No outcome yet. The supervisor lists no run for this request so far.'
          : "The command printed no outcome and the supervisor's recent runs do not list it.";
  return { title: `${what} · ${how}`, note };
}
