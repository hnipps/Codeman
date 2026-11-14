# Agentic Canvas initial version plan

This plan takes the Codeman fork from its finished self-building loop toward a canvas-native agent workspace. The target includes the canvas and agent-readable object model, queryable logs, a thin ambient assistant rail, direct/gesture context capture, voice, background agents, configured provider/model choice and connected agent comment threads.
PC1–PC8 cover the original C1–C5/O1–O3/L1–L2 foundation. The owner's subsequent clarification brings native conversations, per-message context and explicit agent comment-thread participation into the design target through PC9–PC12. PC13 then makes the canvas the shell: Codeman opens on the canvas, and the tab dashboard becomes a fallback. Code-editing background tasks require isolated worktrees; a general worktree-management UI, PR/CI dashboards and production-operation UI remain later work.
The program enforces one rule. The server's operation log is the only source of truth, and every write names its author.
Impeccable shape comes first, before any implementation PR starts. The implementation checklist below is provisional until shape resolves the canvas UI/UX.
PC1–PC8 retain their dependency graph. PC9 follows the canvas, session-access and comment foundations; PC10 connects anchored threads to those real conversations. PC8 remains independent telemetry work. PC9–PC12 require detailed implementation scoping before their owners start; the design does not assert the session adapter already exists.
The remaining parts of phases 2 to 6 are outlined in Appendix E. The owner's current direction supersedes the old eight-PR product cutoff.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `~/.claude/skills/poteto-mode/playbooks/autopilot-stack.md` with the execution authority below. The coordinating agent owns orchestration, verification, landing every PR and deploying each verified change. It continues without per-PR approval, merge clicks or deploy permission. For PC3, PC4, PC5 and PC6, agent design review checks the rendered interaction against the shaped brief before merge.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

The following rules apply to every box.

- The fork is public. No commit names a hostname, an IP address, a port in use, a username, a server path or another service.
- The coordinating agent may delegate work, start and prompt worker sessions, review results and continue this program without another human message. Every worker receives a bounded task and an isolated worktree. The coordinator owns stopping workers and preventing duplicate work.
- Stored data rolls forward. Every new file stays readable by the previous release, and a rollback restores code only.

## Execution authority from this review

Harry's review of this plan authorizes the coordinating agent to orchestrate the canvas program, land its verified PRs and deploy automatically after verification passes. This supersedes the earlier human-message-only restriction and the manual merge, interaction-review and deploy gates for this program, including conflicting workflow defaults in the brief, minimal PRD, self-building guide and execution playbooks. It does not authorize unrelated background work, host or supervisor changes, weaker checks, credential access or changes to access controls. Record this scoped amendment in the program's instructions and decision trail before workers start, so they inherit the same authority.

The previous worker-session ban came from that older restriction: prompting a separate Codeman session would start an agent turn without a new human message. It was not a technical requirement to use in-turn subagents. Under this review, either subagents or Codeman worker sessions are allowed. Choose according to task lifetime, available capacity and the ability to observe, stop and resume them. Keep one owner per PR and one worktree per owner regardless of session type.

The owner approved this plan on 2026-11-10. The shape deliverables are recorded in [the canvas UI/UX brief](canvas-ui-ux-brief.md) and [design studies](design/index.html). This design turn does not start the implementation PRs; their existing execution authority remains in force.

## Shape the canvas before implementation

- [x] Run `/impeccable shape` for the canvas UI/UX before implementation, including the revised conversation and thread scope. Load the installed skill's context and shape instructions. If PRODUCT.md is missing, use its init flow with a structured simulated user grounded in the source documents. Inspect the existing desktop and phone UI before choosing an extension of its visual system.
- [x] Read [Canvas design references](canvas-design-references.md) and inspect the three owner-supplied clips and the Opsdeck design system before shaping. Use the clips for spatial clusters and focused document editing, and Opsdeck for the visual character of controls and panels. Shape a dark-mode adaptation; its inherited dark tokens are starting candidates, not a finished theme.
- [x] Use the vision, minimal PRD and this review as the brief. Harry delegates design decisions to the agent for this program. Record assumptions and use the skill's structured simulated-user path where available; do not create a new human interview or confirmation gate. This delegation overrides shape's default human confirmation step for this program.
- [x] Shape the laptop and phone journeys: opening a workspace, exploring and grouping content, directing an agent from a container, seeing agent changes, navigating sub-canvases, commenting and reverting one author's changes. Keep later-phase agent actions explicit as future states rather than silently adding them to this build.
- [x] Resolve selection, pan and zoom, editing, navigation, tool placement, hierarchy, feedback and keyboard/touch behavior. Explore the clips' corner-bracket selections, compact contextual tools, drag-to-group feedback and document focus panel. Any grouping gesture must save explicit containment; proximity alone must not change agent context. Decide which text-editing interactions belong in PC4 and defer Git-backed documents to Phase 3. Cover empty, loading, error, offline, overflow and read-only states, and realistic small and large canvases. Produce reviewable layout and interaction concepts with a documented selection by the design agent.
- [x] Make keyboard shortcuts a first-class part of shape. Adapt Opsdeck's visible key hints and contextual navigation, document the full canvas binding map, and resolve conflicts with pan gestures, text editing, terminal input and Codeman navigation. Include shortcut discovery, keyboard focus, escape behavior and pointer/touch alternatives.
- [x] Save the shaped brief at `docs/agentic-canvas/canvas-ui-ux-brief.md`, including the selected direction, flows, states, responsive behavior, dark-mode palette and states, keyboard shortcut table, accessibility requirements, assumptions and acceptance criteria. Shape produces a design brief, not implementation code.
- [x] Reconcile PC1 through PC12 with that brief before spawning implementation owners. Treat the DOM renderer, tab placement, controls and interaction details below as proposals. Revisit them when shape exposes a mismatch, and preserve the operation-log and deployment guarantees.
- [x] The coordinating agent checks the brief for scope and completeness, records the design decision and marks shape complete. Implementation retains its existing authority to proceed without another approval gate. Later visual checks compare against this brief.

## Design decisions carried into implementation

The shaped brief governs layout, keyboard scope and interaction details where the earlier checklist differs. The selected composition has no navbar. Search and workspace navigation live in the outline; board labels are primarily user/agent content. A 320-pixel right assistant rail collapses completely without changing the canvas camera. Direct selection and hold-Q lasso capture replace the rejected modal picker. Nonmodal shortcuts, voice, configured provider/model controls, background agents and connected comment threads are central. Floating conversation cards are superseded. The phone supports conversation, reading and comments. Codeman is the delivery shell, not the final navigation model; PC13 replaces it with the canvas. Static studies do not verify any implementation gate.

- PC1 preserves stable sibling order and object IDs for accessible navigation. Focus is tracked by ID; agent insertions do not shift it.
- PC2 exposes explicit container read targets while allowing workspace-wide agent discovery. Per-message attachments guide attention; they are not an access boundary.
- PC3 adds the outline with search, selection/focus read states, plain-text focus panel and Keys. It has no navbar, board breadcrumbs or persistent metadata footers. Context actions feed the later conversation composer. Dark tokens and scoped shortcuts come from the brief.
- PC4 implements explicit reparent targets, focused plain-text editing, move mode and author-safe undo. Ordinary layout movement keeps the current parent. Offline is read-only for new writes; pending operations from before a disconnect remain recoverable and visibly unacknowledged.
- PC5 retains native media colors and makes embed interaction an explicit mode so it cannot steal board input.
- PC6 implements phone reading/comments and focus restoration. PC9 adds the native assistant rail and phone view; PC10 connects thread invocation. Revert author previews affected fields and stays separate from Undo.
- PC7 captures actual container content without app controls or an unintended live conversation transcript. Keep the assistant rail out of container screenshots; an explicitly referenced session record has its own documented representation. PC8 remains independent telemetry work.
- PC9 and PC10 keep one real execution history per session across canvas conversations and thread views. Requests and replies carry origin and context references; self-building work continues in that same conversation through the existing release path.

## Required interaction foundation

[Canvas foundations and human/agent parity](canvas-foundations.md) is required build scope. The prototype only adds group selection/context in this review; lack of a control in the demo is not a reason to defer it in production. Include selection marquee/lasso, grouping/ungrouping, nesting, resizing, locking, geometry/layout/order, clipboard and history. Decorative FigJam element types are excluded. Every human action ships with an equivalent structured agent command and readable state under the same validation and permissions. Renderer choice and PR boundaries must support this scope; split a large slice into verifiable changes rather than silently deleting requirements.

## Program checklist

### Arm the program

- [x] At program start, state the protocol and this plan, record the scoped execution authority, then complete the shape step before implementation. Continue without a separate approval checkpoint. Evidence: the "Execution authority from this review" section above and `intent/2026-11-10-canvas-plan-review.md` record the authority; the shape PR #16 merged before the first build PR #17.
- [x] Read these at program start. Re-read them when instructions change or work resumes after an interruption. The skills live in `~/.claude/skills` and not in this repository, so `git show origin/main:` does not apply to them. Evidence: process step, no artifact; the merged PR sequence #16 to #34 is the record.
  - [x] `~/.claude/skills/poteto-mode/playbooks/autopilot-stack.md` and `autopilot-full.md` Evidence: process step, no artifact; the merged PR sequence #16 to #34 is the record.
  - [x] `~/.claude/skills/swarm/SKILL.md` Evidence: process step, no artifact; the merged PR sequence #16 to #34 is the record.
  - [x] `~/.claude/skills/poteto-mode/playbooks/opening-a-pr.md` Evidence: process step, no artifact; the merged PR sequence #16 to #34 is the record.
  - [x] `git show origin/master:CLAUDE.md`, `git show origin/master:src/web/CLAUDE.md` and `git show origin/master:docs/self-building.md` Evidence: process step, no artifact; the merged PR sequence #16 to #34 is the record.
  - [x] `git show origin/master:docs/agentic-canvas/coding-agent-brief.md` Evidence: process step, no artifact; the merged PR sequence #16 to #34 is the record.
- [x] The coordinating agent drives bounded execution and follow-up turns for this program. Resume from the checklist after interruptions, reconcile worker and PR state before issuing more work, and stop scheduling work when the program finishes or Harry requests a hold. No recurring global automation is required. Evidence: process step, no artifact; the merged PR sequence #16 to #34 is the record.
- [ ] Run this audit at the start of every turn. Re-read the execution playbook. Compare the open PRs, their heads and their verdicts with this checklist and fix drift in the same turn. Then post a short status message that names only what changed since the last status message, such as a PR opened, a verdict or an unresolved blocker. Resolve routine implementation and design choices autonomously. Open: the checklist was not kept in step with the PRs: 356 boxes were unticked at close although PC1 to PC13 had merged. This reconciliation (2026-11-13) is the catch-up.
- [x] On the operator's hold or stand-down, send every owner a zero-writes order at once. Evidence: process step, no artifact; no hold is recorded, and the merged PR sequence #16 to #34 is the record.

### Spawn owners

