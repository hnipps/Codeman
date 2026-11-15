# Intent: Canvas routines, agents that run on a schedule (W-44)

**Status:** Implemented on `feat/w44-agent-routines`, awaiting Harry's review

## Problem statement

Nothing moves a canvas Work item unless a person starts an agent by hand. Harry wants agents that run in the background and refine Work items, judge whether they are ready, pick ready items up and drive them to complete, verified, merged and deployed.

Today no code path can do that under the canvas agent rules. Cron starts a plain session through its own spawn path, pastes one line, knows no canvas and never learns that the run ended. A canvas background task carries every agent rule (`src/canvas/agent-start.ts`) but can only start from a signed-in HTTP request. `docs/self-building.md` rule 4 also forbids any feature that prompts Claude without a human message.

## Proposed outcome

A canvas has **routines**. A routine is a title, a description, a prompt and one or more triggers (interval, daily, weekly), plus an enabled switch and optional CLI and model. Unknown fields are kept, so the shape stays flexible (owner decision, 2026-11-15).

- Each due time of an enabled routine starts one ordinary canvas background task whose request is the routine's prompt. The server sends it through its own `POST /api/canvas/:ws/tasks` route, so the task gets its own worktree, and the 4-task cap, the 50-record cap, `AGENT_CAP`, depth one, worktree-only and `startedBy` attribution all apply unchanged. Changing the agent rules (W-46) changes routines with them.
- What a run does is its prompt: refine items with `canvas_work`, build, test, commit, `codeman-deploy` like any agent (owner decision: all agents may deploy), and `report` on the item.
- A person creates, edits, enables, runs now and deletes routines from a Routines tab beside Work. Agents list, read, create and edit them through a brief-only `canvas_routine` MCP tool; an agent's create is saved disabled and an agent cannot enable, run or delete one.
- Only the live deploy colour fires routines (rule 6). A due time fires at most once across crashes and colour switches. Missed due times collapse into one fire. A due time while the routine's previous run is still active is skipped and recorded. A cap refusal is recorded with its code.
- Each routine shows its recent fires: started (linking the task), skipped, refused or failed.
- A routine may carry **gates** that the server checks before a fire, so no agent and no tokens are spent when one says no (owner requirement, 2026-11-15: "I want a cap on the number of work items that are automatically picked up and worked on, and I don't want to waste tokens by having an agent figure this out"). One kind, `work-count`: count the canvas Work items with a status and an assignee filter (`any`, `none`, `routine`) and pass when `min <= count` and `count < max`. The two cases: a cap, `{status:'in-progress', assignee:'routine', max:2}`, and nothing to pick, `{status:'todo', assignee:'none', min:1}`. A gate skip consumes the due time and is recorded as `skipped: gate N (count X)`. Run now meets the gates; a person may ignore them for that run.
- `docs/self-building.md` rule 4 is narrowed to respawn, auto-resume and prompt-cache keep-warm, and says cron jobs and canvas routines may prompt agents. Harry's reason (canvas review, 2026-11-15): those three duplicated prompts and burned tokens when more than one Codeman process ran.

## Design

Base: architect candidate A ("a routine run is a background task sent through the front door"). Candidate B reached the same shape independently (task route through `app.inject`, an in-process principal, a per-canvas side file, deterministic `requestId`, one active run per routine, person-only enable, brief-only tool), which is strong agreement. No cross-model judge ran: no model outside the Claude family was available.

- `src/canvas/routines.ts` (pure, shared with the page): the `Routine`, `RoutineTrigger` and `RoutineGate` types and schemas, `dueAt` (reuses `computeNextRunAt` from `src/cron/cron-time.ts` through one adapter), `planFire`, `gateRefusal`, `countWork`, `runRequestId` (name-based UUID of `routineId:dueAt`) and `routineRequestText`.
- Gates: `planFire(routine, state, runs, now, work)` takes a derived `WorkCounts` (counts per status and assignee filter, computed by the runner from `work.json` and the set of routine-run sessions, never stored). Order: pending fire, disabled, not due, previous run active (skip), a gate says no (skip with `gate` and `count`), start. A gate this release cannot read, or Work items that could not be counted, says no. Gates are kept loose on disk like triggers.
- `src/canvas/routine-store.ts`: `routines.json` (definitions, written only by the routine routes, revision guarded, passthrough) and `routine-state.json` (`lastDueAt` and the last 20 fires per routine, written only by the runner) under `dataPath('canvas', ws, …)`. Next run time and run state are derived, never stored.
- `src/web/routine-runner.ts`: `tick(now)` and `fire(ws, routine, reason)`. Records the fire (consuming the due time) before it injects, checks `deployRole.allows('automate')` at tick start and before each write and inject, and removes the routine's own finished runs beyond the newest 3 through the existing remove route (which keeps any worktree with changes).
- `src/web/internal-principal.ts`: an in-process HMAC header (key never leaves memory, 5-minute life, bound to workspace and routine). The auth hook turns a verified header into the workspace owner; the canvas pre-handler turns it into `req.canvasRoutine`. A client-sent header is ignored and never forwarded by the webview proxy.
- `startedBy` for a run is stored as `{ kind: 'agent', sessionId: <the run's own session>, routineId, runId }`, so the previous release still counts it toward `AGENT_CAP` and still applies depth one after a rollback (rule 5 holds for meaning, not only parsing).
- `src/web/routes/canvas-routine-routes.ts`: list, create, update (expectedRevision), delete, run-now, and `routineTool` for `canvas_routine`.
- `packages/canvas/src/routines-view.ts`: the Routines tab.

