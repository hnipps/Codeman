# Intent: Light assurance for Codeman

**Status:** Draft

## Problem statement

A change in this repository can land with code, a plan under `docs/`, and an update to `docs/architecture-invariants.md`, and still have no short record of why the change was wanted. Crosscheck can supply that record, and its default onboarding also installs a protected-surface hook, failing CI stubs, and an amendment step before an invariant file can change. Those blocks would sit on top of a product that is still moving, and on top of rules the repo already enforces with tests.

## Proposed outcome

A non-trivial change starts as an intent file in `intent/`. The rules that already hold stay in `CLAUDE.md` and `docs/architecture-invariants.md`, edited in the same change as the code. A promise that is still moving can be a draft under `docs/invariants/` and can change with the code. Every Crosscheck skill can be run by asking for it. A commit is not blocked by a new assurance hook or a failing assurance job.

## Affected users and systems

People and agents working in `hnipps/Codeman`. The Crosscheck plugin skills already installed on this machine. Read My Mind (`src/intent-store.ts`) stays a separate product feature.

## Constraints

- `docs/architecture-invariants.md` and the short rules in `CLAUDE.md` stay in force. A draft under `docs/invariants/` does not weaken them.
- A draft may be rewritten or removed in the same change as the code it describes.
- A hook, a failing CI job, or a protected-surface block waits for an intent file that asks for that gate.
- Results from `/intent-check` and `/spec-adversary` are searches. They are not proof.
- Dafny and Lean need Docker images built from the Crosscheck plugin before they can prove anything. Those images are not required for other work.
- Keep this distinct from Read My Mind. Do not write development intent into `~/.codeman/intents.json`.

## Open questions

- Which new module, once its behaviour settles, is the first one worth pinning to a Crosscheck-style test comment.
- Whether any existing section of `docs/architecture-invariants.md` should later be named with a stable id. Until an intent asks for that, the prose and the tests that already cover it stay as they are.
