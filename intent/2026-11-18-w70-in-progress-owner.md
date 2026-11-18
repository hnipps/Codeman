# Intent: W-70 In progress always has a live owner

**Status:** Draft (spec for W-70, under `intent/2026-11-18-spec-first-lifecycle.md`; revision 1)

## Problem statement

The Work board can say an item is In progress when nobody is working on it. On 2026-11-18 four items sat In progress, and none of them was moving:

- **W-61.** R-2 claimed it at 19:02:47 and started a run. A deploy switched colours two seconds later. The session was created by build `9c3641fa` (pid 2063570) and restored by build `ceabe5b8` (pid 2099175) at 19:02:48.9. So the run's prompt was never delivered: its message is `failed`, `deliveredAt: null`, and the session shows 0 tokens. The task read `failed`, but the item stayed In progress and assigned to that session for two hours. The claim is written once, when the run starts (`claim()` in `src/web/routine-runner.ts`). Only the agent's own `report` ever releases it.
- **W-56.** An interactive session created it straight into In progress, with nobody assigned. Its PR #69 was named only in the description, so `pr` was never set. PR #69 merged on 2026-11-17 at 21:14 through its session review, and nothing closed the item.
- **W-66.** Request changes moved it to Ready for work but left its finished builder assigned. R-2 picks up only unassigned items, so nothing took the revision for 36 minutes, until another session claimed it by hand.
- **W-22.** A parent item, In progress and unassigned while its tickets move. Today that is correct only because someone set it by hand. Nothing moves it once its tickets close.

These have one cause. In progress is a bare status, and nothing ties it to someone doing the work. "An agent is on this" and "someone once said an agent was on this" look the same on the board.

## Outcomes

1. An item is In progress only while it has an owner: a person, a live session, or tickets of its own that are still open.
2. When a routine run that holds an item ends without reporting, the item goes back on its own within one routine tick (30 s). It never needs a person to notice it.
3. A release that keeps failing stops and asks Harry. It does not spin up a new run every 30 seconds.
4. Request changes hands the revision to the pickup routine.
5. A parent item closes when its tickets are all done.
6. Approving a session review closes the In progress items that session is linked to.

## Constraints

- **Self-building rule 5.** `work.json` stays readable by the release before this one. No new stored status and no new item key. The release count is read from history, not stored.
- **Rule 6, live colour only.** Every release is a write through `changeWork()` under `mayAutomate()`.
- **The 8 GiB host.** No new timer and no new process. The release runs inside the routine runner's existing 30-second tick and reads the task list that tick already fetches.
- **Fail closed.** An owner whose state cannot be read counts as live. A task list that cannot be read, a session map not yet restored after boot (before `markRestorationComplete()`, `server.ts:4543`), or a pane whose exit state is unknown never releases anything.
- **Rules live in `work.ts`.** The owner rule and the release decision are pure functions there. The runner supplies only the facts.
- **No id-branching** on a CLI id. Routine runs are recognised by `startedBy.kind === 'routine'`, as the runner already does.
- **`canvas_capabilities` is at its 60 KB cap.** Nothing is added to it. The `canvas_work` tool description changes one sentence.

## Data shape

```ts
/** Who keeps an item In progress, as the server sees it at one moment. */
type Owner =
  | { kind: 'person' }                                     // assignee {kind:'person'}
  | { kind: 'run'; runId: string; taskId: string; state: TaskState }   // assignee is a routine run's session
  | { kind: 'session'; sessionId: string; state: 'live' | 'exited' | 'gone' | 'unknown' }
  | { kind: 'tickets'; open: number[] }                    // no assignee; items createdFrom it that are not closed
  | { kind: 'none' };

/** The pure decision. `ownerOf` is the runner's facts; the result is the one write to make, or null. */
function releaseFor(item: WorkItem, file: WorkFile, ownerOf: (item: WorkItem) => Owner): Release | null;
type Release =
  | { to: WorkStatus; reason: string }                     // back where it came from
  | { to: 'human-required'; question: string }             // second release in a row, or an open PR
  | { to: 'done'; reason: string };                        // a parent whose tickets are all Done
```

