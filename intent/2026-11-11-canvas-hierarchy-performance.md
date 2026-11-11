# Intent: Keep canvas hierarchy validation bounded and fast

**Status:** Implemented

## Problem statement

Deleting or restoring a valid nested group chain repeatedly parses the same objects and walks the same ancestors, stalling the synchronous request path.

## Proposed outcome

Classify known and opaque records when private store state is loaded or changed. Keep that classification in memory beside state. Validate affected descendants in one traversal with constant-time classification and inherited hierarchy facts. Cover depth-200 and 5,000-object trees with timing and behavior regressions, and repeat the 10,000-object append/load probe.

## Affected users and systems

Canvas command callers, operation replay, and snapshot loading.

## Constraints

Preserve opaque records, atomic rejection, locks, deletion provenance, cycles and hierarchy bounds. Change no disk schema. Append commits to the existing branch. Run only the three canvas suites plus typecheck, lint, formatting and deploy script tests; the task explicitly forbids the full suite.

## Open questions

None.

## Validation

The new wide-tree regression failed before the fix (27,885.9 ms for delete).
Depth-200 and 5,000-object delete, restore, move, reparent and lock validations now
pass the 250 ms bound, including classification of unindexed fixture inputs.
The three canvas files pass 52 tests. A 10,000-object append/reload smoke probe
verified every append and loaded object: p95 append 0.341 ms, load 458.503 ms.
Typecheck, lint and format checks passed; the deploy gate is recorded in the
worker report after completion. No disk format changed.
