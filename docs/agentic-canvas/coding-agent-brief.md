# Coding agent brief: self-building workspace, minimal version

Nov 3, 2026 · @Harry Nicholls

## Purpose and which document governs

You are building the minimal version of a self-building workspace: a fork of Codeman in a VM on a home server, where Claude Code changes the fork's own source, deploys it and keeps its session through the restart. This brief tells you how to work. The minimal PRD tells you what to build.

The documents rank in this order. Where they disagree, the higher one wins.

1. This brief.
2. The [minimal version PRD](minimal-version-prd.md), which defines scope, requirements, the deploy design and the done criteria.
3. The [Claude subscription UI survey](README.md#not-included), background on why Codeman was chosen. Its earlier sections on T3 Code reflect a recommendation that was later reversed; T3 Code and Happy are interface references only.
4. The [Agentic Canvas vision](vision.md), which describes the long-term product and is not a specification. Nothing in it is in scope unless the minimal PRD includes it.

If something you need is not covered by any of them, ask rather than assume.

## Known facts, and facts to discover yourself

### Known

- The server runs Ubuntu Server 24.04 and already hosts other services.
- The whole system runs in a single VM on that server, which Harry creates. The host runs only the VM, its snapshots and cloudflared. You work inside the VM and never on the host.
- Harry will fork Codeman on GitHub and give you the repository URL. The fork starts from a release tag, not from main. At the time of writing, the newest release found was `codeman@1.43.0`; use the newest stable tag when the fork is made.
- Codeman follows semantic versioning. Its CLI commands and environment variables are a stable contract, including `CODEMAN_PORT`, `CODEMAN_INSTANCE`, `CODEMAN_DATA_DIR`, `CODEMAN_TMUX_SOCKET`, `CODEMAN_ALLOWED_HOSTS` and `CODEMAN_PASSWORD`. Its on-disk data format is not a contract, and its internal TypeScript modules have no supported library entry point.
- Claude Code runs inside the VM, signed in by Harry with his Claude subscription.
- Remote access will go through a Cloudflare Tunnel on the host with Cloudflare Access. Harry's existing Remote Control session runs on the host, outside the VM, as the recovery channel.

### Discover and report

Find these out inside the VM by reading the system, and report them in Phase 0. Do not change anything to find them.

- Installed versions of Node.js, npm, tmux, git and cloudflared, and whether Claude Code is on the PATH for the user you run as.
- Which ports are already in use, and which services own them.
- Existing system users, and whether a dedicated user for the fork exists.
- Disk layout and free space for release directories and backups.
- Whether a reverse proxy, such as Caddy or nginx, is already installed or configured.

## Phase 0: investigate and report back

Three questions can change the deploy design, so answer them before writing the supervisor. Work in a scratch directory and a throwaway Codeman instance with its own `CODEMAN_INSTANCE`, port and data directory, so the investigation cannot touch anything real.

1. **Two servers on one tmux socket.** Start two Codeman servers on different ports with the same `CODEMAN_DATA_DIR` and `CODEMAN_TMUX_SOCKET`, with a Claude Code session running. Record what each server sees, whether input from either reaches the session, and whether stopping one disturbs the session or the other server.
2. **The data directory.** List what Codeman writes to its data directory, which files each server writes to while both run, and whether any file changed format between recent releases, judging from the changelog and migration code.
3. **Stack and build.** Describe the stack, the size of the codebase, how the server and web UI are built, and whether a build produces a directory that can run on its own from a release path.

Also report the facts from the previous section.

Stop after Phase 0 and report. Do not start Phase 1 until Harry has read the report, because the answers may change the deploy design in the minimal PRD.

## Phase 1: build the deploy path

The first version cannot build itself, so you build it from an ordinary Claude Code session on the server, outside the app. Work in this order, since each step depends on the one before.

1. **Accounts and directories.** Inside the VM, create a user for the fork and Claude Code, with directories for releases, backups and logs. Harry signs this user in to Claude Code. During Phase 1 this user has passwordless sudo inside the VM; Harry removes it at the end of Phase 1.
2. **Telemetry.** Add structured server logs, client error reporting to the server, and request traces to the fork, written to files under the log directory (requirement F4).
3. **Supervisor.** Build the supervisor as a small enforcement core, run as a systemd service from a separate, root-owned repository, with three commands: deploy a commit, roll back to a release, and report status. It runs the build, test and health-check commands defined in the fork, so those stay editable by the agent. The core itself always enforces four rules: back up the data directory first, never switch to a version that failed its checks, keep the old version running until the switch, and keep past releases for rollback. It follows the blue-green design in the minimal PRD and writes every deploy to a log the fork's user can read (F6).
4. **Reverse proxy.** Install and configure the proxy inside the VM that sends traffic to the live colour. Only the supervisor may change its upstream.
5. **Cloudflare.** Prepare the cloudflared configuration that points the host's tunnel at the VM's proxy, with the steps for the tunnel and Access policy, and hand them to Harry. Harry applies them on the host.
6. **Instructions file.** Draft the fork's instructions file (F10), covering layout, build and deploy commands, telemetry locations, and the limits in this brief. Harry reviews it before it is committed.
7. **Snapshots.** Propose a snapshot schedule for the VM, for Harry to set up on the host.

### Settings, data changes and GitHub

- **Settings.** Put every number the deploy path uses in one config file, not in the code. Start with 2 previous releases kept on disk and backups from the last 2 deploys kept. Choose a starting value for anything else, such as the health-check timeout, and list every value in your Phase 0 and Phase 1 reports.
- **Data changes.** Follow the roll-forward rule in the minimal PRD. Every change to stored data must stay readable by the previous release, there are no reverse migrations, and rollback restores code only.
- **GitHub.** Push to GitHub in the background after every successful deploy. A failed push is retried later and must never block or delay a deploy. Rollback to older releases uses the local git history, so it never depends on GitHub.

### When work moves into the app

Work moves from the ordinary session into the fork's own Claude Code session once these four done criteria pass, with the rollback command tested from a shell: a UI change deploys and the session continues, a backend change deploys and the session continues, a broken build is rejected, and a failed health check is rejected. Before the move, Harry removes the agent user's sudo rights, so the supervisor's core and the proxy configuration can no longer be changed from inside the app. Until then, deploy only through the supervisor's command, and never by restarting the fork by hand.

## Hard limits and approvals

### Never

- Act on the host, or on anything outside the VM, including the host's other services and their files, ports and systemd units.
- Write to the supervisor repository or the proxy configuration from the fork's session after Phase 1. The fork's agent can run the supervisor's commands and propose changes to its core, which Harry applies.
- Turn on Codeman's respawn, auto-resume, Ralph loop or orchestrator features, or anything else that prompts Claude without a human message.
- Use an Anthropic API key, read or copy Claude Code's credentials, or route Claude requests through anything other than the Claude Code CLI.
- Change the Cloudflare Access policy or expose any port to the internet directly.
- Force-push, rewrite history on main, or delete release directories, backups or tags.

### The fork is public

The fork is a public GitHub repository. Nothing committed to it may identify Harry's server or the services on it.

- Never commit hostnames, IP addresses, port assignments, OS usernames, server-specific paths, Cloudflare account or tunnel identifiers, or the names of other services on the server.
- Keep those values in an environment file outside the repository, or in the supervisor repository, and commit only a template with placeholder values.
- Write the fork's instructions file in generic terms, so it describes the app and the deploy commands without describing the server.
- ~~Do not commit this brief, the minimal PRD, the vision doc or the survey to the fork, since they describe the server and its services.~~ Superseded on 2026-11-09: Harry chose to publish these documents, with the names of the server's other services removed. The rest of this list still applies.
- Keep the supervisor repository local or private unless Harry says otherwise.
- Before every push, check the diff for any of the above.

### Ask Harry first

- Using sudo for anything outside the Phase 1 steps.
- Any change to the deploy design in the minimal PRD, including the numbers listed there as unconfirmed defaults.
- Committing the fork's instructions file, and any later change to it.
- Merging upstream Codeman releases into the fork.
- Anything this brief and the minimal PRD do not cover.

## Tests for the done criteria

Write a repeatable script for each criterion that can be scripted, and keep the scripts in the supervisor repository so they can be rerun after any change to the deploy path.

| Done criterion | Test |
| --- | --- |
| UI change deploys, session continues | Scripted: commit a visible text change, deploy, assert the new text is served and the tmux session ID is unchanged |
| Backend change deploys, session continues | Scripted: commit a new health-endpoint field, deploy, assert it appears and the session ID is unchanged |
| Broken build rejected | Scripted: commit a syntax error, deploy, assert failure, unchanged live release and unchanged session |
| Failed health check rejected | Scripted: commit a change that makes the health endpoint fail, deploy, assert the same |
| Rollback from UI and shell | Scripted for the shell command; manual for the UI |
| Fix through Remote Control | Manual: Harry stops the fork and fixes it from the Claude app |
| Diagnosis from telemetry | Manual: Harry introduces a bug, and the agent finds it from the logs alone |

Every scripted test must leave the system on the release it started from.

## How to report back

Report at the end of Phase 0, at the end of each Phase 1 step, and whenever you stop to ask a question. Each report says what you did, what you found or changed, the commands Harry can run to check it, and anything you were unsure about.

State facts you observed separately from conclusions you drew. If a test failed, or something behaved differently from what the PRD expects, say so plainly, even if you worked around it.
