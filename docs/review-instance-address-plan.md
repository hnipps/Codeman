# Review instance address: proposal

**Status:** Proposal for Harry. Nothing in it has been applied. `docs/self-building.md` rule 11 says changes to the supervisor, the proxy or the deploy design are proposed in writing; this is that proposal.

## The need

The planned Reviews page lets Harry review a finished branch inside Codeman. When the branch is a branch of Codeman itself, an **Open live** button opens that branch's running instance in a new browser tab.

That tab runs unreviewed code. It must not share the live app's login cookie, its stored settings (`localStorage`, IndexedDB) or its service worker. Those are all keyed by web origin, so the review instance needs an origin of its own. A sub-path of the live address is ruled out because it is the same origin. It is never embedded in a frame, so frame rules do not matter here.

The preview server fix of 2026-11-14 (`intent/2026-11-14-preview-env-isolation.md`) already gives a Codeman started as a preview its own data directory and tmux socket. This proposal is about the address and the process that serves it.

## Placeholders

The repository is public, so this document names no host, address, port, user or server path. Harry fills these in privately.

| Placeholder | Meaning |
| --- | --- |
| `<live-host>` | The public hostname of the live app. |
| `<review-host>` | The new public hostname for the review instance. |
| `<zone>` | The DNS zone both hostnames sit in. |
| `<tunnel>` | The tunnel that carries `<live-host>` to the VM. |
| `<proxy-listener>` | The reverse proxy's listener that the tunnel reaches today. |
| `<review-unit>` | The name of the new service unit that runs the review instance. |
| `<review-port>` | A loopback port for the review instance. It must differ from both colours' ports in `config.json`, the stable API listener and `<proxy-listener>`. |
| `<review-user>` | A new OS user that runs the review instance. |
| `<review-data-dir>` | The review instance's data directory, under `<review-user>`'s home. |
| `<review-releases-dir>` | Where the supervisor keeps the one review build. |

## Options for a separate origin

An origin is scheme, host and port. Cookies are looser: they ignore the port and, with a `Domain` attribute, can span subdomains. Codeman's `codeman_session` cookie is host-only (no `Domain`, `path=/`, `src/web/middleware/auth.ts`).

| Option | Separate origin? | Separate cookie jar? | Verdict |
| --- | --- | --- | --- |
| A second port on `<live-host>` | Yes | **No.** Cookies ignore the port, so both instances read and overwrite one `codeman_session` cookie. | Rejected. It fails the cookie requirement. The tunnel also routes by hostname, not port. |
| A subdomain of the live host, `review.<live-host>` | Yes | Yes, while the live cookie stays host-only | Works, but a two-level name is not covered by the zone's default edge certificate, and any future `Domain=` cookie on the live app would reach it. |
| **A sibling hostname, `<review-host>` in `<zone>`** | Yes | Yes | **Recommended.** One-level name, so the existing edge certificate covers it. Needs one DNS record, one tunnel ingress rule and one Access application. |
| A separate registrable domain | Yes | Yes, and also cross-site | Strongest, since `SameSite` then separates them too. Costs a domain. Not needed, given the next point. |

A sibling hostname is the same *site* as `<live-host>`, so a page on `<review-host>` can send requests to `<live-host>` that carry the live cookie. Codeman already refuses those writes: `registerHostGuard()` rejects a state-changing request whose `Origin` hostname is not in the live colour's `CODEMAN_ALLOWED_HOSTS` (`isAllowedRequestOrigin()` in `src/web/network-auth-policy.ts`). Reads come back opaque to the review page because Codeman grants CORS only to `localhost`, `127.0.0.1` and `::1` origins (`registerSecurityHeaders()` in `src/web/middleware/auth.ts`). Two rules keep that true:

- The live `CODEMAN_ALLOWED_HOSTS` must never gain a suffix entry (`.<zone>`) that matches `<review-host>`.
- The live app must never add a CORS grant for `<review-host>`.

## Recommended design

The supervisor owns the review instance, the same way it owns the colours. The app asks for it through the supervisor CLI, as the Deploys section already does.

- **One unit.** A new systemd unit, `<review-unit>`, runs one Codeman on `127.0.0.1:<review-port>` as `<review-user>`. One unit means at most one review instance, by construction.
- **Static proxy route.** The reverse proxy gets one more site that sends `<review-host>` to `<review-port>`. It never changes per review, so no review action reloads the proxy.
- **Its own build.** `codeman-supervisor review start <sha>` exports the commit with `git archive` and runs `deploy/build.sh` into `<review-releases-dir>`, through the same queue as deploys. It skips `deploy/test.sh`, the backup, the handoff, the switch and the `good/` tag. It writes no state the deploy path reads.
- **Stop.** `codeman-supervisor review stop` stops the unit and deletes the build. The Reviews page calls it when a review is decided.

### Why a second OS user

