# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **This file is deliberately small: it is loaded into every agent session.** It holds the rules that apply to every change. The dense per-subsystem rules that used to be here are in [`docs/subsystem-rules.md`](docs/subsystem-rules.md), and the mechanisms, file inventories and history behind them are in [`docs/architecture-invariants.md`](docs/architecture-invariants.md). **Before you change a subsystem, find its title in the index below and read its paragraph in `docs/subsystem-rules.md`** (`grep -n '<title>' docs/subsystem-rules.md`, then Read from that line; never read the whole file). Frontend rules are in [`src/web/CLAUDE.md`](src/web/CLAUDE.md). When the goal is raw throughput, [`docs/SPEEDRUN.md`](docs/SPEEDRUN.md) is the fast-execution protocol (it removes ceremony, never the safety rules here). The user-facing manual is `docs/wiki/`, and `AGENTS.md` deliberately just points here.
>
> **Keep it small.** A new subsystem rule goes in `docs/subsystem-rules.md` with its title added to the index here, not as a paragraph in this file. `CLAUDE.md`, `src/web/CLAUDE.md` and `docs/subsystem-rules.md` are in `.prettierignore` on purpose (Prettier corrupts their glob-heavy paths): do not remove the entries and do not run `prettier --write` on them. Why the repo root is kept short, and which files must stay there, is the first paragraph of `docs/subsystem-rules.md`.

## This fork deploys itself

Read [`docs/self-building.md`](docs/self-building.md) before you deploy, roll back, or change anything under `deploy/`. Deploy a commit only with `codeman-deploy "$(git rev-parse HEAD)"`. The rules in that file override the release and production steps below, including `COM`, `systemctl --user restart codeman-web` and pushing to `master`. Never restart a Codeman server or the tmux server by hand, and start a server from this clone only under a throwaway `CODEMAN_INSTANCE`.

## Assurance

Follow these on every change. The same rules are in `AGENTS.md` and `.github/copilot-instructions.md`.

- Start a non-trivial change with `intent/<yyyy-mm-dd>-<slug>.md`, copied from `intent/TEMPLATE.md`. Revise that file in place while the work is still moving.
- That directory is not Read My Mind. Read My Mind is `src/intent-store.ts`, `~/.codeman/intents.json`, and `docs/readmymind.md`.
- Rules that already hold live in this file, in [`docs/subsystem-rules.md`](docs/subsystem-rules.md) and in [`docs/architecture-invariants.md`](docs/architecture-invariants.md). Update them in the same change as the code they describe.
- A promise that is still moving can be a `Status: Draft` note under `docs/invariants/`. A draft does not override an architecture invariant and does not block a commit.
- Do not add a commit hook, a failing CI job, or a protected-surface block unless an intent file asks for that gate.
- Crosscheck skills from the Nicholls plugin can be run by name. A layer 5 or layer 6 result is a search, and it is not proof. The menu is [`docs/assurance/README.md`](docs/assurance/README.md).
- Read [`docs/JOURNAL.md`](docs/JOURNAL.md) before a non-trivial change, and add an entry there when the change records a decision.

## Quick Reference

| Task        | Command                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dev server  | `npm run dev` (or `npx tsx src/index.ts web`)                                                                                                                       |
| Type check  | `npm run typecheck` (= `tsc --noEmit` + `tsc -p config/tsconfig.scripts.json`)                                                                                      |
| Lint        | `npm run lint` (fix: `npm run lint:fix`)                                                                                                                            |
| Format      | `npm run format` (check: `npm run format:check`)                                                                                                                    |
| Tests       | `npm test` (the CI gate — safe to run bare) · one file: `npm test -- test/<file>.test.ts` · see Testing for the excluded suites |
| Build       | `npm run build` (esbuild via `scripts/build.mjs`, NOT tsc — `tsc --noEmit` is type-check only)                                                                      |
| Production  | `codeman-deploy "$(git rev-parse HEAD)"` in this fork ([`docs/self-building.md`](docs/self-building.md)); upstream installs use `npm run build && systemctl --user restart codeman-web` |

