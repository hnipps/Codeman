# Intent: a routine gate that wakes R-3 only when a review is waiting for it

**Status:** Draft

Owner request, 2026-11-21: "Pr-swarm routine must be guarded by deterministic gate that prevents it starting an agent session when there are no eligible targets."

## Problem statement

R-3 (pr-swarm sweep) fires every 60 minutes and always starts a Claude session. That session lists the waiting reviews, compares each review's branch tip with its ledger (`~/.codeman/swarm-sweep.json`, `done[reviewId] = tip it last handled`), and usually finds nothing to do. Each empty run still costs a session, tokens, a worktree, and one of the canvas's 50 task slots.

The only gate routines have today is `work-count`, which counts Work items. Nothing on a Work item says whether a review's tip has moved since R-3 last looked, so no `work-count` gate can tell an empty hour from a busy one.

## Proposed outcome

A new gate kind, checked by the server before a fire like `work-count`, with no agent involved:

```json
{ "kind": "review-tips", "ledger": "swarm-sweep" }
```

R-3 gets this gate. A fire of R-3 starts a session only when at least one review is **eligible**, and is otherwise recorded as `skipped` with `reason: "gate"`, as gates already are.

### G1: ReviewTipsGateOpensOnlyForEligibleReviews

The gate passes exactly when at least one review owned by the canvas's owner is eligible. A review is eligible when all of these hold:

- (a) it has no decision: not merged, deploying, deployed, deploy-failed or closed. This is R-3's own test (`.review.decision` is null). It is narrower than `isOpen()`, which also counts `deploy-failed`: a merged review whose deploy failed has nothing left for R-3 to review;
- (b) the tip watcher can read it (`refusalOf(reviewId)` is null; a remote or Docker case is refused, and R-3 cannot fetch it either);
- (c) its tip differs from `done[reviewId]` in the ledger (a review the ledger does not name differs). The tip is what the pr-swarm tip watcher read last, else the newest tip a pr-swarm run of that review recorded, else the review's `headSha`. This is the order the watcher itself uses, so the gate never runs git;
- (d) no Work item on the canvas has that review's branch as its `pr.branch` while In progress. R-3 skips those, since a builder holds the branch.

Only the canvas owner's reviews count (`review.owner`, or every review when multi-user mode is off), as on the Reviews page. R-3's prompt gets the same scope, so the gate and the run agree on which reviews exist.

These are R-3's own skip rules (its steps 1 and 2), except the merge-conflict check, which needs git and stays in the prompt (Non-goals).

- *Why:* each rule the gate drops is a wake that finds nothing. Each rule it adds that R-3 does not have would make the gate keep R-3 asleep while there is work.
- *Test:* a routine with this gate and reviews in each state: open and unhandled (passes), open and handled at its tip (fails), handled at an older tip (passes), merged, `deploy-failed` and closed (all fail), one the watcher refuses (fails), held by an In progress item (fails), another owner's review (fails), no reviews (fails). A manual run with "ignore gates" still starts.

### G2: ReviewTipsGateFailsClosed