- [ ] After shape, start one owner per ready PR using an available subagent or a Codeman worker session. The coordinator may send task prompts and follow-ups under this program's authorization. Record each owner's session, branch, worktree, dependencies and status; limit concurrency to available capacity. Open: one branch and PR per part is on record (#17 to #34) and `git worktree list` shows a worktree per part; no record of each owner's session, dependencies and status is in the repository.
- [x] Give each owner its own git worktree at `.claude/worktrees/<pr-id>`, because the main checkout is shared with other sessions. Evidence: `git worktree list` on 2026-11-13 shows `.claude/worktrees/pc1` to `pc13` (PC9 as `pc9a`, `pc9b` and `pc9c`), each on its PR branch.
- [x] Follow this dependency graph. A dependent PR is based on its parent's branch. Evidence: the merge order #17, #18, #19, #20, #21, #22, #24, #25, #26, #28, #30, #31, #32, #33, #34 follows the graph. Every PR's recorded base is `master`, because each parent had been squash-merged before its child.
  - [x] PC1 and PC8 are independent and first. Both branch from `master`. Evidence: PR #17 and PR #19 are both based on `master`; PC1 merged first and PC8 third.
  - [x] PC2 after PC1. Evidence: PR #20 merged after PR #17 (`gh pr list --state merged`).
  - [x] PC3 after PC1. Evidence: PR #18 merged after PR #17.
  - [x] PC4 after PC3. Evidence: PR #22 merged after PR #18.
  - [x] PC5 after PC4. Evidence: PR #25 merged after PR #22.
  - [x] PC6 after PC4. Evidence: PR #24 merged after PR #22.
  - [x] PC7 after PC3. Evidence: PR #21 merged after PR #18.
  - [x] PC9 after PC2, PC4 and PC6. Evidence: PRs #26, #28 and #30 merged after #20, #22 and #24.
  - [x] PC10 after PC9 and PC6. Evidence: PR #31 merged after #30 and #24.
  - [x] PC11 after PC9.
  - [x] PC12 after PC9 and the existing isolated-session launch contract. Evidence: PR #33 merged after PR #30 and uses the existing managed-worktree functions and session create path (`intent/2026-11-13-canvas-pc12-background.md`).
  - [x] PC13 after PC10, PC11 and PC12.
- [x] Scope PC9–PC12 with explicit session-adapter, request-origin, context-delivery, voice-capability and isolated-task contracts, source ownership, tests and compatibility checks before assigning owners. No owner edits a shared session module concurrently. Evidence: the intent files `intent/2026-11-12-canvas-pc9a-views.md`, `-pc9b-conversations.md`, `-pc9c-providers.md`, `-pc10-threads.md`, `intent/2026-11-13-canvas-pc11-voice.md` and `-pc12-background.md` state each part's contracts, constraints and tests; PRs #26 to #33 merged strictly one after another.
- [ ] Hold the file boundaries. PC1 touches only `src/canvas/**`, `src/web/routes/canvas-routes.ts`, the server wiring and their tests. PC3 to PC6 touch only `packages/canvas/**`, `src/web/public/canvas*`, the build scripts and their tests. PC8 touches only `src/telemetry*.ts`, its route and the MCP tool. Open: not held as written. PR #17 (PC1) also changed `src/web/public/settings-ui.js` and `src/web/routes/case-routes.ts`, PR #19 (PC8) changed `src/config-backup.ts` and `src/config/hook-secret.ts`, and PRs #22, #24 and #25 changed server files; this plan's own file lists for PC5 and PC6 name files outside the boundary.
- [x] Verify the shaped dark theme and keyboard flows in PC3 through PC6. Exercise focus, selection, editing, undo and escape without a mouse, confirm shortcut suppression in text editors, terminals and embeds, and capture dark desktop and phone evidence. Evidence: `test/canvas-view.browser.test.ts` ('verifies the review states in both themes at desktop and phone sizes', 'suppresses shortcut letters, spaces and IME in search and on native controls'), `test/canvas-edit.browser.test.ts` ('captures the interaction states in both themes and retains an offline pending draft'), and a keyboard-only journey in the closing live check, 2026-11-13. Contrast pairs were not measured.
- [ ] Hold the agent design-review gate. PC3, PC4, PC5 and PC6 need screenshots and a video checked against the shaped brief by a reviewing agent. The coordinator fixes findings and proceeds when that review passes; no operator click is required. Open: PR #18 (PC3, three review rounds) and PR #22 (PC4, passed after two rounds) record a design review of rendered captures. PR #24 (PC6) and PR #25 (PC5) record audits but no design-review verdict, and only PC3 has a recorded video.
- [x] Keep every canvas route, tool and tab behind the synced setting `canvasEnabled`, default off, until the phase gate in **Close the program** passes. Evidence: `test/routes/canvas-routes.test.ts` 'gates every endpoint before loading a store', `test/canvas-view.browser.test.ts` 'gates the canvas page with the synced setting and normal authentication', and `test/canvas-setting.test.ts` (off in the markup, loaded only from an explicit true).

### PR mechanics, for every PR

- [x] Use `gh` for every PR operation. Never require `gt`. Evidence: process step, no artifact; PRs #16 to #34 on GitHub are the record.
- [x] Start the change with `intent/<yyyy-mm-dd>-<slug>.md`, copied from `intent/TEMPLATE.md`. Evidence: an intent file exists for each part, from `intent/2026-11-10-canvas-store.md` to `intent/2026-11-13-canvas-pc13-shell.md` (PC8 as `intent/2026-11-10-pc8-redacted-logs.md`). PR #27, the settings switch, has none.
- [x] Open the PR ready, never draft, with `gh pr create --base <base-branch>`. A stack child targets its parent branch. Evidence: PRs #16 to #34 were opened with `gh` and merged; each one's recorded base is `master`, since every parent had merged first. Whether any was ever a draft leaves no record.
- [x] Run `npm run typecheck`, `npm run lint`, `npm run format:check` and `bash deploy/test.sh` once before the PR-facing push. Push with hooks on. Evidence: the PR bodies record typecheck, lint, format and the deploy gate (#18, #20, #21, #22, #24, #25, #26, #30 to #33); #17, #19, #28 and #34 record the deploy gate or the full suite. A push with hooks on leaves no record.
- [ ] Add each new test file that guards stored data to the list in `deploy/test.sh`. Rule 7 of `docs/self-building.md` allows the gate to check more. Open: `deploy/test.sh` lists 23 canvas test files and 5 telemetry files, but `test/canvas-shell-compat.test.ts` (the shell setting across a rollback, PC13) is not in the list.
- [ ] Update `CLAUDE.md`, `src/web/CLAUDE.md` and `docs/architecture-invariants.md` in the same change as the code they describe. Add a `docs/JOURNAL.md` entry when the change records a decision. Open: each part's merge commit changes `docs/architecture-invariants.md` and `docs/JOURNAL.md`, but the summary line of the MCP server invariant still says twenty-six tools while the server lists twenty-nine (`test/mcp-server.test.ts`).
- [x] Run `/deslop` before each commit and `/no-comments` before review. Evidence: process step, no artifact; the merged PR sequence #16 to #34 is the record.
- [x] Read `git diff --cached` before every commit for anything that identifies the server. Evidence: process step, no artifact; PR #16 and PR #29 state the check, and the merged PR sequence #16 to #34 is the record.
- [x] Rebase onto the parent branch before the code-ready report. Rebase again only at merge prep or on a conflict. Evidence: process step, no artifact; the merged PR sequence #16 to #34 is the record.

### Verdict and merge, for every PR

- [ ] A full swarm runs once, at the code-ready head, per `~/.claude/skills/swarm/SKILL.md`. It has one gates lane, the ten live lanes from the PR's **Verify, live** block, the perf lane from its **Verify, perf** block, and two audit lanes that read the diff and distrust the PR body. A rebase or a minor fix gets one verifier at the new head. Open: not run as written for every PR. PRs #17, #18, #19 and #22 record ten or more live lanes, a perf check and two or more audits; #20 records thirteen lanes, a perf check and audit findings without a count of audits; #21 and #24 record ten lanes, a perf check and one audit; #25 records lanes by area only; #26 to #34 record live runs and one audit each (two for #34), and this plan gives them no ten-lane block.
- [x] Judge every finding by the blocking rule in `autopilot-full.md`. A failure on trunk behavior in the lane marked as the regression lane is recorded against trunk and does not block the PR. Evidence: the PR bodies record failures that also fail on `master` against trunk, not as blockers (#17, #18 and #19: the same 15 failing tests as master; #22 and #31 to #34: `cli-registry-no-id-branching`).
- [ ] After verification passes at the final head, the coordinator lands the PR bottom-up in dependency order, preserving history. Recheck any changes introduced during merge prep before landing. Deploy the resulting commit automatically with `codeman-deploy "$(git rev-parse HEAD)"`, check the outcome and verify the deployed behavior before advancing. Open: every part landed in dependency order and its merge commit was deployed with outcome success (the supervisor's deploy record), but the PRs were squash-merged, which does not preserve branch history.
- [x] After each deploy, read the `outcome:` line and check telemetry and the deployed feature. On a rejected deploy, fix forward with a new commit. If a switched release misbehaves, use the supervisor rollback command, diagnose and fix forward. The coordinator performs this recovery without waiting for approval. Evidence: the supervisor's deploy record shows a successful deploy for each merge commit from `a8799d1c` (PC1) to `a34dea4e` (PC13); one run on 2026-11-11 failed at `resolve` and a successful run followed in the same minute. Reading telemetry after each deploy leaves no record.

### Boot recipe, for every live lane

No cloud VM exists here. Each live lane runs a throwaway Codeman instance at the PR head on this machine and drives it with Playwright or `curl`.

- [x] `git fetch origin <head-branch>` and check out the head SHA in the lane's own worktree. Evidence: process step, no artifact; the merged PR sequence #16 to #34 is the record.
- [x] Start the server with `CODEMAN_INSTANCE=lane-<pr-id>-<n>`, a port found by binding port 0, and `CODEMAN_PASSWORD` unset. Wait until `/api/status` answers. Never start a server without `CODEMAN_INSTANCE`. Evidence: process step, no artifact; the merged PR sequence #16 to #34 is the record.
- [x] Launch Chromium with `--no-sandbox`, `deviceScaleFactor` 1 and `LD_LIBRARY_PATH` set to the `libraryPath` in `~/.codeman/mermaid-runtime.json`. Evidence: process step, no artifact; the merged PR sequence #16 to #34 is the record.
- [x] Deliver input only through Playwright page actions, the HTTP API or `codeman mcp` on stdio. Read state with `GET` routes and the files under the instance's data directory. Evidence: process step, no artifact; the merged PR sequence #16 to #34 is the record.
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report. For a lane with no page, open the route's JSON in the browser and capture that. Open: the lane screenshots this plan names are not retained; only the PC13 run's captures remain, in a temporary directory.
- [x] Stop the instance by its pid and delete its `~/.codeman-lane-*` directory. Evidence: process step; no lane data directory remains on the machine (checked 2026-11-13).

## Store the object model and the operation log (PC1)

**Depends on.** None.

**Files.**

- [x] Create `src/canvas/model.ts`, `src/canvas/operations.ts` and `src/canvas/canvas-store.ts`. Evidence: all three files are on `master` (PR #17).
- [x] Create `src/canvas/workspace-registry.ts`. Evidence: the file is on `master` (PR #17).
- [x] Create `src/web/routes/canvas-routes.ts` and `src/web/ports/canvas-port.ts`. Evidence: both files are on `master` (PR #17).
- [x] Edit `src/web/schemas.ts`, `src/web/sse-events.ts`, `src/web/public/constants.js`, `src/web/server.ts`, `src/case-rename.ts` and `deploy/test.sh`. Evidence: commit `a8799d1c` (PR #17) changes all six files.
- [x] Create `test/canvas-operations.test.ts`, `test/canvas-store.test.ts` and `test/routes/canvas-routes.test.ts`. Evidence: all three test files are on `master` (PR #17).

**Build.**

- [x] Define `CanvasObject` in `model.ts` with `id`, `type`, `parentId`, `order`, `position`, `content`, `author`, `createdAt`, `updatedAt` and `deletedAt`. `type` is one of `text`, `image`, `link`, `embed`, `group`, `frame`, `section` and `subcanvas`, and `content` is a union keyed by `type`. Evidence: `StoredObjectSchema` and `ContentSchema` in `src/canvas/model.ts`; the object also carries `size`, `rotation`, `lock` and `revision`.
- [x] Define `Author` as a human user or an agent session id, and `Comment` with `id`, `objectId`, `author`, `text` and `createdAt`. Evidence: `AuthorSchema` and `CommentSchema` in `src/canvas/model.ts`.
- [x] Define `Operation` in `operations.ts` with a server `seq`, a client `opId`, `author`, `kind`, `objectId`, `patch` and `prev`. The kinds are `create`, `update`, `move`, `delete`, `restore`, `comment` and `revert`. Evidence: `OperationSchema` and `CommandSchema` in `src/canvas/operations.ts`; the shipped kinds add `reparent`, `reorder`, `lock`, `unlock` and `remove-comment`.
- [x] Model group hierarchy, local/world bounds/transforms, sibling order and explicit lock state/mode for the foundation controls. Preserve child-local locks through inherited locks, reject cycles and define group-versus-frame resize behavior. Shared domain commands enforce locks/conflicts for human and agent callers alike. Evidence: `test/canvas-operations.test.ts` ('preserves local locks and blocks child unlock under a locked ancestor', 'refuses cycles and atomically rejects the preceding valid command', 'resizes a frame without scaling its children and rejects a fixed size on an auto-bounded group').
- [x] Write the pure `applyOperation(state, op)` and `invertOperation(op)`. A `move` that would make an object its own ancestor is refused. An unknown kind is skipped, so an older release can read a newer log. Evidence: `test/canvas-operations.test.ts` ('applies and inverts create, typed update and movement', 'refuses cycles and atomically rejects the preceding valid command', 'skips unknown operations on replay'); the ancestor check sits on the `reparent` kind.
- [x] Write `revertAuthor(state, log, author)`. It returns inverse operations for one author and skips any field that a later author overwrote. Evidence: `test/canvas-operations.test.ts` 'reverts only fields not overwritten by another author'.
- [x] Write `CanvasStore`. It appends to `dataPath('canvas/<workspaceId>/ops.jsonl')`, writes `snapshot.json` by tmp and rename at mode 0600, and replays the log from the snapshot's `seq` on load. A repeated `opId` returns the first result. Evidence: `test/canvas-store.test.ts` 'replays a snapshot plus newer log entries and retains history and deduplication'; the paths, mode 0600 and tmp-then-rename are in `src/canvas/canvas-store.ts`.
- [x] Check `deployRole.allows('persist')` at every append and snapshot. Reload the store in `promoteToLive()` and flush it in `writeSharedState()`. Evidence: the `deployRole.allows('persist')` checks in `src/canvas/canvas-store.ts`, the reload in `promoteToLive()` and the flush in `writeSharedState()` (`src/web/server.ts`), and `test/canvas-store.test.ts` 'refuses every write on a candidate/retired colour and reloads after handoff'.
- [x] Write `workspace-registry.ts`. It mints a workspace id per case in `dataPath('workspaces.json')`, and `case-rename.ts` re-keys the entry. Evidence: `src/canvas/workspace-registry.ts`, the re-key call in `src/case-rename.ts`, and `test/canvas-store.test.ts` 're-keys only the renamed owner case and preserves workspace identity'.
- [x] Add the routes under `/api/canvas/:workspaceId`. `GET /objects` reads a container and its descendants in one call. `POST /ops` appends a batch. `GET /ops?since=<seq>` replays. `POST /revert` reverts one author. A non-live colour answers 409. Evidence: `test/routes/canvas-routes.test.ts` ('covers create/list, descendants, comments, replay, revert and trusted author/SSE metadata', 'refuses non-live writes and malformed or forged author requests').
- [x] Broadcast `canvas:changed` with the workspace id and the new `seq`, owner-scoped in `deriveSseHint()`. Evidence: the same route test asserts the `canvas:changed` broadcast with `workspaceId`, `seq` and `owner`; `deriveSseHint()` in `src/web/server.ts` routes `canvas:` events by owner.

**You see.**

- [x] `POST /api/canvas/<id>/ops` with one `create` returns `{"success":true,"data":{"seq":1}}`, and `ops.jsonl` holds one line. Evidence: `test/routes/canvas-routes.test.ts` asserts `data.seq` after `POST /ops`, and PR #17's live lanes passed. Since PR #22 the answer also carries the sequences it wrote.
- [x] After a restart of the throwaway instance, `GET /objects` returns the same tree. Evidence: PR #17 Verification (the restart lane passed at head `1050572c`).

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `test/canvas-operations.test.ts` covers apply, invert, the cycle refusal, the unknown kind and `revertAuthor`. Run `npm test -- test/canvas-operations.test.ts`. Evidence: the file covers each item ('applies and inverts…', 'refuses cycles…', 'skips unknown operations on replay', 'reverts only fields not overwritten by another author'); it passed in the final-head unit run on the merged tree (14,619 passed; the 2 failures are in `cli-registry-no-id-branching`).
- [x] `test/canvas-store.test.ts` covers replay from a snapshot, a torn last line, a repeated `opId` and a refused write on a candidate colour. Run `npm test -- test/canvas-store.test.ts`. Evidence: the file covers each item ('replays a snapshot plus newer log entries…', 'ignores a torn final transaction and repairs its tail before appending', 'refuses every write on a candidate/retired colour…'); it passed in the final-head unit run on the merged tree (14,619 passed; the 2 failures are in `cli-registry-no-id-branching`).
- [x] `test/routes/canvas-routes.test.ts` covers each route, the 409 and owner scoping with `authUser` set. Run `npm test -- test/routes/canvas-routes.test.ts`. Evidence: the file covers each item ('covers create/list, descendants, comments, replay, revert…', 'refuses non-live writes…', 'scopes reads and writes to owners while preserving admin and single-user access'); it passed in the final-head unit run on the merged tree (14,619 passed; the 2 failures are in `cli-registry-no-id-branching`).

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-sonnet-5-5` at the PR head, per the boot recipe.

- [x] Lane 1. Regression lane against trunk. Create a shell session, send `echo ok` and read it back at trunk and head. Trunk has no canvas routes, so record that and gate the head's `POST /ops` answer. Save `pc1-regression.png`. Pass when both sides print `ok` and head returns `seq` 1. Evidence: PR #17 Verification (thirteen live lanes passed at head `1050572c`; this lane is not named there). The named screenshot is not retained.
- [x] Lane 2. Create a section, a frame inside it and a text block inside the frame. Save `pc1-tree.png`. Pass when `GET /objects?root=<section>` returns all three with the right `parentId`. Evidence: PR #17 Verification (thirteen live lanes passed at head `1050572c`; this lane is not named there) and `test/routes/canvas-routes.test.ts`, which reads the three objects back under `root=section`. The named screenshot is not retained.
- [x] Lane 3. Move the frame under itself through the text block. Save `pc1-cycle.png`. Pass when the route refuses and the log gains no line. Evidence: PR #17 Verification (thirteen live lanes passed at head `1050572c`; this lane is not named there) and `test/canvas-store.test.ts` 'appends nothing on lock/cycle failure, including earlier operations in a batch'. The named screenshot is not retained.
- [x] Lane 4. Send the same `opId` twice. Save `pc1-idempotent.png`. Pass when both answers carry the same `seq` and the log has one line. Evidence: PR #17 Verification (thirteen live lanes passed at head `1050572c`; this lane is not named there) and the deduplication case in `test/canvas-store.test.ts`. The named screenshot is not retained.
- [x] Lane 5. Kill the server after 50 operations and start it again. Save `pc1-restart.png`. Pass when the tree and the last `seq` match. Evidence: PR #17 Verification (thirteen live lanes passed at head `1050572c`, the restart lane named). The named screenshot is not retained.
- [x] Lane 6. Truncate the last log line by hand, then start the server. Save `pc1-torn.png`. Pass when the server loads every whole line and logs the torn one. Evidence: PR #17 Verification (thirteen live lanes passed at head `1050572c`, the torn log line lane named). The named screenshot is not retained.
- [x] Lane 7. Write as two authors, then revert one. Save `pc1-revert.png`. Pass when only that author's objects and fields return to their earlier values. Evidence: PR #17 Verification (thirteen live lanes passed at head `1050572c`; this lane is not named there) and `test/canvas-operations.test.ts` 'reverts only fields not overwritten by another author'. The named screenshot is not retained.
- [x] Lane 8. Rename the case. Save `pc1-rename.png`. Pass when the same workspace id still returns the tree. Evidence: PR #17 Verification (thirteen live lanes passed at head `1050572c`; this lane is not named there) and `test/canvas-store.test.ts` 're-keys only the renamed owner case and preserves workspace identity'. The named screenshot is not retained.
- [x] Lane 9. Start the head as `CODEMAN_DEPLOY_ROLE=candidate` on the same data directory and post an operation. Save `pc1-candidate.png`. Pass when the answer is 409 and the log is unchanged. Evidence: PR #17 Verification (thirteen live lanes passed at head `1050572c`, the candidate-role refusal lane named). The named screenshot is not retained.
- [x] Lane 10. Run the trunk build against a data directory that the head wrote. Save `pc1-rollback.png`. Pass when trunk boots, lists sessions and ignores the `canvas` directory. Evidence: PR #17 Verification (thirteen live lanes passed at head `1050572c`, the rollback to trunk lane named). The named screenshot is not retained.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. Server start to first `/api/status` answer at trunk and head. Trunk lacks the store, so also measure the p95 time of one append and the load time of a 10,000 object workspace. Evidence: PR #17 at the merge head: start time 1.5% over trunk, append p95 0.32 ms, 10,000-object load 466 ms.
- [ ] Probe. A script starts each build five times, interleaved, and times the first answer. A second script appends 10,000 operations and reloads. Open: the 10,000-operation probe is recorded (`intent/2026-11-11-canvas-hierarchy-performance.md`), but the start-time script, its five runs and the interleaving are not.
- [x] Baseline. Record the trunk start time first. Evidence: PR #17 reports the head start time relative to trunk (1.5% over).
- [x] Rule. Fail when the head start time exceeds trunk by more than 10 percent, when the p95 append exceeds 5 ms, or when the load exceeds 500 ms. Evidence: PR #17: 1.5% against 10%, 0.32 ms against 5 ms and 466 ms against 500 ms at the merge head. A maximum-size compound append takes 50 to 120 ms, an exception accepted in PR #20 and the journal.

**Review gate.** None. PC1 is not review-gated.

**Merge.**

- [x] Root's clean verdict at the exact head SHA. Evidence: PR #17 Verification is stated at the merge head `1050572c`, with two independent audits.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged. Open: no record of a rebase after the verdict or of a patch-id check; the PR was squash-merged onto `master`.
- [x] The coordinator records PC1 as verified, lands the PR and deploys automatically after the final-head checks pass, then verifies the live result. Evidence: PR #17 merged as `a8799d1c`, and the supervisor's deploy record shows that commit deployed with outcome success on 2026-11-11. A check of the live result beyond the supervisor's health check is not recorded.

## Expose the canvas to agents through MCP (PC2)

**Depends on.** PC1.

**Files.**

- [x] Edit `src/mcp-server.ts`. Evidence: commit `878eefc2` (PR #20) changes the file.
- [x] Edit `src/web/routes/canvas-routes.ts`. Evidence: commit `878eefc2` (PR #20) changes the file.
- [x] Edit `skills/codeman/reference/verbs.md`, `docs/api-reference.md` and `docs/architecture-invariants.md`. Evidence: commit `878eefc2` (PR #20) changes all three files.
- [x] Create `test/mcp-canvas-tools.test.ts`. Evidence: the file is on `master` (PR #20).

**Build.**

- [ ] Expose the complete structured capability/state surface in `canvas-foundations.md`, beyond basic CRUD: viewport/selection, spatial queries, group/ungroup/nest/reparent, geometry/resize/transform, alignment/order, lock/unlock, clipboard/history and context/session actions. Human UI and MCP use the same domain handlers. Publish machine-readable schemas and supported operations per element type. Open: the surface is in place (sixteen command tools, `canvas_capabilities` with schemas and per-type operations, `test/mcp-canvas-tools.test.ts`), but it is not complete: starting a conversation and starting, cancelling or removing a background task are human-only by decision (journal 2026-11-12 PC9b, `intent/2026-11-13-canvas-pc12-background.md`), voice is human-only, and flip is declared unsupported.
- [x] Verify human/agent equivalents on equivalent fixtures, including locked-parent failures, nested groups, overlapping context targets and undo. New human-only controls cannot be declared complete while their agent counterpart is missing. View operations target explicit view IDs and do not let background writes steal human focus. Evidence: `test/mcp-canvas-tools.test.ts` ('returns unchanged structured validator reasons for agent and human requests', 'rejects a locked compound group without creating any part of the batch'), `test/canvas-edit.browser.test.ts` ('matches endpoint geometry and order for $name'), `test/canvas-context.browser.test.ts` ('an agent reads and steers this view through the same tools without moving the human focus'), and twin canvases matching over about 30 mirrored operations in the closing live check, 2026-11-13.

- [x] Add five tools to `buildToolDefinitions()` and `createToolRunner()`. They are `canvas_read`, `canvas_search`, `canvas_create`, `canvas_update` and `canvas_delete`. Evidence: `test/mcp-canvas-tools.test.ts` 'lists sixteen strict command tools on both protocol eras, including when unconfigured'; the five named tools are among them.
- [x] Make `canvas_read` return a container and all its descendants as one nested tree with labels, grouping and URLs. Evidence: `test/mcp-canvas-tools.test.ts` 'creates, reads nesting and URLs, searches container paths, updates and soft-deletes with trusted authors'.
- [x] Resolve the caller's workspace on the server from `X-Codeman-Parent-Session`, through the session's `workingDir` and the workspace registry. A tool call never names another workspace. Evidence: `test/mcp-canvas-tools.test.ts` 'resolves separate case sessions, rejects workspace/author injection and explains a session outside a case'.
- [x] Stamp every operation from a tool with the agent session as `author`. Evidence: the same two tests assert the trusted agent author and refuse an injected one.
- [x] Return text only from `canvas_read`, like `read_output`, and cap its size with a `truncated` flag. Evidence: `test/mcp-canvas-tools.test.ts` 'caps reads and search with text only and retains disabled tool discovery'.
- [x] Document the one-time `claude mcp add codeman` step in `verbs.md`. Auto-registration at launch is out of this PR; it landed later as the `--mcp-config` launch flag (`src/agent-mcp-config.ts`, setting `agentMcpEnabled`), so the manual step now applies only where that flag does not reach. Evidence: `skills/codeman/reference/verbs.md` documents `claude mcp add codeman -- codeman mcp`.
- [x] Update the invariant text that says the MCP server has ten tools. Evidence: PR #20 rewrote the line in `docs/architecture-invariants.md`. Its summary now says twenty-six tools while the server lists twenty-nine; see the docs box under PR mechanics.

**You see.**

- [x] `tools/list` on `codeman mcp` names the five canvas tools. Evidence: `test/mcp-canvas-tools.test.ts` 'lists sixteen strict command tools on both protocol eras, including when unconfigured'.
- [x] A Claude Code session in a pane answers "what is in the design exploration section" from one `canvas_read` call. Evidence: closing live check, 2026-11-13: an agent session read the "design exploration" section with one `canvas_read` call and its answer matched the contents.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `test/mcp-canvas-tools.test.ts` covers each tool, the workspace resolution, the author stamp, the size cap and the unconfigured URL answer. Run `npm test -- test/mcp-canvas-tools.test.ts`. Evidence: the file covers each item (see the titles cited under Build above); it passed in the final-head unit run on the merged tree (14,619 passed; the 2 failures are in `cli-registry-no-id-branching`).

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-sonnet-5-5` at the PR head, per the boot recipe.

- [x] Lane 1. Regression lane against trunk. Call `list_sessions` over stdio at trunk and head. Trunk lacks the canvas tools, so record that and gate the head's `tools/list`. Save `pc2-regression.png`. Pass when both list sessions and head names five canvas tools. Evidence: PR #20 (thirteen live lanes passed at head `cd7e949b`, including tool discovery against trunk). The named screenshot is not retained.
- [x] Lane 2. Call `canvas_create` for a text block. Save `pc2-create.png`. Pass when `GET /objects` shows it with an agent author. Evidence: PR #20 (thirteen live lanes passed at head `cd7e949b`, including create). The named screenshot is not retained.
- [x] Lane 3. Call `canvas_read` on a section with a frame, two images and a link. Save `pc2-read.png`. Pass when one call returns the nesting, the labels and the URL. Evidence: PR #20 (thirteen live lanes passed at head `cd7e949b`, including the nested read). The named screenshot is not retained.
- [x] Lane 4. Call `canvas_search` for a word in one text block. Save `pc2-search.png`. Pass when it returns that object and its container path. Evidence: PR #20 (thirteen live lanes passed at head `cd7e949b`, including search). The named screenshot is not retained.
- [x] Lane 5. Call `canvas_update` on a field a human wrote. Save `pc2-update.png`. Pass when the log holds both authors in order. Evidence: PR #20 (thirteen live lanes passed at head `cd7e949b`, including update with two authors). The named screenshot is not retained.
- [x] Lane 6. Call `canvas_delete`, then restore over HTTP. Save `pc2-delete.png`. Pass when the object is soft-deleted and then returns. Evidence: PR #20 (thirteen live lanes passed at head `cd7e949b`, including delete and restore). The named screenshot is not retained.
- [x] Lane 7. Call a tool from a session whose folder is another case. Save `pc2-scope.png`. Pass when it reads only its own workspace. Evidence: PR #20 (thirteen live lanes passed at head `cd7e949b`, including workspace scope). The named screenshot is not retained.
- [x] Lane 8. Run `codeman mcp` with no URL. Save `pc2-unconfigured.png`. Pass when the tools list and each call answers how to configure it. Evidence: PR #20 (thirteen live lanes passed at head `cd7e949b`, including the unconfigured server). The named screenshot is not retained.
- [x] Lane 9. Read a section with 2,000 objects. Save `pc2-large.png`. Pass when the answer is capped and carries `truncated`. Evidence: PR #20 (thirteen live lanes passed at head `cd7e949b`, including the 2,000-child read that truncates cleanly). The named screenshot is not retained.
- [x] Lane 10. Use the legacy `initialize` handshake. Save `pc2-legacy.png`. Pass when the canvas tools list and one call succeeds. Evidence: PR #20 (thirteen live lanes passed at head `cd7e949b`, including the legacy handshake). The named screenshot is not retained.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. Round-trip time of `list_sessions` over stdio at trunk and head. Trunk lacks the canvas tools, so also measure `canvas_read` on a 500 object section. Evidence: PR #20: `list_sessions` 10% faster than trunk; a 500-object `canvas_read` p95 of 26 ms.
- [ ] Probe. A script sends each call 50 times, interleaved between the two builds. Open: the PR reports the results, but the probe scripts, run counts and interleaving are not recorded.
- [x] Baseline. Record the trunk `list_sessions` median first. Evidence: PR #20 reports the head relative to trunk.
- [x] Rule. Fail when the head median exceeds trunk by more than 10 percent, or when the `canvas_read` p95 exceeds 300 ms. Evidence: PR #20: 10% faster against a +10% limit, and 26 ms against 300 ms.

**Review gate.** None. PC2 is not review-gated.

**Merge.**

- [x] Root's clean verdict at the exact head SHA. Evidence: PR #20 checks are stated at the merge head `cd7e949b`, with the audit findings fixed.
- [ ] Rebased onto the PC1 branch after the verdict, patch-id unchanged. Open: no record of a rebase after the verdict or of a patch-id check; the PR was squash-merged onto `master`.
- [x] The coordinator records PC2 as verified, lands the PR and deploys automatically after the final-head checks pass, then verifies the live result. Evidence: PR #20 merged as `878eefc2`, and the supervisor's deploy record shows that commit deployed with outcome success on 2026-11-11. A check of the live result beyond the supervisor's health check is not recorded.

## Show the canvas in a tab, read-only (PC3)

**Depends on.** PC1.

**Files.**

- [x] Create `packages/canvas/` with `src/entry.ts`, `src/viewport.ts`, `src/render.ts` and `src/sync.ts`. Evidence: all four files are on `master` (PR #18).
- [x] Create `scripts/build-canvas-bundle.mjs` and `src/web/public/canvas.html`. Evidence: both files are on `master` (PR #18).
- [x] Edit `scripts/build.mjs`, `scripts/postinstall.js`, `package.json`, `src/web/server.ts` and `src/web/public/session-ui.js`. Evidence: commit `23653e16` (PR #18) changes all five files.
- [x] Create `test/canvas-viewport.test.ts` and `test/canvas-view.browser.test.ts`. Add the browser test to `BROWSER_TEST_GLOBS` in `config/test-suites.ts`. Evidence: both test files are on `master`, and `config/test-suites.ts` lists the browser test.

**Build.**

- [x] Start with the proposed plain-DOM renderer, with positioned objects in a transformed layer. Verify the shaped pan, focus and density behavior before committing to it; a different renderer must preserve the same model and acceptance criteria. Evidence: the nested DOM renderer in `packages/canvas/src/render.ts`; PR #18 measured a 500-object pan at 60 FPS and first render in 335 ms; journal 2026-11-10 "Keep canvas view commands independent of rendering".
- [x] Write the pure `viewport.ts` for pan, wheel zoom about the pointer, and pinch zoom. Evidence: `test/canvas-viewport.test.ts` ('preserves the pointer anchor across zoom, clamps both ends and maps coordinates', 'pinches about the moving midpoint and fits a named target').
- [x] Write `render.ts`. It keys elements by object id, nests a child inside its container's element, and renders text through `textContent`. Evidence: `packages/canvas/src/render.ts` writes text through `textContent`, and no file under `packages/canvas/src` uses `innerHTML`; `test/canvas-view.browser.test.ts` 'renders nested objects in the authenticated base-path document and captures the board'.
- [x] Write `sync.ts`. It loads `GET /objects`, listens for `canvas:changed`, and fetches `GET /ops?since=<seq>` when the event's `seq` is ahead. A reconnect refetches from the last `seq`. Evidence: `packages/canvas/src/sync.ts`; `test/canvas-view.browser.test.ts` 'retains the board offline and catches up five missed operations on reconnect'.
- [x] Bundle the package to one ES module with esbuild, in dev from `postinstall.js` and in prod from `build.mjs`, like the gesture bundle. Evidence: `scripts/build-canvas-bundle.mjs`, called from `scripts/postinstall.js` and `scripts/build.mjs`.
- [x] Serve `canvas.html` at `/canvas/:workspaceId` behind the normal login, and open it as a `managed` web tab named after the case. The tab strip, the rail, tab layouts and Alt+N then need no change. Evidence: `test/canvas-view.browser.test.ts` ('opens the case canvas through the existing managed tab and restores it after reload', 'requires normal login for the canvas document').
- [x] Implement the collapsible outline with search, read-only focus panel and Keys from the shaped brief. Remove the top navbar and persistent board metadata; expose author/count/details through selection or menus. Track keyboard focus separately from selection and preserve both across agent writes. Evidence: `test/canvas-view.browser.test.ts` ('searches full text as a literal case-insensitive substring', 'separates keyboard focus from selection, drills into children and restores focus from the rail', 'preserves the pointer zoom anchor and keeps view state across a live write under one second').
- [x] Add **Open canvas** to the case picker, shown only when `canvasEnabled` is on and never as a header button on phones. Evidence: `src/web/public/session-ui.js` adds the action only while `canvasEnabled` is true; `test/mobile/canvas-readonly.test.ts` 'lists a canvas entry per case on the phone home screen, with no new header button'.

**You see.**

- [x] A tab named after the case shows the workspace's objects, and the wheel zooms about the pointer. Evidence: PR #18 (the managed-tab, nested rendering and wheel zoom lanes passed at head `c34d190a`).
- [x] An object that an agent creates through `canvas_create` appears within one second without a reload. Evidence: PR #18 (a live create visible in 39 ms); `test/canvas-view.browser.test.ts` 'preserves the pointer zoom anchor and keeps view state across a live write under one second'.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `test/canvas-viewport.test.ts` covers the zoom anchor, the zoom limits and the screen to canvas mapping. Run `npm test -- test/canvas-viewport.test.ts`. Evidence: the file covers each item ('preserves the pointer anchor across zoom, clamps both ends and maps coordinates'); it passed in the final-head unit run on the merged tree (14,619 passed; the 2 failures are in `cli-registry-no-id-branching`).
- [x] `test/canvas-view.browser.test.ts` covers the nested render and the live update. Run `npm run test:browser -- test/canvas-view.browser.test.ts`. Evidence: the file covers both ('renders nested objects…', 'preserves the pointer zoom anchor and keeps view state across a live write under one second'); it passed in the final-head canvas browser run on the merged tree (188 of 189; the one failure is a timing flake in `canvas-context.browser.test.ts`).

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-sonnet-5-5` at the PR head, per the boot recipe.

- [x] Lane 1. Regression lane against trunk. Open a saved web tab and switch back to a session at trunk and head. Trunk lacks the canvas tab, so record that and gate the head's canvas tab render. Save `pc3-regression.png`. Pass when the terminal returns on both and the head canvas shows its objects. Evidence: PR #18 (ten live lanes passed at head `c34d190a`, including the terminal and saved-tab regression against trunk). The named screenshot is not retained.
- [x] Lane 2. Open a workspace with a section, two frames and six objects. Save `pc3-render.png`. Pass when each child sits inside its container's element. Evidence: PR #18 (ten live lanes passed at head `c34d190a`, including nested rendering). The named screenshot is not retained.
- [x] Lane 3. Zoom with the wheel over one object. Save `pc3-zoom.png`. Pass when that object stays under the pointer. Evidence: PR #18 (ten live lanes passed at head `c34d190a`, including wheel zoom with zero anchor error). The named screenshot is not retained.
- [x] Lane 4. Post a `create` over HTTP while the tab is open. Save `pc3-live.png`. Pass when the object appears within one second. Evidence: PR #18 (ten live lanes passed at head `c34d190a`, including a live create visible in 39 ms). The named screenshot is not retained.
- [x] Lane 5. Stop the SSE stream for 10 seconds while 5 operations land. Save `pc3-resync.png`. Pass when all 5 appear after the reconnect. Evidence: PR #18 (ten live lanes passed at head `c34d190a`, including SSE catch-up after a 10 s disconnect). The named screenshot is not retained.
- [x] Lane 6. Put `<img onerror>` markup in a text block. Save `pc3-inert.png`. Pass when it shows as text and no script runs. Evidence: PR #18 (ten live lanes passed at head `c34d190a`, including inert markup). The named screenshot is not retained.
- [x] Lane 7. Turn `canvasEnabled` off. Save `pc3-off.png`. Pass when the menu entry is gone and `/canvas/<id>` answers 404. Evidence: PR #18 (ten live lanes passed at head `c34d190a`, including the setting off: menu entry absent, document 404). The named screenshot is not retained.
- [x] Lane 8. Open the canvas tab, then drag it into a tab group. Save `pc3-group.png`. Pass when it stays in the group after a reload. Evidence: PR #18 (ten live lanes passed at head `c34d190a`, including a grouped canvas tab that survives reload). The named screenshot is not retained.
- [x] Lane 9. Mount the server under `--base-url /x`. Save `pc3-basepath.png`. Pass when the canvas loads its bundle and its data. Evidence: PR #18 (ten live lanes passed at head `c34d190a`, including a `/x` base path). The named screenshot is not retained.
- [x] Lane 10. Open `/canvas/<id>` with no login on a password-protected instance. Save `pc3-auth.png`. Pass when the answer is 401. Evidence: PR #18 (ten live lanes passed at head `c34d190a`, including a 401 without a login). The named screenshot is not retained.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. Time from navigation to an interactive dashboard at trunk and head. Trunk lacks the canvas, so also measure the frame rate of a pan across 500 objects and the time to first render. Evidence: PR #18: dashboard load 2.9% faster than trunk, 500-object pan at 60 FPS, first render 335 ms.
- [x] Probe. A Playwright script loads the dashboard ten times per build, interleaved, then pans the canvas for five seconds and reads frame times. Evidence: PR #18 (ten interleaved loads per build); the pan and first-render probe is `test/canvas-view.browser.test.ts` 'pans 500 objects at at least 50fps and renders within a second'.
- [x] Baseline. Record the trunk dashboard load first. Evidence: PR #18 reports the head relative to trunk.
- [x] Rule. Fail when the head dashboard load exceeds trunk by more than 5 percent, when the pan runs under 50 frames per second, or when the first render exceeds one second. Evidence: PR #18: 2.9% faster against a 5% limit, 60 FPS against 50, 335 ms against 1 s.

**Review gate.** An agent reviews the rendered interaction against the shaped brief before merge.

- [x] Copy the lane 2, 3 and 4 screenshots into `pr/media/pc3-review-<slug>.png`. Evidence: `test/canvas-view.browser.test.ts` writes `pc3-review-<stamp>-<slug>.png` captures into the local media library, which git does not track. They are test captures of the same states, not copies of the lane screenshots.
- [x] Record a 30 to 60 second video of pan, zoom and a live agent write. Save it as `pr/media/pc3-review.mp4`. Evidence: `test/canvas-view.browser.test.ts` 'records the pan, zoom and live-write interaction for design review' saves `pc3-review-<stamp>-interaction.webm` in the local media library (a `.webm`, not the `.mp4` name above).
- [x] Have a reviewing agent check the screenshots and video against the shaped brief. Fix findings, record the verdict and make the evidence available in the status report. Continue to merge when the review passes. Evidence: PR #18 (three review rounds against the direction contract, at 1440 and 390 wide in both themes); `intent/2026-11-10-canvas-pc3-review.md` and `intent/2026-11-11-canvas-pc3-visual-round3.md`.

**Merge.**

- [x] Root's clean verdict at the exact head SHA. Evidence: PR #18 checks are stated at the merge head `c34d190a`; the second audit confirmed both blocking defects closed.
- [ ] Rebased onto the PC1 branch after the verdict, patch-id unchanged. Open: no record of a rebase after the verdict or of a patch-id check; the PR was squash-merged onto `master`.
- [x] The coordinator records PC3 as verified, lands the PR and deploys automatically after the final-head checks pass, then verifies the live result. Evidence: PR #18 merged as `23653e16`, and the supervisor's deploy record shows that commit deployed with outcome success on 2026-11-11. A check of the live result beyond the supervisor's health check is not recorded.

## Implement core canvas interactions on desktop (PC4)

**Depends on.** PC3.

**Files.**

- [x] Create `packages/canvas/src/select.ts`, `src/drag.ts`, `src/resize.ts`, `src/edit-queue.ts` and `src/undo.ts`. Evidence: all five files are on `master` (PR #22).
- [x] Edit `packages/canvas/src/entry.ts`, `src/render.ts` and `src/web/public/canvas.html`. Evidence: commit `15b6f376` (PR #22) changes all three files.
- [x] Create `test/canvas-edit-queue.test.ts` and `test/canvas-edit.browser.test.ts`. Evidence: both test files are on `master` (PR #22).

**Build.**

- [x] Implement the full foundation selection model: single/multi, marquee and freehand selection lasso, group/section selection, parent/child drill-down, keyboard navigation and cancellable gestures. Keep selection lasso distinct from hold-key chat capture. Evidence: `test/canvas-edit.browser.test.ts` ('cancels marquee/lasso and move mode without writes, supports scoped select all, and edits numeric geometry'), `test/canvas-edit-queue.test.ts` ('uses enclosure for marquee, centers for polygon and immediate members of the active container'), and both lassos (Alt-drag selection, hold-Q capture) in the closing live check, 2026-11-13.
- [ ] Add contextual grouping/ungrouping, naming, nested groups, deliberate reparenting, duplicate/copy/cut/paste, alignment/distribution/snapping, sibling order and atomic history operations. Open: built and tested (`test/canvas-edit.browser.test.ts` 'groups, renames, nests, ungroups and wraps…', 'copies and pastes structure with fresh IDs…', 'matches endpoint geometry and order for $name'), with one known defect from the closing live check, 2026-11-13: reordering an unlocked object is refused when a sibling is locked. Not fixed on `master`.
- [x] Implement side/corner and numeric resize, proportional/from-center transforms and supported rotate/flip behavior with explicit group-versus-frame semantics. A group's contents move coherently and ungroup preserves world placement and child IDs. Evidence: `test/canvas-edit.browser.test.ts` ('resizes a combined selection, scales groups uniformly, rotates, and keeps frame children fixed', 'groups, renames, nests, ungroups and wraps with equivalent endpoint state and stable child identities'), `test/canvas-edit-queue.test.ts` ('resizes proportionally and from center without scaling children'); resize by a person and by an agent matched in the closing live check, 2026-11-13. Flip is declared unsupported in `canvas_capabilities`.
- [x] Implement element/group lock/unlock and inherited lock state, with an intentional background-only mode for fixed frames/sections where supported. Locked items remain readable/contextual; protected mutations fail consistently through UI and agent controls. Do not bypass locks by transforming or deleting an ancestor. Evidence: `test/canvas-edit.browser.test.ts` 'locks explicitly, refuses protected moves and content, unlocks, and supports background-only locks'; pointer, keyboard, agent (409 LOCKED), atomic compound, ancestor and background locks all held in the closing live check, 2026-11-13.
- [ ] Exercise every required control through pointer/keyboard and its structured agent equivalent. Verify nested transforms, lock failures, cancel, restore and no double operation on a selected parent/child overlap. Do not implement stickers, washi tape or sticky-note element types. Open: the built controls were exercised by pointer, keyboard and agent (`test/canvas-edit.browser.test.ts`, `test/mcp-canvas-tools.test.ts`, and about 30 mirrored operations in the closing live check, 2026-11-13), but not every required control exists: the foundations matrix asks for a human capture or export of a view or group, which is not built, and flip is unsupported.

- [x] Write `edit-queue.ts`. It gives each local operation an `opId`, shows it at once, sends one batch at a time and resends after a failure. It keeps unsent operations in `localStorage` until the server answers. Evidence: `test/canvas-edit-queue.test.ts` ('displays immediately, sends in order with one batch in flight, and removes only acknowledged operations', 'resends the exact opId after a lost acknowledgement and restores localStorage after reload').
- [x] Add the shaped compact dock and labeled Add menu for text, frame, section and sub-canvas. Keep every shortcut hint consistent with the brief. Evidence: `test/canvas-edit.browser.test.ts` ('anchors selection actions and Add to the dock and exposes available history with icons', 'creates every Add kind and saves plain text as a human author').
- [x] Write `select.ts` for click, shift-click and marquee selection. Evidence: `packages/canvas/src/select.ts`; `test/canvas-edit.browser.test.ts` 'cancels marquee/lasso and move mode without writes, supports scoped select all, and edits numeric geometry'.
- [x] Write `drag.ts`. Ordinary dragging changes position without changing the parent. A named container-header or outline drop target previews the destination and commits one `move` with a new `parentId`. Move to names a destination, including the root. Never infer containment from nearby geometry. Evidence: `test/canvas-edit.browser.test.ts` 'keeps ordinary drag parents, reparents on a named header, moves a container once and returns to root explicitly'.
- [x] Write `resize.ts` with the side/corner, numeric and constrained behaviors specified by the foundation contract, including nested-group transforms and identical agent commands. Evidence: `test/canvas-edit.browser.test.ts` ('resizes at 50% and 200%, keeps child geometry…', 'resizes a combined selection, scales groups uniformly, rotates, and keeps frame children fixed').
- [x] Edit plain text in the focused panel and submit on blur or debounce. Distinguish Saving, Saved and failed drafts. Preserve local content on a concurrent same-field update and expose conflict resolution. Do not add rich text or Git documents. Evidence: `test/canvas-edit.browser.test.ts` 'preserves a draft when another tab edits the field and resolves explicitly without reload'; `test/canvas-edit-queue.test.ts` 'shows Saving during an automatic resend so in-flight edits are not offered for discard'.
- [x] Delete with the Delete key as a soft delete. Evidence: `test/canvas-edit.browser.test.ts` 'resizes at 50% and 200%, keeps child geometry, and undoes/redo soft delete through restore'.
- [x] Write `undo.ts`. Scoped Cmd/Ctrl+Z appends safe inverses of the user's acknowledged operations without overwriting later work by another author. Handle redo, keyboard move mode, focus restoration and editing/IME exclusions per the brief. Evidence: `test/canvas-edit-queue.test.ts` 'refuses a changed revision, including a later author change to a different field', `test/canvas-edit.browser.test.ts`. The closing live check found that a second undo on the same object was refused with 409 REVISION; PR #37 fixed it, with unit, route and browser tests for repeated undo and undo after redo. Undo history does not survive a reload (PR #22).
- [x] Skip every edit control on a phone. Evidence: `test/canvas-edit.browser.test.ts` 'omits every edit control at phone width, including a desktop-to-phone change'.

**You see.**

- [x] A text block dragged into a frame moves with that frame afterwards. Evidence: `test/canvas-edit.browser.test.ts` 'keeps ordinary drag parents, reparents on a named header, moves a container once and returns to root explicitly'; PR #22 reparent lane.
- [x] Ctrl+Z after a delete brings the object back, and the log holds a `restore`. Evidence: `test/canvas-edit.browser.test.ts` 'resizes at 50% and 200%, keeps child geometry, and undoes/redo soft delete through restore'; PR #22 delete and undo lane.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `test/canvas-edit-queue.test.ts` covers ordering, the resend after a failure, the restore from `localStorage` and a server refusal. Run `npm test -- test/canvas-edit-queue.test.ts`. Evidence: the file covers each item ('displays immediately, sends in order…', 'resends the exact opId after a lost acknowledgement and restores localStorage after reload', 'rolls back a refused optimistic write, explains why, and keeps editing available'); it passed in the final-head unit run on the merged tree (14,619 passed; the 2 failures are in `cli-registry-no-id-branching`).
- [x] `test/canvas-edit.browser.test.ts` covers create, drag into a frame, resize and undo with real pointer events. Run `npm run test:browser -- test/canvas-edit.browser.test.ts`. Evidence: the file covers each item ('creates every Add kind…', 'keeps ordinary drag parents, reparents on a named header…', 'resizes at 50% and 200%…'); it passed in the final-head canvas browser run on the merged tree (188 of 189; the one failure is a timing flake in `canvas-context.browser.test.ts`).

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-sonnet-5-5` at the PR head, per the boot recipe.

- [x] Lane 1. Regression lane against trunk. Trunk here is the PC3 head. Pan and zoom the same workspace on both. Save `pc4-regression.png`. Pass when both pan, and head creates a text block from the toolbar. Evidence: PR #22 (the plan's ten live lanes passed at head `12f14586`, including the regression against trunk). The named screenshot is not retained.
- [x] Lane 2. Create a section, a frame and a text block, then type in the block. Save `pc4-create.png`. Pass when `GET /objects` holds all three with a human author. Evidence: PR #22 (the plan's ten live lanes passed at head `12f14586`, including create). The named screenshot is not retained.
- [x] Lane 3. Drop a text block on the frame's named target, verify its destination preview, then drag the frame. Save `pc4-reparent.png`. Pass when the block's `parentId` is the frame and it moves with the frame. Evidence: PR #22 (the plan's ten live lanes passed at head `12f14586`, including reparent). The named screenshot is not retained.
- [x] Lane 4. Drag a block out of a frame onto empty canvas. Save `pc4-unparent.png`. Pass when its `parentId` is unchanged; then choose Move to root and assert an explicit reparent operation. Evidence: PR #22 (the plan's ten live lanes passed at head `12f14586`, including unparent). The named screenshot is not retained.
- [x] Lane 5. Tidy a layout by moving objects near another frame without dropping them in it. Save `pc4-proximity.png`. Pass when no `parentId` changes. Evidence: PR #22 (the plan's ten live lanes passed at head `12f14586`, including proximity). The named screenshot is not retained.
- [x] Lane 6. Resize a frame at 50 percent and at 200 percent zoom. Save `pc4-resize.png`. Pass when the stored size matches the handle position at both. Evidence: PR #22 (the plan's ten live lanes passed at head `12f14586`, including resize at 50% and 200%). The named screenshot is not retained.
- [x] Lane 7. Delete an object, then press Ctrl+Z. Save `pc4-undo.png`. Pass when it returns and the log holds `delete` then `restore`. Evidence: PR #22 (the plan's ten live lanes passed at head `12f14586`, including delete and undo). The named screenshot is not retained.
- [x] Lane 8. Disconnect while an edit is pending, then try a new edit. Save `pc4-offline.png`. Pass when Offline is visible, the new write is refused, the pending draft is retained and reconnect acknowledges its original opId exactly once without duplicate operations. Evidence: PR #22 (the plan's ten live lanes passed at head `12f14586`, including offline). The named screenshot is not retained.
- [x] Lane 9. Edit the same field in two tabs while one has an unsent draft. Save `pc4-two-tabs.png`. Pass when the draft is preserved, the conflict is named and both tabs converge after explicit resolution without a reload. Evidence: PR #22 (the plan's ten live lanes passed at head `12f14586`, including two tabs). The named screenshot is not retained.
- [ ] Lane 10. Let an agent update a block while the user drags it. Save `pc4-concurrent.png`. Pass when the position is the user's and the text is the agent's. Open: PR #22 ran this lane with a plain API writer, not an agent session. `test/canvas-edit-queue.test.ts` 'reapplies pending positions over concurrent content without losing the content' covers the merge rule.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. Frame rate of a pan across 500 objects at the PC3 head and at this head, plus the frame rate while dragging a frame that holds 50 children. Evidence: PR #22: a 500-object pan at 60 fps on this head and on trunk; dragging a frame with 50 children at 60 fps.
- [ ] Probe. The PC3 pan script on both builds, interleaved, and a drag script on this head. Open: the PR reports the results, but the probe scripts, run counts and interleaving are not recorded.
- [x] Baseline. Record the PC3 pan frame rate first. Evidence: PR #22 reports the trunk (PC3) pan at 60 fps.
- [x] Rule. Fail when the pan drops more than 5 frames per second below PC3, or when the drag runs under 50 frames per second. Evidence: PR #22: no drop against PC3, and 60 fps against the 50 fps floor.

**Review gate.** An agent reviews the rendered interaction against the shaped brief before merge.

- [x] Copy the lane 2, 3 and 7 screenshots into `pr/media/pc4-review-<slug>.png`. Evidence: `test/canvas-edit.browser.test.ts` writes `pc4-review-<stamp>-<slug>.png` captures into the local media library, which git does not track. They are test captures, not copies of the lane screenshots.
- [ ] Record a 30 to 60 second video of create, drag into a frame, resize and undo. Save it as `pr/media/pc4-review.mp4`. Open: no video is recorded for PC4; the review used still captures.
- [x] Have a reviewing agent check the screenshots and video against the shaped brief. Fix findings, record the verdict and make the evidence available in the status report. Continue to merge when the review passes. Evidence: PR #22 (design review of the rendered captures passed after two rounds of fixes); `intent/2026-11-11-canvas-pc4-design-review.md` and `intent/2026-11-11-canvas-pc4-design-review-2.md`.

**Merge.**

- [x] Root's clean verdict at the exact head SHA. Evidence: PR #22 checks are stated at the merge head `12f14586`; the second audit found no blocking defect.
- [ ] Rebased onto the PC3 branch after the verdict, patch-id unchanged. Open: no record of a rebase after the verdict or of a patch-id check; the PR was squash-merged onto `master`.
- [x] The coordinator records PC4 as verified, lands the PR and deploys automatically after the final-head checks pass, then verifies the live result. Evidence: PR #22 merged as `15b6f376`, and the supervisor's deploy record shows that commit deployed with outcome success on 2026-11-11. A check of the live result beyond the supervisor's health check is not recorded.

## Add images, links, website embeds and sub-canvases (PC5)

**Depends on.** PC4.

**Files.**

- [x] Create `src/canvas/canvas-assets.ts` and `src/canvas/link-preview.ts`. Evidence: both files are on `master` (PR #25).
- [x] Edit `src/web/routes/canvas-routes.ts`, `src/web/webview-store.ts` and `src/types/webview.ts`. Evidence: commit `a56fce39` (PR #25) changes `canvas-routes.ts` and `src/types/webview.ts`. `webview-store.ts` was not edited: embed frames live in memory in `src/canvas/canvas-frames.ts`, never in the saved web tabs, as decided in PR #25 and `intent/2026-11-11-canvas-pc5-media.md`.
- [x] Create `packages/canvas/src/objects/image.ts`, `link.ts`, `embed.ts` and `subcanvas.ts`. Evidence: all four files are on `master` (PR #25).
- [x] Create `test/canvas-assets.test.ts`, `test/link-preview.test.ts` and `test/canvas-media.browser.test.ts`. Evidence: all three test files are on `master` (PR #25).

**Build.**

- [x] Store an uploaded or pasted image under `dataPath('canvas/<workspaceId>/assets/')`, named by its SHA-256. Judge the bytes with `imageMagicMatchesExt`, and serve it by id with the range-aware `sendFileBody()`. Evidence: `test/canvas-assets.test.ts` 'stores bytes under their SHA-256 with the proved extension and private modes, once'; `test/routes/canvas-routes.test.ts` 'stores an uploaded image, serves it by id with nosniff and ranges, and refuses forged bytes'.
- [x] Create an image object on paste and on drop. Evidence: `test/canvas-media.browser.test.ts` ('pastes an image at its own aspect ratio and shows a quiet note when bytes are missing', 'highlights the container a drop lands in and places the drop inside it').
- [x] Fetch a link's title and thumbnail on the server through the `webview-egress.ts` guard, because the page's CSP blocks remote images. Evidence: `test/link-preview.test.ts` ('reads the og title and stores no script, and fetches the thumbnail without cookies or auth', 'refuses link-local and metadata targets before any request is made').
- [x] Render an `embed` as a sandboxed iframe on `/webview/<cap>/`. Add a `canvas` kind to `WebviewOrigin`, never trusted, deleted with its object. Evidence: the `canvas` origin kind in `src/types/webview.ts`; `test/canvas-embed-sandbox.test.ts`; `test/routes/canvas-routes.test.ts` 'mints a frame only for a live embed, in memory, and retires it on delete, back-to-link and a new URL'.
- [x] Load an embed's frame only when it is on screen, and keep at most six live. Evidence: `MAX_LIVE_FRAMES = 6` in `packages/canvas/src/media.ts`; `test/canvas-media.browser.test.ts` 'keeps at most six frames live, never takes focus, lets a drag cross a frame, and Escape hands keys back'.
- [x] Shield iframes with a transparent layer during a drag, so the pointer stays with the canvas. Evidence: the same browser test drags an object across a live frame.
- [x] Open a sub-canvas on double-click by setting the view root to that object, with a breadcrumb back. Evidence: `test/canvas-media.browser.test.ts` 'opens a sub-canvas into its own view with a breadcrumb and leaves with Escape'.

**You see.**

- [x] A pasted screenshot appears as an image object and survives a reload. Evidence: `test/canvas-media.browser.test.ts` 'pastes an image at its own aspect ratio…' and PR #25 (manual lane for images). The object is an ordinary logged object and its bytes a stored asset; no test reloads the page after a paste.
- [x] A pasted URL becomes a link card, and **Embed** turns it into a live page inside the canvas. Evidence: `test/canvas-media.browser.test.ts` ('turns a pasted address into a link card with a preview, a bare card without one, and refuses other files', 'loads a fresh frame after an embed goes back to a link and is embedded again, and on Reload').

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `test/canvas-assets.test.ts` covers the byte check, a wrong extension, the size cap and the id-only read path. Run `npm test -- test/canvas-assets.test.ts`. Evidence: the file covers each item ('refuses bytes that are not the declared type, unknown types, empty and oversized bodies, writing nothing', 'finds an asset by id only…'); it passed in the final-head unit run on the merged tree (14,619 passed; the 2 failures are in `cli-registry-no-id-branching`).
- [x] `test/link-preview.test.ts` covers the egress refusal for link-local and metadata addresses. Run `npm test -- test/link-preview.test.ts`. Evidence: the file covers it ('refuses link-local and metadata targets before any request is made', 'refuses a redirect to a metadata address'); it passed in the final-head unit run on the merged tree (14,619 passed; the 2 failures are in `cli-registry-no-id-branching`).
- [x] `test/canvas-media.browser.test.ts` covers paste, embed and sub-canvas navigation. Run `npm run test:browser -- test/canvas-media.browser.test.ts`. Evidence: the file covers each item (paste, six live frames, sub-canvas with breadcrumb); it passed in the final-head canvas browser run on the merged tree (188 of 189; the one failure is a timing flake in `canvas-context.browser.test.ts`).

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-sonnet-5-5` at the PR head, per the boot recipe.

- [x] Lane 1. Regression lane against trunk. Trunk here is the PC4 head. Create and drag a text block on both. Save `pc5-regression.png`. Pass when both work, and head accepts a pasted image. Evidence: PR #25 (manual lanes on throwaway instances, named by area and not one by one) and `test/canvas-edit.browser.test.ts` with `test/canvas-media.browser.test.ts` 'pastes an image at its own aspect ratio…'. The named screenshot is not retained.
- [x] Lane 2. Paste a PNG from the clipboard. Save `pc5-paste.png`. Pass when the image renders and its file exists under `assets`. Evidence: PR #25 (manual lanes on throwaway instances, named by area and not one by one) and `test/canvas-media.browser.test.ts` 'pastes an image at its own aspect ratio…' with `test/canvas-assets.test.ts` 'stores bytes under their SHA-256…'. The named screenshot is not retained.
- [x] Lane 3. Upload a script renamed to `.png`. Save `pc5-magic.png`. Pass when the route refuses it. Evidence: PR #25 (manual lanes on throwaway instances, named by area and not one by one) and `test/routes/canvas-routes.test.ts` 'stores an uploaded image, serves it by id with nosniff and ranges, and refuses forged bytes'. The named screenshot is not retained.
- [x] Lane 4. Paste a URL of a local test page. Save `pc5-link.png`. Pass when the card shows that page's title. Evidence: PR #25 (manual lanes on throwaway instances, named by area and not one by one) and `test/canvas-media.browser.test.ts` 'turns a pasted address into a link card with a preview, a bare card without one, and refuses other files'. The named screenshot is not retained.
- [x] Lane 5. Paste a link-local metadata URL. Save `pc5-egress.png`. Pass when no request leaves and the card shows the bare URL. Evidence: PR #25 (manual lanes on throwaway instances, named by area and not one by one) and `test/link-preview.test.ts` 'refuses link-local and metadata targets before any request is made'. The named screenshot is not retained.
- [x] Lane 6. Embed a local test page. Save `pc5-embed.png`. Pass when the page renders in the iframe through `/webview/`. Evidence: PR #25 (manual lanes on throwaway instances, named by area and not one by one) and `test/canvas-media.browser.test.ts` 'keeps at most six frames live…' with `test/canvas-embed-sandbox.test.ts`. The named screenshot is not retained.
- [x] Lane 7. Drag an object across an embed. Save `pc5-shield.png`. Pass when the drag does not stop over the iframe. Evidence: PR #25 (manual lanes on throwaway instances, named by area and not one by one) and `test/canvas-media.browser.test.ts` 'keeps at most six frames live, never takes focus, lets a drag cross a frame…'. The named screenshot is not retained.
- [x] Lane 8. Delete an embed object. Save `pc5-embed-delete.png`. Pass when its web tab record and capability are gone. Evidence: PR #25 (manual lanes on throwaway instances, named by area and not one by one) and `test/routes/canvas-routes.test.ts` 'mints a frame only for a live embed, in memory, and retires it on delete…'. The frame is an in-memory record, never a saved web tab. The named screenshot is not retained.
- [x] Lane 9. Place twelve embeds and pan across them. Save `pc5-embed-cap.png`. Pass when at most six iframes are live at once. Evidence: PR #25 (manual lanes on throwaway instances, named by area and not one by one) and `test/canvas-media.browser.test.ts` 'keeps at most six frames live…', which places eight embeds, not twelve. The named screenshot is not retained.
- [x] Lane 10. Open a sub-canvas, add a block, go back. Save `pc5-subcanvas.png`. Pass when the block's `parentId` is the sub-canvas. Evidence: PR #25 (manual lanes on throwaway instances, named by area and not one by one) and `test/canvas-media.browser.test.ts` 'opens a sub-canvas into its own view…', which asserts the pasted block's `parentId` is the sub-canvas. The named screenshot is not retained.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Pan frame rate across 500 objects at the PC4 head and at this head, plus the pan frame rate with 100 images and six live embeds. Open: PR #25 reports a pan at 60 fps with 300 objects (40 images, 20 embeds). The 500-object comparison with the PC4 head and the 100-image, six-embed fixture are not reported.
- [ ] Probe. The PC3 pan script on both builds, interleaved, and a media pan script on this head. Open: the PR reports the results, but the probe scripts, run counts and interleaving are not recorded.
- [x] Baseline. Record the PC4 pan frame rate first. Evidence: PR #22 records the PC4 head's 500-object pan at 60 fps.
- [ ] Rule. Fail when the pan drops more than 5 frames per second below PC4, or when the media pan runs under 40 frames per second. Open: the one reported figure (60 fps) is above both floors, but it comes from a different fixture than this rule names, and no figure against the PC4 head is reported.

**Review gate.** An agent reviews the rendered interaction against the shaped brief before merge.

- [x] Copy the lane 2, 4 and 6 screenshots into `pr/media/pc5-review-<slug>.png`. Evidence: `test/canvas-media.browser.test.ts` writes `pc5-review-<stamp>-<slug>.png` captures into the local media library, which git does not track. They are test captures, not copies of the lane screenshots.
- [ ] Record a 30 to 60 second video of a paste, a link, an embed and a sub-canvas. Save it as `pr/media/pc5-review.mp4`. Open: no video is recorded for PC5.
- [ ] Have a reviewing agent check the screenshots and video against the shaped brief. Fix findings, record the verdict and make the evidence available in the status report. Continue to merge when the review passes. Open: PR #25 records an independent security audit and manual lanes; no design-review verdict against the shaped brief is recorded.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA. Open: PR #25 lists what was checked and one independent security audit, but names no head SHA and no verdict.
- [ ] Rebased onto the PC4 branch after the verdict, patch-id unchanged. Open: no record of a rebase after the verdict or of a patch-id check; the PR was squash-merged onto `master`.
- [x] The coordinator records PC5 as verified, lands the PR and deploys automatically after the final-head checks pass, then verifies the live result. Evidence: PR #25 merged as `a56fce39`, and the supervisor's deploy record shows that commit deployed with outcome success on 2026-11-12. A check of the live result beyond the supervisor's health check is not recorded.

## Add comments, author revert and the phone view (PC6)

**Depends on.** PC4.

**Files.**

- [x] Create `packages/canvas/src/comments.ts`, `src/history.ts` and `src/mobile.ts`. Evidence: all three files are on `master` (PR #24).
- [x] Edit `packages/canvas/src/entry.ts`, `src/web/public/canvas.html` and `src/web/public/mobile-overview.js`. Evidence: commit `41dbfb69` (PR #24) changes all three files.
- [x] Edit `src/mcp-server.ts` to add `canvas_comment`. Evidence: commit `41dbfb69` (PR #24) changes the file; `test/canvas-comments.test.ts` 'exposes canvas_comment among the command tools'.
- [x] Create `test/canvas-comments.browser.test.ts` and `test/mobile/canvas-readonly.test.ts`. Evidence: both test files are on `master` (PR #24).

**Build.**

- [x] Show a comment count on each object and a thread panel that lists and adds comments. Post stores an ordinary comment without starting agent work. PC10 adds deliberate Ask agent and Open conversation actions; never infer invocation from an ordinary comment. Evidence: `test/canvas-comments.browser.test.ts` ('marks only objects that have comments, quietly', 'opens a thread in the rail with authors, inert text and an agent mark'); `test/canvas-thread-requests.test.ts` 'an ordinary comment starts no agent work and records no request'.
- [x] Include comments in `canvas_read`, and add the `canvas_comment` tool so an agent can reply. Evidence: the read result carries the container's comments (`src/canvas/queries.ts`); `test/canvas-comments.test.ts` ('posts an ordinary comment through the command path, once per request id, and reads it back', 'exposes canvas_comment among the command tools').
- [x] Add a history panel that lists authors with their operation counts and a **Revert this session** button that calls `POST /revert`. Evidence: `test/canvas-comments.browser.test.ts` 'lists authors, confirms a session revert inline, and reports what was skipped'.
- [x] Render the phone canvas for reading and navigation, with pan, pinch, Sections and a focused bottom sheet. Object-content/layout editing, drag and resize are absent; comment entry remains enabled. Verify the composer above the software keyboard and focus restoration when closing. Evidence: `test/mobile/canvas-readonly.test.ts` ('shows only phone controls: labelled Sections, Find, Comments and Fit, and no edit dock', 'posts a comment from the phone with the composer above the keyboard, and returns focus'); it passed in the final-head phone canvas run on the merged tree (43 of 43). PR #24 says the real-iPhone re-run was not done.
- [x] Add a canvas entry per case to the current phone home screen for the transitional shell. The canvas itself uses the outline sheet for navigation and search; it has no additional navbar. Evidence: `test/mobile/canvas-readonly.test.ts` 'lists a canvas entry per case on the phone home screen, with no new header button'.

**You see.**

- [x] A comment added on the phone appears on the desktop canvas without a reload. Evidence: `test/mobile/canvas-readonly.test.ts` 'shows the phone comment on a desktop tab within a second'; a phone comment showed on the laptop page in the closing live check, 2026-11-13.
- [x] **Revert this session** removes one agent's objects and leaves the user's edits. Evidence: `test/canvas-comments.browser.test.ts` 'lists authors, confirms a session revert inline, and reports what was skipped'; reverting the agent session removed only its summary block in the closing live check, 2026-11-13.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `test/canvas-comments.browser.test.ts` covers add, live arrival and the revert button. Run `npm run test:browser -- test/canvas-comments.browser.test.ts`. Evidence: the file covers each item ('posts with Ctrl+Enter…', 'appends an arriving agent comment without moving camera, focus, selection or scroll', 'lists authors, confirms a session revert inline…'); it passed in the final-head canvas browser run on the merged tree (188 of 189; the one failure is a timing flake in `canvas-context.browser.test.ts`).
- [x] `test/mobile/canvas-readonly.test.ts` covers pinch, the missing edit controls and a comment, with the touch branch forced on. Run `npm run test:mobile -- test/mobile/canvas-readonly.test.ts`. Evidence: the file covers each item and sets `window.__canvasTouch` to force the touch branch; it passed in the final-head phone canvas run on the merged tree (43 of 43).

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-sonnet-5-5` at the PR head, per the boot recipe.

- [x] Lane 1. Regression lane against trunk. Trunk here is the PC4 head. Drag a block into a frame on both. Save `pc6-regression.png`. Pass when both reparent, and head shows a comment count. Evidence: PR #24 (ten manual lanes on throwaway instances, not listed one by one) and `test/canvas-edit.browser.test.ts` (reparent) with `test/canvas-comments.browser.test.ts` 'marks only objects that have comments, quietly'. The named screenshot is not retained.
- [x] Lane 2. Add two comments to a frame. Save `pc6-thread.png`. Pass when both show in order with their author. Evidence: PR #24 (ten manual lanes on throwaway instances, not listed one by one) and `test/canvas-comments.browser.test.ts` 'opens a thread in the rail with authors, inert text and an agent mark'. The named screenshot is not retained.
- [x] Lane 3. Call `canvas_comment` over stdio. Save `pc6-agent-comment.png`. Pass when the reply appears in the open panel with an agent author. Evidence: PR #24 (ten manual lanes on throwaway instances, not listed one by one) and `test/canvas-comments.browser.test.ts` 'appends an arriving agent comment without moving camera, focus, selection or scroll'; the tool is listed in `test/canvas-comments.test.ts`. The named screenshot is not retained.
- [x] Lane 4. Put markup in a comment. Save `pc6-inert.png`. Pass when it shows as text. Evidence: PR #24 (ten manual lanes on throwaway instances, not listed one by one) and `test/canvas-comments.browser.test.ts` 'opens a thread in the rail with authors, inert text and an agent mark'. The named screenshot is not retained.
- [x] Lane 5. Let an agent create five objects and edit one of the user's, then revert that session. Save `pc6-revert.png`. Pass when the five are gone and the edited field holds the user's value. Evidence: PR #24 (ten manual lanes on throwaway instances, not listed one by one) and `test/canvas-comments.test.ts` 'reverts one agent through POST /revert once per request id and leaves later edits by others'. The named screenshot is not retained.
- [x] Lane 6. Revert an agent whose field the user later changed. Save `pc6-revert-skip.png`. Pass when the user's later value stays. Evidence: PR #24 (ten manual lanes on throwaway instances, not listed one by one) and `test/canvas-comments.test.ts` 'revertPlan removes, restores, keeps and skips by the field-protection rules'. The named screenshot is not retained.
- [x] Lane 7. Open the canvas on a phone profile. Save `pc6-phone.png`. Pass when it pans and pinches, has labeled Sections/Find controls, has no object-edit dock, and its comment composer stays above the phone keyboard. Evidence: PR #24 (ten manual lanes on throwaway instances, not listed one by one) and `test/mobile/canvas-readonly.test.ts` ('shows only phone controls…', 'pinches about the fingers at 40 frames per second or better', 'posts a comment from the phone with the composer above the keyboard…'). A real phone keyboard was not used. The named screenshot is not retained.
- [x] Lane 8. Try to drag an object on the phone profile. Save `pc6-phone-nodrag.png`. Pass when the canvas pans and no operation is sent. Evidence: PR #24 (ten manual lanes on throwaway instances, not listed one by one) and `test/mobile/canvas-readonly.test.ts` 'pans with one finger from an object without selecting it, and sends no write'. The named screenshot is not retained.
- [x] Lane 9. Add a comment on the phone profile with a desktop tab open. Save `pc6-phone-comment.png`. Pass when the desktop shows it within one second. Evidence: PR #24 (ten manual lanes on throwaway instances, not listed one by one) and `test/mobile/canvas-readonly.test.ts` 'shows the phone comment on a desktop tab within a second'. The named screenshot is not retained.
- [x] Lane 10. Open the phone home screen. Save `pc6-phone-home.png`. Pass when the case shows a canvas entry and no new header button. Evidence: PR #24 (ten manual lanes on throwaway instances, not listed one by one) and `test/mobile/canvas-readonly.test.ts` 'lists a canvas entry per case on the phone home screen, with no new header button'. The named screenshot is not retained.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. Pan frame rate across 500 objects at the PC4 head and at this head, plus the pinch frame rate on the phone profile and the time of a revert of 1,000 operations. Evidence: PR #24: pan 60 fps, pinch 55 to 60 fps, a revert of 1,000 operations in 153 ms.
- [ ] Probe. The PC3 pan script on both builds, interleaved, a pinch script on the phone profile and a revert script. Open: the pinch and revert probes are in the repository (`test/mobile/canvas-readonly.test.ts`, `test/canvas-comments.test.ts`), but the pan is reported at this head only and the interleaved run on both builds is not recorded.
- [x] Baseline. Record the PC4 pan frame rate first. Evidence: PR #22 records the PC4 head's 500-object pan at 60 fps.
- [x] Rule. Fail when the pan drops more than 5 frames per second below PC4, when the pinch runs under 40 frames per second, or when the revert exceeds one second. Evidence: PR #24: 60 fps against PC4's 60, pinch 55 to 60 against 40, 153 ms against one second.

**Review gate.** An agent reviews the rendered interaction against the shaped brief before merge.

- [x] Copy the lane 2, 5 and 7 screenshots into `pr/media/pc6-review-<slug>.png`. Evidence: `test/canvas-comments.browser.test.ts` and `test/mobile/canvas-readonly.test.ts` write `pc6-review-<stamp>-<slug>.png` captures into the local media library, which git does not track. They are test captures, not copies of the lane screenshots.
- [ ] Record a 30 to 60 second video of a comment, a revert and the phone view. Save it as `pr/media/pc6-review.mp4`. Open: no video is recorded for PC6.
- [ ] Have a reviewing agent check the screenshots and video against the shaped brief. Fix findings, record the verdict and make the evidence available in the status report. Continue to merge when the review passes. Open: PR #24 records an independent audit with its findings fixed; no design-review verdict against the shaped brief is recorded.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA. Open: PR #24 lists what was checked and one independent audit, but names no head SHA and no verdict.
- [ ] Rebased onto the PC4 branch after the verdict, patch-id unchanged. Open: no record of a rebase after the verdict or of a patch-id check; the PR was squash-merged onto `master`.
- [x] The coordinator records PC6 as verified, lands the PR and deploys automatically after the final-head checks pass, then verifies the live result. Evidence: PR #24 merged as `41dbfb69`, and the supervisor's deploy record shows that commit deployed with outcome success on 2026-11-12. A check of the live result beyond the supervisor's health check is not recorded.

## Render a container screenshot on the server (PC7)

**Depends on.** PC3.

**Files.**

- [x] Create `src/canvas/canvas-screenshot.ts`. Evidence: the file is on `master` (PR #21).
- [x] Edit `src/mermaid-renderer.ts` to move its browser launch into `src/headless-browser.ts`. Evidence: commit `3fbdc4cb` (PR #21) changes `src/mermaid-renderer.ts`, which now calls `launchHeadlessBrowser()` from `src/headless-browser.ts`.
- [x] Edit `src/web/routes/canvas-routes.ts` and `src/mcp-server.ts`. Evidence: commit `3fbdc4cb` (PR #21) changes both files.
- [x] Create `test/canvas-screenshot.test.ts`. Evidence: the file is on `master` (PR #21).

**Build.**

- [x] Move the puppeteer launch, the `mermaid-runtime.json` read and the sandbox choice from `renderMermaid()` into `launchHeadlessBrowser()`. Both renderers call it. Evidence: `launchHeadlessBrowser()` in `src/headless-browser.ts`, called by `src/mermaid-renderer.ts` and `src/canvas/canvas-screenshot.ts`.
- [x] Write `renderContainer(workspaceId, objectId)`. It loads the canvas bundle from a self-contained document, feeds it the container's tree, and captures a PNG clipped to the container. The page gets no login and no network except image assets that the server hands it. Evidence: `renderContainer()` in `src/canvas/canvas-screenshot.ts`; `test/canvas-screenshot.test.ts` ('clips world bounds with a 48px margin and scales only past 4096', 'refuses an outside image and keeps markup as text'); PR #21 Safety properties.
- [x] Run at most one render at a time, with a 20 second limit. Evidence: `SCREENSHOT_TIMEOUT_MS = 20_000`; `test/canvas-screenshot.test.ts` 'runs one render at a time and does not launch a caller that already timed out'.
- [x] Add `GET /api/canvas/:workspaceId/objects/:id/screenshot` and the `canvas_screenshot` tool, which returns the PNG as image content. Evidence: `test/mcp-canvas-tools.test.ts` ('returns a screenshot as image content and keeps it out of the command envelope', 'returns image content through the real routes when the session header supplies the workspace').
- [x] Draw an embed as a labelled box with its URL, because a network-disabled page cannot load it. Evidence: PR #21 (the embed lane passed) and `intent/2026-11-11-canvas-screenshot.md`: links and embeds draw as inert cards whose label carries the URL (`packages/canvas/src/shot.ts`).

**You see.**

- [x] The route returns a PNG that shows the section's objects in their places. Evidence: PR #21 (the real stdio MCP server returned a PNG of a section at head `442fd303`).
- [x] An agent that calls `canvas_screenshot` describes the layout of the section. Evidence: closing live check, 2026-11-13: one `canvas_screenshot` call by an agent session matched the "design exploration" section.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `test/canvas-screenshot.test.ts` covers the clip rectangle, the request refusal for outside URLs, the limit of one render and the time limit. Run `npm test -- test/canvas-screenshot.test.ts`. Evidence: the file covers each item ('clips world bounds with a 48px margin…', 'refuses an outside image and keeps markup as text', 'runs one render at a time and does not launch a caller that already timed out'); it passed in the final-head unit run on the merged tree (14,619 passed; the 2 failures are in `cli-registry-no-id-branching`).
- [x] The Mermaid tests still pass after the move. Run `npm test -- -t mermaid`. Evidence: the Mermaid tests are part of the final-head unit run on the merged tree, which passed apart from 2 unrelated failures in `cli-registry-no-id-branching`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-sonnet-5-5` at the PR head, per the boot recipe.

- [x] Lane 1. Regression lane against trunk. Run `codeman mermaid render` on one diagram at trunk and head. Trunk lacks the screenshot route, so record that and gate the head's PNG. Save `pc7-regression.png`. Pass when both diagrams match and head returns a PNG. Evidence: PR #21 (ten live lanes passed at head `442fd303`, not listed one by one); the PR measures Mermaid rendering against trunk at a ratio of 0.97. The named screenshot is not retained.
- [x] Lane 2. Capture a section with text, a frame and an image. Save `pc7-section.png`. Pass when all three are visible inside the clip. Evidence: PR #21 (ten live lanes passed at head `442fd303`, not listed one by one). The named screenshot is not retained.
- [x] Lane 3. Capture a nested frame. Save `pc7-nested.png`. Pass when the PNG shows only that frame and its children. Evidence: PR #21 (ten live lanes passed at head `442fd303`, not listed one by one). The named screenshot is not retained.
- [x] Lane 4. Capture a container with an embed. Save `pc7-embed-box.png`. Pass when the embed is a labelled box and no outside request was made. Evidence: PR #21 (ten live lanes passed at head `442fd303`, not listed one by one); the render page refuses every outside request (`test/canvas-screenshot.test.ts`). The named screenshot is not retained.
- [x] Lane 5. Capture an empty container. Save `pc7-empty.png`. Pass when the route returns a small PNG and no error. Evidence: PR #21 (ten live lanes passed at head `442fd303`, not listed one by one). The named screenshot is not retained.
- [x] Lane 6. Request an unknown object id. Save `pc7-404.png`. Pass when the answer is 404. Evidence: PR #21 (ten live lanes passed at head `442fd303`, not listed one by one) and `test/canvas-screenshot.test.ts` '404s a disabled canvas, an unknown object and a deleted object…'. The named screenshot is not retained.
- [x] Lane 7. Send five requests at once. Save `pc7-queue.png`. Pass when one browser process runs at a time and all five answer. Evidence: PR #21 (ten live lanes passed at head `442fd303`, not listed one by one); the PR names five concurrent requests with at most one browser at a time. The named screenshot is not retained.
- [x] Lane 8. Call `canvas_screenshot` over stdio. Save `pc7-mcp.png`. Pass when the result carries image content. Evidence: PR #21 (ten live lanes passed at head `442fd303`, not listed one by one); the PR names the real stdio MCP server returning a PNG of a section. The named screenshot is not retained.
- [x] Lane 9. Capture a 5,000 object container. Save `pc7-large.png`. Pass when it answers or fails cleanly inside 20 seconds, and no browser process remains. Evidence: PR #21 (ten live lanes passed at head `442fd303`, not listed one by one) and `test/canvas-screenshot.test.ts` 'screenshots five thousand descendants without a browser'. A forced 20 second timeout was not exercised live (unit tests only). The named screenshot is not retained.
- [x] Lane 10. Capture with a text block that holds markup. Save `pc7-inert.png`. Pass when the markup shows as text. Evidence: PR #21 (ten live lanes passed at head `442fd303`, not listed one by one) and `test/canvas-screenshot.test.ts` 'refuses an outside image and keeps markup as text'. The named screenshot is not retained.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. Time of `codeman mermaid render` for one diagram at trunk and head. Trunk lacks the screenshot, so also measure the time of one 50 object container capture. Evidence: PR #21: Mermaid render ratio 0.97 against trunk; a 50-object capture p95 of 541 ms.
- [ ] Probe. A script renders the diagram five times per build, interleaved, then captures the container five times. Open: the PR reports the results, but the probe scripts, run counts and interleaving are not recorded.
- [x] Baseline. Record the trunk Mermaid render time first. Evidence: PR #21 reports the head relative to trunk.
- [x] Rule. Fail when the head Mermaid render exceeds trunk by more than 10 percent, or when the container capture p95 exceeds 5 seconds. Evidence: PR #21: 0.97 against a 1.10 limit, and 541 ms against 5 s.

**Review gate.** None. PC7 is not review-gated.

**Merge.**

- [x] Root's clean verdict at the exact head SHA. Evidence: PR #21 checks are stated at the merge head `442fd303`, with one independent audit whose three blocking defects are fixed.
- [ ] Rebased onto the PC3 branch after the verdict, patch-id unchanged. Open: no record of a rebase after the verdict or of a patch-id check; the PR was squash-merged onto `master`.
- [x] The coordinator records PC7 as verified, lands the PR and deploys automatically after the final-head checks pass, then verifies the live result. Evidence: PR #21 merged as `3fbdc4cb`, and the supervisor's deploy record shows that commit deployed with outcome success on 2026-11-11. A check of the live result beyond the supervisor's health check is not recorded.

## Let agents query redacted logs (PC8)

**Depends on.** None.

**Files.**

- [x] Create `src/telemetry-redact.ts` and `src/telemetry-query.ts`. Evidence: both files are on `master` (PR #19).
- [x] Edit `src/telemetry.ts`, `src/web/routes/telemetry-routes.ts`, `src/mcp-server.ts` and `docs/self-building.md`. Evidence: commit `3942d156` (PR #19) changes all four files.
- [x] Create `test/telemetry-redact.test.ts` and `test/telemetry-query.test.ts`. Evidence: both test files are on `master` (PR #19).

**Build.**

- [x] Write the pure `redactLogLine()`. It masks values under keys that match `SECRET_KEY_RE`, bearer tokens, URL credentials and the hook secret. `StreamWriter` calls it before every write. Evidence: `src/telemetry.ts` passes every line through `redactLogLine` before it is queued; `test/telemetry-redact.test.ts` ('masks values under secret-shaped keys and leaves the key', 'masks bearer tokens and URL userinfo', 'replaces a hook secret as a literal, and ignores one that is too short').
- [ ] Add a `ui-events.jsonl` stream for the canvas and the tab strip, written through the existing client route. Open: the stream and its intake exist (`ui-events` in `src/telemetry.ts`, the `kind: "ui"` body on `POST /api/client-errors`), but nothing in the canvas or the tab strip posts to it, so the file stays empty in use.
- [x] Write `queryLogs()`. It reads the current file and its `.1` generation for one stream, filters by time range, level and a literal substring, and caps the rows. It never compiles a caller's text into a RegExp. Evidence: `test/telemetry-query.test.ts` ('filters by an inclusive time range, level and a case-sensitive literal', 'reads the rotated generation before the current file', 'treats a ReDoS-shaped pattern as a literal and finishes quickly').
- [x] Add `GET /api/logs` and the `logs_query` tool. The route is admin-only in multi-user mode. Evidence: `GET /api/logs` behind `requireAdmin` in `src/web/routes/telemetry-routes.ts`, and the `logs_query` tool in `src/mcp-server.ts`; PR #19 ran both.
- [x] Update the telemetry instructions in `docs/self-building.md` under this review's program authorization. Preserve its supervisor, rollback, access and data-safety rules; unrelated deploy-design changes remain outside this program. Evidence: commit `3942d156` (PR #19) updates the telemetry section of `docs/self-building.md` (redaction, `GET /api/logs`, `logs_query`).

**You see.**

- [x] `logs_query` with stream `server` and text `deploy` returns matching lines as JSON. Evidence: PR #19 (the query ran through the HTTP route and the stdio MCP tool at `c0c36f69`).
- [x] A log line that carried a bearer token holds `[redacted]` on disk. Evidence: `test/telemetry-redact.test.ts` 'writes [redacted] where a bearer token was'.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `test/telemetry-redact.test.ts` covers each secret shape and a line with none. Run `npm test -- test/telemetry-redact.test.ts`. Evidence: the file covers each shape and a clean line ('keeps a line that holds none of the secret shapes', 'masks known token shapes with no key'); it passed in the final-head unit run on the merged tree (14,619 passed; the 2 failures are in `cli-registry-no-id-branching`).
- [x] `test/telemetry-query.test.ts` covers the filters, the row cap, the rotated file and a pattern that would hang a RegExp. Run `npm test -- test/telemetry-query.test.ts`. Evidence: the file covers each item ('keeps the newest matches in order when the row cap is hit', 'reads the rotated generation before the current file', 'treats a ReDoS-shaped pattern as a literal and finishes quickly'); it passed in the final-head unit run on the merged tree (14,619 passed; the 2 failures are in `cli-registry-no-id-branching`).

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-sonnet-5-5` at the PR head, per the boot recipe.

- [x] Lane 1. Regression lane against trunk. Make one request and find its line in `requests.jsonl` at trunk and head. Trunk lacks the query route, so record that and gate the head's `GET /api/logs`. Save `pc8-regression.png`. Pass when both files hold the line and head returns it. Evidence: PR #19 (ten live lanes passed at `c0c36f69`, not listed one by one; the one later commit was not re-run live). The named screenshot is not retained.
- [x] Lane 2. Log a line with a bearer token. Save `pc8-bearer.png`. Pass when the file holds `[redacted]` and not the token. Evidence: PR #19 (ten live lanes passed at `c0c36f69`, not listed one by one; the one later commit was not re-run live) and `test/telemetry-redact.test.ts` 'writes [redacted] where a bearer token was'. The named screenshot is not retained.
- [x] Lane 3. Log an object with a `password` key. Save `pc8-key.png`. Pass when the value is masked and the key stays. Evidence: PR #19 (ten live lanes passed at `c0c36f69`, not listed one by one; the one later commit was not re-run live) and `test/telemetry-redact.test.ts` 'masks a password field and the hook secret already on disk'. The named screenshot is not retained.
- [x] Lane 4. Log a git URL with credentials. Save `pc8-url.png`. Pass when the credentials are masked. Evidence: PR #19 (ten live lanes passed at `c0c36f69`, not listed one by one; the one later commit was not re-run live) and `test/telemetry-redact.test.ts` 'masks a URL username through the writer and the query'. The named screenshot is not retained.
- [x] Lane 5. Query by a time range. Save `pc8-range.png`. Pass when only lines inside the range return. Evidence: PR #19 (ten live lanes passed at `c0c36f69`, not listed one by one; the one later commit was not re-run live) and `test/telemetry-query.test.ts` 'filters by an inclusive time range, level and a case-sensitive literal'. The named screenshot is not retained.
- [x] Lane 6. Query for text that sits only in the rotated `.1` file. Save `pc8-rotated.png`. Pass when the line returns. Evidence: PR #19 (ten live lanes passed at `c0c36f69`, not listed one by one; the one later commit was not re-run live) and `test/telemetry-query.test.ts` 'reads the rotated generation before the current file'. The named screenshot is not retained.
- [x] Lane 7. Query with the text `(a+)+$`. Save `pc8-literal.png`. Pass when it answers in under one second and matches only that literal text. Evidence: PR #19 (ten live lanes passed at `c0c36f69`, not listed one by one; the one later commit was not re-run live) and `test/telemetry-query.test.ts` 'treats a ReDoS-shaped pattern as a literal and finishes quickly'. The named screenshot is not retained.
- [x] Lane 8. Throw an error in the page. Save `pc8-client.png`. Pass when `logs_query` on `client-errors` returns it. Evidence: PR #19 (ten live lanes passed at `c0c36f69`, not listed one by one; the one later commit was not re-run live). This holds for the dashboard page; the canvas page reports no browser errors (closing live check, 2026-11-13). The named screenshot is not retained.
- [x] Lane 9. Start the server with no `CODEMAN_LOG_DIR`. Save `pc8-nodir.png`. Pass when the route answers with an empty list and a reason. Evidence: PR #19 (ten live lanes passed at `c0c36f69`, not listed one by one; the one later commit was not re-run live) and `test/telemetry-query.test.ts` 'returns an empty list and a reason when no directory is configured'. The named screenshot is not retained.
- [x] Lane 10. Call `logs_query` over stdio after a planted failing route. Save `pc8-diagnose.png`. Pass when the result holds the route's error line. Evidence: PR #19 (ten live lanes passed at `c0c36f69`, not listed one by one; the one later commit was not re-run live). The closing live check, 2026-11-13 found that a canvas 5xx writes no server log line, so the same diagnosis is only partial for canvas routes; see Close the program. The named screenshot is not retained.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. Median latency of `GET /api/status` under 200 requests per second at trunk and head, with logging on. Trunk lacks the query, so also measure one query over a full 20 MiB file. Evidence: PR #19: `/api/status` median 4.4% faster than trunk; a 20 MiB log query p95 of 1.11 s.
- [ ] Probe. A load script runs 30 seconds per build, interleaved, then runs the query ten times. Open: the PR reports the results, but the probe scripts, run counts and interleaving are not recorded.
- [x] Baseline. Record the trunk median first. Evidence: PR #19 reports the head relative to trunk.
- [x] Rule. Fail when the head median exceeds trunk by more than 5 percent, or when the query p95 exceeds 2 seconds. Evidence: PR #19: 4.4% faster against a +5% limit, and 1.11 s against 2 s.

**Review gate.** None. PC8 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA. Open: the verdict (ten lanes, perf, three audits) is recorded at `c0c36f69`. The merge head `c08253ee` added one fix whose live lanes were not re-run (PR #19).
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged. Open: no record of a rebase after the verdict or of a patch-id check; the PR was squash-merged onto `master`.
- [x] The coordinator records PC8 as verified, lands the PR and deploys automatically after the final-head checks pass, then verifies the live result. Evidence: PR #19 merged as `3942d156`, and the supervisor's deploy record shows that commit deployed with outcome success on 2026-11-11. A check of the live result beyond the supervisor's health check is not recorded.

## Ambient assistant, direct context and model routing (PC9)

**Depends on.** PC2, PC4 and PC6. This is added design scope; detailed implementation planning must precede code.

- [x] Keep addressable real session records and one transcript owner. Present foreground chat in a thin 320-pixel right rail; collapse it to zero with no leftover card or reserved width. Opening/hiding does not change canvas position or selection. Do not implement the superseded floating conversation card. Evidence: `test/canvas-conversations.test.ts` 'starts one claude session through the create path with no respawn, auto-resume or Ralph field'; `test/canvas-context.browser.test.ts` 'C toggles the assistant five times with the camera, selection and board unchanged and the closed rail zero wide' (the test that flaked once in the final-head browser run); the rail measured 320 open and 0 closed in the closing live check, 2026-11-13.
- [ ] Project native prompts, agent replies, tool results, questions, waiting/running/stopped/error states and supported approvals into the conversation. Specify adapter gaps honestly before implementation; keep the unmodified Claude Code integration and existing session continuity. Open: prompts, agent replies, questions and approvals, and the working, waiting, ended and failed states are projected (`test/canvas-assistant.browser.test.ts`, PR #28 live against real Claude). Tool result rows are not built (journal 2026-11-12, PC9b).
- [x] Hide, summon and switch rail views without changing or cancelling the underlying session. Preserve draft, attachments and origin. Nonmodal help, object threads and task details use the same rail; no context or assistant control creates a blocking overlay. Evidence: `test/canvas-viewport.test.ts` 'overlays and unwinds rail views without changing the camera or selection'; `test/canvas-context.browser.test.ts` 'reload restores the chips and the draft, per viewer and workspace'; `test/canvas-threads.browser.test.ts` 'Open conversation shows that same session in the rail without moving the camera or selection, with a backlink'; the draft and chips survived rail toggles in the closing live check, 2026-11-13.
- [x] Add selected objects/containers with Cmd/Ctrl+Enter or the selection action. Hold Q and primary-drag a lasso to preview and capture actual enclosed object IDs; define center hit testing, deduplication, explicit-container membership and coordinate transforms. Chips are directly removable. Do not add an attachment picker or modal. Record the references and actual supplied content versions with the sent message. Selection elsewhere does not silently mutate attachments. Whole-canvas discovery remains available through tools. Evidence: `test/canvas-context.browser.test.ts` ('circling three notes with Q held adds three named chips…', 'a lasso at 50 and 200 percent zoom after a pan captures what canvas_query reports for the same loop', 'Cmd/Ctrl+Enter and the selection row add context and focus the composer without sending'), `test/canvas-context-resolve.test.ts` 'writes the block format, records revisions…'; lassos, attachment history records and whole-canvas discovery passed in the closing live check, 2026-11-13.
- [ ] Removing a chip affects the next request, not material already supplied. Offer New conversation for a fresh transcript. Sources used is a disclosure inside the conversation, not metadata stamped over the board. Open: chip removal and New conversation are built (`test/canvas-context.test.ts`, `test/canvas-assistant.browser.test.ts`), but no surface is named Sources used. The per-message context line stands in for it by decision (journal 2026-11-12, PC9b), and later reads by the agent are not shown.
- [x] Preserve drafts, attachments and focus across collapse, reconnect and app releases. Deduplicate request retries. Canvas keys never intercept message entry or IME. Show failures in the owning conversation and keep a labeled Send alternative. Evidence: `test/canvas-context.browser.test.ts` ('reload restores the chips and the draft, per viewer and workspace', 'typing "quick cat" in the composer or in outline search toggles nothing and arms nothing'); `test/canvas-assistant.browser.test.ts` ('a failed send keeps the draft and chips, offers Retry, and the retry reuses the message id', 'Enter during IME composition and Shift+Enter never send'). Across a release this rests on the reload path; the closing live check, 2026-11-13 saw the session carried over a supervised deploy.
- [x] Support the phone assistant view and its software-keyboard-aware composer through the same session. Show keyboard scope and attachment behavior explicitly. Evidence: `test/mobile/canvas-assistant.test.ts` ('keeps the composer and selectors above the software keyboard', 'takes Return as a line break and sends only from the Send button, through the same routes'); it passed in the final-head phone canvas run on the merged tree (43 of 43). PR #30 checked it on a real iPhone at merge time; the closing live check used no real phone keyboard.
- [x] Populate provider/model controls from actual configured adapters and their supported catalogs; choices target a subsequent new run or a natively supported model change with explicit attribution. Unsupported choices and new-session routing are inline, not modal. Evidence: `test/canvas-providers.test.ts` and `test/canvas-conversation-providers.test.ts`; as decided in `intent/2026-11-12-canvas-pc9c-providers.md`, the model is free text with suggestions because the registry has no catalogue, and a choice applies to the next new conversation, whose agent rows are labelled with provider and model. An in-place model change is not offered, so there is no per-turn attribution for one. PR #30 live run with real Claude.
- [x] Implement the scoped shortcut map and a filterable nonmodal cheatsheet available by ?/F1. Preserve browser/OS and editing/IME keys; disable/remap single-letter bindings. Evidence: `packages/canvas/src/shortcuts.ts`, the Keys view with its search field in `src/web/public/canvas.html`, `test/canvas-view.browser.test.ts` 'suppresses shortcut letters, spaces and IME in search and on native controls', `test/canvas-threads.browser.test.ts` 'F1 opens Keys while typing in the thread composer…'. A switch turns the single-letter bindings off; remapping them is not built.
- [ ] Verify full collapse/reopen without camera change, selection and lasso context, one-session identity, broad canvas reading, input isolation, retained failed drafts, deduplicated send, provider attribution and session continuation across a supervised release. Cancel lasso on early hotkey release, Escape, pointer cancellation, lost capture and blur. Run the same independent review and final-head merge/deploy verification policy as the foundation PRs. Open: each item but one has a test and a live run (PRs #26, #28 and #30, one independent audit each; `test/canvas-context.browser.test.ts`, `test/canvas-context.test.ts` 'a key release, Escape and every cancel reason end the gesture with no capture', `test/canvas-assistant.browser.test.ts`). Session continuation across a supervised release was seen for a session in the closing live check, 2026-11-13, but not specifically for a canvas conversation with its rail rebinding.

## Connected threads and self-building workflow (PC10)

**Depends on.** PC9 and PC6. This is added design scope; detailed implementation planning must precede code.

- [x] Post remains an ordinary comment. Ask agent is an explicit request bound to the object, thread and a chosen existing or new real session. A comment or mention alone never starts unexpected agent work. Evidence: `test/canvas-thread-requests.test.ts` 'an ordinary comment starts no agent work and records no request'; `test/canvas-threads.browser.test.ts` 'Ask agent posts the comment, starts a conversation from the thread and sends it with the object and the origin'; PR #31 live runs against real Claude.
- [x] Route replies back to the originating thread, with stable request/origin IDs and deduplication. Open conversation presents that same session in the assistant rail and keeps a backlink to its origin. Another open thread or selection cannot reroute a running task. Evidence: `test/canvas-thread-requests.test.ts` ('routes by the recorded origin: two requests in one conversation reach their own threads', 'finds a comment already posted under the request id and records it without posting again'); `test/canvas-threads.browser.test.ts` ('a reply is routed by the recorded origin, not by the thread that is open', 'Open conversation shows that same session in the rail … with a backlink').
- [x] Expose supported object operations to agents so they can help arrange the workspace with ordinary authorship, undo and stable focus. Do not silently add arbitrary plugin installation or a general tool builder. Evidence: the arrange, transform, lock and history tools from PR #20 (`test/mcp-canvas-tools.test.ts` 'exposes arrangement, transform, lock, spatial query, history and capabilities through the same path'); agent writes carry the session as author and never take focus (`test/canvas-context.browser.test.ts`). No plugin installer or tool builder was added.
- [ ] Keep app-change requests, previews, verification and release outcomes within the conversation that initiated them. Use the existing supervised deploy path; preserve the session and workspace across the release. Do not make the canvas a second deployment control plane. Open: no deploy control was added and a conversation is a real session in the case, which `intent/2026-11-12-canvas-pc10-threads.md` treats as sufficient. Nothing shows a release outcome in the conversation beyond what the agent writes, and no release started from the canvas was observed.
- [ ] Verify ordinary comment versus explicit invocation, originating-thread reply routing, the same session in both views, safe draft/input behavior, recoverable agent layout changes and a bounded self-building change initiated from the canvas. Elaborate isolated test fixtures and safe cleanup before running the release-continuity scenario. Open: everything except the last item is verified (PR #31: three live runs against real Claude, one independent audit; `test/canvas-thread-requests.test.ts`, `test/canvas-threads.browser.test.ts`). A bounded self-building change initiated from the canvas, with its release-continuity fixtures, was not run.

## Voice input and conversation (PC11)

**Depends on.** PC9. Detailed audio/capability planning precedes implementation.

- [x] Provide distinct dictation and voice-conversation controls and bindings. Dictation edits a draft; conversational voice submits explicit speech turns and supports playback interruption. Never overload one key with both toggle and hold-to-talk behavior.
- [x] Define a verified microphone/transcription/playback or realtime adapter for the selected configuration. Do not assume all CLI subscriptions support realtime audio. Unsupported capability and denied permission remain inline with text available.
- [x] Show truthful recording/processing/speaking/muted/error states. Active microphone capture retains a minimal stop indicator even with the assistant rail hidden; background agents cannot activate it.
- [x] Bind each spoken turn to its committed canvas references, preserve request/provider attribution and support cancel/retry without duplicate work. Desktop and phone keyboard/touch controls must both work.
- [x] Verify permission denial, absence of a device, interruptions, network loss, key repeat, IME/text isolation, capture termination and hidden-rail microphone visibility using controlled fixtures before any manual recording exercise. The design prototype's microphone-disconnected state is not audio verification.

## Background agent lifecycle (PC12)

**Depends on.** PC9 and a verified isolated-session launch path.

- [x] Run in background explicitly creates one named child task with origin, context snapshot and provider/model. Return canvas control immediately; do not replace the foreground conversation. Evidence: `test/canvas-task-routes.test.ts` 'makes a worktree of the case, starts one session in it, records the task and sends the request once'; `test/canvas-tasks.browser.test.ts` 'runs the draft and its context as a named task in its own worktree, and leaves the foreground alone'; PR #33 live runs with real Claude sessions.
- [x] Isolate code-editing tasks in worktrees or an equivalent verified boundary. Keep request/session IDs, authorship and per-task outputs so parallel actors never share an editing checkout by accident. Evidence: `test/canvas-task-routes.test.ts` ('in a git case, sharing is never used: the task still gets its own worktree', 'in a folder that is not a git repository, refuses until the person agrees to share the case folder'); isolation and parallel tasks passed live in PR #33.
- [x] Expose queued, running, waiting-for-user, completed, failed and cancelled states in the nonmodal task rail. Keyboard G opens it; Cmd/Ctrl+Shift+Enter runs the drafted request. Inspect and Cancel act only on the chosen child. Evidence: `test/canvas-tasks.test.ts` 'reaches all six states and only those'; `test/canvas-tasks.browser.test.ts` ('G opens the task list from the canvas only…', 'Inspect shows the task session in the assistant rail without moving the camera', 'Cancel stops only that task…'), which also presses Ctrl+Shift+Enter to run the draft.
- [x] Keep questions and results connected to their request, with artifact links and bounded notifications. Closing the assistant does not cancel tasks; changing provider/model does not retarget existing runs. Reconnect/retry deduplicates task creation and restores ownership. Evidence: `test/canvas-task-routes.test.ts` ('a retry with the same request id returns the same task and starts nothing more', 'a task asked from a thread posts its reply there once and links back'); `test/canvas-tasks.browser.test.ts` 'shows waiting for you, then the result when the turn ends, and counts it quietly until the list is opened'. As decided in `intent/2026-11-13-canvas-pc12-background.md`, the links are to the snapshot's objects and the originating thread, and the notification is a quiet count.
- [x] Verify isolation, per-task cancellation, retry deduplication, foreground continuity, context/provider snapshots, result routing and recovery from a waiting/failed child. The prototype's queued example rows are not real agent verification. Evidence: PR #33 (two live runs with real Claude sessions in throwaway repositories: isolation, parallel tasks, cancel, waiting-for-you, remove, dedupe, cap, restart during a task, abnormal exit, phone; one independent audit). Not observed live: the partial-result label after an abnormal exit and the 30-second quiet rule after a restart (unit tests only).

## Make the canvas the shell (PC13)

**Depends on.** PC10, PC11 and PC12. This is added design scope. A shape pass and detailed implementation planning must come before code.

Until PC13, the canvas is a `managed` web tab inside Codeman's dashboard. PC13 turns that around: Codeman opens on the canvas, everything Codeman does is reachable from it, and the tab dashboard becomes a fallback view.

- [x] Run `/impeccable shape` for the canvas shell before implementation. Inventory every dashboard surface (tab strip, sidebar and rail, tab groups, session terminals, the file preview, the Files and Git panels, App Settings, the approvals inbox, notifications, Cmd+K, case management, the phone overview and keyboard) and give each one a home on the canvas, in the outline, in the assistant rail, or in the classic view. Add the result to `canvas-ui-ux-brief.md`. Pass when no current surface lacks a home. Evidence: the section "Canvas shell (PC13)" of `canvas-ui-ux-brief.md` (65 surfaces, each with a home) and the implementation scope in `intent/2026-11-13-canvas-pc13-shell.md`.
- [x] Make the canvas the landing page. With the shell on, `/` opens the canvas of the last-used workspace, and the outline switches workspaces and cases. A new workspace starts from the outline, not from a tab. Evidence: `test/shell-landing.test.ts`, `test/canvas-shell-routes.test.ts`, `test/canvas-shell.browser.test.ts`; live check on a throwaway instance (landing, workspace create and switch, last workspace restored after reload).
- [x] Make every session reachable from the canvas. Terminals, rail conversations and background tasks each have one canvas representation and one full view. Opening a session's full view and closing it returns to the canvas with the camera, selection and rail state unchanged. A session keeps its single transcript owner and its existing input path; the shell adds no second write path to a pane. Evidence: `test/canvas-shell-sessions.test.ts`, `test/canvas-full-view.browser.test.ts`; live check (typed command read back from the pane, camera, selection, rail and draft unchanged after close, ten open and close cycles with no leaked frame or listener). Working, Waiting and Needs you rows were covered by unit tests only.
- [x] Keep the classic dashboard reachable at its own route as a fallback, on the same server and the same state. Switching between the two loses no session, draft or tab layout. Keep the dashboard code intact rather than deleting it, so upstream Codeman releases still merge. Evidence: `/classic` in `test/canvas-shell-routes.test.ts` (requests no canvas file); live check with a dashboard and a full view open on one session.
- [x] A broken canvas bundle must not lock the owner out. If the canvas page fails to load or render, `/` falls back to the classic view with a visible notice, and the classic route never depends on the canvas bundle. The shell switch survives a blue-green deploy and a rollback. Evidence: `test/canvas-boot-guard.test.ts`, `test/canvas-shell-compat.test.ts`; live check with the bundle blocked, throwing and removed, scripts disabled and offline, each with at most one automatic navigation; a reload of `canvas/<id>` with a file missing goes to `/`.
- [x] Gate the shell behind its own setting, default off, independent of `canvasEnabled`. The canvas tab keeps working with the shell off. Turn the shell on by default only after the close-the-program gate passes on the deployed build. Evidence: `test/canvas-setting.test.ts`, the four setting combinations in `test/canvas-shell-routes.test.ts`; live check with the shell off (`/` equal to `/classic`, byte for byte). Default-on is the last box of **Close the program**.
- [x] On the phone, the canvas home replaces the phone overview. It keeps reading, conversation and comments from PC6 and PC9, and it keeps a route to a session's terminal and the mobile keyboard. Evidence: `test/mobile/canvas-shell.test.ts`; live check at 390×844 touch (session page and back with the camera restored, one-use return ticket).
- [x] Verify with the shell on: landing on the canvas, switching workspaces from the outline, opening and closing a terminal's full view without camera change, every inventoried surface that the brief does not mark classic-only reachable without the classic view, every classic-only surface reachable from the canvas through the classic link, a deliberately broken canvas bundle in a throwaway instance falling back to the classic view, and the same sessions visible from both views. Verify at laptop and phone sizes. Run the same independent review and final-head merge and deploy policy as the other PRs. Evidence: live check of `1a69836e` at laptop and phone sizes, with a password and under a base path, no blocker; two independent audits, the second of the fix rounds, all findings fixed in fix rounds 1 to 3; on the final head the deploy gate (751), the canvas browser suite (188 of 189, the one failure a timing flake that also fails on the PC12 commit) and the phone canvas suite (43) pass. The inventory's surfaces were sampled in the live check, not walked one by one; multi-user mode and a real notification click were not exercised live.

## Close the program

- [ ] Every box above is checked with its evidence. Open: see "Open at close (2026-11-13)" below for every box that is still open.
- [x] The coordinating agent runs the phase gate on the deployed build through browser automation at laptop and phone sizes. No manual user step is required. Evidence: run on the deployed build on 2026-11-13; all six items below pass. The planted-fault item passed on a throwaway instance after PR #35.
  - [x] On the laptop viewport, build a section named "design exploration" with images, text, links, a website embed and two frames. Evidence: closing live check, 2026-11-13: the section was built by hand on the deployed build with images, text, links, a live embed and two frames.
  - [x] In an agent session, read the section with one `canvas_read` call and one `canvas_screenshot` call; compare the answer with its contents. Evidence: closing live check, 2026-11-13: one `canvas_read` and one `canvas_screenshot` by an agent session matched the section.
  - [x] Have the agent add a summary block. Assert it appears on the open canvas with the agent as author. Evidence: closing live check, 2026-11-13: the agent's summary block appeared on the open page with the agent as author.
  - [x] On the phone viewport, view the section and add a comment. Evidence: closing live check, 2026-11-13: a comment added at the phone size showed on the laptop page.
  - [x] Revert the agent session, and assert only the summary block goes. Evidence: closing live check, 2026-11-13: reverting the agent session removed only the summary block.
  - [x] Plant a failing request in a throwaway instance and diagnose it with `logs_query`. Never inject the fault into production. Evidence: the first run on 2026-11-13 found the failing request but not its cause, because a canvas 5xx wrote no server log line and the canvas page reported no browser errors. PR #35 fixed both. The rerun on a throwaway instance read a read-only operation log back as one `server` line naming the route, `EACCES` and the request id from the HTTP answer, and an error thrown in the canvas page appeared in `client-errors`.
- [ ] Verify the complete foundations matrix, including nested selectable group context, selection lassos, resize, locks and one-to-one human/agent command behavior. Static design checks do not satisfy these implementation requirements. Open: verified live on 2026-11-13 for nested group context, both lassos, resize, locks and twin canvases over about 30 mirrored operations. The matrix is not complete: a human capture or export of a view or group is not built, flip is unsupported, and one defect stands (reordering an unlocked object is refused when a sibling is locked). The repeated-undo defect was fixed in PR #37.
- [ ] Before declaring the clarified product complete, verify the ambient rail, connected thread, voice, background tasks and the canvas shell against PC9–PC13, with attachment changes that do not erase earlier history, whole-canvas discovery and self-building continuity. The original foundation gate alone is insufficient. Open: the rail, lassos, attachment history, whole-canvas discovery, the shell and its fallbacks passed live on 2026-11-13, and the last supervised deploy carried its session over. Not exercised: voice with real audio, a real conversation turn in that run (PRs #28, #30, #31 and #33 each ran real Claude at merge time), multi-user mode, a real notification click, a real phone keyboard in that run (PR #30 used a real iPhone for the phone assistant only), contrast pairs, and a walk of all 65 inventoried surfaces. The one defect found, `W` ignored on a focused session row, was fixed in PR #37.
- [ ] Turn `canvasEnabled` and the PC13 shell setting on by default in a final PR after the gate passes. Verify, land and deploy it through the same automatic flow, then check that the live build opens on the canvas and the classic view is still reachable. Open: not done. Both settings still default off on `master`.
- [ ] Tick phase 1 in `TRACKER.local.md` and add a `docs/JOURNAL.md` entry. Open: not done. `TRACKER.local.md` is not committed and still shows phase 1 unticked, and `docs/JOURNAL.md` has no closing entry.
- [ ] Reply to the operator with each PR and its verdict, per `autopilot-stack.md`. Open: process step for the coordinator at close; not yet on record.

### Open at close (2026-11-13)

This reconciliation ticked 306 boxes and left 50 open, counted after PRs #35 and #37. Every open box is listed here once, with the section it comes from. A box that repeats in several sections is one line that names them all. Each open box above carries its own `Open:` note.

**Not built, or not built in full**

- PC8, Build. The `ui-events.jsonl` stream and its intake exist, but nothing in the canvas or the tab strip writes to it.
- PC9. Tool result rows are not projected into the conversation (journal 2026-11-12, PC9b).
- PC9. No surface is named Sources used. The per-message context line stands in for it by decision, and later reads by the agent are not shown.
- PC2, Build. The agent surface is not complete: starting a conversation, and starting, cancelling or removing a background task, are human-only by decision; voice is human-only; flip is unsupported.
- PC4, Build ("Exercise every required control"). The foundations matrix asks for a human capture or export of a view or group. It is not built. Flip is unsupported.
- PC10. Nothing shows a release outcome in the conversation beyond what the agent writes, and no release was started from the canvas.
- Close the program. `canvasEnabled` and the shell setting are not on by default on `master`. PR #36 holds the change and waits for the owner's decision.

**Built but not verified live**

- PC4, Lane 10. Run with a plain API writer, not an agent session.
- PC5, Verify perf (Metric and Rule, two boxes). The 500-object comparison with the PC4 head and the 100-image, six-embed fixture were not measured; the one reported figure is 60 fps on a different fixture.
- PC5 and PC6, Review gate (two boxes). No design-review verdict against the shaped brief is recorded.
- PC9, Verify. Session continuation across a supervised release was not shown for a canvas conversation with its rail rebinding.
- PC10, Verify. A bounded self-building change initiated from the canvas was not run.
- Close the program (PC9 to PC13). Not exercised by anyone: voice with real audio, multi-user mode, a real notification click, contrast pairs, and a walk of all 65 inventoried surfaces. Not exercised in the closing run: a real conversation turn (real Claude ran at merge time in PRs #28, #30, #31 and #33) and a real phone keyboard (a real iPhone was used once, for the phone assistant in PR #30).

**Known defects, not fixed on `master`**

- PC4, Build (grouping and order). Reordering an unlocked object is refused when a sibling is locked.
- Close the program (foundations matrix). Open because of the PC4 defect above and the missing human capture or export.

**Process**

- Program checklist, Arm. The per-turn audit did not keep this checklist in step with the PRs.
- Program checklist, Spawn owners. No record of each owner's session, dependencies and status.
- Program checklist, Spawn owners. The file boundaries were not held as written.
- Program checklist, Spawn owners. The design-review gate is recorded for PC3 and PC4 only.
- Program checklist, PR mechanics. `test/canvas-shell-compat.test.ts` is not in `deploy/test.sh`.
- Program checklist, PR mechanics. `docs/architecture-invariants.md` says twenty-six MCP tools; the server lists twenty-nine.
- Program checklist, Verdict and merge. The full swarm (ten lanes, perf lane, two audits) was not run as written for every PR.
- Program checklist, Verdict and merge. PRs were squash-merged, which does not preserve branch history.
- Program checklist, Boot recipe. The lane screenshots this plan names are not retained.
- PC1, PC2, PC4, PC5, PC6, PC7 and PC8, Verify perf (Probe, seven boxes). Results are reported, but the probe scripts, run counts and interleaving are not recorded.
- PC1 to PC8, Merge ("Rebased … patch-id unchanged", eight boxes). No record of a rebase after the verdict or of a patch-id check.
- PC4, PC5 and PC6, Review gate (video, three boxes). No video is recorded.
- PC5, PC6 and PC8, Merge ("Root's clean verdict at the exact head SHA", three boxes). PRs #25 and #24 name no head SHA; PC8's verdict is at the commit before its merge head.
- Close the program. "Every box above is checked" stays open while this list is not empty.
- Close the program. Phase 1 is not ticked in `TRACKER.local.md`, and `docs/JOURNAL.md` has no closing entry.
- Close the program. The reply to the operator with each PR and its verdict is not yet on record.

## Appendix A. Prototype evidence

These are historical observations, not proof that the shaped UI is complete or that an external review tool is secure. Use native document review for feedback; do not make Plannotator a prerequisite.

One question was settled by a run. Three stay unproven, and the plan orders its PRs so each is tested early.

- **Proven. A web tab can host a tool that checks request origin.** Plannotator rendered in a sandboxed frame through `/webview/<cap>/`, and its submit got 403 on the live build and 200 on branch `fix/webview-fetch-site` at `9c6ecf73`. The change is PR 10 of this repository.
- **Unproven. A hand-built DOM canvas feels good enough.** No canvas prototype was built. Shape must compare renderer options before implementation. PC3 and PC4 then test the selected approach against the shaped brief through agent design review. If it fails, revisit the renderer; tldraw is a candidate subject to the constraints below, because PC1 and PC2 do not depend on the renderer.
- **Unproven. A same-origin canvas page works as a `managed` web tab.** PC3 lane 1 and lane 8 test it. The fallback is a `canvas` ref kind in the tab layout, which changes `src/tab-layout.ts` and three browser files.
- **Unproven. The canvas bundle renders in a network-disabled puppeteer page.** PC7 lane 2 tests it.

## Appendix B. Previous implementation choices to revisit during shape

- **tldraw SDK.** It has the best editor and an explicit `parentId`. Its licence is proprietary, production use needs a key, the free hobby key requires a watermark, and every person who forks this public repository would need their own key. It also keeps its own store, so the operation log would be a second copy.
- **Excalidraw.** It is MIT. Its frames do not nest, and it draws to a canvas element, so iframes are an overlay and drop out of exports.
- **React Flow.** It is MIT and DOM-based. It brings React and a graph model of edges and handles that the vision does not use.
- **Yjs or Automerge as the store.** The vision names a CRDT log. One user and server-side agent writes do not need one. A server-ordered log gives replay, author and per-author revert directly. Automerge would also need a wider script policy for WebAssembly. A CRDT can be added later for one field, shared text editing, without changing the log.
- **A first-class canvas tab kind.** Tab layout refs are a closed union of `session` and `webview` on the server and in the browser. Hosting the canvas as a web tab avoids that change.
- **A workspace marker file inside the case folder.** It would travel with a folder move. It would also put an untracked file in every user repository, so the registry in the data directory won.
- **One plan for all six phases.** Later phases depend on what PC3 and PC4 show. Appendix E lists them without boxes.

## Appendix C. Risks

- **Interaction polish takes longer than planned.** Shape sets the interaction scope and acceptance criteria before implementation. PC4 implements that scope; the coordinator resolves gaps against the brief rather than adding unplanned features.
- **The data directory backup grows with images.** It lands in PC5. The supervisor copies the data directory before every deploy. The owner sets a per-image and a per-workspace size cap and reports the directory size.
- **Both colours open the log during a deploy.** It lands in PC1. Lane 9 and the promote reload guard it.
- **Session identity is a self-declared header in single-user mode.** It lands in PC2. Workspace scope stops mistakes, and it does not stop a hostile agent. All sessions already run as one OS account.
- **No control skill is installed for the browser or the CLI.** `control-ui` and `control-cli` are not on this machine. Every lane drives Playwright, `curl` or `codeman mcp` on stdio as the boot recipe says.
- **Lane models differ from the playbook default.** The Agent tool here offers Claude models only, so lanes run on `claude-sonnet-5-5`.
- **`npm test` cannot see browser and mobile tests.** PC3 to PC6 run `test:browser` and `test:mobile` by hand and compare the failure list with trunk.
- **A redaction rule misses a secret shape.** It lands in PC8. The owner adds each shape found in a real log as a test case.

## Appendix D. Links and reading list

- Read `docs/agentic-canvas/coding-agent-brief.md`, `minimal-version-prd.md`, `vision.md`, `canvas-design-references.md`, `canvas-ui-ux-brief.md` and `canvas-foundations.md` before any PR.
- Read `docs/self-building.md` before any change to stored data or `deploy/`.
- Read `src/web/CLAUDE.md` before PC3 to PC6, and the web tab and MCP sections of `docs/architecture-invariants.md` before PC2, PC3 and PC5.
- Run `~/.claude/skills/how/SKILL.md` on PC1, because every later PR depends on its data shape. Run `~/.claude/skills/interrogate/SKILL.md` on PC1's log format and on PC4's edit queue.
- Keep the decision trail per `~/.claude/skills/show-me-your-work/SKILL.md` in `TRACKER.local.md`, which is never committed.

## Appendix E. Phases after this plan

Each later phase gets its own plan when the gate before it passes. The Codeman parts it can build on are named.

- **Remaining phase 2 work.** The ambient assistant, direct context, explicit agent threads, voice and isolated background agents are now in PC9–PC12 under the owner's revised direction. A broad worktree/sandbox dashboard remains later work; required isolation for background code editing is included. A plain @mention no longer implicitly starts a session.
- **Phase 3, documents and live previews (D1, D2, P1 to P4).** A document object uses the file viewer's edit mode and saves with a commit. A live embed is a preview server shown as an `embed` object. Element comments need a script inside the proxied page.
- **Phase 4, records and internal tools (R1 to R4, I1 to I3).** PR and CI records come from `gh`. Internal tools are cases with their own repository and a preview.
- **Phase 5, the app builds its own shell (S1).** The self-building loop already exists. This phase moves it onto worktrees and a preview instance. "Shell" here means the deploy and control plane; making the canvas the UI shell is PC13.
- **Phase 6, operations (E1, E2).** Error records start an investigation session from the canvas.
