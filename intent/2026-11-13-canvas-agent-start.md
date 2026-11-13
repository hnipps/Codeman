# Intent: Agents start canvas conversations and background tasks, within bounds

**Status:** Draft

## Problem statement

A person can start a canvas conversation and start, cancel or remove a background task. An agent working in the same case cannot do any of these: the routes answer 403, by decision (journal 2026-11-12 PC9b fix round, PC12 intent). The capability matrix in `canvas-foundations.md` asks that no human command stay without its agent counterpart, and the owner has now asked for these to be built (2026-11-13).

The earlier decision guarded against these risks:

- A start is a new agent session on the person's own account, so it costs money and runs code without a person's click.
- Agents starting agents can fan out (one start becomes many) or loop (agent-started work starting more, or two conversations answering each other) with no person in the loop. PC9b's fix round already met the loop half for sends: an agent that is itself a conversation's session cannot message a conversation.
- A person's canvas fills with work they did not ask for and cannot tell apart from their own.
- A background task can run in the shared case folder only after the person ticks consent.

## Proposed outcome

An agent attached to a canvas case (its session's folder is inside the case, resolved by the existing workspace pre-handler) can, through `canvas_conversation create` and a new `canvas_task` tool (`list`, `start`, `cancel`, `remove`), do what a person does, through the same routes and domain functions, under these bounds held in code and pinned by tests:

- Only the workspace the agent is attached to. The workspace comes from the caller's own session, as for every canvas tool; a session is started only through `startConversationSession`, the same create and start routes and ownership checks a person's click uses.
- Depth one. A session started by an agent (a conversation or task whose record says an agent started it), or any session whose recorded spawn parent chain reaches one, cannot start a conversation or a task. Sessions of person-started conversations may start; the work they start may not.
- Caps. The existing per-workspace caps apply (four active tasks, fifty records). On top, agents together hold at most two active tasks and two live conversations per canvas, so agents never take the person's last places.
- Attribution. The record carries `startedBy: { kind: 'agent', sessionId }`; the task list row, the rail's conversation picker and the session's lineage line (its `parentSessionId`) say an agent started it. The request message is authored by the agent.
- The person can cancel and remove anything an agent started, through the controls they already have.
- An agent may cancel or remove only tasks it started itself.
- An agent cannot consent to the shared case folder: an agent-started task runs in a worktree or not at all. An agent cannot attach a thread origin or a parent conversation.
- Nothing new loops or runs on a timer. The started session gets no respawn, auto-resume, Ralph or keep-warm field, and the parent link means it does not inherit the keep-warm default.

Voice stays human-only (an agent has no microphone). Flip is another builder's.

## Affected users and systems

People using the canvas; agents using `codeman mcp`. `src/canvas/{agent-start,tasks,conversation-schema,commands}.ts`, `src/web/routes/{canvas-conversation-routes,canvas-task-routes,canvas-routes}.ts`, `src/web/ports/canvas-port.ts`, `src/web/server.ts`, `src/mcp-server.ts`, `packages/canvas/src/{assistant,task}.ts`, docs and tests.

## Constraints

- No new spawn path, no new pane write path, no new worktree code.
- Stored data rolls forward: `startedBy` is a new optional key on a passthrough schema; the previous release reads the record unchanged.
- "Agent" remains the caller-declared parent-session header. The bounds keep agents that use Codeman's own tools inside them; they are not a defence against a process that calls the HTTP API without the header, which is no change from today.
- `parentSessionId` stays decoration for every purpose except this one refusal: it can only take a start away, never grant one.

## Open questions

- A single agent working through a long turn can start, wait for, remove and start again, within the caps. A lifetime budget per agent session is not built.
