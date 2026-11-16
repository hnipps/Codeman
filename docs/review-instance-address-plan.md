# Review previews on throwaway VMs: proposal

**Status:** Proposal for Harry, revised 2026-11-16 after his answers to the first version. Nothing in it has been applied. `docs/self-building.md` rule 11 says changes to the supervisor, the proxy or the deploy design are proposed in writing; this is that proposal.

The first version proposed one review instance inside the Codeman VM, run as a second OS user on one fixed hostname. Harry asked for a throwaway VM per preview, outside the Codeman VM, each on its own generated hostname. This version describes that design. The section "What changed from the first version" lists the differences.

## The need

The planned Reviews page lets Harry review a finished branch inside Codeman. When the branch is a branch of Codeman itself, an **Open live** button opens that branch's running instance in a new browser tab.

That tab runs unreviewed code. In the browser it must not share the live app's login cookie, its stored settings (`localStorage`, IndexedDB) or its service worker, which are all keyed by web origin. On the server it must not be able to read the live data directory, the live login, the live tmux socket or the deploy queue. It is never embedded in a frame.

## Decisions Harry has made

| Topic | Decision |
| --- | --- |
| Where it runs | A throwaway VM per preview, on the machine that hosts the Codeman VM, outside the Codeman VM. |
| Address | A hostname generated for each preview. |
| Role | The default role, so the instance behaves like a fresh install. |
| Agents inside | Allowed, against a simulated Claude. No real Claude login on a preview VM. |
| Data | Test data. An agent may change it to set up the scenario its work needs. |
| Running | Only while the review is in use: start when the review page opens, stop after five minutes without interaction, stop one minute after the page is closed or backgrounded. |
| Capacity | A cap on running preview VMs, set from measurements on the host (see "Measured on the host"). |
| Build | Build only. `deploy/test.sh` does not run for a preview. |
| Maximum age | An undecided preview's disk is deleted after three days. |
| Other projects | A dev server for a project other than Codeman stays on the existing preview servers inside the Codeman VM. Preview VMs are for Codeman branches only. |
| Sign-in | The edge access application is the only sign-in. The broker verifies its signed token on every request. |
| Broker channel | The host drives it. The Codeman VM stays unable to reach the host. |
| Supervisor constraints | None known. |

## Placeholders

The repository is public, so this document names no host, address, port, user or server path. Harry or the host-side session fills these in privately.

| Placeholder | Meaning |
| --- | --- |
| `<live-host>` | The public hostname of the live app. |
| `<zone>` | The DNS zone the live hostname sits in. |
| `<preview-prefix>` | The fixed start of every preview hostname. |
| `<preview-host>` | One preview's hostname, `<preview-prefix>-<id>.<zone>`. |
| `<tunnel>` | The tunnel that carries `<live-host>` to the host machine. |
| `<broker>` | The new host-side service that creates, routes to and destroys preview VMs. |
| `<preview-net>` | A host-only virtual network that preview VMs attach to. |
| `<base-image>` | The prepared disk image every preview VM starts from. |

## Design

### One host-side service owns preview VMs

`<broker>` runs on the host machine, outside every VM. It is the only thing that creates or destroys a preview VM, and it is also the proxy that preview hostnames reach. It does four things:

- **Create.** Given a commit as a `git archive` export and an optional scenario (see "Test data"), it clones `<base-image>` as a copy-on-write disk, boots a VM on `<preview-net>`, and runs `deploy/build.sh` inside it. It returns the preview's id and hostname.
- **Route.** It answers every `<preview-host>` request by looking up the id and passing the request to that VM. An unknown id gets 404.
- **Stop and start.** It runs a VM only while the review is in use (see "When a preview VM runs"). A stop suspends the VM to disk, so a start resumes it with its sessions intact and without building again. While it resumes, the broker answers with a small "starting" page that reloads itself.
- **Destroy.** It deletes the VM and its disk when the review is approved, when a newer commit replaces the reviewed one, and after three days if neither happens. A deleted preview can be built again from its commit and scenario.

The broker enforces the limits itself, so nothing the Codeman VM sends can exceed them: a maximum number of running preview VMs, a fixed memory and disk size per VM, a longest single run, and the maximum age. The numbers come from measuring a preview VM on the host.

### Measured on the host

A host-side session built `master` in a test VM on 2026-11-16 and measured it. Its full report stays on the host.

| Item | Result |
| --- | --- |
| Smallest memory at which the build passes | 2 GiB (peak use about 1.3 GiB) |
| Build time from a clean export | About 71 s. More memory or CPUs barely changed it. |
| Memory when running with four shell sessions | About 0.45 GiB in the guest |
| Create a VM from the base image | Under 1 s after the first |
| Cold start to the app answering | 16 to 17 s. Sessions are lost. |
| Suspend to disk | About 8 s |
| Resume to the app answering | About 6 s. Sessions are kept. |
| Disk per stopped preview | About 3 GiB, plus up to 2 GiB of saved state |
| Effect of a build on the Codeman VM | None measurable |

Limits that follow:

