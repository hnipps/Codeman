# Intent: Background agent tasks from the canvas assistant (PC12)

**Status:** Draft

## Problem statement

The canvas assistant holds one foreground conversation at a time. A person cannot hand a request to an agent, carry on with the canvas, and come back to the result. Keys lists `G` and Cmd/Ctrl+Shift+Enter as arriving later, and nothing handles them. Two agents asked to edit code in the same case would share one checkout.

## Proposed outcome

Run in background is an explicit action under the composer, also Cmd/Ctrl+Shift+Enter with a non-empty draft. It creates one named child task from the drafted request: its own real session, the context chips of that moment recorded as the task's snapshot, and the provider and model chosen at that moment. The composer is cleared, the foreground conversation is left exactly as it was, and control returns to the canvas at once.

A task is a conversation record with a `task` part: name, the request id that created it, the conversation it was started from (if any), a thread origin (if started from a thread request), how it is isolated, and its recorded state. It is started and written through the existing conversation create and send paths.

Isolation. In a case that is a local git repository the task's session runs in its own git worktree of that case, made through the existing managed-worktree path, so no two tasks and no foreground session share an editing checkout by accident. In a case that is not a git repository there is nothing to isolate with: Run in background says so in line and runs only after the person ticks "Run in the case folder, shared with other sessions" for that task. Docker and remote cases are refused, as conversations are.

`G` opens the task list in the same rail, non-modal. Each task shows its name, provider and model, isolation, and one of six distinct states: queued, running, waiting for you, completed, failed, cancelled. Inspect opens that task's conversation in the rail. Cancel interrupts only that task and marks it cancelled; its session and worktree are kept for inspection. Remove deletes a finished or cancelled task's session and, when the worktree is clean, the worktree; a worktree with changes is kept and the task says where it is. Closing the rail cancels nothing.

A task's question or approval shows as "waiting for you" with a quiet count on the task control; it is answered in that task's conversation. A finished task shows its result text and links to what it was about: the objects in its snapshot, and its originating thread, where the reply is also posted by the existing thread-reply path. Nothing is dumped into the foreground conversation.

A retry of the same Run in background after a lost response creates one task. A reload or reconnect restores the list and each task's state from the server. Changing the provider or model afterwards changes no existing task. A deploy carries tasks over like any conversation.

Only a person can start a task. No agent tool, view command or thread reply can. A task cannot start the microphone.

## Affected users and systems

People using the canvas assistant on desktop and phone. `src/canvas/{conversation-schema,conversations}.ts`, a new pure task module, `src/web/routes/canvas-conversation-routes.ts`, the canvas port and its server wiring, `packages/canvas/src/{assistant,shortcuts,entry,mobile}.ts` and a new task view, `src/web/public/canvas.{html,css}`, and their tests.

## Constraints

- No new spawn path, no new pane write path, no new worktree code: sessions through the existing create, messages through the existing send, worktrees through the existing managed-worktree functions with their rules (managed path only, never Docker or remote, remove without force and refused while a live session is inside, branch delete without force).
- Stored data rolls forward: the `task` part lives in `conversations.json`, whose schemas pass unknown keys through; the previous release reads a task as an ordinary conversation.
- Bounded: a cap on tasks running at once per workspace, the existing conversation and message caps, the existing send rate limit.
- States are derived from evidence the server holds (delivery state, the turn-end rule the thread replies use, the approvals inbox, the pane-exit record); a state is never claimed from a guess.
- No respawn, auto-resume, Ralph or orchestrator. A task is one request; it does not loop.
- Everything stays behind `canvasEnabled`. Public repository: no hostnames, ports, users or paths.

## Open questions

- Tasks launch in the install's default permission mode, as canvas conversations do. Forcing a mode that asks is the owner's open decision and is not changed here.
- A task's worktree is left in place when it has changes; merging its branch back is the person's or an agent's ordinary git work, not a control in this change.

## Decisions

Settled while building; none changes the outcome above.

- The task has its own routes beside the conversation routes: one create (`POST /api/canvas/:workspaceId/tasks`), a list, a cancel and a remove, in `src/web/routes/canvas-task-routes.ts`. The create still goes through the conversation session start and the conversation send; it adds no spawn path and no pane write path.
- The create does its steps in one order and undoes them in reverse when a later one fails: the case is probed, the cap is checked, the worktree is made, the session is started, the task is recorded, the request is sent. A failed run leaves no worktree, branch, session or record, and its request id can be used again.
- State is worked out when a task is read. The record holds only observations: when it was cancelled, when its turn was seen to end, and when it was removed. The turn end is written by the same pass, on the same evidence and two agreeing transcript reads, that posts a thread reply. Completed and cancelled are final, and a cancel wins over everything else. An agent that exited, or a session that is gone, with no recorded turn end is failed.
- The id of the task's one message is made on the server and kept in the task part.
- The same request id returns the same task. An id that already made an ordinary conversation is refused, and so is the same id with different text or context.
- A git case always gets a worktree, named `task-` and eight hex digits, on the branch the worktree code names for it. The tick for sharing is asked for, and used, only where no worktree can be made.
- At most four tasks of one canvas are queued, running or waiting at once.
- Cancel sends Escape to that task's session and nothing else. A request still waiting for a composer is then never written.
- Remove deletes the record once the session is discarded and the worktree is gone, which frees a place under the conversation cap. A worktree git will not remove stays, the row stays and says where it is inside the case and why, and Remove can be pressed again. The branch is deleted only when git agrees it is merged; one that holds commits is kept and named.
- A removed task's status line leaves the thread it was asked from; the reply comment stays.
- A person can message a task's session from Inspect. An agent cannot message, start, cancel or remove a task; it can list and read them through the conversation list and read, which name the task, its state and, in the read, its result.
- Tasks are left out of the assistant's conversation picker, the Ask agent targets and the rail's choice of the newest conversation. Inspect binds the rail to the task and the picker then names it.
- The task list is a rail view, so an agent's view command can open it. That shows the list and starts nothing.
- The composer and its chips are cleared when the server acknowledges the run, not before; a failed run keeps both, and its request id is kept with the draft across a reload.
- The count is tasks waiting for the person plus tasks finished since the list was last opened, remembered per browser. Opening the list clears the finished ones; a question keeps counting until it is answered.
- Cmd/Ctrl+Shift+Enter also works with the canvas in focus and the rail closed; what happened is then said in the announcement line.
- The desktop has a dock control for the list. The phone reaches it from a control inside the assistant, which appears once a task exists, so the phone dock keeps its five controls. A hardware `G` does nothing on a phone.
- A task's session is named `Task ·` and the task's name. The name is the person's, or the first line of the request cut at a word within sixty characters.
- The result a row shows is cut at 4000 characters; the whole reply is in the task's session.

## Verification limits

Sessions in every test are stand-ins and transcripts are written by the test. No real agent has run a task. Worktrees are made and removed by real git in a temporary repository, in the route tests and the browser tests. Cancel is checked as an Escape written to the task's session, not as an agent stopping.
