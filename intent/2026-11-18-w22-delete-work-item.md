# Intent: W-22 delete a Work item (spec, pilot)

**Status:** Draft (spec for W-22, the pilot of `intent/2026-11-18-spec-first-lifecycle.md`; revision 2, after the owner's notes of 2026-11-18)

## Problem statement

A canvas Work item can never be removed. #52 shipped Not doing as the stand-in for delete, but Not doing means something else: it is the explicit list of work that is out of scope. Items that are wrong, outdated, duplicated or filed by mistake have no place to go, so they clutter the lanes, the counts and agents' lists.

## Outcomes

1. Harry, or an agent, can delete an item. A deleted item moves to a new status, **Deleted**.
2. Deleted items are hidden by default: from the lanes, the outline's counts, Needs you, and `canvas_work list`.
3. Harry can show the Deleted lane, open a deleted item, read who deleted it, when and why, and restore it.
4. A delete made on the page can be undone from its notice for a few seconds.
5. Nothing is lost. A deleted item keeps its key, history, attachments, links and pull request. Restoring it brings all of them back.
6. Deleted items get no agent work. Pickup, routines and the Reviews queue ignore them.

## Constraints

- **Self-building rule 5.** After any delete, `work.json` stays readable by the release before this one (master 9c3641fa).
  - `version` stays 1.
  - Stored `status` stays in the old five-value enum. A Deleted item is stored as `status: "not-doing"` plus a new item key, `deleted`, the same way W-48 stored its three statuses under `todo`.
- **Routines stay readable too.** `routines.json` and `routine-state.json` never hold the value `deleted`. Routine triggers and gates take a status list without it, so the previous release, which refuses an unknown status there, still reads both files.
- **Rule 6, live colour only.** Delete and restore are item writes through `changeWork()`, which already writes only on the live colour.
- **The 8 GiB host.** No new background work: no sweep, no timer, no purge.
- **No id-branching.** Nothing branches on a CLI id. The agent rules read the request's author kind, as the Backlog rule does.
- **Rules live in `work.ts`.** The Deleted status, its encoding and its agent rules sit in the pure functions every caller reaches: the routes, `canvas_work` and the Reviews page.
- **`canvas_capabilities` is at its 60 KB cap.** No tool and no action is added. `canvas_work` gains one status value and one field, described in its own tool listing, not in that document.
- Strings from items reach the DOM through `textContent` only.

## Invariants

## I1: DeleteKeepsEverything

Deleting an item never removes it from `work.json`, never changes its number, and never touches its attachments' bytes, linked sessions, pull request, `createdFrom` or the items created from it. The only changes are its status, the `deleted` record, one history event, `revision` and `updatedAt`.

- *Why:* the owner asked for soft delete (review note, 2026-11-18). The Canvas work rules say keys are "never reused", and W-42 says the record is the source of truth for attached bytes.
- *Test:* random item with attachments, links and `pr`; delete; diff the item before and after; only the listed fields differ; the attachment files are byte-identical; `next` is unchanged.

## I2: PreviousReleaseReadsDeletedItems

After any delete, the written `work.json` parses with the pre-change file schema (master 9c3641fa). Every Deleted item is stored with `status: "not-doing"` and its `deleted` record. That release shows it in Not doing.

- *Why:* self-building rule 5, and the W-48 journal entry: the old schema "refuses a whole file over one unknown status and any version but 1".
- *Test:* a gate test parses the encoded file with a frozen copy of the 9c3641fa `WorkFileSchema`, asserts success, and asserts the item reads as `not-doing` with `deleted` kept.

## I3: AnOldReleaseMoveRestores

An item stored with a `deleted` record but a stored status other than `not-doing` decodes to that stored status, not Deleted. The next write of the item drops the stale record. The previous release only knows Not doing, so a person who moved the item after a rollback meant to restore it.

- *Why:* rollback restores code only (rule 5). Without this rule, an item the old release moved to In progress would turn back into Deleted after the roll forward.
- *Test:* a stored item `{status: "in-progress", deleted: {...}}` decodes as `in-progress`; one write later the encoded item has no `deleted`.

## I4: HiddenByDefault

A Deleted item does not appear in:
- the outline's counts or its Human required and In progress lists;
- Needs you;
- the Work view's lanes while "Show deleted" is off;
- `canvas_work list` without a status.

`canvas_work list` with `status: "deleted"` lists only Deleted items, and `canvas_work read` of a Deleted key answers it with its status.

- *Why:* the owner's note: deleted items "should be hidden by default". An agent reading a list without a status must not pick up or reason about deleted items.
- *Test:* a file with items in every status, some Deleted with a `needs` question; assert the model's counts, the outline rows, the Needs you rows and the brief list leave out every Deleted item; `list` with `status: "deleted"` returns exactly them.

## I5: AgentsMayDeleteWithAReason

An agent may move any item, in any status (Backlog included), into Deleted. It must give a `reason`. The reason is stored on the `deleted` record and quoted in the history event. A person may give one and need not.

- *Why:* the owner's note: "Agents must be able to soft-delete". A reason is the only trace of why an agent hid an item.
- *Test:* an agent update to `deleted` without `reason` is refused 400, and the file is unchanged. With `reason`, it succeeds from each of the seven other statuses, including Backlog with no `instruction`. The history reads `Deleted: "<reason>"`.

## I6: OnlyAPersonRestores

Only a person moves an item out of Deleted. An agent's update or report that would do so is refused unless it carries `instruction`, the person's words, under the same rule as moving out of Backlog. A `continue` report, and edits that leave the status alone, are allowed.

- *Why:* "Only a person moves an item out of Backlog" exists so an agent cannot commit work nobody asked for. Restoring a deleted item is the same act. Without this rule, an agent mid-run could report `done` and pull an item back out of Deleted.
- *Test:* on a Deleted item, an agent's `status: "ready-for-work"` without `instruction` is refused; `report done` is refused; `report continue` is accepted and the item stays Deleted; a person's restore is accepted.

## I7: DeletedIsQuiet

A Deleted item gets no agent work:
- It is closed (`workClosed()` is true), so its work review does not wait on the Reviews page.
- It is not in `readyOrder`.
- Request changes on its review is refused, as for any closed item.
- No routine trigger or gate can name the Deleted status.

Restoring the item to an open status with the same pull request brings the same review back with its notes.

- *Why:* "Wanted is the tracker's": closing an item already hides its review "with no delete" and brings it back when it reopens. This pins Deleted as one of the closed statuses.
- *Test:* an item with `pr.branch` and a synced review is deleted. `queueOf` no longer lists it as waiting, and the review file is byte-identical. `readyQueue()` leaves it out. A routine trigger or gate with `status: "deleted"` is refused 400. Restore it, and the same review id waits again.

## I8: UndoIsAnOrdinaryMove

Restoring an item, whether from Undo or Restore, puts it back in the status its `deleted` record names. A Ready for work item goes to the bottom of that lane. Restore is a normal status change: it is logged and announced, and it is guarded by `expectedRevision`.

- *Why:* the Work view already offers Undo on a person's move ("undoable from the notice"). Delete reuses that path rather than adding a second one.
- *Test:* delete a Ready for work item at position 1, then restore it. Its status is `ready-for-work`, its position is last, and two history events record the move away and the move back.

## Non-goals

- Permanent delete, a purge or emptying the Deleted lane. Deleted items, and their attachments, stay on disk and count against the canvas quota. A purge would be a later spec.
- Deleting several items at once.
- A Delete-key shortcut on cards.
- A new `canvas_work` action. Delete is `update` with `status: "deleted"`.
- Changing Not doing. It stays the list of out-of-scope work.
- Routines that trigger on, or count, Deleted items.

## Acceptance checks

1. `npm test -- test/canvas-work.test.ts test/canvas-work-model.test.ts test/canvas-routines.test.ts` passes. Each of I1 to I8 has one or more cases, each marked `// Invariant I<N>: <Name>`.
2. On a throwaway instance (`CODEMAN_INSTANCE`, its own port), with `curl`:
   - Create an item, attach a file, and `PATCH /api/canvas/<ws>/work/W-n` with `{status: "deleted", expectedRevision}`. It answers 200 with `status: "deleted"`.
   - The `work.json` file stores it as `status: "not-doing"` with a `deleted` record. The attachment file is still on disk.
   - `GET /api/canvas/<ws>/work` still returns it. A `canvas_work list` through the command route without a status leaves it out.
   - The same PATCH with `X-Codeman-Parent-Session` and no `reason` answers 400. With a `reason` it answers 200.
   - An agent PATCH back to `backlog` without `instruction` answers 400. A person's answers 200.
3. Run the browser suite by hand on an idle host, not during a deploy. `test/canvas-work.browser.test.ts` passes, with new cases:
   - delete from the detail at 1440px, then Undo;
   - Show deleted, open the item, Restore;
   - the phone layout at 390px.
4. By hand on the throwaway instance, desktop and phone:
   - Delete an item. It leaves its lane, and the notice offers Undo.
   - Turn on Show deleted. The item is there with its reason. Restore it.
   - In a second tab, the item disappears without a reload.

## Design

The design is a status move, with the same Undo the Work view already has for moves. Deleted is a lane that stays hidden unless "Show deleted" is on, plus a banner on a deleted item. Every piece reuses a pattern that already ships: a lane, the move notice with Undo, a line button, and the stacked closed column. A delete can be undone, so the inline confirmation in revision 1 is gone. No prototype was made yet, because this spec agent's session cannot reach the canvas. One can be added before approval if the description below is not enough.

**Entry points.**
- The item's detail gets a **Delete item** line button in its last section, below History. On a phone it is 44px high, like the other detail controls.
- The detail's Status select lists **Deleted** last.
- When the Deleted lane is shown, a card can be dragged into it.
- Shift+Left/Right on a card never steps into or out of Deleted, so no keyboard shortcut deletes.

**No confirmation; Undo instead.** Delete moves the item at once. The rail closes the detail. Focus moves to the card after the deleted one in its lane, else the card before it, else that lane's "+ Add item". The notice says "W-22 deleted" with **Undo** for 5 seconds, the same notice a move uses. Undo restores the item and reopens nothing.

**Show deleted.** The Work view's header gets a **Show deleted (N)** toggle button (`aria-pressed`), shown only when N > 0. The setting lives in the page and is not stored.
- When on, a Deleted lane joins the stacked closed column on a desktop, below Done and Not doing.
- On a phone, a Deleted tab joins the wrapping tabs.
- Deleted cards are muted. They show the title, key and "Deleted <date>", and list newest deletion first.

**A deleted item's detail.** A banner at the top reads "Deleted by you on 18 Nov" or "Deleted by <session> on 18 Nov", with the reason below when there is one. It has one primary button, **Restore to <status>**, which names the status the item came from. Everything else in the detail reads as usual and can be edited.

**Deleted elsewhere.** When another tab, a person or an agent deletes the item open here, the detail switches to that banner. It does not close under the reader.

**Keyboard.**
- Tab reaches Delete item at the end of the detail. Enter or Space deletes.
- Undo in the notice is reachable by Tab. The page also announces the delete through its live region.
- In a deleted item's detail, Restore is the first control after the title.

## Technical design

**Soft delete as a status.** `WORK_STATUSES` gains `deleted`, last, named "Deleted". `workClosed()` is true for it. A hard delete was dropped at the owner's request.

**Stored shape.**
- The decoded status `deleted` is stored as `status: "not-doing"` plus an item key: `deleted: { at, from, author, reason? }`.
  - `from` is the status it left.
  - `reason` is at most 300 characters, one line.
- `WorkFileSchema` decodes `not-doing` + `deleted` as Deleted.
- Any other stored status with a `deleted` record decodes as that status (I3).
- `encodeWorkFile()` writes `deleted` only for a Deleted item and drops it otherwise.
- Only `work.ts` sees the stored form, as with `todo`. `version`, `next` and the stored enum are unchanged.
- A soft delete stored this way shows in Not doing after a rollback. It does not disappear, and it is not shown as open work.

**Rules in `work.ts`.**
- **Moving into Deleted.** `setStatus()` to Deleted records `deleted` and logs `Deleted` (with `: "<reason>"` when given). It removes the number from `readyOrder`, as leaving Ready for work does.
- **Reason.** `UpdateWorkSchema` gains `reason`, which an agent must give when moving into Deleted (I5).
- **Moving out.** `backlogRefusal()` becomes "out of Backlog or Deleted": the same `instruction` rule and the same history line (I6). Moving into Deleted is exempt from the Backlog rule.
- **Restore.** A restore clears `deleted`. Undo and Restore both send `status: <from>` (I8).
- **Report.** `reportWork()` already passes through `backlogRefusal()` for `done`, `split` and `ask`, so it inherits I6. `continue` does not move.

**Hidden by default.**
- `canvas_work list` without a status filters out Deleted. With `status: "deleted"`, it lists them.
- `GET /work` keeps returning every item, because the page filters.
- In the page's `work-model.ts`, `workCounts`, `outlineItems`, `openCount`, the Needs you rows and `laneItems` leave Deleted out unless Show deleted is on.
- `stepStatus()` skips Deleted.
- A page from before the deploy drops rows it cannot parse (`parseWork`), so an open old tab simply does not show Deleted items.

**HTTP route.** No new route. Delete and restore are `PATCH /work/:key`.

**MCP `canvas_work`.**
- No new action. `update` takes `status: "deleted"` and `reason`.
- The tool description gains one sentence: delete hides wrong or outdated items, gives a reason, and only a person restores.
- `canvas_capabilities` is unchanged.

**Who may delete.**
- **Delete:** a person, or an agent with a reason.
- **Restore:** a person, or an agent quoting the person's `instruction`.

**Key number.** Never reused, and never freed: the item stays.

**Attachments' bytes.** Kept. They still count against the quota, and they are served as before. Purge is a non-goal.

**Items whose `createdFrom` points at it.** Unchanged. The Related items section shows the deleted item with its status.

**Linked sessions.** Untouched. A session working on the item sees `status: "deleted"` on its next read. Any move it then tries is refused (I6).

**Waiting work review.** It leaves the queue because Deleted is closed (`wanted()`). An Approve already in progress syncs first and answers `GONE`. Restore brings the same review back (I7).

**Routines.**
- `routines.ts` takes `RoutineStatusSchema`, the work statuses without `deleted`, for triggers, gates and the marks in `routine-state.json`. A trigger or gate naming `deleted` is refused, so neither file can hold the value (constraints).
- Gates and triggers never see Deleted items, because those are not in any status a routine can name.

**History and audit.** The item's own history: `Moved from <A> to Deleted`, `Deleted: "<reason>"`, and on restore `Moved from Deleted to <B>`. The `deleted` record holds who, when, from where and why.

**Modules touched.**
- `src/canvas/work.ts`: the status, its encoding, `reason`, the refusal rule and the list filter.
- `src/web/routes/canvas-work-routes.ts`: `list` filtering only.
- `src/canvas/routines.ts`: `RoutineStatusSchema`.
- `src/canvas/commands.ts` or the tool listing: the `canvas_work` description sentence.
- `packages/canvas/src/work-model.ts`, `work-view.ts` and their stylesheet: Delete item, the select option, Show deleted, the lane and tab, the banner, Restore and Undo.
- `docs/architecture-invariants.md` "Canvas work" and "Canvas routines", and `docs/subsystem-rules.md` "Canvas work": the statuses, the stored form and the Backlog-or-Deleted rule.
- Tests: `test/canvas-work.test.ts`, `test/canvas-work-model.test.ts`, `test/canvas-routines.test.ts`, `test/canvas-work.browser.test.ts`.

**Risks.**
- *Deleted items grow without bound.* They count toward `MAX_WORK_ITEMS` (2,000) and the attachment quota. At today's rate (63 items in about two weeks), that limit is far off. Purge is the later spec.
- *A rollback shows deleted items in Not doing.* After a roll forward they are Deleted again, unless someone moved them (I3).
- *An old page tab* hides Deleted items rather than showing an error, because the page drops rows it cannot parse.

## Decisions for Harry

Your notes settled soft delete, agent delete and "any status". These three remain, each written so you can approve the recommendation as it stands.

1. **Only a person restores.** Recommended. An agent needs your words (`instruction`) to bring an item back, as it does to move one out of Backlog. Without this rule, an agent finishing a run could report `done` and pull a deleted item back into the lanes.
2. **An agent gives a reason when it deletes.** Recommended. The reason is shown on the deleted item and kept in its history. It is the only record of why an agent hid something, and you will read it when deciding whether to restore. A person's reason is optional.
3. **After a rollback, deleted items show in Not doing.** Recommended, and it follows from rule 5. The previous release refuses any status it does not know. So a Deleted item is stored as Not doing plus a marker, and that release shows it as Not doing. The alternative, hiding them in the old release, is impossible without changing the old release.

## Checks run

**Revision 1.** `crosscheck:draft-invariants` drafted the invariants from `docs/architecture-invariants.md` "Canvas work", "Work item pull requests" and self-building rule 5. Its red-pen step is this Spec review. Its property tests are left to ticket 1, since this branch is docs only. One departure from the skill: the code was read before drafting, because the brief asked for that.

**Revision 2.** The invariants were redrafted for soft delete. `crosscheck:audit-invariant-consistency` ran them again against "Canvas work", "Work item pull requests" and "Canvas routines". It found:
- *Contradiction:* routine triggers and gates take `WorkStatusSchema`, so adding `deleted` there would let `routines.json` hold a value the previous release refuses. Resolved with `RoutineStatusSchema` (constraints, I7).
- *Contradiction:* "never store a new status value into `status`". Resolved: the stored form is `not-doing` + `deleted` (I2).
- *Scope gap:* the Backlog rule did not cover a report moving an item out of a closed status. Resolved by I6.
- *Consistent, no change:* keys never reused (I1), the closed-item review rule (I7), and the existing Undo on moves (I8).

These are layer 5 and 6 searches. They point at contradictions and are not proof that none remain.

<details><summary>Tickets (2)</summary>

**Ticket 1: Deleted status on the server.** Order 1. No dependencies.
- Serves outcomes 1, 2, 5 and 6 for the server, the API and `canvas_work`.
- The Deleted status and its stored form, `reason`, the Backlog-or-Deleted rule, the `list` filter, `RoutineStatusSchema` and the tool description sentence.
- Updates the docs paragraphs.
- Gate tests for I1 to I3 and I5 to I7, each marked `// Invariant I<N>: <Name>`, plus I4's `list` half, I8's server half, and acceptance checks 1 and 2.
- Reviewable alone: the page, which drops rows it cannot parse, keeps working unchanged.

**Ticket 2: Delete, Show deleted and Restore on the page.** Order 2. Depends on ticket 1.
- Serves outcomes 1 to 4 on desktop and phone.
- Delete item, the Status select option, Undo, Show deleted with its lane and tab, the deleted banner with Restore, the deleted-elsewhere switch, and the model's filtering (I4's page half, I8's Undo).
- Browser tests and acceptance checks 3 and 4.
- Reviewable alone against ticket 1's API.

</details>
