# Journal

Newest entries first. After an entry is on the default branch, correct it with a new entry. The types are `propagated-discovery`, `intent-refinement`, `drift`, `retraction`, and `status-transition`.

## 2026-11-13 — Every local Claude launch carries the Codeman MCP server

**Type:** intent-refinement
**Touches:** `src/agent-mcp-config.ts`, `src/config/cli-registry/stock.ts`, `src/session-cli-registry-bridge.ts`, `src/tmux-manager.ts`, `src/session-cli-builder.ts`, `src/session.ts`, `src/hooks-config.ts`, `src/web/schemas.ts`, `skills/codeman/reference/verbs.md`
**Why:** No Claude session had the canvas tools unless someone ran `claude mcp add` in it first, so an agent started from the canvas and one started from a terminal could not do the same work.
**Links:** [intent/2026-11-13-canvas-prototypes.md](../intent/2026-11-13-canvas-prototypes.md)

Decision. The launch carries one inline `--mcp-config` argument that names this process's own entry script, behind the synced `agentMcpEnabled` setting (absent means on). It is not a `codeman` looked up on PATH, because two instances on one machine can run different code. Which CLI takes it is read off the launch template (the `codemanMcpConfigJson` engine value), so there is no new capability flag that could disagree with the template.

Rejected. Writing the server into the user's Claude configuration: launch must not rewrite client configuration, and an entry there would outlive the instance that wrote it. `--strict-mcp-config`: it drops the user's own servers.

Measured on Claude Code 2.1.325. A `codeman` server the user already has in local scope is not started when the launch names one inline; `/mcp` shows a single `codeman`. Positionals after `--mcp-config` are read as more configs, so the flag stays ahead of `--name`.

## 2026-11-13 — The assistant rail does not ask for the transcript of a deleted session

**Type:** drift
**Touches:** `src/web/routes/canvas-conversation-routes.ts`, `packages/canvas/src/assistant.ts`, `test/canvas-view.browser.test.ts`
**Why:** Opening a conversation whose session had been deleted logged a 404 in the browser console for `last-response?context=full`. The record outlives its session, and the rail asked the session's transcript route anyway. A session with no answer yet answers 200, so the 404 only ever meant a missing session.
**Links:** [intent/2026-11-13-canvas-open-events.md](../intent/2026-11-13-canvas-open-events.md)

Decision. The conversation summary carries an optional `sessionGone: true` when the session is not on the server or not the caller's, and the rail skips the transcript read for it. The route's 404 is unchanged: it is the stable answer for a missing session. A page from before this release ignores the field and keeps logging the 404, which is what it did before.

The same slice changes one browser test. "never earns a 429 from its own view publishes" counted the publishes made during six rounds of clicks. A publish carries the state at the moment it is sent and one equal to the last is skipped, so under load every send could land on the round's resting state and the count stayed at one. The test now holds two states until each is published. The 429 check is unchanged.

## 2026-11-13 — An unnamed session has one name in the outline and the tab strip

**Type:** drift
**Touches:** `src/canvas/shell-sessions.ts`, `src/web/routes/canvas-shell-routes.ts`
**Why:** The classic view names an unnamed session after its folder and falls back to the short id. The canvas outline's row used the short id straight away, so the same session read `myapp` in one view and `a1b2c3d4` in the other.
**Links:** [intent/2026-11-13-canvas-open-events.md](../intent/2026-11-13-canvas-open-events.md)

Decision. The outline uses the classic rule through `sessionDisplayName()`. The classic view's `getSessionName()` is browser script and the outline's row is built on the server, and no module is loaded by both, so the rule exists once in each runtime. `test/canvas-shell-sessions.test.ts` cuts `getSessionName()` out of `app.js`, runs it as written and compares it with `sessionDisplayName()` over the cases, the way that file already pins the session order against the dashboard's. A change to either side fails the test.

## 2026-11-13 — A stalled case folder is logged per state change on the polled sessions route

