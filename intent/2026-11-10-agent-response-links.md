# Intent: Open inline and wrapped agent links

**Status:** Implemented

## Problem statement

Copilot responses display inline links to local reports that do nothing when clicked. Long paths split over bordered TUI rows open fragments as folders.

## Proposed outcome

Inline local links open the file preview for their own session. Every visible fragment of a wrapped path opens the complete target without including TUI borders.

## Affected users and systems

People reading agent output in primary, split, and tile terminals. Terminal link handlers and path reconstruction.

## Constraints

Preserve web link confirmation and safe scheme handling. Preserve cell coordinates and session ownership. Keep reconstruction bounded and avoid joining unrelated rows.

## Open questions

None.

## Work plan

1. Reproduce it yourself on the matching surface via the control skill.
2. Binary-search the cause.
3. Plan the fix.
4. Verify on the same surface.
5. Stage the commits so the failing repro lands before the fix in git history.
6. Run Opening a PR.

Throughput checkpoint. The transcript and existing browser tools are available. Keep the change in terminal link handling and reuse existing preview routes.

## Decisions and verification

Keep the existing physical path segments and guarded preview routes. Native OSC 8 links resolve their session when activated. Touch uses xterm's native provider before text detection.

Real Chromium clicks failed before the fix. Inline local links opened nothing. Wrapped path fragments opened a truncated folder or an unrelated relative file. Seven browser regressions now pass, including native touch lookup, both gutter forms, and a two-row full-width wrap. The focused terminal suite passes 267 tests. Review found and corrected a false join between independent bordered rows.

Two short bordered rows alone cannot establish an arbitrary-character wrap. Reconstruction requires a filled terminal edge or a repeated intermediate wrap column. This preserves unrelated directory and file listings.
