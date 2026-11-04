# intent/

An intent file is the first written record of a change in this repository. It states the problem, the outcome, who it touches, the constraints, and the open questions. It does not propose a design.

This directory is the development record. It is not Read My Mind. Read My Mind stores a per-case profile of recent prompts in `src/intent-store.ts` and `~/.codeman/intents.json`. See `docs/readmymind.md`.

## Naming

`intent/<yyyy-mm-dd>-<slug>.md`

The date is the day the file was created. The slug is a short hyphenated name, as in `intent/2026-11-04-light-assurance.md`.

## How to use one

Copy `intent/TEMPLATE.md`. Fill the five sections in language a newcomer can check without reading the diff.

Revise the file in place while the change is still in flight. When the outcome itself moves, edit this file and say so in `docs/JOURNAL.md`. A later change gets its own file.

A small change stops here. A change that alters what a caller can rely on also gets a plan. This repo already keeps those as `docs/<slug>-plan.md`. Use that path. Put a dated snapshot that should stay as written under `docs/specs/<yyyy-mm-dd>-<slug>.md`.

## Where this sits

`docs/assurance/README.md` is the working policy: which existing documents stay in force, which Crosscheck skills you can run, and which gates stay off.