More commands (gesture bundle, CLI catalogue, docker agent image, pre-push hook, detached server, CI layout, code style and Prettier's narrow scope): `docs/subsystem-rules.md`, "Additional Commands".

## CRITICAL: Session Safety

**You may be running inside a Codeman-managed tmux session.** Before killing ANY tmux or Claude process:

1. Check: `echo $CODEMAN_MUX` - if `1`, you're in a managed session
2. **NEVER** run `tmux kill-session`, `pkill tmux`, or `pkill claude` without confirming
3. Use the web UI or `./scripts/tmux-manager.sh` instead of direct kill commands

**The working tree is shared with other agent sessions.** Several Codeman sessions run against THIS one checkout, so another session can `git checkout` a different branch, or leave half-finished untracked files, while you are mid-task.

- **Always `git branch --show-current` immediately before committing.** Observed 2026-07-27: another session ran `git checkout -b feat/web-tabs`, a commit silently landed there instead of master, and the follow-up `git push origin master` cheerfully reported "Everything up-to-date".
- To land a commit on master **without** switching branches (which would yank the tree out from under the other session): `git push origin HEAD:master` then `git branch -f master HEAD`. Never `git checkout master` to "fix" it.
- **Never `git add -A`/`git add .`** — stage explicit paths. A sweep will pick up another session's WIP.
- Another session's broken WIP can block `npm run build`, since `tsc` is the first step and the build gates on it. That is not your bug to fix. ⚠️ `tsc` still EMITS on type errors, so a failed `npm run build` leaves a rebuilt `dist/index.js` compiled from their tree; check what it pulled in before restarting the service. To deploy frontend-only changes past a blocked `tsc`, run the asset stage of `scripts/build.mjs` (everything after the `tsc`/`chmod` lines is independent of it).
- **A pre-push failure in a file you did not touch is another session's WIP.** Push with `CODEMAN_SKIP_PREPUSH=1 git push` and leave it alone. (The hook already skips itself when the tree has uncommitted changes in a path it checks, so this mostly happens once the other session has committed.)

## CRITICAL: Always Test Before Deploying

**NEVER COM without verifying your changes actually work.** For every fix:

1. **Backend changes**: Hit the API endpoint with `curl` and verify the response
2. **Frontend changes**: Use Playwright to load the page and assert the UI renders correctly. Use `waitUntil: 'domcontentloaded'` (not `networkidle` — SSE keeps the connection open). Wait 3-4s for polling/async data to populate, then check element visibility, text content, and CSS values
3. **Only after verification passes**, proceed with COM

Static files are cached for a year, but `index.html` is `no-cache` and every same-origin `.js`/`.css` reference in it gets `?v=<mtime>`, so a normal reload picks up edited modules and styles. ⚠️ `index.html` itself is read ONCE at server start: editing its markup needs a server restart. Detail: `docs/subsystem-rules.md`, "Static asset caching".

## COM Shorthand (Deployment)

Uses [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`) via `@changesets/cli`. What SemVer actually covers (the CLI, documented env vars, **and the HTTP/SSE API under `/api/v1`**: endpoint paths, response envelope, `errorCode` values and SSE event names are public/stable; on-disk state, internal TS modules, and experimental features are internal/unstable) is defined in `docs/versioning-policy.md`. Third-party integration surfaces are documented in `docs/extending-codeman.md`. Security reporting + known limitations live in `.github/SECURITY.md`.

When the user says **COM** (`COM` = patch, `COM minor`, `COM major`): **Read [`docs/releasing.md`](docs/releasing.md) and follow every step in order**; never improvise a release from memory. It covers the changeset, `npm run version-packages`, the `**Version**` line below, the branch check and explicit-path commit, deploy, the getcodeman.com badge, watching BOTH CI workflows, the MCP registry publish, and the Discussions announcement.

**Version**: 1.47.0 (must match `package.json`)

## Project Overview

Codeman is a Claude Code session manager with web interface and autonomous Ralph Loop. Spawns Claude CLI via PTY, streams via SSE, supports respawn cycling for 24+ hour autonomous runs.

**Tech Stack**: TypeScript (ES2022/NodeNext, strict mode), Node.js, Fastify, node-pty, xterm.js. Supports Claude Code, OpenCode, Codex (OpenAI), Gemini (Google, enterprise-only since Google's June 2026 consumer cutover), Antigravity (`agy`, Google), Pi (pi.dev), Grok Build (`grok`, xAI), DeepSeek Harness (`dsh`), OMP (`omp`) and GitHub Copilot (`copilot`, npm `@github/copilot`) CLIs via pluggable CLI resolvers (`SessionMode = 'claude' | 'shell' | 'opencode' | 'codex' | 'gemini' | 'antigravity' | 'pi' | 'grok' | 'deepseek' | 'omp' | 'copilot'`).

**TypeScript Strictness** (see `tsconfig.json`): `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `allowUnreachableCode: false`, `allowUnusedLabels: false`.

**Requirements**: Node.js 22+, Claude CLI, tmux

**Git**: Main branch is `master`. Terminal session dashboard: `codeman tui` (`--list` to list, `codeman tui <n>` to attach).

## Rules for every change

- **ESM only**: never `require()`, use `await import()`. `tsx` masks CJS/ESM issues in dev but production breaks.
- **Package ≠ product name**: npm `aicodeman`, product **Codeman**; both `aicodeman` and `codeman` bins are installed.
- **Imports**: utils from `./utils`, types from `./types` (barrel), runtime config from the specific `src/config/*` file (no barrel). The repo-root `config/` is tooling only.
- **Global regex `lastIndex`**: reset it before reusing a shared `g`-flag pattern, or use `execPattern()` (`utils/regex-patterns.ts`). Never build a RegExp from caller or config text without `compileVersionRegex()`.
- **Zod v4; `.optional()` rejects `null`**: convert `null` to `undefined` before `JSON.stringify`, or declare `.nullish()`.
- **Data dir and tmux socket**: every `~/.codeman/...` path goes through `dataPath()` and every `tmux -L` caller through `resolveTmuxSocketName()` (`src/config/instance.ts`). A second Codeman on the same socket attaches to the first one's live sessions.
- **User-chosen paths are probed BOUNDED** (`probePath()`/`probePathKind()`), never `existsSync`/`statSync` on a request or spawn path; `unknown` is never `absent`.
- **Programmatic input must END with `\r`** or Enter is never sent; a prompt is one paste plus a separate Enter (`writeViaMux`).
- **No code outside `src/config/cli-registry/stock.ts` branches on a CLI id**: use a capability field or a named profile. Env overrides pass only the per-CLI prefix allowlist; effort, advisor and model are NOT env vars.
- **`settings.json` writes go through `mutateSettingsFile()`**, and a synced setting is admin-only to write in multi-user mode. Decide per-device vs synced before adding a setting.
- **SSE events** are declared on both sides (`src/web/sse-events.ts`, `SSE_EVENTS` in `constants.js`) and must stay in sync.
- **Text from an agent, a file or a user reaches the DOM through `textContent`**, never `innerHTML`.
- **Generated files are not edited or committed**: `dist/`, the vendor bundles under `src/web/public/vendor/`, `canvas.js`. Change the package source and rebuild.
- **Pure helpers are split out of the large files on purpose** so tests exercise shipped code: keep new logic that way. Every file has a `@fileoverview`: read it before diving in.
- **Memory (24h+ sessions)**: use `CleanupManager`, clear Maps in `stop()`, guard async with `if (this.cleanup.isStopped) return`, `LRUMap`/`StaleExpirationMap` for caches.
- **Headless screenshots**: `deviceScaleFactor` 1 and a unique filename per run.

## Subsystem index

Each name below is the bold title of a paragraph in [`docs/subsystem-rules.md`](docs/subsystem-rules.md). Read the paragraph before touching that subsystem; it carries the ⚠️ rules and the pointer into `docs/architecture-invariants.md`.

- **Gotchas**: A prompt is one paste plus Enter · ESM only · Package ≠ product name · Global regex `lastIndex` · `envOverrides` flow `CLAUDE_CODE_*` / `OPENCODE_*` / `CODEX_*… · Effort is NOT an env var · The advisor rides `--settings`, NEVER the `--advisor` flag · Model choice · Multi-CLI prefix discipline · Zod `.optional()` rejects `null` · Local-echo overlay stays on screen · `xterm-zerolag-input` is single-source · Default bind is loopback-only; non-loopback without a passwor… · Instance isolation / multi-instance attach danger · The prefix table on Codeman's socket holds only `<prefix> sen… · node-pty's macOS `spawn-helper` ships without `+x` · User-chosen paths are probed BOUNDED, never with `existsSync`… · Headless screenshots · Import conventions
- **Code map**: Read before touching a subsystem · Local packages · Config · Utilities
- **Key patterns (server)**: Input · Agent wait primitives · Agent CLI · MCP server · Redacted log query · Agent-created case marker · Agent preamble cache GC · Idle detection · Respawn usage budgets · A `❯` sighting is NOT the end of a turn, and neither is silence · A turn that ENDED waiting for its own workers is working, not… · A codex dialog is BLOCKED, read off the screen, and only ever… · A quiet pane is not always a pane that wants you · An exited agent in a live pane · Dead-pane respawn resume pin · Workspace-trust dialog auto-accept · Process-tree walks are bounded · Auto-resume on usage limit · Config backups · Plan-usage chip · Prompt-cache keep-warm · Orchestrator · Cron · Remote sessions + remote SSH cases · Wake-on-LAN · Docker cases · Docker Compose deployment · CLI registry · External CLI modes · DeepSeek web UI · Case rename · Custom Model Endpoint Profiles · llama-swap endpoints · MCP server sync · Auto-named sessions · Maintainer bot · Unified session list · Owner tab layouts · Hook events · Reboot restore · Approvals Inbox · Read My Mind intent profiles · Agent inbox · Voice dictation via Claude · Agent Teams · Circuit breakers · Full-scrollback replay · Terminal scrollback strip + wheel/touch forwarding · Detached start + service install · Self-update · Reverse-proxy base path · Attachments · Prompt uploads · File-path links · Filesystem path picker · File Viewer edit mode · Files panel search · Git status indicator · Git fetch · Raw file bodies are streamed and range-aware · Ultracode / workflow-run visualization · Clone a repository as a case · Git worktrees of a case · Cross-session search · Web tabs · Preview servers · Multi-user mode · Away digest · Ralph todo-config · Port interfaces
- **Frontend**: Mermaid diagrams · Frontend invariants live in src/web/CLAUDE.md · Gesture control · PTY and browser terminal geometry · Service worker precache
- **Canvas** (`src/canvas/`, `packages/canvas/`, behind the synced `canvasEnabled`; it and `canvasShellEnabled` are ON unless `settings.json` says `false`, an absent key included, read ONLY through `canvasOn()`/`shellActive()` in `src/web/shell-landing.ts` and `canvasSettingOn()` in settings-ui.js, and nothing writes the key to make it so): sections "Canvas storage" (which holds the canvas shell rule, `canvasShellEnabled`) and "Canvas read view" in `docs/subsystem-rules.md`, "Canvas document" in `src/web/CLAUDE.md`, program plan in `docs/agentic-canvas/`.
- **Also there**: Security (layer table and env vars; full model in `docs/security-architecture.md`), SSE Event Registry, API Routes and the HTTP contract, Adding Features (the long form), State Files, Performance & Limits, Scripts & Tunnel (`install.sh`).

Read first for whole subsystems: respawn → `docs/respawn-state-machine.md`; Ralph → `docs/ralph-wiggum-guide.md`; orchestrator → `docs/orchestrator-loop-architecture.md`; cron → `docs/cron-discovery.md`; DeepSeek → `docs/deepseek-integration.md`; TUI → `docs/tui-plan.md`; CLI registry → `docs/cli-registry.md`; Docker cases → `docs/docker-cases.md`; remote sessions → `docs/remote-sessions.md`.

## Security in one paragraph

Default bind is loopback; optional HTTP Basic via `CODEMAN_PASSWORD`; always-on Host-header and cross-site Origin guards; hook routes are loopback-only and need `X-Codeman-Hook-Secret` when auth is on; a tunnel refuses to start without a login. Validate every input with a Zod schema in `schemas.ts`. Multi-user mode separates workspaces but is not a sandbox: every session runs as the same OS account. Before touching auth, binding, file serving, the web-tab proxy or anything that fetches a URL or spawns a process from caller text, read "Security" in `docs/subsystem-rules.md` and [`docs/security-architecture.md`](docs/security-architecture.md).

## Adding Features

- **API endpoint**: types in `src/types/`, route in `src/web/routes/*-routes.ts`, Zod schema in `schemas.ts`, answer with the `ApiResponse` envelope (`{ success: true, data }`; errors via `createErrorResponse()`). `/api/v1/*` is a stable public alias (`docs/versioning-policy.md`, `docs/api-reference.md`).
- **SSE event**: add to both registries, emit via `broadcast()`, handle in `app.js` (`addListener(`).
- **Session setting**: add to `SessionState`, include in `session.toState()`, call `persistSessionState()`.
- **App setting**: read "Adding Features → App setting" in `docs/subsystem-rules.md` first (per-device vs synced, `merged`, admin gate, the settings writer).
- **Hook event**: `HookEventType`, `hooks-config.ts:generateHooksConfig()`, `HookEventSchema`.
- **Mobile feature**: guard with `MobileDetection.isMobile()`; new header buttons stay off phones.
- **New test**: in-process servers bind port 0 and read the bound port; route tests use `app.inject()`.

## Testing

**`npm test` is the gate and is safe to run bare**: it runs `config/vitest.ci.config.ts`, exactly what CI runs.

```bash
npm test                                          # The gate — what CI runs
npm test -- test/<specific-file>.test.ts          # Single file
npm test -- -t "pattern"                          # By name
npm run test:browser   # Playwright + chromium, live server
npm run test:mobile    # browser suite plus environment-specific PNG baselines
npm run test:perf      # wall-clock benchmarks, need an idle machine
```

- ⚠️ **`npm test` cannot see the browser, mobile and perf suites.** A change touching mobile, gesture or terminal-render behaviour needs the matching runner by hand; diff its FAIL list against master.
- ⚠️ **A file filter must match the runner.** `npm test -- test/mobile/x.test.ts` matches nothing and exits GREEN having run zero tests. Read the file count, not the colour.
- **Isolation**: under vitest, tmux and docker IO are no-ops and each file gets a temp `HOME`. Prefer `npm test --`; never point `--config` at a config without `setupFiles`.
- **Ports**: every in-process test server binds port 0. Never 3000.
- **Live instance**: `w1`/`w2`/`w3` and every other existing session are the user's REAL sessions. Never send input to them. Create a throwaway session, test against that, and delete it by exact id.
- ⚠️ Browser tests can pass vacuously on mobile input paths (`app.sendInput` bypasses the local-echo overlay; headless Chromium reports no touch). Detail and the remaining test rules: "Testing" in `docs/subsystem-rules.md`.

## Debugging

```bash
tmux -L codeman list-sessions                      # Codeman's own socket
curl -sk https://localhost:3000/api/sessions | jq  # prod is HTTPS-only; dev on :3000 is plain http
curl -sk https://localhost:3000/api/status | jq    # Full app state
cat ~/.codeman/state.json | jq                     # Persisted state
```
