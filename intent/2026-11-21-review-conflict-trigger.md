# Intent: R-4 wakes only for a real conflict

**Status:** Draft

Owner request, 2026-11-21: "check routine r-4 for wastage too. Ideally would be triggered on conflicts and/or needs a deterministic gate."

## Problem statement

R-4 (Resolve review conflicts) runs on a 30-minute interval with no gate. Each run starts a full agent session. That session fetches, runs `git merge-tree` on every waiting review and, almost always, finds nothing to do.

Its record since it was switched on (2026-11-21), 7 fires:

- 1 refused (`AGENT_CAP`): both of the canvas's agent slots were busy. R-4 competes for those two slots with R-1, R-2 and the pr-swarm runs.
- 1 run resolved conflicts on two reviews, and `docs/JOURNAL.md` was the only file that conflicted in both. W-129 (merged as 89201ccd) now merges that file with a union driver, so this class of conflict no longer needs an agent.
- 5 runs found nothing. Their final reports each say "merges cleanly, skipped" for every review.

So 5 of the 6 sessions it started did nothing. Each still held an agent slot while it ran, plus a task-list entry.

There are two more costs. A conflict that appears just after a run waits up to 30 minutes. And the decision to wake an agent at all is something the server can compute in milliseconds without one.

## Outcomes

1. R-4 starts only when a waiting review actually conflicts with its base and the run could act on it. A pass that finds no conflicts starts nothing and spends no tokens.
2. A conflict is noticed within about a minute, not up to 30.
3. Each conflict is offered to R-4 once. A run that escalates is not retried on the same pair of tips.

## Design

A new routine trigger, `review-conflict`, replaces R-4's interval trigger. The server computes the condition. The agent never wakes to compute it.

### The data

The swarm watcher's pass already visits every open review once a minute, with a deadline on each read (`src/reviews/swarm-watcher.ts`). For each review it can read, the pass adds one more read:

```
ConflictView = { reviewId, branchTip, baseTip, base, files: string[] }
```

This record is produced only when `git merge-tree --write-tree --name-only <baseTip> <branchTip>` exits 1. `base` is the review's base branch, or `master` when that branch is gone (a stacked base that has already merged). Exit 0 means no conflict. Any other result counts as unknown and produces no record. The watcher keeps the current `ConflictView` list in memory and reads nothing from disk.

The **conflict key** is `(reviewId, branchTip, baseTip)`. A new tip on either side makes a new key.

### The trigger

`{ kind: 'review-conflict' }` is a third trigger family, beside schedules and `work-item`. `planFire` gains a step after work items, as follows.

- **C1 OnlyRealConflictsFire.** A review-conflict fire names one `ConflictView` that the latest watcher pass produced, and passes the review id, both tips and the conflicted files into the run's task. No conflict view means no fire.
- **C2 EachConflictFiresOnce.** The fire's `runId` is `nameUuid(routineId:reviewId:branchTip:baseTip)`. A key already fired (started, or refused by the task route and then started later) never fires again. A `refused` fire leaves the key due, as a refused work-item fire does. The prompt's `failed` ledger becomes unnecessary and is dropped.
- **C3 HeldAndFreshConflictsWait.** A key is not due while the review's Work item is In progress, the same "held" read as pr-swarm runs revision 4's T4, or while the branch tip is less than 15 minutes old. These conditions move out of the prompt and into the server. A held key fires on the first tick after it stops being held, if it still conflicts then.
- **C4 OneRunAtATime.** While a run of this routine is active, no review-conflict fire starts, and the key stays due. A run handles exactly one review, so the prompt's "at most 3 per run" loop goes away.
- **C5 GatesStillApply.** The routine's gates are checked as they are for a work-item fire. A refusal is recorded once per key and gate count, and the key stays due.
- **C6 DoubtStaysAsleep.** If a merge-tree read fails or runs past its deadline, there is no conflict view. If the review cannot be read (`refusalOf`), there is no conflict view. If the Work file cannot be read, the conflict counts as held. Every doubt keeps the agent asleep. The cost is that a conflict on an unreadable review is never resolved automatically. It shows on the Reviews page as before, and a person can press Run now.

