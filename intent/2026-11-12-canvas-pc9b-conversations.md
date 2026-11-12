# Intent: Canvas conversations and projection (PC9b)

**Status:** Draft

## Problem statement

The assistant rail holds context chips and a draft, but Send only says conversations are not ready. A person cannot ask an agent about their canvas, and an agent cannot take part in a conversation the person can see.

## Proposed outcome

Send starts, then continues, a real Claude session in the case folder, reached through the ordinary session create and write paths. The rail shows that session's own transcript with the chips each message carried, one calm state line, an approval card, and designed failures (could not send, session ended, offline) that keep the draft and chips. Context travels as reference text resolved on the server, recorded as ids and revisions only. Delivery is confirmed as submitted (never merely pasted), with a visible Sending state and a Retry that never pastes twice. Nothing auto-sends. Only a person starts a conversation, Docker and remote cases are refused, and `canvas_conversation send` gives agents the same checks plus a rate limit and a refusal from inside any conversation.

## Affected users and systems

People using the canvas on desktop; agents using `codeman mcp`; the canvas routes, the MCP tool list (now 29 tools), the SSE registries (`canvas:conversation`), and the data directory (`canvas/<workspace>/conversations.json`, ignored by the previous release).

## Constraints

No new spawn path or transport. Prompts are pasted with `writeViaMux` and a trailing carriage return, never as one burst. No respawn, auto-resume, Ralph, orchestrator, API keys or credentials. Phone stays read-only with no assistant. Prompts are never logged or searched. Public repository: no hostnames, ports, users or paths.

## Open questions

Whether a multi-line paste is confirmed as submitted by a real Claude build (`SubmitVerifier` cannot recognise one). Not verified against a real agent in this change. Provider and model choice, the phone view and Keys belong to PC9c.
