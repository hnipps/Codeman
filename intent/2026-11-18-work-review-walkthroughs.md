# Intent: Agent-written walkthroughs and screenshots on work reviews

**Status:** Draft

## Problem statement

Most reviews on the Reviews page come from Work items that the Build routine (R-2) carries to a pull request. The server makes those reviews from the item (`src/reviews/work-reviews.ts`), and nothing an agent writes reaches them.

- The walkthrough is `walkthroughOf(item)`: the item's open question, its description and the pull request link. On 2026-11-18 all five waiting work reviews opened with "The agent asked: PR https://github.com/hnipps/Codeman/pull/NN is ready for your review and merge." It came from the routine's closing question. The item's own brief followed. Nothing said what was built, why that way, or where to look.
- No work review has ever had a screenshot. Screenshots reach a review only through `codeman agent review submit --capture`. The capture route admits only the review's author session, and a work review has none (`authorSessionId()` is null).
- Notes sent with Request changes go to the item, and the routine picks the item up again. Its brief says to push fixes to the same branch. It does not say to answer the notes on the review. On 2026-11-18, W-49 had a note sent 19 hours earlier and a second note asking "did you respond to my previous note?"

The owner reviews the ticket, not the work.

## Proposed outcome

A work review opens on the agent's own walkthrough and screenshots of the change. The item's text is one press away, never in the same pane as the walkthrough.

- The agent that built the item runs `codeman agent review submit` (or MCP `submit_review`) on its branch, as any session can today. When the branch is the pull request branch of an open Work item that links the session, the submission writes into that item's work review. No second review is made.
- The walkthrough column holds only the agent's walkthrough, with its byline. The item's text (its open question, description and pull request link) moves to a "Work item" tab on the stage, beside Preview, Captures and Changes. That tab is never the one a review opens on. A work review that has no agent walkthrough says so plainly in the column and points to the tab. The routine's closing question is not dressed up as the walkthrough.
- Captures from that session land on the work review. A UI change arrives with at least one screenshot.
- A resubmission after Request changes moves the review to "updated", so the owner can see the notes were answered.
- The Build routine's brief gains the submit step, both for a first build and for a revision.

## Affected users and systems

- The owner, on the Reviews page.
- The Build routine (R-2) and any agent that builds a Work item with a pull request.
- `src/reviews/review-model.ts`, `work-review-model.ts`, `work-reviews.ts`, `routes/review-routes.ts`, `reviews.js`, and the routine's prompt in the canvas workspace.

## Constraints

- Self-building rule 5. `ReviewSchema` is strict, so the release before the one that writes a new key must already read it. That means two releases: the first only reads the key, the second writes it.
- The tracker still decides whether a work review waits (`wanted()`). An agent submission never makes a work review exist, and never reopens a decided one.
- Only a session linked to the item writes its walkthrough or captures. No new way for a session to reach a review it did not build.
- The item's synced text stays the tracker's, so no sync ever overwrites what the agent wrote.
- A person's press is still the only thing that sends notes, merges or deploys.

## Open questions

- An agent that submits before it sets `pr` on the item makes an ordinary session review. Once `pr` is set the item's work review appears beside it, so there are two. The spec avoids this through the order in the brief and leaves a server-side fold for later.