Origin separation protects the browser. It does nothing on the server. A review instance running as the app user can read the live data directory, the login file it links to (`.env` in the live data dir), the live tmux socket directory, and the supervisor's queue, so unreviewed code could read the live password, attach to live agent sessions or queue a deploy.

Every one of those is closed to a user outside the app user and app group today. The live home and data directory are owner-only, the tmux socket directory is owner-only, and the login file and the queue directory are readable by the app group only. Running the review instance as `<review-user>`, not in the app group, closes all of them without changing any of their permissions.

The same gap exists today for every preview server an agent starts, because those run as the app user. This proposal does not change previews.

## Steps for Harry

Each step is a change to the supervisor, the proxy or the host. None of it can be done from inside the app.

### 1. DNS, tunnel and Access (host side)

1. Add a DNS record for `<review-host>` that points at `<tunnel>`, the same way `<live-host>` does.
2. Add an ingress rule for `<review-host>` to `<tunnel>`'s config. Point it at the same service as `<live-host>` (`<proxy-listener>`). The tunnel passes the `Host` header through (the live colour's `CODEMAN_ALLOWED_HOSTS` check depends on that already), so the proxy can tell the two apart. No new port is opened into the VM, so the host's firewall rules for the VM do not change.
3. Add an edge access application for `<review-host>` with the same policy as the one in front of `<live-host>`. Its sign-in cookie is per application, so this is a separate sign-in.

### 2. The review user (VM)

1. Create `<review-user>` with its own home. Do not add it to the app group.
2. Give it read access to the review build only: `<review-releases-dir>` owned by root, readable by `<review-user>`.
3. Do not give it a Claude Code login. Agent sessions inside the review instance then cannot spend tokens. See open question 4.

### 3. The reverse proxy (VM)

1. On `<proxy-listener>`, add a site that matches only the host `<review-host>`. Keep the existing site as the catch-all for every other host, so it keeps serving `<live-host>`.
2. Point the new site at `127.0.0.1:<review-port>` with response buffering turned off, the same setting the colour upstream uses so SSE frames flush.
3. Write it into the proxy's main config, not into the upstream file the supervisor rewrites on each switch. A switch must never touch it.
4. Reload the proxy once.

When no review instance is running, the proxy answers `<review-host>` with 502, which is the right answer.

### 4. The review unit (VM)

```ini
[Unit]
Description=Codeman review instance
After=network.target

[Service]
Type=simple
User=<review-user>
Group=<review-user>
EnvironmentFile=<supervisor env dir>/review.env
ExecStart=/bin/sh -c 'cd "$CODEMAN_RELEASE_DIR" && exec "$CODEMAN_NODE_BINARY" dist/index.js web --port "$CODEMAN_COLOUR_PORT"'
KillMode=control-group
MemoryHigh=<review memory high>
MemoryMax=<review memory max>
RuntimeMaxSec=<idle ceiling>
OOMPolicy=stop
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=<review-user home>
PrivateTmp=yes
```

Unlike a colour, the review instance's tmux server should live in this unit's cgroup. Stopping the unit then kills every pane it started, which is what a review needs. `PrivateTmp=yes` also gives it its own tmux socket directory.

`RuntimeMaxSec` is the idle ceiling: the unit stops after that long whatever happens. Four hours would match the preview idle stop (`CODEMAN_PREVIEW_IDLE_STOP_MS`). A stop on real inactivity, read from the proxy's access log for `<review-host>`, can come later if the ceiling proves too blunt.

### 5. The review environment (supervisor)

`review start` writes `review.env` with exactly these variables, and nothing copied from `colourEnv` or the app env file:

| Variable | Value | Why |
| --- | --- | --- |
| `CODEMAN_RELEASE_DIR` | The review build | Same role as for a colour. |
| `CODEMAN_COLOUR_PORT` | `<review-port>` | Same role as for a colour. |
| `CODEMAN_NODE_BINARY` | `config.nodeBinary` | Same role as for a colour. |
| `CODEMAN_DATA_DIR` | `<review-data-dir>` | Explicit, so nothing falls back to a shared default. |
| `CODEMAN_TMUX_SOCKET` | `codeman-review` | A name no colour uses. The private `/tmp` separates it anyway. |
| `CODEMAN_ALLOWED_HOSTS` | `<review-host>` | Its own Host allowlist and Origin check. |
| `CODEMAN_BUILD_ID` | The reviewed sha | So its UI and telemetry say which build it is. |
| `CODEMAN_PASSWORD` | The review password (section "Login") | Never the live password. |

Left out on purpose:

- `CODEMAN_SUPERVISOR_CLI`. Its Deploys section stays hidden, and with no group membership it could not reach the queue anyway.
- `CODEMAN_STABLE_API_URL`, `CODEMAN_LOG_DIR`. Those point at the live deployment.
- `CODEMAN_DEPLOY_ROLE`. Unset is `live` (`parseStartRole()` in `src/deploy-role.ts`), which is right for a server alone in its own data dir. See open question 3.

