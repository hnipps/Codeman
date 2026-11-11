# Intent: Let agents query redacted logs

**Status:** Draft

## Problem statement

Supervised deploys write JSONL telemetry under `CODEMAN_LOG_DIR`, and an agent that wants a line has to open those files itself. Nothing masks a bearer token, a URL password, a secret-shaped JSON value, or the hook secret before the bytes land on disk. There is no admin-only query for one stream.

## Proposed outcome

Every telemetry line is redacted by one pure function before it is queued for disk. `GET /api/logs` and the `logs_query` MCP tool return already-redacted lines from one stream and its rotated `.1` file, filtered by time, level, and a literal substring, with a row cap and a byte cap. With no log directory the route returns an empty list and a reason. Canvas and tab-strip events can be appended as `ui-events.jsonl` through `POST /api/client-errors`.

## Affected users and systems

Agents diagnosing a deploy, admins in multi-user mode, and the supervisor's telemetry directory. Single-user callers who can already read `/api/health` can query logs. A non-admin in multi-user mode cannot.

## Constraints

Redaction runs on every line, must not throw, and must not compile a caller-supplied pattern. Querying must not load a whole rotated file into memory at once. The route uses the `ApiResponse` envelope. `logs_query` returns text only. No parameter reads unredacted bytes. New files stay ignorable by the previous release.

## Open questions

None.
