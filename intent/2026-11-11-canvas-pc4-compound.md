# Intent: Shared desktop canvas compound commands

**Status:** Implemented

## Problem statement

Desktop users cannot group, arrange, lock, transform or copy a selection. Browser history currently computes inverses independently of the server.

## Proposed outcome

All compound edits use the existing typed command endpoint with durable request identities, one request in flight, acknowledgement recovery and refusal rollback. Compact desktop controls expose grouping, fixed-container wrapping, transforms, locking, clipboard and arrangement. Pointer snapping remains ephemeral. Server history protects later work.

## Affected users and systems

Desktop canvas users, browser edit queue, command endpoint, browser and route tests.

## Constraints

Preserve existing operation kinds and additive disk compatibility. No push, deployment, modal, inspector, toast or full test run. Keep phone read-only and native text/IME shortcuts. No new hook or CI gate. Run checks serially after other test/build processes clear.

## Open questions

None. Optional request identities use deterministic native operation IDs recovered from the existing log. Grouping accepts a frame/section type for wrapping, and reparent accepts world translation for placed drops. Copies stage their new locks after creating the complete hierarchy, preserving locked sources without unlocking them.
