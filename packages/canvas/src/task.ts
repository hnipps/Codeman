/** Pure parts of the background task list: the stored run attempt, what a refusal says, the quiet count and the row copy. */
import type { TaskRow, TaskState } from '../../../src/canvas/tasks.js';

export type { TaskRow, TaskState };
/** One run attempt, kept with the draft until the server acknowledges it, so a retry starts the same task and never a second. */
export type TaskAttempt = { requestId: string; text: string; refIds: string[] };
const UUID = /^[0-9a-fA-F-]{36}$/;
export function parseTaskAttempt(raw: string | null): TaskAttempt | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return null;
    const o = v as Record<string, unknown>;
    if (
      typeof o.requestId !== 'string' ||
      !UUID.test(o.requestId) ||
      typeof o.text !== 'string' ||
      !Array.isArray(o.refIds) ||
      !o.refIds.every((id) => typeof id === 'string')
    )
      return null;
    return { requestId: o.requestId, text: o.text, refIds: o.refIds as string[] };
  } catch {
    return null;
  }
}
/** The same request again reuses its id; any change to the text or the context is another task. */
export function nextTaskAttempt(
  stored: TaskAttempt | null,
  text: string,
  refIds: string[],
  makeId: () => string
): TaskAttempt {
  if (
    stored &&
    stored.text === text &&
    stored.refIds.length === refIds.length &&
    stored.refIds.every((id, i) => id === refIds[i])
  )
    return stored;
  return { requestId: makeId(), text, refIds };
}

export const STATE_LABEL: Record<TaskState, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Waiting for you',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
export const taskActive = (state: TaskState): boolean =>
  state === 'queued' || state === 'running' || state === 'waiting';

/**
 * What a refused run says. `share` asks the person whether the task may run in the case folder itself; `fresh` means
 * the stored attempt can never succeed and the next press is a new request.
 */
export function taskFailure(message: string, status: number): { text: string; share: boolean; fresh: boolean } {
  const code = /^([A-Z_]+):/.exec(message)?.[1] ?? '';
  const say = (text: string, share = false, fresh = false) => ({ text, share, fresh });
  const kept = 'Your message is kept.';
  switch (code) {
    case 'NOT_A_REPOSITORY':
    case 'NO_COMMITS':
    case 'REPOSITORY_SUBFOLDER':
    case 'BARE_REPOSITORY':
    case 'DOCKER_WORKSPACE': {
      // The server's own reason, which is one of a fixed set of sentences and never carries a path.
      const reason = message.slice(code.length + 1).trim() || 'this case folder is not a git repository';
      return say(
        `The task cannot be isolated here: ${reason}. It can run in the case folder itself, sharing it with your other sessions.`,
        true
      );
    }
    case 'TASK_CANCELLED':
      return say('This task was cancelled. Start a new one.');
    case 'TOO_MANY_TASKS':
      return say(`Four background tasks are already running on this canvas. Cancel one or wait. ${kept}`);
    case 'TOO_MANY':
      return say(`This canvas holds as many conversations and tasks as it can. Remove a finished task first. ${kept}`);
    case 'CASE_UNSUPPORTED':
      return say(`Background tasks are not available for this case. ${kept}`);
    case 'CASE_MISSING':
      return say(`The case folder no longer exists. ${kept}`);
    case 'CASE_UNREACHABLE':
      return say(`The case folder is not answering right now. Nothing was started. ${kept}`);
    case 'ORIGIN_GONE':
      return say(`The comment this was asked from is gone. ${kept}`, false, true);
    case 'ISOLATION_FAILED':
    case 'WORKTREE_FAILED':
      return say(`The task could not get its own worktree. Nothing was started. ${kept}`);
    case 'START_FAILED':
      return say(`The agent session could not start. Nothing was left behind. ${kept}`);
    case 'SESSION_ENDED':
    case 'NOT_DELIVERED':
      return say(`The agent did not take the request. Nothing was left behind. ${kept}`);
    case 'TASK_CHANGED':
    case 'REQUEST_REUSED':
      return say(`That request was already used. Press Run in background again. ${kept}`, false, true);
    case 'FILE_UNREADABLE':
      return say(`Tasks cannot be saved right now. Nothing was started. ${kept}`);
    case 'TOO_LARGE':
      return say('The message and its context are too large to send. Remove some context or shorten it.');
  }
  if (status === 403) return say(`You cannot start a background task on this canvas. ${kept}`);
  if (status === 400) return say(message || `That request cannot be run. ${kept}`);
  return say(`The task could not be started. ${kept}`);
}
/** Why a cancel or remove was refused, in a sentence. */
export function taskActionFailure(message: string, status: number): string {
  const code = /^([A-Z_]+):/.exec(message)?.[1] ?? '';
  if (code === 'TASK_FINISHED') return 'This task had already finished.';
  if (code === 'TASK_ACTIVE') return 'Cancel the task before removing it.';
  if (status === 404) return 'This task is no longer listed.';
  if (status === 403) return 'You cannot change this task.';
  return 'That did not work. Try again.';
}
export const KEPT_REASON: Record<NonNullable<TaskRow['kept']>['reason'], string> = {
  changes: 'has changes, so it was kept',
  'in-use': 'is still in use by a session, so it was kept',
  locked: 'is locked in git, so it was kept. Unlock it with git first',
  leftover: 'is a folder git no longer knows as a worktree, so it was left as it is',
  session: 'was kept because its session could not be closed',
  failed: 'could not be removed',
};

