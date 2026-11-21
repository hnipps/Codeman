# Intent: W-70 I8 revision 2, what Approve closes, made exact

**Status:** Draft (second revision of one invariant, after an independent check of the option B code on 2026-11-21)

**Supersedes:** `intent/2026-11-21-w70-i8-waiting-work.md` (merged as 7f623c63), whole. That file revised the I8 section of `intent/2026-11-18-w70-in-progress-owner.md`; every other part of the 2026-11-18 spec stands.

**What changes from revision 1.** An independent check of the code found three gaps in it. (1) Its (a) closed any In progress item linking S, so an item another session picked up after Request changes would be closed under it; (a) now requires the item to be assigned to S. (2) Its "Not closed" list kept open a Human required item "whose question someone else asked", which contradicted (c): the usual release-before-approve, S ending while its pull request waits, gives the item a question Codeman wrote. (c) now says those close. (3) It did not say that work a routine run left behind is out of reach; Non-goals now does. (4) A second check found that (a) and (b), read off the current state alone, still closed items others had changed since: a question survives a move or a reassignment, so an item the person took, parked and brought back, or another session moved, still carried S's question. Every case now also requires the item's newest history line to be S's own write. Everything else is unchanged.

## Problem statement

I8 moves to Done only the **In progress** items that link the session whose review was approved. A builder that finishes rarely leaves its item there:

- **It asks for review.** The usual finish is `report` with outcome `ask` ("PR #93 is ready for your review and merge"). That moves the item to **Human required** with a question the session asked. W-91 is the example: its own builder, session `0adc4c38`, asked that question, so approving PR #93 under the merged I8 would close nothing, W-91 included.
- **It ended first.** If the session exits before the person approves, the W-70 release (I2) moves the item back where it came from, often **Ready for work**. Approve then skips it, and R-2 may pick the merged work up and build it again. This was pr-swarm's MEDIUM finding on PR #93 (`src/canvas/work.ts:887`).

So in the common flow the board keeps merged work open, and a person closes it by hand.

## Outcomes

1. Approving a session's review closes the work that session left waiting for that review, whichever of the three ways it left it.
2. Nothing else is closed. An item a person or another session has acted on since is left as it is.

## I8 (revised): SessionReviewApproveClosesWaitingWork

