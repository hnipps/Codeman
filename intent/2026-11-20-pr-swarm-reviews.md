# Intent: pr-swarm runs on every review

**Status:** Draft (spec, revision 3; the owner's answers of 2026-11-20 are recorded under Constraints, D1 to D4 were settled in review, and R-3 is now part of this work)

## Problem statement

The `pr-swarm` plugin (`pr-swarm@nicholls`: the `/pr-swarm` review skill and the `/review-triage` fix-and-close skill) is installed, but nothing runs it. Its README assumes a GitHub Actions workflow on GitHub pull requests. Codeman's reviews live on the Reviews page. Many of them have no GitHub pull request, only a branch. Today a review gets no automated check before the owner reads it, and a branch that moves after submission is not checked again.

## Outcomes

1. Every open review gets a pr-swarm run when its code changes: a submission, a resubmission, or a push to its branch from an agent or a person.
2. The Reviews page shows each review's pr-swarm state (queued, running and which round, or the last verdict) with the findings. It has a **Run pr-swarm** button to ask for a run by hand.
3. A review has at most one run at a time. Commits pushed while a run is going are reviewed by that same run before it finishes. They never start a second run.
4. Non-spec reviews get the full triage: `/review-triage` behaviour, which fixes what it may, commits with the `PR-Swarm-Automated: true` trailer and pushes to the review's branch. Spec reviews get the review half only. Nothing edits a spec under review.
5. Work attributed to an approved spec merges and deploys automatically when the final pr-swarm verdict is `APPROVE` or `APPROVE_WITH_NITS` and R-3 passes it (Outcome 8). It goes through the same path as the page's Approve button. Other approve verdicts are recorded and wait for the owner, and spec reviews never merge automatically.
6. Any other final verdict (`REQUEST_CHANGES`, `BLOCKED`) is sent to an agent the way Request changes sends notes: to the author session of a session review, or onto the work item of a work review.
7. Two non-approve verdicts in a row on one review escalate to the owner. The review's open work items move to **Human required**, each with a comment naming the decision needed. A review with no work item shows **Escalated** on the page and sends a notification.
8. **R-3 is built here, as a step of `/review-triage`.** On a review attributed to an approved spec, the run ends with an R-3 pass: the work is checked against that spec in poteto-mode. pr-swarm's crosscheck lenses (byfuglien and hellebuyck) already supply the crosscheck review, so poteto-mode is the addition. R-3 gives `pass`, `changes` or `escalate`, and it lists the work's Deviations from the spec.

## Constraints

- **Owner answers, 2026-11-20:**
  - Triage is the full `/review-triage` as shipped for non-spec reviews.
  - Only work attributed to an approved spec may merge automatically. Spec reviews never do.
  - Runs happen in Codeman as background work, not in GitHub Actions.
  - Every review gets a run, and the results appear in Codeman only. Nothing is written to GitHub: no review comments, no sticky summary, no thread replies or resolutions, and no auto-merge armed there.
  - Escalation needs two non-approve verdicts in a row. An approve verdict resets the count.
- **Owner answer, review note 2026-11-20:** R-3 is part of this work and part of the `/review-triage` skill. The skill already uses crosscheck agents, so poteto-mode is the addition.
- **R-3 as the spec-first lifecycle defines it** (`intent/2026-11-18-spec-first-lifecycle.md`): it runs in a different session from the builder, it reads poteto-mode's SKILL.md file as R-2 does, and no unattended version of poteto-mode is built. Its escalation triggers are that spec's fixed list. A crosscheck finding feeds R-3's judgment and never escalates on its own.
- **"Auto-merge" means Codeman's Approve.** With no GitHub writes, review-triage's auto-merge step maps to Codeman's own Approve: merge (`review-merge.ts`) and deploy (`codeman-deploy`). It keeps Approve's compare-and-swap on `headSha`: if the branch moved after the reviewed tip, the merge is refused and the run goes on (I2). See D1.
- **PRODUCT.md principle holds.** Nothing merges or deploys without a person's approval of the spec that authorises it. Only spec-attributed work merges without a button press, and agents never approve specs.
- **Never a GitHub approval.** This is the plugin's own hard rule and it holds unchanged.
- **Self-building rule 5.** The strict review schema (`ReviewSchema`) gets no new key. Run state is kept in its own file, so the previous release reads every review file unchanged and ignores the run files.
- **Rule 6.** Only the live deploy colour starts runs, writes run state, sends verdicts or merges. A candidate colour shows state read-only.
- **The 8 GiB host** (`host-memory-and-deploy-limits`). At most one pr-swarm run at a time server-wide; the rest queue (D3). Each run is one Claude session, and its lens subagents run inside it. Branch-tip polling is bounded: open reviews only, interval 60 s, 2 at a time, 10 s timeout each.
- **Never on the review-sync timer.** The tip watcher reads tips only. It never syncs a work review: the rule in `work-reviews.ts` stays as written.
- **Git safety rules carry over** from `review-git.ts`: argv only, checked refs, no git on a remote or Docker case or inside a Docker case workspace. A review whose repository fails those checks gets no run, and the page says why.
- The brief and every finding reach the DOM through `textContent` only. Finding text is agent-written and untrusted.

## Invariants

## I1: OneRunPerReview

At any moment a review has at most one run in the `queued` or `running` state. A trigger (submit, push, manual) on a review that already has one does not create a run. A manual request then answers `409 RUNNING` and returns the run it joined.

- *Test:* random interleavings of triggers and run completions against the pure run model. Count queued plus running per review, and it never exceeds 1.

## I2: PushesJoinTheRunningRun

A run finishes only when the tip it last reviewed equals the branch's current tip. A tip change seen during a run is recorded on that run as `pendingTip`. When the agent reports a round, the server compares tips and, if they differ, sends the same session one more round for the new tip. That repeats until the tips match or the run reaches the plugin's 5-round cap (INV-4). A run that hits the cap with tips still different ends `incomplete`. An incomplete run carries no verdict: nothing is sent, nothing merges, and it does not count toward escalation. The next run is queued for the new tip.

- *Test:* the model gets a run, a push mid-round, then a round report for the old tip. The run is still running and asks for another round. A report for the new tip finishes the run. Six moving rounds end it `incomplete` and queue one new run.

## I3: NothingIsWrittenToGitHub

A run never calls a GitHub API that writes. The run's brief invokes both skills in Codeman-local mode (D2). In that mode they read the diff from git, take their triage units from pr-swarm's findings instead of GitHub threads, and print results instead of posting them. The run's session is started with `GH_TOKEN` and `GITHUB_TOKEN` set empty, so a stray `gh` write fails rather than posts. Pushes to the review's branch are git and are allowed (Outcome 4).

- *Test:* the brief builder's output always carries the local-mode flag. The session's env overrides always blank both tokens. A grep test over the brief finds no `gh pr review`, `gh pr merge` or `gh api` write verb.

## I4: OnlySpecWorkMergesItself

The server starts an automatic Approve only when all of these hold, each read fresh at that moment:
- the run finished with `APPROVE` or `APPROVE_WITH_NITS`;
- the review is not a spec review;
- the review is attributed to an approved spec;
- the review is open and not escalated;
- R-3 passed that same tip (I9);
- the branch tip equals the tip that verdict reviewed.

It then calls the same function the Approve button calls, so every existing Approve refusal still applies.

- **Spec review:** the branch changes only `intent/*.md`, plus files the spec links (canvas prototypes and docs).
- **Attributed:** the review is a work review, and its item's `createdFrom` parent item has a merged review that was a spec review.

- *Test:* the decision table over the conditions. Only the all-true row approves, and a spec review is never approved whatever the other columns say.

## I5: OneSendPerVerdict

Each non-approve final verdict produces exactly one send. A session review's send pastes into the author session through `deliver()`. A work review's send goes through `workReviews.sendChanges()`. The text is built by one pure function, `swarmVerdictPrompt()`. It lists the findings and the triage's deferred items, and it ends with the same instruction Request changes uses for that kind of review. A failed delivery is shown on the run (`send: failed` and the reason) and is not retried on its own; the page offers **Send again**.

- *Test:* the run model emits one send action per non-approve verdict, and none for approve, incomplete or failed runs. The prompt builder's ending matches `requestChangesPrompt()` for both review kinds.

## I6: TwoInARowEscalates

A review keeps `streak`, the number of non-approve verdicts since its last approve verdict. Incomplete and failed runs leave it unchanged. When `streak` reaches 2, the review is escalated, and in that same step:
- the verdict is NOT sent to an agent;
- every open work item linked to the review moves to Human required with a comment that names the review, the two verdicts and the action needed;
- with no linked item, a notification goes out.

While a review is escalated, runs still happen and show, but nothing is sent and nothing merges automatically. A person clears the escalation by sending notes, approving, closing, pressing Run pr-swarm, or moving the item out of Human required. Clearing it resets `streak` to 0.

- *Test:* verdict sequences against the model. `R, A, R` never escalates, and `R, R` escalates on the second. After escalation nothing is sent, and a clear resets the count.

## I7: ReviewFilesUnchanged

No release with this feature adds a key to `ReviewSchema` or `ReviewFileSchema`. Run state lives in `<data dir>/reviews/<id>.swarm.json` (`{ version: 1, ... }`, 0600, tmp + fsync + rename, live colour only), and the previous release never reads it.

- *Test:* a frozen copy of the current `ReviewFileSchema` parses every review file written while runs exist.

## I8: RunOwnCommitsNeverStartARun

A tip change whose commits all carry `PR-Swarm-Automated: true` and come from the running run is that run's own work. It is reviewed inside the run (I2) and never queues a run after it. A person's or another agent's commit always counts as a change.

- *Test:* the watcher's classifier, given a commit list, returns `own` only when every commit has the trailer and the run is active. Otherwise it returns `change`.

## I9: R3FailsClosed

R-3 runs only on a non-spec review attributed to an approved spec, and only on the final tip of the run, after the last pr-swarm round and after any fix the run pushed. Its result is `pass`, `changes`, `escalate` or `unavailable`. Only `pass` on the tip the merge would take counts toward I4. When poteto-mode's SKILL.md cannot be read, the spec cannot be read, or the step does not report, the result is `unavailable`. Then nothing merges, and the verdict waits for the owner. `changes` counts as a non-approve verdict for I5 and I6. `escalate` names a trigger from the lifecycle's list, and it escalates at once, as I6 does on its second verdict.

- *Test:* the decision table again. An `unavailable`, `changes` or `escalate` row never merges, and a `pass` on an older tip never merges. A missing SKILL.md path in the brief gives `unavailable`. An `escalate` with no named trigger is refused at report validation.

## Non-goals

- GitHub comments, GitHub auto-merge, or any GitHub Actions workflow.
- Changing pr-swarm's lenses, its router or its verdict scale.
- The rest of the spec-first lifecycle: the Shipped log, agents fixing failed deploys, and rewriting R-1 and R-2. R-3's verdict and Deviations are kept on the run record, where a later Shipped log can read them (D5).
- An unattended version of poteto-mode.
- Running on decided or closed reviews.
- Multi-person review.

## Acceptance checks

1. Submitting a session review queues a run. The page shows `queued` and then `running · round 1 · abc1234`.
2. Pushing a commit to that branch mid-run shows `pendingTip` on the page. The run does a second round on the new tip, and no second run appears.
3. Pressing Run pr-swarm during a run shows the running run. Pressing it after the run ends starts one.
4. A `REQUEST_CHANGES` verdict on a session review pastes one prompt into the author session. On a work review it puts the text on the item, which moves to the top of Ready.
5. A second `REQUEST_CHANGES` in a row moves the linked item to Human required with a comment, and nothing is sent.
6. A spec-attributed work review with an `APPROVE` verdict and an R-3 `pass` merges and deploys. The decision reads as made by pr-swarm and R-3, citing the run. The same pr-swarm verdict with an R-3 `changes` sends the R-3 findings instead. On a spec review or an unattributed review, an approve verdict is only recorded, and no R-3 step runs.
7. With poteto-mode's SKILL.md renamed away, the same run shows R-3 `unavailable` and nothing merges.
8. No GitHub write happens during any of these. Check the PR's comments and the `gh` audit in the run session's transcript.
9. Desktop and phone both show the state chip, the findings, the R-3 result and the button.

## Design

- **Queue row:** a small chip after the review state: `swarm: running`, `swarm: approve`, `swarm: changes`, `swarm: escalated`.
- **Review top bar:** a pr-swarm section with the chip and the round or tip, then **Run pr-swarm**, which reads **Running…** and is disabled while a run is active, and a link to the run's session.
- **Below the walkthrough:** a collapsible **pr-swarm** panel with the last run's verdict, the findings (lens, severity, file and line as a Changes link, text), the triage outcome (fix commits as links, and deferred items), the R-3 result (verdict, the trigger when it escalated, its findings and its Deviations, with a link to the spec), the send result with **Send again**, and the earlier runs, newest first, capped at 20.
- Escalated reviews show the reason at the top of the review, matching the spec-first escalation lane.

## Technical design

- **`src/reviews/swarm-model.ts` (pure).** Holds the run record, the state machine (`queued → running → passed | changes | blocked | incomplete | failed`), `streak` and the escalation flag, the auto-merge decision (I4), the spec-review and attribution predicates, `swarmVerdictPrompt()`, and validation of the agent's report. The report is the pr-swarm return contract, capped and cleaned like review text.
- **`src/reviews/swarm-store.ts`.** Reads and writes the `<id>.swarm.json` files with the same rules as `review-store.ts`.
- **`src/reviews/swarm-runner.ts`.** Runs a FIFO queue with a cap of 1. For each run:
  - makes a managed worktree at the reviewed tip (detached);
  - starts a Claude session there with blank GitHub tokens and the brief: local mode; for a spec review, `/pr-swarm` only; otherwise `/review-triage`, pushing with `git push origin HEAD:refs/heads/<branch>`, or updating the local ref for a branch that has no origin;
  - waits for the agent's report through `codeman agent swarm report <runId> --file <json>` (new verb, ownership-checked: only the run's own session may report);
  - applies I2, I5, I6 and I4;
  - removes the session and the worktree. A run whose session dies or goes silent for 30 minutes ends `failed`.
