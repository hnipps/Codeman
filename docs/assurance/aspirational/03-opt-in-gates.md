# 03 — Opt-in gates and a proved core

**Status:** Not started

## Scope

Later, and only from an intent file that asks for it: pin one module's draft promises to tests, install the invariant-coverage gate for that module's language, and consider a Dafny or Lean proof for a pure core. Docker images for those provers are built from the Crosscheck plugin when that work starts. `docs/architecture-invariants.md` stays outside that gate unless the same intent names it.

## Deliverables

- `scripts/check_invariant_coverage` for the language of the pinned module. Not created yet.
- `.claude/hooks/protected-surface-guard.mjs`. Not created yet.
- A proved core under a path chosen in the intent that asks for Layer 1. Not created yet.

## Acceptance

- The intent file for the gate names the module, the language, and the CI system.
- Draft modules that are not named in that intent stay editable, with no test pin and no hook.
- Existing `npm test` jobs stay the CI gate for the rest of the repo.
