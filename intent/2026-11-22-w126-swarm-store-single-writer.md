# Intent: only changeSwarm writes a swarm file, and a bad change answers invalid (W-126)

**Status:** Draft

## Problem statement

The header of `src/reviews/swarm-store.ts` promises that a swarm file that does not parse, or that a newer release wrote, is never overwritten. Only `changeSwarm()` keeps that promise, because it reads first. The exported `writeSwarm()` writes without reading. A change whose result fails `SwarmFileSchema` throws a `ZodError` out of `changeSwarm()`, although its return type offers an `ok: false` answer. The pr-swarm sweep of PR #96 found both.

## Proposed outcome

`changeSwarm()` is the only way to write a swarm file. A change whose file fails the schema, or names another review, writes nothing and answers `{ ok: false, reason: 'invalid' }`. A write outside the live colour still throws `DeployRoleRefusal`. The header says that read-apply-write is safe only in one synchronous tick, in one process, under the live-colour lease.

## Affected users and systems

The pr-swarm runner (`apply()` in `swarm-runner.ts`), which already reports any `ok: false` reason as a message. Tests that seeded swarm files with `writeSwarm()`.

## Constraints

No change to the swarm file format or to `SwarmRead`. `writeReview` in `review-store.ts` has the same shape but three real callers and stays as it is.

## Open questions

None.