- **`src/reviews/swarm-watcher.ts`.** On submit and resubmit it triggers at once. Every 60 s it reads the tips of open reviews: the local ref for a session review without origin, otherwise `git ls-remote origin <branch>`. It uses the bounds in Constraints and classifies commits by I8.
- **Routes in `review-routes.ts`.**
  - `GET /api/reviews/:id/swarm`: the run state.
  - `POST /api/reviews/:id/swarm`: a manual run, person only, `409 RUNNING` when one is active.
  - `POST /api/reviews/:id/swarm/resend`: sends a failed verdict again.
  - An SSE event `review:swarm` is added to both registries.
- **Escalation writes** go through `changeWork()` and the work-comment path, as `review-work.ts` does.
- **Plugin change (D2)** goes in the nicholls marketplace repository, not here. It adds `--local` to both skills: no `gh` writes, the diff comes from `git diff <base>...HEAD`, the triage units are pr-swarm's findings, and the result is printed as JSON. The grep proof obligation is unchanged.
- **R-3 step in `/review-triage`** (nicholls marketplace). New flags `--spec <path>` and `--poteto-skill <path>`. Codeman passes both for an attributed review: the parent spec file, read at the merged commit, and poteto-mode's SKILL.md. The plugin hard-codes no path into another plugin. The step runs once, after the loop ends, in the triage session:
  - it reads poteto-mode's SKILL.md and follows it as a reviewer, with the adaptations R-2 uses: an ask becomes a `deferred` item in the report, and any subagent it dispatches runs in the foreground, under the skill's existing rule for adding `Agent`;
  - it checks the diff from base to the final tip against the spec's outcomes, constraints, invariants and non-goals, and it reads the pr-swarm result, including both crosscheck lenses, as input;
  - it returns `r3: { verdict, trigger?, findings[], deviations[], tip }` in the JSON result. It never edits code, so the lifecycle's rule that the reviewer is not the builder holds even though the triage step may push fixes.
