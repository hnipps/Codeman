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

- [ ] At program start, state the protocol and this plan, record the scoped execution authority, then complete the shape step before implementation. Continue without a separate approval checkpoint.
- [ ] Read these at program start. Re-read them when instructions change or work resumes after an interruption. The skills live in `~/.claude/skills` and not in this repository, so `git show origin/main:` does not apply to them.
  - [ ] `~/.claude/skills/poteto-mode/playbooks/autopilot-stack.md` and `autopilot-full.md`
  - [ ] `~/.claude/skills/swarm/SKILL.md`
  - [ ] `~/.claude/skills/poteto-mode/playbooks/opening-a-pr.md`
  - [ ] `git show origin/master:CLAUDE.md`, `git show origin/master:src/web/CLAUDE.md` and `git show origin/master:docs/self-building.md`
  - [ ] `git show origin/master:docs/agentic-canvas/coding-agent-brief.md`
- [ ] The coordinating agent drives bounded execution and follow-up turns for this program. Resume from the checklist after interruptions, reconcile worker and PR state before issuing more work, and stop scheduling work when the program finishes or Harry requests a hold. No recurring global automation is required.
- [ ] Run this audit at the start of every turn. Re-read the execution playbook. Compare the open PRs, their heads and their verdicts with this checklist and fix drift in the same turn. Then post a short status message that names only what changed since the last status message, such as a PR opened, a verdict or an unresolved blocker. Resolve routine implementation and design choices autonomously.
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] After shape, start one owner per ready PR using an available subagent or a Codeman worker session. The coordinator may send task prompts and follow-ups under this program's authorization. Record each owner's session, branch, worktree, dependencies and status; limit concurrency to available capacity.
- [ ] Give each owner its own git worktree at `.claude/worktrees/<pr-id>`, because the main checkout is shared with other sessions.
- [ ] Follow this dependency graph. A dependent PR is based on its parent's branch.
  - [ ] PC1 and PC8 are independent and first. Both branch from `master`.
  - [ ] PC2 after PC1.
  - [ ] PC3 after PC1.
  - [ ] PC4 after PC3.
  - [ ] PC5 after PC4.
  - [ ] PC6 after PC4.
  - [ ] PC7 after PC3.
  - [ ] PC9 after PC2, PC4 and PC6.
  - [ ] PC10 after PC9 and PC6.
  - [x] PC11 after PC9.
  - [ ] PC12 after PC9 and the existing isolated-session launch contract.
  - [ ] PC13 after PC10, PC11 and PC12.
- [ ] Scope PC9–PC12 with explicit session-adapter, request-origin, context-delivery, voice-capability and isolated-task contracts, source ownership, tests and compatibility checks before assigning owners. No owner edits a shared session module concurrently.
- [ ] Hold the file boundaries. PC1 touches only `src/canvas/**`, `src/web/routes/canvas-routes.ts`, the server wiring and their tests. PC3 to PC6 touch only `packages/canvas/**`, `src/web/public/canvas*`, the build scripts and their tests. PC8 touches only `src/telemetry*.ts`, its route and the MCP tool.
- [ ] Verify the shaped dark theme and keyboard flows in PC3 through PC6. Exercise focus, selection, editing, undo and escape without a mouse, confirm shortcut suppression in text editors, terminals and embeds, and capture dark desktop and phone evidence.
- [ ] Hold the agent design-review gate. PC3, PC4, PC5 and PC6 need screenshots and a video checked against the shaped brief by a reviewing agent. The coordinator fixes findings and proceeds when that review passes; no operator click is required.
- [ ] Keep every canvas route, tool and tab behind the synced setting `canvasEnabled`, default off, until the phase gate in **Close the program** passes.

### PR mechanics, for every PR

- [ ] Use `gh` for every PR operation. Never require `gt`.
- [ ] Start the change with `intent/<yyyy-mm-dd>-<slug>.md`, copied from `intent/TEMPLATE.md`.
- [ ] Open the PR ready, never draft, with `gh pr create --base <base-branch>`. A stack child targets its parent branch.
- [ ] Run `npm run typecheck`, `npm run lint`, `npm run format:check` and `bash deploy/test.sh` once before the PR-facing push. Push with hooks on.
- [ ] Add each new test file that guards stored data to the list in `deploy/test.sh`. Rule 7 of `docs/self-building.md` allows the gate to check more.
- [ ] Update `CLAUDE.md`, `src/web/CLAUDE.md` and `docs/architecture-invariants.md` in the same change as the code they describe. Add a `docs/JOURNAL.md` entry when the change records a decision.
- [ ] Run `/deslop` before each commit and `/no-comments` before review.
- [ ] Read `git diff --cached` before every commit for anything that identifies the server.
- [ ] Rebase onto the parent branch before the code-ready report. Rebase again only at merge prep or on a conflict.

### Verdict and merge, for every PR

- [ ] A full swarm runs once, at the code-ready head, per `~/.claude/skills/swarm/SKILL.md`. It has one gates lane, the ten live lanes from the PR's **Verify, live** block, the perf lane from its **Verify, perf** block, and two audit lanes that read the diff and distrust the PR body. A rebase or a minor fix gets one verifier at the new head.
- [ ] Judge every finding by the blocking rule in `autopilot-full.md`. A failure on trunk behavior in the lane marked as the regression lane is recorded against trunk and does not block the PR.
- [ ] After verification passes at the final head, the coordinator lands the PR bottom-up in dependency order, preserving history. Recheck any changes introduced during merge prep before landing. Deploy the resulting commit automatically with `codeman-deploy "$(git rev-parse HEAD)"`, check the outcome and verify the deployed behavior before advancing.
- [ ] After each deploy, read the `outcome:` line and check telemetry and the deployed feature. On a rejected deploy, fix forward with a new commit. If a switched release misbehaves, use the supervisor rollback command, diagnose and fix forward. The coordinator performs this recovery without waiting for approval.

### Boot recipe, for every live lane

No cloud VM exists here. Each live lane runs a throwaway Codeman instance at the PR head on this machine and drives it with Playwright or `curl`.

- [ ] `git fetch origin <head-branch>` and check out the head SHA in the lane's own worktree.
- [ ] Start the server with `CODEMAN_INSTANCE=lane-<pr-id>-<n>`, a port found by binding port 0, and `CODEMAN_PASSWORD` unset. Wait until `/api/status` answers. Never start a server without `CODEMAN_INSTANCE`.
- [ ] Launch Chromium with `--no-sandbox`, `deviceScaleFactor` 1 and `LD_LIBRARY_PATH` set to the `libraryPath` in `~/.codeman/mermaid-runtime.json`.
- [ ] Deliver input only through Playwright page actions, the HTTP API or `codeman mcp` on stdio. Read state with `GET` routes and the files under the instance's data directory.
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report. For a lane with no page, open the route's JSON in the browser and capture that.
- [ ] Stop the instance by its pid and delete its `~/.codeman-lane-*` directory.

