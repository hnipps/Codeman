# Intent: A preview server does not inherit this Codeman's instance, deploy or login

**Status:** Draft

## Problem statement

A preview server (`src/preview-supervisor.ts`) is started with the Codeman server's own environment, spread whole. Only `CODEMAN_PASSWORD` and `CODEMAN_USERNAME` were removed. So the agent's dev server inherited `CODEMAN_DATA_DIR`, `CODEMAN_TMUX_SOCKET`, `CODEMAN_DEPLOY_ROLE` and the other variables that scope and operate THIS Codeman.

Observed 2026-11-14: a throwaway Codeman started as a preview with `CODEMAN_INSTANCE=proto-demo` still used the live data directory and tmux socket, because `CODEMAN_DATA_DIR` and `CODEMAN_TMUX_SOCKET` outrank `CODEMAN_INSTANCE` (`src/config/instance.ts`). That is the multi-instance attach danger: the second instance discovers and attaches to the first one's live sessions.

## Proposed outcome

A preview server starts from the Codeman server's environment minus one named list, `PREVIEW_STRIPPED_ENV` in `src/preview-env.ts`, built by the pure `buildPreviewEnv()`. `PORT`, `CODEMAN_PREVIEW_ID` and `CODEMAN_PREVIEW_OWNER` are set afterwards, so the stop path still finds the server by its markers.

Each stripped variable, and why:

| Variable | Why a preview must not inherit it |
| --- | --- |
| `CODEMAN_INSTANCE` | A nested Codeman would take this instance's name, so its data dir and socket. |
| `CODEMAN_DATA_DIR` | Outranks `CODEMAN_INSTANCE`: the nested Codeman reads and writes this data dir. The observed bug. |
| `CODEMAN_TMUX_SOCKET` | Outranks `CODEMAN_INSTANCE`: the nested Codeman attaches to this instance's panes. The observed bug. |
| `CODEMAN_PORT`, `CODEMAN_HOST` | A nested Codeman would try to bind this server's address. The preview's port is `PORT`. |
| `CODEMAN_BASE_URL` | The reverse-proxy prefix of this server, not of anything the preview serves. |
| `CODEMAN_DEPLOY_ROLE` | A nested Codeman would start as this colour's role, e.g. `candidate`. |
| `CODEMAN_SUPERVISOR_CLI` | A nested Codeman's deploy routes would drive the real deploy supervisor. |
| `CODEMAN_STABLE_API_URL` | A nested Codeman would point its panes at the live address of this deployment. |
| `CODEMAN_RESTART_BY_EXIT` | A nested Codeman would exit to update, expecting a supervisor that is not its own. |
| `CODEMAN_BUILD_ID` | A nested Codeman would report this server's build. |
| `CODEMAN_LOG_DIR` | A nested Codeman would append its telemetry to this server's log streams. |
| `CODEMAN_PASSWORD`, `CODEMAN_USERNAME` | This server's login. Already stripped before this change. |
| `CODEMAN_MULTIUSER` | This server's login mode; without the credentials above a nested one starts in a mode it cannot satisfy. |
| `CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK`, `CODEMAN_ALLOW_UNAUTHENTICATED_TUNNEL` | An acknowledgement of exposure is given for one server. A child must not start already waived. |
| `CODEMAN_MUX`, `CODEMAN_SESSION_ID`, `CODEMAN_MUX_NAME` | Present only when the server was itself started from a pane. They name a session that is not the preview's, and `codeman agent` would act as it. |
| `CODEMAN_HOOK_SECRET_FILE` | Same case. The path to the secret that authenticates hook events. |

Kept on purpose:

- `CODEMAN_API_URL`. It names this server only. A nested Codeman overwrites it in `WebServer.start()`. Nothing in the preview path reads it, and `codeman agent` refuses to run without `CODEMAN_MUX=1`, which is stripped, so keeping it gives a preview no identity. An app under preview that wants to call this Codeman can still find it.
- `CODEMAN_CASES_PATH`, `CODEMAN_USER_SPACES_DIR`. The cases trees are shared across instances by design.
- Tuning limits (`CODEMAN_MAX_*`, timeouts) and facts about the host (`CODEMAN_IN_CONTAINER`, `CODEMAN_DOCKER_HOST_HOME`). They describe the machine, not this server.

## Affected users and systems

Agents that start a dev server with `codeman agent preview add`, and anyone running a throwaway Codeman as a preview. The preview stop path is unchanged: it reads the two markers, which are set after the strip.

## Constraints

- The markers `CODEMAN_PREVIEW_ID` and `CODEMAN_PREVIEW_OWNER` must reach every preview process. The unit test pins that they are not on the list.
- Keys are deleted, never set to `undefined` (COD-115: node-pty and spawn serialize a present-undefined key as a string).
- No stored data changes.

## Other leak sites, reported and not changed here

- Session panes. `TmuxManager.createSession()` runs `tmux new-session` with the server's environment minus `TMUX`. When Codeman cold-starts the tmux server, the tmux global environment, and so every pane, carries the same variables. Not the same fix: `codeman agent` in a pane reads the login from the data dir's `.env`, which it finds through `CODEMAN_DATA_DIR`/`CODEMAN_INSTANCE`, so stripping them there would break it. In this fork the tmux server runs as its own service and does not inherit a colour's environment.
- Direct-PTY fallback (`buildClaudeEnv`, `buildShellEnv`, `buildMuxAttachEnv` in `session-cli-builder.ts`) spreads `process.env` the same way, password included.
- `deepseek-web-server.ts` (`dsh web`), `web/self-update.ts` and the dsh plugin install in `system-routes.ts` pass the server's environment whole. Self-update needs it.
- `headless-browser.ts` spreads `process.env` into the browser child.

## Open questions

None for the preview path. Whether panes should get a narrower list (for example `CODEMAN_DEPLOY_ROLE`, `CODEMAN_SUPERVISOR_CLI`, `CODEMAN_PASSWORD`) is a separate decision.
