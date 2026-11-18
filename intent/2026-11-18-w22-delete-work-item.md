# Intent: W-22 delete a Work item (spec, pilot)

**Status:** Draft (spec for W-22, the pilot of `intent/2026-11-18-spec-first-lifecycle.md`)

## Problem statement

A canvas Work item can never be removed. A duplicate, a test item or a capture filed by mistake stays on the board for good. #52 shipped Not doing as the stand-in for delete, so today such an item sits in the Not doing lane forever, with its attached files still counted against the canvas quota.

## Outcomes

1. Harry can delete one Work item from its detail panel, on desktop and on a phone.
2. Before anything is removed, Harry sees what goes with the item and confirms. Keep, or Escape, leaves everything as it was.
3. After a delete, the item is gone from every lane, the outline's counts and `canvas_work list`, in every open tab.
4. The item's attached files are removed from disk and no longer count against the canvas quota.
5. A later read, update or report of the deleted key answers that the item was deleted, so an agent holding the key learns why.
6. A deleted key is never given to a new item.

## Constraints

- **Self-building rule 5.** After any delete, `work.json` stays readable by the release before this one (master 9c3641fa). `version` stays 1, stored statuses stay in the old five-value enum, and any new data is an unknown key that release passes through.
- **Rule 6, live colour only.** The delete route checks `deployRole.allows('persist')` before it reads anything, as the attachment routes do. Off the live colour it answers 409 and changes nothing.
- **The 8 GiB host.** No new background work: no sweep, timer or directory walk. The one filesystem change is removing the item's `work-files/<n>/` folder after the write.
- **No id-branching.** Nothing branches on a CLI id. The person-only check reads the request's author kind, as routines do.
- **Rules live in `work.ts`.** The refusal for an agent, the revision check and the tombstone are in the pure `deleteWork()`, not the route, so the HTTP route and any later caller hold the same rules.
- **`work.json` stays readable by this release too.** An unparsable or newer file is still reported (409 `FILE`) and never overwritten, delete included.
- **`canvas_capabilities` is at its 60 KB cap.** This change adds no tool and no `canvas_work` action, so that document does not grow.
- Strings from items reach the DOM through `textContent` only, as everywhere in the Work view.

## Invariants

## I1: DeletedKeyNeverReused

After any sequence of creates, splits and deletes, every item's number is unique among all items ever created in the workspace. Deleting an item, including the newest one, never lowers the file's `next`.

- *Why:* the Canvas work rules say keys are "never reused". Agents, routine marks, history lines and work review ids (`workReviewId`) all name items by number, so a reused number would attach old reviews and marks to a new item.
- *Test:* random create/split/delete sequences; after each step, assert `next` never decreases and no created number repeats.

## I2: OnlyAPersonDeletes

A delete whose author is an agent (a request carrying `X-Codeman-Parent-Session`, which sets `req.canvasAuthor`) is refused 403 and leaves `work.json` and the item's files byte-for-byte unchanged.

- *Why:* "Nothing moves an item by itself". A delete cannot be undone, and routines (W-44) already keep their own delete for a person (`PERSON_ONLY`).
- *Test:* route test with the agent header: 403, file bytes and attachment folder unchanged, no `canvas:changed` broadcast.

## I3: DeleteNeedsTheRevisionSeen

A delete names the revision the person saw. A delete without `expectedRevision` is refused 400; a stale one is refused 409 `CONFLICT`. Neither changes anything.

- *Why:* two tabs, or an agent editing the item, can change it between the press and the request. The person must delete what they read, as every other item write is guarded.
- *Test:* create, update (revision 2), delete with revision 1: 409 and the item is still there; delete with no revision: 400.

## I4: DeleteTouchesOnlyThatItem

A delete removes exactly one item. Every other item keeps its fields and its `revision`, including items whose `createdFrom` names the deleted one. The only other change to the file is that the number leaves `readyOrder` and a tombstone is added.

- *Why:* the reorder rule already says "only the moved item's revision changes". Bumping other items' revisions would make agents' and other tabs' `expectedRevision` writes fail for no visible reason.
- *Test:* random file; delete one item; diff every other item's JSON before and after: equal. `readyOrder` equals the old one without that number.

## I5: PreviousReleaseReadsTheFile

After any delete, the written `work.json` parses with the pre-change file schema (master 9c3641fa): `version` 1, stored statuses in `backlog`, `todo`, `in-progress`, `done`, `not-doing`, and the tombstones under a top-level key that schema passes through.