## Store the object model and the operation log (PC1)

**Depends on.** None.

**Files.**

- [ ] Create `src/canvas/model.ts`, `src/canvas/operations.ts` and `src/canvas/canvas-store.ts`.
- [ ] Create `src/canvas/workspace-registry.ts`.
- [ ] Create `src/web/routes/canvas-routes.ts` and `src/web/ports/canvas-port.ts`.
- [ ] Edit `src/web/schemas.ts`, `src/web/sse-events.ts`, `src/web/public/constants.js`, `src/web/server.ts`, `src/case-rename.ts` and `deploy/test.sh`.
- [ ] Create `test/canvas-operations.test.ts`, `test/canvas-store.test.ts` and `test/routes/canvas-routes.test.ts`.

**Build.**

- [ ] Define `CanvasObject` in `model.ts` with `id`, `type`, `parentId`, `order`, `position`, `content`, `author`, `createdAt`, `updatedAt` and `deletedAt`. `type` is one of `text`, `image`, `link`, `embed`, `group`, `frame`, `section` and `subcanvas`, and `content` is a union keyed by `type`.
- [ ] Define `Author` as a human user or an agent session id, and `Comment` with `id`, `objectId`, `author`, `text` and `createdAt`.
- [ ] Define `Operation` in `operations.ts` with a server `seq`, a client `opId`, `author`, `kind`, `objectId`, `patch` and `prev`. The kinds are `create`, `update`, `move`, `delete`, `restore`, `comment` and `revert`.
- [ ] Model group hierarchy, local/world bounds/transforms, sibling order and explicit lock state/mode for the foundation controls. Preserve child-local locks through inherited locks, reject cycles and define group-versus-frame resize behavior. Shared domain commands enforce locks/conflicts for human and agent callers alike.
- [ ] Write the pure `applyOperation(state, op)` and `invertOperation(op)`. A `move` that would make an object its own ancestor is refused. An unknown kind is skipped, so an older release can read a newer log.
- [ ] Write `revertAuthor(state, log, author)`. It returns inverse operations for one author and skips any field that a later author overwrote.
- [ ] Write `CanvasStore`. It appends to `dataPath('canvas/<workspaceId>/ops.jsonl')`, writes `snapshot.json` by tmp and rename at mode 0600, and replays the log from the snapshot's `seq` on load. A repeated `opId` returns the first result.
- [ ] Check `deployRole.allows('persist')` at every append and snapshot. Reload the store in `promoteToLive()` and flush it in `writeSharedState()`.
- [ ] Write `workspace-registry.ts`. It mints a workspace id per case in `dataPath('workspaces.json')`, and `case-rename.ts` re-keys the entry.
- [ ] Add the routes under `/api/canvas/:workspaceId`. `GET /objects` reads a container and its descendants in one call. `POST /ops` appends a batch. `GET /ops?since=<seq>` replays. `POST /revert` reverts one author. A non-live colour answers 409.
- [ ] Broadcast `canvas:changed` with the workspace id and the new `seq`, owner-scoped in `deriveSseHint()`.

**You see.**

- [ ] `POST /api/canvas/<id>/ops` with one `create` returns `{"success":true,"data":{"seq":1}}`, and `ops.jsonl` holds one line.
- [ ] After a restart of the throwaway instance, `GET /objects` returns the same tree.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `test/canvas-operations.test.ts` covers apply, invert, the cycle refusal, the unknown kind and `revertAuthor`. Run `npm test -- test/canvas-operations.test.ts`.
- [ ] `test/canvas-store.test.ts` covers replay from a snapshot, a torn last line, a repeated `opId` and a refused write on a candidate colour. Run `npm test -- test/canvas-store.test.ts`.
- [ ] `test/routes/canvas-routes.test.ts` covers each route, the 409 and owner scoping with `authUser` set. Run `npm test -- test/routes/canvas-routes.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-sonnet-5-5` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Create a shell session, send `echo ok` and read it back at trunk and head. Trunk has no canvas routes, so record that and gate the head's `POST /ops` answer. Save `pc1-regression.png`. Pass when both sides print `ok` and head returns `seq` 1.
- [ ] Lane 2. Create a section, a frame inside it and a text block inside the frame. Save `pc1-tree.png`. Pass when `GET /objects?root=<section>` returns all three with the right `parentId`.
- [ ] Lane 3. Move the frame under itself through the text block. Save `pc1-cycle.png`. Pass when the route refuses and the log gains no line.
- [ ] Lane 4. Send the same `opId` twice. Save `pc1-idempotent.png`. Pass when both answers carry the same `seq` and the log has one line.
- [ ] Lane 5. Kill the server after 50 operations and start it again. Save `pc1-restart.png`. Pass when the tree and the last `seq` match.
- [ ] Lane 6. Truncate the last log line by hand, then start the server. Save `pc1-torn.png`. Pass when the server loads every whole line and logs the torn one.
- [ ] Lane 7. Write as two authors, then revert one. Save `pc1-revert.png`. Pass when only that author's objects and fields return to their earlier values.
- [ ] Lane 8. Rename the case. Save `pc1-rename.png`. Pass when the same workspace id still returns the tree.
- [ ] Lane 9. Start the head as `CODEMAN_DEPLOY_ROLE=candidate` on the same data directory and post an operation. Save `pc1-candidate.png`. Pass when the answer is 409 and the log is unchanged.
- [ ] Lane 10. Run the trunk build against a data directory that the head wrote. Save `pc1-rollback.png`. Pass when trunk boots, lists sessions and ignores the `canvas` directory.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Server start to first `/api/status` answer at trunk and head. Trunk lacks the store, so also measure the p95 time of one append and the load time of a 10,000 object workspace.
- [ ] Probe. A script starts each build five times, interleaved, and times the first answer. A second script appends 10,000 operations and reloads.
- [ ] Baseline. Record the trunk start time first.
- [ ] Rule. Fail when the head start time exceeds trunk by more than 10 percent, when the p95 append exceeds 5 ms, or when the load exceeds 500 ms.

**Review gate.** None. PC1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The coordinator records PC1 as verified, lands the PR and deploys automatically after the final-head checks pass, then verifies the live result.

## Expose the canvas to agents through MCP (PC2)

**Depends on.** PC1.

**Files.**

- [ ] Edit `src/mcp-server.ts`.
- [ ] Edit `src/web/routes/canvas-routes.ts`.
- [ ] Edit `skills/codeman/reference/verbs.md`, `docs/api-reference.md` and `docs/architecture-invariants.md`.
- [ ] Create `test/mcp-canvas-tools.test.ts`.

**Build.**

- [ ] Expose the complete structured capability/state surface in `canvas-foundations.md`, beyond basic CRUD: viewport/selection, spatial queries, group/ungroup/nest/reparent, geometry/resize/transform, alignment/order, lock/unlock, clipboard/history and context/session actions. Human UI and MCP use the same domain handlers. Publish machine-readable schemas and supported operations per element type.
- [ ] Verify human/agent equivalents on equivalent fixtures, including locked-parent failures, nested groups, overlapping context targets and undo. New human-only controls cannot be declared complete while their agent counterpart is missing. View operations target explicit view IDs and do not let background writes steal human focus.

