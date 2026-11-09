# Agentic Canvas vision

Nov 2, 2026 · @Harry Nicholls

This is a vision document, not a specification. It describes the long-term product. The [minimal version PRD](minimal-version-prd.md) defines what is being built now, and it governs wherever the two disagree. Decisions made after this document was written are listed in the next section, and they override anything below that conflicts with them.

## Decisions made since

- The base is a fork of Codeman, which runs the unmodified Claude Code CLI in tmux. The app does not wrap agents through ACP, and Codex is deferred.
- The whole system runs in a single VM on the home server, with snapshots taken from the host.
- Remote Control runs on the host, outside the VM, with full access, as the recovery channel.
- Deploys are blue-green, with both colours sharing one tmux socket. There is no automatic rollback after a switch.
- The supervisor is a small enforcement core. The build, test and health-check commands live in the fork, and the agent can change them.
- Data changes roll forward only. Every change stays readable by the previous release, and there are no reverse migrations.
- Two previous releases are kept on disk; older releases are rebuilt from git. Pushes to GitHub run in the background and never block a deploy.
- The fork is public and must contain nothing that identifies the server or its services.
- T3 Code and Happy are references for the interface, not bases for the code.
- The canvas, worktrees, PR and CI records, operations and internal tools all come after the minimal version. The phases and "version 1" described below predate it.

## Summary

Agentic Canvas is a self-hosted workspace where one person and their coding agents design, build, ship and operate software from a single infinite canvas. Every object on the canvas, every app record and every log line is addressable and readable by agents. The app is a harness around existing agents such as Claude Code and Codex, which run in remote sandboxes on a home server under the user's own subscriptions.

The same workspace builds both public products and internal tools, and the app itself is built from inside the app once the core loop works. "Agentic Canvas" is a working name.

## Problem and context

A product's context is spread across separate tools today. Design explorations sit in a design tool, specs in documents, code in a repository, PRs and CI in GitHub, deploys in a hosting dashboard, and errors in Sentry or Datadog.

Coding agents see only the slice they are handed. A Claude Code session reads the repository and whatever is pasted into it, but not the mood board, the comment thread that motivated the change, or the production error that a user hit.

The user also builds internal tools to run this work, such as a UI pattern library, a latency harness and a delivery dashboard. These are usually separate projects with their own hosting, and agents cannot see or change them from the same place as the product.

## Goals and non-goals

### Goals

1. Hold a product's full context, from first exploration to production, in one workspace that agents can read.
2. Let the user direct agents from any object: a section, a document, an element in a live preview, a PR or a production error.
3. Run agents remotely so the workspace works from any device, including a phone, with only a thin client locally.
4. Use the user's existing Claude and OpenAI subscriptions within each provider's terms.
5. Let several agents work in parallel on independent branches, with their state visible in the UI.
6. Let agents change any part of the app, including internal tools and the app itself, with tested releases and rollback.
7. Never lose code, design or canvas data because of an agent's change.

### Non-goals

- Replacing git or GitHub. The app mirrors and acts on them.
- Replacing CI, error tracking or APM. The app reads from them and shows their records.
- Writing its own agent loop to replace Claude Code or Codex.
- Multiplayer in the first version. The data model should not rule it out.
- Full-featured canvas editing on mobile in the first version.

## Users

The first and only user in version 1 is Harry, working alone. He holds every role: designer, engineer, reviewer and operator. He uses the app from a laptop browser at home and from a phone while away.

Multiplayer is the longer-term aim. When it arrives, each collaborator signs in to their own agent subscriptions inside their own sandboxes, and roles decide who can comment, merge, deploy or change the app. Version 1 records the author of every write, human or agent, so roles can be added later without migrating history.

## Core concepts and object model

Everything in the workspace is an object with a stable ID, a type, content, a parent container, a position where it has one, an author, and attached comments. Agents read and write objects through the app's MCP server. Screenshots supplement this model and never replace it.

