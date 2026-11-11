# Intent: Mask auth headers, cookies, and known tokens in logs

**Status:** Draft

## Problem statement

A line can still keep a secret after round 3. `Authorization: Basic …` keeps the credential after one masked word. Cookie and `Set-Cookie` headers are left intact. A multi-word password keeps every word after the first. Tokens shaped like `sk-…` or `ghp_…`, and a curl `-u user:pass` argument, are not recognised unless a credential key happens to cover them.

## Proposed outcome

Those values are `[redacted]` on disk and in `queryLogs`. `cookie`, `set-cookie`, `codeman_session`, and `sid` are secret keys. `session`, `sessionId`, `session_id`, and `claudeSessionId` are not. Known token shapes are masked with no key. The stack frame, a host and port, an `Error:` label, an ordinary request row, and attribution fields stay.

## Affected users and systems

Operators reading `GET /api/logs`, and the telemetry writer that redacts before the queue. Config backup's key rule is unchanged.

## Constraints

Unquoted secret values run to the newline, so the rest of that line may be lost. The scan stays linear. The 1 MiB and 4 MiB bounds from round 3 still hold. Session ids used to correlate log rows are not secret keys.

## Open questions

None.
