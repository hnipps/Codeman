# Spec: agent-written walkthroughs and screenshots on work reviews

Intent: [intent/2026-11-18-work-review-walkthroughs.md](../intent/2026-11-18-work-review-walkthroughs.md). This spec says what to build and in what order, and how each part is checked.

## Today

A work review is the review the server makes for a Work item that has `pr.branch` and is not closed. Three facts from the code drive this spec.

1. `syncedReview()` in `src/reviews/work-review-model.ts` sets `walkthrough` to `walkthroughOf(item)` on every sync. Anything else stored in `walkthrough` would be overwritten at the next item write.
2. `POST /api/reviews` in `src/web/routes/review-routes.ts` finds an open review with `sameWork(r, session.id, facts)`. A work review's `sessionId` is `work:<workspaceId>:<n>`, so it never matches, and the agent gets a separate session review.
3. `PUT /api/reviews/:id/captures/:name` admits only `authorSessionId(review)`, which is null for a work review. No session can add a capture to one.

## The data

One optional key on `Review`, written only on a work review:

```ts
authored?: {
  sessionId: string;     // the session that submitted, linked to the item
  sessionName: string;
  walkthrough: string;   // cleaned like any walkthrough, at most MAX_WALKTHROUGH_CHARS
  headSha: string;       // the origin tip the agent wrote it for
  at: number;            // when it was submitted
}
```

`walkthrough` keeps its meaning for a work review. It is the item's text, owned by the tracker and replaced at each sync. `authored` is the agent's text, written only by a submission. The two never overwrite each other, so `syncedReview()` needs no change beyond carrying `authored` through. The existing `captures` key holds the screenshots, as it does for a session review.

`authored` is a separate key and not a reuse of `walkthrough`. Reusing it needs a marker for "the agent wrote this", and the strict schema has no free key to carry one. A sync that saw no marker would then wipe the agent's text.

## Rules

**Which review a submission writes.** `POST /api/reviews` resolves the target before the session-review path. After `repoFacts()`, it looks for open Work items in the owner's workspaces where all of these hold:

- `item.pr.branch === facts.branch`;
- the item's case repository has the same git common dir as `facts.repoRoot`, so a worktree and the main clone count as one repository;
- `item.sessions` includes the calling session;
- the work review `workReviewId(work, item.pr.url)` exists and is not decided.

With exactly one match, the submission writes that work review. With none, the route makes or updates a session review exactly as today. With more than one, it refuses with 409 and names the items. A branch that is the pull request of an item the session is NOT linked to is refused (403, naming the item). That stops a stray session on the same branch from writing someone else's walkthrough. An agent that should write it links itself first with `canvas_work update`.

**Pushed work only.** Before writing, the route fetches the branch the way `sync` does (`fetchOnce`) and compares `origin/<branch>` with the session's local head. If they differ, the submission is refused (409 `UNPUSHED`, "push the branch, then submit"). A walkthrough never describes commits the reviewer cannot see. Then `sync(work)` runs, so the review's `headSha` and `authored.headSha` are the same commit.

**What a submission changes.** A pure `authorWorkReview(review, input, author, headSha, now)` in `work-review-model.ts`:

- sets `authored` to the cleaned walkthrough, the author and `headSha`;
- applies `input.captures` to `captures` exactly as `submitReview()` does (named ones kept, the rest dropped with their files);
- bumps `updatedAt`, so a review whose notes were sent reads `updated`;
- never touches `title`, `walkthrough`, `notes`, `decision` or `revision`. The revision still counts branch heads, as it does for every work review. A decided review is refused upstream and never reaches here.

**Who may add a capture.** The capture route admits `authorSessionId(review)` as today, or, on a work review, `review.authored?.sessionId`. No other session. A capture upload never creates `authored`, so a session must submit a walkthrough before its screenshots are accepted.

**Reading.** `toView()` passes `authored` through. `walkthroughOf()` stays as it is. The item's open question can be a real one (a blocked build asks something), so it is never dropped. It moves under the fold once the agent has written a walkthrough.

## The page

In `src/web/public/reviews.js`:

- With `authored`, the walkthrough column renders `authored.walkthrough` (same sanitizer and link handling) under the byline "Walkthrough by <sessionName>". The item's text follows in a closed `<details>` titled "Work item W-n". Capture links and capture notes work as on a session review.
- When `authored.headSha !== review.headSha`, the notice says "The branch has new commits since this walkthrough was written." The existing moved-branch notice reads the same, so this is one notice with a second trigger.
- Without `authored`, the column shows a one-line notice above the item text: "No walkthrough from the agent yet. This is the work item." Nothing else changes.

## The Build routine

The routine (R-2, "Build Ready items (poteto-mode)") lives in the canvas workspace, not in the repository. After release 2 is live, its prompt changes in two places.

- Step 4: for a change a person can see, take screenshots of the throwaway server with `deviceScaleFactor: 1`, one per state that matters.
- Step 5, after `canvas_work update` sets `pr`: write `walkthrough.md` (what changed and why, where to look as `#code=` links, what was not verified) and run `codeman agent review submit --title "<item title>" --file walkthrough.md --capture <name>=<png>` from the build branch. Then report as today.
- Revision path (step 1): after pushing the fixes, submit again. The walkthrough opens with one line per note sent in `changes`, saying what was done about it.

The order matters. `pr` must be set before the submit, or the submit makes a session review (see the open question in the intent).

## Order of work

Each release is one PR, verified before the next.

1. **Release 1: read only.** `ReviewSchema` accepts `authored`. `toView()` passes it through, and the page renders it when present. Nothing writes it. Tests: a review file with `authored` parses, and the previous shape still parses. A route read of such a file returns it. Deploy this before release 2. Rule 5 then holds for release 2, since release 1 reads everything release 2 writes.
2. **Release 2: write.** The resolver in `POST /api/reviews`, `authorWorkReview()`, the capture route rule and the "no walkthrough yet" notice. Tests, in `test/review-*.test.ts`:
   - A linked session's submit on the item's branch writes `authored` on the work review and makes no session review.
   - An unlinked session on that branch gets 403. An unpushed head gets 409 `UNPUSHED`.
   - A sync after the item is edited keeps `authored` unchanged.
   - Captures from the authoring session land on the work review, and any other session gets 403.
   - After Request changes, a resubmission reads `updated`.
   - A decided work review refuses the submission.
   - Browser check against a throwaway instance: the page shows the agent text first and the item folded.
3. **Routine prompt.** Edit R-2's prompt as above. Check: the next Ready item it builds arrives on the Reviews page with an agent walkthrough and at least one capture for a UI change.
4. **Docs.** `docs/architecture-invariants.md#reviews-page` gains the `authored` rules. The JOURNAL entry of 2026-11-18 records why a separate key.

## Done when

- A Build routine run ends with a work review whose walkthrough the agent wrote, with screenshots when the change is visible.
- A Request changes round ends with the review in `updated` and a walkthrough that answers each note.
- No work review presents the item's text as if the agent wrote it. It is either folded under the agent's walkthrough or labelled as the work item.
