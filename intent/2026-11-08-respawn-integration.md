# Intent: Bound idle respawn usage across integrated fixes

**Status:** Draft

## Problem statement

Non-git workspaces never trip unchanged-cycle detection, changing documentation can
defeat that detection, and budget exhaustion bypasses the persisted stop path.
Obsolete skip-clear metrics and incomplete lifecycle documentation remain.

## Proposed outcome

Fingerprint non-git workspace content with bounded traversal. Default respawn to
50 total cycles and 3 unchanged cycles (0 disables either limit). Use one persisted
stop path, remove dead skip-clear metrics, and document RL-4 through RL-6 with
covering tests. Commit each integration item separately after reproducing behavior
changes, then run typecheck, lint and the full CI suite.

## Affected users and systems

Respawn users, persisted session recovery, respawn metrics, and live deploy leases.

## Constraints

Never touch the live instance, its data directory or tmux socket. Tests use temporary
directories. Skip dot-directories, node_modules, symlinks and files over 1 MB in the
fallback; inspect at most 5000 files. No new enforcement gates or deployment.

## Open questions

None.

## Validation findings

The full CI run also found pre-existing CLI-id guard violations in plugin uninstall
plans and Grok pane readers, missing generated spreadsheet assets, and Git fixture
failures under inherited `safe.bareRepository=explicit` / `core.fsmonitor=false`.
Remediation preserves behavior: dispatch through data, restore existing vendor
bundles, explicitly configure only temporary Git fixtures, and recognize Git's
bare-repository refusal without weakening the refusal or existing assertions.
The live lease's simultaneous-acquisition race is recorded as an open RL-6 gap;
this integration adds its documentation, not a new locking design.