- *Why:* self-building rule 5, and the W-48 journal entry: the old schema "refuses a whole file over one unknown status and any version but 1".
- *Test:* a gate test parses the encoded file with a frozen copy of the 9c3641fa `WorkFileSchema` and asserts success and that the tombstone key survives its round trip.

## I6: RecordFirstThenBytes

An item's attached bytes are removed only after the delete was written. A refused delete (any code) removes no bytes. After a delete, the canvas quota counts only the attachments the remaining items record.

- *Why:* the W-42 rule "the record is the source of truth for what exists". Removing bytes first would leave a live item pointing at missing files if the write failed.
- *Test:* item with two attachments; a refused delete leaves both files on disk; an accepted one leaves `work-files/<n>/` absent and `attachedBytes()` lower by their sizes.

## I7: DeletedKeySaysDeleted

While its tombstone is kept, a read, update, report or attach of a deleted key answers 404 `NOT_FOUND` with a message saying the item was deleted and when. A number that was never issued still answers "does not exist".

- *Why:* routine runs and agents hold item keys across a long run (W-44 work-item triggers). "Does not exist" for a key they just read looks like a bug; "was deleted" tells them to stop.
- *Test:* delete W-n; GET, PATCH, report and attach each give 404 with "deleted" in the message; GET of `next` gives 404 with "does not exist".

## I8: DeletedItemLeavesTheReviewQueue

When an item with a pull request is deleted, its work review stops waiting on the Reviews page and its record is kept, unchanged. Nothing can bring that review back, since the number is never reused.

- *Why:* "Wanted is the tracker's": `wanted()` is already false for a missing item. This pins it for delete, so a review cannot sit in the queue for an item that is gone, and Approve on it answers 409 `GONE`.
- *Test:* item with `pr.branch` and a synced review; delete it; `queueOf` no longer lists it as waiting; the review file is byte-identical; Approve answers `GONE`.

## Non-goals

- Deleting from a card, a lane or the keyboard without opening the item. No Delete-key shortcut.
- Deleting several items at once.
- Undo, a trash lane, or a "recently deleted" view.
- An agent delete, or a `canvas_work delete` action.
- Changing Not doing. It stays the way to close an item and keep it.
- Removing anything from linked sessions, review records, routine records or canvas history.

## Acceptance checks

1. `npm test -- test/canvas-work.test.ts` passes, with one or more cases for each of I1 to I8, each marked `// Invariant I<N>: <Name>`.
2. On a throwaway instance (`CODEMAN_INSTANCE`, its own port), with `curl`:
   - create an item, attach a file, then `DELETE /api/canvas/<ws>/work/W-n?expectedRevision=<r>` answers 200 with `{ deleted: "W-n" }`;
   - `GET /api/canvas/<ws>/work/W-n` answers 404 and the message says it was deleted;
   - a new create gets W-(n+1) or later, never W-n;
   - the same DELETE with `X-Codeman-Parent-Session` answers 403; with a stale revision, 409;
   - the item's `work-files/<n>/` folder is gone.
3. The browser suite's `test/canvas-work.browser.test.ts` passes, run by hand on an idle host (not during a deploy), with new cases: delete from the detail at 1440px, Keep and Escape cancel, focus lands on the next card, and the phone layout at 390px.
4. By hand on the throwaway instance, desktop and phone: open an item, press Delete item, read the confirmation, press Keep (nothing changes), then confirm (the item leaves its lane and the notice says so). In a second tab with the same item open, the detail says it was deleted.

## Design

The design is a button and an inline confirmation, the same pattern the Tasks list uses for Remove (`tasks-view.ts`, `.revert-confirm`). No prototype was made, because the pattern already ships.

**Entry point.** The item's detail in the rail gets a last section, below History, separated by a rule: one line button, **Delete item**. It is not on cards, lanes or the outline. On a phone the rail is full width and the button is 44px high, like the other detail controls.

**Confirmation.** Pressing Delete item replaces the button, in place, with a group (`role="group"`, label "Delete W-n"):

