/**
 * @fileoverview What the canvas shows of the Reviews page: how many reviews ask something of the reader, and which session
 * wrote each. Pure. The page itself is `reviews.html`; the canvas only links to it.
 *
 * The answer of `GET /api/reviews` is parsed here and nothing in it is trusted: a row that is not a review is
 * dropped, and an id that could not be part of an address never becomes one.
 */

export type WaitingReview = { id: string; state: string };
/** `byWork` is keyed by `workReviewKey(workspaceId, key)`: a work key repeats across workspaces. */
export type WaitingReviews = {
  count: number;
  bySession: Map<string, WaitingReview>;
  byWork: Map<string, WaitingReview>;
};
export const workReviewKey = (workspaceId: string, key: string): string => `${workspaceId}\n${key}`;

const ID = /^[a-z0-9]{8,40}$/;

/** What a linked session's review row says, by the review's state. */
export const REVIEW_WORDS: Record<string, string> = {
  ready: 'Review ready for you',
  'changes-requested': 'Review: you asked for changes',
  updated: 'Review updated since your notes',
  deploying: 'Review approved, deploying',
  'deploy-failed': 'Review approved, deploy failed',
};
export const reviewWords = (state: string): string => REVIEW_WORDS[state] ?? 'Review waiting';

/** The waiting reviews in the answer of `GET /api/reviews`, or null when it is not that answer. */
export function parseWaitingReviews(body: unknown): WaitingReviews | null {
  const waiting = (body as { data?: { waiting?: unknown } } | null)?.data?.waiting;
  if (!Array.isArray(waiting)) return null;
  const bySession = new Map<string, WaitingReview>();
  const byWork = new Map<string, WaitingReview>();
  let count = 0;
  for (const row of waiting) {
    const r = row as {
      id?: unknown;
      sessionId?: unknown;
      state?: unknown;
      work?: { workspaceId?: unknown; key?: unknown } | null;
    } | null;
    if (!r || typeof r.id !== 'string' || !ID.test(r.id)) continue;
    // An approved review that is deploying is on the list, and asks nothing of the reader.
    if (r.state !== 'deploying') count++;
    // A session can have one review per branch; the list is oldest first, so the oldest one is the row's link.
    const review = { id: r.id, state: typeof r.state === 'string' ? r.state : '' };
    // A work review is listed by its item; its stored session id names no session.
    if (r.work && typeof r.work.workspaceId === 'string' && typeof r.work.key === 'string') {
      byWork.set(workReviewKey(r.work.workspaceId, r.work.key), review);
      continue;
    }
    if (typeof r.sessionId === 'string' && !bySession.has(r.sessionId)) bySession.set(r.sessionId, review);
  }
  return { count, bySession, byWork };
}
