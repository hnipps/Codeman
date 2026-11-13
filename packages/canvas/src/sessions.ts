/**
 * @fileoverview The outline's Sessions section and Go to (PC13): what a row says and what a query finds.
 *
 * Pure. Rows come from `GET /api/canvas/:workspaceId/sessions`, already derived by the server; this file words
 * them, keeps a row to one per session, and matches Go to queries. Matching is a literal, case-insensitive
 * substring test. The DOM half is `shell-view.ts`.
 */
import { z } from 'zod';
import {
  SHELL_SESSION_KINDS,
  SHELL_SESSION_STATES,
  sortSessions,
  type ShellSessionKind,
  type ShellSessionRow,
  type ShellSessionState,
} from '../../../src/canvas/shell-sessions.js';

export type { ShellSessionRow };

/** State as a word. Colour never carries it alone: every row shows the glyph and the word. */
export const STATE_WORDS: Record<ShellSessionState, string> = {
  needs: 'Needs you',
  error: 'Error',
  waiting: 'Waiting',
  working: 'Working',
  idle: 'Idle',
  done: 'Ended',
};
export const STATE_GLYPHS: Record<ShellSessionState, string> = {
  needs: '!',
  error: '×',
  waiting: '?',
  working: '●',
  idle: '○',
  done: '–',
};
export const KIND_WORDS: Record<ShellSessionKind, string> = {
  terminal: 'Terminal',
  conversation: 'Conversation',
  task: 'Task',
};

const RowSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().max(512),
  mode: z.string().max(64),
  kind: z.enum(SHELL_SESSION_KINDS),
  state: z.enum(SHELL_SESSION_STATES),
  since: z.number().catch(0),
  lastActivityAt: z.number().catch(0),
  lastSubmitAt: z.number().catch(0),
  conversationId: z.string().max(128).optional(),
});
/** A row this release cannot read is left out; the rest of the list still shows. */
export const SessionListSchema = z.object({
  data: z.object({ sessions: z.array(z.unknown()) }),
});
export function parseSessions(body: unknown): ShellSessionRow[] | null {
  const parsed = SessionListSchema.safeParse(body);
  if (!parsed.success) return null;
  return parsed.data.data.sessions.flatMap((row) => {
    const one = RowSchema.safeParse(row);
    return one.success ? [one.data] : [];
  });
}

export type SessionViewRow = ShellSessionRow & {
  kindWord: string;
  stateWord: string;
  glyph: string;
  /** What a screen reader hears for the row: name, kind and state. */
  label: string;
};
/** The rows the outline draws: one per session id, in the dashboard's order. */
export function sessionRows(rows: readonly ShellSessionRow[]): SessionViewRow[] {
  const seen = new Set<string>();
  const unique = rows.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
  return sortSessions(unique).map((row) => ({
    ...row,
    kindWord: KIND_WORDS[row.kind],
    stateWord: STATE_WORDS[row.state],
    glyph: STATE_GLYPHS[row.state],
    label: `${row.name}, ${KIND_WORDS[row.kind]}, ${STATE_WORDS[row.state]}`,
  }));
}

/**
 * The list after this page started a session. The answer to the start and the server's own list can arrive in
 * either order, so the new session is added only when the list does not hold it yet.
 */
export function withStarted(
  rows: readonly ShellSessionRow[],
  started: { id: string; name: string; mode: string; at: number }
): ShellSessionRow[] {
  if (rows.some((row) => row.id === started.id)) return [...rows];
  return [
    ...rows,
    {
      id: started.id,
      name: started.name,
      mode: started.mode,
      kind: 'terminal',
      state: 'idle',
      since: started.at,
      lastActivityAt: started.at,
      lastSubmitAt: 0,
    },
  ];
}

/** Names of sessions that need the person now and did not in the list before: announced once, politely. */
export function newlyNeeding(before: readonly ShellSessionRow[], after: readonly ShellSessionRow[]): string[] {
  const was = new Set(before.filter((row) => row.state === 'needs').map((row) => row.id));
  return after.filter((row) => row.state === 'needs' && !was.has(row.id)).map((row) => row.name);
}

/** A server event waits this long so a burst is one fetch. */
export const REFRESH_SETTLE_MS = 400;
/** The server batches session updates about twice a second; the list is fetched at most once per this gap. */
export const REFRESH_GAP_MS = 2000;
/** How long after an event the list is fetched again, given when the last fetch started. Never over the gap. */
export const refreshDelay = (now: number, lastFetchAt: number): number =>
  Math.min(REFRESH_GAP_MS, Math.max(REFRESH_SETTLE_MS, lastFetchAt + REFRESH_GAP_MS - now));
/** What New session offers: the agent CLIs the server lists, then a shell. */
export type LaunchChoice = { mode: string; label: string; available: boolean; reason: string };
export function launchChoices(
  providers: readonly { id: string; label: string; available: boolean; reason?: string }[]
): LaunchChoice[] {
  return [
    ...providers.map((p) => ({ mode: p.id, label: p.label, available: p.available, reason: p.reason ?? '' })),
    { mode: 'shell', label: 'Shell', available: true, reason: '' },
  ];
}

export type GotoResult =
  | { group: 'sessions'; id: string; label: string; detail: string }
  | { group: 'workspaces'; id: string; label: string; detail: string }
  | { group: 'objects'; id: string; label: string; detail: string };
export const GOTO_GROUPS: { group: GotoResult['group']; title: string }[] = [
  { group: 'sessions', title: 'Sessions in this workspace' },
  { group: 'workspaces', title: 'Workspaces' },
  { group: 'objects', title: 'Objects on this canvas' },
];
export const MAX_GOTO_PER_GROUP = 8;
/** Go to results, grouped and bounded. An empty query lists sessions and workspaces and no objects. */
export function gotoResults(
  query: string,
  source: {
    sessions: readonly SessionViewRow[];
    workspaces: readonly { id: string; name: string; current: boolean }[];
    objects: readonly { id: string; label: string }[];
  }
): GotoResult[] {
  const needle = query.trim().toLowerCase();
  const has = (text: string): boolean => !needle || text.toLowerCase().includes(needle);
  const take = <T>(rows: readonly T[]): T[] => rows.slice(0, MAX_GOTO_PER_GROUP);
  return [
    ...take(source.sessions.filter((s) => has(s.name))).map(
      (s): GotoResult => ({ group: 'sessions', id: s.id, label: s.name, detail: `${s.kindWord} · ${s.stateWord}` })
    ),
    ...take(source.workspaces.filter((w) => !w.current && has(w.name))).map(
      (w): GotoResult => ({ group: 'workspaces', id: w.id, label: w.name, detail: 'Workspace' })
    ),
    ...(needle
      ? take(source.objects.filter((o) => has(o.label))).map(
          (o): GotoResult => ({ group: 'objects', id: o.id, label: o.label, detail: 'Object' })
        )
      : []),
  ];
}
