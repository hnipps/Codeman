# Agent previews plan

Agents get live previews of the web UI they are building, shown inside Codeman and owned by the session that made them. The operator sees a badge on the session tab, opens the preview with a Terminal and Preview switch, and deletes previews from the session or from a Previews drawer. Codeman starts every preview server itself and stops it when the preview is deleted, when its session is deleted, after 4 hours unopened, or at the next boot if its record is gone. Agents never hold a server Codeman cannot see. The intent is `intent/2026-11-05-agent-previews.md`. Five PRs land in order, P1, P2, P3, P4, P5.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `~/.claude/skills/poteto-mode/playbooks/autopilot-stack.md`. The operator lands every PR. Each PR stops at merge-ready, and P4 and P5 also wait for the operator's review in chat.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] Read these from trunk at program start. Re-read them at every tick.
  - [ ] `git show origin/master:docs/agent-previews-plan.md`
  - [ ] `git show origin/master:intent/2026-11-05-agent-previews.md`
  - [ ] `git show origin/master:docs/web-tabs.md`
  - [ ] `git show origin/master:docs/architecture-invariants.md`
  - [ ] `git show origin/master:CLAUDE.md`
  - [ ] Read `~/.claude/skills/poteto-mode/playbooks/autopilot-stack.md`, `~/.claude/skills/swarm/SKILL.md` and `~/.claude/skills/poteto-mode/playbooks/opening-a-pr.md` from the local skill store, which has no trunk.
- [ ] On the operator's go, arm the audit tick as `/loop 1h` with the tick prompt below. Never leave the cadence to memory.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names. Owners are Codeman workers started through the codeman skill, each in its own git worktree of `/home/codeman/codeman`, because that checkout is shared with other sessions.
- [ ] Follow this dependency graph. Each PR branches from its parent's branch.
  - [ ] P1 is first and branches from `master`.
  - [ ] P2 after P1.
  - [ ] P3 after P2. P4 after P2.
  - [ ] P5 after P4, because both edit `src/web/public/webview-tabs.js` and `src/web/public/mobile.css`.
- [ ] Hold the file boundaries. P1 and P2 touch only `src/**/*.ts`, `test/**` and `docs/**`. P3 touches only `src/cli-agent.ts`, `skills/codeman/**`, `test/**` and `docs/**`. P4 and P5 touch only `src/web/public/**`, `test/**` and `docs/**`.
- [ ] Hold the review gate. P4 and P5 change an interaction. They wait for the operator's review in chat with screenshots and a video before merge.

### PR mechanics, for every PR

- [ ] Resolve the forge once. This host has neither `gh` nor `origin` (checked 2026-11-05). Push the branch to `origin` (`git@github.com:hnipps/Codeman.git`) and hand the operator the compare URL `https://github.com/hnipps/Codeman/compare/<base>...<branch>` in place of a PR. Record that fallback in the decision trail.
- [ ] Open the PR ready, never draft, per **Opening a PR**, once a forge tool exists. Until then the compare URL plus the PR body in chat stands in for it. A stack child targets its parent branch.
- [ ] Run `npm run typecheck`, `npm run lint` and `npm run format:check` once before the PR-facing push. Push with hooks on.
- [ ] Run `/deslop` before each commit and `/no-comments` before review. Stage explicit paths only and run `git branch --show-current` before each commit, per `CLAUDE.md`.
- [ ] Triage every Bugbot and security-reviewer comment per `~/.claude/skills/poteto-mode/references/bugbot-triage.md`.
- [ ] Rebase onto current trunk before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, on a CI failure that comes from a change on trunk, or when a known concurrent change to the same files lands.

### Verdict and merge, for every PR

