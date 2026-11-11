# Intent: Fix canvas screenshot session, cleanup and errors

**Status:** Draft

## Problem statement

A session-scoped screenshot request loses the object id, so `canvas_screenshot` cannot return an image. A `browser.close()` that never settles holds the only render slot and leaves the browser process running. A bad `mermaid-runtime.json` puts the server's data directory path in the HTTP error.

## Proposed outcome

The workspace pre-handler sets `workspaceId` and keeps every other param. `browser.close()` waits at most 2 seconds, then the browser pid is killed and the exit wait is bounded. The render queue is released without awaiting a close that does not settle. The next render launches. Server shutdown and a client hang-up use that same close. Screenshot HTTP and MCP answers contain no filesystem path. A missing browser is a 503 that names `codeman mermaid setup`. A bad runtime config is a 500 `Screenshot renderer is misconfigured on this server`, and the path is logged on the server. `codeman mermaid` still prints the detailed configuration line.

## Affected users and systems

Agents calling `canvas_screenshot`. Humans calling the screenshot route. Server shutdown. The Mermaid CLI, which keeps its own error text.

## Constraints

One render at a time. The caller's 20 second budget includes the wait. Stored canvas data stays forward-compatible. The Mermaid sandbox and `libraryPath` behaviour stay as they are. No new commit hook or CI gate.

## Open questions

None. The exit wait uses the same 2 second bound as close. A queue backlog cap and a total stored-image byte cap are left unset; neither number is in the plan.
