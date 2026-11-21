# Repository Guidelines

Canonical agent/contributor guidance for this repository lives in [CLAUDE.md](CLAUDE.md) —
project structure, build/test/lint commands, code style, testing safety rules
(`npm test` is the CI gate and is safe to run bare; the three excluded suites
have their own runners), security notes, and
the deployment workflow are all maintained there. Please read it before making
changes, and keep it the single source of truth rather than duplicating
sections here.

Quick pointers:

- Type check: `tsc --noEmit` · Lint: `npm run lint` · Format: `npm run format:check`
- Tests: `npm test` (the CI gate, safe to run bare) or `npm test -- test/<file>.test.ts` for one file
- Route tests use `app.inject()`; new tests needing a socket bind port 0 (`new WebServer(0, …)` + `boundPort`); mobile tests use `createTestServer()` and read `server.boundPort`
- Branch off `master` for all work; Conventional Commit-style messages (`fix(mobile): ...`)
- Never commit secrets or local state from `~/.codeman/`

## Assurance

Follow these on every change. The same rules are in `CLAUDE.md` (## Assurance) and `.github/copilot-instructions.md`. Grok and Claude Code load `CLAUDE.md`. Codex, Antigravity, and Grok load this file. Copilot loads the instructions file.

- Start a non-trivial change with `intent/<yyyy-mm-dd>-<slug>.md`, copied from `intent/TEMPLATE.md`. Revise that file in place while the work is still moving.
- That directory is not Read My Mind. Read My Mind is `src/intent-store.ts`, `~/.codeman/intents.json`, and `docs/readmymind.md`.
- Rules that already hold live in `CLAUDE.md`, `docs/subsystem-rules.md` and `docs/architecture-invariants.md`. Update them in the same change as the code they describe.
- A promise that is still moving can be a `Status: Draft` note under `docs/invariants/`. A draft does not override an architecture invariant and does not block a commit.
- Do not add a commit hook, a failing CI job, or a protected-surface block unless an intent file asks for that gate.
- UI and UX design work uses the `impeccable` skill: a new or changed screen, layout, component, visual style, motion, or interface copy, and any design critique or audit. Use it to shape the design before building and to check the result after.
- A non-trivial code change runs under poteto-mode. It is user-invocation only, so an agent that was not started with `/poteto-mode` reads `~/.claude/skills/poteto-mode/SKILL.md` in full and follows it. Where it would pause for the person, ask once and stop, or report the question on the canvas Work item. Non-trivial means anything past a one-line or mechanical edit, or any change in behaviour.
- Before a non-trivial change goes up for review (a pull request, or a submission to Codeman's Reviews page with `codeman agent review submit`), at least one independent agent verifies it. That agent did not write the change, gets the goal and the diff rather than the author's conclusion, and runs the checks itself. Put its verdict in the PR body or the walkthrough, then fix what it found or say why not.
- Implementers and reviewers both consider the Crosscheck skills from the Nicholls plugin, and reach for them when a change is complex or carries many invariants, such as a state machine, concurrency, a security rule, or a file format. Say in the PR body which ones ran, or why none did. A layer 5 or layer 6 result is a search, and it is not proof. The menu is `docs/assurance/README.md`.
- A spec that defines or changes a state machine, a lifecycle, or which items a write may touch is checked before it goes up for review. Extend the spec's model, or write one (a Dafny file under `intent/`, as `intent/2026-11-18-w70-lifecycle.dfy` and `intent/2026-11-21-w70-i8-model.dfy` do), that proves the rules against every write path, and put a mutation through it to show the proof is not vacuous. Any other spec with invariants gets at least `crosscheck:audit-invariant-consistency` on its own text. Record what was proved, and what was not, under "How this was checked" in the spec. A model finds the design gaps a code review otherwise finds only after the build.
- Routines and the agents they start follow these rules too.
- A Claude agent may hand work to codex, antigravity (`agy`) or gemini agents to spread the cost across providers, through `codeman agent spawn --mode <mode>` or the MCP `start_session` tool. The rules above still apply to that work, and the Claude agent reviews what comes back.
- Read `docs/JOURNAL.md` before a non-trivial change, and add an entry there when the change records a decision.
