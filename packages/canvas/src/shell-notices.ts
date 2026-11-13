/**
 * @fileoverview The one quiet line the shell's outline shows for something the classic view is waiting to tell
 * the person (PC13): sessions to rebuild after a restart, a security notice, a release they have not seen.
 *
 * Pure. The line only says that something is there and links to the classic view, where the notice itself is
 * shown, closed and remembered. The canvas page reads the same data the dashboard reads and writes none of it.
 */
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Local-time bounds of a `YYYY-MM-DD` day, as the dashboard reads them (`securityNoticeDay`, constants.js). */
function day(value: unknown): { start: number; end: number } | null {
  const match = typeof value === 'string' ? DAY.exec(value) : null;
  if (!match) return null;
  const year = Number(match[1]),
    month = Number(match[2]) - 1,
    date = Number(match[3]);
  const start = new Date(year, month, date);
  if (start.getFullYear() !== year || start.getMonth() !== month || start.getDate() !== date) return null;
  return { start: start.getTime(), end: new Date(year, month, date + 1).getTime() - 1 };
}
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * True when at least one notice in `security-notices.json` is in its date window, not in the seen list, and
 * (when it names a CLI) about a CLI this server can run. A malformed entry counts as nothing.
 */
export function securityNoticeDue(
  notices: unknown,
  opts: { seen: readonly string[]; now: number; available: Readonly<Record<string, boolean>> }
): boolean {
  if (!Array.isArray(notices)) return false;
  const seen = new Set(opts.seen);
  const taken = new Set<string>();
  for (const entry of notices) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const id = text(e.id);
    const published = day(e.published),
      expires = day(e.expires);
    if (!id || !text(e.message) || !published || !expires || taken.has(id)) continue;
    taken.add(id);
    if (opts.now < published.start || opts.now > expires.end || seen.has(id)) continue;
    if (e.cli !== undefined && (typeof e.cli !== 'string' || opts.available[e.cli] !== true)) continue;
    return true;
  }
  return false;
}

/** The ids the dashboard recorded as closed (`codeman-security-notices-seen`); anything unreadable is none. */
export function seenNotices(raw: string | null): string[] {
  try {
    const ids: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** True when this browser has seen an earlier release and not the running one: the classic view will announce it. */
export const releaseUnseen = (seenVersion: string | null, runningVersion: unknown): boolean =>
  !!seenVersion && typeof runningVersion === 'string' && !!runningVersion && seenVersion !== runningVersion;

export type ShellLine = { kind: 'reboot' | 'security' | 'release'; text: string };
/** At most one line, most pressing first. */
export function shellLine(facts: { reboot: number; security: boolean; release: boolean }): ShellLine | null {
  if (facts.reboot > 0)
    return {
      kind: 'reboot',
      text: `${facts.reboot} ${facts.reboot === 1 ? 'session' : 'sessions'} can be rebuilt after a restart`,
    };
  if (facts.security) return { kind: 'security', text: 'Security notice' };
  if (facts.release) return { kind: 'release', text: 'Codeman was updated' };
  return null;
}
