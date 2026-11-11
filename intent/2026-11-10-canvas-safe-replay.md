# Intent: Safe canvas walks and forward replay

**Status:** Implemented

## Problem statement

Loaded future data can create cyclic hierarchies, lose unapplied operations behind a snapshot, or crash author revert on unfamiliar content.

## Proposed outcome

All hierarchy walks share cycle, depth and node limits. Cyclic records stay readable and read-only with one load diagnostic. Unknown or mismatched content stays opaque. Checkpoints never seal unapplied operations, including lifecycle flushes.

## Affected users and systems

Canvas storage, geometry, commands, author revert and HTTP reads.

## Constraints

Preserve disk data and strict request schemas. Work alone; no deploy or full test suite. Run the three canvas suites, typecheck, lint, format check and deploy test script. Commit only this work.

## Open questions

None. Use a maximum depth of 256 objects and 10,000 visited nodes per walk. Skip new snapshots while unknown operations exist; retain the prior checkpoint and complete log.
