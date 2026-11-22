/**
 * @fileoverview The canvas Work items a review belongs to. A work item links the sessions that worked on it; the
 * review links its author session; so the items of a review are the open items, in its owner's canvas workspaces,
 * that link that session. Used when a review is handed to a new session (`POST /api/reviews/:id/new-session`): the
 * items go into the new session's prompt, and the new session is linked to them so the canvas follows the work.
 * Also used on Approve of a session's review: the items that session left waiting move to Done (W-70 I8), and when
 * pr-swarm escalates a review: its open items move to Human required (`intent/2026-11-20-pr-swarm-reviews.md` I6).
 *
 * Reads tolerate a workspace whose work file cannot be read (it is skipped); a link that cannot be written is
 * reported, never thrown, since the hand-over itself has already happened by then.
 */
import { changeWork, readWork } from '../canvas/work-store.js';
import {
  WORK_STATUS_NAMES,
  MAX_WORK_NOTE_CHARS,
  ESCALATED_LINE,
  closeLinkedWork,
  commentWork,
  escalateWork,
  findWork,
  updateWork,
  workClosed,
  workKey,
  type WorkItem,
} from '../canvas/work.js';
import { readWorkspaces } from '../canvas/workspace-registry.js';
import type { Author } from '../canvas/model.js';
import { authorSessionId, sourceOf, type HandoverWork, type Review, type WorkRef } from './review-model.js';

export type ReviewWorkItem = { workspaceId: string; number: number; item: WorkItem };

/** The open work items of the given owner's workspaces that link `sessionId`, oldest item first. */
export function workItemsForSession(owner: string | null, sessionId: string): ReviewWorkItem[] {
  let workspaces;
  try {
    workspaces = readWorkspaces();
  } catch {
    return [];
  }
  const out: ReviewWorkItem[] = [];
  for (const workspace of workspaces) {
    if ((workspace.owner ?? null) !== owner) continue;
    let read;
    try {
      read = readWork(workspace.id);
    } catch {
      continue;
    }
    if (!read.ok) continue;
    for (const item of read.file.items)
      if (!workClosed(item.status) && item.sessions.includes(sessionId))
        out.push({ workspaceId: workspace.id, number: item.number, item });
  }
  return out.sort((a, b) => a.item.createdAt - b.item.createdAt);
}

/** The item a work item was created from, or undefined when it has none or its work file cannot be read. */
export function workCreatedFrom(work: WorkRef): number | undefined {
  try {
    const read = readWork(work.workspaceId);
    return read.ok ? findWork(read.file, work.number)?.createdFrom : undefined;
  } catch {
    return undefined;
  }
}

export const handoverWork = (w: ReviewWorkItem): HandoverWork => ({
  key: workKey(w.number),
  title: w.item.title,
  status: WORK_STATUS_NAMES[w.item.status],
  description: w.item.description,
  ...(w.item.needs ? { question: w.item.needs.question } : {}),
  ...(w.item.outcome ? { outcome: w.item.outcome.text } : {}),
});

/** Links `sessionId` to each item. Returns the workspaces that changed; an item that refuses the link is skipped. */
export function linkSessionToWork(items: ReviewWorkItem[], sessionId: string, author: Author): string[] {
  const changed = new Set<string>();
  for (const w of items) {
    try {
      const result = changeWork(w.workspaceId, (file) =>
        updateWork(file, w.number, { linkSessions: [sessionId] }, { author, now: Date.now() })
      );
      if (result.ok && !result.duplicate) changed.add(w.workspaceId);
    } catch {
      /* Not the live colour, or the file went away: the hand-over stands without the link. */
    }
  }
  return [...changed];
}

/** What Approve did to the author session's items: keys moved to Done, and keys it could not write with the reason. */
export type ClosedSessionWork = {
  closed: { workspaceId: string; key: string }[];
  failed: { workspaceId: string; key: string; reason: string }[];
};