`Owner` is derived every tick and never stored. Its liveness facts come from the same places the task list already reads them: `deriveTaskState()` for a run, and `session ? (paneExit ? 'exited' : 'live') : 'gone'` for a session (`canvas-conversation-routes.ts:125`).

## Invariants

## I1: InProgressHasAnOwner

No write leaves an item In progress with no assignee and no open tickets.
- A person who moves an unassigned item into In progress becomes its assignee (`{kind: 'person'}`).
- An agent who does so becomes the assignee (its own session).
- Unassigning an In progress item, or unlinking its assignee's session, is refused unless the same write moves it out of In progress.
- `create` into In progress follows the same rule.

- *Why:* W-56 was created into In progress with nobody assigned, so nothing could ever tell that its owner was gone.
- *Test:* for each write path (`create`, `update` status, `update` assignee null, `unlinkSessions` of the assignee, `report continue`) and each author kind, assert the stored item is never In progress with `assignee: null` and no open tickets.

## I2: EndedRunReleasesItsItem

An In progress item whose assignee is the session of a routine run, and whose task is not active (`failed`, `cancelled`, or `completed`), is released on the next tick.
- With no `pr`, or with `pr` and unaddressed `changes`, it returns to the status it entered In progress from (the newest `Moved from <A> to In progress` event). If that status is Ready for work, it goes to position 1.
- With a `pr` and no pending `changes`, it goes to Human required. The question names the run and the PR.
- The assignee is cleared and the run's session is unlinked. History reads `Released: run <runId> ended without a report`.

- *Why:* W-61. Moving it back into Ready fires R-2's trigger again, which is what moved W-61 on 2026-11-18 when it was done by hand.
- *Test:* an item claimed by a run whose task is each of `failed`, `cancelled`, `completed`. One tick later it is in Ready at position 1, unassigned, with the history line. Repeat with `pr` set, and it lands in Human required with `needs`.

## I3: LiveOwnersAreNeverReleased

The release never touches an item whose owner is:
- a person;
- a run whose task is `queued`, `running` or `waiting`;
- a session that is live or `unknown`;
- open tickets.

An interactive session is released only when it is `gone` or `exited`, never because it is idle.

- *Why:* a person can leave a conversation idle for hours and come back. A task a person started can sit `completed` between replies. Releasing those would put a second agent on work someone is doing.
- *Test:* each of those owners, held for many ticks, produces no write. A session the restore has not reached yet counts as `unknown`.

## I4: RepeatedReleaseAsks

The second release of an item with no `report` and no person's move between them sends it to Human required, with the question "W-n was released twice: runs <a> and <b> ended without reporting. Send it back to Ready for work when the cause is fixed."

- *Why:* if every run fails the same way (a broken prompt, a broken worktree), releasing it into Ready would start a new run, worktree and session every tick.
- *Test:* two consecutive releases. The second lands in Human required with `needs`, and no third run is fired.

## I5: ReleaseIsIdempotent

Running the release twice on the same facts writes once. A release whose `expectedRevision` no longer matches is skipped until the next tick. A late `report` from a released run is applied as it would be today. Moving the item out of Ready again is the report's job, and nothing double-moves it.

- *Test:* call `releaseFor` on its own output. It returns null. A report arriving after a release succeeds and its history follows the release line.

## I6: ChangesRequestedUnassigns

Request changes on a work review clears the assignee as it moves the item to Ready for work. The finished session stays linked.

- *Why:* W-66. R-2 picks up only unassigned items. A work review's notes go to the item and to no session (`work-reviews.ts` `sendChanges`), so nobody else is working the revision.
- *Test:* an item with `pr` assigned to a session gets Request changes. It is in Ready at position 1 with `assignee: null`, the session is still in `sessions`, and a work-item trigger with `unassignedOnly` fires for it.

