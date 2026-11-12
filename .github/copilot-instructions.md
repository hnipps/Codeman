# Codeman assurance rules

Apply these on every change in this repository. The same rules are in AGENTS.md and in the Assurance section of CLAUDE.md.

## Intent

- Start a non-trivial change with intent/<yyyy-mm-dd>-<slug>.md, copied from intent/TEMPLATE.md. Revise that file in place while the work is still moving.
- That directory is not Read My Mind. Read My Mind is src/intent-store.ts, ~/.codeman/intents.json, and docs/readmymind.md. Do not write a development intent into intents.json.

## Invariants

- Rules that already hold live in CLAUDE.md, docs/subsystem-rules.md and docs/architecture-invariants.md. Update them in the same change as the code they describe.
- A promise that is still moving can be a Status: Draft note under docs/invariants/. A draft does not override an architecture invariant and does not block a commit.
- Do not add a commit hook, a failing CI job, or a protected-surface block unless an intent file asks for that gate.

## Checks

- Crosscheck skills from the Nicholls plugin can be run by name. A layer 5 or layer 6 result is a search, and it is not proof. The menu is docs/assurance/README.md.
- Read docs/JOURNAL.md before a non-trivial change, and add an entry there when the change records a decision.
- npm test is the CI gate. Do not weaken an existing test to make a change pass.
