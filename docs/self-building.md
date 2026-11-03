# Working in the self-building deployment

This fork runs as two Codeman servers, the blue and green colours, behind a reverse proxy that sends every request to whichever colour is live. A root-owned supervisor deploys a commit by building it in its own release directory, starting it as the idle colour, checking it, moving the proxy to it and then stopping the old colour. You can run the supervisor's commands, but you cannot change the supervisor, the proxy or their configuration. Both colours share one data directory and one tmux socket, and the tmux server runs as a service of its own, so your Claude Code session keeps running through every deploy, whether the deploy succeeds or not.

## Follow these rules

1. Deploy and roll back only with `codeman-deploy`. Never start, stop, restart or kill a Codeman server, a colour or the tmux server by hand, and never call `POST /api/deploy/role` yourself.
2. Ignore the upstream release and production steps in `CLAUDE.md`, such as `COM`, `systemctl --user restart codeman-web`, `codeman web -d` and pushing to `master`. They do not apply to this fork.
3. To try a server by hand, give it a throwaway `CODEMAN_INSTANCE` and its own port, as `scripts/run-beta.sh` does, and stop it when you finish. A server started without `CODEMAN_INSTANCE` can land on the shared data directory and tmux socket and attach to your own session.
4. Never turn on respawn, auto-resume, the Ralph loop or the orchestrator. The same goes for any other feature that sends Claude a prompt without a human message, such as cron jobs and prompt-cache keep-warm.
5. Keep stored data readable by the previous release. Every change to a file in the data directory must stay readable by the release before it. There are no reverse migrations. A rollback restores code only, so repair data with a new forward change.
6. Only the live colour writes. New code that writes the data directory, creates panes or acts on panes without being asked must check `deployRole.allows('persist')` or `deployRole.allows('automate')` at the moment it acts. `src/deploy-role.ts` holds the policy.
7. Change `deploy/test.sh` or `deploy/healthcheck.mjs` only to check more, or to follow a real change in the app. Never weaken them to get a deploy through.
8. The repository is public. Never commit a hostname, an IP address, a port in use, an OS username, a path on the server, a Cloudflare identifier or the name of another service on the machine. Read `git diff --cached` before every commit.
9. Never force-push, rewrite or reset the pushed branch, and never delete a release, a backup or a tag. Fix mistakes with new commits.
10. Never use an Anthropic API key, read or copy Claude Code's credentials, or send Claude requests through anything but the Claude Code CLI.
11. To change the supervisor, the proxy or the deploy design, write a proposal for Harry. Ask Harry before you change this file or merge an upstream Codeman release.

## Deploy a change

1. Make the change in this clone.
2. Run the gate the supervisor runs before every switch:

   ```sh
   bash deploy/test.sh
   ```

   It runs the type check, the frontend syntax check and a fixed list of tests. If the change touches the build or the frontend assets, run `npm run build` as well. `npm test` runs the whole suite, which took about 18 minutes when measured.

3. Commit with explicit paths, on top of the branch the supervisor pushes. That branch is `push.branch` in the supervisor config, and the installer default is `master`. The supervisor exports the commit with `git archive`, so uncommitted and untracked files never reach a release.
4. Deploy the commit:

   ```sh
   codeman-deploy "$(git rev-parse HEAD)"
   ```

5. Read the outcome. The command prints the deploy id and the path of its log, streams the log, and ends with an `outcome:` line.

`codeman-deploy` exits 0 on success, 1 when the run was rejected, 2 for a bad argument, and 3 when no result arrived within `requestWaitSeconds`. After exit 3 the deploy may still be running, so check `codeman-deploy status` before you deploy again. Deploys queue and run one at a time.

After a switch, every open page reloads itself on its next SSE reconnect, at most once every 30 seconds per tab.

### Read the outcome

A failure at any step before `switch` stops only the new colour and leaves the live app as it was. Your session is not affected.

