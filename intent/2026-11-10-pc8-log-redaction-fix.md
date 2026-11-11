# Intent: Close the redacted-log leaks from the first audit

**Status:** Draft

## Problem statement

A log line can still keep a secret, and a query can miss the newest row. A URL that puts the credential in the username, a bearer scheme in any other capitalization, and a secret-shaped key as Node's console printer writes it all reach disk. A hook secret created just after startup is invisible for 30 seconds. A query that starts at the top of a long file drops the newest lines. Attribution keys such as `author` are masked because they contain the letters `auth`.

## Proposed outcome

Those shapes are masked before the line is queued and again when it is read. The hook secret is visible to the next line as soon as it exists. A query reads from the tail, so a match past the byte cap is returned. Attribution keys keep their values. Config backup keeps its own key rule.

## Affected users and systems

Agents reading `GET /api/logs` or `logs_query`, and anyone inspecting the telemetry files. Config backup is unchanged.

## Constraints

Redaction stays one pure function, linear-time, and unable to throw. It must not take a caller-supplied pattern. There is still no way to read an unredacted line. A new file must stay ignorable by the previous release.

## Open questions

None.
