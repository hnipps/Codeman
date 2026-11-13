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
      return say(
        'This case folder is not a git repository, so the task cannot get its own copy. It can run in the case folder itself, sharing it with your other sessions.',
        true
      );
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
  failed: 'could not be removed',
};

/** Tasks that want the person: waiting for an answer, or finished since the list was last opened. */
export function taskCount(rows: readonly Pick<TaskRow, 'id' | 'state'>[], seen: ReadonlySet<string>): number {
  return rows.filter((r) => r.state === 'waiting' || (!taskActive(r.state) && !seen.has(r.id))).length;
}
/** What opening the list marks as seen: every finished task now listed, and nothing that has gone. */
export const seenAfterOpen = (rows: readonly Pick<TaskRow, 'id' | 'state'>[]): string[] =>
  rows.filter((r) => !taskActive(r.state)).map((r) => r.id);
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
/** Provider, model and where the task runs, on one line. */
export const taskMeta = (row: Pick<TaskRow, 'cliLabel' | 'cliId' | 'model' | 'isolation'>): string =>
  [row.cliLabel || row.cliId, row.model ?? '', row.isolation.label].filter(Boolean).join(' · ');
