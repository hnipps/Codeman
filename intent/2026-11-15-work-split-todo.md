# Intent: Split Work's Todo into Needs refinement, Human required and Ready for work

**Status:** Draft

## Problem statement

Work item W-48 (owner decision 2026-11-15). The Work tracker has one Todo status, so nothing says whether an item can be handed to an agent, is waiting for a person, or still needs detail. Routines (W-44) and an intake routine need a contract: which items a pickup routine may take, and in which order.

## Proposed outcome

Statuses, in board order: Backlog, Needs refinement, Human required, Ready for work, In progress, Done, Not doing. Ids: `backlog`, `needs-refinement`, `human-required`, `ready-for-work`, `in-progress`, `done`, `not-doing`.

- Backlog: potential work, not committed.
- Needs refinement: wanted but not detailed enough for an agent. The intake routine's queue and where raw captures land. Pickup routines ignore it.
- Human required: a person has to act: answer an agent's question (the item's `needs`), or do work only a person can do (the item's description says which).
- Ready for work: an agent can pick it up and finish with no further questions. Pickup routines take only from here, top first.

Rules, enforced in `src/canvas/work.ts`:

- An `ask` report moves the item to Human required. Marking its question answered sends it to Needs refinement, never straight to Ready for work (a patch that answers and asks for Ready for work is refused).
- Only a person moves an item out of Backlog. An agent may do it only with `instruction`, the person's words; the history records them. Without it the call is refused. Agents may move or file items into Backlog freely.
- Priority is position: the file keeps the Ready for work order (`readyOrder`), an item entering the lane goes to the bottom unless `position` is given, `position` reorders, and the list answers that lane top first. `workPosition()`/`laneOrder()` are the one ordering API.

Migration of existing Todo items: assigned to the person -> Human required; unassigned -> Needs refinement; assigned to a session -> Needs refinement, assignee kept.

Lanes: desktop shows six columns, Done and Not doing stacked in the last (closed) column, scrolling sideways when narrow; phone keeps one lane at a time behind wrapping tabs. The outline lists Human required items first, then In progress. Ready for work cards reorder by drag or Shift+Up/Down; the detail offers Move up / Move down.

## Affected users and systems

People planning work on a canvas, agent sessions using `canvas_work`, and W-44's routines (session 60301e9f), which read the status enum, the history's move events and the lane order from `work.ts`. Files: `src/canvas/work.ts`, `work-store.ts`, `routes/canvas-work-routes.ts`, `src/mcp-server.ts` (tool description), `packages/canvas/src/work-model.ts`, `work-view.ts`, `canvas-work.css`, docs.

## Constraints

- Self-building rule 5: the previous release must read `work.json`. Its schema accepts only the five old statuses and refuses a whole file on one unknown value, and refuses any version but 1. So the file stays version 1 and the stored `status` stays in the old enum: the three new statuses are stored as `status: "todo"` plus `todoStatus`, an item key the old release keeps (passthrough); `readyOrder` is a file key it keeps too. Decoding and encoding live only in `work-store.ts`/`work.ts`; every reader above them sees the seven statuses. A Todo item without `todoStatus` is migrated by the rule above on every read and pinned by the next write.
- The migration adds no history event: it has no author, and a read must not write. Routines must not expect a move event for a migrated item.
- `canvas_capabilities` lists `canvas_work` in brief, so the schema change does not grow it.
- Do not edit W-44's routine code.

## Open questions

- None blocking. A rollback to the previous release shows the three new statuses as Todo; if the old release then moves an item out of Todo and back, its stale `todoStatus` is applied again.
