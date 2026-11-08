# Respawn lifecycle

Status: Draft

A user's "respawn off" is desired state. It must survive a server restart, a recover and a deploy. The code is `stopRespawnForSession` in `src/web/respawn-event-wiring.ts`, which `POST /api/sessions/:id/respawn/stop`, the Ralph loop disable, budget exhaustion and duration expiry all call.

The [respawn state machine](../respawn-state-machine.md) describes the cycle sequence,
idle detection and configuration. Its [cycle budget](../respawn-state-machine.md#cycle-budget)
is the mechanism for RL-4 and RL-5 below; these promises complement that operational guide.

## RL-1: Stop is absorbing across restart

After a stop, `state.json` has `respawnEnabled: false` and no `respawnConfig`, and `mux-sessions.json` has no respawn config, so boot restore never restarts the controller. The stop works with no controller in the map, and it cancels a restore start that is still waiting out the grace period. A break keeps burning usage on a session the user turned off.

Tests: `test/respawn-lifecycle.test.ts` (`// Invariant RL-1`), `test/routes/respawn-routes.test.ts`.

## RL-2: At most one controller per session per process

`restoreRespawnController` stops and replaces any existing controller, timer and pending start for that session. A second live controller types into the same pane.

Test: `test/respawn-lifecycle.test.ts` (`// Invariant RL-2`).

## RL-3: Loop off implies the respawn it started is off

A respawn started by `POST /api/ralph-loop/start` with `enableRespawn` carries `startedByLoop` in its persisted config. Disabling the loop through `ralph-config` `enabled:false` runs the same stop path. A respawn the user started themselves is left alone.

Tests: `test/routes/ralph-routes.test.ts`, `test/respawn-lifecycle.test.ts` (`// Invariant RL-3`).

## RL-4: Unchanged workspaces stop within their cycle budget

For a positive `maxUnchangedCycles` (default `3`), a loop stops after that many
consecutive completed cycles whose workspace fingerprint equals the preceding one,
including the baseline at start. Git workspaces use HEAD, status and diff; non-git
workspaces use bounded path/content hashing. Dot-directories, `node_modules`, symlinks
and files over 1 MB are skipped; traversal stops at 5000 files or directories.
Unchanged means unchanged within that sample, not proof that no work exists.
Unreadable workspaces do not count as unchanged. `0` disables the check.

Failure condition: readable unchanged workspaces, git or not, keep cycling past the
configured unchanged budget.

Tests: `test/respawn-cycle-budget.test.ts` (`// Invariant RL-4`), including a temporary
non-git workspace, content changes, exclusions and the traversal cap.

## RL-5: No loop exceeds its total cycle budget

A positive `maxCycles` (default `50`) stops the controller even if update prompts
and `/init` change files every cycle. The limit is checked after completion and before
starting another cycle, so a pending fingerprint check cannot permit cycle 51.
`0` explicitly means unlimited. Automatic stops persist disabled desired state and
broadcast their reason through the same stop path as a user stop.

Failure condition: a loop starts more cycles than its positive `maxCycles`, or
budget exhaustion leaves an enabled persisted configuration.

Tests: `test/respawn-cycle-budget.test.ts` (`// Invariant RL-5`),
`test/respawn-lifecycle.test.ts`, `test/routes/respawn-routes.test.ts`.

## RL-6: At most one process holds the live lease per data directory

A live-by-default start, promotion or reinstatement must acquire the data directory's
`deploy-lease.json` before becoming a writer. An existing live holder is refused,
stale holders can be replaced, and only the holder releases on retire or stop.
Candidates hold no lease. See [instance isolation and leases](../architecture-invariants.md#network-binding-and-instance-isolation).

Failure condition: a second process starts or promotes as live while an existing
live process holds that data directory's lease.

Tests: `test/deploy-lease.test.ts` (`// Invariant RL-6`), covering startup refusal,
promotion, stale holders and handover. These tests cover an already-established
holder, not simultaneous first acquisition. The current read-then-rename acquisition
is not atomic across processes; concurrent acquisition remains a gap in this draft
promise. Separate data directories on the same tmux socket and older servers without
a lease are also outside its protection.
