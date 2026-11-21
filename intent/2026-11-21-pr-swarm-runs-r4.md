# Intent: pr-swarm runs, revision 4: real triage, and no wasted runs

**Status:** Draft

**Supersedes:** in `intent/2026-11-20-pr-swarm-reviews.md` (revision 3, merged), the trigger rules: Outcome 1, I1's trigger sentence and I8. Every other part of revision 3 stands. R-3 the routine (the "pr-swarm sweep" stopgap) is retired: the owner switched it off on 2026-11-21 ("let's drop the routine and fix up W-112").

Owner request, 2026-11-21: "W-112 should also do review-triage. So let's drop the routine and fix up W-112. Also check for possibility of wasted runs there."

## Problem statement

### The built-in runs do not run review-triage

W-112's runs (live since 15:30 on 2026-11-21) ask for `/review-triage --local` on every non-spec review, as revision 3 says. But the skill they ask for is not there:

- The pr-swarm plugin is not installed for Claude Code on this host (`installed_plugins.json` lists only crosscheck and pstack), so the run session has no `/review-triage` or `/pr-swarm` command.
- The brief's fallback reads the skill file from the marketplace checkout, whose skills have no `--local` mode. Ticket t2 (W-110) is the open pull request nicholls-inc/claude-code-marketplace#259, not merged.

Every run so far records the same degradation, for example: "the installed review-triage/pr-swarm skills do not implement --local, so the triage ran by hand over git diff … No reviewer subagents dispatched; a single-pass review covered the whole diff." So each run is one agent's single pass, not pr-swarm's lenses, and no run has applied a triage fix. The only fix commits on review branches came from the R-3 routine.

### Runs that review nothing new

The run records from 2026-11-21 (`~/.codeman/reviews/*.swarm.json`) show four kinds of run that found nothing to review, and the code shows two more:

1. **A merge of the base.** `build/w-77…` and `build/w-88…` each got a full run for a push that only merged `origin/master` into the branch. The branch's own changes were byte-identical before and after.
2. **A burst of pushes.** `build/w-77…` got runs at 17:31 and 17:34 for two pushes three minutes apart. The second run started on work the author was still pushing.
3. **Another agent's trailer commits.** The R-3 routine's fix commits carry `PR-Swarm-Automated: true`, but they did not come from the running run, so I8 counted them as a change and queued a new run each time (three of the runs above). Retiring R-3 ends this one.
4. **A resubmit at a tip already reviewed.** The model's `trigger` event queues a run on any submit when no run is going, even when the last finished run reviewed that very tip (a walkthrough-only resubmit).
5. **A builder still at work.** A review submitted while its Work item is In progress gets a run on each push the builder makes. It reviews unfinished work, and review-triage then pushes fixes onto a branch the builder is still writing. R-3 skipped those reviews; the built-in runs do not.
6. **A decided review.** A queued run is dropped at start when its review was decided, but a running run carries on after Approve or close. It spends the rest of its rounds, and its triage can push fixes to a branch that has already merged.

## Outcomes

1. Every non-spec review gets the real `/review-triage`: pr-swarm's lenses, fixes committed with the trailer and pushed to the review's branch. Spec reviews get `/pr-swarm` only, as before.
2. A run starts only when the review's own changes are new and settled, and nobody is still building them. Merging the base in, resubmitting the same tip, and a burst of pushes in progress all start nothing.
3. Deciding or closing a review ends its run at once.

## The plugin (Outcome 1)

This part needs no Codeman code:

- merge nicholls-inc/claude-code-marketplace#259 (`--local` for both skills), after its own review;
- pull the marketplace checkout and install the plugin (`claude plugin install pr-swarm@nicholls`), so the run session has both commands;
- the runner already passes `--local`, `--base`, `--head-sha`, `--push-ref` and `--push-remote`, which match #259's flags.

Acceptance: a run on a non-spec review records no "does not implement --local" degradation and names pr-swarm's lenses in its findings, and a finding it can fix produces a trailer commit on the branch.

## Invariants (revising revision 3's trigger rules)

Words used below:
- **reviewed tip**: the tip the newest finished run (`passed`, `changes` or `blocked`) reviewed last. `incomplete` and `failed` runs review nothing.
- **the review's changes at a tip**: `git diff <base>...<tip>`, the branch's own changes from its fork point, compared by `git patch-id --stable`.
- **held**: the review's linked Work item (the item whose `pr.branch` is the review's branch, on the owner's canvases) is In progress.

### T1: SubmitAtTheReviewedTipStartsNothing

A submit or resubmit whose tip is the reviewed tip, or whose changes at that tip equal the changes at the reviewed tip, queues no run. A person's **Run pr-swarm** always queues one (I1 still applies), so a person can always ask again.

- *Test:* a finished run on tip A, then a submit on A: no run. A submit on B with new changes: one run. A manual run on A: one run.

### T2: TheBaseMergedInIsNotAChange

A tip move is classified `same-changes` when the review's changes at the new tip equal its changes at the tip it moved from. That covers a clean merge of the base, a rebase that changed nothing on the branch's side, and a merge that only resolved conflicts back to the same result. A `same-changes` move never queues a run, and the watcher records the new tip as seen. A move whose comparison fails (a git error or the deadline) counts as a change, so doubt reviews.

A merge whose conflict resolution changed the branch's own lines is a change, because its three-dot diff differs.

- *Test:* the classifier, fed equal and unequal patch ids, and a failed read. A model trace of base merges never starts a run.

