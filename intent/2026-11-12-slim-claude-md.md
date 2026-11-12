# Intent: keep the always-loaded CLAUDE.md small

**Status:** Draft

## Problem statement

The root `CLAUDE.md` had grown to about 157 KB. Claude Code loads it whole into every session and every subagent, so each one paid for roughly 35,000 tokens of rules before doing any work, and most of those rules concern subsystems the session never touches. Agents that hit a usage limit and resumed paid it again.

## Proposed outcome

`CLAUDE.md` is about 20 KB. It keeps what applies to every change: the self-deploy rule, assurance, commands, session safety, test-before-deploy, the release pointer and version line, a short list of universal rules, testing essentials, and an index of subsystem titles. Every per-subsystem paragraph, the long command and CI notes, the security table, state files, the canvas sections and the long testing notes moved verbatim to `docs/subsystem-rules.md`, which an agent opens at one paragraph when it is about to change that subsystem. No rule was deleted or reworded in the move.

## Affected users and systems

Every agent session in this repository (Claude Code, and Codex, Grok and Copilot through `AGENTS.md` and `.github/copilot-instructions.md`, which point at `CLAUDE.md`). `test/docker-entrypoint.test.ts` now reads the `cap_add` quotation from the new file. `.prettierignore` lists the new file. `docs/releasing.md` still finds the `**Version**` line in `CLAUDE.md`.

## Constraints

- No rule is lost: the move is mechanical, done by a script from the committed file, and relative links are rewritten for the new location.
- The session-safety, deploy and assurance sections stay in `CLAUDE.md` word for word.
- A subsystem rule is now discoverable only through the index, so the index must list every moved title and new rules must add theirs.
- A rule in `docs/subsystem-rules.md` binds exactly as it did in `CLAUDE.md`; the file's header says so.

## Open questions

- `src/web/CLAUDE.md` (about 69 KB, loaded when a file under `src/web/` is read) could be split the same way. Not done here.
- A session started from a checkout that predates this change still loads the old file until that checkout moves forward.