## I7: ParentFollowsItsTickets

An In progress item with no assignee is owned by the items created from it (`createdFrom`) that are not closed. When none are open:
- every ticket is Done: the parent moves to Done, with history `Done: all tickets done (W-a, W-b)`;
- otherwise (some ticket is Not doing or Deleted): it moves to Human required, asking whether it is done.

- *Why:* W-22's description already says "This item is Done when both tickets are." That is a rule, so the server should run it rather than rely on someone remembering.
- *Test:* a parent with two tickets. While either is open, nothing moves. When both are Done it is Done. When one is Not doing it is Human required with `needs`.

## I8: SessionReviewApproveClosesLinkedWork

Approve that merges a session review moves to Done every In progress item whose `sessions` include that review's session, with history `Done: review <id> merged <sha>`. Items in other statuses are left alone.

- *Why:* W-56. Its session review's Approve merged PR #69 and had no item to close, because the link lived only in prose. The review's session was already linked to the item.
- *Test:* a session review for session S, and items In progress, Human required and Ready that link S. After Approve only the In progress one is Done.

## Non-goals

- Releasing an item because its session has been idle. Idle is not ended (I3).
- Retrying a run's prompt after a deploy cuts its delivery. That is a separate item (filed beside this spec). This spec makes sure such a run's item does not stay stuck.
- A general transition table for all eight statuses. Today's guards (Backlog and Deleted exits, answered questions) are fine. Only In progress lacked one.
- Stored owner or lease fields. Owners are derived each tick.
- Changing the page. The lanes already show assignee and history. A released item reads as an ordinary move.

## Acceptance checks

1. `npm test -- test/canvas-work.test.ts test/canvas-routines.test.ts test/work-reviews.test.ts` passes. Each of I1 to I8 has one or more cases marked `// Invariant I<N>: <Name>`. Add a release test file only if the cases do not fit those.
2. On a throwaway instance (`CODEMAN_INSTANCE`, its own port), with `curl`:
   - Create a Ready item. Let a routine with `claim` pick it up, then cancel its task through `POST /api/canvas/<ws>/tasks/<id>/cancel`. Within 60 s the item is back in Ready, unassigned, with the `Released:` line, and a new run has claimed it.
   - Cancel that second run too. The item lands in Human required with the I4 question, and no third run starts.
   - `PATCH` an In progress item with `assignee: null` as an agent. It answers 400.
3. Restart the throwaway server while an item is claimed by a live run. Nothing is released during the restore, and the item is still held afterwards.

## Technical design

**Where the rule runs.** `RoutineRunner.tickWorkspace()` already reads the canvas's task list every 30 s (`runViews`), but it returns early when no routine is due. The release runs before that early return, for every workspace, when `mayAutomate()` is true and restoration is complete. It reads `work.json` once. It builds `ownerOf` from:
- the task list, extended to carry each task's `sessionId` (the brief list already has `startedBy` and `state`);
- a new runner dependency `sessionState(id)`, which returns `'live' | 'exited' | 'gone' | 'unknown'` from the server's session map, and `'unknown'` until `markRestorationComplete`.

For each item, `releaseFor()` decides, and the runner makes at most one `changeWork()` per item, guarded by `expectedRevision`. It then calls `announce(ws, {work: true})`. Moving the item into Ready is an ordinary status change, so the routine's existing `work-item` trigger fires on it in the same tick, or the next one.

**Write-side rule.** `createWork()`, `updateWork()` and `reportWork()` each end by checking I1 on the resulting item:
- auto-assign when the author moved an unassigned item into In progress;
- otherwise refuse with `INVALID_INPUT`: "W-n is In progress, so it needs an owner. Assign someone, or move it out of In progress in the same change."

The routine's own `claim()` already sets status and assignee in one write.

**Request changes.** `requestChangesOnWork()` sets `assignee = null` and logs `Unassigned`.