- [ ] A full swarm runs once, at the code-ready head. Another full swarm runs only for new behavior, a redesign, or a large new diff. A rebase, a merge-conflict resolution, or a minor fix gets a single verifier at the new head, and a wording-only change gets none. Run each full swarm per `~/.claude/skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict.
- [ ] Judge every finding by the execution playbook's blocking rule. The verdict is clean when none blocks. A failure on trunk behavior in a lane marked `Regression lane against trunk.` is recorded against trunk and does not block the PR. A new head gets a fresh verdict, except for results that stay valid under the patch-id rule in `~/.claude/skills/poteto-mode/playbooks/shipping.md`.
- [ ] The root appends each verified PR to the stack and reports it merge-ready. The operator lands the stack bottom-up. A PR whose patch-id is unchanged after a rebase keeps its verdict.

### Boot recipe, for every live lane

Each live lane runs as a Codeman worker on this host, in its own worktree at the PR head, against an isolated Codeman instance. Browser lanes drive Playwright through `control-ui`. CLI lanes drive the terminal through `control-cli`.

- [ ] `git fetch origin <head-branch> && git worktree add /tmp/swarm-<pr-id>/worker-<n>/tree <head SHA>`.
- [ ] Start an isolated server with `CODEMAN_INSTANCE=lane<n> CODEMAN_PORT=41<nn> npx tsx src/index.ts web` from the worktree. Wait until `curl -s http://127.0.0.1:41<nn>/api/v1/sessions` returns JSON.
- [ ] Deliver input only through the control skill's commands and `codeman agent` pointed at that port. Read-only diagnostics are `GET /api/v1/sessions`, `GET /api/v1/webviews`, `GET /api/v1/previews`, `ps -o pid,pgid,etime,cmd -g <pgid>` and `ss -ltnp`.
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report.
- [ ] Stop the instance and remove the worktree when the lane ends. Then confirm `ss -ltnp` shows no listener the lane started.

## Give web tabs a session origin (P1)

**Depends on.** None.

**Files.**

- [ ] Edit `src/types/webview.ts`.
- [ ] Edit `src/webview-store.ts`.
- [ ] Edit `src/web/schemas.ts`.
- [ ] Edit `src/web/routes/webview-routes.ts`.
- [ ] Edit `src/web/server.ts`.
- [ ] Edit `docs/web-tabs.md`, `docs/architecture-invariants.md` and `docs/api-reference.md`.
- [ ] Create `test/webview-origin.test.ts`.

**Build.**

- [ ] Add `WebviewOrigin` to `src/types/webview.ts` as a discriminated union of `{ kind: 'user' }`, `{ kind: 'managed'; managed: WebviewManagedKind }` and `{ kind: 'session'; sessionId: string; name: string }`, and replace the optional `managed` field with a required `origin`.
- [ ] Parse old records in `readWebviews` (`src/webview-store.ts`). A record with `managed` becomes `{ kind: 'managed' }`, and any other record without `origin` becomes `{ kind: 'user' }`. Write back only on the next normal write, so reading twice changes nothing.
- [ ] Refuse `trusted: true` in the create and update schemas when the record's origin is `session`, with `INVALID_INPUT`.
- [ ] Remove every record whose origin is `{ kind: 'session', sessionId }` inside `_doCleanupSession` in `src/web/server.ts`, revoke their capabilities, and emit `webview:changed`.

**You see.**