| `outcome:` line | What happened | What to read |
| --- | --- | --- |
| `success` | The commit is live and tagged `good/<UTC timestamp>`. A failure after the switch shows as a `WARNING` line and does not undo the deploy. | Nothing more. |
| `failed at resolve` | The sha is not a commit in this clone. | The error on the outcome line. |
| `failed at backup` | Copying the data directory failed. | The deploy log. |
| `failed at build` | `deploy/build.sh` exited non-zero. | The build output in the deploy log. |
| `failed at test` | `deploy/test.sh` exited non-zero. | The test output in the deploy log. |
| `failed at start` | Something already answers on the idle colour's port. | Tell Harry. |
| `failed at health` | `deploy/healthcheck.mjs` did not pass within `healthTimeoutSeconds`, or the new colour exited. | Each attempt's JSON line, then the colour's own output, which the supervisor copies into the deploy log. |
| `failed at handoff` | `deploy/handoff.mjs` exited non-zero, or ran past `handoffTimeoutSeconds`. When it fails by itself it puts the old colour back to live first. | Its JSON line in the deploy log, and the next paragraph if it timed out. |
| `failed at switch` | The proxy reload or the supervisor's state write failed, and the proxy was pointed back at the old colour. | The next paragraph. |

A failure at `switch` after a successful handoff is undone by the supervisor, which runs `node deploy/handoff.mjs --undo` so the old colour is live again before the candidate stops. If the deploy log says the undo itself failed, or a handoff ran past `handoffTimeoutSeconds`, the old colour may be left retired. It then serves pages but writes nothing and cannot create sessions. Run `codeman-deploy rollback <live sha>` to start a fresh live colour from the same release, and tell Harry.

## Roll back

```sh
codeman-deploy status
codeman-deploy rollback previous
codeman-deploy rollback <sha>
```

`status` prints the live colour, its sha and the time it went live, the kept releases, the backups, the push state, the last five runs and the deploy lock. `rollback previous` switches to the release that was live before the current one. `rollback <sha>` switches to a kept release, or rebuilds and tests any older commit from the local git history.

A rollback runs the same steps as a deploy, and a kept release is reused without building or testing it again. The supervisor backs up the data directory first and then leaves it as it is, because a rollback restores code only. A second `rollback previous` returns to the release you just left.

Rollbacks are never pushed to GitHub, and a rollback also clears the pending push target. A deploy that was rolled back before the background push sent it stays local, unless a later deploy is built on top of it.

After a rollback the live code is older than the tip of the branch. Fix forward with a revert or a fix committed on top of the tip, then deploy that commit. Never reset the branch to the rolled-back commit, because the background push only fast-forwards.

Harry can run these commands from a shell session in the web UI, or from any shell as the app user.

### Roll back from the web UI

The Deploys section in Settings shows the live build, the releases kept on disk and the last five runs. It has a Roll back button for each kept release that is not live, a Roll back to previous button, and a box for any commit sha. Each asks for confirmation in the page. It queues the same request as `codeman-deploy rollback`, through `GET /api/deploy/overview` and `POST /api/deploy/rollback`, and only the live colour accepts the request. The rollback keeps running after the colour serving that page stops, and the page reloads itself when the new build goes live. A rejected rollback shows as a failed row in the list of runs.

The section only exists in builds that contain it. A rollback to a build from before it removes the section, and from there the way back is the shell command, `codeman-deploy rollback <sha>`.

## Handle failures

**A deploy is rejected.** The live app and your session are unchanged. Read the deploy log from its `FAILED at` line, fix the cause in a new commit, run `bash deploy/test.sh` and deploy again.

**The app misbehaves after a switch.** Roll back first with `codeman-deploy rollback previous`. Then find the cause in the telemetry of the release you left, and deploy a fix. Nothing rolls back by itself once a release is live.

**The done-criteria tests.** The supervisor's `tests/done` scripts deploy probe commits, check them and roll back. Run them only while the agent is idle, never while you are editing, because they move this clone onto a throwaway branch while they run. They also force the background push off for the run. That needs root, so as the app user they refuse to start while push is on.

**The app is down.** Harry cannot reach you through the web UI, although your tmux session keeps running. He recovers through Remote Control, which runs outside this machine and can restart it, open its console or restore a snapshot. At boot the supervisor starts the live colour again. If Harry reaches you through the console, run `codeman-deploy status` and roll back if the live release is the cause. Never start a server yourself.

