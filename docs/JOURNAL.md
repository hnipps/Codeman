# Journal

Newest entries first. After an entry is on the default branch, correct it with a new entry. The types are `propagated-discovery`, `intent-refinement`, `drift`, `retraction`, and `status-transition`.

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