A gate exists to keep an agent asleep, so doubt keeps it asleep (`gateRefusal()`'s existing rule):

- a `ledger` name that is not `^[a-z0-9][a-z0-9-]{0,39}$` fails schema validation when the routine is saved, and a stored one that fails it says no;
- the ledger is `dataPath(<ledger> + '.json')` and nothing else: no path, no `..`, no symlink followed (`lstat` first). It is read only, never written by the server, and capped at 1 MB;
- a missing ledger reads as "nothing handled yet" (R-3 creates it on its first run);
- a ledger that is a symlink, over the cap, does not parse, or whose `done` is not an object of `reviewId → 40-hex` strings says no;
- reviews or Work items that cannot be read say no.

The fire record of a "no" because of doubt has no `count`. A "no" from a clean read carries `count: 0`, the number of eligible reviews. So the routine's fire list shows which it was. A ledger left broken keeps R-3 asleep until a person repairs it or runs R-3 by hand with gates ignored; R-3's prompt writes the ledger to a temp file and renames it, so a tick never reads half a file.

- *Test:* each of those cases skips with the right shape; the gate never writes the ledger (its mtime and bytes are unchanged).

### G3: OlderReleasesKeepReadingTheRoutine

`review-tips` is a new member of the gate union. A release that does not know it keeps the routine file loading and treats the gate as one that says no. That is today's rule for an unknown gate, so a rollback leaves R-3 asleep, never running unguarded.

## Affected users and systems

- `src/canvas/routines.ts`: `GateSchema` becomes a union of `work-count` and `review-tips`. `gateRefusal()` takes a second input, the eligible-review count, which stays pure.
- `src/web/routine-runner.ts`: computes that count for the canvas's owner only when a due routine has a `review-tips` gate, from the review store, the tip watcher and the Work file it already reads.
- `src/reviews/swarm-watcher.ts`: exposes the tip it last read for a review (a read-only getter on the map it keeps).
- `canvas_routine` MCP description and `canvas_capabilities`: name the new gate.
- R-3: gets `gates: [{ kind: "review-tips", ledger: "swarm-sweep" }]`, and two prompt lines: handle only the routine owner's reviews, and write the ledger with a temp file and rename. Changing gates or prompt switches it off, so the owner re-enables it.
- Docs: the routines rule in `docs/subsystem-rules.md` and `docs/architecture-invariants.md`.

## Constraints

- No git, network or child process on the gate path. The routine tick reads files and memory only.
- The server reads the ledger and never writes it. Its format stays R-3's: `{version: 1, done: {...}, verdicts: {...}}`, and fields the gate does not use are ignored.
- Reviews are the owner's own (`review.owner`, or every review when multi-user mode is off), as everywhere else on the Reviews page.
- Only the live colour fires routines already, so nothing changes there.

## Non-goals

- **Merge conflicts.** A conflicted review still wakes R-3, which skips it, until R-4 (every 30 minutes) resolves the conflict and the tip moves. Telling a conflict without git is not possible, and running git on the tick breaks the constraint above.
- **The watcher's lag.** After R-3 pushes a fix and records the new tip, the gate compares against the watcher's last read. If the watcher has not read the new tip yet, the gate sees the old tip differ from the ledger and wakes R-3 once for nothing. The watcher reads every open review each minute and R-3 fires hourly, so in practice the watcher has caught up.
- **Whether R-3 should still exist.** The built-in pr-swarm triggers (W-112, live since 15:30 today) already review every submit and push. R-3 now overlaps them for review, and differs only in running review-triage and pushing fixes. Retiring or narrowing R-3 is a separate decision.
- A general "command" gate that runs a script. A script on the tick is the cost this gate exists to avoid, and an agent-written command run by the server is a code-execution surface.

## How this was checked

The rules are a predicate on one tick's inputs, with no state of their own beyond the ledger R-3 already keeps, so no model was written. Per the owner's rule for specs with invariants, `crosscheck:audit-invariant-consistency` ran over G1–G3 against R-3's prompt (revision 7), `gateRefusal()`/`planFire()` in `src/canvas/routines.ts` and the tip watcher's tip order. It found four gaps in the first draft, all fixed here:

1. G1 counted `deploy-failed` reviews (`isOpen()`), which R-3 never acts on, so the gate would have woken R-3 every hour for a failed deploy. (a) now matches R-3's "no decision".
2. G1 counted the owner's reviews while R-3 read every review file. R-3's prompt now takes the same scope.
3. R-3 wrote its ledger in place, so a tick could read half a file and a broken ledger would keep R-3 asleep for good. The prompt now writes temp-and-rename, and G2 names how a person recovers.
4. A review the watcher cannot read fell back to its submitted head, older than the tip R-3 records, so it would wake R-3 every hour. Such a review is now not eligible ((b)).

It found no contradiction among G1–G3, and G3 matches `gateRefusal()`'s rule for an unknown gate. This is a search, not a proof: it compares text, not running code.

## Open questions

None.

## Tickets

One build item: the gate, its tests, the docs and the R-3 update.
