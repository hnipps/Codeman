# Self-building workspace: minimal version PRD

Nov 3, 2026 · @Harry Nicholls

## Summary

The minimal version is a fork of Codeman in a VM on the home server, where Claude Code, signed in with the user's Claude subscription, changes the fork's own source, rebuilds it and restarts it without losing its session. It must prove one thing: that the app can build itself safely, with every bad change caught or rolled back.

It has a chat with Claude Code, agent access to the app's telemetry, a supervised deploy with health checks and rollback, and Remote Control as a way in when the app is down. Everything else in the [Agentic Canvas vision](vision.md) is deferred until this loop works.

## Scope

### In scope

- A single VM on the home server that holds the whole system, with snapshots taken from the host.
- A fork of Codeman, which is the app being built and the interface to the agent.
- Claude Code sessions in tmux, signed in with the user's Claude subscription.
- Telemetry the agent can read: server logs, client errors sent to the server, and build and deploy output.
- A supervisor that builds, starts, health-checks, switches and rolls back the app.
- Backups of the app's data before every deploy.
- An instructions file that tells the agent the repository layout, build and deploy commands, and where telemetry lives.
- Cloudflare Access in front of the app from the first day.
- Remote Control on the host, outside the VM, as a recovery channel.

### Deferred

- The infinite canvas and the object model.
- An MCP server for agents to spawn other agents, modelled on T3 Code's.
- A thread, diff and PR interface, modelled on T3 Code.
- Native mobile apps, modelled on Happy.
- Worktrees and parallel agents.
- GitHub PR, CI and deployment records.
- Codex and other providers.
- Production error tracking and internal tools.

## Components

Each component sits in one of two places: inside the repository the agent edits, or outside it where the agent cannot change it.

| Component | Where it runs | Role | Agent can change it |
| --- | --- | --- | --- |
| Codeman fork | VM | Web UI, session management, telemetry endpoint; the app being built | Yes, through the deploy flow |
| Build, test and health-check commands | VM, in the fork | Define how a release is built and what counts as working | Yes, through the deploy flow |
| Claude Code in tmux | VM, as an unprivileged user | The agent; runs in its own tmux session and survives restarts of the app | No; installed and signed in by the user |
| Instructions file | VM, in the fork | Repository layout, commands, telemetry locations, rules for the agent | Yes, through the deploy flow |
| Supervisor core | VM, owned by root | Enforces backup, checks before switch, and kept releases; runs the fork's commands | No; the agent proposes changes and the user applies them |
| Reverse proxy | VM | Routes traffic to the live colour | No; only the supervisor changes its upstream |
| VM and snapshots | Host | Isolates the system from the host; snapshots allow a full restore | No |
| Cloudflare Tunnel and Access | Host | Remote access and sign-in | No |
| Remote Control | Host, under the user's account | Recovery channel with full access; can restart the VM or restore a snapshot | No |

## Self-modification loop

Every change the agent makes goes through the same deploy path, with two checks before it goes live.

*[Diagram not included in this copy: self-modification loop · 3 checks, 3 safe failure paths.]*

A failure at any check leaves the live app running the last good release, and the agent reads the outcome from the deploy log.

## Functional requirements

| ID | Requirement |
| --- | --- |
| F1 | The user chats with a Claude Code session in the fork's web UI from a desktop or phone browser. |
| F2 | Claude Code runs as the unmodified CLI in a tmux session, signed in with the user's Claude subscription. |
| F3 | The session's working directory is a clone of the fork's repository, and the agent can edit any file in it. |
| F4 | The app writes structured server logs, client errors and request traces to files the agent can read and search. |
| F5 | The agent starts a deploy with one command, which hands the commit to the supervisor and returns its result. |
| F6 | Every deploy writes its build output, health-check result and outcome to a log the agent can read. |
| F7 | The agent's tmux session and transcript continue unchanged across every deploy, successful or not. |
| F8 | The web UI reconnects and reloads automatically when a new build goes live. |
| F9 | The user can roll back to either of the 2 previous releases kept on disk, or to any older commit rebuilt from git, from the UI and from a shell command when the UI is down. Rollback restores code only. |
| F10 | The repository contains an instructions file covering layout, commands, telemetry and deploy rules. |
| F11 | Every number the deploy path uses, such as releases kept, backups kept and the health-check timeout, is read from one config file rather than written into the code. |
| F12 | Successful deploys are pushed to GitHub in the background. A failed push is retried later and never blocks or delays a deploy. |

## Deploy and rollback design