- One sentence built from what the item has, for example: "Delete W-22 for good? Its history and its 2 attached files go with it, and its pull request review leaves the Reviews queue. This cannot be undone." The file and review parts appear only when they apply. When agent sessions are linked, it adds "Linked sessions keep running."
- Two buttons: **Keep** and **Delete W-22** (danger style). Keep gets focus first, so Enter on arrival does not delete.
- Keep or Escape closes the group and returns focus to Delete item. Opening another item, or the panel repainting for another item, also closes it.
- While the request travels, both buttons are disabled.

**After a delete.** The rail closes the detail. Focus moves to the card after the deleted one in its lane, else the card before it, else that lane's "+ Add item". With the lanes closed, focus goes back to where the outline's Work section was opened. The page says "W-22 deleted" through the live region, and the Work view's notice shows the same words with no Undo. The lane, counts and outline repaint from the server's answer and the `canvas:changed` broadcast.

**Refused.** A 409 conflict reloads the item and the group says "W-22 changed since you opened it. Read it again before deleting." with only Keep. Any other refusal shows the server's message in the group and keeps the item.

**Deleted elsewhere.** When another tab or person deletes the item that is open here, the detail shows "W-22 was deleted." in place of the fields, instead of today's "Pick a work item".

**Keyboard.** Tab reaches Delete item at the end of the detail. Enter or Space opens the confirmation. Tab moves between Keep and Delete W-n. Escape is Keep. There is no shortcut that deletes.

## Technical design

**Hard delete with a tombstone.** The item is removed from `items`. A short tombstone is added under a new top-level file key, `deleted: [{ number, title, at, author }]`, newest first, at most 500. That is the item's whole audit trail after a delete: who, when and what it was called. The item's own history goes with it. The previous release passes the unknown file key through on its own writes (`WorkFileSchema` is passthrough), so a rollback keeps the tombstones. A soft-delete flag on the item was rejected: the previous release would show every deleted item again after a rollback.

**Data shape.** `WorkFileSchema` gains `deleted` as an optional array that drops a bad entry alone (`.catch([])` per entry, as `attachments` does). `next`, `version` and the item schema are unchanged. `encodeWorkFile()` writes `deleted` only when it is non-empty.

**Key number.** Never reused. `deleteWork()` never touches `next` (I1).

**`deleteWork(file, number, expectedRevision, ctx)`** in `src/canvas/work.ts`, pure:

1. An agent author is refused with a new `WorkRefusal` code `PERSON_ONLY`, answered 403 `FORBIDDEN`.
2. `unchangeable()` gives 404 or the 409 revision conflict. `expectedRevision` is required by the route's schema.
3. It removes the item and its number from `readyOrder`, and adds the tombstone. It returns the removed item, so the route knows which bytes to remove.

The not-found message reads the tombstones: "W-22 was deleted on <date>" when one matches, else today's "W-22 does not exist" (I7). `unchangeable()` and `createWork()`'s `createdFrom` check share that one message function.

**HTTP route.** `DELETE /api/canvas/:workspaceId/work/:key?expectedRevision=<n>` in `canvas-work-routes.ts`. It checks `deployRole.allows('persist')` first, then `changeWork(deleteWork)`, then removes `work-files/<n>/` with `rm({recursive, force})`. A failure there is logged and not returned, since the record is already gone and orphaned bytes count against nothing. Then it broadcasts `canvas:changed` with `work: true`. It answers `{ success: true, data: { deleted: "W-n" } }`. A query parameter is used, not a body, because some clients drop a DELETE body.

**MCP `canvas_work`.** No new action, so the tool listing and `canvas_capabilities` are unchanged. An agent that holds a deleted key gets the "was deleted" 404 through `read`, `update` and `report`.

**Who may delete.** A person only (see Decision 2).

**Attachments' bytes.** Removed after the write, as `detachWork` does (I6). The whole `work-files/<n>/` folder goes, which also catches an upload that was in flight. Its own refused `attachWork` (now "was deleted") removes its bytes as it does today.

**Items whose `createdFrom` points at it.** Left as they are (I4). `workRelated()` already skips a missing parent, so their detail shows no "created from" link. `workBrief()` still lists the key, which a reader can look up and find deleted.

**Linked sessions.** Untouched. Sessions hold no reference to items. A session working on the item finds out at its next `canvas_work` call (I7).

**Waiting work review.** The review leaves the queue with no write, because `wanted()` is false for a missing item. Its record stays (I8). An Approve already in progress syncs first and answers `GONE`. A merge recorded just before the delete keeps its deploy and its record; `accepted()` finds no item and does nothing.

