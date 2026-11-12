# Intent: Plan the canvas as Codeman's shell (PC13)

**Status:** Draft

## Problem statement

The canvas opens as a tab inside Codeman's dashboard. The design brief says Codeman is only the delivery shell, but no step in `docs/agentic-canvas/initial-version-plan.md` ever replaces it. The program's last step turns `canvasEnabled` on by default, which only makes the tab visible to everyone.

## Proposed outcome

The plan gains PC13, after PC12. It makes the canvas the landing page and the place every Codeman surface is reached from, keeps the tab dashboard as a fallback route, and moves the final default switch so the live build opens on the canvas. This change edits the plan only; no code changes.

## Affected users and systems

The owner, who wants all of Codeman to live in a canvas. The canvas program coordinator and the PC13 owner, who take scope from the plan.

## Constraints

- PC13 starts with a shape pass, like PC9 to PC12.
- The classic dashboard stays in the code, so upstream Codeman releases still merge.
- A broken canvas bundle must never lock the owner out.
- Deploy, rollback and data-compatibility rules in `docs/self-building.md` are unchanged.

## Open questions

- Whether the shell setting is synced or per device. Shape decides.
- The classic view's route name. Shape decides.