| Object | What it holds | Where it lives | Source of truth |
| --- | --- | --- | --- |
| Workspace | One product or internal tool, its canvas and its repositories | App | App database |
| Canvas | The infinite surface for a workspace | App | Canvas operation log |
| Basic object | Image, text block, link, embedded website | Canvas | Canvas operation log |
| Container | Frame, sub-canvas or named section | Canvas | Canvas operation log |
| Document | A markdown file such as PRODUCT.md or DESIGN.md, editable with a rendered preview | Canvas | Git, at a named branch |
| Comment thread | Comments on any object, including a DOM element in a live embed | Canvas and app pages | App database |
| Live embed | A dev preview served from a sandbox, or a production URL | Canvas | The serving environment |
| Agent session | One running agent task, its transcript and its outputs | App, linked from the thread that started it | App database |
| Worktree | A branch and sandbox for one task, with status, diff and preview | App page, and on the canvas beside its section | Git and the sandbox |
| Record | PR, CI run, deployment or production error | App pages, embeddable on the canvas | GitHub, CI provider, Sentry or Datadog |
| Internal tool | A small app with data sources, placed on the canvas | Canvas and app pages | Git, plus the tool's own data store |
| Log entry | Server, client, UI-event and agent logs | App | App log store |

Explicit containment is the grouping agents rely on. Two objects belong together when they share a container. Proximity on the canvas is a weak hint at most, so tidying the layout does not change what an agent reads.

A request is scoped by its anchor. A comment on a section means the agent reads that section and its children first, and can search the rest of the workspace when it needs to.

## Primary user journey

The journey runs from a blank canvas to a production fix without leaving the app. Each step names the objects involved.

1. **Explore.** The user opens a blank canvas for a new social app. He imports images, adds text blocks and labels, pastes links that embed websites, comments on items, and groups them into frames. He puts all of it in a section titled "design exploration".
2. **Shape.** He comments on the section: "@Claude /impeccable shape the landing page". Claude reads every object in the section through the MCP server, including grouping, labels and URLs, and takes a screenshot of the section. It runs the shape flow in the comment thread.
3. **Specify.** Claude writes PRODUCT.md and DESIGN.md to the workspace repository and places them on the canvas as documents. The user edits them in place and previews the rendered markdown.
4. **Build.** In the canvas chat he asks Claude to craft the landing page. The app creates a worktree and sandbox, and Claude builds the page. When it has something to show, a live embed of the dev server appears on the canvas.
5. **Refine.** He comments on individual elements in the live embed. Claude receives each element's selector, DOM path, computed styles, text and source location, makes the changes, and the embed updates.
6. **Ship.** He asks Claude to commit, push and open a PR. The app shuts down the sandbox and removes the embed. The PR appears on the app's PR page.
7. **Review and merge.** He comments on the PR in the app and asks Claude to review it, fix issues and merge. The app shows the review, the fixes, the merge and the CI run as they happen.
8. **Deploy.** When CI passes and the deploy finishes, the app records the deployment and Claude embeds the production page on the canvas.
9. **Operate.** A new user hits an error in production. The error appears as a record in the app. The user sends Claude to investigate it, which starts a new worktree, and the journey continues from step 5.

## Capabilities

Each capability has an ID for reference and the phase it was planned for. These describe the long-term product and are not requirements for the current build.