Approve that merges a review written by session S moves to Done each item that is not closed, whose `sessions` include S, whose newest history line S wrote (every write logs a line with its author, so nobody else has changed the item since S's last write), and that is in one of these states:

- (a) **In progress and assigned to S**. The merged I8 closed any In progress item linking S; this one does not close an item another session or the person has picked up since; or
- (b) **Human required** with an open question that S asked (`needs.sessionId === S`); or
- (c) released by S: its newest history line is the I2 release `Released: session S ...`, which I2 writes as S. This holds whatever status and question the release gave it. When S ends while the item's pull request waits, I2 moves it to Human required with a question Codeman wrote ("has pull request ... waiting"), and the I4 second release asks one too; those items close, because the question was only asking for this Approve.

The history line stays `Done: review <id> merged <sha7>`. When Done clears an open question or requested changes, a line `Cleared its question` / `Cleared its requested changes` is written just before it. Any other item is left as it is. The move is idempotent.

- *Why:* W-91 and the release-before-approve finding above. Each state is one S put the item in itself, and the author check is what shows nobody has changed it since. That is what makes the close safe without guessing.
- *Not closed:* an item S only linked (a follow-up or idea it filed in Backlog or Needs refinement); an In progress item held by another session or the person; a Human required item whose question another session or a person asked, other than a release of S as in (c); an item whose question a person answered (answering clears `needs` and moves it to Needs refinement); an item released by another session, including one whose id starts with S's; any item a person or another session wrote to after S's last write, whatever its state: a move (including out to Backlog and back), a reassignment, a comment, a link or a pull request; an item the person assigned to S that S never wrote to (unless it was then released when S ended: I2 writes that release as S, so it counts as S's write and (c) closes it, which is the release-before-approve case this revision exists for); an item Ready, Backlog or Needs refinement for any other reason.
- *Test:* a review written by S, and items linking S in each of (a), (b) and (c), (c) both with and without a waiting pull request, plus each "not closed" case above, including a question S asked that survives the person taking the item, another session moving it and back, the person parking it in Backlog and back, and a person's comment. After Approve, exactly (a), (b) and (c) are Done. (b) and (c) are also checked through the Approve route. A failed merge closes nothing. A second call changes nothing.

## How this was checked

- *Formal: proved.* [`2026-11-21-w70-i8-model.dfy`](2026-11-21-w70-i8-model.dfy) models one item and every kind of write the code makes to it, with the author of each history line: a claim from any open status, a move to any status by anyone (keeping the question and assignee, as `setStatus` does), a reassignment in any status, a report `ask`, a session's release and a routine run's release to wherever the item came from (I2, with and without a waiting pull request), Request changes (I6), an answer, a comment, a pull request, and linking and unlinking a session. `WaitsOn` is this revision's rule, as `waitsOnSessionReview()` implements it. Dafny 4.11.0 verifies it, 22 verified and 0 errors, and `dafny audit` reports 0 findings. It proves:
  - *Every change is signed* (`EveryChangeIsSigned`): any write that changes the item logs a line authored by whoever made it, so the item's state is the one its newest line's author left.
  - *Sound* (`I8_AnyOtherWriteKeepsItOpen`, `I8_ClosesOnlyWhatSLeft`): after any write by someone other than S, Approve of S's review leaves the item alone; whenever it closes one, S's write is the newest.
  - *Complete where it should be* (`I8_ClosesWhatSJustLeft`): S's claim, question or exit, whenever it took effect, leaves the item waiting on S's review.
  - *Idempotent* (`I8_Idempotent`): a closed item never matches again.
  - *An assigned item S never touched* (`AssignedThenReleasedCloses`): once I2 releases it as S, (c) closes it; before that (`AssignedButUntouched`) it stays open.
  - *The second check's findings, as counterexamples to the state-only reading:* the person takes an item S asked about (`P1_PersonTakesAskedItem`), another session moves it to In progress and back (`P2_OtherSessionMovesItBackAndForth`), the person parks it in Backlog and back (`P3_PersonParksAndReturnsIt`), and the person assigns S an item S never touches (`AssignedButUntouched`). Each matches the three states and stays open under this rule.
  - *Revision 1's gaps, as counterexamples:* it closes another session's live item after Request changes (`Gap1_Rev1ClosesAnotherSessionsWork`); its (c) and its "not closed" list both apply to the pull-request release (`Gap2_Rev1ContradictsItself`); a run's release is out of reach of both revisions (`Gap3_RunWorkIsOutOfReach`).
  - *One rule for all three* (`CommentAfterAnyOfThemKeepsItOpen`): a person's comment after S's claim, question or release keeps the item open. The first model of this revision found that only the release behaved that way; the author check makes the three alike.
- *Mutation check.* Dropping the author check from `WaitsOn` fails 7 proofs (soundness and every counterexample above). In the tests, the same mutation fails the case that covers the five new "not closed" items.
- *What this does not cover.* One item at a time, and the model is not the TypeScript: the link is the citations in the model and the tests in `test/review-approve.test.ts`, which build each case through the real `reportWork`, `releaseFor`/`applyRelease` and `updateWork`, and the Approve route. History truncation, timing and `expectedRevision` races are outside it.

## Constraints

- The decision is read from the item alone (status, assignee, `needs.sessionId`, and the newest history line with its author). No new stored field, no link to the review store.
- Placement and reporting are unchanged from PR #93's fixes: the close runs synchronously right after the merge is recorded, before Approve's first await, and the response's `linkedWork` lists the keys closed and any that could not be written.
- Work reviews keep their own path (`workReviews.accepted`). A work review has no author session, so the two never act on one review.

## Non-goals

- **Work a routine run left behind.** When a routine run's session ends without reporting, I2 writes `Released: run <id>` and unlinks that session, so nothing ties the item to the review any more. R-2's runs report `ask` before they end, which (b) covers. Closing the rest would need the run's session written into the release line, a change to I2 and I4 that this revision leaves out.

## Open questions

None. The owner chose option B over leaving I8 as is (A), closing every open linked item (C), holding the item In progress while a review waits (D) and a pickup-only guard (E).

## Tickets

One: it rides on W-91 (PR #93), which carries I8 and is not merged yet. The code waits for this spec's approval before PR #93 is approved.
