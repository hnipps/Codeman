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

## Fix round 1

A review of the first commit and a run on a real agent found the points below. None changes the outcome above; each is fixed in a second commit.

- Cancel stops the request. The cancel is recorded first, and from then on the delivery writes nothing: no paste, and no Enter for a request already pasted. The session's own re-press of Enter is stopped too. A request left in the composer is cleared with Escape, pressed only while a fresh read of the screen shows text there and at most three times; when it will not clear, or the screen cannot be read, the row says the request may still be in that session's input box. A cancelled task refuses further messages, in the route and in the composer, and its row says the session is kept for inspection only.
- An agent that leaves its pane with a failure, a signal or no status has not finished: the task is failed, and the text it had written by then is shown as a partial result. Only a clean exit, or a turn the transcript shows closed, completes a task.
- A run and a send never carry the same text. Send is off and refused while a run is on its way, Run is refused while a send or a spoken send is on its way, and a spoken countdown is cancelled when a run starts.
- A task's session folder is spelled through the case path, not the path git resolves, so a linked case behind a symlink still resolves to its canvas for the task's own session.
- After a restart nothing in memory says a turn ended. What is live wins over what was recorded: a task whose session is working or asking is running or waiting whatever its record says. A turn end nobody saw is taken only from all of these together: the screen shows no work, no question is pending, the transcript holds the request, it has not been written for thirty seconds, and two reads agree. That settles the task's state and posts nothing into a thread. A request a stopped server left on its way is recorded delivered when the transcript holds it and not delivered otherwise, and Retry sends the same message again once.
- The list is cheap. A working task's transcript is not read. A closed list asks only for each task's state, at most every two seconds, and that answer reads no result.
- A session start that throws undoes the worktree like any other failed step. A `task-` worktree that no task names and no session is inside is listed as left behind, with a Remove that uses the same non-force rule; nothing removes one on its own.
- The refusal says why no worktree can be made: not a repository, no commit yet, a subfolder of a repository, a bare repository, or a Docker workspace. Each offers the shared tick.
- Remove says what it kept and why: changes, a session still inside, a git lock, a folder git no longer knows, a session that would not close, or a failure. A row kept after its session is gone still shows the result, which is stored on the record before the session is discarded.
- The hooks file and the agent skill copy that a session start writes are always written into the repository's `info/exclude` when a task worktree is made, whatever the machine's own git ignores say, so a task that only replied is removable under any git configuration. A warning from that step rides the row.
- A spoken turn is refused while the rail shows a task. A reload while a run was on its way is said in the composer, and settles by itself when the task turns out to be listed.
- A parent conversation is recorded only when it is an ordinary conversation of the same workspace.
- "Only a person" rests on the caller-declared agent header, as it does for conversations: a caller that does not declare itself an agent is treated as a person. It keeps agents that use Codeman's own tools from starting, cancelling, removing or retrying tasks. It is not a defence against a process that calls the HTTP API without the header.

Left as they are, and why:

- The question card's title, "Claude needs your permission", comes from the shared approvals code and is the same for every session. It is not task code and is not changed here.
- Remove does not look inside a worktree to decide that only Codeman's own files changed. Telling those files from the agent's by content is not decidable in general, so git's own answer stands and the row explains it.
- Retry needs the request text, which the server never stores. It is offered in the browser that started the task, for its last eight tasks.
- Clearing a pasted request from the composer with Escape is checked against a stand-in pane. On a real agent the claim the row makes rests on reading an empty composer afterwards, not on what Escape is known to do.

