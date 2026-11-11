# Journal

Newest entries first. After an entry is on the default branch, correct it with a new entry. The types are `propagated-discovery`, `intent-refinement`, `drift`, `retraction`, and `status-transition`.

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