- [ ] `GET /api/v1/webviews` returns each existing dashboard with `"origin":{"kind":"user"}` and the DeepSeek row with `"origin":{"kind":"managed","managed":"deepseek-web"}`.
- [ ] Deleting a session whose id owns a session-origin record leaves `GET /api/v1/webviews` without that record.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `test/webview-origin.test.ts` gains cases for the old-record parse, a second read being a no-op, the `trusted` refusal on create and on update, and the cascade removing only the deleted session's records. Run `npm test -- test/webview-origin.test.ts`.
- [ ] Run `npm test -- test/webview-proxy.test.ts test/webview-capability-revocation.test.ts test/webview-sse.test.ts` to confirm existing web tab behavior is unchanged.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Save a user web tab to a local static server, open it, and screenshot it at trunk and at head. Save `user-tab.png`. Pass when both render the page and head's `GET /api/v1/webviews` shows `origin.kind` `user`.
- [ ] Lane 2. Copy a trunk `webviews.json` with one user row and one `deepseek-web` row into the lane's data dir, then boot head. Save `migrated-list.png`. Pass when the list shows both rows with the right origins and the file on disk is byte-identical until the first write.
- [ ] Lane 3. Create a session-origin record through the store test hook, then delete its session from the UI. Save `cascade.png`. Pass when the record is gone from `GET /api/v1/webviews` and its old capability URL returns 404.
- [ ] Lane 4. Two sessions each own a record. Delete one session. Save `cascade-scoped.png`. Pass when only the deleted session's record is gone.
- [ ] Lane 5. `PATCH` a session-origin record with `trusted: true`. Save `trusted-refused.png`. Pass when the response is 400 with `INVALID_INPUT` and the record is unchanged.
- [ ] Lane 6. `PATCH` a user record with `trusted: true`. Save `trusted-user.png`. Pass when it succeeds, as on trunk.
- [ ] Lane 7. Open the web tab editor in the UI on a user record and save an edit. Save `editor.png`. Pass when the edit persists and `origin` is unchanged.
- [ ] Lane 8. With two browser tabs open, delete a session that owns a record. Save `sse-other-tab.png`. Pass when the second browser tab drops the record without a reload.
- [ ] Lane 9. Restart the lane's server after a cascade. Save `after-restart.png`. Pass when the deleted record does not come back.
- [ ] Lane 10. Load the UI at 390 by 844 pixels with three user tabs. Save `mobile-tabs.png`. Pass when the tab strip matches trunk's screenshot of the same state.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Median latency of `GET /api/v1/webviews` with 50 records, and of `DELETE /api/v1/sessions/:id` for a session that owns 5 records.
- [ ] Probe. Run 200 requests of each against trunk and head, interleaved in blocks of 20, with `autocannon` or a `curl` loop timing each call.
- [ ] Baseline. Record the trunk medians first.
- [ ] Rule. Head fails if either median exceeds trunk by more than 10 percent, or if session delete exceeds trunk by more than 20 milliseconds.

**Review gate.** None. P1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends P1 to the stack and the operator lands it bottom-up.

## Start, stop and reconcile preview servers (P2)

**Depends on.** P1.

**Files.**

- [ ] Create `src/preview-supervisor.ts`.
- [ ] Create `src/types/preview.ts`.
- [ ] Create `src/web/routes/preview-routes.ts`.
- [ ] Create `src/config/preview-limits.ts`.
- [ ] Edit `src/web/routes/index.ts`, `src/web/server.ts` and `src/web/schemas.ts`.
- [ ] Edit `docs/api-reference.md`, `docs/web-tabs.md` and `docs/architecture-invariants.md`.
- [ ] Create `test/preview-supervisor.test.ts` and `test/preview-routes.test.ts`.

**Build.**

- [ ] Define `PreviewProcess` in `src/types/preview.ts` as a record of `webviewId`, `sessionId`, `name`, `cmd`, `cwd`, `port`, `pid`, `pgid`, `startTicks` (field 22 of `/proc/<pid>/stat`), `logPath`, `state` and `lastViewedAt`, where `state` is `'running' | 'stopped' | 'exited'`. Persist the list to `previews.json` in the data dir with a temp-file rename.
- [ ] In `src/preview-supervisor.ts`, `start` binds port 0 to pick a free port, substitutes `{port}` in `cmd` and sets `PORT`, spawns `/bin/sh -c cmd` detached in a new process group with the session's `workingDir` as `cwd`, sends output to `logPath`, and writes the record before returning.
- [ ] `stop` sends `SIGTERM` to the process group, waits up to 5 seconds, then sends `SIGKILL`. It treats a group that is already gone as success.
- [ ] `reconcile` runs at boot and every minute. A record whose `pid` is alive with matching `startTicks` and whose web tab exists keeps running. A live group whose web tab is gone is stopped. A dead process is marked `exited`. A running preview whose `lastViewedAt` is older than `PREVIEW_IDLE_STOP_MS` (default 4 hours, env `CODEMAN_PREVIEW_IDLE_STOP_MS`) is stopped and marked `stopped`.
- [ ] Mark `lastViewedAt` from the web tab proxy when a request arrives for a preview's capability.
- [ ] Add `PUT /api/v1/sessions/:id/previews/:name` with `{ cmd }`. It creates or replaces the preview keyed by session and name, so a repeat stops the old process and starts one new one. Add `GET` and `DELETE` on the same path, `GET /api/v1/sessions/:id/previews`, `GET /api/v1/previews` and `GET /api/v1/sessions/:id/previews/:name/log?tail=`.
- [ ] Refuse remote and Docker sessions with `INVALID_INPUT` and a message that names the session type.
- [ ] Deleting the web tab, the preview, or the session stops the process in the same call.

