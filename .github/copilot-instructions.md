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

- UI and UX design work uses the impeccable skill: a new or changed screen, layout, component, visual style, motion, or interface copy, and any design critique or audit. Use it to shape the design before building and to check the result after.
- A non-trivial code change runs under poteto-mode. It is user-invocation only, so an agent that was not started with /poteto-mode reads ~/.claude/skills/poteto-mode/SKILL.md in full and follows it. Where it would pause for the person, ask once and stop, or report the question on the canvas Work item. Non-trivial means anything past a one-line or mechanical edit, or any change in behaviour.
- Before a non-trivial change goes up for review (a pull request, or a submission to Codeman's Reviews page with codeman agent review submit), at least one independent agent verifies it. That agent did not write the change, gets the goal and the diff rather than the author's conclusion, and runs the checks itself. Put its verdict in the PR body or the walkthrough, then fix what it found or say why not.
- Implementers and reviewers both consider the Crosscheck skills from the Nicholls plugin, and reach for them when a change is complex or carries many invariants, such as a state machine, concurrency, a security rule, or a file format. Say in the PR body which ones ran, or why none did. A layer 5 or layer 6 result is a search, and it is not proof. The menu is docs/assurance/README.md.
- Routines and the agents they start follow these rules too.
- A Claude agent may hand work to codex, antigravity (agy) or gemini agents to spread the cost across providers, through codeman agent spawn --mode <mode> or the MCP start_session tool. The rules above still apply to that work, and the Claude agent reviews what comes back.
- Read docs/JOURNAL.md before a non-trivial change, and add an entry there when the change records a decision.
- npm test is the CI gate. Do not weaken an existing test to make a change pass.