### What the prompt keeps

The run still merges, never rebases. It still pushes fast-forward only, verifies, escalates to Human required, and handles `intent/` and spec branches as before. It now resolves the one review its task names, rechecks that the conflict still exists (another fix may have landed since), and exits.

### What the schedule keeps

None. R-4's interval trigger is removed when this ships. **Run now** stays for a person. It picks the first due conflict key and, when none is due, says so without starting a session.

## Interaction with pr-swarm runs (revision 4)

An R-4 merge of the base moves the branch tip. Under revision 4's T2, a clean resolution leaves the branch's own changes, compared by patch id, the same. So it starts no pr-swarm run. A resolution that had to change the branch's own lines is a change, and it gets reviewed, which is what should happen.

## Constraints

- The watcher's bounds stay as they are: 60-second passes, 2 reviews at a time, 10-second deadline per review. The merge-tree read shares that deadline, and runs only when the branch or base tip moved since the review's last read. An unchanged pair reuses the last answer.
- Only the live colour reads and fires (rule 6).
- Nothing is added to the review file or the routine file beyond fires (rule 5).

## Non-goals

- Resolving conflicts in the server. The agent still does the merge.
- Watching branches that have no open review.
- Changing R-1 or R-2's triggers.

## Interim

Until this ships, R-4's interval goes from 30 to 60 minutes. That halves the empty wakes. Most of the remaining conflicts were JOURNAL.md, which W-129 now merges by itself. The extra latency costs little at the rate conflicts are arriving (1 run in 7 had work).

## How this was checked

`intent/2026-11-21-review-conflict-trigger.dfy` models one routine's ticks. Each tick sees the watcher's conflict list, which keys are held, which are under 15 minutes old, and whether the gates pass. The model also covers a refused start and a run ending. Dafny 4 verifies 20 items with 0 errors. The key lemmas:

- Safety: a fire names a key the watcher saw conflicting, and that key is not held or fresh (C1, C3). A pass with no conflicts starts nothing (Outcome 1). A key that fired never fires again unless its start was refused (C2). There is never a second run while one is active (C4). A closed gate starts nothing (C5).
- Progress: a due conflict is never passed over. A refused start stays due. A held conflict fires on the first tick after it stops being held.
- The observed record: five empty passes in a row leave the routine unchanged. One conflict listed on pass after pass is one run.

Mutation check. Each rule was removed in turn, and each removal made proofs fail.

| Rule removed | Lemmas that failed |
|---|---|
| C2, fired keys excluded | EachConflictFiresOnce, OneConflictOneRun |
| C2, the fire recorded | OneConflictOneRun |
| C2, a refusal un-records | DueConflictStartsARun, RefusedStaysDue |
| C3, held excluded | OnlyRealSettledConflictsFire |
| C3, fresh excluded | OnlyRealSettledConflictsFire |
| C4, active run blocks | OneRunAtATime |
| C5, gates | GatesStillApply |
| C1, never fire at all | FirstDueFinds, OneConflictOneRun |

The model leaves several things out. It does not model git (the `merge-tree` answer is taken as given) or the watcher's deadlines. It does not model the task route's caps, beyond the fact that a refusal happens. It does not model the run's own merge. A run that pushes a resolution changes the branch tip, so its key leaves the conflict list on the next pass. That follows from the key's definition and is not proved here.

## Tickets

1. The watcher's conflict read and the `ConflictView` list (`swarm-watcher.ts`, a `merge-tree` reader with the same deadline).
2. The `review-conflict` trigger: schema, `planFire` step, Run now, and the routine form row (`routines.ts`, its runner, `routines-ui`).
3. R-4's prompt rewritten for one named review, and its interval trigger replaced.
