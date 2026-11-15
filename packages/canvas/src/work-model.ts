/**
 * @fileoverview The Work view's pure part: what an item's live state is, how a lane orders its cards, what a filter
 * keeps, and the counts the outline shows. The DOM is `work-view.ts`.
 *
 * An item's state is the Sessions vocabulary: Needs you while it holds an agent's question, else the most urgent
 * state among its linked sessions; a linked session the list no longer carries reads as Ended. An item with no
 * linked session has no state. Nothing here changes an item.
 */
import { z } from 'zod';
import {
  SESSION_STATE_RANK,
  type ShellSessionRow,
  type ShellSessionState,
} from '../../../src/canvas/shell-sessions.js';
import { WORK_STATUSES, workClosed, type WorkRow, type WorkStatus } from '../../../src/canvas/work.js';

export type { WorkRow, WorkStatus };
export type WorkFilter = 'all' | 'you' | 'agents' | 'none';

const Row = z
  .object({
    key: z.string(),
    number: z.number(),
    title: z.string(),
    status: z.enum(WORK_STATUSES),
    description: z.string().catch(''),
    assignee: z
      .union([
        z.object({ kind: z.literal('person') }),
        z.object({ kind: z.literal('session'), sessionId: z.string() }),
        z.null(),
      ])
      .catch(null),
    sessions: z.array(z.string()).catch([]),
    createdFrom: z.number().optional().catch(undefined),
    author: z.union([
      z.object({ kind: z.literal('human'), userId: z.string() }),
      z.object({ kind: z.literal('agent'), sessionId: z.string() }),
    ]),
    createdAt: z.number(),
    updatedAt: z.number(),
    revision: z.number(),
    needs: z
      .object({ question: z.string(), sessionId: z.string().optional(), at: z.number() })
      .optional()
      .catch(undefined),
    outcome: z
      .object({
        kind: z.enum(['done', 'continue', 'split']),
        text: z.string(),
        sessionId: z.string().optional(),
        at: z.number(),
      })
      .optional()
      .catch(undefined),
    history: z
      .array(
        z.object({
          at: z.number(),
          author: z.union([
            z.object({ kind: z.literal('human'), userId: z.string() }),
            z.object({ kind: z.literal('agent'), sessionId: z.string() }),
          ]),
          text: z.string(),
        })
      )
      .catch([]),
  })
  .passthrough();
/** The list route's answer, or null. A row this release cannot read is left out; the rest still show. */
export function parseWork(body: unknown): { items: WorkRow[]; next: string } | null {
  const parsed = z
    .object({ success: z.literal(true), data: z.object({ next: z.string(), items: z.array(z.unknown()) }) })
    .safeParse(body);
  if (!parsed.success) return null;
  const items = parsed.data.data.items.flatMap((raw) => {
    const row = Row.safeParse(raw);
    return row.success ? [row.data as unknown as WorkRow] : [];
  });
  return { items, next: parsed.data.data.next };
}

export type WorkState = ShellSessionState;
/** Needs you while the item holds a question; else the most urgent linked session; none without a linked session. */
export function itemState(item: WorkRow, sessions: readonly ShellSessionRow[]): WorkState | null {
  if (item.needs) return 'needs';
  let best: WorkState | null = null;
  for (const id of item.sessions) {
    const state: WorkState = sessions.find((s) => s.id === id)?.state ?? 'done';
    if (best === null || SESSION_STATE_RANK[state] < SESSION_STATE_RANK[best]) best = state;
  }
  return best;
}
const rank = (state: WorkState | null): number => (state === null ? 99 : SESSION_STATE_RANK[state]);

export function matchesFilter(item: WorkRow, filter: WorkFilter, query: string): boolean {
  if (filter === 'you' && item.assignee?.kind !== 'person') return false;
  if (filter === 'agents' && item.assignee?.kind !== 'session') return false;
  if (filter === 'none' && item.assignee !== null) return false;
  const q = query.trim().toLowerCase();
  return !q || item.title.toLowerCase().includes(q) || item.key.toLowerCase().includes(q);
}

/** One lane's cards: open lanes urgent first, then newest change; closed lanes newest change only. */
export function laneItems(
  items: readonly WorkRow[],
  status: WorkStatus,
  sessions: readonly ShellSessionRow[],
  filter: WorkFilter = 'all',
  query = ''
): WorkRow[] {
  return items
    .filter((i) => i.status === status && matchesFilter(i, filter, query))
    .map((item) => ({ item, state: rank(itemState(item, sessions)) }))
    .sort((a, b) =>
      !workClosed(status) && a.state !== b.state ? a.state - b.state : b.item.updatedAt - a.item.updatedAt
    )
    .map((entry) => entry.item);
}

export type WorkCount = { status: WorkStatus; count: number; unassigned: number };
/** A count per status; Todo also says how many have nobody on them. */
export function workCounts(items: readonly WorkRow[]): WorkCount[] {
  return WORK_STATUSES.map((status) => {
    const inLane = items.filter((i) => i.status === status);
    return {
      status,
      count: inLane.length,
      unassigned: status === 'todo' ? inLane.filter((i) => i.assignee === null).length : 0,
    };
  });
}
export const openCount = (items: readonly WorkRow[]): number => items.filter((i) => !workClosed(i.status)).length;

/** The status one step left or right, or null past either end. */
export function stepStatus(status: WorkStatus, step: -1 | 1): WorkStatus | null {
  return WORK_STATUSES[WORK_STATUSES.indexOf(status) + step] ?? null;
}

/** The name a session goes by here: its row's name, else the first eight characters of its id. */
export function sessionLabel(id: string, sessions: readonly ShellSessionRow[]): string {
  return sessions.find((s) => s.id === id)?.name || id.slice(0, 8);
}
export function assigneeLabel(item: Pick<WorkRow, 'assignee'>, sessions: readonly ShellSessionRow[]): string {
  if (!item.assignee) return 'Unassigned';
  return item.assignee.kind === 'person' ? 'You' : sessionLabel(item.assignee.sessionId, sessions);
}
export function authorLabel(author: WorkRow['author'], sessions: readonly ShellSessionRow[]): string {
  return author.kind === 'human' ? 'You' : sessionLabel(author.sessionId, sessions);
}