- **Brief and report.** The runner adds `--spec` and `--poteto-skill` only when the review is attributed (I4's predicate). `swarm-model.ts` validates the `r3` block and caps its text like review text.
- **Risks:**
  - The plugin's GitHub-shaped steps (thread pagination, CI wait, branch protection reads) need a clean local branch, or a run stalls. Mitigation: the 30-minute silence rule and `failed` state.
  - Spec-review detection by path is a heuristic until W-68 gives reviews a kind. A wrong "not spec" only gives a spec the full triage, and I4 still requires attribution before any merge.

## Ticket breakdown

<details><summary>7 tickets</summary>

1. **t1 Run model and store**: `swarm-model.ts`, `swarm-store.ts`, and tests for I1, I2, I4, I5, I6, I7 and I8. No dependencies.
2. **t2 Plugin local mode**, in the nicholls marketplace: `--local` for `/pr-swarm` and `/review-triage`. No dependencies.
3. **t3 Runner and report verb**: `swarm-runner.ts`, `codeman agent swarm report`, the session lifecycle and the brief. Needs t1 and t2.
4. **t4 Triggers**: submit hook and `swarm-watcher.ts`. Needs t3.
5. **t5 Outcomes**: verdict send, escalation to Human required, and automatic Approve for spec-attributed work once R-3 passes. Needs t3 and t7.
6. **t6 Reviews page**: chip, panel and button, desktop and phone, plus the SSE event. Needs t1, with live data after t3.
7. **t7 R-3 step**, in the nicholls marketplace: `--spec` and `--poteto-skill` for `/review-triage`, the `r3` result, and its tests. Then Codeman's side: the brief passes both flags, and the model tests cover I9. Needs t2.

</details>

## Decisions for Harry

- **D1 Auto-merge is Codeman's Approve.** Since nothing is written to GitHub, an approve verdict on spec-attributed work runs Codeman's own merge and deploy. Agreed in review, 2026-11-20.
- **D2 The plugin gets a local mode.** Both skills are written around GitHub reads and writes. A `--local` flag in the plugin is cleaner than a Codeman brief that tells the agent to skip half of each skill. Agreed in review, 2026-11-20: add the flag (ticket t2).
- **D3 One run at a time server-wide.** For the 8 GiB host. Raise it later if measurements allow. Agreed in review, 2026-11-20.
- **D4 A run and R-3.** Settled in review, 2026-11-20: R-3 is built in this work, as a poteto-mode step in `/review-triage` (Outcome 8, I9, ticket t7). An automatic merge needs both pr-swarm's approve and R-3's pass.
- **D5 The Shipped log waits.** The spec-first lifecycle also asks for a read-only Shipped log on each spec. Recommended: leave it out of this work. The run record keeps R-3's verdict and Deviations, so the Shipped log can be built on them later.

## Checks run

None yet. This is a spec.