- [ ] Add five tools to `buildToolDefinitions()` and `createToolRunner()`. They are `canvas_read`, `canvas_search`, `canvas_create`, `canvas_update` and `canvas_delete`.
- [ ] Make `canvas_read` return a container and all its descendants as one nested tree with labels, grouping and URLs.
- [ ] Resolve the caller's workspace on the server from `X-Codeman-Parent-Session`, through the session's `workingDir` and the workspace registry. A tool call never names another workspace.
- [ ] Stamp every operation from a tool with the agent session as `author`.
- [ ] Return text only from `canvas_read`, like `read_output`, and cap its size with a `truncated` flag.
- [ ] Document the one-time `claude mcp add codeman` step in `verbs.md`. Auto-registration at launch is out of this PR.
- [ ] Update the invariant text that says the MCP server has ten tools.

**You see.**

- [ ] `tools/list` on `codeman mcp` names the five canvas tools.
- [ ] A Claude Code session in a pane answers "what is in the design exploration section" from one `canvas_read` call.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `test/mcp-canvas-tools.test.ts` covers each tool, the workspace resolution, the author stamp, the size cap and the unconfigured URL answer. Run `npm test -- test/mcp-canvas-tools.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-sonnet-5-5` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Call `list_sessions` over stdio at trunk and head. Trunk lacks the canvas tools, so record that and gate the head's `tools/list`. Save `pc2-regression.png`. Pass when both list sessions and head names five canvas tools.
- [ ] Lane 2. Call `canvas_create` for a text block. Save `pc2-create.png`. Pass when `GET /objects` shows it with an agent author.
- [ ] Lane 3. Call `canvas_read` on a section with a frame, two images and a link. Save `pc2-read.png`. Pass when one call returns the nesting, the labels and the URL.
- [ ] Lane 4. Call `canvas_search` for a word in one text block. Save `pc2-search.png`. Pass when it returns that object and its container path.
- [ ] Lane 5. Call `canvas_update` on a field a human wrote. Save `pc2-update.png`. Pass when the log holds both authors in order.
- [ ] Lane 6. Call `canvas_delete`, then restore over HTTP. Save `pc2-delete.png`. Pass when the object is soft-deleted and then returns.
- [ ] Lane 7. Call a tool from a session whose folder is another case. Save `pc2-scope.png`. Pass when it reads only its own workspace.
- [ ] Lane 8. Run `codeman mcp` with no URL. Save `pc2-unconfigured.png`. Pass when the tools list and each call answers how to configure it.
- [ ] Lane 9. Read a section with 2,000 objects. Save `pc2-large.png`. Pass when the answer is capped and carries `truncated`.
- [ ] Lane 10. Use the legacy `initialize` handshake. Save `pc2-legacy.png`. Pass when the canvas tools list and one call succeeds.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Round-trip time of `list_sessions` over stdio at trunk and head. Trunk lacks the canvas tools, so also measure `canvas_read` on a 500 object section.
- [ ] Probe. A script sends each call 50 times, interleaved between the two builds.
- [ ] Baseline. Record the trunk `list_sessions` median first.
- [ ] Rule. Fail when the head median exceeds trunk by more than 10 percent, or when the `canvas_read` p95 exceeds 300 ms.

**Review gate.** None. PC2 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Rebased onto the PC1 branch after the verdict, patch-id unchanged.
- [ ] The coordinator records PC2 as verified, lands the PR and deploys automatically after the final-head checks pass, then verifies the live result.

## Show the canvas in a tab, read-only (PC3)

**Depends on.** PC1.

**Files.**

- [ ] Create `packages/canvas/` with `src/entry.ts`, `src/viewport.ts`, `src/render.ts` and `src/sync.ts`.
- [ ] Create `scripts/build-canvas-bundle.mjs` and `src/web/public/canvas.html`.
- [ ] Edit `scripts/build.mjs`, `scripts/postinstall.js`, `package.json`, `src/web/server.ts` and `src/web/public/session-ui.js`.
- [ ] Create `test/canvas-viewport.test.ts` and `test/canvas-view.browser.test.ts`. Add the browser test to `BROWSER_TEST_GLOBS` in `config/test-suites.ts`.

**Build.**

- [ ] Start with the proposed plain-DOM renderer, with positioned objects in a transformed layer. Verify the shaped pan, focus and density behavior before committing to it; a different renderer must preserve the same model and acceptance criteria.
- [ ] Write the pure `viewport.ts` for pan, wheel zoom about the pointer, and pinch zoom.
- [ ] Write `render.ts`. It keys elements by object id, nests a child inside its container's element, and renders text through `textContent`.
- [ ] Write `sync.ts`. It loads `GET /objects`, listens for `canvas:changed`, and fetches `GET /ops?since=<seq>` when the event's `seq` is ahead. A reconnect refetches from the last `seq`.
- [ ] Bundle the package to one ES module with esbuild, in dev from `postinstall.js` and in prod from `build.mjs`, like the gesture bundle.
- [ ] Serve `canvas.html` at `/canvas/:workspaceId` behind the normal login, and open it as a `managed` web tab named after the case. The tab strip, the rail, tab layouts and Alt+N then need no change.
- [ ] Implement the collapsible outline with search, read-only focus panel and Keys from the shaped brief. Remove the top navbar and persistent board metadata; expose author/count/details through selection or menus. Track keyboard focus separately from selection and preserve both across agent writes.
- [ ] Add **Open canvas** to the case picker, shown only when `canvasEnabled` is on and never as a header button on phones.

**You see.**

