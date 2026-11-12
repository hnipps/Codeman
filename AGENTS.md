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
- Crosscheck skills from the Nicholls plugin can be run by name. A layer 5 or layer 6 result is a search, and it is not proof. The menu is `docs/assurance/README.md`.
- Read `docs/JOURNAL.md` before a non-trivial change, and add an entry there when the change records a decision.