| ID | Area | Requirement | Phase |
| --- | --- | --- | --- |
| C1 | Canvas | Infinite pan and zoom canvas per workspace, usable in a desktop browser | 1 |
| C2 | Canvas | Create images by upload or paste, text blocks, links with website embeds, frames, sub-canvases and named sections | 1 |
| C3 | Canvas | Move objects between containers; containment is stored explicitly, not inferred from position | 1 |
| C4 | Canvas | Server-rendered screenshot of any container on request, for agents and for thumbnails | 1 |
| C5 | Canvas | Read-only canvas viewing, comments and chat on mobile browsers | 1 |
| O1 | Object model | Every object has a stable ID, type, content, parent, position, author and comments | 1 |
| O2 | Object model | MCP server exposing read, search, create, update and delete for objects, scoped per session | 1 |
| O3 | Object model | Agents can read a container and all its descendants in one call, with grouping and labels preserved | 1 |
| T1 | Threads | Comment threads on any object, with @mentions that start an agent session | 2 |
| T2 | Threads | Canvas chat window per workspace that can start sessions without an anchor | 2 |
| T3 | Threads | Agent replies, questions and progress appear in the thread that started the session | 2 |
| A1 | Agents | Start Claude Code or Codex sessions in a remote sandbox from a thread or the chat | 2 |
| A2 | Agents | Pass each session its repository, instruction files, skills and canvas MCP access at start | 2 |
| A3 | Agents | Stream session transcripts to the app and keep them after the session ends | 2 |
| A4 | Agents | Stop, resume and restart a session from the UI | 2 |
| W1 | Worktrees | One branch and one sandbox per task, created automatically when a session needs to change code | 2 |
| W2 | Worktrees | Worktree page listing every worktree with agent, branch, task, status, diff against main and preview link | 2 |
| W3 | Worktrees | Worktree card on the canvas beside the section that started it | 2 |
| W4 | Worktrees | Shut down a worktree's sandbox and embed when its PR opens or the user closes it | 2 |
| D1 | Documents | Markdown documents on the canvas backed by a file in the workspace repository at a named branch | 3 |
| D2 | Documents | Edit a document in place with a rendered preview; saving commits to the branch | 3 |
| P1 | Preview | Live embed of a sandbox dev server on the canvas, served through the tunnel | 3 |
| P2 | Preview | Comment on any element in a live embed; the comment stores selector, DOM path, computed styles, text and a screenshot crop | 3 |
| P3 | Preview | Map a commented element to its component and source file and line where the framework allows | 3 |
| P4 | Preview | Embed refreshes after the agent's change without losing comment anchors where the element still exists | 3 |
| R1 | Records | Mirror PRs, reviews, CI runs and deployments from GitHub into app pages | 4 |
| R2 | Records | Comment on a PR in the app to start an agent session that can review, fix and merge | 4 |
| R3 | Records | Live CI and deploy status on the PR page and on the worktree card | 4 |
| R4 | Records | Embed a production URL on the canvas after a deploy | 4 |
| I1 | Internal tools | Create an internal tool as a workspace with its own repository, built with the same loop as a product | 4 |
| I2 | Internal tools | Host internal tools on the home server and place them on any canvas as live embeds | 4 |
| I3 | Internal tools | Give internal tools read access to app records and logs through a documented API | 4 |
| S1 | Self-hosting | The app's own code is a workspace in the app, changed through the same worktree and PR flow | 5 |
| E1 | Operations | Mirror production errors and latency alerts from Sentry or Datadog as records | 6 |
| E2 | Operations | Start an investigation session from an error record, with the error, trace and recent deploys attached | 6 |
| L1 | Logs | Structured server, client, UI-event and agent logs, queryable by agents through the MCP server | 1 |
| L2 | Logs | Redact secrets and tokens before log entries are stored | 1 |

## Architecture and deployment

*[Diagram not included in this copy: system architecture · client, tunnel, home server, external services.]*

The client holds no state beyond the open session, so any device with a browser and an Access login reaches the full workspace. The control plane starts one container per worktree and gives each session MCP access scoped to its workspace. Every preview gets its own hostname under the app's parent domain, behind the same Access policy, so embeds load from a phone without separate sign-in.

Nothing outside the server opens a connection in. Sandboxes reach model providers, package registries and GitHub; the control plane reads GitHub, Sentry and Datadog and writes backups off the server.

## Agent integration

The app talks to every agent through one internal adapter interface: start a session with a repository, instructions and MCP servers; send prompts; stream events; stop. Adding an agent means adding an adapter.

