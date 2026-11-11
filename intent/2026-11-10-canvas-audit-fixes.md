# Intent: Resolve PC1 storage audit findings

**Status:** Implemented

## Problem statement

Workspace creation uses an unbounded case probe, two assertions miss regressions,
and strict stored schemas prevent code-only rollback after future data additions.
Sub-canvases cannot contain blocks and delete inversion does not log restore.

## Proposed outcome

Bound case probes distinguish unknown from absent. Strict requests coexist with
lossless stored object/content/operation extensions and opaque future object types.
Sub-canvases use explicit container bounds; delete undo emits restore.
Tests verify each behavior and documentation records the compatibility contract.

## Affected users and systems

Canvas workspace routes, persistence, replay, hierarchy and history callers.

## Constraints

Keep existing commits intact; commit locally on the assigned branch. No full test
suite this round. Run typecheck, lint, formatting, three canvas suites and deploy gate.
Unknown operation kinds remain unapplied while their raw records remain available.

## Open questions

None.