## Diagnose from telemetry

The supervisor's config names both log directories, and every user can read it:

```sh
CFG=/etc/codeman-supervisor/config.json    # the installer default
APP_LOGS=$(jq -r '.colourEnv.CODEMAN_LOG_DIR' "$CFG")
DEPLOY_LOGS=$(jq -r '.logDir' "$CFG")
LAST=$(jq -c 'select(.outcome == "success")' "$DEPLOY_LOGS/deploys.jsonl" | tail -n 1)
SHA=$(jq -r .sha <<<"$LAST")
SINCE=$(jq -r .finishedAt <<<"$LAST")
```

`SHA` is the live release and `SINCE` is the time its run finished. To find a fault:

1. List the server's errors and warnings for the live build. `server.jsonl.1` holds the lines from before the last rotation.

   ```sh
   cat "$APP_LOGS/server.jsonl.1" "$APP_LOGS/server.jsonl" 2>/dev/null |
     jq -c --arg b "$SHA" 'select(.buildId == $b and (.level == "error" or .level == "warn"))' | tail -n 50
   ```

2. List the failed requests since the switch. Request lines name no build, so filter them by time.

   ```sh
   jq -c --arg t "$SINCE" 'select(.ts >= $t and .status >= 500)' "$APP_LOGS/requests.jsonl" | tail -n 50
   ```

3. Count the browser errors for the build.

   ```sh
   jq -r --arg b "$SHA" 'select(.buildId == $b) | .message' "$APP_LOGS/client-errors.jsonl" | sort | uniq -c | sort -rn | head
   ```

4. Search for a known message across both generations of a file with `grep`, for example `grep -h 'TypeError' "$APP_LOGS"/server.jsonl*`.
5. If the server crashed or never started, read `$DEPLOY_LOGS/colour-<colour>.log`. It holds each colour's stdout and stderr, including output from before file telemetry starts.
6. Reproduce the fault in a test, fix it, and deploy the fix.

To read the end of the last rejected run's log:

```sh
tail -n 100 "$(jq -r 'select(.outcome == "failed") | .log' "$DEPLOY_LOGS/deploys.jsonl" | tail -n 1)"
```

## Reference

### The deploy directory

The supervisor runs the four files in `deploy/` as the app user, from the root of the release they belong to. You change them like any other code, through a deploy, and each release is built and checked by its own copies.

| File | When the supervisor runs it | What it does |
| --- | --- | --- |
| `deploy/build.sh` | After it exports the commit. The environment carries no secrets, no data directory and no tmux socket. | Runs `npm ci` unless `package-lock.json` matches the stamp in `node_modules`, then `npm run build`. |
| `deploy/test.sh` | After the build, with the same environment. | Runs `npm run typecheck`, `npm run check:frontend-syntax` and a fixed list of test files. It fails if a listed file is missing. |
| `deploy/healthcheck.mjs` | After the new colour starts, every `healthRetryIntervalSeconds` until it passes or `healthTimeoutSeconds` ends. | Checks `GET /api/health` and its build id, and the `/ws/health` WebSocket. When the live colour is running, it also checks that the new colour lists every session the live colour lists. Prints one JSON line. |
| `deploy/handoff.mjs` | After the health check passes. | Retires the old colour, then promotes the new one, through `POST /api/deploy/role`. On a failure it puts the old colour back to live and exits 1. |

A release judges itself with its own health check, so a weakened check would pass the release that weakened it. Harry relies on rollback and Remote Control to catch that, which is why rule 7 exists.

### Code that supports deploys

