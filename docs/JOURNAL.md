# Journal

Newest entries first. After an entry is on the default branch, correct it with a new entry. The types are `propagated-discovery`, `intent-refinement`, `drift`, `retraction`, and `status-transition`.

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
