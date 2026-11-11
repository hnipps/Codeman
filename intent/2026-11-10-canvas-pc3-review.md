# Intent: PC3 design review corrections

**Status:** Complete

## Problem statement

The read-only canvas gives editing affordances to unavailable tools, confuses focus with selection, and repeats reader content. Its rail, empty state and native interaction states need the reviewed visual treatment.

## Proposed outcome

Apply all ten review items with neutral selection, amber keyboard focus, discoverable unavailable actions, platform key caps, compact reader metadata and deliberately centred empty content. Verify the real desktop and phone document in both themes and save new captures.

## Affected users and systems

Canvas readers using keyboard, pointer or touch; the standalone canvas bundle, scoped styles and browser verification.

## Constraints

Read-only, no storage changes, no deployment. Local ordered commits only. Run typecheck, lint, format check, viewport and canvas browser tests, then deploy/test.sh sequentially; do not run the full CI test suite this round.

## Open questions

None.

## Verification

Typecheck, lint and formatting pass. Viewport tests: 7 passed. Canvas browser tests: 14 passed, including both themes at both requested sizes. Deploy check: 23 files, 336 tests passed. Inspected all 47 newly timestamped screenshots; computed control-state evidence is saved beside them. The full CI suite was not run this round.
