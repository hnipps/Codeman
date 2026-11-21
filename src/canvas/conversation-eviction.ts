/**
 * @fileoverview Which canvas conversations and tasks still hold a place under the canvas cap. Pure: the routes hand it
 * what the record and the live session say, and it answers whether the agent is still at work and which records may
 * give up their place, oldest first.
 */
import type { ConversationMessage } from './conversation-schema.js';

/** A live session that has been quiet this long, waiting on a person or idle, no longer holds a place. */
export const ACTIVE_WINDOW_MS = 60 * 60 * 1000;

export type ActivityEvidence = {
  createdAt: number;
  messages: readonly Pick<ConversationMessage, 'sentAt' | 'submittedAt' | 'deliveredAt'>[];
  /** Absent when the session is no longer on the server. */
  session?: {
    /** The agent left its pane. */
    exited: boolean;
    /** A turn is running: the CLI's own hook says so, or idle detection does. */
    working: boolean;
    /** The pane's last output and last submitted input, in ms. */
    lastActivityAt?: number;
    lastSubmitAt?: number;
  };
};

/** The newest moment anything happened: the pane's output or input, a message the canvas sent, or the record's creation. */
export function lastActiveAt(e: ActivityEvidence): number {
  const times = [e.createdAt, e.session?.lastActivityAt ?? 0, e.session?.lastSubmitAt ?? 0];
  for (const m of e.messages) times.push(m.sentAt, m.submittedAt ?? 0, m.deliveredAt ?? 0);
  return Math.max(...times);
}

/** Active: the session is live, and its agent is working now or was active less than `ACTIVE_WINDOW_MS` ago. */
export const conversationActive = (e: ActivityEvidence, now: number): boolean =>
  !!e.session && !e.session.exited && (e.session.working || now - lastActiveAt(e) < ACTIVE_WINDOW_MS);

/** The inactive records, oldest activity first (creation breaks a tie): the order a full canvas evicts them in. */
export const evictionOrder = <T extends { evidence: ActivityEvidence }>(records: readonly T[], now: number): T[] =>
  records
    .filter((r) => !conversationActive(r.evidence, now))
    .sort((a, b) => lastActiveAt(a.evidence) - lastActiveAt(b.evidence) || a.evidence.createdAt - b.evidence.createdAt);
