# Intent: Shared desktop canvas compound commands

**Status:** Draft

## Problem statement

Desktop users cannot group, arrange, lock, transform or copy a selection. Browser history currently computes inverses independently of the server.

## Proposed outcome

All compound edits use the existing typed command endpoint with durable request identities, one request in flight, acknowledgement recovery and refusal rollback. Compact desktop controls expose grouping, fixed-container wrapping, transforms, locking, clipboard and arrangement. Pointer snapping remains ephemeral. Server history protects later work.

## Affected users and systems

Desktop canvas users, browser edit queue, command endpoint, browser and route tests.

## Constraints

Preserve existing operation kinds and additive disk compatibility. No push, deployment, modal, inspector, toast or full test run. Keep phone read-only and native text/IME shortcuts. No new hook or CI gate. Run checks serially after other test/build processes clear.

## Open questions

The command endpoint has no compound retry identity. Add an optional request ID and deterministic native op IDs, recoverable from the existing operation log; no new stored record type. Grouping accepts an optional frame/section container type for wrapping, and reparent accepts world translation for placed drops. Copies stage new locks after creating their complete hierarchy so locked source groups remain copyable without unlocking them.