**You see.**

- [ ] `PUT /api/v1/sessions/<id>/previews/web` with `{"cmd":"python3 -m http.server {port}"}` returns `{ port, url, state: "running" }`, and the returned URL serves the directory listing.
- [ ] `DELETE` on the same path returns success, and `ss -ltnp` no longer shows the port.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `test/preview-supervisor.test.ts` gains cases for port substitution, a repeated `start` leaving one live group, `stop` on a dead group, `reconcile` keeping a matching process, killing an orphan group, refusing to touch a reused pid whose `startTicks` differ, and the idle stop with a fake clock. Run `npm test -- test/preview-supervisor.test.ts`.
- [ ] `test/preview-routes.test.ts` gains cases for create, replace, list, delete, the remote and Docker refusals, and the cascade from session delete. Run `npm test -- test/preview-routes.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk lacks previews, so record that and run the user web tab scenario from P1 lane 1 at both. Then gate head on creating a `python3 -m http.server {port}` preview and loading its URL. Save `preview-up.png`. Pass when trunk and head render the user tab and head serves the preview.
- [ ] Lane 2. Create a Vite dev server preview from a scaffolded app with `npm run dev -- --port {port} --strictPort`. Edit `src/App.jsx`. Save `vite-hmr.png`. Pass when the frame updates without a reload.
- [ ] Lane 3. Run the same `PUT` three times. Save `idempotent.png`. Pass when `GET /api/v1/previews` lists one preview and `ps -g` shows one process group.
- [ ] Lane 4. Delete the preview through the API. Save `deleted.png`. Pass when the process group is gone within 6 seconds and the port is free.
- [ ] Lane 5. Delete the owning session from the UI. Save `session-deleted.png`. Pass when its previews, web tabs and process groups are all gone.
- [ ] Lane 6. Kill the Codeman server with `SIGKILL`, delete the preview's row from `webviews.json`, and boot again. Save `orphan-reaped.png`. Pass when reconcile stops the orphaned group within one minute of boot.
- [ ] Lane 7. Set `CODEMAN_PREVIEW_IDLE_STOP_MS=60000`, create a preview and leave it unopened. Save `idle-stopped.png`. Pass when its state becomes `stopped` and its port is free within 2 minutes.
- [ ] Lane 8. Use a command that daemonizes itself with `setsid sh -c 'python3 -m http.server {port}' &`. Save `daemonized.png`. Pass when deleting the preview still frees the port, or the lane records that it does not and files a blocking finding.
- [ ] Lane 9. Use a command that exits at once. Save `exited.png`. Pass when the preview shows state `exited` and `GET .../log` returns its output.
- [ ] Lane 10. Create a preview for a session marked remote in the lane's data dir. Save `remote-refused.png`. Pass when the API returns 400 naming the session type and nothing is spawned.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Trunk lacks previews, so measure the diff-added work. Time from `PUT` to the first 200 through the preview URL for `python3 -m http.server`, the cost of one `reconcile` pass with 20 previews, and the median of `GET /api/v1/webviews` at trunk and head.
- [ ] Probe. Run 20 create-and-load cycles and 20 reconcile passes at head, and 200 interleaved `GET /api/v1/webviews` calls at trunk and head.
- [ ] Baseline. Record the trunk `GET /api/v1/webviews` median first.
- [ ] Rule. Head fails if `PUT` to first 200 exceeds 1500 milliseconds at the median, if one reconcile pass exceeds 50 milliseconds, or if `GET /api/v1/webviews` exceeds trunk by more than 10 percent.

**Review gate.** None. P2 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends P2 to the stack and the operator lands it bottom-up.

## Give agents a preview command (P3)

**Depends on.** P2.

**Files.**

- [ ] Edit `src/cli-agent.ts`.
- [ ] Edit `skills/codeman/SKILL.md` and `skills/codeman/reference/verbs.md`.
- [ ] Edit `docs/api-reference.md`.
- [ ] Create `test/cli-agent-preview.test.ts`.

**Build.**

- [ ] Add `codeman agent preview add <name> --cmd <cmd>`, `ls`, `rm <name>` and `logs <name>` to `src/cli-agent.ts`. Each calls the P2 routes for `$CODEMAN_SESSION_ID`, prints the URL and port, and uses the existing exit codes.
- [ ] Add a row to the skill's job table in `skills/codeman/SKILL.md` and a section in `skills/codeman/reference/verbs.md` that tells agents to start servers only through `preview add`.

**You see.**

- [ ] `codeman agent preview add web --cmd "python3 -m http.server {port}"` prints `web  running  :<port>  /webview/<cap>/` and exits 0.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `test/cli-agent-preview.test.ts` gains cases for each verb against a fake API, the JSON output flag, a missing session id, and a 400 mapped to exit code 1. Run `npm test -- test/cli-agent-preview.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `codeman agent ls` at trunk and head, then gate head on `codeman agent preview add`. Save `cli-regression.png`. Pass when `ls` output matches and the preview starts.
- [ ] Lane 2. Run `preview ls` with two previews. Save `cli-ls.png`. Pass when both rows show name, state and port.
- [ ] Lane 3. Run `preview rm web`. Save `cli-rm.png`. Pass when the port is free and `ls` no longer lists it.
- [ ] Lane 4. Run `preview logs web` on a server that printed a line. Save `cli-logs.png`. Pass when the line appears.
- [ ] Lane 5. Run `preview add` twice with different commands. Save `cli-replace.png`. Pass when one preview runs the second command.
- [ ] Lane 6. Prompt a claude worker with the updated skill to "build a hello page and preview it". Save `claude-worker.png`. Pass when it uses `preview add` and no other server process appears in `ss -ltnp`.
- [ ] Lane 7. Give a grok worker the same prompt. Save `grok-worker.png`. Pass when it uses `preview add` as well.
- [ ] Lane 8. Run `preview add` with `--json`. Save `cli-json.png`. Pass when the output parses with `jq` and carries `port` and `url`.
- [ ] Lane 9. Run `preview add` outside a Codeman session. Save `cli-no-session.png`. Pass when it exits non-zero with a message naming `CODEMAN_SESSION_ID`.
- [ ] Lane 10. Run `codeman agent --help`. Save `cli-help.png`. Pass when `preview` is listed with its four verbs.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Wall time of `codeman agent ls` at trunk and head, and of `codeman agent preview ls` at head.
- [ ] Probe. Run each 30 times, interleaved between trunk and head, with `hyperfine`.
- [ ] Baseline. Record the trunk `codeman agent ls` median first.
- [ ] Rule. Head fails if `codeman agent ls` exceeds trunk by more than 10 percent, or if `preview ls` exceeds 400 milliseconds at the median.

