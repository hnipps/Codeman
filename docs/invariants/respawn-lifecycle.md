# Respawn lifecycle

Status: Draft

A user's "respawn off" is desired state. It must survive a server restart, a recover and a deploy. The code is `stopRespawnForSession` in `src/web/respawn-event-wiring.ts`, which `POST /api/sessions/:id/respawn/stop` and the Ralph loop disable both call.

## RL-1: Stop is absorbing across restart

After a stop, `state.json` has `respawnEnabled: false` and no `respawnConfig`, and `mux-sessions.json` has no respawn config, so boot restore never restarts the controller. The stop works with no controller in the map, and it cancels a restore start that is still waiting out the grace period. A break keeps burning usage on a session the user turned off.

Tests: `test/respawn-lifecycle.test.ts` (`// Invariant RL-1`), `test/routes/respawn-routes.test.ts`.

## RL-2: At most one controller per session per process

`restoreRespawnController` stops and replaces any existing controller, timer and pending start for that session. A second live controller types into the same pane.

Test: `test/respawn-lifecycle.test.ts` (`// Invariant RL-2`).

## RL-3: Loop off implies the respawn it started is off

A respawn started by `POST /api/ralph-loop/start` with `enableRespawn` carries `startedByLoop` in its persisted config. Disabling the loop through `ralph-config` `enabled:false` runs the same stop path. A respawn the user started themselves is left alone.

Tests: `test/routes/ralph-routes.test.ts`, `test/respawn-lifecycle.test.ts` (`// Invariant RL-3`).
