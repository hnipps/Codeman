# 02 — First draft invariant for a new module

**Status:** Not started

## Scope

When a new module has a promise that is not already written in `docs/architecture-invariants.md`, add `docs/invariants/<module>.md` with `Status: Draft`. Keep the promise editable. Do not pin tests and do not install the coverage gate in this item. Do not copy the architecture document into numbered ids here.

## Deliverables

- `docs/invariants/<module>.md` for that new module. The filename is chosen when the module exists. That file is not in the tree today.

## Acceptance

- The module doc states each promise in a paragraph and marks `Status: Draft`.
- `docs/architecture-invariants.md` still holds the rules that already exist.
- No test comment and no coverage script are required for this item to be done.