- `src/deploy-role.ts` holds the role machine and its policy table. A colour starts as `candidate` when `CODEMAN_DEPLOY_ROLE=candidate`, or as `live` when the variable is unset. The transitions are `candidate` to `live`, `live` to `retired`, and `retired` to `live`. Only a `live` colour may `persist`, which means writing the shared files and creating panes, or `automate`, which means running the timers and controllers that write the data directory or act on panes.
- `src/telemetry.ts` writes the three telemetry files and owns the build id.
- `src/web/routes/telemetry-routes.ts` serves `GET /api/health`, `/ws/health` and `POST /api/client-errors`.
- `src/web/routes/deploy-routes.ts` serves `POST /api/deploy/role`. It accepts only loopback requests that carry no forwarding headers.
- `src/deploy-control.ts` and `src/web/routes/deploy-control-routes.ts` back the Deploys section in Settings, and `src/web/public/deploy-ui.js` draws it. They run the supervisor command named in `CODEMAN_SUPERVISOR_CLI` and pass on only shas, times and outcomes. A rollback request needs the `requestDeploy` capability, which only a `live` colour has.
- `src/web/pane-api-url.ts` hands panes `CODEMAN_STABLE_API_URL` as their `CODEMAN_API_URL` when it is an http or https URL on a loopback host, so their hooks reach whichever colour is live.
- `decideBuildReload()` in `src/web/public/constants.js` decides when a page reloads for a new build. `handleInit()` in `app.js` calls it.

### Deploy steps

The supervisor runs `lock`, `recover`, `resolve`, `backup`, `export`, `seed`, `build`, `test`, `publish`, `start`, `health`, `handoff` and `switch`, then `stop-old`, `tag` and `prune`. A reused release skips the steps from `export` to `publish`. `switch` is the commit point. A failure before it rejects the run, and a failure after it is a warning.

### Supervisor logs

These live under the supervisor's `logDir`, and the app user can read them.

| Path | Contents |
| --- | --- |
| `deploys/<deploy id>.log` | One log per deploy, rollback or boot start, with every step and all build, test, health and handoff output. |
| `deploys.jsonl` | One row per run, with `id`, `action`, `sha`, `outcome`, `failedStep`, `error`, `warnings`, `startedAt`, `finishedAt`, `colour`, `port` and `log`. |
| `colour-<colour>.log` | Each colour's stdout and stderr. |
| `push.log` | Every background `git push` and its output. |

### App telemetry

The server writes these files to `CODEMAN_LOG_DIR` when it is set, and both colours write to the same directory. Every line is one JSON object with an ISO 8601 `ts` field.

| File | Fields |
| --- | --- |
| `server.jsonl` | `level`, `buildId`, `pid` and `msg`. One line per console call, with `level` one of `log`, `info`, `warn`, `error` or `debug`. `msg` is capped at 8 KiB. |
| `requests.jsonl` | `buildId`, `pid`, `reqId`, `method`, `path`, `status` and `ms`. One line per HTTP response. `path` has no query string, and the token in a `/q/`, `/webview/` or `/html-view/` path reads `:redacted`. `reqId` restarts with each server process, so use `pid` or `buildId` to tell the two colours apart during a deploy. |
| `client-errors.jsonl` | `buildId`, `ua`, `message`, `source`, `line`, `col`, `stack` and `url`. One line per uncaught browser error or unhandled rejection. A page reports at most 20 distinct errors per load. The server accepts 30 reports a minute per client address, and behind the proxy every client shares the proxy's address. |

A file that has passed `CODEMAN_LOG_MAX_BYTES`, 20 MiB by default, is renamed to `<name>.1` before the next write, replacing the older `.1`. Lines are written in batches about every 200 ms. A write that fails is dropped, never raised, so a full disk loses lines without stopping the server.

### Environment the supervisor sets

| Variable | Meaning |
| --- | --- |
| `CODEMAN_DEPLOY_ROLE` | `candidate` for a new colour, `live` for the boot start. |
| `CODEMAN_BUILD_ID` | The full commit sha. `/api/health`, `/api/status`, the SSE init and every telemetry line that names a build report it. |
| `CODEMAN_LOG_DIR` | The telemetry directory. |
| `CODEMAN_STABLE_API_URL` | A loopback URL in front of the live colour, handed to panes. |
| `CODEMAN_SSE_PADDING` | `1` pads SSE frames so a buffering proxy flushes them. |
| `CODEMAN_DATA_DIR` and `CODEMAN_TMUX_SOCKET` | The shared data directory and tmux socket. |
| `CODEMAN_SUPERVISOR_CLI` | The supervisor command the Deploys section runs. When it is unset, the section is hidden. |
