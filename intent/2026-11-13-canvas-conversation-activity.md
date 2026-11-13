# Intent: tool rows, Sources used and release outcomes in the canvas conversation

**Status:** Draft

## Problem statement

The assistant rail shows a conversation as prompts and replies only. A person cannot see what the agent did between two replies: which files and canvas objects it read, which commands it ran, or what came back. The plan's "Sources used" disclosure does not exist; the line of chips under a message names only what was attached at send time. When the agent in a conversation asks the deploy supervisor for a release, the only sign of how it went is whatever the agent writes afterwards.

The PC9b journal entry says "Tool activity rows are not built" and gives no reason. The reason is in the code: the one transcript reader the rail and the thread-reply router share (`parseClaudeResponseTranscript`) drops every `tool_use` and `tool_result` block, and reply routing depends on that reader returning text rows only.

## Proposed outcome

- The transcript reader can also fill a tool ledger while it makes the same text rows as before. Reply routing and `last-response` are unchanged.
- `GET /api/canvas/:workspaceId/conversations/:conversationId/activity` answers the conversation's tool calls with their results, each anchored to the text row it follows, plus the release requests found among them joined with the deploy supervisor's own record. The `canvas_conversation read` answer carries the same activity for an agent, bounded.
- The rail shows tool calls as quiet rows between replies. A row opens to a bounded excerpt of its result.
- Each turn ends with a "Sources used" disclosure: what was sent with the message, and what the agent read afterwards (files, searches, web addresses, canvas reads).
- A release the agent asked for with `codeman-deploy` appears as a Release row with the supervisor's recorded outcome, or the outcome the command printed when the supervisor's recent runs no longer list it, and says which of the two it is.

## Affected users and systems

People using the canvas assistant on desktop and phone; agents using `codeman mcp`; `src/web/routes/session-routes.ts` (the reader gains an optional collector), the canvas conversation routes and port, the canvas bundle.

## Constraints

- Read-only. Nothing here starts, queues or cancels a deploy or a rollback. The supervisor is reached only through the existing `readOverview()` status read.
- Tool input and output are untrusted and can carry secrets: every field is cut to a fixed length on the server, passed through the telemetry redactor, and reaches the DOM through `textContent`.
- Nothing is stored. `conversations.json` keeps its shape, so the previous release reads it as before.
- An event never moves the camera, selection or focus; an open disclosure stays open across a repaint.
- Claude transcripts only. Another CLI's conversation answers `supported: false` and the rail shows no tool rows for it.

## Open questions

- The plan also says no release was started from the canvas. This change builds no trigger. A person can already ask the conversation's agent to release; whether the canvas should offer its own control is the owner's call.