- Each preview VM gets 2 GiB of memory, 2 CPUs and a 20 GiB thin disk.
- At most 3 preview VMs run at once. Four fit by arithmetic, but the host already uses swap.
- A stop is a suspend to disk. A six-second resume suits a VM that stops one minute after the page goes to the background; a seventeen-second cold start that drops every session does not.
- On this hypervisor a VM that has been resumed does not answer an ordinary shutdown request. The broker stops such a VM by suspending it again, or by force when its disk is about to be deleted.
- A suspended preview that has slept for a day gives up its saved state and starts cold next time. This recovers disk.
- Previews get their own storage pool. The pool that holds the Codeman VM's disk is nearly full, and filling it would stall the Codeman VM.

### When a preview VM runs

A stopped VM uses disk but no memory. The rules below keep a VM running only while Harry is looking at its review.

| Event | Result |
| --- | --- |
| An agent submits a review | Build once, capture the stills the walkthrough links to, then stop. Builds run one at a time. |
| Harry opens the review page | Start. |
| Five minutes with no interaction on the review page or in the **Open live** tab | Stop. |
| The review page and the **Open live** tab are both closed or in the background | Stop after one minute. |
| Harry switches to another review in the queue | The first review counts as closed. |
| The browser stops reporting (sleep, lost connection) | Counts as closed. |
| The cap is reached and Harry opens another review | Stop the running VM that was used longest ago, then start the new one. |
| Harry requests changes | Stop. The disk is kept until the new commit arrives. |
| The host restarts | Every VM is stopped. Disks are kept. |

The **Open live** tab counts as use of the review. Without that rule, working in the live tab would put the review page in the background and stop the VM under it.

The review page and the broker's own view of the **Open live** tab report use. The preview's code is not trusted to report it. A preview page keeps a stream open to its server for as long as it is loaded, so an open connection does not count as use; a request that a person caused does. Code under review could fake such requests, which the longest single run bounds.

### Hostnames come from one wildcard

Nothing is created at the edge per preview. Three wildcard entries are set up once:

1. One wildcard DNS record for `*.<zone>` that points at `<tunnel>`.
2. One wildcard ingress rule in `<tunnel>`'s config that sends `*.<zone>` to `<broker>`. The existing rule for `<live-host>` stays above it and is unchanged.
3. One edge access application that covers `<preview-prefix>-*.<zone>` with the same policy as the one in front of `<live-host>`.

Preview names are one level deep, so the zone's default edge certificate covers them. Each preview is its own origin, so its cookie and stored settings are separate from the live app's and from every other preview's.

The broker only routes names that start with `<preview-prefix>-` and match a preview it created. Every other name the wildcard catches gets 404.

Preview hostnames are the same *site* as `<live-host>`, so a preview page can send requests to the live app that carry the live cookie. Codeman already refuses those writes (`isAllowedRequestOrigin()` in `src/web/network-auth-policy.ts`) and grants CORS only to loopback origins (`registerSecurityHeaders()` in `src/web/middleware/auth.ts`). Two rules keep that true:

- The live `CODEMAN_ALLOWED_HOSTS` must never gain a suffix entry (`.<zone>`) that matches preview names.
- The live app must never add a CORS grant for a preview hostname.

### What a preview VM can reach

- `<preview-net>` gives a preview VM outbound internet access, which the build needs for `npm ci`.
- It has no route to the Codeman VM, to other preview VMs or to the host's local network.
- Only the broker can open a connection into a preview VM.

The host measurement found that the existing network rule in front of the Codeman VM does not separate two VMs attached to the same virtual network. So `<preview-net>` is a separate network, never the one the Codeman VM is on, and each preview VM is also isolated from the other VMs on it. The rule is enforced by the host. A firewall inside the preview VM does not count, because code with root in the guest could remove it.

The broker and its health checks never send a request without credentials to the live app. Every client behind the proxy shares one address, so a few such requests fill the live app's sign-in failure limit for everyone.

Building inside the preview VM is deliberate. A build runs the branch's install scripts, and those are unreviewed code too.

### How the app asks for a preview

The app never talks to the broker. The supervisor does, the same way it owns deploys:

| Command | What it does | Prints |
| --- | --- | --- |
| `codeman-deploy review create <sha> [--scenario <file>]` | Exports the commit, hands it to the broker, which builds it once and leaves the preview asleep. | `id`, `hostname` |
| `codeman-deploy review use <id>` | Says a reviewer is looking at this preview now. Wakes it if it is asleep and restarts its idle clock. | its state |
| `codeman-deploy review release <id>` | Says the reviewer has left. The preview goes to sleep a minute later, unless something uses it first. | its state |
| `codeman-deploy review destroy <id>` | Deletes the preview's VM and disk. | its state |
| `codeman-deploy review status [<id>]` | Lists every preview, or one: commit, hostname, state and last use. Changes nothing. | the list |

Harry left the command set to the agent on 2026-11-16, asking that each command have one job. The first draft had three (`start`, `stop`, `status`). Two things changed:

- **Two commands were added.** The rule that a preview runs only while its review is in use needs the app to say when a review page opens and when it closes. `use` and `release` are those two messages. Without them a preview could only wake on the first request to its own address and sleep after five idle minutes.
- **Two commands were renamed.** `start` built a preview and left it asleep, and `stop` deleted it, while a preview also stops and starts every time it sleeps and wakes. `create` and `destroy` say what happens.

The app runs the same commands through the supervisor program it already uses for deploys (`CODEMAN_SUPERVISOR_CLI`), as `review <command>`. It sends none of them unless the supervisor has set `CODEMAN_REVIEW_PREVIEWS=1` in the app's environment, so a supervisor without the commands is never asked.

Every command prints one line of JSON on standard output and errors on standard error. Exit codes match `codeman-deploy`: 0 done, 1 refused, 2 bad argument, 3 no answer in time. `use`, `release` and `destroy` can be repeated safely: a second call on a preview already in that state succeeds. An `<id>` the broker did not issue is exit 2 before any request is written.

The Codeman VM is deliberately blocked from opening any connection to the host, and that stays true. The host drives the channel: the supervisor writes each request into a directory in the Codeman VM that only the supervisor can write, and the broker reads requests from it and writes its answers back. The broker accepts only those five requests and treats what it reads as untrusted input. The app user and the agents cannot write a request, and no network rule changes. Creating a preview does not go through the deploy queue, because nothing is built on the Codeman VM.

### The preview's environment

The broker starts Codeman in the VM with a fixed environment and nothing copied from the live deployment:

| Variable | Value |
| --- | --- |
| `CODEMAN_ALLOWED_HOSTS` | The preview's own hostname. |
| `CODEMAN_BUILD_ID` | The reviewed commit. |
| `CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK` | `1`. The preview has no password of its own (see "Login"), and it listens on `<preview-net>` so the broker can reach it. |

No deploy role is set, so it runs as `live` in its own data directory (`parseStartRole()` in `src/deploy-role.ts`). No supervisor variables are set, so its Deploys section stays hidden.

### Login

The edge access application is the only sign-in. It attaches a signed token to every request it lets through. The broker verifies that token's signature, audience and expiry on every request and refuses a request without a valid one. If the access application is ever misconfigured, previews are refused, not exposed.

The preview's Codeman has no password. Only the broker can connect to it, so the broker's check is the gate. This keeps the check out of the code under review, and no live credential or new sign-in code is needed. **Open live** is a plain link to `<preview-host>`.

### Simulated Claude

Agents run inside a preview, but never against the real service. `<base-image>` carries a stand-in `claude` executable on the `PATH` that draws a scripted session in the terminal and makes no network request. No Claude Code login and no API key exist on a preview VM, so `docs/self-building.md` rule 10 holds there by construction.

The stand-in is `deploy/preview/bin/claude`, described in `deploy/preview/README.md`. It covers start, a prompt, a working row, a reply, the idle state, the conversation file and the three hooks Codeman waits on, since those are what Codeman's own features read. It was run inside a throwaway Codeman: a claude session started on it, a prompt sent through the API came back as a `stop` signal and a last answer, and the session then read as idle. Tools, permission dialogs and resuming are not covered.

### Test data

A preview starts from a seed data set kept in the repository, so every preview shows the same sessions, cases and canvas unless told otherwise. An agent that needs a particular scenario submits a scenario file with its walkthrough. The broker applies it on top of the seed at create time. A scenario is stored with the review and is not merged with the branch.

## What Harry or the host-side session sets up

None of this can be done from inside the Codeman VM.

1. **Survey and measure the host.** Done on 2026-11-16; see "Measured on the host".
2. **Build `<base-image>`.** The same OS release as the Codeman VM, with Node, tmux, git, the C/C++ toolchain `npm ci` needs, and the stand-in `claude`.
3. **Create `<preview-net>`** with the reachability rules above. The host firewall drops forwarded traffic by default, so a new network also needs rules for address assignment, name lookup and the route out.
4. **Create a storage pool for previews**, separate from the Codeman VM's.
5. **Install `<broker>`** as a host service with its limits and the access application's verification keys.
6. **Add the three wildcard entries** at the edge and in the tunnel config. Changing the tunnel config restarts the tunnel, which interrupts `<live-host>` briefly.
7. **Create the request directory** in the Codeman VM, writable only by the supervisor, and add the three `review` commands to the supervisor.

## What changed from the first version

| First version | This version |
| --- | --- |
| One instance inside the Codeman VM | One VM per preview, outside it |
| A second OS user for server-side isolation | A separate machine; no second user needed |
| One fixed sibling hostname | A generated hostname per preview from one wildcard |
| A memory cap inside the 8 GiB VM | The preview VM's own size, set on the host |
| Replace or refuse a second review | Several at once, up to the broker's limit |
| A static site in the VM's reverse proxy | The broker routes; the VM's proxy is untouched |
| A four-hour ceiling | Runs only while the review is in use |
| No agents inside | Agents inside, against a simulated Claude |
| Built on the Codeman VM through the deploy queue | Built inside the preview VM |
