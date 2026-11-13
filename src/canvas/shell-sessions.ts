/**
 * @fileoverview The Sessions section of the canvas shell (PC13): what a row is, its state and the row order.
 *
 * Pure, and shared by the server route and the canvas page. A session row is derived on every request from what
 * the server already holds about a live session. Nothing here is stored, and a session writes nothing to a canvas.
 *
 * The order is the dashboard's own (`CodemanSessionOrder`, `src/web/public/constants.js`), ported here because the
 * canvas bundle cannot load that classic script. No Node import: the bundle includes this file. `test/canvas-shell-sessions.test.ts` runs both over the same rows.
 */
export const SHELL_SESSION_STATES = ['needs', 'error', 'waiting', 'working', 'idle', 'done'] as const;
export type ShellSessionState = (typeof SHELL_SESSION_STATES)[number];
export const SHELL_SESSION_KINDS = ['terminal', 'conversation', 'task'] as const;
export type ShellSessionKind = (typeof SHELL_SESSION_KINDS)[number];

export const SESSION_STATE_RANK: Record<ShellSessionState, number> = {
  needs: 0,
  error: 1,
  waiting: 2,
  working: 3,
  idle: 4,
  done: 5,
};
/** States something is still in, where the oldest stamp sorts first. */
const OLDEST_FIRST: readonly string[] = ['needs', 'error', 'waiting', 'working'];

export type ShellSessionRow = {
  id: string;
  name: string;
  mode: string;
  kind: ShellSessionKind;
  state: ShellSessionState;
  /** Epoch ms the row entered its state, 0 when unknown. */
  since: number;
  lastActivityAt: number;
  lastSubmitAt: number;
  /** The conversation or task this session carries, when it has one. */
  conversationId?: string;
};

export type StateInput = {
  /** What the approvals inbox holds for the session: nothing, an idle prompt, or a dialog that blocks the agent. */
  approval: 'none' | 'idle' | 'blocking';
  status?: string;
  /** The agent left its pane. */
  exited: boolean;
  busy: boolean;
};
/** One state per session, most urgent first. An exited agent cannot be working or waiting, whatever else is recorded. */
export function deriveSessionState(input: StateInput): ShellSessionState {
  if (input.status === 'error') return 'error';
  if (input.exited || input.status === 'stopped') return 'done';
  if (input.approval === 'blocking') return 'needs';
  if (input.approval === 'idle') return 'waiting';
  return input.busy ? 'working' : 'idle';
}

type Ordered = { state: string; lastActivityAt?: number; lastSubmitAt?: number; orderIndex?: number };
/** When the row entered the state it is in: a working pane's last submit, else its last output. */
export function sessionAnchor(row: Ordered): number {
  const activeAt = Number(row.lastActivityAt) || 0;
  return row.state === 'working' ? Number(row.lastSubmitAt) || activeAt : activeAt;
}
export function compareSessions(a: Ordered, b: Ordered): number {
  const rank =
    (SESSION_STATE_RANK[a.state as ShellSessionState] ?? 99) - (SESSION_STATE_RANK[b.state as ShellSessionState] ?? 99);
  if (rank !== 0) return rank;
  const atA = sessionAnchor(a),
    atB = sessionAnchor(b);
  if (atA !== atB) {
    if (!atA) return 1;
    if (!atB) return -1;
    return OLDEST_FIRST.includes(a.state) ? atA - atB : atB - atA;
  }
  const orderA = Number.isFinite(a.orderIndex) ? (a.orderIndex as number) : Number.MAX_SAFE_INTEGER;
  const orderB = Number.isFinite(b.orderIndex) ? (b.orderIndex as number) : Number.MAX_SAFE_INTEGER;
  return orderA - orderB;
}
/** A copy of `rows` in the order the outline shows them. Rows keep their incoming position as the last tiebreak. */
export function sortSessions<T extends Ordered>(rows: readonly T[]): T[] {
  return rows
    .map((row, orderIndex) => ({ row, orderIndex }))
    .sort((a, b) => compareSessions({ ...a.row, orderIndex: a.orderIndex }, { ...b.row, orderIndex: b.orderIndex }))
    .map((entry) => entry.row);
}

export const needsYou = (rows: readonly { state: string }[]): number => rows.filter((r) => r.state === 'needs').length;

/**
 * The name a session is shown under: its own name, else its folder's name, else the first eight characters of
 * its id. This is the classic view's rule (`getSessionName()` in `app.js`), kept equal to it by a parity test,
 * so an unnamed session reads the same in the outline and in the tab strip.
 */
export function sessionDisplayName(session: { id: string; name?: unknown; workingDir?: unknown }): string {
  if (typeof session.name === 'string' && session.name) return session.name;
  if (typeof session.workingDir === 'string' && session.workingDir)
    return session.workingDir.split('/').pop() || session.workingDir;
  return session.id.slice(0, 8);
}
