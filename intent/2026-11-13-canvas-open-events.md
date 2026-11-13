# Intent: The canvas and the tab strip write UI events, and six telemetry and canvas follow-ups

**Status:** Draft

## Problem statement

The canvas plan's "Open at close (2026-11-13)" list says of PC8: the `ui-events.jsonl` stream and its intake exist, but nothing in the canvas or the tab strip writes to it. An agent that asks `logs_query` for `ui-events` gets an empty list on a server people are using.

Six smaller things were found beside it:

1. A request id such as `req-6` is a per-process counter, so the id in an HTTP error answer names a different request after every restart.
2. The telemetry tests added with the canvas failure work, and `test/canvas-shell-compat.test.ts`, are not in the deploy gate.
3. A polled canvas sessions route writes an error line on every poll while a case folder sits on a mount that stopped answering.
4. An unnamed session has one name in the canvas outline and another in the classic view.
5. On a phone the Canvas button of a session page sits flush against the top edge of the screen.
6. Two browser tests fail about one full-suite run in three, and opening the canvas logs a console 404 for a session that has no response yet.
7. `docs/architecture-invariants.md` gives a wrong count of MCP tools.

## Proposed outcome

- The canvas pages and the classic tab strip post what a person did to `POST /api/client-errors` with `kind: "ui"`, and `logs_query` on `ui-events` returns those lines.
- The events are tokens: an action name and an id, a tool or view name, or a state word. No typed text, prompt, session name or object content is sent, and the route refuses a value that could carry one.
- The reporter is bounded: a batch of at most 25 events, one request every two seconds, a repeated event counted once, 1000 entries a page load, events dropped while the page is hidden or the browser offline, nothing retried.
- Each follow-up above is fixed in its own commit, with the reason recorded in `docs/JOURNAL.md` where it is a decision.

## Affected users and systems

- An agent or a person diagnosing a fault through `GET /api/logs` or `logs_query`.
- Clients of `POST /api/client-errors`: a `kind: "ui"` body may carry `events`, and `target` must be a token.
- `src/web/public/ui-events.js` (new), `index.html`, `canvas.html`, `app.js`, `webview-tabs.js`, `packages/canvas/src/{ui-events,entry,home,edit}.ts`, `src/web/routes/telemetry-routes.ts`.

## Constraints

- No new route, no new stored file, no new setting. `ui-events.jsonl` gains two optional fields a reader that does not know them ignores.
- The previous release answers a batch body with 400. The reporter drops it. Nothing else changes for that release.
- The 120 requests a minute budget of the intake is not raised.
- `docs/self-building.md` and `docs/agentic-canvas/initial-version-plan.md` are not edited here.

## Decisions

- One reporter script for both pages, exposed on `window`, with the canvas bundle calling it when present.
- The canvas records at its two command funnels (`dispatch()` and the editor's submit), the dashboard at the functions a tab action already goes through.
- An agent's view command is not a UI event.
- Escape and the rail's close button pop the rail without naming it, so `rail.close` is named from the rail view on top before the command.
- The console 404 came from a conversation whose session was deleted, not from a session with no response yet (that state answers 200). The conversation summary carries an optional `sessionGone` and the rail skips the transcript read.
- `test/canvas-ui-events.browser.test.ts` is the end-to-end proof: real keys and clicks, the file read back through `logs_query`, and a check that no draft, object text or session name is in it.

## Open questions

None.
