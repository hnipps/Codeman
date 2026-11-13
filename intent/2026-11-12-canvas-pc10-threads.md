# Intent: Ask an agent from a comment thread (PC10)

**Status:** Implemented

## Problem statement

A comment on a canvas object is only a note. A person reading a thread cannot ask an agent about that object from the thread, and an agent's answer never appears where the question was asked. The assistant rail and the comment threads are two separate places.

## Proposed outcome

The thread composer keeps Post, which stays an ordinary comment and never starts agent work. Beside it, Ask agent is an explicit request: it posts the comment and sends it to a chosen conversation (an existing one of this workspace, or a new one on the rail's current provider and model choice), carrying the object as context. The send goes through the same conversation send path as the rail, so the same session, delivery chain, rate limit and refusals apply.

The request is recorded on the conversation message as `origin: { kind: 'thread', objectId, commentId }`. When that turn ends, the server posts the agent's reply text into the originating thread as an ordinary `comment` operation authored by the agent's session, with a comment id derived from the message id, so a repeat of the stop signal or a retry posts nothing twice. Routing reads only the recorded origin, so another open thread or a changed selection cannot move a reply. The message records `reply: { commentId, postedAt }`.

The thread shows the request's state on the asking comment (queued, sending, working, replied, not delivered) and an Open conversation action that opens that same conversation in the assistant rail. In the rail, a prompt that came from a thread shows a backlink that selects the object and opens its thread.

Agents get the same request as a `canvas_conversation` action only where the existing send rules already allow it; nothing new lets an agent start work. The MCP object tools are checked against the human edit actions and any missing supported operation is added through the existing command path.

## Affected users and systems

People using canvas comments on desktop and phone; the assistant rail; `src/canvas/conversation-schema.ts`, `conversations.ts`, `src/web/routes/canvas-conversation-routes.ts`, the hook-event path that already reports a turn's end to conversations, `packages/canvas/src/{comments,assistant,conversation,entry}.ts`, canvas HTML and CSS, and their tests.

## Constraints

- The stored comment shape is `.strict()` and read by the previous release, so it does not change. The link between a comment and a request lives only in `conversations.json`, whose schemas pass unknown keys through.
- No new spawn path and no new write path to a pane. A new conversation is made by the existing create; the message by the existing send.
- A comment or a mention alone never starts agent work. Only Ask agent does, and only a person can press it.
- The reply comment is written through the ordinary command path with the agent session as author, so author revert and undo treat it like any agent write. It is cut to the comment text limit with a note that the full reply is in the conversation.
- A reply is posted only for a message that has a thread origin and no recorded reply; an object that no longer exists drops the reply and records why.
- The phone can ask and read replies; it follows the phone assistant's rules.
- Everything stays behind `canvasEnabled`. Public repository: no hostnames, ports, users or paths.
- No respawn, auto-resume, Ralph or orchestrator.

## Open questions

- The reply text is the assistant rows of the transcript between the asking prompt and the next prompt. A turn that ends on a question to the person posts that question text; the thread then points to the conversation to answer it.
- App-change requests, verification and release outcomes already stay in the conversation because the conversation is a real session in the case; this change adds no deploy control. The release-continuity check is run by the coordinator on a deployed build.

## Decisions

Settled while building; none changes the outcome above.

- `origin` and `reply` are stored as unknown values and read through lenient readers. A shape this release does not know reads as "no origin" or "already settled", so the file stays readable and nothing is posted twice.
- The reply comment id is `reply-<messageId>`. The existing comment under that id is the dedupe, and reply work is one chain per workspace.
- The reply is appended by the server with the agent session as author. The stop hook carries no person's credentials, so the HTTP command route is not called; the operation and the change notice are the same.
- The transcript is read with the reader behind the session's last-response route, handed to the canvas port.
- Routing runs when the stop hook fires and whenever the conversations are listed or read, in the background. The newest prompt is settled only when no hook-reported turn is running and either the stop just fired or the session is not working. Known limit: after a restart in the middle of a turn, a reconcile can post the text written so far.
- A session that ended before a reply leaves the request unsettled; the thread says "Session ended before a reply". A closed turn with no text records `no-reply`. A refused append records `refused`.
- A new message whose comment or object is gone is refused with `ORIGIN_GONE` before anything is written to the pane.
- The prompt is the comment text alone, with the object as context. No extra instruction is added.
- The chooser is an inline native select: the rail's live conversation first, else the newest live one, else New conversation on the rail's provider and model. Ended conversations are not offered. A provider that cannot start is explained in line and nothing is posted.
- Retry on a request line reuses the comment's own text and ids. The same text on the same object keeps its comment ids whichever conversation is chosen next.
- Ask agent has no keyboard shortcut. Cmd/Ctrl+Enter already posts an ordinary comment and the brief names no other.
- An agent may send with an origin through `canvas_conversation`; it cannot create with one. The field is kept out of the tool's create shape, which also keeps the capabilities answer inside its byte budget.
- The route test's mock session gained `markHookStop`; nine hook-event route tests failed without it on the default branch.

## MCP parity

| Human action | Tool |
| --- | --- |
| Create, duplicate, paste | `canvas_create` |
| Edit text, move, resize, rotate, reparent | `canvas_update`, `canvas_transform` |
| Delete | `canvas_delete` |
| Align, distribute, order, wrap | `canvas_arrange` |
| Lock, unlock | `canvas_lock` |
| Undo, redo, revert a session | `canvas_history` |
| Comment | `canvas_comment` |
| Link preview, embed | `canvas_link_preview`, `canvas_update` |
| Image upload | `canvas_upload_image` |
| Ask agent | `canvas_conversation` send with `origin` (start stays human-only) |

Nothing was missing, so no tool was added.