- [ ] A tab named after the case shows the workspace's objects, and the wheel zooms about the pointer.
- [ ] An object that an agent creates through `canvas_create` appears within one second without a reload.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `test/canvas-viewport.test.ts` covers the zoom anchor, the zoom limits and the screen to canvas mapping. Run `npm test -- test/canvas-viewport.test.ts`.
- [ ] `test/canvas-view.browser.test.ts` covers the nested render and the live update. Run `npm run test:browser -- test/canvas-view.browser.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-sonnet-5-5` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Open a saved web tab and switch back to a session at trunk and head. Trunk lacks the canvas tab, so record that and gate the head's canvas tab render. Save `pc3-regression.png`. Pass when the terminal returns on both and the head canvas shows its objects.
- [ ] Lane 2. Open a workspace with a section, two frames and six objects. Save `pc3-render.png`. Pass when each child sits inside its container's element.
- [ ] Lane 3. Zoom with the wheel over one object. Save `pc3-zoom.png`. Pass when that object stays under the pointer.
- [ ] Lane 4. Post a `create` over HTTP while the tab is open. Save `pc3-live.png`. Pass when the object appears within one second.
- [ ] Lane 5. Stop the SSE stream for 10 seconds while 5 operations land. Save `pc3-resync.png`. Pass when all 5 appear after the reconnect.
- [ ] Lane 6. Put `<img onerror>` markup in a text block. Save `pc3-inert.png`. Pass when it shows as text and no script runs.
- [ ] Lane 7. Turn `canvasEnabled` off. Save `pc3-off.png`. Pass when the menu entry is gone and `/canvas/<id>` answers 404.
- [ ] Lane 8. Open the canvas tab, then drag it into a tab group. Save `pc3-group.png`. Pass when it stays in the group after a reload.
- [ ] Lane 9. Mount the server under `--base-url /x`. Save `pc3-basepath.png`. Pass when the canvas loads its bundle and its data.
- [ ] Lane 10. Open `/canvas/<id>` with no login on a password-protected instance. Save `pc3-auth.png`. Pass when the answer is 401.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from navigation to an interactive dashboard at trunk and head. Trunk lacks the canvas, so also measure the frame rate of a pan across 500 objects and the time to first render.
- [ ] Probe. A Playwright script loads the dashboard ten times per build, interleaved, then pans the canvas for five seconds and reads frame times.
- [ ] Baseline. Record the trunk dashboard load first.
- [ ] Rule. Fail when the head dashboard load exceeds trunk by more than 5 percent, when the pan runs under 50 frames per second, or when the first render exceeds one second.

**Review gate.** An agent reviews the rendered interaction against the shaped brief before merge.

- [ ] Copy the lane 2, 3 and 4 screenshots into `pr/media/pc3-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of pan, zoom and a live agent write. Save it as `pr/media/pc3-review.mp4`.
- [ ] Have a reviewing agent check the screenshots and video against the shaped brief. Fix findings, record the verdict and make the evidence available in the status report. Continue to merge when the review passes.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Rebased onto the PC1 branch after the verdict, patch-id unchanged.
- [ ] The coordinator records PC3 as verified, lands the PR and deploys automatically after the final-head checks pass, then verifies the live result.

## Implement core canvas interactions on desktop (PC4)

**Depends on.** PC3.

**Files.**

- [ ] Create `packages/canvas/src/select.ts`, `src/drag.ts`, `src/resize.ts`, `src/edit-queue.ts` and `src/undo.ts`.
- [ ] Edit `packages/canvas/src/entry.ts`, `src/render.ts` and `src/web/public/canvas.html`.
- [ ] Create `test/canvas-edit-queue.test.ts` and `test/canvas-edit.browser.test.ts`.

**Build.**

- [ ] Implement the full foundation selection model: single/multi, marquee and freehand selection lasso, group/section selection, parent/child drill-down, keyboard navigation and cancellable gestures. Keep selection lasso distinct from hold-key chat capture.
- [ ] Add contextual grouping/ungrouping, naming, nested groups, deliberate reparenting, duplicate/copy/cut/paste, alignment/distribution/snapping, sibling order and atomic history operations.
- [ ] Implement side/corner and numeric resize, proportional/from-center transforms and supported rotate/flip behavior with explicit group-versus-frame semantics. A group's contents move coherently and ungroup preserves world placement and child IDs.
- [ ] Implement element/group lock/unlock and inherited lock state, with an intentional background-only mode for fixed frames/sections where supported. Locked items remain readable/contextual; protected mutations fail consistently through UI and agent controls. Do not bypass locks by transforming or deleting an ancestor.
- [ ] Exercise every required control through pointer/keyboard and its structured agent equivalent. Verify nested transforms, lock failures, cancel, restore and no double operation on a selected parent/child overlap. Do not implement stickers, washi tape or sticky-note element types.

- [ ] Write `edit-queue.ts`. It gives each local operation an `opId`, shows it at once, sends one batch at a time and resends after a failure. It keeps unsent operations in `localStorage` until the server answers.
- [ ] Add the shaped compact dock and labeled Add menu for text, frame, section and sub-canvas. Keep every shortcut hint consistent with the brief.
- [ ] Write `select.ts` for click, shift-click and marquee selection.
- [ ] Write `drag.ts`. Ordinary dragging changes position without changing the parent. A named container-header or outline drop target previews the destination and commits one `move` with a new `parentId`. Move to names a destination, including the root. Never infer containment from nearby geometry.
- [ ] Write `resize.ts` with the side/corner, numeric and constrained behaviors specified by the foundation contract, including nested-group transforms and identical agent commands.
- [ ] Edit plain text in the focused panel and submit on blur or debounce. Distinguish Saving, Saved and failed drafts. Preserve local content on a concurrent same-field update and expose conflict resolution. Do not add rich text or Git documents.
- [ ] Delete with the Delete key as a soft delete.
- [ ] Write `undo.ts`. Scoped Cmd/Ctrl+Z appends safe inverses of the user's acknowledged operations without overwriting later work by another author. Handle redo, keyboard move mode, focus restoration and editing/IME exclusions per the brief.
- [ ] Skip every edit control on a phone.

**You see.**

- [ ] A text block dragged into a frame moves with that frame afterwards.
- [ ] Ctrl+Z after a delete brings the object back, and the log holds a `restore`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `test/canvas-edit-queue.test.ts` covers ordering, the resend after a failure, the restore from `localStorage` and a server refusal. Run `npm test -- test/canvas-edit-queue.test.ts`.
- [ ] `test/canvas-edit.browser.test.ts` covers create, drag into a frame, resize and undo with real pointer events. Run `npm run test:browser -- test/canvas-edit.browser.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-sonnet-5-5` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk here is the PC3 head. Pan and zoom the same workspace on both. Save `pc4-regression.png`. Pass when both pan, and head creates a text block from the toolbar.
- [ ] Lane 2. Create a section, a frame and a text block, then type in the block. Save `pc4-create.png`. Pass when `GET /objects` holds all three with a human author.
- [ ] Lane 3. Drop a text block on the frame's named target, verify its destination preview, then drag the frame. Save `pc4-reparent.png`. Pass when the block's `parentId` is the frame and it moves with the frame.
- [ ] Lane 4. Drag a block out of a frame onto empty canvas. Save `pc4-unparent.png`. Pass when its `parentId` is unchanged; then choose Move to root and assert an explicit reparent operation.
- [ ] Lane 5. Tidy a layout by moving objects near another frame without dropping them in it. Save `pc4-proximity.png`. Pass when no `parentId` changes.
- [ ] Lane 6. Resize a frame at 50 percent and at 200 percent zoom. Save `pc4-resize.png`. Pass when the stored size matches the handle position at both.
- [ ] Lane 7. Delete an object, then press Ctrl+Z. Save `pc4-undo.png`. Pass when it returns and the log holds `delete` then `restore`.
- [ ] Lane 8. Disconnect while an edit is pending, then try a new edit. Save `pc4-offline.png`. Pass when Offline is visible, the new write is refused, the pending draft is retained and reconnect acknowledges its original opId exactly once without duplicate operations.
- [ ] Lane 9. Edit the same field in two tabs while one has an unsent draft. Save `pc4-two-tabs.png`. Pass when the draft is preserved, the conflict is named and both tabs converge after explicit resolution without a reload.
- [ ] Lane 10. Let an agent update a block while the user drags it. Save `pc4-concurrent.png`. Pass when the position is the user's and the text is the agent's.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Frame rate of a pan across 500 objects at the PC3 head and at this head, plus the frame rate while dragging a frame that holds 50 children.
- [ ] Probe. The PC3 pan script on both builds, interleaved, and a drag script on this head.
- [ ] Baseline. Record the PC3 pan frame rate first.
- [ ] Rule. Fail when the pan drops more than 5 frames per second below PC3, or when the drag runs under 50 frames per second.

**Review gate.** An agent reviews the rendered interaction against the shaped brief before merge.

- [ ] Copy the lane 2, 3 and 7 screenshots into `pr/media/pc4-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of create, drag into a frame, resize and undo. Save it as `pr/media/pc4-review.mp4`.
- [ ] Have a reviewing agent check the screenshots and video against the shaped brief. Fix findings, record the verdict and make the evidence available in the status report. Continue to merge when the review passes.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Rebased onto the PC3 branch after the verdict, patch-id unchanged.
- [ ] The coordinator records PC4 as verified, lands the PR and deploys automatically after the final-head checks pass, then verifies the live result.