/**
 * Approve merged a review written by `sessionId`: each item of the owner's workspaces that `closeLinkedWork` finds
 * done moves to Done (W-70 I8). A refused or failed write is returned in `failed`, never thrown: the merge stands.
 */
export function closeSessionWork(
  owner: string | null,
  sessionId: string,
  reviewId: string,
  mergedSha: string,
  author: Author
): ClosedSessionWork {
  const out: ClosedSessionWork = { closed: [], failed: [] };
  for (const w of workItemsForSession(owner, sessionId)) {
    const key = workKey(w.number);
    try {
      const result = changeWork(w.workspaceId, (file) =>
        closeLinkedWork(file, w.number, sessionId, reviewId, mergedSha, { author, now: Date.now() })
      );
      if (!result.ok) out.failed.push({ workspaceId: w.workspaceId, key, reason: result.message });
      else if (result.item.status === 'done') out.closed.push({ workspaceId: w.workspaceId, key });
    } catch (err) {
      out.failed.push({ workspaceId: w.workspaceId, key, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/**
 * The open work items a review belongs to: a work review's own item, or the items linking a session review's author
 * session. Empty when there are none or they cannot be read.
 */
export function reviewWorkItems(review: Review): ReviewWorkItem[] {
  const source = sourceOf(review);
  if (source.kind === 'work') {
    try {
      const read = readWork(source.work.workspaceId);
      const item = read.ok ? findWork(read.file, source.work.number) : undefined;
      return item && !workClosed(item.status)
        ? [{ workspaceId: source.work.workspaceId, number: item.number, item }]
        : [];
    } catch {
      return [];
    }
  }
  const author = authorSessionId(review);
  return author ? workItemsForSession(review.owner ?? null, author) : [];
}

/** What an escalation did to the review's items: keys moved to Human required, and keys it could not write. */
export type EscalatedWork = {
  moved: { workspaceId: string; key: string }[];
  failed: { workspaceId: string; key: string; reason: string }[];
};

/** Moves each item to Human required with `note` (`escalateWork`). A refused write is returned, never thrown. */
export function escalateReviewWork(items: ReviewWorkItem[], note: string, author: Author): EscalatedWork {
  const out: EscalatedWork = { moved: [], failed: [] };
  for (const w of items) {
    const key = workKey(w.number);
    try {
      const result = changeWork(w.workspaceId, (file) =>
        escalateWork(file, w.number, note, { author, now: Date.now() })
      );
      if (result.ok) out.moved.push({ workspaceId: w.workspaceId, key });
      else out.failed.push({ workspaceId: w.workspaceId, key, reason: result.message });
    } catch (err) {
      out.failed.push({ workspaceId: w.workspaceId, key, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/**
 * Whether an escalation made at `since` still waits in the items: true while one of the items it moved is in Human
 * required, false once all have left it, null when it moved none of them. Only the items it moved count: one it
 * refused (Backlog, a full thread) never held it, so it can never clear it.
 */
export function escalationHeld(items: ReviewWorkItem[], since: number): boolean | null {
  const moved = items.filter((w) => w.item.history.some((e) => e.at >= since && e.text === ESCALATED_LINE));
  return moved.length ? moved.some((w) => w.item.status === 'human-required') : null;
}

/** Adds `text` as a comment to each item. Returns the workspaces that changed; an item that refuses it is skipped. */
export function commentReviewWork(items: ReviewWorkItem[], text: string, author: Author): string[] {
  const changed = new Set<string>();
  for (const w of items) {
    try {
      const result = changeWork(w.workspaceId, (file) =>
        commentWork(file, w.number, text.slice(0, MAX_WORK_NOTE_CHARS), { author, now: Date.now() })
      );
      if (result.ok) changed.add(w.workspaceId);
    } catch {
      /* Not the live colour, or the file went away: the comment is lost, the change it reports stands. */
    }
  }
  return [...changed];
}
