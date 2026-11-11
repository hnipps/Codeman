# Intent: Broaden log redaction after the second audit

**Status:** Draft

## Problem statement

A second audit of the redacted log query showed the narrower key rule letting credential names through, masked values stopping at a prefix, a bearer token with a minimum length, a hook-secret read that could take a whole file, and a tail window that dropped a complete row when it started on a newline.

## Proposed outcome

The redactor masks any key that contains a credential word, of any length, except a short exact allowlist of attribution keys. A masked value runs to its closing quote, matching bracket, or next delimiter, and to the end of the line when that end is not found. Bearer tokens have no minimum length. The hook secret is read with a capped read and is not read again once it is known. A query window that starts on a row boundary keeps that row. A secret printed with no key and no known shape is still not detected, and the docs say so.

## Affected users and systems

Operators and agents reading `GET /api/logs` or `logs_query`. The telemetry writer, the query reader, and the hook-secret file. Config backup's own key rule is unchanged.

## Constraints

When in doubt, mask. Over-masking an ordinary value is acceptable. The attribution allowlist is the exception. The scanners stay linear and must not throw. A miss on the hook secret is not cached. No full-suite run in this round. Do not change the plan checkboxes.

## Open questions

None.
