# Intent: One placeholder on an Authorization bearer

**Status:** Draft

## Problem statement

`Authorization: Bearer abc1234` is stored and read back as `Authorization: [redacted]]`. The secret is gone. A second `]` is not.

## Proposed outcome

That header, in any capitalization of `authorization` or `bearer`, and `Proxy-Authorization: Bearer …`, is one `[redacted]`. `headers: [Authorization: Bearer …]` keeps the one bracket that closed the array. A free-standing `Bearer` token is still `Bearer [redacted]`. No redaction row gains `[redacted]]`, `[redacted][redacted]`, or `[[redacted]` unless the input already had that bracket.

## Affected users and systems

Operators reading `GET /api/logs`, and the telemetry writer that redacts before the queue.

## Constraints

Do not strip a `]` after the fact. The bearer shape and the header rule share the span, and the placeholder is written once. The per-record time bound stays. Token counts, session ids, and the hook-secret cap stay as they are.

## Open questions

None.
