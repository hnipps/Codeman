# Intent: A dead session no longer blocks a deploy

**Status:** Draft

## Problem statement

Every deploy on 2026-11-19 after 15:01 failed at health. The tmux server had restarted at 06:41, and the 22 sessions it was running were gone. The live colour still listed all 22 as idle, because a session whose PTY exits is marked detached, not removed. The supervisor passes the live colour's session ids to `deploy/healthcheck.mjs` as `--expect-sessions`. The new colour found no tmux session for those 22, dropped them as it should, and the health check reported them missing on every attempt until the 90 s timeout. Nothing in the deployed commits caused it: `1351bae8` added two files under `intent/`. This is the second time a tmux server loss has blocked deploys.

## Proposed outcome

The session check still exists to catch a new colour that loses a session the live colour holds. It now excuses an expected session the new colour does not list only when that session is provably gone:

- the live colour's `mux-sessions.json` (in `CODEMAN_DATA_DIR`) has a record for the id that names a tmux session, and
- that tmux session is not on `CODEMAN_TMUX_SOCKET` (or no tmux server runs there).

Any doubt fails closed: no record for the id, an unset variable, a record file that does not parse, or any tmux error other than "no server". The passing detail names every excused id, so the deploy log shows what was excused.

### Model and differential testing (asked for by Harry, 2026-11-19)

The decision lives in its own pure module, `deploy/session-survival.mjs` (`decideSessions`), and `deploy/healthcheck.mjs` keeps only the I/O. `deploy/model/SessionSurvival.dfy` models it and proves five properties (S1 to S5, listed in `deploy/model/README.md`): a pass means listed or provably dead, a running session that goes missing always fails, any doubt is the old check, every old pass still passes, and the report is exact. Planting either of two bugs in the model breaks a proof.

`test/session-survival.drt.test.ts` compares the shipped code with a Python build of the model (`deploy/model/oracle/`) on random inputs. Tier 1 runs `decideSessions` on 5000 abstract cases. Tier 2 runs the real script on 120 scenarios with a real record file (valid, malformed, absent), a real tmux server on a throwaway socket, no server, or no tmux binary. Four bugs planted in the module were each caught. The test is in the deploy gate (`deploy/test.sh`).

## Affected users and systems

Harry's deploys through the supervisor. Agents that ship through Approve on the Reviews page. The supervisor itself is unchanged: it already runs the health check as the app user with `CODEMAN_DATA_DIR` and `CODEMAN_TMUX_SOCKET` set.

## Constraints

- `docs/self-building.md` rule 7: the check may change only to check more or to follow the app. Harry asked for this change on 2026-11-19. The check stays as strict for every session that still has a tmux session.
- The supervisor cannot be changed from this repo (rule 11), so the fix lives in the release's own `deploy/healthcheck.mjs`.
- tmux is called with an argv array, never a shell, and record names are checked against `^[A-Za-z0-9._-]+$`.

## Open questions

- Residual risk: a new colour that KILLED a live tmux session would also pass, since the check runs after the new colour starts and cannot tell when the session died. Candidates are barred from acting on panes (rule 6, `deployRole`), so this relies on that guard.
- CI has no Dafny, so nothing re-verifies the model or checks `oracle/` for drift automatically. `deploy/model/build-oracle.sh --check` does both where Dafny is installed. The DRT itself runs everywhere with python3 (tier 2 also needs tmux).
- The root of the stale list is in the app: the live colour never notices that its tmux server died and keeps listing dead sessions as idle tabs. A follow-up should mark or drop them at runtime (the `sessionDied` path the boot reconcile already uses).
