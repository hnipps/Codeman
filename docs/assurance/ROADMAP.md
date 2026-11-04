# Assurance roadmap

This directory records assurance work for this repository. Each item has its own file under a horizon directory. That file holds the scope and the status. The status line in the item file is the one to edit. This index repeats it so the two stay in step.

The product already has `docs/architecture-invariants.md`, `CLAUDE.md`, and `npm test`. This roadmap adds a place to record why a change is made. It does not replace those rules and it does not block a product change.

## Horizon index

### Immediate

| # | Item | Status | Doc |
|---|---|---|---|
| 01 | Per-change intent files, with Crosscheck skills available and new gates off | In progress | `immediate/01-per-change-intent.md` |

### Next

| # | Item | Status | Doc |
|---|---|---|---|
| 02 | First draft invariant for a new module that is not already in the architecture doc | Not started | `next/02-first-draft-invariant.md` |

### Medium-term

No items. Add one when a module has callers and a promise you expect to keep for a while.

### Aspirational

| # | Item | Status | Doc |
|---|---|---|---|
| 03 | Opt-in coverage gate and a proved core, only if a later intent asks | Not started | `aspirational/03-opt-in-gates.md` |

## Kill criteria

Stop and rewrite this roadmap if any of these become true:

- A draft under `docs/invariants/` is used as a reason to refuse a product change that was asked for, or as a reason to weaken `docs/architecture-invariants.md`.
- A hook, a failing CI job, or a protected-surface block is installed without an intent file that asks for that gate.
- `/intent-check` has at least three human verdicts in its rolling window and the false-positive rate is at or above 30%. Until that sample exists, this criterion is idle.

## Status values

`Not started`, `In progress`, `Blocked`, `Done`, `Deferred`. A deferred item has a `Reason` line. A blocked item has a `Blocker` line. Items are kept. `Deferred` is how an item is retired.
