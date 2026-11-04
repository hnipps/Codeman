# Protected surfaces

A path is protected only when it appears in the list at the bottom of this file. The list is empty.

`docs/architecture-invariants.md`, `CLAUDE.md`, and `src/web/CLAUDE.md` stay editable in the same change as the code they describe. They are not on this list. A draft under `docs/invariants/` is editable the same way.

Two labels are reserved for when a later intent adds a path:

- Class A is harness and workflow material: agent rules, hooks, and CI workflows. A silent edit there changes how later checks behave.
- Class B is a pinned module promise and the tests that cover it.

## When a path is on the list

The change that adds the path, and later changes to files the path matches, carry a short note in the intent file for that change:

- what is changing
- why
- which behaviour downstream is affected

Ask for `/protected-surface-amend` when you want that note in the plugin's usual block. The note is for the reader. No hook enforces it while this list is empty.

## Machine-readable path list

No path is protected while this block has no globs. Add one glob per line, and only from an intent that asks for the gate.

```text
```
