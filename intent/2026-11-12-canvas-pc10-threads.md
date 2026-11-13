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
- Routing runs when the stop hook fires and whenever the conversations are listed or read, in the background. An open turn is settled only on a turn end this process observed after it began writing the message to the pane (`submittedAt`), with the session not working, and after a second read of the transcript gives the same text. A turn closed by a later submitted prompt, or an exited agent, settles on any pass. Accepted cost: a turn whose stop this process never saw stays "Waiting for a reply" until a later prompt closes it or 24 hours pass.
- A prompt the CLI queued during a turn does not close that turn. A turn that absorbed a queued prompt gives every thread request in it the turn's whole text, with a line saying the turn answered more than one message; otherwise the reply is the text after the request's own prompt.
- An agent that exited before a reply records `session-ended`. A request whose prompt is not in the transcript after 24 hours records `timed-out`; one whose session the server no longer holds records `session-ended` after the same bound. A closed turn with no text records `no-reply`. An append the command path refuses records `refused`; a throw records nothing and is tried again.
- A comment already under the reply id counts as the reply only on the origin object and by that conversation's agent session. Any other records `refused`.
- A reply can grow while its turn is open and never changes what was posted: later text is a further comment, at most five in all, the last saying more may follow. Splitting one turn's text over two comments is accepted; posting a wrong or partial final reply is not.
- A new message whose comment or object is gone is refused with `ORIGIN_GONE` before anything is written to the pane.
- The prompt is the comment text alone, with the object as context. No extra instruction is added.
- The chooser is an inline native select: the rail's live conversation first, else the newest live one, else New conversation on the rail's provider and model. Ended conversations are not offered. A provider that cannot start is explained in line and nothing is posted.
- Retry on a request line reuses the comment's own text and ids. The same text on the same object keeps its comment ids whichever conversation is chosen next. An attempt cut off by a reload comes back as the draft with Retry; Post on it sends the same comment again, never a second; the attempt is dropped once the conversation list shows the message.
- Ask agent has no keyboard shortcut. Cmd/Ctrl+Enter already posts an ordinary comment and the brief names no other.
- An agent may send with an origin through `canvas_conversation`; it cannot create with one. The field is kept out of the tool's create shape, which also keeps the capabilities answer inside its byte budget.
- The route test's mock session gained `markHookStop`; nine hook-event route tests failed without it on the default branch.

## Fix round 1

An audit of the first commit found reply-routing defects with one cause: a reply is recorded once and never corrected. The rule is now to keep waiting rather than record a wrong final reply.

1. A queued prompt no longer closes the turn before it (rows carry `queued`); the shared-turn attribution above.
2. An unclosed request settles only on a stop or idle transition observed after delivery, never while the session works, and only when two reads agree.
3. A throw while posting records nothing. `refused` is for an invalid append.
4. An unchanged transcript is not re-read; a request gives up with `session-ended` or `timed-out`; the list computes each conversation's requests once.
5. The stop callback is inside the branch for modes whose hooks are available.
6. A comment under the reply id counts only on the origin object by the conversation's agent session.
7. Post after "Your comment is posted. The agent was not asked" reuses the stored comment ids and clears the draft; a draft survives a reload in the middle of an ask.

A run on a real agent added these:

8. A reply is extendable, not final: it is all the text after its prompt up to the next submitted prompt. Text that arrives after the first post (a last row written after the stop hook, or a turn the agent resumed by itself after a background task) is posted as a further comment, `reply-<messageId>-2` up to `-5`, deduped by the posted length recorded on the message. A record of the first shape stays settled.
9. The two reads are 1.5 seconds apart and the pass after a stop posts by itself, with no read by a client.
10. The thread says "Reply removed" when the reply's comments are gone, and nothing is posted again.
11. The list's `working` is a hook turn or the session's working state, and the list is read again shortly after an ask, so phone and desktop agree.
12. An unposted thread draft is kept per object across a reload.
13. F1 while typing opens Keys in the rail composer too, so the thread composer was left the same.

## Fix round 2

A turn that ended before its delivery was confirmed never settled on its own, because the stop was compared with `deliveredAt`. The message now records `submittedAt`, the time the server began writing it to the pane, and an open turn settles on a turn end observed after that. The other guards stay: the session is not working, two reads agree, and the prompt row with this message's id is in the transcript with the text after it. A retry that writes the message again stamps the time again, so a stop seen before that write does not count. A confirmed delivery routes replies itself, and a stop that arrives while the message is still being delivered is looked at again.

In the "Your comment is posted. The agent was not asked" state only Retry is shown and Post is reached with Cmd/Ctrl+Enter. No hint or Keys text names a Post button there, so nothing changed.

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
