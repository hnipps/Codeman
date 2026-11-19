/**
 * @fileoverview Notice, while the server runs, that a session's tmux session no longer exists.
 *
 * Boot already does this (`TmuxManager.reconcileSessions()` drops a session with no pane), but a
 * running server never did: when the tmux server died (an OOM kill took it down twice), every
 * session lost its pane, and the server went on listing them all as idle tabs. The deploy health
 * check then expected a new colour to keep them, and refused every deploy (2026-11-19).
 *
 * Pure, so the rules are tested as shipped. `TmuxManager` runs one `tmux list-sessions` per
 * pane-exit tick, classifies it with {@link classifyListSessions}, and folds it in with
 * {@link nextVanishCounts}; the server drops what comes out and offers it back for rebuild.
 *
 * ⚠️ Conservative on purpose: a session is gone only after {@link VANISH_CONFIRM_READS} reads IN A
 * ROW that answered and did not list it. A read that failed for any other reason than "no server"
 * proves nothing and changes no count, so a wedged or slow tmux can never empty the tab strip.
 * The same "no server" rule is in deploy/session-survival.mjs, whose model is proved in
 * deploy/model/SessionSurvival.dfy.
 */

/** What one `tmux list-sessions -F '#{session_name}'` said. */
export type MuxProbe =
  | { kind: 'running'; names: ReadonlySet<string> }
  | { kind: 'none' } // no tmux server on the socket: every session on it is gone
  | { kind: 'unknown' }; // anything else: proves nothing

/** Consecutive answering reads without the session before it counts as gone. */
export const VANISH_CONFIRM_READS = 2;

/** A missing socket, or one nothing listens on, means no server. "Permission denied" and the rest do not. */
const NO_SERVER = /no server running|error connecting to .*\((No such file or directory|Connection refused)\)/i;

/** Classify one run of `tmux -L <socket> list-sessions -F '#{session_name}'`. */
export function classifyListSessions(failed: boolean, stdout: string, stderr: string): MuxProbe {
  if (!failed) return { kind: 'running', names: new Set(stdout.split('\n').filter(Boolean)) };
  return NO_SERVER.test(stderr) ? { kind: 'none' } : { kind: 'unknown' };
}

/**
 * Fold one probe into the per-session miss counts.
 *
 * @param prev    misses so far, by tmux session name
 * @param watched the tmux session names to watch now (sessions with a local pane on the socket)
 * @returns the new counts (only watched names, only names with a miss) and the names that just
 *   reached {@link VANISH_CONFIRM_READS}
 */
export function nextVanishCounts(
  prev: ReadonlyMap<string, number>,
  watched: Iterable<string>,
  probe: MuxProbe
): { counts: Map<string, number>; vanished: string[] } {
  const counts = new Map<string, number>();
  const vanished: string[] = [];
  for (const name of watched) {
    const before = prev.get(name) ?? 0;
    if (probe.kind === 'unknown') {
      if (before > 0) counts.set(name, before);
      continue;
    }
    const present = probe.kind === 'running' && probe.names.has(name);
    if (present) continue;
    const misses = before + 1;
    if (misses >= VANISH_CONFIRM_READS) vanished.push(name);
    else counts.set(name, misses);
  }
  return { counts, vanished };
}
