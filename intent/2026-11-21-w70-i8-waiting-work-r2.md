# Intent: W-70 I8 revision 2, what Approve closes, made exact

**Status:** Draft (second revision of one invariant, after an independent check of the option B code on 2026-11-21)

**Supersedes:** `intent/2026-11-21-w70-i8-waiting-work.md` (merged as 7f623c63), whole. That file revised the I8 section of `intent/2026-11-18-w70-in-progress-owner.md`; every other part of the 2026-11-18 spec stands.

**What changes from revision 1.** An independent check of the code found three gaps in it. (1) Its (a) closed any In progress item linking S, so an item another session picked up after Request changes would be closed under it; (a) now requires the item to be assigned to S. (2) Its "Not closed" list kept open a Human required item "whose question someone else asked", which contradicted (c): the usual release-before-approve, S ending while its pull request waits, gives the item a question Codeman wrote. (c) now says those close. (3) It did not say that work a routine run left behind is out of reach; Non-goals now does. Everything else is unchanged.

## Problem statement

I8 moves to Done only the **In progress** items that link the session whose review was approved. A builder that finishes rarely leaves its item there:

- **It asks for review.** The usual finish is `report` with outcome `ask` ("PR #93 is ready for your review and merge"). That moves the item to **Human required** with a question the session asked. W-91 is the example: its own builder, session `0adc4c38`, asked that question, so approving PR #93 under the merged I8 would close nothing, W-91 included.
- **It ended first.** If the session exits before the person approves, the W-70 release (I2) moves the item back where it came from, often **Ready for work**. Approve then skips it, and R-2 may pick the merged work up and build it again. This was pr-swarm's MEDIUM finding on PR #93 (`src/canvas/work.ts:887`).

So in the common flow the board keeps merged work open, and a person closes it by hand.

## Outcomes

1. Approving a session's review closes the work that session left waiting for that review, whichever of the three ways it left it.
2. Nothing else is closed. An item a person or another session has acted on since is left as it is.

## I8 (revised): SessionReviewApproveClosesWaitingWork

Approve that merges a review written by session S moves to Done each item that is not closed, whose `sessions` include S, and that is in one of these states:

- (a) **In progress and assigned to S**. The merged I8 closed any In progress item linking S; this one does not close an item another session or the person has picked up since; or
- (b) **Human required** with an open question that S asked (`needs.sessionId === S`); or
- (c) released by S: its newest history line is the I2 release `Released: session S ...`, so nothing has happened to it since. This holds whatever status and question the release gave it. When S ends while the item's pull request waits, I2 moves it to Human required with a question Codeman wrote ("has pull request ... waiting"), and the I4 second release asks one too; those items close, because the question was only asking for this Approve.

The history line stays `Done: review <id> merged <sha7>`. When Done clears an open question or requested changes, a line `Cleared its question` / `Cleared its requested changes` is written just before it. Any other item is left as it is. The move is idempotent.

- *Why:* W-91 and the release-before-approve finding above. Each state is one S put the item in itself, and that nobody has changed since. That is what makes the close safe without guessing.
- *Not closed:* an item S only linked (a follow-up or idea it filed in Backlog or Needs refinement); an In progress item held by another session or the person; a Human required item whose question another session or a person asked, other than a release of S as in (c); an item whose question a person answered (answering clears `needs` and moves it to Needs refinement); an item released by another session, including one whose id starts with S's; a released item someone touched since (the release line is no longer newest); an item Ready, Backlog or Needs refinement for any other reason.
- *Test:* a review written by S, and items linking S in each of (a), (b) and (c), (c) both with and without a waiting pull request, plus each "not closed" case above. After Approve, exactly (a), (b) and (c) are Done. (b) and (c) are also checked through the Approve route. A failed merge closes nothing. A second call changes nothing.

## Constraints

- The decision is read from the item alone (status, `needs.sessionId`, newest history line). No new stored field, no link to the review store.
- Placement and reporting are unchanged from PR #93's fixes: the close runs synchronously right after the merge is recorded, before Approve's first await, and the response's `linkedWork` lists the keys closed and any that could not be written.
- Work reviews keep their own path (`workReviews.accepted`). A work review has no author session, so the two never act on one review.

## Non-goals

- **Work a routine run left behind.** When a routine run's session ends without reporting, I2 writes `Released: run <id>` and unlinks that session, so nothing ties the item to the review any more. R-2's runs report `ask` before they end, which (b) covers. Closing the rest would need the run's session written into the release line, a change to I2 and I4 that this revision leaves out.

## Open questions

None. The owner chose option B over leaving I8 as is (A), closing every open linked item (C), holding the item In progress while a review waits (D) and a pickup-only guard (E).

## Tickets

One: it rides on W-91 (PR #93), which carries I8 and is not merged yet. The code waits for this spec's approval before PR #93 is approved.
