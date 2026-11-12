# Intent: Canvas view registry and direct context (PC9a)

**Status:** Draft

## Problem statement

An agent cannot see where a person is looking on the canvas or move their view, and a person cannot hand a few objects to an assistant without copying text. The reserved `canvas.viewport/selection/focus/context.*` commands are listed as unavailable, and the dock has no place for an assistant.

## Proposed outcome

- A server view registry (in memory, 60 s TTL, owner-scoped) that each canvas tab publishes to, and two agent tools, `canvas_view` and `canvas_context`, that read and steer one open view. The same commands the browser runs.
- An assistant view in the right rail: pending context as removable chips (a container shows how many objects it holds) and a draft that survives reload. Send says conversations arrive next and keeps everything.
- `C` / Cmd or Ctrl+`.` toggle the rail; Cmd/Ctrl+Enter and an Add to chat button in the selection row add the selection; holding `Q` and dragging a loop adds the objects whose centre it encloses. None of these writes an operation or moves the camera.
- `canvas_query` accepts `semantics: 'center'`, so an agent can reproduce a lasso.

## Affected users and systems

Canvas page (`packages/canvas`, `canvas.html`, `canvas.css`), `src/canvas` (view registry and schemas, query semantics), the canvas command route and two REST routes, the MCP server (28 tools), docs. Desktop only: a phone stays read-only and has no assistant until PC9c.

## Constraints

- Behind `canvasEnabled` (default off). View state is ephemeral and never stored; no new stored file.
- Conversations, model routing and the phone assistant are PC9b/PC9c. Nothing here starts a session or writes a prompt.
- The one write gate stays `DesktopEditor.available()`; the phone refuses the assistant rail even when an agent asks.
- Single-letter keys never act in a text field or under IME composition.

## Open questions

None. Plan choices that differ from the PC9 plan are in the journal entry.
