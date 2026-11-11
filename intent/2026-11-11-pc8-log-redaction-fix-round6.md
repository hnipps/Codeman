# Intent: A token count must be a whole number

**Status:** Draft

## Problem statement

`tokens: 1synthetic-credential-123456789` is left on the log line. Round 5 treated any value that starts with a digit as a usage count.

## Proposed outcome

A token-count key keeps its value only when the first value token is entirely a number: digits, optional `.` `,` `_` separators between digits, and an optional `k` or `m` suffix. `tokens: 15234 input, 921 output`, `max_tokens=4096`, `tokens: 174k`, and `{"inputTokens":15234}` stay. A value with anything else glued on is `[redacted]` on disk and in `queryLogs`.

## Affected users and systems

Operators reading `GET /api/logs`, and the telemetry writer that redacts before the queue.

## Constraints

The rest of the round 5 rule stays: an object, array, or quoted string under a count key is masked, and `token`, `access_token`, `refreshTokens`, and `authTokens` stay secret. The per-record time bound stays.

## Open questions

None.