**Type:** drift
**Touches:** `src/web/routes/canvas-failure.ts`, `src/web/routes/canvas-shell-routes.ts`
**Why:** Every canvas 5xx writes one error line. The sessions route is asked by the page on a timer, so one folder on a mount that stopped answering wrote an error line every few seconds for as long as a canvas page stayed open.
**Links:** [intent/2026-11-13-canvas-open-events.md](../intent/2026-11-13-canvas-open-events.md), [architecture-invariants, "Canvas failures and telemetry"](architecture-invariants.md#canvas-failures-and-telemetry)

Decision. The rule "every canvas 5xx writes a line" now has one stated exception: a polled route writes the line when a folder stops answering and one `recovered` line when it answers again. Each 503 still has its `requests.jsonl` line and its `requestId`, so a single answer can still be found. Workspace creation is a person's own request and keeps a line per answer. The memory is in the process and capped. It is lost on restart, which costs one repeated line.

## 2026-11-13 — The deploy gate runs four more canvas and telemetry tests

**Type:** intent-refinement
**Touches:** `deploy/test.sh`
**Why:** The plan's box "add each new test file that guards stored data to `deploy/test.sh`" was open for `test/canvas-shell-compat.test.ts`, and the tests added with the canvas failure work were never considered for the gate.
**Links:** [intent/2026-11-13-canvas-open-events.md](../intent/2026-11-13-canvas-open-events.md), [self-building, rule 7](self-building.md#follow-these-rules)

Decision. Added: `canvas-shell-compat` (the shell setting across a rollback), `canvas-failure-routes` (a canvas 5xx leaves a log line an agent can diagnose a bad deploy from, and no path in the body), `canvas-client-errors` (the canvas pages report browser errors and the boot guard still falls back to the classic view) and `ui-events` (the reporter's body is one the intake accepts). Left out: `canvas-view-sync`, which guards the page's publish pacing. A regression there costs a 429 on a view publish, which a later deploy fixes and no stored data or fallback depends on. Rule 7 of `docs/self-building.md` allows the gate to check more.

## 2026-11-13 — A request id names one request across restarts

**Type:** drift
**Touches:** `src/telemetry.ts`, `src/web/server.ts`
**Why:** A canvas 5xx answer carries `requestId`, and the logs join on it. Fastify's default id is a counter per process, so `req-6` named a new request after every restart and during a deploy both colours used the same ids.
**Links:** [intent/2026-11-13-canvas-open-events.md](../intent/2026-11-13-canvas-open-events.md)

Decision. The id itself is unique: `req-<tag>-<n>`, with eight random hex characters chosen once per process. The other option was to keep the counter and have readers join on `pid` or `buildId` as well, which the error answer does not carry. Two things read `req.id`: the `requests.jsonl` hook and `canvasFailure()`. Neither parses it, and no client does. A test runs 200 generated ids through the redactor, since a new token-like shape in a log line could have been masked.

## 2026-11-13 — The canvas and the tab strip write UI events, as tokens in batches

**Type:** intent-refinement
**Touches:** `src/web/public/ui-events.js`, `packages/canvas/src/ui-events.ts`, `src/web/routes/telemetry-routes.ts`, `src/web/public/app.js`, `packages/canvas/src/entry.ts`
**Why:** PC8 built the `ui-events.jsonl` stream and its intake, and nothing wrote to it. The plan names the two surfaces and no event list, body shape or limits.
**Links:** [intent/2026-11-13-canvas-open-events.md](../intent/2026-11-13-canvas-open-events.md), [architecture-invariants, "Canvas failures and telemetry"](architecture-invariants.md#canvas-failures-and-telemetry)

Decision. One reporter script serves both pages, because the dashboard is plain script and the canvas is a bundle, and two copies of the batching would drift. The intake keeps the one-event body and gains a batch body of at most 25 events, with optional `n` and `agoMs` on a line. A `target` is now a token on both sides (no whitespace), which is how "no typed text, prompt or object content" is enforced by structure instead of by review. The stream records what a person did: an agent's view command is left out because its request already has a line. Only discrete actions are recorded. Camera, focus and selection commands are left out because they run per frame or per key and the view registry holds their result.

Consequences accepted. A release that does not know the batch body answers 400, so events are lost while two colours overlap during a deploy; nothing is retried. Sends, comments and background runs are not separate events: each is a request with its own `requests.jsonl` line. `docs/self-building.md` still describes the one-event line without `n` and `agoMs`; rule 11 there reserves that file for the owner.
## 2026-11-13 — Agents may start canvas conversations and background tasks, within bounds (reverses PC9b and PC12)

**Type:** retraction
**Touches:** `src/canvas/{agent-start,tasks,commands,conversation-schema}.ts`, `src/web/routes/{canvas-conversation-routes,canvas-task-routes,canvas-routes}.ts`, `src/web/ports/canvas-port.ts`, `src/web/server.ts`, `src/mcp-server.ts`, `src/types/session.ts`, `packages/canvas/src/{assistant,task}.ts`
**Why:** The owner's instruction of 2026-11-13 overrides the earlier decision that starting a conversation, and starting, cancelling or removing a background task, are human-only (PC9b fix round 2026-11-12; PC12 intent and fix round 2026-11-13). The capability matrix asks for an agent counterpart to every human command.
**Links:** [Intent](../intent/2026-11-13-canvas-agent-start.md), [architecture-invariants, "Canvas agent starts"](architecture-invariants.md#canvas-agent-starts)

What the earlier decision guarded against. A start is an agent session on the person's own account, so it costs money and runs code without a click. Agents starting agents can fan out, or loop with no person in it (PC9b already refused a send from any conversation's session for the loop half). A person's canvas could fill with work they cannot tell from their own. And a task in a non-git case runs in the shared folder only on the person's consent.

Decision. Agents get `canvas_conversation create` (previously a 403) and a new `canvas_task` tool (`list | start | cancel | remove`, the thirtieth MCP tool), answered by the same functions as a person's click, under bounds held in code: the workspace is the one the agent's own session sits in; no new spawn path, and the session is created with the agent as its spawn parent and no respawn, auto-resume, Ralph or keep-warm field; depth one, refusing a start from any session an agent started and from any session whose recorded spawn chain reaches one (`NESTED_AGENT`), which also closes the route through a worker spawned with `codeman agent spawn`; agents together hold at most two live conversations and two active tasks per canvas beside the existing caps (`AGENT_CAP`); the record carries `startedBy` and the rail and task list say so; an agent cancels, removes or retries only what it started (`NOT_YOURS`) while the person can act on anything; and an agent cannot give the person's consent to the shared folder, a thread origin or a parent conversation. Sessions of person-started conversations may start, because "ask my assistant to run this in the background" is the use the owner named, and the work they start may not start more.

`parentSessionId` was decoration only. It is now also read to refuse, never to grant, which is why a caller-chosen value is acceptable there. Codeman's own spawn tools (`codeman agent spawn`, the MCP `start_session`) record it; a session started without it escapes the depth rule the same way a caller without the agent header escapes every agent rule.

One change outside the slice: the capability answer was 49 bytes under its 60,000-byte bound, so adding any tool would have truncated it. Generated schemas now drop zod's uuid `pattern` beside `format: "uuid"`, about 5 KB.

Not bounded: one agent working through a long turn can start, wait, remove and start again within the caps. No lifetime budget per agent session is built.
## 2026-11-13 — Tool rows, Sources used and release outcomes in the canvas conversation

**Type:** retraction
**Touches:** `src/canvas/{transcript-activity,release,conversation-schema,commands}.ts`, `src/web/routes/{session-routes,canvas-conversation-routes}.ts`, `src/web/ports/canvas-port.ts`, `src/web/server.ts`, `src/mcp-server.ts`, `packages/canvas/src/{activity,assistant}.ts`, `src/web/public/canvas.css`, `deploy/test.sh`
**Why:** The owner asked for the three conversation items the plan lists as open at close: tool result rows, a surface named Sources used that includes what the agent read later, and release outcomes in the conversation that asked.
**Links:** [Intent](../intent/2026-11-13-canvas-conversation-activity.md), [architecture-invariants, "Canvas conversations"](architecture-invariants.md#canvas-conversations)

This replaces two statements in the PC9b entry of 2026-11-12: "Tool activity rows are not built" and "the manifest line is the 'Sources used'". That entry gave no reason. The reason found in the code is that the rail and reply routing share one transcript reader that drops every tool block, and reply routing needs its rows to stay text only. So the reader was not changed for its callers; it takes an optional ledger that collects the tool blocks in the same pass, and only the new activity read asks for one.

Decisions. Activity is a separate canvas read (`.../conversations/:id/activity`, and inside the `canvas_conversation read` answer for agents, bounded to about 12 KB; it is not a new action or field because the capabilities answer is 59,969 bytes against its 60,000-byte limit and has no room for one) and not a new shape of `last-response`, so the stable session API answers what it did and reply routing cannot see a tool row. Nothing is stored: prompts and tool output carry secrets, and `conversations.json` keeps the shape the previous release reads. Tool fields are cut and redacted on the server, with the telemetry redactor; the cost is that a harmless line containing a word such as `key` is sometimes masked. A shell command is not listed under Sources used, because its text does not say what it read; that gap is stated here and not papered over with a guess. Tool rows exist for Claude transcripts only, which is every available provider today. Sources used is one disclosure per turn that lists what was sent and what was read; the line of labels under a message stays, so the earlier decision is extended and not undone. Activity rows are not `.turn` elements, so existing counts of prompt and reply rows hold.

Release outcomes. A release is recognised as the conversation's own agent running `codeman-deploy`, which is the only sense in which a conversation "asked for" one. The outcome is the supervisor's record, found by the deploy id the command printed or by action, commit and start time; when the supervisor's five recent runs no longer list it, the row shows the command's own `outcome:` line and says so, because that line is the agent's output and can be forged. No release control was built. The plan's note "no release was started from the canvas" is a verification item (a person asking a canvas conversation to release, on the live install), not a missing control: the plan itself says not to make the canvas a second deployment control plane, and a trigger would let an agent-steerable page start a deploy. That run remains for the owner or coordinator.

## 2026-11-13 — The canvas and its shell are on by default, by absence

**Type:** status-transition
**Touches:** `src/web/shell-landing.ts`, `src/web/server.ts`, `src/web/public/settings-ui.js`, `src/web/public/session-ui.js`, `src/web/public/mobile-overview.js`, `test/classic-dashboard.ts`, `docs/architecture-invariants.md`, `docs/subsystem-rules.md`
**Why:** The program's last box is to turn `canvasEnabled` and the shell setting on by default once the gate passes. A default that had to be written into `settings.json` would need a migration, and a rollback could not read it back.
**Links:** [intent/2026-11-13-canvas-default-on.md](../intent/2026-11-13-canvas-default-on.md), [architecture-invariants, "Canvas shell"](architecture-invariants.md#canvas-shell)

Decision. Both settings are tri-state by absence: a key absent from `settings.json` reads as on, `true` is on, and only an explicit `false` is off. Nothing writes the key to make it so. The server reads through `canvasOn()` and `shellActive()`, the browser through `canvasSettingOn()`, and no other code compares either key. A Settings save still sends `canvasShellEnabled` only when its box changed, so opening and saving Settings flips nothing and unticking the box stores `false`. The browser drops its stored copy of a key the server does not have.

Consequences accepted. An install that already stores `canvasEnabled: false` stays off until someone ticks the box. The previous release reads an absent key as off, so a rollback returns `/` to the dashboard and hides the canvas until the keys are explicit; stored data is unchanged. The fallback is as it was: a missing canvas file or an unreadable registry answers the dashboard with the notice, and `/classic` depends on no canvas file.
## 2026-11-13 — The canvas program is built and gated, and stays open on 50 boxes

**Type:** status-transition
**Touches:** `docs/agentic-canvas/initial-version-plan.md`
**Why:** PC1 to PC13 are merged and deployed, and the closing phase gate passes on the deployed build. The plan closes only when every box is checked, and a reconciliation of the plan against the merged work left 50 boxes open.
**Links:** [Plan, "Open at close (2026-11-13)"](agentic-canvas/initial-version-plan.md#open-at-close-2026-11-13)

Decision. The plan was reconciled against the repository in one pass: 306 boxes ticked with evidence and 50 left open, each with an `Open:` note. Most ticks rest on test titles and spot reads of the code, not on a fresh run of every test. The program is not declared complete. The default-on change waits in its own PR for the owner, because merging it turns the shell on for an install whose settings file has no shell key.

What stays open. Seven items are not built or not built in full (human export, tool result rows and a Sources used surface in the conversation, release outcomes in the conversation, canvas writes to the UI event stream, the agent-side start of conversations and tasks, and the defaults). Some built behaviour was never exercised live, such as voice with real audio and multi-user mode. One defect stands: reordering an unlocked object is refused when a sibling is locked. The rest are process boxes whose evidence was not kept and cannot be recovered.

## 2026-11-13 — Undo compares what an edit left, not the revision number

**Type:** drift
**Touches:** `src/canvas/commands.ts`, `src/canvas/operations.ts`, `packages/canvas/src/entry.ts`, `docs/agentic-canvas/canvas-foundations.md`
**Why:** The closing check of the canvas program found that a second Ctrl+Z on the same object was refused with `REVISION`. The server required the object's revision to equal the revision the undone edit produced, and the first undo had already bumped it.
**Links:** [Intent](../intent/2026-11-13-canvas-repeated-undo.md), [canvas foundations, "History contract"](agentic-canvas/canvas-foundations.md#history-contract)

The revision number was a stand-in for the real question, which is whether the inverse still restores exactly what the edit replaced. A history step is now accepted while every object it touches holds the fields the edit left, ignoring `revision` and `updatedAt`. A person's own undo or redo in between passes; any other later edit changes a field and is refused as before. Two alternatives were set aside. Recording on each undo which revision it restores would add a field to the stored operation record, which the previous release must keep reading. Letting the browser send the expected revision would fix people and leave agents broken, and the server would trust a number it cannot check.

One consequence is accepted on purpose: if someone changes an object and then puts every field back, an older undo runs, because nothing of theirs is lost. Inverse operation ids now include the sequence the step is built on. Without that, undoing one edit a second time after its redo repeated the first undo's id and was answered as a duplicate that wrote nothing.

The same change makes `S` and `W` answer from the outline's buttons in the canvas shell, and Escape return the keyboard to the board. The shell's own flows left focus there, where no shell key was heard.
## 2026-11-13 — A canvas fault is diagnosable from telemetry (closing gate fix)

**Type:** propagated-discovery
**Touches:** `src/web/routes/canvas-failure.ts`, `src/web/routes/canvas-routes.ts`, `src/web/routes/canvas-shell-routes.ts`, `packages/canvas/src/client-errors.ts`, `packages/canvas/src/view-sync.ts`, `src/web/webview-proxy.ts`
**Why:** The program's closing gate (plant a failing request, diagnose it with `logs_query`) passed only in part: the agent found the 500 and not its cause.
**Links:** [Intent](../intent/2026-11-13-canvas-telemetry.md), [architecture-invariants, "Canvas failures and telemetry"](architecture-invariants.md#canvas-failures-and-telemetry)

Every canvas answer of 500 or above now goes through one function that logs the cause once, with the route template and the request id of the `requests` line, and answers with a sentence that carries no path. The 503 for a case folder that is not responding lost the path it used to end with; that path is in the log line. Both canvas pages report browser errors with the dashboard's limits. The view publisher's 429 was the page's own pacing: it counted its gap from the send while the server counts from the handling, so the gap is now counted from the answer and one publish is in flight at a time. The server's limit is unchanged. The proxy's attribute rewrite takes unquoted values. The gate was not rerun in this change, which starts no server.

## 2026-11-13 — An agent's view command only steers the view (PC13 audit fix round 1)

**Type:** intent-refinement
**Touches:** `packages/canvas/src/full-view.ts`, `packages/canvas/src/entry.ts`, `packages/canvas/src/view-sync.ts`, `packages/canvas/src/shell-view.ts`, `src/canvas/view-schema.ts`, `src/web/public/app.js`, `src/web/routes/canvas-shell-routes.ts`, `src/canvas/commands.ts`, `src/mcp-server.ts`
**Why:** The audit of PC13 found that an agent's `canvas_view full-view` framed the session page, whose automatic reattach starts a stopped session and can raise the breaker's confirm, and that the frame swallowed the keys of a person typing on the canvas.
**Links:** [Intent, "Audit fix round 1"](../intent/2026-11-13-canvas-pc13-shell.md#audit-fix-round-1), [architecture-invariants, "Canvas shell"](architecture-invariants.md#canvas-shell)

The rule is now stated and enforced where the write happens: an agent-issued view command never starts a CLI, never raises a dialog and never takes a keystroke. An agent's open frames the session page with `passive=1`, and that page shows a stopped session as stopped until the person presses Start session. The open is refused for an unlisted or ended session, on a phone, and while the person's focus is in an editable field. The command route cannot know the browser's focus, so a refusal is published by the view (`refused: { commandId, reason }`) and read with `canvas_view read`. Also in this round: the session list refetch is throttled to one per 2 s and stops while the page is hidden, the list route drops `pastCap` and leaves remote sessions out, and the agent-facing text says what a full view does and that a read can be a few seconds stale.

## 2026-11-13 — A session's terminal as a full view over the canvas (PC13 part 3)

**Type:** intent-refinement
**Touches:** `packages/canvas/src/full-view.ts`, `packages/canvas/src/entry.ts`, `src/canvas/view-schema.ts`, `src/web/public/app.js`, `src/web/public/terminal-ui.js`, `src/web/public/canvas.html`
**Why:** The intent fixed frame or navigate; it left how the session page learns its origin, where the back chord is listed, and what a notification for another workspace does.
**Links:** [Intent, "Decisions"](../intent/2026-11-13-canvas-pc13-shell.md#decisions), [architecture-invariants, "Canvas shell"](architecture-invariants.md#canvas-shell)

The full view is the existing single-session page: one unsandboxed same-origin frame over an inert canvas on a laptop, a window navigation with a one-use return ticket on a phone. The canvas gained no terminal code and no write to a pane; it hears two messages from the frame it opened and sends none. The session page turns on its Canvas button and back chord from `from=canvas` on its own address, so it still reads no setting, and the chord is a registry entry that exists only on such a page, which keeps Ctrl+Shift+Backspace and the Shortcuts list unchanged everywhere else. A notification for a session outside the open workspace goes to the classic view after one ownership-checked read, since the canvas lists only its own workspace's sessions.

## 2026-11-13 — Workspaces, sessions and Go to in the canvas outline (PC13 part 2)

**Type:** intent-refinement
**Touches:** `src/canvas/shell-sessions.ts`, `src/web/routes/canvas-shell-routes.ts`, `packages/canvas/src/shell-view.ts`, `packages/canvas/src/home.ts`, `src/web/public/canvas.html`, `src/web/public/app.js`
**Why:** The brief left the wording of states, the update line and the Settings link to the builder, and one requested line could not be built as asked.
**Links:** [Intent, "Decisions"](../intent/2026-11-13-canvas-pc13-shell.md#decisions), [architecture-invariants, "Canvas shell"](architecture-invariants.md#canvas-shell)

Sessions are rows derived per request and never canvas content. The order is a port of the dashboard's comparator with a parity test, because the canvas bundle cannot load the classic script. An idle prompt somebody already looked at reads Idle, not Waiting, which is what the dashboard's alert does. An "Update available" line was asked for; the server holds no such fact without asking GitHub, so the line says "Codeman was updated" from the release notes file and the browser's own seen version, and the canvas makes no update check. Settings (classic) is a real deep link, `classic?open=settings`, honoured only with the shell on. A terminal row opens the session's own page by navigation in this part; part 3 puts that page in a frame on a laptop.

## 2026-11-13 — The canvas shell's routes, setting and fallback (PC13 part 1)

**Type:** intent-refinement
**Touches:** `src/web/shell-landing.ts`, `src/web/server.ts`, `src/web/public/canvas.html`, `packages/canvas/src/shell.ts`, `src/web/public/app.js`, `src/web/public/settings-ui.js`, `docs/architecture-invariants.md`
**Why:** The intent left four points to the builder, and two of its sentences did not survive the code.
**Links:** [Intent, "Decisions"](../intent/2026-11-13-canvas-pc13-shell.md#decisions), [architecture-invariants, "Canvas shell"](architecture-invariants.md#canvas-shell)

`/` serves the canvas document itself and the page names its workspace with `replaceState`: no redirect, so the lost-frame and auth rules see the same request as before. The dashboard gets its shell flag only while both settings are on, which keeps a shell-off `/` byte-identical even when the query asks for a notice; the intent had the flag appear whenever a notice applied. `/classic` does read the settings, for the Canvas link, where the intent said it would not. The workspace memory is a cookie the page writes, because the server must choose before any script runs. The first-run page is a second small entry (`canvas-home.js`). Without scripts there is only the plain classic link, since the dashboard needs scripts too. The Settings page sends the new key only when its box changed, and saves the rest when a rolled-back server refuses it.

## 2026-11-13 — The canvas shell is shaped and PC13 is scoped

**Type:** intent-refinement
**Touches:** `docs/agentic-canvas/canvas-ui-ux-brief.md`, `docs/agentic-canvas/initial-version-plan.md`, `intent/2026-11-13-canvas-pc13-shell.md`
**Why:** The plan requires a shape pass and a surface inventory before PC13 code, and its two open questions (synced or per-device setting, the classic route's name) had no answer.
**Links:** [Intent](../intent/2026-11-13-canvas-pc13-shell.md), [Brief, "Canvas shell (PC13)"](agentic-canvas/canvas-ui-ux-brief.md#canvas-shell-pc13), [earlier intent](../intent/2026-11-12-canvas-first-shell.md)

Documents only; no code. The owner delegated design decisions for this program, so shape's interview was answered from the source documents and the assumptions are listed in the brief.

Decisions. With the shell on, `/` answers with the canvas document for the workspace last used on that device, never with a redirect, because the service worker precaches `/`. The classic dashboard's route is `classic`. The shell setting is `canvasShellEnabled`, synced, off by default and independent of `canvasEnabled`; the shell needs both. Last-used workspace is per device, held in a cookie the server validates, so no `GET` writes settings.

Sessions are rows in a Sessions section of the outline, one row per live session in the workspace's case, ordered by state. No session is placed on the board and none writes to the operation log. Every session has one full view, its terminal, and that view is Codeman's existing single-session page. On a laptop it opens in a same-origin frame over the canvas, so the canvas document is never unloaded and the camera, selection and rail are unchanged by construction. On a phone or a touch-first device the window navigates to the session page and back with a one-use return ticket, because the dashboard reads the software keyboard from `visualViewport`, which a framed page does not see. Hosting the whole dashboard in a frame was rejected: the session page already exists, is a registered route the lost-frame rule never answers, and shows one session.

The fallback has three parts: the server answers `/` with the classic view when a canvas file is missing; an inline guard in the canvas document navigates to the classic view when the bundle does not load or does not start; and a plain link works with no script. The automatic target is `/?view=classic`, which a pre-PC13 release ignores and answers with the dashboard, so a rollback in mid-load still lands on a working page. The guard never navigates when the address already asks for the classic view, which is what prevents a loop when the service worker serves a cached canvas document offline.

The inventory has 65 surfaces: Canvas 5, Outline 8, Rail 1, Full view 8, Classic 42, Server page 1. Classic-only is a deliberate home for deep or rare surfaces, including all of App Settings and Deploys, so recovery never depends on the canvas. The plan's verification line was reworded to match: surfaces not marked classic-only are reachable without the classic view, and classic-only surfaces through the classic link. The first PC13 box is ticked.

Not determined from the code and left to the builder, with a test named for each in the intent: whether a previous release's Settings save echoes an unknown synced key into the strict schema; which of the inventory's Full view surfaces the single-session page really draws; and whether Ctrl+Shift+Backspace is free on every platform.

## 2026-11-13 — Background tasks: what a cancel, a crash and a restart leave (PC12 fix round 1)

**Type:** intent-refinement
**Touches:** `src/canvas/{tasks,conversation-delivery}.ts`, `src/web/routes/{canvas-task-routes,canvas-conversation-routes,session-routes}.ts`, `src/web/ports/canvas-port.ts`, `src/session.ts`, `src/git-worktrees.ts`, `packages/canvas/src/{task,tasks-view,assistant,entry,voice,voice-view,storage-keys}.ts`
**Why:** A review and a run on a real agent found that a cancelled task's request could still be submitted, a crashed agent read as completed, a restart left tasks running for ever, and a task that only replied could not be removed on a machine whose git ignores differ.
**Links:** [Intent](../intent/2026-11-13-canvas-pc12-background.md)

Decisions made in this round. A cancel is recorded before any key is sent, and the delivery asks whether its message is still wanted before the paste and immediately before every Enter, so the order of the two cannot let an Enter through. A request left in the composer is cleared with Escape only on evidence, a fresh screen read that shows text there, and at most three times; an Escape to an empty composer means something else in the CLI, so none is sent blind. When the composer cannot be read or will not clear, the row says so and the task refuses every later message, because any Enter in that session would run the request.

State still is not stored, and live evidence now comes first: a session that is working or asking outranks a recorded turn end. After a restart the turn-end time held in memory is gone, so a turn end nobody saw is inferred only from the screen and the transcript together (no work on the screen, no question pending, the request found in the transcript, no write to it for thirty seconds, two reads that agree). The inference settles the task and never posts into a thread; a thread reply still waits for a turn end this process sees. A message recorded on its way with no delivery of this process carrying it is an orphan: the transcript decides delivered or not delivered, and Retry is the only thing that sends it again.

An abnormal exit is an exit status other than 0, a signal, or no status at all. It fails the task and shows what was written as a partial result. A clean exit with a reply still completes it.

The repository's `info/exclude` gets Codeman's own lines every time a task worktree is made, without asking git whether they are already ignored. The probe answered for the server's git configuration at that moment, and Remove can run under another. The alternative, deciding at Remove that only Codeman's files changed, would need to tell them from an agent's edit of the same files and was rejected.

A worktree named by this subsystem that no record names is listed, not swept: a start that died after `git worktree add` may have been followed by a person's own work in that folder.

"Only a person" is the caller-declared agent header. The docs now say what that does and does not keep out.

## 2026-11-13 — Background agent tasks from the canvas assistant (PC12)

**Type:** intent-refinement
**Touches:** `src/canvas/{tasks,conversations,conversation-schema,conversation-delivery,view-schema}.ts`, `src/web/routes/{canvas-task-routes,canvas-conversation-routes,canvas-routes,worktree-routes}.ts`, `src/mcp-server.ts`, `packages/canvas/src/{task,tasks-view,assistant,entry,shortcuts,commands,storage-keys}.ts`, `src/web/public/{canvas.html,canvas.css}`
**Why:** The assistant held one foreground conversation, Keys listed `G` and Cmd/Ctrl+Shift+Enter as not bound, and two agents asked to edit one case would have shared its checkout.
**Links:** [Intent](../intent/2026-11-13-canvas-pc12-background.md)

A task is a conversation record with a `task` part, started by one route that makes a git worktree of the case, starts a session in it through the conversation session start, records the task and sends the request through the conversation send. Each step is undone in reverse when a later one fails. The previous release reads the record as an ordinary conversation.

Decisions the intent did not settle. State is derived when a task is read; the record keeps only the cancel time, the time the turn was seen to end, and the removal. That turn end is written by the pass that posts thread replies, on its evidence and its two agreeing reads, so a task is never called completed because agent text is present. A git case always gets a worktree and the consent to share is used only where none can be made. Remove deletes the record when the worktree is gone and keeps the row, with the worktree's place inside the case and the reason, when git will not remove it. Tasks stay out of the conversation picker and are reached through Inspect. An agent can read tasks and can do nothing else to them, including sending a message to one. The composer is cleared on the server's acknowledgement, and the request id is kept with the draft until then.

One change outside the task code: a delivery that is waiting for a composer now stops when its task is cancelled, instead of waiting out the ready timeout.

Limit: sessions in the tests are stand-ins and transcripts are written by the test. No real agent has run a task. Worktrees are made and removed by real git in a temporary repository.

## 2026-11-12 — Voice ends when its frame is hidden, and a reply waits for the turn to end (PC11 fix round 1)

**Type:** retraction
**Touches:** `packages/canvas/src/{voice,voice-capture,voice-view,assistant,entry}.ts`, `src/web/routes/canvas-routes.ts`, `src/web/public/{canvas.html,canvas.css}`
**Why:** An audit of the first PC11 commit and a run in the real dashboard found the microphone could stay open with no indicator on screen, and a reply could be read early or to nobody.
**Links:** [Intent](../intent/2026-11-13-canvas-pc11-voice.md)

This replaces three statements in the entry below. "A hidden page ends capture" was not enough: the canvas runs as a frame in the dashboard, and a tab switch there hides the frame with no visibility event, so capture went on unseen. A frame that is no longer drawn is now a hidden page, checked on blur and twice a second while anything of voice is live. "Read once when the turn has settled" read whatever agent text was present the first time the session was not working: the reply now waits for a turn end seen after the send, is read again 1.5 seconds later and spoken only if unchanged (the same late last row that PC10's thread replies met), and is not read into a hidden page or for another conversation. "Stop, Escape, ... end capture without sending" left out the composer's own Send and Enter, which sent the message and left the capture running to write the same words back; a composer send now ends the capture.

Other decisions of this round. Escape is heard before every other handler and stops none, so a menu or lasso still acts on the same press. The turn is bound to the conversation a send would reach when the countdown starts. The composer's send joins a send already travelling. The relay is called listening only after its `ready` frame. Playback needs a voice, not just a synthesis object. The rail opens for the countdown and the indicator carries it with Cancel send.

Limit, unchanged: every test runs on fixtures. A real microphone was shown to open inside the dashboard's frame in a manual run by the coordinator, not by these tests.

## 2026-11-12 — Dictation and voice conversation in the canvas assistant (PC11)

**Type:** intent-refinement
**Touches:** `packages/canvas/src/{voice,voice-capture,voice-view,assistant,entry,shortcuts}.ts`, `src/web/routes/canvas-routes.ts`, `src/web/ports/canvas-port.ts`, `src/web/server.ts`, `src/web/public/{canvas.html,canvas.css}`
**Why:** The assistant took typed text only, and Keys listed `B` and Shift+B as not bound.
**Links:** [Intent](../intent/2026-11-13-canvas-pc11-voice.md)

Decisions the intent did not settle. The page learns whether the relay can be used from one boolean, `voice.relay`, on the providers GET; nothing else about voice is exposed. The capture worklet is the dashboard's file, referenced by a link the server already versions, not a copy. Voice text always goes into the composer draft, and a conversation turn is sent by the assistant's ordinary send, so there is one send path and one message id discipline. A turn is two presses of the same control followed by a three-second window with Cancel; Stop, Escape, a hidden page, an edit, composition and going offline end capture without sending and keep the text. The spoken reply is the agent's text for that turn, cut at about 600 characters at a sentence end, read once when the turn has settled.

The microphone can be opened only by a trusted key press or click that the voice view itself listens for. The start is private to that class and is not a view command, so an agent that can drive the view cannot reach it; a browser test sends an `assistant` view command and a scripted click and checks that no microphone request follows.

Limit: every test runs on fixtures (an oscillator stream, a scripted relay socket, recorders for recognition and synthesis). No real microphone, transcription or playback has been exercised.

## 2026-11-12 — Thread replies wait for evidence instead of guessing (PC10 fix round 1)

**Type:** retraction
**Touches:** `src/canvas/{thread-reply,conversation-schema}.ts`, `src/web/routes/{canvas-conversation-routes,hook-event-routes,session-routes}.ts`, `src/web/ports/canvas-port.ts`, `src/web/server.ts`, `src/session.ts`, `packages/canvas/src/{ask,comments}.ts`
**Why:** An audit of the first PC10 commit found that a reply could be posted wrong or early, and a reply is recorded once and never corrected.
**Links:** [Intent](../intent/2026-11-12-canvas-pc10-threads.md)

This replaces the settle rule in the entry below ("the newest prompt is settled only when no hook turn is running", with its known limit, and "a session that ended before a reply leaves the request waiting"). A prompt the CLI queued during a turn no longer closes the turn before it; a turn that absorbed one gives each thread request in it the turn's whole text with a line saying so, because the text cannot be split between the messages. An open turn is settled only on a turn end this process observed after the message was delivered, with the session not working, and only when a second read a moment later gives the same text. A throw while posting records nothing and is retried; `refused` is kept for an append the command path answers as invalid, and for a comment already under the reply id that is not on the origin object by that conversation's agent session. An exited agent records `session-ended`, and a request with no prompt in the transcript, or a session this process does not hold, gives up after 24 hours (`timed-out`, `session-ended`). An unchanged transcript is not re-read. The stop callback runs only for a mode whose hooks are available. In the browser, an attempt cut off by a reload comes back as the draft with Retry, Post on it reuses the stored comment ids, and the attempt is dropped once the list shows the message. Accepted cost: a turn whose stop this process never saw stays "Waiting for a reply" until a later prompt closes it or the age bound passes.

A run on a real agent then showed two more ways to post the wrong text, and both are answered by letting a reply grow instead of making it final. A turn of text, a tool call and text posted only the first text, because the stop hook came before the last row was written; and an agent that ended its turn waiting on a background task had its interim line posted, while the answer it wrote after resuming by itself was never posted. A reply is now all the text after its prompt up to the next submitted prompt. The record keeps how much was posted, and text added later goes out as a further comment (`reply-<messageId>-2` to `-5`) under the same rules, deduped by the recorded length so a reverted part is not posted again. The two reads are 1.5 seconds apart, and a pass that posted into an open turn tries again by itself. The thread says "Reply removed" when the reply's comments are gone, keeps an unposted draft per object across a reload, and reads Working from the same server state on phone and desktop. F1 while typing opens Keys in the thread composer as it does in the rail composer; that was left as it is.

A second run showed the evidence rule compared the stop with the wrong time. Delivery is confirmed about a second after the write, so on a warm session a quick turn's only stop came before `deliveredAt` and the request waited for the next prompt. The message now records `submittedAt` when the server begins writing it to the pane (a retry that writes again stamps it again), and the stop is compared with that. A confirmed delivery routes replies itself, and a stop that finds the message still being delivered tries again.

## 2026-11-12 — Ask an agent from a comment thread (PC10)

**Type:** intent-refinement
**Touches:** `src/canvas/{conversation-schema,conversations,thread-reply}.ts`, `src/web/routes/{canvas-conversation-routes,hook-event-routes,session-routes}.ts`, `src/web/ports/canvas-port.ts`, `src/web/server.ts`, `packages/canvas/src/{ask,comments,assistant,conversation,entry,storage-keys}.ts`, `src/web/public/{canvas.html,canvas.css}`
**Why:** A comment was only a note; a person could not ask an agent about an object from its thread, and an answer never came back to where the question was asked.
**Links:** [Intent](../intent/2026-11-12-canvas-pc10-threads.md)

Decisions the intent did not settle. `origin` and `reply` are stored as unknown values behind lenient readers, so a later shape can neither make `conversations.json` unreadable nor cause a second post. The reply comment id is `reply-<messageId>` and the existing comment is the dedupe, with one chain per workspace. The reply is appended in-process with the agent session as author, because the stop hook carries no person's credentials; the transcript is read through the `last-response` reader handed to the canvas port. Routing runs on the stop hook and on every conversations list or read; the newest prompt is settled only when no hook turn is running, which leaves one known limit (a reconcile after a restart mid-turn can post the text so far). A session that ended before a reply leaves the request waiting and the thread says so; a closed turn with no text records `no-reply`. A send whose comment or object is gone is refused (`ORIGIN_GONE`). The prompt is the comment text alone. The chooser is a native select defaulting to the rail's live conversation, else the newest live one, else New; ended conversations are not offered. Ask agent has no shortcut, because Cmd/Ctrl+Enter already posts and the brief names none. `origin` is kept out of the tool's create shape to hold the capabilities answer under its byte budget. MCP parity was checked and nothing was missing. The route test's mock session gained `markHookStop`, which nine hook-event route tests needed on the default branch too.

## 2026-11-12 — Provider and model choice, the phone assistant and Keys (PC9c)

**Type:** intent-refinement
**Touches:** `src/canvas/providers.ts`, `src/canvas/{conversation-schema,view-schema,commands}.ts`, `src/web/routes/{canvas-routes,canvas-conversation-routes}.ts`, `src/web/server.ts`, `packages/canvas/src/{assistant,providers,entry,shortcuts}.ts`, `src/web/public/{canvas.html,canvas.css}`
**Why:** The owner wants to keep building the canvas from the canvas, which needs a choice of agent and model, an assistant on a phone, and Keys that names the new shortcuts.
**Links:** [Intent](../intent/2026-11-12-canvas-pc9c-providers.md)

Decisions the PC9 plan did not settle. Availability is "can delivery confirm a submit" (claude by its hook, any CLI by a declared composer ready mark plus glyph) AND "can Codeman tell the CLI is waiting on an approval or question" (a hook, or a declared `blockedLine`); everything else is listed unavailable with a reason rather than offered and left to strand a message or paste a second message into a dialog nobody was shown. That leaves only claude available among the stock CLIs; copilot has composer evidence but no hook and no `blockedLine`, so it is listed unavailable until it gains one. A create naming no CLI is the old behaviour and is not probed, so a server whose probe lists nothing still starts what it did. The model control is a text field with suggestions from models this canvas already used (the registry has no catalogue and the launch defaults are settings keys, not ids). A model id is validated per CLI at the narrowest shape its create schema accepts. The choice is `null` until someone chooses, persists per viewer, and opening another conversation clears it so a pending choice never redirects an old thread; a changed choice with a conversation bound makes the next send create a new one. `canvas_conversation model` is one action with `operation: read | set` and a `viewId`, applied through the same view-command path as `canvas_view`, so the open view's selectors follow it. The phone dock gets an icon-only assistant control (a fifth labelled control does not fit 390 px) and tighter paddings. Retry after a reload falls back to the interrupted attempt's text. `P` focuses the provider and Shift+P the model. Fix round 1 (audit): availability also needs a visible waiting dialog, a create naming no CLI still needs the default CLI enabled, the model field is capped at 100 characters, and a choice an agent set is labelled as such in the rail.

## 2026-11-12 — The canvas becomes the shell after PC12 (PC13)

**Type:** intent-refinement
**Touches:** `docs/agentic-canvas/initial-version-plan.md`
**Why:** The owner wants all of Codeman to exist in a canvas, not the canvas as a tab in the dashboard, and no step in the plan got there.
**Links:** [Intent](../intent/2026-11-12-canvas-first-shell.md)

The canvas tab stays as it is through PC12. PC13, after PC10, PC11 and PC12, makes `/` open the canvas, gives every dashboard surface a home on the canvas, the outline or the rail, and keeps the dashboard at its own route as a fallback that never depends on the canvas bundle. The shell has its own setting, separate from `canvasEnabled`, and the final default switch now turns both on. Phase 5's "shell" in Appendix E is the deploy and control plane, not the UI.

## 2026-11-12 — Canvas conversations fix round (PC9b)

**Type:** drift
**Touches:** `src/canvas/conversation-delivery.ts`, `src/canvas/send-limit.ts`, `src/web/routes/canvas-conversation-routes.ts`, `src/session.ts`, `src/web/routes/hook-event-routes.ts`, `packages/canvas/src/{assistant,conversation,outbox}.ts`
**Why:** A live run against a real Claude session showed the first message stranded in the composer while recorded delivered, the transcript's paste wrapper leaking the context block, no working line, and two ways a conversation could cost money or loop.
**Links:** [Intent](../intent/2026-11-12-canvas-pc9b-conversations.md)

Delivered now means submitted. Send answers at once and a per-conversation chain pastes once after the composer is ready, then confirms from the prompt-submitted hook or an empty composer, pressing Enter alone while text remains; a timeout leaves the conversation stuck so nothing is pasted behind it and Retry checks the composer first. Docker and remote cases are refused before anything starts. Starting is human-only; an agent inside any conversation cannot send; sends are rate limited per conversation. The context block is now always present so every prompt row carries its message id, which gives the rail author labels and survives the CLI's wrapper. Working comes from the hooks that fire (`hook:prompt_submitted`, `hook:stop`), with `Session.hookTurnRunning` after a reload. Not decided here: the permission mode these sessions launch with (the owner's call).

## 2026-11-12 — Canvas conversations and projection (PC9b)

**Type:** intent-refinement
**Touches:** `src/canvas/{conversation-schema,conversations,context-resolve}.ts`, `src/web/routes/canvas-conversation-routes.ts`, `src/web/routes/canvas-routes.ts`, `src/web/ports/canvas-port.ts`, `src/web/server.ts`, `src/canvas/commands.ts`, `src/mcp-server.ts`, `packages/canvas/src/{assistant,conversation,outbox}.ts`, `src/web/public/canvas.{html,css}`
**Why:** The assistant rail kept chips and a draft but Send did nothing; a person could not hold a conversation with an agent about their canvas.
**Links:** [Intent](../intent/2026-11-12-canvas-pc9b-conversations.md)

Decisions the PC9 plan did not settle. Create goes through `app.inject` on the same app with the caller's own `authorization`, `cookie` and `host` headers instead of a copy of the create route, so the existing launch rules apply untouched (the port method is optional, so older test ports compile). The send body drops the plan's `viewId`, which nothing used; create takes only `requestId` (Claude only, no `cliId` or `model` until PC9c). The record carries `namedSha256` so a retry is compared by the ids the sender named, not by what resolved. The `message` attribute in the context block is how a prompt row is matched to its manifest and stripped for display; a message with no context carries no block and is matched to its transcript row by identical text. A multi-line paste is allowed (line breaks only), which means `SubmitVerifier` cannot confirm it; this is recorded as a risk, not solved. An ended conversation refuses a send (`SESSION_ENDED`) and the rail offers Start a new conversation rather than starting one silently. After a reload the rail rebinds to the newest conversation. Tool activity rows are not built; the manifest line is the "Sources used". `canvas_conversation send` is provided for agents because the plan lists it, with the same ownership checks and a refusal to message the caller's own session. The duplicate `threadEmpty` id (Comments owns it) was caught in review captures and the assistant's is `assistantEmpty`.

## 2026-11-12 — Canvas view registry and direct context (PC9a)

**Type:** intent-refinement
**Touches:** `src/canvas/view-registry.ts`, `src/canvas/view-schema.ts`, `src/canvas/commands.ts`, `src/canvas/queries.ts`, `src/web/routes/canvas-routes.ts`, `src/mcp-server.ts`, `packages/canvas/src/{context,context-capture,assistant,view-sync,entry,commands}.ts`, `src/web/public/canvas.{html,css}`
**Why:** Agents could not read or steer a person's canvas view, and a person could not hand objects to an assistant without copying text.
**Links:** [Intent](../intent/2026-11-12-canvas-pc9a-views.md)

Decisions the PC9 plan did not settle. The Assistant is a new desktop dock button (`#assistantTool`); `#chatTool` stays Comments, because PC6 made it the phone dock's Comments entry. `canvas_context` takes `add` and `remove` with `targetIds`; it has no `includeDescendants`, since a container chip always carries its descendants, as it does for a person. A phone refuses the `assistant` rail view (even from an agent) and shows no Add to chat, so the one write-free phone rule has no exception until PC9c. The lasso preview uses its own `context-preview` class beside `selection-preview`, because the editor clears the latter. The restored context list is read once at construction, before the first paint can overwrite storage with the empty starting state. Rate limits: the browser spaces publishes 300 ms apart and the server refuses a faster one with 429. `canvas_view` read results carry `ageMs`; a closed tab stays listed for up to 60 s, which is why an agent should treat `VIEW_GONE` as the only proof of closing. Old text "no server view store" in the architecture notes is replaced: there is a store, in memory only.

## 2026-11-12 — Canvas images, link cards, embeds and sub-canvases

**Type:** intent-refinement
**Touches:** `src/canvas/canvas-assets.ts`, `src/canvas/link-preview.ts`, `src/canvas/commands.ts`, `src/web/routes/canvas-routes.ts`, `src/web/routes/webview-routes.ts`, `src/types/webview.ts`, `src/mcp-server.ts`, `packages/canvas/src/objects/`, `packages/canvas/src/media.ts`
**Why:** The canvas stored image, link, embed and sub-canvas types but could neither make nor show them, and agents had no way to add an image or a live page.
**Links:** [Intent](../intent/2026-11-11-canvas-pc5-media.md)

Image bytes are workspace assets named by their SHA-256 and served by id; no request carries a path, and an object can name only an asset its own workspace holds. Unreferenced assets are kept, because undo and revert can bring an object back and the log does not record which bytes went away. A link preview goes through the web-tab egress guard and writes nothing itself: the browser or agent writes the title with an ordinary update, so there is still one write path. An embed's frame is a web tab record with a new `canvas` origin rather than a `managed` row, because its lifetime follows a canvas object and it must never appear in the tab strip. Link and embed switch type in place so the object keeps its id, history and position. A sub-canvas opens as a view root in the browser and changes no stored data. MCP grows to 25 tools (`canvas_upload_image`, `canvas_link_preview`).

## 2026-11-12 — Canvas comments, author revert and a read-only phone view

**Type:** intent-refinement
**Touches:** `src/canvas/operations.ts`, `src/canvas/commands.ts`, `src/web/routes/canvas-routes.ts`, `src/mcp-server.ts`, `packages/canvas/src/{comments,history,mobile,entry}.ts`, `src/web/public/mobile-overview.js`
**Why:** Comments and author revert were stored but invisible, and a real iPhone showed the phone canvas as a desktop editor with its controls hidden.
**Links:** [Intent](../intent/2026-11-11-canvas-pc6-comments.md)

Comments post as ordinary `comment` operations (MCP gains `canvas_comment`, 24 tools) and never start agent work. Author revert has one planner, `revertPlan()`, whose summary (removed, kept, restored, skipped, comments) backs both the History view's inline confirm and the `canvas_history` `preview` action. The lock policy stays the existing atomic one: a locked target refuses the whole revert, and the preview runs the same validation so the confirm says so first. `POST /revert` gained the command route's request identity. Phone mode is one helper (`isPhone()`); the phone reads, navigates and comments, and the editor refuses writes there. Two phone findings changed shared code: the sheet no longer carries `data-object-id` (it matched object selectors), and the rail's opener falls back to the last pressed button because iOS gives a tapped button no focus.

## 2026-11-12 — The root CLAUDE.md keeps only what every change needs

**Type:** status-transition
**Touches:** `CLAUDE.md`, `docs/subsystem-rules.md`, `AGENTS.md`, `.github/copilot-instructions.md`, `.prettierignore`, `test/docker-entrypoint.test.ts`
**Why:** The file was about 157 KB and is loaded whole into every agent session and subagent, most of it about subsystems that session never touches.
**Links:** [Intent](../intent/2026-11-12-slim-claude-md.md)

The per-subsystem paragraphs moved verbatim to `docs/subsystem-rules.md`; nothing was reworded or dropped. `CLAUDE.md` keeps the self-deploy rule, assurance, commands, session safety, test-before-deploy, the release pointer, a short list of universal rules, testing essentials and an index of the moved titles. A new subsystem rule is written in `docs/subsystem-rules.md` and its title added to that index. The rules there bind as before. `src/web/CLAUDE.md` is unchanged.

## 2026-11-11 — A canvas refusal drops one submission, and acknowledgement reads only what it wrote

**Type:** intent-refinement
**Touches:** `packages/canvas/src/edit-queue.ts`, `packages/canvas/src/edit.ts`, `src/canvas/canvas-store.ts`, `src/web/routes/canvas-routes.ts`
**Why:** The round-one audit found a refusal that froze every later save, a no-op compound that bumped a revision through an empty revert, and a compound acknowledgement that downloaded and cloned the whole log.
**Links:** [Intent](../intent/2026-11-11-canvas-pc4-audit-round1.md)

A refusal is now a notice, not a lock. The queue removes the refused batch and later batches that provably depend on it, then keeps sending. A draft's sent marker names its operation id and is cleared by `saveText` whenever the queue no longer holds that id. A no-op answers `noop: true` with no log line, which replaces the empty revert guard; a retry of the same request id evaluates to the same no-op. `GET /ops` is paged at 500 records and 1 MB with a `more`/`next` cursor, and a capped page omits `seq` so an older client refetches the snapshot instead of adopting a sequence it never replayed. Local canvas storage is keyed by viewer. Undo after a reload is left out: the log keeps neither batch grouping nor redo state, and rebuilding either would mean storing something new.

## 2026-11-11 — Canvas Arrange becomes a compact menu; refusals become product copy

**Type:** intent-refinement
**Touches:** desktop canvas Arrange menu, selection row, reader geometry, refusal copy, lock marks
**Why:** Design review found the Arrange panel covering half the board, raw server text in refusals, a viewport-wide focus ring and a locked selection offering actions that could only fail.
**Links:** [Intent](../intent/2026-11-11-canvas-pc4-design-review-2.md)

Arrange keeps only layout: align and distribute icons, order with Mod+] / Mod+[ hints, and wrapping. Explicit equal spacing left the pointer UI rather than becoming a reader field: a gap value needs an axis, and splitting it from the distribute buttons across two surfaces did not fit cleanly. It stays on the command endpoint. Rotation moved to the reader; move mode gained the `M` key because the removed menu item was its only entry point. Duplicate joined the selection row, which still fits one line at 1440. Refusal sentences are chosen from the server's reason code and the client's own lock tree, so an inherited lock names its ancestor without new server data. A refusal names the selection it was about, so it clears when the selection changes; a failed save keeps its message until retried or discarded.

## 2026-11-11 — Persist compound canvas identities and use server history

**Type:** intent-refinement
**Touches:** desktop canvas queue, command endpoint and history
**Why:** A compound command expands to server-generated operation IDs; resending after a lost response otherwise repeats grouping, pasting or history.
**Links:** [Intent](../intent/2026-11-11-canvas-pc4-compound.md)

An optional UUID request identity plus an author/payload fingerprint becomes deterministic native operation IDs. Retry recovers the original sequences directly from the existing log before expansion; mismatched reuse refuses. No-op compounds append an empty native revert guard so their acknowledgements survive retries too. Disk kinds stay unchanged. Copies stage their new locks after all creates, preserving locked subtree structure without unlocking the source. Wrapping reuses group with an optional fixed-container type, and reparent accepts world translation for one atomic placed drop.

Browser history now selects acknowledged sequences and asks the server to invert them. Its stricter revision and dependent rules supersede the earlier field-scoped browser inverse. Typed internal clipboard data keeps hierarchy and world placement; new identities are allocated before one create command. Compound UI actions wait for earlier writes rather than expanding against speculative state.

## 2026-11-11 — Separate canvas selection chrome from content and history

**Type:** intent-refinement
**Touches:** canvas renderer, dock, reader and browser checks
**Why:** PC4 design review found handles covering text and repeated across multi-selection.
**Links:** [intent](../intent/2026-11-11-canvas-pc4-design-review.md)

Selection chrome uses six screen pixels of outward clearance at every zoom;
resize still measures pointer deltas against true stored geometry. Boundaries
and focus rings counter-scale with zoom to avoid fractional CSS outline rounding.
Multi-selection shows individual corner marks and one combined boundary without resize handles
until part 2. Marquee and lasso previews reuse those boundaries rather than
stacking outlines; pointer focus-mode changes schedule a paint immediately.
Auto-bounded groups retain their real hit region between children independently
of the outward selection chrome.
Unselected, unfocused boundaries stay out of rendering after a
500-object comparison exposed the cost of empty chrome. History belongs in the
dock and stays available without selection.
Conflict attribution comes from replayed operations, because an object's author
identifies its creator rather than the writer who changed the text. Missing
operation attribution uses “Someone” instead of naming the creator.

## 2026-11-11 — Keep canvas edits recoverable across acknowledgement races

**Type:** intent-refinement
**Touches:** canvas edit queue, reader and history
**Why:** PC4 needs recoverable writes and safe inverse batches using the existing API.
**Links:** [intent](../intent/2026-11-11-canvas-pc4-edit.md)

The desktop queue persists each submitted batch boundary because the server rejects mixed duplicate/new batches. It uses existing operation IDs for retries and recovers an acknowledgement from history when an SSE snapshot arrived before the POST response. A server refusal quarantines pending edits and rolls back their optimistic display. Explicit reparenting uses the existing `reparent` kind rather than adding a parent field to `move`.

PC4 history aggregates a gesture’s changes per object before inversion, so resize position and size undo together. Existing empty `revert` patches serve as revision guards for descendants in the same atomic inverse batch; no server command kind is added.

Alt-drag selects with a freehand lasso; Q remains reserved for future chat context capture. Named container headings stay above child content so an explicit drop cannot make its destination heading unreachable.

## 2026-11-11 - Screenshot cleanup is bounded and answers stay path-free

**Type:** propagated-discovery
**Touches:** `src/canvas/canvas-screenshot.ts`, `src/web/routes/canvas-routes.ts`, `src/web/server.ts`
**Why:** The audit showed a session-scoped screenshot dropping `:id`, a `browser.close()` that never settles holding the only render slot, and a bad `mermaid-runtime.json` putting the data directory in the HTTP body.
**Links:** [Intent](../intent/2026-11-11-canvas-screenshot-fix.md)

The workspace pre-handler assigns `workspaceId` on the existing params object. Close waits 2 seconds, then the pid is killed, and the exit wait uses that same 2 second bound. The queue `finally` releases without awaiting close. Shutdown and a client hang-up share that close. A missing browser stays the 503 that names `codeman mermaid setup`. A bad runtime config is the fixed 500, and any other absolute path in a screenshot error is `Canvas screenshot failed`, so a paint failure is not labelled as a bad config. The path is logged on the server. `codeman mermaid` keeps the detailed line. The 20 second deadline starts before the job, and model, bundle and document work run inside it.

## 2026-11-11 - A canvas screenshot is one clipped page

**Type:** intent-refinement
**Touches:** `src/canvas/canvas-screenshot.ts`, `src/headless-browser.ts`, `packages/canvas/src/shot.ts`
**Why:** The plan left the clip margin, image fetching, the page bundle, and the queue budget unspecified.
**Links:** [Intent](../intent/2026-11-11-canvas-screenshot.md)

The clip margin is 48 pixels so a container title drawn above the box is inside the picture. A title wider than the object can still meet the clip edge. Device scale factor stays 1. Past 4096 pixels on the long side, CSS scale shrinks the page and the metadata says so. Only a stored `data:image` of png, jpeg, gif, or webp is painted. A remote image URL is not fetched. The shot page loads `canvas-shot.js`, which uses the shipped Renderer and does not boot the live view. An embed label includes its URL so the view and the screenshot draw the same box. The 20 second budget includes time waiting for the single render slot, and a caller whose budget is already spent does not launch. `canvas_screenshot` is a GET, not a command-batch tool. A browser process that survives `close()` is killed.

## 2026-11-11 - An Authorization bearer is one placeholder

**Type:** intent-refinement
**Touches:** `src/telemetry-redact.ts`
**Why:** `Authorization: Bearer …` was stored as `Authorization: [redacted]]`. The bearer shape and the header rule both rewrote the same span, and the `]` inside the placeholder ended the header value early.
**Links:** [Intent](../intent/2026-11-11-pc8-log-redaction-fix-round7.md)

The assignment is measured on the original text, before any placeholder is written. A credential header that holds a bearer token gets one `[redacted]`. A `]` that was already in the input, such as the closer of `headers: [Authorization: Bearer …]`, stays. Free-standing bearer tokens are unchanged.

## 2026-11-11 - Bound canvas expansion separately and preserve later descendants

**Type:** propagated-discovery
**Touches:** canvas history, validation, model reads and command routes
**Why:** The PC2 audit reproduced undo deleting another author's later child,
maximum-target history exceeding caller limits, and cycles hiding healthy objects.
**Links:** [Audit fix intent](../intent/2026-11-11-canvas-audit-fixes.md)

History checks the staged subtree against identities created/restored by the
selected sequences, refusing later dependents before append. An existing `revert`
restores reparent geometry in one operation, keeping undo/redo size stable.
Caller operation arrays retain their 1,000 limit; server expansions and history
sequence lists use 10,000, ten caller batches and the hierarchy node bound.
A CPU profile of maximum-target ungroup found repeated whole-state child scans;
validation now maintains a batch-local child index as staged parents change.
The final maximum-target probe still exceeds the literal PC1 5 ms whole-append
rule; this audit round records that limit rather than normalizing time per object.
Cycle classification is independent of the write depth bound, so even long
loaded cycles remain flat and diagnosed while healthy discovery works. Browser
pointer snapping is described separately from deterministic stored arrangement.

## 2026-11-11 - Keep canvas MCP compact and share native commands

**Type:** intent-refinement
**Touches:** `src/canvas/commands.ts`, `src/canvas/queries.ts`, canvas routes and MCP
**Why:** Five CRUD tools alone do not cover the required stored capability matrix.
**Links:** [Canvas MCP intent](../intent/2026-11-11-canvas-mcp.md)

Use eleven canvas tools (21 MCP tools total): the five named read/CRUD tools plus
query, arrange, transform, lock, history and capabilities. Every tool calls the
same typed HTTP handler available to humans. Compound edits expand to one native
batch and append once. Schema discovery describes unsupported flips/shear,
uniform group scaling, fixed-container bounds resize and world AABB queries.
Undo uses explicit own-author sequences and refuses intervening revisions; redo
inverts returned undo sequences. This avoids a second mutable undo stack.

Reserve per-view viewport, selection, focus and context names for PC3/PC9 in the
capability list. The browser owns that state; PC2 does not create a server store.
Read/search/query/history use text-only JSON capped at 60,000 UTF-8 bytes with a
truncation flag and omit records that do not fit. Case scope follows the longest
registered case path containing the visible caller session's working directory;
body workspace and author fields are forbidden.

## 2026-11-11 — Remove empty canvas reader sections and stacked review fixtures

**Type:** propagated-discovery
**Touches:** canvas reader, outline search and browser review fixtures
**Why:** Design review found an empty divider, crowded clear control and apparently bold inert text.
**Links:** [intent](../intent/2026-11-11-canvas-pc3-visual-round3.md)

Containers show live direct-child counts above metadata without an empty body
separator. Search uses a separate clear button with reserved input padding.
The heavy text was multiple identical live-test objects at the same coordinates,
not a different font: browser tests now clean up their live writes between tests
and capture one markup-looking text object with matching computed typography.

## 2026-11-11 — Recover canvas readers across future operation records

**Type:** propagated-discovery
**Touches:** canvas browser model, synchronization and pointer input
**Why:** The audit reproduced a permanent catch-up stall on a header-only future operation and hidden subcanvas children.
**Links:** [intent](../intent/2026-11-11-canvas-pc3-audit-round2.md)

The read boundary preserves extensions and skips unknown kinds even when they
supply after-images. Unreadable catch-ups recover through one fresh snapshot.
The browser shares the pure server container predicate. Reader activation uses
consecutive pointer taps because cancelling pointerdown suppresses mouse double
clicks; pointer capture loss ends a gesture without ending a held Space key.

## 2026-11-11 - Classify canvas records at the state boundary

**Type:** intent-refinement
**Touches:** `src/canvas/model.ts`, `src/canvas/operations.ts`, `src/canvas/canvas-store.ts`
**Why:** Delete/restore validation repeatedly parsed known objects and rewalked each changed container's descendants and their ancestors.
**Links:** [Hierarchy performance intent](../intent/2026-11-11-canvas-hierarchy-performance.md)

Private store state owns a WeakMap classification sidecar, rebuilt on load and
updated on replay/apply. Public reads and snapshots carry no index. Mutable pure
caller inputs are classified at validation entry unless explicitly indexed at
their construction boundary. Subtree validation uses lookups and descendant-local
locks, then carries depth and deletion facts through one final descendant walk.
This preserves atomic rejection when selective restore would revive a child
beneath an independently deleted container.

## 2026-11-10 - Keep unsafe canvas data readable and future operations replayable

**Type:** intent-refinement
**Touches:** `src/canvas/`, canvas route tests
**Why:** The second PC1 audit found cycles could hang hierarchy walks, snapshots could seal unapplied future operations, and author revert could throw on opaque content.
**Links:** [Safe replay intent](../intent/2026-11-10-canvas-safe-replay.md), [Canvas storage invariants](architecture-invariants.md#canvas-storage)

All hierarchy consumers share an iterative walk with cycle detection, a depth
of 256 objects and a 10,000-node limit. Reads retain reached records; commands
and geometry refuse an unsafe or incomplete walk. Load diagnostics are deduplicated
across reloads of the same store. Unknown or mismatched content is opaque,
including before/after history, so independent author changes can still revert.

A store with unknown operation kinds fsyncs its log but skips new snapshots.
This deliberately accepts repeated replay instead of writing an inaccurately
advanced checkpoint. The same rule applies to shutdown and handoff flushes.
Existing checkpoints and all log records stay unchanged for a future reader.

## 2026-11-10 — Make read-only canvas affordances truthful

**Type:** intent-refinement
**Touches:** `packages/canvas/`, `src/web/public/canvas.css`, `src/web/public/canvas.html`
**Why:** PC3 review found resizing-like selection squares and unavailable actions that looked live.
**Links:** [intent](../intent/2026-11-10-canvas-pc3-review.md)

Selection follows the existing container edge with corner brackets; amber belongs
to keyboard focus and selected-tool strokes. Add and Comment remain reachable
with aria-disabled and activation announcements, so keyboard readers can discover
when those actions arrive. Comments name the later conversation slice; the empty
state directs the owner to an agent in the case until hand editing ships.

## 2026-11-10 - Keep canvas view commands independent of rendering

**Type:** implementation-decision
**Touches:** `packages/canvas/`, canvas document and managed web tabs
**Why:** PC3 needs a read-only first screen whose view actions can later be driven by both editing controls and agent adapters.

The client uses a pure typed command reducer and exposes a cloned state query plus dispatcher. Keyed nested DOM remains the first renderer; only the world layer transforms while panning. Canvas tabs use the existing trusted direct managed mode, which carries normal same-origin login cookies and avoids proxying the application into itself. This requires an additive `canvas` managed-origin discriminator. Reader and Keys share a removable overlay rail; unsupported media and future object types remain inert. The coordinator retains independent live/performance comparison and final design-review ownership.

## 2026-11-10 - Preserve future canvas data across code-only rollback

**Type:** intent-refinement
**Touches:** `src/canvas/`, `src/web/routes/canvas-routes.ts`
**Why:** The PC1 audit found strict disk schemas would reject later object extensions on rollback.
**Links:** [Audit fix intent](../intent/2026-11-10-canvas-audit-fixes.md), [Canvas storage invariants](architecture-invariants.md#canvas-storage)

Requests retain strict schemas. Stored objects, content and operation records
retain extension keys; known content edits merge those keys unchanged. Future
object types are opaque and read-only to this release, including compound
commands affecting their subtree. Unknown operation kinds remain unapplied but
are retained in returned history and in the log, which snapshots never truncate.

Sub-canvases are explicitly bounded containers so later media work can place
blocks inside them. Resizing their bounds leaves child geometry unchanged.
Delete inversion emits a root restore, using deletion IDs to restore only its
own tombstones. Other ordinary undo commands use native operations; reparent
undo restores membership and exact local geometry in one batch. Author revert
retains its separate field-aware operation.
Workspace creation probes case paths with bounded helpers: unknown returns a
diagnostic 503 and never mints a workspace or claims the case is missing.

## 2026-11-10 - Store canvas commands as atomic attributed transactions

**Type:** intent-refinement
**Touches:** `src/canvas/`, `src/web/routes/canvas-routes.ts`, `src/case-rename.ts`
**Why:** Later canvas controls need explicit hierarchy, geometry and locks without changing the meaning of existing log records.
**Links:** [Canvas store intent](../intent/2026-11-10-canvas-store.md), [Canvas storage invariants](architecture-invariants.md#canvas-storage)

The command vocabulary adds reparent, reorder, lock, unlock and remove-comment.
A layout move never changes membership. Reparent preserves world placement by
default. Groups derive their bounds; frames and sections have explicit sizes,
and resizing those bounds does not scale their children. Every stored change
uses one validation path, including author revert. Locked targets and affected
locked descendants reject the entire batch.

A compound batch occupies one versioned JSONL envelope so a torn tail cannot
replay half a transaction. Single-operation writes remain one operation per
line. Unknown operation kinds advance the sequence without applying state.
Snapshots do not truncate history: deduplication and author revert still work
after restart. Subtree tombstones carry the deletion operation ID, avoiding
accidental restores of independently deleted children at the same timestamp.
Workspace IDs survive case renames. Two workspace discovery/creation routes
supply IDs before a canvas tab exists. The API stamps human authors; future
agent tools must pass the resolved session identity through the same store.
The flag remains default off, with no startup replay or background work.

A local 10,000-object smoke probe found full-table copying and a sync of each
append above the performance limits. Validation now stages touched records and
materializes a full resulting table only for pure callers that ask for it.
Normal replay records avoid constructing failed envelope-schema parses.
Appends reach the OS synchronously; snapshot and handoff flushes fsync the log.
This covers process restart recovery, with no per-append power-loss guarantee.
The smoke probe is not the program's independent live or performance verdict.

## 2026-11-11 - A token count is a whole number

**Type:** intent-refinement
**Touches:** `src/telemetry-redact.ts`
**Why:** Round 5 kept any value that started with a digit, so `tokens: 1synthetic-credential-123456789` stayed on the line.
**Links:** [Intent](../intent/2026-11-11-pc8-log-redaction-fix-round6.md)

The first value token under a token-count key must be entirely a number: digits, group separators only between digits, and an optional `k` or `m`. `174k` stays. Anything else is masked like a secret value.

## 2026-11-11 - A token count is not a credential

**Type:** intent-refinement
**Touches:** `src/telemetry-redact.ts`
**Why:** `tokens: 15234 input, 921 output` was masked because the key contains `token`. That line is a usage count this app logs on purpose.
**Links:** [Intent](../intent/2026-11-11-pc8-log-redaction-fix-round5.md)

A key that only counts tokens is not a secret key. The value stays only when it starts with a digit. An object, an array, or a quoted string under `tokens` is still masked, because a key-only exemption would leave `{"tokens":{"access":"…"}}` readable and `access` is not itself a credential word. `authTokens` and any count-shaped key that also says `auth`, `access`, `refresh`, `secret`, `bearer`, `api`, `session`, or `id_token` stay secret.

## 2026-11-11 - An unquoted secret value runs to the newline

**Type:** intent-refinement
**Touches:** `src/telemetry-redact.ts`
**Why:** A coordinator probe still found HTTP Basic credentials, cookie values, multi-word passwords, `sk-` and `ghp_` tokens, and curl `-u` arguments on disk. Stopping an unquoted value at the first space was the gap.
**Links:** [Intent](../intent/2026-11-11-pc8-log-redaction-fix-round4.md)

An unquoted value under a secret key now runs to the newline, or to the `}` or `]` that closes the surrounding structure. `cookie`, `set-cookie`, `codeman_session`, and `sid` are secret keys. `session`, `sessionId`, `session_id`, and `claudeSessionId` stay readable so a row can still be correlated. Token shapes are masked by a linear scan with no key. The plan did not list those shapes; the probe did.

## 2026-11-11 - Scan quoted text, and stop over-masking diagnostics

**Type:** intent-refinement
**Touches:** `src/telemetry-redact.ts`
**Why:** The third audit still found secrets inside quoted assignments, after a second `@`, and under a digit-leading key. The same pass was eating stack-frame positions, `host:port`, and an `Error:` label, and a megabyte-long quoted key took seconds because it was copied and normalised.
**Links:** [Intent](../intent/2026-11-11-pc8-log-redaction-fix-round3.md)

A quote that is not itself a secret value is scanned for assignments and URL userinfo, four levels deep. Past that depth a marked interior is masked whole. Userinfo is masked through the last `@` before the authority ends, and a URL with no `@` keeps a numeric port. A key may start with a digit. A key longer than 256 characters is secret without another copy. A path-like key followed only by digits, and a value that is only an `Error:` label, stay. The plain scan repeats at most three times so a mask that uncovers a later shape still settles. An unlabelled secret is still not detected. That is a second line behind not logging the secret.

## 2026-11-10 - Mask the whole value when the key merely contains a credential word

**Type:** intent-refinement
**Touches:** `src/telemetry-redact.ts`, `src/telemetry.ts`, `src/telemetry-query.ts`
**Why:** The second audit showed that an exact-word key rule, a capped value, and a tail window that always skipped to the next newline still left secrets out of the mask or dropped a complete row.
**Links:** [Intent](../intent/2026-11-10-pc8-log-redaction-fix-round2.md)

The key rule is a substring match again (`auth`, `password`, `secret`, `token`, `key`, `credential`), at any length, minus an exact allowlist of attribution keys after case and separators are removed. `keyboard` is therefore a credential key. That is the over-mask the rule accepts. Config backup's `SECRET_KEY_RE` is unchanged and still matches `author`. A masked value runs to its quote, bracket, or delimiter, or to the end of the line when the closer is not in the line. The hook secret is read with a 512-byte cap and, once known, is not read again; a miss is still not cached. A query window keeps its first row when the byte before the window is a newline. A secret with no credential key and no known shape is not detected.

## 2026-11-10 - Mask the secret shapes the first log audit still found

**Type:** intent-refinement
**Touches:** `src/telemetry-redact.ts`, `src/telemetry-query.ts`, `src/telemetry.ts`, `src/config/hook-secret.ts`
**Why:** The first audit showed credential-shaped lines still reaching disk, a 30 second blind spot after the hook secret was created, and a query that dropped the newest rows once a file passed its byte cap.
**Links:** [Intent](../intent/2026-11-10-pc8-log-redaction-fix.md)

URL userinfo is masked with or without a password, and the scheme match is case-insensitive. Bearer tokens are too. Secret-shaped keys are recognized in the quoted, escaped, and whitespace-separated forms `util.format` actually prints. A hook-secret miss is not cached, and `getHookSecret()` supplies the value it just stored, so the next line cannot keep a secret that appeared a moment earlier. `queryLogs` reads each generation from the tail. Telemetry's key rule is no longer config backup's: `author`, `authored`, `authUser`, and `authorId` keep their values, while `auth`, `authorization`, and `x-auth-*` stay masked. Config backup's `SECRET_KEY_RE` is unchanged.

## 2026-11-10 - Query redacted telemetry without a second intake route

**Type:** intent-refinement
**Touches:** `src/telemetry.ts`, `src/telemetry-redact.ts`, `src/telemetry-query.ts`, `src/web/routes/telemetry-routes.ts`, `src/mcp-server.ts`
**Why:** The canvas plan asks for redacted log query and a `ui-events` stream, and leaves the intake route and the newest-row structure unspecified.
**Links:** [Intent](../intent/2026-11-10-pc8-redacted-logs.md), [Initial version plan](agentic-canvas/initial-version-plan.md)

Canvas and tab-strip events post through the existing `POST /api/client-errors` with `kind: "ui"`, validated by a small schema in the route, and land in `ui-events.jsonl`. They use their own 120-per-minute bucket so a burst does not consume the 30-per-minute client-error budget. `queryLogs` keeps the newest matches in a ring rather than shifting an array, and it redacts again on read so a line written by an older release cannot come back raw. The hook secret is read from the file that already exists and is never created by a log write. A value shorter than 16 characters is ignored. A usable secret is removed by literal split/join, not by a regular expression. `deploy/test.sh` gains `test/telemetry-redact.test.ts` and `test/telemetry-query.test.ts` next to the telemetry files it already runs, because those tests guard stored data.

## 2026-11-10 - Run the canvas program with Codex, Grok and Copilot workers

**Type:** intent-refinement
**Touches:** `docs/agentic-canvas/initial-version-plan.md`
**Why:** The owner asked the coordinator to build the shaped canvas by directing Codex, Grok and Copilot worker sessions and to keep its own context for judgment.
**Links:** [Initial version plan](agentic-canvas/initial-version-plan.md), [Canvas surface brief](../.impeccable/surfaces/src-web-public-canvas-html.md)

Each PR has three roles, each held by a different CLI: one owner builds in its
own worktree, one verifier runs the gates, the live lanes and the perf probe
from the plan's boot recipe, and one auditor reads the diff and distrusts the
PR body. This replaces the plan's ten same-model lanes and its swarm. The lane
list, the perf rules, the review gate for PC3 to PC6 and the coordinator's
authority to land and deploy stay as the plan states them. The coordinator
writes each task packet, judges findings and owns every push, merge and deploy.

## 2026-11-10 - Require canvas foundations and agent parity

**Type:** intent-refinement
**Touches:** `PRODUCT.md`, `docs/agentic-canvas/`
**Why:** The owner approved the ambient design and clarified selectable group context, FigJam-style foundational controls and agent-native parity.
**Links:** [Canvas foundations](agentic-canvas/canvas-foundations.md), [Design intent](../intent/2026-11-10-canvas-design.md)

The prototype now lets Design exploration be selected from its canvas heading
or outline and added as one named context reference, with explicit descendants
and overlapping targets deduplicated. The production scope explicitly includes
selection lassos, grouping/ungrouping, nested groups, resize, lock and related
geometry/layout/clipboard/history controls. Decorative workshop elements remain
excluded. Each human operation must have structured agent control and readable
state through the same validated domain path. Prototype scope stays narrow;
its current controls are not the complete build checklist.

## 2026-11-10 - Replace chat cards with an ambient assistant

**Type:** intent-refinement
**Touches:** `PRODUCT.md`, `docs/agentic-canvas/`
**Why:** The owner rejected floating chat and modal context picking, favoring a thin dismissible right rail inspired by HeyClicky's ambient interaction.
**Links:** [Current design brief](agentic-canvas/canvas-ui-ux-brief.md), [Interactive design prototype](agentic-canvas/design/ambient-assistant.html)

The assistant collapses to zero without moving the canvas. Direct selection and
a hold-Q lasso add object references to the next request; cancellation changes
nothing. Help, comments and task details use the same nonmodal rail. Voice,
background agents and configured provider/model selection are explicit scope,
with separate dictation/conversation modes and isolated child-task identity.
The plan now names PC9–PC12 for this work. The browser prototype exercises UI
and gesture behavior only; audio, model calls and agent sessions remain
unconnected. These decisions supersede the prior chat-card interpretation.

## 2026-11-10 - Make conversations part of the canvas workspace

**Type:** intent-refinement
**Touches:** `PRODUCT.md`, `docs/agentic-canvas/`
**Why:** The owner accepted the visual direction and clarified that the canvas is the primary agentic interface, with conversations and comment threads inside it.
**Links:** [Revised UI/UX brief](agentic-canvas/canvas-ui-ux-brief.md), [Design intent](../intent/2026-11-10-canvas-design.md)

The navbar is removed, search moves into the outline and persistent system labels
leave the board. Conversations become movable objects linked to real sessions.
Per-message attachments guide attention while the whole authorized canvas stays
available; removing a reference does not erase previously supplied context.
Ordinary comments stay ordinary, and Ask agent explicitly invokes work that
replies to its originating thread. The same session can open as a conversation.
Users and agents can reshape the workspace and initiate app changes inside it,
through the existing self-building release path. This supersedes the first
brief's exclusion of native chat and agent comments. The revised plan adds that
work explicitly; static studies are not evidence of a working session adapter.

## 2026-11-10 - Shape the initial canvas before implementation

**Type:** intent-refinement
**Touches:** `PRODUCT.md`, `docs/agentic-canvas/`
**Why:** The owner approved the plan, supplied spatial-canvas and Opsdeck references, requested dark mode and emphasized keyboard shortcuts.
**Links:** [Canvas design intent](../intent/2026-11-10-canvas-design.md), [UI/UX brief](agentic-canvas/canvas-ui-ux-brief.md)

The owner delegated orchestration, design choices, verified PR landing and
supervised deployment for this program. This supersedes its older human-only
prompt and per-PR approval restrictions; deployment and data protections remain.
The design compares three compositions and selects an open board with a
collapsible outline, preserving explicit context and stable keyboard order.
Object selection and keyboard focus are separate. Focused plain-text reading
uses an overlay on desktop and a commenting sheet on the phone. Offline permits
reading but no new writes; existing pending drafts remain visible and recoverable.
Ordinary layout dragging preserves parent membership, while named targets make
reparenting explicit. The implementation checklist was reconciled with those
decisions. Static studies and contrast calculations are design evidence, not
runtime, durability or performance verification.

## 2026-11-10 - Run real-iPhone tests as one scenario

**Type:** propagated-discovery
**Touches:** `scripts/ios-device.mjs`, `docs/ios-device-testing.md`
**Why:** A real-device test pass took 118 agent tool calls in 28 minutes, and the device was not the bottleneck.
**Links:** [iOS device runner intent](../intent/2026-11-10-ios-device-runner.md)

Measured on the Mac next to Appium, a tap costs about 0.63 s, a page JS call
0.02 s and a screenshot 0.14 s. Talking to WebDriverAgent directly instead of
through Appium, and avoiding context switches, saved nothing there, so the
runner keeps Appium for page JS and sends touches to WebDriverAgent only to
skip the context switch. The cost was one agent turn per step (about 14 s)
and a 251 ms tunnel round trip per request. Taps aim at CSS selectors through
one swallowed calibration touch, because accessibility-tree queries in Safari
were slow and once stalled WebDriverAgent.

## 2026-11-10 - Background rewake waits only on a Claude transcript

**Type:** intent-refinement
**Touches:** `src/hooks-config.ts`, `docs/claude-code-hooks-reference.md`
**Why:** A cancelled PostToolUse hook blocked the turn. The helper was polling for a Claude `queue-operation` line in a transcript that never gets one.
**Links:** [Background rewake intent](../intent/2026-11-10-background-rewake-claude-only.md)

The helper still watches Claude transcripts and still exits 2 when the matching
background command finishes. It returns at once unless the transcript path has a
`.claude` directory segment. `asyncRewake` stays, because Claude is the client
that honours it. The marker is `CODEMAN_BACKGROUND_REWAKE_V4` so an installed
copy of the previous script is replaced in place.

## 2026-11-10 - Desktop Cmd+V must not focus a paste trap

**Type:** intent-refinement
**Touches:** `src/web/public/image-input.js`, `src/web/public/terminal-ui.js`, `src/web/public/terminal-tile.js`
**Why:** Cmd+V on a desktop focused a hidden contenteditable and left it focused, which pops the platform editing toolbar and can insert the clipboard twice.
**Links:** [Desktop paste intent](../intent/2026-11-10-desktop-paste-once.md)

A fine primary pointer arms a one-shot listener on the paste the browser already
delivers to the terminal. A coarse pointer and Android keep the contenteditable
trap and `execCommand('paste')`, because those engines were the reason the trap
exists. Linux Meta+V is not the paste chord, so that press inserts nothing and
must not move focus.

## 2026-11-10 - Verify inline links through the real terminal transport

**Type:** retraction
**Touches:** `src/tmux-manager.ts`, `test/terminal-local-links.browser.test.ts`
**Why:** The previous link fix verified direct xterm input but missed the transport used by the real Copilot session.
**Links:** [intent](../intent/2026-11-10-copilot-inline-targets.md)

The real tmux capture retained the report destination. Attached clients omitted it because they did not advertise hyperlink support, and snapshot formatting stripped it independently. Local attach clients now advertise the feature where supported. Snapshot filtering retains well-formed OSC 8 sequences and closes clipped links. Regression tests pass captured output through the formatter before clicking the rendered label. The saved Copilot row reproduced the missing target before the fix and opened its intended report after it.

## 2026-11-10 - Review a document inside the file preview

**Type:** intent-refinement
**Touches:** `src/web/public/doc-review.js`, `src/web/public/panels-ui.js`, `src/web/public/index.html`
**Why:** Marking up an agent's doc needed either hand-quoted prompts or a third-party page in a trusted frame on Codeman's origin.
**Links:** [Document review intent](../intent/2026-11-10-doc-review.md), [architecture invariants](architecture-invariants.md#document-review)

Review is a mode of the existing rendered Markdown preview, not a web tab. It
adds no route: the feedback file rides the prompt-upload route and the prompt
rides the input route. Three choices are worth knowing later. Anchors are
text quotes with context, not DOM positions, so a draft survives the agent
rewriting the file, and a comment whose text is gone is sent marked as such
instead of being dropped. The prompt is sent without `useMux`, because the
route's automatic plain-prompt branch is the one that waits for Enter and can
report a failure. Drafts are keyed by session and path in `localStorage`, so
a review belongs to the agent that will receive it and is pruned with it.
A send owns the draft snapshot present when the user pressed Send. Its
completion clears only that snapshot, so notes written while the upload or
prompt is pending remain a draft, even if Review was closed and reopened.

Testing on a real iPhone exposed a keyboard layout bug. The window followed
the visual viewport, but its full-height overlay centered the shorter window
below the top of the visible area and hid the Add button. The phone overlay
now follows the same `--app-height` as its window. This also keeps the file
editor's actions above the keyboard.

## 2026-11-09 - Publish the Agentic Canvas source documents

**Type:** intent-refinement
**Touches:** `docs/agentic-canvas/`
**Why:** The owner wants the vision, PRD and brief readable in the public fork.
**Links:** [Agentic Canvas documents](agentic-canvas/README.md)

The brief originally said these documents must never be committed, because
they describe the server. The owner reversed that. The one passage that named
the server's other services was made generic, and the brief's remaining
public-fork rules still stand. The subscription survey was not available to
copy and is listed as not included.

## 2026-11-09 - Show named tab groups on the phone home screen

**Type:** intent-refinement
**Touches:** `src/web/public/mobile-overview.js`, `src/web/public/mobile.css`, `src/web/public/app.js`
**Why:** A tab group made on the desktop was invisible on a phone, because phones never get the vertical rail.
**Links:** [Phone tab groups intent](../intent/2026-11-09-phone-tab-groups.md)

The owner chose headings on the home screen over a tag on each row or labels
in the tab strip. Only Current sessions is split. Needs you stays flat, because
urgency comes before grouping. Membership reuses `CodemanTabLayout.project()`,
so the phone and the rail cannot disagree. The last heading reuses the rail's
"Ungrouped" label, which already has a translation, rather than the mock-up's
"Other".

## 2026-11-09 - Load Mermaid through the authenticated parent

**Type:** propagated-discovery
**Touches:** `src/web/public/mermaid-render.js`, `test/mermaid-renderer.browser.test.ts`
**Why:** Production verification caught a renderer timeout that unauthenticated browser tests missed.
**Links:** [Authenticated renderer intent](../intent/2026-11-09-mermaid-authenticated-frame.md)

The supervisor deployed the original feature successfully, and the installed
agent command rendered images. The authenticated live Markdown check failed.
The release was rolled back before repairing it. Enabling authentication in the
browser regression reproduced the same timeout.

The auth middleware deliberately intercepts non-route HTML iframe navigations
with lost-frame recovery. A static renderer document is such a navigation.
The parent now fetches that protected document and assigns it to the opaque
frame's `srcdoc`. This leaves recovery, authentication and sandbox rules intact,
keeps credentials out of the frame, and preserves the existing render timeout.

## 2026-11-09 - Recover the native renderer from Git

**Type:** intent-refinement
**Touches:** `src/mermaid-runtime/`, `src/mermaid-runtime-setup.ts`, `scripts/vendor-mermaid-runtime.mjs`
**Why:** A working machine-local runtime is not enough to recover the instance after losing its disk.
**Links:** [Mermaid intent](../intent/2026-11-09-mermaid-renderer.md)

The owner chose to preserve the small native library closure in Git while
allowing normal pinned npm and Chromium downloads during recovery. The bundle
keeps official Ubuntu package provenance, per-file checksums, license notices,
and matching upstream/distribution source archives for its LGPL libraries.
It is versioned outside public assets and copied into the published package.

`mermaid setup` restores only the tested Ubuntu 24.04 x64 target, verifies all
assets first, and copies libraries to stable instance storage. Repeats verify
instead of overwrite; conflicting configuration and symlinks are refused.
Sandbox policy is still an explicit instance choice, never inherited blindly
from this VM. The library bytes and restoration mechanism now travel with the
feature; a fully offline backup and session-state backup remain out of scope.

## 2026-11-09 - Provision the Mermaid runtime without system changes

**Type:** intent-refinement
**Touches:** `src/mermaid-renderer.ts`, `src/cli-mermaid.ts`
**Why:** All agents need the normal render command to work without session-local environment overrides.
**Links:** [Mermaid intent](../intent/2026-11-09-mermaid-renderer.md)

The smaller Chromium headless shell still has native shared-library dependencies.
Those cannot be removed by tree-shaking the Mermaid JavaScript. A private copy of
the missing library closure avoids installing system packages or a desktop stack.
The renderer reads an optional instance-local `mermaid-runtime.json` for that
library directory and an explicit sandbox opt-out. Only the browser child gets
the private library path. The default elsewhere remains sandboxed, and
`--sandbox` overrides a saved opt-out. No failure triggers a weaker retry.

The owner approves the opt-out inside this VM. The UI's opaque iframe, network
restrictions, input bounds, and output bounds remain unchanged.

## 2026-11-09 - Mermaid uses one isolated renderer

**Type:** intent-refinement
**Touches:** `scripts/mermaid-frame.js`, `src/mermaid-renderer.ts`, `src/web/public/mermaid-render.js`
**Why:** Agents need to inspect actual diagram images, and Markdown readers need the same rendering behavior without running diagram code in the dashboard origin.
**Links:** [Mermaid intent](../intent/2026-11-09-mermaid-renderer.md)

The UI and offline agent command share one bundled Mermaid document. An opaque
iframe renders diagrams for Markdown readers, which display the SVG as an image.
The command writes new PNG or SVG files through Chromium and needs no server.
Source stays available when rendering fails. Chromium's OS sandbox is enabled
unless the caller explicitly disables it. This host lacks Chromium libraries and
usable OS sandbox support, so verification uses session-local libraries and an
explicit sandbox opt-out for local verification. No system libraries or live
server are changed.

Puppeteer is a runtime dependency so an installed command can provision its
browser without a separate renderer service. This adds a browser download during
installation. `puppeteer-core` would avoid that download but require every host
to supply a compatible browser. Rendering itself stays offline. The UI needs no
Chromium installation, and headless Linux hosts still need its system libraries.

## 2026-11-08 — Respawn lifecycle has a real-process check

**Type:** propagated-discovery
**Touches:** `scripts/verify-respawn-lifecycle.sh`, `docs/invariants/respawn-lifecycle.md`
**Why:** In-process tests cannot reproduce two live servers or a real restart's
restoration of disabled desired state.
**Links:** [E2E intent](../intent/2026-11-08-respawn-e2e.md)

The manual runner builds a selected ref in a temporary worktree and uses only
shell sessions with a private HOME, data directory and tmux socket. Master failed
all three scenarios; the integrated fixes passed stop/restart, established-holder
lease refusal and the three-cycle unchanged-workspace stop. Shell step completion
needs the detector's prompt glyph and a short command delay after delivery.
Restart observations extend beyond the two-minute restore grace period.
This is not a CI gate or coverage of simultaneous first lease acquisition.

## 2026-11-10 — Terminal links retain local targets across Copilot rows

**Type:** propagated-discovery
**Touches:** `src/web/public/constants.js`, `src/web/public/terminal-ui.js`, `src/web/public/terminal-tile.js`
**Why:** Copilot's inline report links were inert, and its vertical gutter split long file paths into links to unrelated folders or relative files.
**Links:** [intent](../intent/2026-11-10-agent-response-links.md)

Local OSC 8 targets use the guarded file preview with the originating terminal's session. Bordered paths use mapped row segments so every fragment opens the complete target without changing selection text. Real browser clicks reproduced the failures before the fix.

## 2026-11-08 — Idle respawn has two usage backstops

**Type:** intent-refinement
**Touches:** `src/respawn-cycle-budget.ts`, `src/respawn-controller.ts`, `src/web/respawn-event-wiring.ts`, `docs/invariants/respawn-lifecycle.md`
**Why:** The incident workspace was not a git repository, and documentation rewritten
every cycle could evade unchanged detection even with git.
**Links:** [integration intent](../intent/2026-11-08-respawn-integration.md)

Non-git workspaces now use bounded content fingerprints. Three unchanged cycles stop
idle loops; fifty total cycles are the default backstop for continually changing
workspaces. Zero explicitly disables either limit. Budget and duration expiry both
use the persisted stop path, including cancellation of a pending restore. Dead
skip-clear metrics were removed. RL-4 through RL-6 link the state machine and tests;
RL-6 remains draft because simultaneous lease acquisition is not atomic.

The full CI run also exposed pre-existing CLI-id branches in plugin removal and
Grok screen parsing; those dispatches now read data without changing behavior.
Git fixture commands explicitly configure their own temporary bare repositories
and fsmonitor control, so inherited shell hardening cannot make their assertions
vacuous. Bare-repository refusals remain refusals with the correct explanation.

## 2026-11-08 — A respawn stop is persisted desired state

**Type:** drift
**Touches:** `src/web/respawn-event-wiring.ts`, `src/web/server.ts`, `src/web/routes/respawn-routes.ts`, `src/web/routes/ralph-routes.ts`, `docs/invariants/respawn-lifecycle.md`
**Why:** `/respawn/stop` removed the controller but `persistSessionState` re-copied the old enabled config into `state.json`, so a restart restored a respawn the user had turned off.

One function, `stopRespawnForSession`, now clears state.json, mux-sessions.json, the timer and any pending restore start. The stop route and the Ralph loop disable both call it. A respawn started by the loop is marked `startedByLoop`.

## 2026-11-08 — Codeman owns agent preview servers

**Type:** status-transition
**Touches:** `src/preview-supervisor.ts`, `src/preview-proc.ts`, `src/web/routes/preview-routes.ts`, `src/cli-agent.ts`, `src/web/public/session-ui.js`, `src/templates/case-template.md`, `skills/codeman/reference/verbs.md`, `docs/web-tabs.md`, `docs/architecture-invariants.md`
**Why:** An agent's dev server started in its own shell outlives the session and holds its port, and nothing can find it later. The operator decided Codeman starts, owns and stops every preview server instead.
**Links:** [intent/2026-11-05-agent-previews.md](../intent/2026-11-05-agent-previews.md), [docs/agent-previews-plan.md](agent-previews-plan.md)

P1 to P4 landed. A web tab records its origin, and a session-origin tab is deleted with its session. Codeman launches each preview in its own process group with a `CODEMAN_PREVIEW_ID` marker. A stop signals the group, then marker processes, then the port listener only if it carries the marker. It reports a server it could not stop as `leftRunning` rather than claiming success. Idle previews stop after 4 hours. Agents start servers with `codeman agent preview add`, and a new preview only badges its session tab. The drawer of all previews (P5) is not built.

## 2026-11-04 — Import and remove plugins and skills

**Type:** intent-refinement
**Touches:** `src/extensions/`, `src/cli-extensions.ts`, `src/web/routes/extension-routes.ts`, `src/mcp-server.ts`, `skills/codeman/reference/extensions.md`, `docs/architecture-invariants.md`
**Why:** Each agent CLI keeps plugins and skills in its own directory. A person and an agent needed one import and one remove that reaches all of them, without an editor for the file contents.
**Links:** [intent/2026-11-04-import-extensions.md](../intent/2026-11-04-import-extensions.md)

Settings, `codeman extension`, `/api/extensions`, and three MCP tools call one service. Copies carry a `.codeman-extension.json` marker. The packaged Codeman skill keeps its own marker. The plugin marketplace name is `codeman-imports`.

## 2026-11-04 — Clean Grok and Copilot Chat snapshots

**Type:** propagated-discovery
**Touches:** `src/web/response-viewer-transcript.ts`, `src/web/routes/session-routes.ts`, `src/web/public/app.js`, `docs/wiki/Mobile-Guide.md`
**Why:** Grok repaints a full-screen TUI. Removing escape sequences from its raw output concatenates old frames into duplicated, corrupted messages.

Grok Chat now segments the captured screen, excluding interface chrome and unsent drafts. It does not fall back to the redraw stream when capture is unavailable. This source is limited to visible messages; choosing the newest saved conversation in a shared working directory would risk displaying another session.

Copilot's untimestamped `❯ Thought for …` rows are status, not submitted prompts. Chat omits status blocks while the Response Viewer API retains them for existing consumers.

## 2026-11-04 — Agents load the assurance rules

**Type:** intent-refinement
**Touches:** `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `docs/assurance/README.md`, `intent/2026-11-04-light-assurance.md`
**Why:** Claude Code reads `CLAUDE.md`. Codex and Antigravity read `AGENTS.md`. Copilot reads `.github/copilot-instructions.md`. Grok reads both `AGENTS.md` and `CLAUDE.md`. The rules have to be in those files or the agent never sees them.
**Links:** [intent/2026-11-04-light-assurance.md](../intent/2026-11-04-light-assurance.md)

The short rules now match in all three instruction files.

## 2026-11-04 — Light intent and assurance practice

**Type:** intent-refinement
**Touches:** `intent/`, `docs/assurance/`, `docs/invariants/`, `docs/JOURNAL.md`, `.claude/rules/protected-surfaces.md`, `CLAUDE.md`
**Why:** Changes need a short record of why they are being made, and draft promises need a place that does not freeze the rules the product already keeps.
**Links:** [intent/2026-11-04-light-assurance.md](../intent/2026-11-04-light-assurance.md)

Per-change intent files are in `intent/`. That directory is separate from Read My Mind. The rules that already hold stay in `CLAUDE.md` and `docs/architecture-invariants.md`. Drafts for promises that are still moving go in `docs/invariants/` and carry no numbered promises yet. Every Crosscheck skill can be run by name. No new hook and no failing assurance job is installed.