Deploys are blue-green, and no agent ever restarts the server it is talking through. The two colours are two Codeman server processes on different ports. They share one data directory and one tmux socket, so each new colour attaches to the agent sessions that are already running.

1. The agent commits its change and runs the deploy command with the commit hash.
2. The supervisor copies the data directory to a timestamped backup.
3. The supervisor runs the fork's build and test commands for the commit in its own release directory. If the build fails, it stops here and reports the build output.
4. It starts the release as the idle colour on its own port, pointed at the shared data directory and tmux socket.
5. It runs the health check: the HTTP health endpoint responds, the server lists the running sessions, and a WebSocket connects. Failure stops the new colour and leaves the live one untouched.
6. On a pass, it switches the reverse proxy to the new colour, stops the old colour, and tags the commit as the latest good release.

There is no automatic rollback after the switch. If a release misbehaves once live, the user or the agent rolls back with the rollback command.

Two rules follow from the shared data directory. Data changes follow a roll-forward rule. Every change to stored data must stay readable by the previous release, and there are no reverse migrations. A rollback restores code only and leaves data as it is; any repair to data is made by a new forward change. And the overlap between colours must be as short as possible, because Codeman's documentation warns that two servers on the same socket both attach to live sessions.

The supervisor is a small enforcement core. The build, test and health-check commands it runs are defined in the fork, so the agent can change them like any other code. The core always enforces four rules: back up first, never switch to a version that failed its checks, keep the old version running until the switch, and keep past releases for rollback. The core and the proxy configuration sit outside the fork, the agent loses admin rights in the VM after setup, and changes to the core are proposed by the agent and applied by the user. Because the agent defines the health check, it could make the check too easy to pass; manual rollback and Remote Control are the backstop for that.

## Data protection

| Data | Protection |
| --- | --- |
| Fork source | Git in the VM with full history; pushed to GitHub in the background after every successful deploy; main is protected from force pushes |
| Release builds | The 2 previous releases are kept on disk; older releases are rebuilt from the local git history, so rollback never depends on GitHub |
| Codeman data directory | Copied before every deploy, keeping the copies from the last 2 deploys; nightly copy off the server |
| Claude Code transcripts | Stay on disk in the VM user's Claude Code directory; included in the nightly copy |
| Supervisor and proxy configuration | Kept in a separate repository the agent has no write access to |
| The whole VM | Snapshots taken from the host on a schedule |

## Access, security and subscription constraints

The app gives whoever reaches it a shell inside the VM, because Codeman starts agents with permission prompts skipped. Access is therefore locked down before anything else.

- **Access.** The app is reachable only through a Cloudflare Tunnel with an Access policy that admits the user alone. Codeman's own password stays on as a second layer, and its host allowlist names the public hostname.
- **Isolation.** The whole system runs in a VM. Inside it, Claude Code runs as an unprivileged user and the supervisor core is owned by root. The agent has admin rights in the VM only during setup. Nothing in the VM can reach the host or the host's other services.
- **Subscription use.** Claude Code runs interactively in tmux under the user's own login, which draws on the plan's usage limits. Codeman's respawn, auto-resume, Ralph loop and orchestrator features stay off, so every agent turn starts from a human message.
- **Recovery.** Remote Control runs on the host under the user's own account, outside the VM, with full access. It can restart the VM, open its console or restore a snapshot, and it does not depend on anything inside the VM.

## Done criteria

The minimal version is done when each of these has happened once, started from a phone.

- [ ] The agent makes a visible UI change, deploys it, and the session carries on in the new build.
- [ ] The agent makes a backend change, deploys it, and the session carries on in the new build.
- [ ] A change that breaks the build is rejected, and the live app is untouched.
- [ ] A change that fails the health check is rejected, and the live app is untouched.
- [ ] The user rolls back a release from the UI and from a shell command.
- [ ] With the fork stopped, the user fixes it through Remote Control.
- [ ] The agent diagnoses a deliberately introduced bug from the telemetry alone.

## Open questions

- [ ] What happens when two Codeman servers attach to the same tmux socket during a switch, and how short the overlap must be.
- [ ] Which data files Codeman keeps in its data directory, and whether any change format between releases.
- [ ] Codeman's stack and code size, and whether its build produces a self-contained release directory.
- [ ] Defaults proposed here and not yet agreed: the health-check timeout.
- [ ] Which reverse proxy to use for the colour switch: Caddy, nginx, or cloudflared ingress rules.
- [ ] Where the nightly off-server copy goes.
