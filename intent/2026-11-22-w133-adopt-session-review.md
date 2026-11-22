# Intent: a work review takes over a session review of the same branch

**Status:** Draft

## Problem statement

An agent that runs `codeman agent review submit` before it sets the Work item's `pr` gets a session review. When it then sets `pr`, `sync` makes a work review for the same branch without looking at that session review, so the Reviews page shows two open reviews of one branch. This happened on W-120 on 2026-11-21 (session review 5b943676, work review 8b210710).

## Proposed outcome

At most one open review per repository and branch, whichever order the agent uses. When `sync` makes a new work review, it takes over the owner's undecided session reviews of the same branch in the same repository (matched by git common dir, since a session review records its worktree). The newest one's walkthrough becomes `authored` and its Request changes stamp comes across; the notes and stills of every match come across. Every match closes with `closedBy` naming the work review, and the closed review's page says where it went.

## Affected users and systems

The owner reading the Reviews page. Agents that submit walkthroughs (Build routine R-2). `src/reviews/work-reviews.ts`, `work-review-model.ts`, `review-store.ts`, `review-model.ts`, the review page route and `reviews.js`.

## Constraints

No new stored key (self-building rule 5): the close uses the existing `closedBy`, and a takeover is told apart from an Approve's close by the work review's `createdAt` equalling the close's `at`. The work review is written and the session reviews are closed in the same no-await tick as the existing write, so two syncs cannot take it over twice. No note is dropped.

## Open questions

- A submit that lands as a session review after the work review already exists (it read the items before `pr` was set) still leaves two open reviews. Taking over on an existing work review would also merge notes into a review that has its own, so it is left out of this change.