Grafts from B considered: a Work-item trigger was taken (see As built; keyed on when the item entered its status rather than a `workKey@revision` ledger, so an intake run's own edits never refire it). Not taken: a synced global kill switch (a follow-up), and `{{item.*}}` prompt substitution (rejected: template injection from item text).

## Affected users and systems

Harry and anyone owning a canvas. Canvas task routes, the auth hook, the canvas pre-handler, the MCP server and tool registry, the canvas Work panel, `docs/self-building.md`, `docs/architecture-invariants.md`, `CLAUDE.md`, `docs/JOURNAL.md`.

## Constraints

- Same rules as canvas agents, with no separate budget and no bypass (owner decision 2).
- Rule 5: the previous release must read every changed file the same way; `routines.json` and `routine-state.json` are new side files it ignores.
- Rule 6: fire only on the live colour, checked at the moment of acting.
- `canvas_capabilities` is at its 60,000-byte cap: the tool is brief-only.
- Minimum interval 15 minutes; at most 20 routines and 4 triggers per routine.
- 8 GiB host: no new test that runs the full suite in parallel; tests run in-process with the echo PTY.

## Open questions

- May an agent enable a routine it drafted when the person asked in chat? This PR says no (enabling is the rule 4 moment, and a depth-limited agent could otherwise start work by proxy). Tracked under W-46.
- Should routines get a global pause switch? Left out: each routine starts disabled. Follow-up if wanted.
- Work-item triggers (fire when an item enters Todo) replace polling for pickup routines. Follow-up, overlapping W-21 and W-43.

## As built (deviations from the design above)

- The principal lives 5 minutes, not 60 s: a task start makes its worktree before the nested session create reuses the header.
- A fire has a `pending` outcome, recorded before the start. The next tick settles it from the task list, repeats it with the same run id, or marks it `failed` after 10 minutes. This is what makes "at most once across crashes" concrete.
- Run now uses the person's `requestId` as the run id and meets the same overlap rule (skipped while a run is active); a repeated Run now with that id answers the recorded fire.
- Agent create with `enabled: true` is refused `PERSON_ONLY`, not silently saved disabled.
- An agent's change to the prompt, triggers, CLI or model of an enabled routine switches it off, so a person always enables the prompt that will run. An agent may switch a routine off.
- Triggers are stored loosely (any `kind` is kept and never fires), and the page sends `triggers` only when the person changed them, so later trigger kinds survive an edit.
- Retention orders runs by task `createdAt` (the brief task rows carry no finish time).
- The `canvas_work` capability note was shortened to fit `canvas_routine` under the 60,000-byte cap.
- The Routines tab is a second tab of the Work view (Items | Routines), not a separate panel.
- Gates were added after the first two commits, on the owner's requirement. Two choices beyond the brief: a gate that cannot be evaluated says no (a doubt keeps the agent asleep), and gates are among the fields whose change by an agent switches an enabled routine off (removing a cap loosens it). A started fire records the run's session so items a run took still count after its task record is removed, and a run whose gates count `routine` items is told to assign its items to itself.
- A `work-item` trigger and a server-side claim were added on the owner's requirement (pickup and intake routines acting on items within WIP and task limits). Level-triggered, once per item per entry into its status (`enteredAt()` from the item's history, else `createdAt`), one item per fire, first in `laneOrder()`. A refused start leaves the item due; a gate skip is recorded once per item and count. `claim` assigns the item to the run's session and moves it to In progress after the start. Built on W-48 (stacked on its branch): `laneOrder()` takes Ready for work in its queue order (`readyQueue`) and other lanes by item number, and `enteredAt()` reads W-48's "Moved from X to Y" events, passing over reorders and Backlog instructions; a Todo item migrated by W-48 has no such event and keys on `createdAt`. Routines never promote out of Backlog (W-48 refuses an agent that move without `instruction`, and routines pass none). W-48 should keep writing those move events, or give items an entry time, for `enteredAt()`.