**Review gate.** None. P3 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends P3 to the stack and the operator lands it bottom-up.

## Show previews inside the session tab (P4)

**Depends on.** P2.

**Files.**

- [ ] Edit `src/web/public/webview-tabs.js`.
- [ ] Edit `src/web/public/session-ui.js`.
- [ ] Edit `src/web/public/mobile.css` and `src/web/public/styles.css`.
- [ ] Edit `docs/web-tabs.md`.
- [ ] Create `test/preview-session-ui.test.ts`.

**Build.**

- [ ] Exclude session-origin records from the top-level web tab strip in `webview-tabs.js`.
- [ ] Add a badge to the session tab in `session-ui.js` when the session has a preview the operator has not opened. Never switch tabs or open the preview on its own.
- [ ] Add a Terminal and Preview switch under the tab strip for a session with previews. Selecting a preview mounts its frame in `#webviewLayer` with the existing sandbox, and the switch shows the preview's name, port and a Delete control.
- [ ] Show a stopped or exited preview as a card with its state and a Restart control, never as a blank frame.

**You see.**

- [ ] After an agent runs `preview add`, the session tab shows a badge and nothing else on screen changes. Tapping the session and then Preview shows the page.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `test/preview-session-ui.test.ts` gains jsdom cases for the badge appearing and clearing, the switch rendering per session, Delete calling the API, and a stopped preview rendering its card. Run `npm test -- test/preview-session-ui.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Load the UI with three sessions and one user web tab at trunk and head at 390 by 844 pixels. Save `strip-regression.png`. Pass when the strips match and head shows no preview tabs in the strip.
- [ ] Lane 2. Create a preview while viewing another session. Save `badge.png`. Pass when the owning tab shows a badge and the active view is unchanged.
- [ ] Lane 3. Open the session and tap Preview. Save `preview-open.png`. Pass when the page renders in the frame and the badge clears.
- [ ] Lane 4. Tap Delete in the switch. Save `preview-deleted.png`. Pass when the switch disappears and the API reports the preview gone.
- [ ] Lane 5. Switch Terminal, Preview, Terminal five times. Save `switching.png`. Pass when the terminal keeps its scrollback and the frame does not reload.
- [ ] Lane 6. Give one session two previews. Save `two-previews.png`. Pass when both names appear in the switch.
- [ ] Lane 7. Stop a preview's server by force. Save `stopped-card.png`. Pass when the card shows the stopped state and Restart brings the page back.
- [ ] Lane 8. Run the lanes 2 to 4 flow at 1280 by 800 pixels. Save `desktop.png`. Pass when the same states appear.
- [ ] Lane 9. Inside a preview, run `fetch('/api/v1/sessions')` from the frame's console. Save `sandbox.png`. Pass when the request fails without the operator's cookie.
- [ ] Lane 10. Reload the page while a preview is open. Save `reload.png`. Pass when the session and its Preview view come back.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time to interactive of the main page with ten sessions, at trunk and head, and the time from tapping Preview to the frame's `load` event at head.
- [ ] Probe. Run 15 Playwright page loads at trunk and head, interleaved, and 15 Preview taps at head.
- [ ] Baseline. Record the trunk time to interactive first.
- [ ] Rule. Head fails if time to interactive exceeds trunk by more than 5 percent, or if the Preview tap to `load` exceeds 800 milliseconds at the median for a static page.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 3 and 7 screenshots into `docs/screenshots/p4-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change on a lane worker at phone size. Save it as `docs/screenshots/p4-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends P4 to the stack and the operator lands it bottom-up.

## List every running preview in a drawer (P5)

**Depends on.** P4.

**Files.**

- [ ] Edit `src/web/public/webview-tabs.js`.
- [ ] Edit `src/web/public/index.html`.
- [ ] Edit `src/web/public/mobile.css` and `src/web/public/styles.css`.
- [ ] Edit `docs/web-tabs.md`.
- [ ] Create `test/preview-drawer.test.ts`.

**Build.**

- [ ] Add a Previews button to the toolbar that opens a sheet listing `GET /api/v1/previews`, grouped by nothing and sorted by uptime, with session, name, port, state, uptime and a Delete control per row.
- [ ] Tapping a row opens that session's Preview view from P4.
- [ ] Update the list from `webview:changed` events while the sheet is open.

**You see.**

- [ ] The sheet lists every running preview with its uptime, and Delete removes a row and frees its port.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `test/preview-drawer.test.ts` gains jsdom cases for the empty state, the row fields, Delete, opening a row, and a live update. Run `npm test -- test/preview-drawer.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Load the toolbar at trunk and head at 390 by 844 pixels. Save `toolbar-regression.png`. Pass when every trunk control is still present and reachable at head.
- [ ] Lane 2. Open the drawer with no previews. Save `drawer-empty.png`. Pass when it says nothing is running.
- [ ] Lane 3. Open it with previews from three sessions. Save `drawer-three.png`. Pass when all three rows show session, port and uptime.
- [ ] Lane 4. Delete a row. Save `drawer-delete.png`. Pass when the row goes and its port is free.
- [ ] Lane 5. Tap a row. Save `drawer-open.png`. Pass when that session's Preview view opens.
- [ ] Lane 6. Create a preview from the CLI while the drawer is open. Save `drawer-live.png`. Pass when the row appears without reopening.
- [ ] Lane 7. Let a preview hit the idle stop with the timeout set to 60 seconds. Save `drawer-idle.png`. Pass when its row shows the stopped state.
- [ ] Lane 8. Open the drawer at 1280 by 800 pixels. Save `drawer-desktop.png`. Pass when it opens as a panel and every row control works.
- [ ] Lane 9. Open the drawer with 20 previews. Save `drawer-many.png`. Pass when it scrolls and the Delete buttons stay reachable.
- [ ] Lane 10. Navigate the drawer with the keyboard only. Save `drawer-keyboard.png`. Pass when every row and Delete control takes focus and Escape closes it.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time to interactive of the main page at trunk and head, and the time from tapping Previews to the sheet rendering 20 rows at head.
- [ ] Probe. Run 15 Playwright page loads at trunk and head, interleaved, and 15 drawer opens at head.
- [ ] Baseline. Record the trunk time to interactive first.
- [ ] Rule. Head fails if time to interactive exceeds trunk by more than 5 percent, or if the drawer takes more than 300 milliseconds at the median to render 20 rows.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 3, 4 and 7 screenshots into `docs/screenshots/p5-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change on a lane worker at phone size. Save it as `docs/screenshots/p5-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends P5 to the stack and the operator lands it bottom-up.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Set `intent/2026-11-05-agent-previews.md` to its final status and add a `docs/JOURNAL.md` entry for the process ownership decision.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

