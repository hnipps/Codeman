# Intent: Work items on the canvas

**Status:** Draft

## Problem statement

A canvas has objects, comments, conversations and background tasks, but nowhere to keep track of the work itself: what is queued, who is on it, what an agent finished and what it found along the way. People keep that in their heads, in text objects or in a second tool. An agent that ends a run has no place to record "done and verified", "still going", "done, and here is new work" or "I need you".

The approved design is the canvas frame `work-study` (brief `work-brief`, prototype `work-tracker` v4 and the two comments it answers).

## Proposed outcome

Each canvas workspace has Work items. An item has a key (`W-12`), a title, a status (Backlog, Todo, In progress, Done, Not doing), a description, an assignee (the person, an agent session, or nobody), linked sessions, the item it was created from, and a short history. Items live in a side file per workspace, `work.json`, beside `conversations.json` and `review-notes.json`, written 0600 through `atomicWrite`; the board, the operation log and stored objects are untouched.

People and agents read and change items through the same routes: `GET/POST /api/canvas/:ws/work`, `PATCH /api/canvas/:ws/work/:key`, and the MCP tool `canvas_work` (list, read, create, update, report) through the existing command route. An agent's writes are stamped with its session as author, like every canvas command.

The page shows:

- an outline **Work** section: a count per status (Todo also says how many are unassigned), then what is in progress, Needs you first;
- a full view on **Shift+W**: five lanes side by side, drag a card to another lane, or Shift+Left/Right on a focused card; filters All / You / Agents / Unassigned and a title-or-key filter; New item;
- the item's detail in the rail (rail view `work`): title, status, assignee, a Needs-you box, the outcome an agent reported, linked sessions with the Sessions vocabulary (`!` Needs you, `×` Error, `?` Waiting, `●` Working, `○` Idle, `–` Ended) where each name opens that session's conversation or terminal, description, Related items ("Created from W-22", "Items created from this · n") and history.

The run-end rule is a rule for agents, carried in the `canvas_work` description and its `report` action: done and verified moves the item to Done; incomplete or unverified keeps it where it is with a note; done with unrelated work found moves it to Done and files new Backlog items created from it; unsure records a question, which shows as Needs you on the item. Nothing moves an item unless a person or an agent asks for it.

## Affected users and systems

People planning work on a canvas, and agent sessions that work on it. Systems: `src/canvas/work.ts` (pure, shared with the page), `src/canvas/work-store.ts`, `src/web/routes/canvas-work-routes.ts`, the command route and `src/canvas/commands.ts` (one tool), `src/mcp-server.ts` (one description), `src/canvas/view-schema.ts` (one rail view), `packages/canvas/src/work-view.ts`, small hooks in `entry.ts`, `canvas.html` and a new `canvas-work.css`.

## Constraints

- The previous release must read the canvas (self-building rule 5): nothing is added to stored objects, comments or the operation log. `work.json` is new and ignored by a release that does not know it. A `work.json` that does not parse, or has another version, is reported and never written over.
- Only the live colour writes (`atomicWrite` refuses elsewhere).
- Every string from an item or a session goes into the DOM through `textContent`.
- No automation: no route, watcher or settle pass changes an item by itself. A linked session's state is read for display only.
- A session can be linked or assigned only if the caller can see it.
- Another agent is changing the phone prototype review in parallel: shared canvas files get the smallest possible hooks.

## Open questions

- Replying to a Needs-you question from the rail. The prototype's reply box would need a new path that writes into a session. Deferred: the box opens the asking session's conversation and offers Mark answered.
- Deleting an item. Not in the brief; Not doing covers it for now.
- Referencing `W-12` from comments and board objects is the brief's "later".