## Add images, links, website embeds and sub-canvases (PC5)

**Depends on.** PC4.

**Files.**

- [ ] Create `src/canvas/canvas-assets.ts` and `src/canvas/link-preview.ts`.
- [ ] Edit `src/web/routes/canvas-routes.ts`, `src/web/webview-store.ts` and `src/types/webview.ts`.
- [ ] Create `packages/canvas/src/objects/image.ts`, `link.ts`, `embed.ts` and `subcanvas.ts`.
- [ ] Create `test/canvas-assets.test.ts`, `test/link-preview.test.ts` and `test/canvas-media.browser.test.ts`.

**Build.**

- [ ] Store an uploaded or pasted image under `dataPath('canvas/<workspaceId>/assets/')`, named by its SHA-256. Judge the bytes with `imageMagicMatchesExt`, and serve it by id with the range-aware `sendFileBody()`.
- [ ] Create an image object on paste and on drop.
- [ ] Fetch a link's title and thumbnail on the server through the `webview-egress.ts` guard, because the page's CSP blocks remote images.
- [ ] Render an `embed` as a sandboxed iframe on `/webview/<cap>/`. Add a `canvas` kind to `WebviewOrigin`, never trusted, deleted with its object.
- [ ] Load an embed's frame only when it is on screen, and keep at most six live.
- [ ] Shield iframes with a transparent layer during a drag, so the pointer stays with the canvas.
- [ ] Open a sub-canvas on double-click by setting the view root to that object, with a breadcrumb back.

**You see.**

- [ ] A pasted screenshot appears as an image object and survives a reload.
- [ ] A pasted URL becomes a link card, and **Embed** turns it into a live page inside the canvas.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `test/canvas-assets.test.ts` covers the byte check, a wrong extension, the size cap and the id-only read path. Run `npm test -- test/canvas-assets.test.ts`.
- [ ] `test/link-preview.test.ts` covers the egress refusal for link-local and metadata addresses. Run `npm test -- test/link-preview.test.ts`.
- [ ] `test/canvas-media.browser.test.ts` covers paste, embed and sub-canvas navigation. Run `npm run test:browser -- test/canvas-media.browser.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-sonnet-5-5` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk here is the PC4 head. Create and drag a text block on both. Save `pc5-regression.png`. Pass when both work, and head accepts a pasted image.
- [ ] Lane 2. Paste a PNG from the clipboard. Save `pc5-paste.png`. Pass when the image renders and its file exists under `assets`.
- [ ] Lane 3. Upload a script renamed to `.png`. Save `pc5-magic.png`. Pass when the route refuses it.
- [ ] Lane 4. Paste a URL of a local test page. Save `pc5-link.png`. Pass when the card shows that page's title.
- [ ] Lane 5. Paste a link-local metadata URL. Save `pc5-egress.png`. Pass when no request leaves and the card shows the bare URL.
- [ ] Lane 6. Embed a local test page. Save `pc5-embed.png`. Pass when the page renders in the iframe through `/webview/`.
- [ ] Lane 7. Drag an object across an embed. Save `pc5-shield.png`. Pass when the drag does not stop over the iframe.
- [ ] Lane 8. Delete an embed object. Save `pc5-embed-delete.png`. Pass when its web tab record and capability are gone.
- [ ] Lane 9. Place twelve embeds and pan across them. Save `pc5-embed-cap.png`. Pass when at most six iframes are live at once.
- [ ] Lane 10. Open a sub-canvas, add a block, go back. Save `pc5-subcanvas.png`. Pass when the block's `parentId` is the sub-canvas.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Pan frame rate across 500 objects at the PC4 head and at this head, plus the pan frame rate with 100 images and six live embeds.
- [ ] Probe. The PC3 pan script on both builds, interleaved, and a media pan script on this head.
- [ ] Baseline. Record the PC4 pan frame rate first.
- [ ] Rule. Fail when the pan drops more than 5 frames per second below PC4, or when the media pan runs under 40 frames per second.

**Review gate.** An agent reviews the rendered interaction against the shaped brief before merge.