The placement question was settled by a clickable mockup at `/home/codeman/codeman-cases/testcase/previews/placement-mockup/index.html`, served through `POST /api/sessions/:id/html-view`. It shows option A (inside the session tab), option B (own tab in the strip) and option C (drawer). The operator chose A with C on 2026-11-05. A jsdom click-through passed for the badge, opening, deleting, the B tab and the C drawer. It was not screenshotted, because headless Chromium on this host fails to load `libatk-1.0.so.0`.

Still unproven. Whether `SIGTERM` to the recorded process group reaches a server that daemonizes itself with `setsid`. P2 lane 8 settles it. Whether Vite hot reload works through the proxy for a preview was inferred from the single-page app fix in `CHANGELOG.md` (#402) and is settled by P2 lane 2.

## Appendix B. Alternatives rejected

- Agents run their own servers and only register a URL. Rejected because Codeman then cannot stop a server the agent detached, which is the leak the operator raised.
- A new preview entity beside web tabs. Rejected because it would duplicate the proxy, capabilities, store and SSE events that web tabs already have. A session origin on the web tab record reuses all of it.
- Previews as their own tabs in the strip (option B). Rejected because on a phone the strip already truncates session names, and ten previews would add ten tabs.
- A boolean `isPreview` plus a `sessionId` field. Rejected because two fields that must agree can disagree. The `origin` union makes a preview without a session impossible to write.
- Running each preview in its own tmux session. Rejected because tmux adds a terminal nobody reads, and the process group gives the same kill guarantee with less machinery.

## Appendix C. Risks

- A server that forks out of its process group survives `stop`. P2 lane 8 tests it. If it fails, P2 adds a cgroup or a descendant walk with `src/proc-tree.ts` before merge.
- Pid reuse after a reboot could make reconcile stop an unrelated process. P2 matches `startTicks` before signalling and never signals a pid whose start time differs.
- Headless Chromium cannot start on this host until `libatk1.0-0` and its siblings are installed. Every browser lane in P1, P4 and P5 depends on it. The root asks the operator to install them before arming, or runs those lanes on a host that has them.
- The host has no `gh` or `origin` CLI, so PRs are compare URLs until one is installed.
- Agents may ignore the skill and start servers directly. P3 lanes 6 and 7 measure it. A later change can warn when a session's process tree holds a listening port that no preview owns.

## Appendix D. Links and reading list

- Read `docs/web-tabs.md`, `docs/security-architecture.md` and the web tab sections of `docs/architecture-invariants.md` before P1 and P2.
- Read `src/tmux-manager.ts` `killSession` and `src/proc-tree.ts` before P2.
- P2 gets `~/.claude/skills/how/SKILL.md` over the web tab proxy and `~/.claude/skills/interrogate/SKILL.md` on the supervisor design before it ships.
- The decision trail follows `~/.claude/skills/show-me-your-work/SKILL.md` and lives in the root's scratchpad.
