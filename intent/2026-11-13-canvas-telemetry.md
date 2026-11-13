# Intent: Diagnose a canvas fault from telemetry alone

**Status:** Draft

## Problem statement

The Agentic Canvas program closes with a gate: plant a failing request in a throwaway instance and diagnose it with `logs_query`. A verifier ran it on the merged build and it passed only in part. The agent found the failing request and could not name its cause. Five things stood in the way or were found beside it:

1. A canvas request that failed on the server left a line in `requests` and nothing in `server`. The canvas routes' error handler answered without logging.
2. The canvas pages posted no browser errors. The dashboard does.
3. The 500 body carried the absolute path of the workspace's operation log, home directory included.
4. The embed proxy left an unquoted root-absolute attribute (`<script src=/s.js>`) alone, so the browser asked the server root for it.
5. The canvas page earned a 429 from its own view publishes when a person clicked a few controls within a second.

## Proposed outcome

- Every canvas route answer of 500 or above writes one server error line with the route template, the cause and the request id of that request's `requests` line.
- The body of that answer is a sentence with no path, plus the request id.
- The log line names the data and home directories without spelling them out, and still gives the errno, the file's role and the workspace.
- Both canvas pages report uncaught errors and unhandled rejections to `POST /api/client-errors`, with the dashboard's limits. The boot guard's fallback is unchanged.
- The proxy rewrites unquoted root-absolute `src`, `href` and `action` like the quoted forms.
- One canvas page can no longer exceed the server's view-publish allowance by itself.

## Affected users and systems

- An agent or a person diagnosing a canvas fault through `GET /api/logs` or the `logs_query` MCP tool.
- Clients of the canvas HTTP routes: a 5xx body has a new fixed sentence and a `requestId` field. Status codes, `success` and `errorCode` are unchanged.
- `src/web/routes/canvas-*.ts`, `src/web/webview-proxy.ts`, `packages/canvas/src/view-sync.ts`, and the two canvas page entries.

## Constraints

- A 4xx writes no log line.
- The proxy serves nothing it did not serve before. Only the rewrite changed.
- The server's view-publish limit is not raised. The cause is fixed at the page's pacing.
- No new route, no new stored file, no new setting. The previous release reads everything this one writes.
- `docs/self-building.md` is not edited here.

## Decisions

- One function, `canvasFailure()`, answers every canvas 5xx. The screenshot route and the two "case folder is not answering" answers call it too, so the rule holds for answers that never reach the error handler. The case-folder sentence loses the path it used to end with.
- The request id is always in a `requestId` field, and in the fixed sentence. A sentence a route supplies (the screenshot's, the case folder's) is sent as written, since clients and tests match those words. The envelope already carries extra fields on canvas answers (`reasons`).
- The publish gap is counted from the previous publish's answer and one publish is in flight at a time. The old gap was counted from the send, while the server counts from when it handled the request. A publish with no answer after 10 seconds is aborted so a stalled request cannot stop the view publishing.
- The injected runtime shim's own HTML rewriter (`rwHtml`, for markup a page assigns at runtime) is left as it is. Its mutation observer already rewrites the attributes of inserted nodes.

## Open questions

- The gate itself (a planted fault in a throwaway instance, read with `logs_query`) was not rerun here: this change starts no server. The route test reads the error line through the same reader `logs_query` uses.