- [ ] Copy the lane 2, 4 and 6 screenshots into `pr/media/pc5-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of a paste, a link, an embed and a sub-canvas. Save it as `pr/media/pc5-review.mp4`.
- [ ] Have a reviewing agent check the screenshots and video against the shaped brief. Fix findings, record the verdict and make the evidence available in the status report. Continue to merge when the review passes.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Rebased onto the PC4 branch after the verdict, patch-id unchanged.
- [ ] The coordinator records PC5 as verified, lands the PR and deploys automatically after the final-head checks pass, then verifies the live result.

## Add comments, author revert and the phone view (PC6)

**Depends on.** PC4.

**Files.**

- [ ] Create `packages/canvas/src/comments.ts`, `src/history.ts` and `src/mobile.ts`.
- [ ] Edit `packages/canvas/src/entry.ts`, `src/web/public/canvas.html` and `src/web/public/mobile-overview.js`.
- [ ] Edit `src/mcp-server.ts` to add `canvas_comment`.
- [ ] Create `test/canvas-comments.browser.test.ts` and `test/mobile/canvas-readonly.test.ts`.

**Build.**

- [ ] Show a comment count on each object and a thread panel that lists and adds comments. Post stores an ordinary comment without starting agent work. PC10 adds deliberate Ask agent and Open conversation actions; never infer invocation from an ordinary comment.
- [ ] Include comments in `canvas_read`, and add the `canvas_comment` tool so an agent can reply.
- [ ] Add a history panel that lists authors with their operation counts and a **Revert this session** button that calls `POST /revert`.
- [ ] Render the phone canvas for reading and navigation, with pan, pinch, Sections and a focused bottom sheet. Object-content/layout editing, drag and resize are absent; comment entry remains enabled. Verify the composer above the software keyboard and focus restoration when closing.
- [ ] Add a canvas entry per case to the current phone home screen for the transitional shell. The canvas itself uses the outline sheet for navigation and search; it has no additional navbar.

**You see.**

- [ ] A comment added on the phone appears on the desktop canvas without a reload.
- [ ] **Revert this session** removes one agent's objects and leaves the user's edits.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `test/canvas-comments.browser.test.ts` covers add, live arrival and the revert button. Run `npm run test:browser -- test/canvas-comments.browser.test.ts`.
- [ ] `test/mobile/canvas-readonly.test.ts` covers pinch, the missing edit controls and a comment, with the touch branch forced on. Run `npm run test:mobile -- test/mobile/canvas-readonly.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-sonnet-5-5` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk here is the PC4 head. Drag a block into a frame on both. Save `pc6-regression.png`. Pass when both reparent, and head shows a comment count.
- [ ] Lane 2. Add two comments to a frame. Save `pc6-thread.png`. Pass when both show in order with their author.
- [ ] Lane 3. Call `canvas_comment` over stdio. Save `pc6-agent-comment.png`. Pass when the reply appears in the open panel with an agent author.
- [ ] Lane 4. Put markup in a comment. Save `pc6-inert.png`. Pass when it shows as text.
- [ ] Lane 5. Let an agent create five objects and edit one of the user's, then revert that session. Save `pc6-revert.png`. Pass when the five are gone and the edited field holds the user's value.
- [ ] Lane 6. Revert an agent whose field the user later changed. Save `pc6-revert-skip.png`. Pass when the user's later value stays.
- [ ] Lane 7. Open the canvas on a phone profile. Save `pc6-phone.png`. Pass when it pans and pinches, has labeled Sections/Find controls, has no object-edit dock, and its comment composer stays above the phone keyboard.
- [ ] Lane 8. Try to drag an object on the phone profile. Save `pc6-phone-nodrag.png`. Pass when the canvas pans and no operation is sent.
- [ ] Lane 9. Add a comment on the phone profile with a desktop tab open. Save `pc6-phone-comment.png`. Pass when the desktop shows it within one second.
- [ ] Lane 10. Open the phone home screen. Save `pc6-phone-home.png`. Pass when the case shows a canvas entry and no new header button.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Pan frame rate across 500 objects at the PC4 head and at this head, plus the pinch frame rate on the phone profile and the time of a revert of 1,000 operations.
- [ ] Probe. The PC3 pan script on both builds, interleaved, a pinch script on the phone profile and a revert script.
- [ ] Baseline. Record the PC4 pan frame rate first.
- [ ] Rule. Fail when the pan drops more than 5 frames per second below PC4, when the pinch runs under 40 frames per second, or when the revert exceeds one second.

**Review gate.** An agent reviews the rendered interaction against the shaped brief before merge.

- [ ] Copy the lane 2, 5 and 7 screenshots into `pr/media/pc6-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of a comment, a revert and the phone view. Save it as `pr/media/pc6-review.mp4`.
- [ ] Have a reviewing agent check the screenshots and video against the shaped brief. Fix findings, record the verdict and make the evidence available in the status report. Continue to merge when the review passes.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Rebased onto the PC4 branch after the verdict, patch-id unchanged.
- [ ] The coordinator records PC6 as verified, lands the PR and deploys automatically after the final-head checks pass, then verifies the live result.

## Render a container screenshot on the server (PC7)

**Depends on.** PC3.

**Files.**

- [ ] Create `src/canvas/canvas-screenshot.ts`.
- [ ] Edit `src/mermaid-renderer.ts` to move its browser launch into `src/headless-browser.ts`.
- [ ] Edit `src/web/routes/canvas-routes.ts` and `src/mcp-server.ts`.
- [ ] Create `test/canvas-screenshot.test.ts`.

**Build.**

- [ ] Move the puppeteer launch, the `mermaid-runtime.json` read and the sandbox choice from `renderMermaid()` into `launchHeadlessBrowser()`. Both renderers call it.
- [ ] Write `renderContainer(workspaceId, objectId)`. It loads the canvas bundle from a self-contained document, feeds it the container's tree, and captures a PNG clipped to the container. The page gets no login and no network except image assets that the server hands it.
- [ ] Run at most one render at a time, with a 20 second limit.
- [ ] Add `GET /api/canvas/:workspaceId/objects/:id/screenshot` and the `canvas_screenshot` tool, which returns the PNG as image content.
- [ ] Draw an embed as a labelled box with its URL, because a network-disabled page cannot load it.

**You see.**