### T3: PushesSettleBeforeARun

When no run is active, a push-triggered run is queued only after the branch tip has stayed the same for `SETTLE_MS` (5 minutes, five watcher passes). Each new tip restarts the wait, and the run reviews the tip it waited on. A submit or a person's press does not wait. While a run is active, a push still joins it (revision 3's I2, unchanged).

- *Test:* pushes at 0, 2 and 4 minutes queue one run, at 9 minutes, on the last tip. A push at 0 and none after queues one run at 5 minutes.

### T4: AHeldReviewWaits

While a review is held, no run is queued by a submit or a push, and an active run is left to finish (it has already started its own session and is not wasted). When the item leaves In progress, the next watcher pass once the changes have settled (T3) queues one run if the review's changes differ from the reviewed tip's (T1's rule). A person's press runs at once, held or not.

- *Why:* R-2's builders submit while In progress and then report `ask`, which moves the item to Human required. The run then reviews the finished branch once, instead of every push on the way.
- *Test:* submit while held: no run. Pushes while held: no run. The item moves to Human required: one run. A manual press while held: one run.

### T5: DecidingEndsTheRun

When a review gets a decision (merged, deploying, deployed or closed), its active run ends `failed` with the reason "The review was decided", in the same step that records the decision. Its session and worktree are removed, nothing is sent, nothing merges, and the streak is unchanged. A report from that session afterwards is refused (`NOT_ACTIVE`), so any result it computed is dropped. `deploy-failed` is still open, as revision 3's `isOpen()` says, and does not end a run.

A push the session already made cannot be taken back. Stopping the session as the decision lands is what bounds it.

- *Test:* the model: a run active, then a decision. No active run remains, the state is failed, and no send or approve action is emitted. A later report changes nothing.

### Unchanged

I1 (one run per review), I2 (pushes join the running run), I8 (a running run's own trailer commits are its own) and the rest of revision 3 stand. T2 runs before I8: a move is `same-changes`, else `own`, else a change.

## Constraints

- The watcher's bounds stay: 60-second passes, 2 reviews at a time, a 10-second deadline each. T2 adds two `git diff | git patch-id` reads to a move, under the same deadline and only when the tip moved.
- T3's settling state and T4's held check live in the watcher's memory and the run file. The run file gains no key (rule 5 and revision 3's I7). A restart forgets a settling push and starts the 5 minutes again.
- T4 reads Work items the same way Approve does (the owner's workspaces, `pr.branch` matching the review's branch). A Work file that cannot be read counts as not held, so doubt reviews.
- Only the live colour acts (rule 6).

## Non-goals

- The plugin's own code: #259 is reviewed in its repository.
- R-3 (the spec-first reviewer step, ticket t7) and verdict sending (t5): unchanged.
- A review whose base itself moved underneath an unchanged branch. T2 does not re-review it: the branch's own changes did not change, and the merge into the new base is what R-4 and Approve check.
- Batching several reviews into one run.

## How this was checked

`intent/2026-11-21-pr-swarm-runs-r4.dfy` models one review's runs under every event: submit, push (with or without new changes, own trailer commits included), the watcher's pass, the clock, a person's press, the Work item entering and leaving In progress, a round's report, a run failing, and a decision. A tip is modelled by its changes (the patch id), so two tips with the same changes are one value.

Dafny 4 verifies all 22 lemmas, 0 errors:

- Safety: a decided review never has a run, and nothing starts one afterwards (T5); a run that starts by itself reviews changes no finished run reviewed (T1, T2); nothing starts by itself while held (T4); a push never starts a run, and the pass that does has waited `SETTLE` since the changes last moved (T3); a move to the same changes changes nothing (T2).
- Progress: a new push with nobody building is reviewed by the first pass `SETTLE` later; work submitted while held is reviewed by the first settled pass after the item leaves In progress. So the rules do not trade waste for missed reviews.
- The waste the run files showed, as concrete traces that now start nothing: a base merge after a finished run, a burst of three pushes (one run owed, none started mid-burst), a resubmit at the reviewed tip (while a press still runs), and a builder pushing while In progress.

Mutation check: each rule was removed in turn and the proofs had to fail.

| Rule removed | Lemmas that failed |
|---|---|
| T1 in submit | OnlyNewChangesStart, ResubmitStartsNothing |
| T4 in submit | HeldStartsNothing, BuilderPushesStartNothing |
| T4 in pass | HeldStartsNothing, BuilderPushesStartNothing |
| T3 in pass | PassWaited, BurstIsOneRun |
| T3 in push (start at once) | PushesSettle, BurstIsOneRun, HeldStartsNothing, OnlyNewChangesStart |
| T5 in decide | StepInv, DecidingEndsTheRun |
| T2 in push | SameChangesChangeNothing |

T2's only effect the model can see beyond T1 is that a base merge does not restart a settling wait: when the old tip was already reviewed, T1's reviewed-tip check would also refuse the run. T2 is kept because it is the cheap check (the previous tip, already in the watcher's memory) and it keeps the wait honest.

What the model leaves out: git itself (the patch id is taken as given), the watcher's deadline and concurrency bounds, restarts (the settle wait starts again, per Constraints), and the session's own work inside a round.

## Tickets

1. Merge #259 and install the plugin (owner, in the marketplace repository).
2. T1–T5 in `swarm-model.ts`, `swarm-watcher.ts` and `review-routes.ts`, with their tests and docs.
