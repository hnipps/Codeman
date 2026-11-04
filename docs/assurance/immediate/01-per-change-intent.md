# 01 — Per-change intent

**Status:** In progress

## Scope

Give this repo a place to record why a change is being made, keep the existing architecture invariants in force, and write down which Crosscheck skills can be run on demand. Leave new commit hooks and failing assurance jobs uninstalled.

## Deliverables

- `intent/README.md`
- `intent/TEMPLATE.md`
- `intent/2026-11-04-light-assurance.md`
- `docs/assurance/README.md`
- `docs/invariants/README.md`
- `docs/invariants/architecture.md`
- `.claude/rules/protected-surfaces.md`
- `docs/JOURNAL.md`
- the Assurance section in `CLAUDE.md`

## Acceptance

- A non-trivial change has an intent template and a directory to put the file in.
- `docs/invariants/architecture.md` contains no numbered promises.
- `.claude/rules/protected-surfaces.md` lists no protected glob.
- `docs/architecture-invariants.md` is unchanged by this item.
- No new workflow file fails a commit for a missing invariant comment.
