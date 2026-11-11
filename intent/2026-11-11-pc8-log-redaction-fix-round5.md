# Intent: Keep token usage counts in logs

**Status:** Draft

## Problem statement

`tokens: 15234 input, 921 output` is written as `tokens: [redacted]`. That line is a usage count, and this app logs it all the time. The word `token` makes the key look like a credential.

## Proposed outcome

A key that only counts tokens keeps a value that starts with a digit, on disk and in `queryLogs`. `inputTokens`, `outputTokens`, `totalTokens`, and `max_tokens` stay. `token`, `access_token`, `refreshTokens`, and `authTokens` stay masked. A `tokens` value that is an object, an array, or a quoted string stays masked.

## Affected users and systems

Operators reading `GET /api/logs`, and the telemetry writer that redacts before the queue.

## Constraints

Singular `token` stays secret. A count key that also contains `auth`, `access`, `refresh`, `secret`, `bearer`, `api`, `session`, or `id_token` stays secret. Rounds 1–4 stay in place, including the end-of-line rule and the per-record time bound.

## Open questions

None.
