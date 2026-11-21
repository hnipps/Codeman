/**
 * @fileoverview The canvas Work items a review belongs to. A work item links the sessions that worked on it; the
 * review links its author session; so the items of a review are the open items, in its owner's canvas workspaces,
 * that link that session. Used when a review is handed to a new session (`POST /api/reviews/:id/new-session`): the
 * items go into the new session's prompt, and the new session is linked to them so the canvas follows the work.
 * Also used on Approve of a session's review: the items that session left waiting move to Done (W-70 I8).
 *
 * Reads tolerate a workspace whose work file cannot be read (it is skipped); a link that cannot be written is
 * reported, never thrown, since the hand-over itself has already happened by then.
 */
import { changeWork, readWork } from '../canvas/work-store.js';
import { WORK_STATUS_NAMES, closeLinkedWork, updateWork, workClosed, workKey, type WorkItem } from '../canvas/work.js';
import { readWorkspaces } from '../canvas/workspace-registry.js';
import type { Author } from '../canvas/model.js';
import type { HandoverWork } from './review-model.js';

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