**Codex** connects through ACP using the [codex-acp adapter](https://www.sourcepulse.org/projects/21679199), signed in with the user's OpenAI subscription. OpenAI has [publicly endorsed](https://www.theregister.com/software/2026/02/20/anthropic-clarifies-ban-on-third-party-tool-access-to-claude/5014546) Codex subscriptions in third-party harnesses.

**Claude Code** runs as the unmodified binary in the sandbox, signed in with the user's own Claude subscription. Anthropic's [Legal and Compliance page](https://code.claude.com/docs/en/legal-and-compliance) allows an end user to sign in to the unmodified binary with their own subscription. It does not allow subscription OAuth tokens in other tools, and it names the Agent SDK specifically.

The Claude ACP adapter, claude-agent-acp, is built on the Agent SDK and needs a subscription OAuth token, so version 1 does not use it with a subscription. The Claude adapter drives the binary directly through its headless mode or a terminal session and presents the same interface as ACP to the rest of the app. If Anthropic confirms the ACP adapter is acceptable for personal self-hosted use, the app can switch to it without other changes.

The assets that shape agent behaviour live in a repository the app manages: instruction files, skills, slash commands and MCP tool definitions. Changes to them go through the same worktree, PR and rollback flow as code. Each session receives canvas MCP access scoped to the workspace and the container that started it.

Multiplayer is out of scope for this section. Anthropic does not allow routing requests through one user's subscription on behalf of others, so each collaborator will need their own sign-in in their own sandbox.

## Safety, rollback and data control

Agents may change any part of the app, but the running instance never edits itself. The app is split into two layers with different rules.

### The shell

The shell is the canvas engine, control plane, authentication, data store, MCP server and deploy pipeline. Agents change it only through a PR. Each shell PR deploys to a separate preview instance with a copy of recent data, runs end-to-end tests there, and is promoted to the main instance only after the tests pass and the user approves.

A recovery service runs separately from the shell on the same server. It changes rarely and is not editable from inside the app. It can roll the shell back to any of the last 10 releases and restore the database from the latest snapshot, even when the main app is down. It is reachable through its own Cloudflare Access application.

### User space

User space is everything built inside the app: product repositories, internal tools and canvas content. Agents change it more freely, because the shell provides history and rollback for it.

### Data protection

| Data | Protection |
| --- | --- |
| Code | Git hosted on GitHub; branch protection on main; no force pushes; agents merge only through PRs |
| Canvas content | CRDT operation log (Yjs or Automerge) with replayable history, hourly snapshots and soft delete |
| App database | Nightly backups off the server; migrations only through shell PRs |
| Internal tool data | Each tool's data store backed up nightly off the server; schema changes through PRs |
| Agent instructions and skills | Git, through the same PR flow as code |

Every write to the canvas carries the author, human or agent session. The user can revert everything one agent session did to the canvas without touching other changes made in the same period.

## Non-functional requirements

| Area | Requirement |
| --- | --- |
| Access | Reachable only through Cloudflare Zero Trust, with Access policies on the app, every preview hostname and the recovery service |
| Devices | Full use in current desktop Chrome, Safari and Firefox; read, comment, chat, review and approve on iOS and Android browsers |
| Previews | Each worktree preview on its own hostname under the app's parent domain, so embeds share the Access session |
| Sandbox isolation | One container per worktree with CPU and memory limits; no route to the home LAN; outbound access limited to package registries, GitHub and model providers |
| Secrets | Agent credentials stored on per-user sandbox volumes; never written to logs, canvas objects or transcripts |
| Concurrency | At least 4 agent sessions running in parallel on the home server without the canvas becoming unresponsive |
| Durability | No canvas operation acknowledged to the client is lost; recovery point for the database of 24 hours or better |
| Availability | Best effort, matching the home server's uptime; the recovery service starts on boot |
| Observability | All app components emit structured logs and traces to one store that agents can query |

## Phasing and milestones

Version 1 is built in six phases. Each ends at a gate that tests a slice of the primary journey, and no dates are set yet.

*[Diagram not included in this copy: phasing · 6 phases, each closed by a gate.]*

Phase 5 is where the app starts building itself, so the shell safety rules must be in place before any agent changes the shell.

## Success measures

Version 1 succeeds when the primary journey runs end to end for a real product, and when the app's own next feature is built from inside the app.

- The landing page journey, steps 1 to 8, completes without the user opening a terminal, an editor or GitHub.
- At least one production error is investigated and fixed through step 9.
- Three internal tools run inside the app: a UI lab, an API latency harness and a delivery dashboard covering the last 30 days.
- One shell change is built by an agent, tested on a preview instance, promoted, then rolled back and promoted again through the recovery service.
- No canvas, code or design data is lost across the first 3 months of daily use.

## Open questions

- [ ] Product name. "Agentic Canvas" is a placeholder.
- [ ] Canvas engine: build on an existing library such as tldraw, or write a custom renderer over the CRDT.
- [ ] Backend language and framework for the control plane, and whether the MCP server runs in the same process.
- [ ] Sandbox runtime on the home server: plain containers, Kubernetes, or microVMs such as Firecracker.
- [ ] Whether to ask Anthropic if claude-agent-acp with a personal subscription is acceptable for self-hosted use.
- [ ] Retention defaults proposed here and not yet agreed: hourly canvas snapshots, nightly off-box backups, 10 shell releases kept for rollback.
- [ ] Where off-box backups go: a cloud bucket, a second machine, or both.
- [ ] How element-to-source mapping works for frameworks other than React with source maps.
- [ ] Whether internal tools share one database server or each get their own.
- [ ] Which internal tool to build first.