/** Tasks that want the person: waiting for an answer, or finished since the list was last opened. */
export function taskCount(rows: readonly Pick<TaskRow, 'id' | 'state'>[], seen: ReadonlySet<string>): number {
  return rows.filter((r) => r.state === 'waiting' || (!taskActive(r.state) && !seen.has(r.id))).length;
}
/** What opening the list marks as seen: every finished task now listed, and nothing that has gone. */
export const seenAfterOpen = (rows: readonly Pick<TaskRow, 'id' | 'state'>[]): string[] =>
  rows.filter((r) => !taskActive(r.state)).map((r) => r.id);
/** A started task's request, kept on this browser so a request that was never delivered can be sent again unchanged. */
export type SentTask = { id: string; requestId: string; text: string; refIds: string[] };
export const MAX_SENT_TASKS = 8;
export function parseSentTasks(raw: string | null): SentTask[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .flatMap((entry: unknown): SentTask[] => {
        if (typeof entry !== 'object' || entry === null) return [];
        const o = entry as Record<string, unknown>;
        const attempt = parseTaskAttempt(JSON.stringify(o));
        return attempt && typeof o.id === 'string' ? [{ id: o.id, ...attempt }] : [];
      })
      .slice(-MAX_SENT_TASKS);
  } catch {
    return [];
  }
}
/** The stored attempt was on its way to the server when the page went away: its answer was never seen. */
export function attemptPending(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'object' && v !== null && (v as { pending?: unknown }).pending === true;
  } catch {
    return false;
  }
}
/** What the composer says about a run a reload interrupted before the server's answer was seen. */
export const RUN_INTERRUPTED =
  'A background run was interrupted before it was confirmed. If it started it is in the task list; otherwise press Run in background again. Your message is kept.';
/** One line under a task row for what the server reports beside its state. */
export function taskAsides(
  row: Pick<TaskRow, 'state' | 'unsubmitted' | 'excludeWarning' | 'retryable' | 'kept'>
): string[] {
  const lines: string[] = [];
  if (row.state === 'cancelled' && !row.kept)
    lines.push(
      row.unsubmitted
        ? 'Cancelled before the request was submitted. It may still be in this session’s input box, so the session is kept for inspection only and takes no more messages.'
        : 'Cancelled. Its session is kept for inspection only and takes no more messages.'
    );
  if (row.retryable) lines.push('The request was not delivered to the agent.');
  if (row.excludeWarning)
    lines.push(
      'Codeman could not tell git to ignore its own settings file in this repository, so this worktree reads as changed and is kept on Remove. Check it and remove it with git.'
    );
  return lines;
}
export function parseSeen(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((id): id is string => typeof id === 'string').slice(0, 200) : [];
  } catch {
    return [];
  }
}
/** Running tasks first, then newest first, so the list does not shuffle while one works. */
export function sortTasks<T extends Pick<TaskRow, 'state' | 'createdAt'>>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) => Number(taskActive(b.state)) - Number(taskActive(a.state)) || b.createdAt - a.createdAt
  );
}
/** Provider, model, where the task runs and, for an agent's task, who started it, on one line. */
export const taskMeta = (row: Pick<TaskRow, 'cliLabel' | 'cliId' | 'model' | 'isolation' | 'startedBy'>): string =>
  [row.cliLabel || row.cliId, row.model ?? '', row.isolation.label, row.startedBy ? 'Started by an agent' : '']
    .filter(Boolean)
    .join(' · ');
