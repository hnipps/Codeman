# Assurance in this repo

This repo keeps Crosscheck's per-change intent files and its assurance skills, and it leaves new blocking gates off. The plugin that provides the skills is Crosscheck 2.9.0 from Nicholls. The reason for a change lives in `intent/`. The rules the product already keeps live in `CLAUDE.md` and `docs/architecture-invariants.md`.

Two different things are called intent:

| Name | What it is |
|---|---|
| `intent/<yyyy-mm-dd>-<slug>.md` | Why a code change is being made. Development record. |
| Read My Mind | A per-case profile of recent prompts. `src/intent-store.ts`, `~/.codeman/intents.json`, `docs/readmymind.md`. |

## What you write

| When | Where |
|---|---|
| You decide to make a change | `intent/<yyyy-mm-dd>-<slug>.md` |
| Callers will rely on a new behaviour | a plan at `docs/<slug>-plan.md`, which is the existing shape in this repo |
| You want a design kept as it was on a date | `docs/specs/<yyyy-mm-dd>-<slug>.md` with `Status: Snapshot` |
| A promise is still moving and is not already an architecture invariant | `docs/invariants/<module>.md` with `Status: Draft` |
| A rule already holds | `docs/architecture-invariants.md`, and the short form in `CLAUDE.md` or `src/web/CLAUDE.md` |
| A non-trivial decision needs a reason a later reader can find | `docs/JOURNAL.md`, newest entry first |

Revise an in-flight intent in place. A spec snapshot stays as it was committed. A design change is a new snapshot plus a journal entry. A draft under `docs/invariants/` moves with the code. See `docs/invariants/README.md`.

## Skills you can run

Ask for the skill by name. None of these run on commit, and none of them are wired into this repo's CI.

| Layer | Question | Skills | What you get |
|---|---|---|---|
| 1 | Does this pure core match a formal spec? | `/spec-iterate`, `/generate-verified`, `/extract-code`, `/suggest-specs`, `/lightweight-verify`. Lean path: `/informal-spec`, `/lean-spec`, `/lean-impl`, `/correspondence-review`, `/drt-oracle` | A proof, after the plugin's Docker images are built. Typical reach is a pure core. |
| 2 | Is the compiler correct? | none | The Dafny backend is trusted. No skill closes this. |
| 3 | Do components compose? | CGV, in the Crosscheck repo, for Python data paths | A partial check. It is not wired into this repo. |
| 4 | Does the code match its invariants? | `/draft-invariants`, `/invariant-coverage-scaffold`, `/assurance-probe`, `/check-regressions`, `/rationale`, `/lightweight-verify` | Prose, tests, and (only after an intent asks) a gate that checks a test comment names an invariant. The gate does not check that the test exercises the promise. |
| 5 | Does the written promise match what you meant? | `/intent-check`, `/audit-invariant-consistency`, `/acceptance-oracle-draft` | A search. Advisory. `/intent-check` does not write the intent file. |
| 6 | Is the promise complete? | `/spec-adversary`, `/audit-spec-coverage` | A search. Advisory. |
| Beside the ladder | What does this code do, and where did it break? | `/reason`, `/compare-patches`, `/locate-fault`, `/trace-execution` | An evidence-backed reading of the implementation. |
| Orientation | What is already true in the repo? | `/assurance-layer-audit`, `/assurance-status`, `/assurance-roadmap-check`, `/journal-context` | A report. |

`/assurance-status` looks for `docs/assurance/ROADMAP.md`, the four horizon directories, one file under `docs/invariants/` besides the README, and `.claude/rules/protected-surfaces.md`. Those files exist so the report can run. The coverage script is absent on purpose, and the status report will warn about that. This repo's own CI (`npm test`) is unchanged.

Layer 1 stays idle until you build the images from the plugin: `scripts/build-docker.sh` and `scripts/build-lean-docker.sh`.

## Gates that stay off

These stay uninstalled until an intent file asks for them:

- a protected-surface hook that blocks an edit
- a pre-commit check that fails the commit for a missing invariant comment
- a CI job that fails the build for a missing invariant comment
- an attestation step, a phase ceremony, or an IC/S/F/B identifier scheme

`.claude/rules/protected-surfaces.md` exists so the status tool can read it. Its path list is empty. `docs/architecture-invariants.md` is not on that list. You edit it in the same change as the code, which is already the practice. A file becomes protected when an intent adds its glob to that list.

## Journal entries

Add the entry at the top of `docs/JOURNAL.md`.

```
## YYYY-MM-DD — <title>

**Type:** propagated-discovery | intent-refinement | drift | retraction | status-transition
**Touches:** <paths>
**Why:** <one line>
**Links:** <intent, plan, or invariant>

One paragraph a reader can use six months later.
```

## Roadmap

`docs/assurance/ROADMAP.md` indexes the assurance work. Each item's own file holds its `Status`. The values are `Not started`, `In progress`, `Blocked`, `Done`, and `Deferred`. `Deferred` carries a `Reason` line. `Blocked` carries a `Blocker` line.