### 6. Supervisor commands

1. `codeman-supervisor review start <sha>`: refuse while a deploy is queued or running, refuse if a review is already running (or replace it, see open question 2), build, write `review.env`, start the unit, wait for `/api/health`.
2. `codeman-supervisor review stop`: stop the unit, delete the build. Keep or delete `<review-data-dir>` (open question 5).
3. `codeman-supervisor review status`: running or not, the sha, when it started.
4. Make `codeman-deploy` accept `review start|stop|status` so an agent can drive it the way it drives deploys.

The app side, the Reviews page and its **Open live** button that opens `https://<review-host>/`, is separate work and needs a setting that tells the app `<review-host>`.

## Login

The review instance has its own origin, so the browser holds a separate `codeman_session` cookie for it. It needs its own credentials.

Recommended: Access on `<review-host>` (step 1.3) is the outer gate, and the review instance gets its own `CODEMAN_PASSWORD`, kept in a root-owned file next to the app env file and read by the supervisor when it writes `review.env`. The browser saves it per origin, so Harry types it once.

Why not the live password: the review instance's own code can read its environment, and that code is the thing under review.

Why not no password: the review instance binds loopback, so Codeman cannot tell that the proxy and the tunnel make it public. Its own guard against running unauthenticated behind a tunnel (`CODEMAN_ALLOW_UNAUTHENTICATED_TUNNEL`) covers only tunnels Codeman starts itself. Access would be the only gate.

## Staying within the host's limits

The VM has 8 GiB of RAM and 4 GiB of swap. On 2026-11-16 at about 01:00, with the live colour idle, `free` showed about 2.2 GiB available and 2.1 GiB of swap in use, and the live colour's resident memory was about 230 MB. Two global out-of-memory events this month killed agent sessions.

- **One at a time.** One unit, so at most one instance. `review start` while one runs either refuses or replaces it.
- **Never during a deploy.** `review start` goes through the deploy queue, so a review build and a deploy build never run together. Both builds then fall under the supervisor service's existing memory cap.
- **Its own cap.** `MemoryMax` on the review unit. Set it from a measurement, for example the peak of one review session with the canvas open. Without that, 1 GiB is a guess.
- **Stopped when decided or idle.** The Reviews page calls `review stop` on approve or reject. `RuntimeMaxSec` stops it if nobody does.
- **Disk.** The root disk was 88% full on 2026-11-16. A release here is about 200 MB; one of the three kept on 2026-11-16 was 1.2 GB. The review build lives in its own directory, never counts toward `limits.releasesKept`, and is deleted on stop.

## Collisions with blue and green

| Resource | Blue and green | Review instance |
| --- | --- | --- |
| Port | `config.colours.*.port` and the stable listener | `<review-port>`, which `review start` refuses if it equals any of them. |
| Data directory | The shared data dir in `colourEnv` | `<review-data-dir>`, under another user's home. |
| tmux socket | `codeman` in `/tmp/tmux-<app uid>` | `codeman-review` in the unit's private `/tmp`, under another uid. |
| Releases | `releasesDir`, pruned to `releasesKept` | `<review-releases-dir>`, one build. |
| Proxy | The upstream file the supervisor rewrites on each switch | A static site block. A switch never touches it. |
| Unit | One unit per colour | `<review-unit>`. |
| Tags and push | `good/<timestamp>`, `push.branch` | None. |

## Open questions for Harry

1. **The hostname.** What should `<review-host>` be? Can you add its DNS record, tunnel ingress rule and Access application, or should those steps go to the host-side session?
2. **Replace or refuse.** When a review is running and another branch is opened, should `review start` replace it or refuse?
3. **Role.** Should the review instance run as the default role in its own data dir, so it behaves like a fresh install, or as `candidate` so it never runs automations?
4. **Agents inside the review instance.** Should agents run there at all? With no Claude Code login for `<review-user>` they cannot, which is the safe default but means features that start an agent cannot be exercised during a review.
5. **Data.** Should each review start from an empty data dir, or from a copy of the live data dir with secrets removed? A copy shows real canvases and sessions but costs disk and needs a list of what to strip.
6. **Memory cap.** What `MemoryMax` do you want, given the measurements above? Should the review refuse to start when available memory is below some floor?
7. **Idle ceiling.** Is four hours right for `RuntimeMaxSec`?
8. **Who builds.** Should the review build run `deploy/test.sh` too, or build only? This proposal says build only, because the review is for looking at the branch and a red test is visible in the walkthrough.
9. **Supervisor layout.** This proposal assumes the review commands live in the supervisor's private repository next to the deploy commands, and that the private `/tmp` and second user suit your threat model. If the supervisor has constraints this repository cannot show, say which.
