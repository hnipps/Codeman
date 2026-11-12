# Intent: Provider and model choice, the phone assistant and Keys (PC9c)

**Status:** Draft

## Problem statement

The assistant rail always starts a Claude session on Claude's own default model, there is no assistant on a phone, and Keys does not list the shortcuts the rail added. A person cannot pick which installed agent CLI or model the next conversation uses, and an agent cannot learn or set that choice.

## Proposed outcome

Two compact selectors under the composer pick the provider and model of the NEXT new conversation. The list comes from `GET /api/canvas/assistant/providers`: enabled, installed agent CLIs from the registry, each saying whether a conversation can start on it and, if not, why. Availability is decided from capabilities only, and a CLI whose send cannot be confirmed (no hook and no composer ready mark plus glyph to read) is listed as unavailable with a reason. The model is "Session default" or a free-text id held to the narrowest shape that CLI's launch accepts. The choice lives in view state, is read only when a conversation is created, is recorded on the conversation and shown on its agent rows, and a changed choice with a conversation bound shows "Next message starts a new conversation on X" while the old conversation is left alone. `canvas_conversation model` reads or sets a view's choice. The phone gets the same assistant as a full-viewport view with Close, a composer above the keyboard, Return as a line break and an Add selection button. Keys lists the new bindings and marks B, Shift+B, G and Cmd/Ctrl+Shift+Enter as arriving later. A Not delivered row whose text only the interrupted attempt held keeps its Retry after a reload.

## Affected users and systems

People using the canvas on desktop and phone; agents using `codeman mcp` (`canvas_conversation` gains `model`); the canvas routes, the view registry (an optional `choice` in a published view and an `assistant-choice` view command), the conversation record (an optional `model`, ignored by the previous release), `WebServer.startConversationSession`, and Keys.

## Constraints

No new spawn path: create still goes through `POST /api/sessions` then `/interactive`. For claude the model is the per-session `model` field, for a `flag` CLI it is the registry's config object and key, and `modelOverride` is never sent. No CLI id is branched on. Starting stays human-only. Nothing is stored that the previous release cannot ignore. No respawn, auto-resume, Ralph, hooks or launch argument other than the model. Public repository: no hostnames, ports, users or paths.

## Open questions

Copilot has composer evidence but Codeman cannot see when it waits on an approval (no hook, no `blockedLine`), so it is listed unavailable; claude is the only available stock CLI. A custom registry entry with composer evidence plus a `blockedLine` or hooks is available but unverified against a real pane; the coordinator runs the live lanes. The model suggestions are only models this canvas already used, because the registry carries no model catalogue.

## Fix round 1

From the independent audit. Availability now also requires that Codeman can tell the CLI is waiting on an approval or question (`hooks !== 'none'` or a declared `blockedLine`), which makes GitHub Copilot unavailable with its own reason. A create naming no CLI refuses when the default CLI is disabled in the registry (still unprobed for installation). The model field is capped at 100 characters. A choice set by an agent says so in the rail until the person changes it. Dead code removed, and the create and `model set` refusals now share one function. Known and left alone: a retried create whose response was lost reuses the earlier conversation even if the selector changed; a page left open across a rollback sends `choice` to a release that refuses it until reloaded.
