/**
 * @fileoverview The pure rules of a work review: a review of the pull request a canvas work item carries
 * (`item.pr`). No IO; `work-reviews.ts` does the reading and writing.
 *
 * Two facts have two owners. Whether an item wants a review is the tracker's (`item.pr`, `item.status`) and is read
 * fresh each time (`wanted`); the review record holds only what the person did and the last tip seen. So clearing the
 * pull request, or closing the item, hides the review with no delete, and setting the same pull request again brings
 * the same record back with its notes.
 */
import { createHash } from 'node:crypto';
import { workClosed, workKey, type WorkItem } from '../canvas/work.js';
import {
  cleanLine,
  cleanText,
  MAX_TITLE_CHARS,
  MAX_WALKTHROUGH_CHARS,
  storedSource,
  type Review,
  type WorkRef,
} from './review-model.js';

/** One review per (item, pull request): a new pull request is a new review, a corrected branch is the same one. */
export function workReviewId(work: WorkRef, prUrl: string): string {
  return createHash('sha256').update(`${work.workspaceId}\n${work.number}\n${prUrl}`).digest('hex').slice(0, 16);
}

/** True while the item still asks for this review: open, with a pull request on a branch, and the same one. */
export function wanted(item: WorkItem | undefined, review: Pick<Review, 'id'>, work: WorkRef): boolean {
  return !!item && !workClosed(item.status) && !!item.pr?.branch && workReviewId(work, item.pr.url) === review.id;
}

/** Everything a work review takes from the item and the repository at one sync. */
export type WorkReviewFacts = {
  repoRoot: string;
  project: string;
  branch: string;
  base: string;
  headSha: string;
  title: string;
  walkthrough: string;
  owner: string | null;
};

/**
 * The review after one sync. With no `open` review, revision 1. When the head moved, the new tip is taken, the revision
 * goes up and `updatedAt` too, so a review whose notes were sent reads `updated`. When only the words or the base
 * differ they are replaced and `updatedAt` stays, or sending notes (which edits the item) would mark the review
 * updated by itself. When nothing differs `open` itself comes back, which the caller reads as nothing to write. A
 * review with a decision is never reopened here.
 */
export function syncedReview(
  open: Review | undefined,
  facts: WorkReviewFacts,
  work: WorkRef,
  id: string,
  now: number
): Review {
  const title = cleanLine(facts.title, MAX_TITLE_CHARS) || workKey(work.number);
  const walkthrough = cleanText(facts.walkthrough, MAX_WALKTHROUGH_CHARS);
  const fields = {
    owner: facts.owner,
    ...storedSource({ kind: 'work', work }),
    title,
    walkthrough,
    repoRoot: facts.repoRoot,
    project: facts.project,
    branch: facts.branch,
    base: facts.base,
  };
  if (!open) return { id, ...fields, headSha: facts.headSha, revision: 1, notes: [], createdAt: now, updatedAt: now };
  if (open.decision) return open;
  if (open.headSha !== facts.headSha)
    return {
      ...open,
      ...fields,
      headSha: facts.headSha,
      revision: open.revision + 1,
      updatedAt: Math.max(now, open.updatedAt + 1),
    };
  const same = (Object.keys(fields) as (keyof typeof fields)[]).every((k) => open[k] === fields[k]);
  return same ? open : { ...open, ...fields };
}

/**
 * The walkthrough of a work review, from the item alone: the agent's latest word on it (its report, or the question it
 * asked, whichever is newer), then the item's description, then the pull request.
 */
export function walkthroughOf(item: WorkItem): string {
  const said =
    item.needs && (!item.outcome || item.needs.at >= item.outcome.at)
      ? { head: 'The agent asked', text: item.needs.question }
      : item.outcome
        ? { head: "The agent's report", text: item.outcome.text }
        : null;
  const parts = [
    said ? `## ${said.head}\n\n${said.text}` : '',
    item.description ? `## ${workKey(item.number)}: ${item.title}\n\n${item.description}` : '',
    item.pr ? `Pull request: ${item.pr.url}` : '',
  ];
  return parts.filter(Boolean).join('\n\n');
}
