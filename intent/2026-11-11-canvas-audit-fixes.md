# Intent: Repair canvas history and cyclic reads

**Status:** Implemented; maximum-batch performance target unmet

## Problem statement

Undo can delete later descendants, compound history exceeds caller batch limits,
and loaded cycles prevent workspace discovery. Arrange advertises an ignored snap field.

## Proposed outcome

Refuse history that would delete later dependents, atomically. Separate caller
operation limits from bounded server expansion and retain existing disk kinds.
Read cyclic records flat with diagnostics while serving healthy geometry normally.
Reject snap input and describe browser pointer snapping accurately. Use a
batch-local child index to avoid repeated whole-state scans for maximum ungroup.

## Affected users and systems

Human and agent canvas callers, command routes, pure model queries and storage.

## Constraints

Previous-release replay compatibility; no new operation kind. Serialized targeted
checks and deployment gate only; no full test suite, deployment or push.

## Open questions

Maximum-target forward/undo/redo is measured and functionally passes. Literal
whole-append p95 remains above PC1's 5 ms rule, including with compiled backend
code; see the coordination report for measurements and limits.
