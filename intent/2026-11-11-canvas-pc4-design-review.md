# Intent: PC4 design review corrections

**Status:** Complete

## Problem statement

Selection chrome overlaps text, multi-selection repeats handles, and editing controls drift from the canvas visual system.

## Proposed outcome

Selection boundaries sit six screen pixels outside geometry at every zoom; one selected sized object has eight handles and multi-selection has a combined boundary without handles. Focus stays separate. History lives in the dock, selection actions align above it, reader fields and conflicts are clear, and Add supports keyboard navigation.

## Affected users and systems

Desktop canvas users; canvas renderer, reader, dock and browser evidence.

## Constraints

Keep stored geometry, exact resize deltas, native text undo, phone read-only behavior and existing tokens. No push or deployment. Run checks sequentially after other test processes clear. Capture twelve states in both themes at 1440px and inspect each.

## Open questions

None. Combined resize remains deferred to part 2.
