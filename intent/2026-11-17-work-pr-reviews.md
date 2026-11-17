# Intent: Work item pull requests on the Reviews page

**Status:** Draft

## Problem statement

The owner judges finished agent work on the Reviews page. Canvas Work items are built by an agent routine that pushes a branch and opens a GitHub pull request, and nothing brings that pull request to the page: a review exists only when a session submits one (`codeman agent review submit`, MCP `submit_review`), and the routine's run has ended by the time the work is ready. The owner has to go to GitHub to read the change and has no way to send notes back to the item.

## Proposed outcome

A Work item that carries a pull request on a branch, and is not closed, has a review on the Reviews page.

- An item gets `pr: { url, branch?, base? }` (W-51). People set it on the item's panel or by `PATCH`; agents set it with `canvas_work`. A bare https URL is accepted as `{ url }`; `pr: null` clears it. The card shows a PR chip and the panel a link.
- The server makes and updates the review itself (`src/reviews/work-reviews.ts`): when the item is written, once after boot, when the review's page is read (at most one fetch a minute), and before Approve. The head is read from `origin` only, after a fetch of that one branch, so a stale local branch of the same name never shows or merges.
- The review is identified by the item and the pull request: its id is derived from both, and its stored `sessionId` is `work:<workspaceId>:<n>`, so no key is added to the review file and the previous release still reads it (self-building rule 5).
- Whether the review waits for the owner is the tracker's answer, read at each list: closing the item or clearing its pull request hides the review without deleting it.
- **Request changes** on a work review puts the notes on the item (`changes`), clears any question, and moves it to the top of Ready for work, where the pickup routine finds it. It pastes into no session. The agent's next report clears `changes`.
- **Approve** fetches, refuses a tip that moved since the page showed it, merges what `origin` has into the base and marks the item Done. GitHub sees the branch merged and closes the pull request on its own. No GitHub API is called.
- The page names the item (W-n) in the queue row, the header, the byline, the Request changes button, its toast and the Approve confirmation, and says that a pull request has no running preview here. The canvas item panel links to the waiting review.

## Affected users and systems

- The owner, on the Reviews page and in the canvas Work view.
- Agent routines that build Work items: they set `pr` instead of submitting a review, and read `changesRequested` in the item brief.
- `src/canvas/work.ts`, `work-store.ts`, `src/reviews/*`, `routes/review-routes.ts`, `reviews.{html,js,css}`, `packages/canvas/src/{reviews,work-view}.ts`, MCP `canvas_work`.

## Constraints

- Rule 5: no new key on the strict review schema; the work item keys (`pr`, `changes`) pass through the previous release's schema.
- Rule 6: the review module writes the data dir without a request, so it checks `deployRole.allows('persist')` at each write.
- Git never runs for a remote or Docker case, nor at or inside a Docker case workspace; the case folder is probed bounded.
- The fetch is the existing non-interactive, timed runner. Nothing fetches on a timer or on the polled queue read. No `gh`.
- A person's press is still the only thing that sends notes, merges or deploys.
- Checked 2026-11-17 with a throwaway draft PR: when Approve pushes a merge commit whose second parent is the PR head, GitHub marks the PR merged (a draft too) and records that commit as its merge commit. The repository deletes a merged PR's head branch on its own.

## Open questions

- An item whose pull request lives in a repository other than its case's is not reviewable; it reports `NO_BRANCH` and shows nothing.
- A crash between recording the merge and marking the item Done is repaired on the next sync of that item (an item write, a page read or the boot pass), not immediately.
