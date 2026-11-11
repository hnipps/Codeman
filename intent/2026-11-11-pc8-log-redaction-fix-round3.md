# Intent: Close the last log-redaction leaks

**Status:** Draft

## Problem statement

A third audit of the redacted telemetry log still found secrets on disk. An assignment buried inside a quoted value (`note: "password=…"`, a `JSON.stringify` detail, or `util.format`) kept the secret. A URL with more than one `@` in the authority masked only through the first one. A key that starts with a digit (`1password`) was not treated as a key. The same pass over-masked three ordinary diagnostics: a stack frame's line and column, a URL that is only `host:port`, and an `Error:` label after a credential-shaped key. A quoted key about a megabyte long also took hundreds of milliseconds because the scanner copied and normalised it.

## Proposed outcome

Those secrets are `[redacted]` on disk and in `queryLogs`. The stack frame, the host and port, and the `Error:` label stay. A one-mebibyte quoted key redacts in well under 50 ms on this machine, and a four-mebibyte one in well under 200 ms. `redactLogLine` applied twice matches one application, including the witness `passw://}s://[@`. The docs say an unlabelled secret is still not detected.

## Affected users and systems

Operators reading `GET /api/logs` or the `logs_query` tool, and the telemetry writer that redacts before the queue. Config backup's own key rule is unchanged.

## Constraints

The attribution allowlist stays as it is. `keyboard`, `sessionKey`, and an env name that merely contains `key` may still be masked. The hook-secret read stays capped at 512 bytes. The query tail rule and the 64 KiB line cap stay. No new intake route, and no raw-line switch. The redactor remains a second line behind not logging secrets.

## Open questions

None.
