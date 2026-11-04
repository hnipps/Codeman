# Module invariants

The rules this repository already keeps are in `docs/architecture-invariants.md`, with the short form in `CLAUDE.md` and `src/web/CLAUDE.md`. Many of them have tests under `test/`. Those documents stay the authority. This directory does not copy them.

A file here is for a promise that is still moving and is not already one of those rules. Number such promises in order, starting at 1, with the prefix `I` and the digits of the number. Give each promise its own paragraph: the situation, the guarantee, and why a break would matter.

## Status

`Status: Draft` means the promise is still moving. Change it, renumber it, or delete it in the same change as the code. A draft needs no test comment and no governance note. A draft does not override `docs/architecture-invariants.md`.

`Status: Pinned` means you have decided the promise should hold. Each pinned promise has at least one test whose comment is `// Invariant I<n>: <Name>` (or the comment syntax of the language you are in). Ask for `/invariant-coverage-scaffold` in an intent file before that check becomes a commit or CI gate. Until that intent exists, the gate stays off, including for pinned promises.

## What is here now

`architecture.md` is an index. It records no numbered promises. Add `docs/invariants/<module>.md` when a new module has a promise that the architecture document does not already state, and add a journal entry when you do.