**Session review Approve.** The session-review Approve path in `review-routes.ts` calls a new pure `closeLinkedWork(file, sessionId, sha, ctx)` in `work.ts` for each workspace whose case contains the review's repository. Like Approve itself, it does nothing off the live colour.

**Rule text.** The `canvas_work` tool description (`src/mcp-server.ts:229`) currently says "Nothing moves an item by itself." That becomes: "Nothing moves an item by itself, except that an In progress item whose run ended without a report goes back where it came from, and a parent closes when its tickets do." The same change goes into `docs/architecture-invariants.md` "Canvas work" and "Canvas routines", `docs/subsystem-rules.md` "Canvas work", and the Canvas work line in `CLAUDE.md`.

**Modules touched.**
- `src/canvas/work.ts`: `Owner`, `releaseFor`, the I1 check, `closeLinkedWork`, and the Request changes unassign.
- `src/web/routine-runner.ts`: the release pass and the `sessionState` dependency.
- `src/web/routes/canvas-task-routes.ts`: `sessionId` on brief task rows.
- `src/web/routes/review-routes.ts` (session Approve) and `src/mcp-server.ts` (one sentence).
- The docs named above.
- Tests: `test/canvas-work.test.ts`, `test/canvas-routines.test.ts`, `test/work-reviews.test.ts`, `test/review-approve.test.ts`.

**Risks.**
- *A run that ends just after reporting.* The report lands first, so the item is no longer In progress and is skipped. If the release lands first, the report applies on top (I5). Either way the item ends where the report put it.
- *Existing items that break I1 on deploy.* W-22 is owned by its open tickets. Any unassigned In progress item with no tickets is released on the first tick back to where it came from, or to Needs refinement when it was created into In progress. This is the cleanup the board needs today.
- *A deploy that cuts deliveries* now produces one released item per cut run, then a fresh run. That is the intended recovery. If it repeats, I4 stops it at two.

## Decisions for Harry

1. **Where a released item goes.** Recommended: back to the status it came from (usually Ready, at the top), or Human required when it already has a PR. Alternative: always Human required. That is safer, but it puts every deploy hiccup in your queue.
2. **A parent with all tickets Done moves itself to Done (I7).** Recommended, because each ticket was already verified and reviewed. Alternative: always ask, as for a parent with a Not doing ticket.
3. **Approve of a session review closes the In progress items that link its session (I8).** Recommended, since it is exactly W-56. The risk is a session linked to two In progress items that only one review covers. That is rare, and the history line names the review. Alternative: leave I8 out, and close such items by hand.
4. **Two releases before asking (I4).** Recommended. One release covers a single deploy cut, and a second in a row means something is broken.

## Checks run

- I read the code paths named above on `origin/master` 3350db0a: `claim()`, `carryOut()` and `runViews()` in `routine-runner.ts`; `deriveTaskState()` in `tasks.ts`; `updateWork()`, `setStatus()`, `requestChangesOnWork()` and `approveWork()` in `work.ts`; `sendChanges()` in `work-reviews.ts`; and the delivery loop in `canvas-conversation-routes.ts`.
- The W-61 timeline comes from `server.jsonl` (build ids and pids at 19:02:46.9 and 19:02:48.9) and the task's message record in `conversations.json`.
- No crosscheck audit was run on these invariants. The review is the first check.

<details><summary>Tickets (2)</summary>

**Ticket 1: Owner rule and release on the server.** Order 1. No dependencies.
- I1 to I7: the write-side check, the release pass in the runner, `sessionState`, `sessionId` on brief task rows, the Request changes unassign, and the parent rule.
- The tool sentence and the docs.
- Acceptance checks 1 (minus I8), 2 and 3.

**Ticket 2: Approve of a session review closes linked work.** Order 2. Depends on ticket 1 for the shared history wording. Reviewable alone.
- I8, `closeLinkedWork`, and its tests in `test/review-approve.test.ts`.

</details>