**Routines.** A work-item trigger's marks are pruned to items still in their status, so the deleted item's mark goes on the next tick. Gates count only existing items. A claim on a deleted item fails the way a claim on an item that left its status fails. No routine code changes.

**History and audit.** The tombstone (above). Nothing is added to the canvas operation log.

**Modules touched.**
- `src/canvas/work.ts`: `deleteWork()`, the tombstone schema, `PERSON_ONLY`, the shared not-found message.
- `src/web/routes/canvas-work-routes.ts`: the DELETE route and the 403 mapping.
- `src/canvas/work-files.ts`: `removeWorkFiles(workspaceId, number)` for the folder.
- `packages/canvas/src/work-view.ts` and its stylesheet: the Delete item section, confirmation, focus and the deleted-elsewhere text.
- `docs/architecture-invariants.md` "Canvas work" and `docs/subsystem-rules.md` "Canvas work": the sentence "Items are never deleted, so no other path removes bytes" is replaced, and delete is added to the route list.
- Tests: `test/canvas-work.test.ts`, `test/canvas-work.browser.test.ts`.

**Risks.**
- *A create retried after its item was deleted files a new item*, because the `requestId` it matched on went with the item. The window is a client retry of a few seconds, and a person must have deleted the item in it. Accepted, not handled.
- *Rollback after a delete.* The previous release reads the file, keeps `deleted`, and answers "does not exist" for the deleted key. The bytes are already gone, which matches the record. Nothing to repair.
- *Orphaned bytes* if the folder removal fails. They count against nothing and are logged. No sweep is added.

## Decisions for Harry

1. **Delete for good, with a confirmation, and no Undo.** Recommended. Undo would need a soft delete or a restore path, and a soft-deleted item reappears after a rollback. Not doing already covers "close it but keep it", so delete can be the rare, deliberate act.
2. **Only a person deletes.** Recommended. Agents keep Not doing and get no `canvas_work` delete action. This matches routines, whose delete is also person-only, and keeps "nothing moves an item by itself" true for the one act that cannot be undone.
3. **Any status can be deleted, including In progress and an item with a waiting review.** Recommended. The confirmation says what goes with it (files, review, linked sessions), and refusing by status would send Harry to move the item first just to delete it.

## Checks run

- `crosscheck:draft-invariants` drafted I1 to I8 from `docs/architecture-invariants.md` "Canvas work", "Work item pull requests" and self-building rule 5. Its red-pen step is this Spec review, and its property tests are left to ticket 1, since this branch is docs only. One departure from the skill: the code was read before the invariants were drafted, because the brief asked for it. The invariants are phrased from the rules docs, and the gap analysis is in the Technical design.
- `crosscheck:audit-invariant-consistency` ran I1 to I8 against the same sections. It found:
  - *Contradiction:* "Items are never deleted, so no other path removes bytes" (Attachments). Resolved: ticket 1 replaces that sentence.
  - *Strength mismatch:* "A person and an agent go through the SAME functions" against I2's person-only delete. Resolved: the refusal lives inside `deleteWork()`, so both still reach the same function, as routines do.
  - *Scope gap:* "`requestId` makes a create retry safe" does not hold across a delete. Recorded under Risks and accepted.
  - *Consistent, no change:* keys never reused (I1), only the changed item's revision moves (I4), `wanted()` hides the review (I8), routine marks pruned to existing items.
- These are layer 5 and 6 searches. They point at contradictions and are not proof that none remain.

<details><summary>Tickets (2)</summary>

**Ticket 1: Delete a Work item on the server.** Order 1. No dependencies.
- Serves outcomes 3 to 6 for the server and the API.
- `deleteWork()` and the tombstone in `work.ts`. The DELETE route, folder removal and broadcast. The shared "was deleted" message.
- Updates the two "Canvas work" docs paragraphs.
- Gate tests for I1 to I8, each marked `// Invariant I<N>: <Name>`, plus acceptance checks 1 and 2.
- Reviewable alone: it adds a route and nothing in the page calls it yet.

**Ticket 2: Delete item in the Work detail panel.** Order 2. Depends on ticket 1.
- Serves outcomes 1 to 3 on desktop and phone.
- The Delete item section, the inline confirmation, focus after a delete, the refusal text and the deleted-elsewhere text, as described in Design.
- Browser tests and acceptance checks 3 and 4.
- Reviewable alone against ticket 1's route.

</details>
