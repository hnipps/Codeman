# Intent: Codeman opens on the canvas by default

**Status:** Draft

## Problem statement

The canvas and the canvas shell are finished, and both are still off unless someone ticks two boxes in App Settings. A fresh install opens on the tab dashboard and shows no way onto a canvas. The program's plan ends with one box: turn `canvasEnabled` and the shell setting on by default, in a final change, after the gate passes.

## Proposed outcome

Both settings are tri-state by absence. A key absent from `settings.json` reads as on. An explicit `true` is on. An explicit `false` is off. Nothing writes the key to make it so: there is no migration, and a `GET` never writes.

- A fresh install, and an install that never saved either switch, opens `/` on the canvas of the workspace last used, or on the first-run page when the person has no workspace. The case picker shows **Open canvas** and the phone home screen lists canvases.
- Unticking **Open on the canvas** stores `canvasShellEnabled: false`, and `/` is the tab dashboard again, byte for byte what it was. Unticking **Canvas** stores `canvasEnabled: false`, and the canvas routes answer 404.
- Opening Settings and saving without touching the two boxes changes neither setting.
- One pure reader per side decides. The server reads through `canvasOn()` and `shellActive()` in `src/web/shell-landing.ts`. The browser reads through `canvasSettingOn()` in `settings-ui.js`. No other code compares either key.
- When the server has no stored value for a key, the browser drops its own stored copy on the next settings load, so a `false` left in a device's storage by an earlier build cannot hide a setting the server treats as on.

## Affected users and systems

- Everyone who opens Codeman without a stored value for the switches: `/` changes from the dashboard to the canvas.
- An install whose `settings.json` already holds `canvasEnabled: false` stays off. A Settings save sends the Canvas box's value, so an install where someone saved Settings with that box unticked is in this group. The shell key is stored only by a save that changed its box.
- Tests of the tab dashboard that load `/` from a real server now store the shell switch as off first (`test/classic-dashboard.ts`).

## Constraints

- The fallback stays. With a canvas file missing or the workspace registry unreadable, `/` answers the dashboard with the notice. `/classic` never depends on a canvas file. A person with no workspace gets the first-run page.
- Multi-user rules are unchanged. A non-admin cannot write either key, and `/` opens only that person's own workspaces.
- Stored data is unchanged and stays readable by the previous release (`docs/self-building.md`, rule 5).
- Rollback: the previous release reads an absent key as off. After a rollback to it, `/` is the dashboard and the canvas entries are hidden until the keys are stored as `true`. That is accepted. Saved canvases are untouched either way.

## Open questions

None.