- [ ] The route returns a PNG that shows the section's objects in their places.
- [ ] An agent that calls `canvas_screenshot` describes the layout of the section.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `test/canvas-screenshot.test.ts` covers the clip rectangle, the request refusal for outside URLs, the limit of one render and the time limit. Run `npm test -- test/canvas-screenshot.test.ts`.
- [ ] The Mermaid tests still pass after the move. Run `npm test -- -t mermaid`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-sonnet-5-5` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `codeman mermaid render` on one diagram at trunk and head. Trunk lacks the screenshot route, so record that and gate the head's PNG. Save `pc7-regression.png`. Pass when both diagrams match and head returns a PNG.
- [ ] Lane 2. Capture a section with text, a frame and an image. Save `pc7-section.png`. Pass when all three are visible inside the clip.
- [ ] Lane 3. Capture a nested frame. Save `pc7-nested.png`. Pass when the PNG shows only that frame and its children.
- [ ] Lane 4. Capture a container with an embed. Save `pc7-embed-box.png`. Pass when the embed is a labelled box and no outside request was made.
- [ ] Lane 5. Capture an empty container. Save `pc7-empty.png`. Pass when the route returns a small PNG and no error.
- [ ] Lane 6. Request an unknown object id. Save `pc7-404.png`. Pass when the answer is 404.
- [ ] Lane 7. Send five requests at once. Save `pc7-queue.png`. Pass when one browser process runs at a time and all five answer.
- [ ] Lane 8. Call `canvas_screenshot` over stdio. Save `pc7-mcp.png`. Pass when the result carries image content.
- [ ] Lane 9. Capture a 5,000 object container. Save `pc7-large.png`. Pass when it answers or fails cleanly inside 20 seconds, and no browser process remains.
- [ ] Lane 10. Capture with a text block that holds markup. Save `pc7-inert.png`. Pass when the markup shows as text.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time of `codeman mermaid render` for one diagram at trunk and head. Trunk lacks the screenshot, so also measure the time of one 50 object container capture.
- [ ] Probe. A script renders the diagram five times per build, interleaved, then captures the container five times.
- [ ] Baseline. Record the trunk Mermaid render time first.
- [ ] Rule. Fail when the head Mermaid render exceeds trunk by more than 10 percent, or when the container capture p95 exceeds 5 seconds.

**Review gate.** None. PC7 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Rebased onto the PC3 branch after the verdict, patch-id unchanged.
- [ ] The coordinator records PC7 as verified, lands the PR and deploys automatically after the final-head checks pass, then verifies the live result.

## Let agents query redacted logs (PC8)

**Depends on.** None.

**Files.**

- [ ] Create `src/telemetry-redact.ts` and `src/telemetry-query.ts`.
- [ ] Edit `src/telemetry.ts`, `src/web/routes/telemetry-routes.ts`, `src/mcp-server.ts` and `docs/self-building.md`.
- [ ] Create `test/telemetry-redact.test.ts` and `test/telemetry-query.test.ts`.

**Build.**

- [ ] Write the pure `redactLogLine()`. It masks values under keys that match `SECRET_KEY_RE`, bearer tokens, URL credentials and the hook secret. `StreamWriter` calls it before every write.
- [ ] Add a `ui-events.jsonl` stream for the canvas and the tab strip, written through the existing client route.
- [ ] Write `queryLogs()`. It reads the current file and its `.1` generation for one stream, filters by time range, level and a literal substring, and caps the rows. It never compiles a caller's text into a RegExp.
- [ ] Add `GET /api/logs` and the `logs_query` tool. The route is admin-only in multi-user mode.
- [ ] Update the telemetry instructions in `docs/self-building.md` under this review's program authorization. Preserve its supervisor, rollback, access and data-safety rules; unrelated deploy-design changes remain outside this program.

**You see.**

- [ ] `logs_query` with stream `server` and text `deploy` returns matching lines as JSON.
- [ ] A log line that carried a bearer token holds `[redacted]` on disk.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `test/telemetry-redact.test.ts` covers each secret shape and a line with none. Run `npm test -- test/telemetry-redact.test.ts`.
- [ ] `test/telemetry-query.test.ts` covers the filters, the row cap, the rotated file and a pattern that would hang a RegExp. Run `npm test -- test/telemetry-query.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-sonnet-5-5` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Make one request and find its line in `requests.jsonl` at trunk and head. Trunk lacks the query route, so record that and gate the head's `GET /api/logs`. Save `pc8-regression.png`. Pass when both files hold the line and head returns it.
- [ ] Lane 2. Log a line with a bearer token. Save `pc8-bearer.png`. Pass when the file holds `[redacted]` and not the token.
- [ ] Lane 3. Log an object with a `password` key. Save `pc8-key.png`. Pass when the value is masked and the key stays.
- [ ] Lane 4. Log a git URL with credentials. Save `pc8-url.png`. Pass when the credentials are masked.
- [ ] Lane 5. Query by a time range. Save `pc8-range.png`. Pass when only lines inside the range return.
- [ ] Lane 6. Query for text that sits only in the rotated `.1` file. Save `pc8-rotated.png`. Pass when the line returns.
- [ ] Lane 7. Query with the text `(a+)+$`. Save `pc8-literal.png`. Pass when it answers in under one second and matches only that literal text.
- [ ] Lane 8. Throw an error in the page. Save `pc8-client.png`. Pass when `logs_query` on `client-errors` returns it.
- [ ] Lane 9. Start the server with no `CODEMAN_LOG_DIR`. Save `pc8-nodir.png`. Pass when the route answers with an empty list and a reason.
- [ ] Lane 10. Call `logs_query` over stdio after a planted failing route. Save `pc8-diagnose.png`. Pass when the result holds the route's error line.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Median latency of `GET /api/status` under 200 requests per second at trunk and head, with logging on. Trunk lacks the query, so also measure one query over a full 20 MiB file.
- [ ] Probe. A load script runs 30 seconds per build, interleaved, then runs the query ten times.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Fail when the head median exceeds trunk by more than 5 percent, or when the query p95 exceeds 2 seconds.

**Review gate.** None. PC8 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The coordinator records PC8 as verified, lands the PR and deploys automatically after the final-head checks pass, then verifies the live result.

## Ambient assistant, direct context and model routing (PC9)

**Depends on.** PC2, PC4 and PC6. This is added design scope; detailed implementation planning must precede code.

- [ ] Keep addressable real session records and one transcript owner. Present foreground chat in a thin 320-pixel right rail; collapse it to zero with no leftover card or reserved width. Opening/hiding does not change canvas position or selection. Do not implement the superseded floating conversation card.
- [ ] Project native prompts, agent replies, tool results, questions, waiting/running/stopped/error states and supported approvals into the conversation. Specify adapter gaps honestly before implementation; keep the unmodified Claude Code integration and existing session continuity.
- [ ] Hide, summon and switch rail views without changing or cancelling the underlying session. Preserve draft, attachments and origin. Nonmodal help, object threads and task details use the same rail; no context or assistant control creates a blocking overlay.
- [ ] Add selected objects/containers with Cmd/Ctrl+Enter or the selection action. Hold Q and primary-drag a lasso to preview and capture actual enclosed object IDs; define center hit testing, deduplication, explicit-container membership and coordinate transforms. Chips are directly removable. Do not add an attachment picker or modal. Record the references and actual supplied content versions with the sent message. Selection elsewhere does not silently mutate attachments. Whole-canvas discovery remains available through tools.
- [ ] Removing a chip affects the next request, not material already supplied. Offer New conversation for a fresh transcript. Sources used is a disclosure inside the conversation, not metadata stamped over the board.
- [ ] Preserve drafts, attachments and focus across collapse, reconnect and app releases. Deduplicate request retries. Canvas keys never intercept message entry or IME. Show failures in the owning conversation and keep a labeled Send alternative.
- [ ] Support the phone assistant view and its software-keyboard-aware composer through the same session. Show keyboard scope and attachment behavior explicitly.
- [ ] Populate provider/model controls from actual configured adapters and their supported catalogs; choices target a subsequent new run or a natively supported model change with explicit attribution. Unsupported choices and new-session routing are inline, not modal.
- [ ] Implement the scoped shortcut map and a filterable nonmodal cheatsheet available by ?/F1. Preserve browser/OS and editing/IME keys; disable/remap single-letter bindings.
- [ ] Verify full collapse/reopen without camera change, selection and lasso context, one-session identity, broad canvas reading, input isolation, retained failed drafts, deduplicated send, provider attribution and session continuation across a supervised release. Cancel lasso on early hotkey release, Escape, pointer cancellation, lost capture and blur. Run the same independent review and final-head merge/deploy verification policy as the foundation PRs.

## Connected threads and self-building workflow (PC10)

**Depends on.** PC9 and PC6. This is added design scope; detailed implementation planning must precede code.

- [ ] Post remains an ordinary comment. Ask agent is an explicit request bound to the object, thread and a chosen existing or new real session. A comment or mention alone never starts unexpected agent work.
- [ ] Route replies back to the originating thread, with stable request/origin IDs and deduplication. Open conversation presents that same session in the assistant rail and keeps a backlink to its origin. Another open thread or selection cannot reroute a running task.
- [ ] Expose supported object operations to agents so they can help arrange the workspace with ordinary authorship, undo and stable focus. Do not silently add arbitrary plugin installation or a general tool builder.
- [ ] Keep app-change requests, previews, verification and release outcomes within the conversation that initiated them. Use the existing supervised deploy path; preserve the session and workspace across the release. Do not make the canvas a second deployment control plane.
- [ ] Verify ordinary comment versus explicit invocation, originating-thread reply routing, the same session in both views, safe draft/input behavior, recoverable agent layout changes and a bounded self-building change initiated from the canvas. Elaborate isolated test fixtures and safe cleanup before running the release-continuity scenario.

## Voice input and conversation (PC11)

**Depends on.** PC9. Detailed audio/capability planning precedes implementation.

- [x] Provide distinct dictation and voice-conversation controls and bindings. Dictation edits a draft; conversational voice submits explicit speech turns and supports playback interruption. Never overload one key with both toggle and hold-to-talk behavior.
- [x] Define a verified microphone/transcription/playback or realtime adapter for the selected configuration. Do not assume all CLI subscriptions support realtime audio. Unsupported capability and denied permission remain inline with text available.
- [x] Show truthful recording/processing/speaking/muted/error states. Active microphone capture retains a minimal stop indicator even with the assistant rail hidden; background agents cannot activate it.
- [x] Bind each spoken turn to its committed canvas references, preserve request/provider attribution and support cancel/retry without duplicate work. Desktop and phone keyboard/touch controls must both work.
- [x] Verify permission denial, absence of a device, interruptions, network loss, key repeat, IME/text isolation, capture termination and hidden-rail microphone visibility using controlled fixtures before any manual recording exercise. The design prototype's microphone-disconnected state is not audio verification.

## Background agent lifecycle (PC12)

**Depends on.** PC9 and a verified isolated-session launch path.

- [ ] Run in background explicitly creates one named child task with origin, context snapshot and provider/model. Return canvas control immediately; do not replace the foreground conversation.
- [ ] Isolate code-editing tasks in worktrees or an equivalent verified boundary. Keep request/session IDs, authorship and per-task outputs so parallel actors never share an editing checkout by accident.
- [ ] Expose queued, running, waiting-for-user, completed, failed and cancelled states in the nonmodal task rail. Keyboard G opens it; Cmd/Ctrl+Shift+Enter runs the drafted request. Inspect and Cancel act only on the chosen child.
- [ ] Keep questions and results connected to their request, with artifact links and bounded notifications. Closing the assistant does not cancel tasks; changing provider/model does not retarget existing runs. Reconnect/retry deduplicates task creation and restores ownership.
- [ ] Verify isolation, per-task cancellation, retry deduplication, foreground continuity, context/provider snapshots, result routing and recovery from a waiting/failed child. The prototype's queued example rows are not real agent verification.

## Make the canvas the shell (PC13)

**Depends on.** PC10, PC11 and PC12. This is added design scope. A shape pass and detailed implementation planning must come before code.

Until PC13, the canvas is a `managed` web tab inside Codeman's dashboard. PC13 turns that around: Codeman opens on the canvas, everything Codeman does is reachable from it, and the tab dashboard becomes a fallback view.

- [ ] Run `/impeccable shape` for the canvas shell before implementation. Inventory every dashboard surface (tab strip, sidebar and rail, tab groups, session terminals, the file preview, the Files and Git panels, App Settings, the approvals inbox, notifications, Cmd+K, case management, the phone overview and keyboard) and give each one a home on the canvas, in the outline, in the assistant rail, or in the classic view. Add the result to `canvas-ui-ux-brief.md`. Pass when no current surface lacks a home.
- [ ] Make the canvas the landing page. With the shell on, `/` opens the canvas of the last-used workspace, and the outline switches workspaces and cases. A new workspace starts from the outline, not from a tab.
- [ ] Make every session reachable from the canvas. Terminals, rail conversations and background tasks each have one canvas representation and one full view. Opening a session's full view and closing it returns to the canvas with the camera, selection and rail state unchanged. A session keeps its single transcript owner and its existing input path; the shell adds no second write path to a pane.
- [ ] Keep the classic dashboard reachable at its own route as a fallback, on the same server and the same state. Switching between the two loses no session, draft or tab layout. Keep the dashboard code intact rather than deleting it, so upstream Codeman releases still merge.
- [ ] A broken canvas bundle must not lock the owner out. If the canvas page fails to load or render, `/` falls back to the classic view with a visible notice, and the classic route never depends on the canvas bundle. The shell switch survives a blue-green deploy and a rollback.
- [ ] Gate the shell behind its own setting, default off, independent of `canvasEnabled`. The canvas tab keeps working with the shell off. Turn the shell on by default only after the close-the-program gate passes on the deployed build.
- [ ] On the phone, the canvas home replaces the phone overview. It keeps reading, conversation and comments from PC6 and PC9, and it keeps a route to a session's terminal and the mobile keyboard.
- [ ] Verify with the shell on: landing on the canvas, switching workspaces from the outline, opening and closing a terminal's full view without camera change, every inventoried surface reachable without the classic view, a deliberately broken canvas bundle in a throwaway instance falling back to the classic view, and the same sessions visible from both views. Verify at laptop and phone sizes. Run the same independent review and final-head merge and deploy policy as the other PRs.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] The coordinating agent runs the phase gate on the deployed build through browser automation at laptop and phone sizes. No manual user step is required.
  - [ ] On the laptop viewport, build a section named "design exploration" with images, text, links, a website embed and two frames.
  - [ ] In an agent session, read the section with one `canvas_read` call and one `canvas_screenshot` call; compare the answer with its contents.
  - [ ] Have the agent add a summary block. Assert it appears on the open canvas with the agent as author.
  - [ ] On the phone viewport, view the section and add a comment.
  - [ ] Revert the agent session, and assert only the summary block goes.
  - [ ] Plant a failing request in a throwaway instance and diagnose it with `logs_query`. Never inject the fault into production.
- [ ] Verify the complete foundations matrix, including nested selectable group context, selection lassos, resize, locks and one-to-one human/agent command behavior. Static design checks do not satisfy these implementation requirements.
- [ ] Before declaring the clarified product complete, verify the ambient rail, connected thread, voice, background tasks and the canvas shell against PC9–PC13, with attachment changes that do not erase earlier history, whole-canvas discovery and self-building continuity. The original foundation gate alone is insufficient.
- [ ] Turn `canvasEnabled` and the PC13 shell setting on by default in a final PR after the gate passes. Verify, land and deploy it through the same automatic flow, then check that the live build opens on the canvas and the classic view is still reachable.
- [ ] Tick phase 1 in `TRACKER.local.md` and add a `docs/JOURNAL.md` entry.
- [ ] Reply to the operator with each PR and its verdict, per `autopilot-stack.md`.

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
