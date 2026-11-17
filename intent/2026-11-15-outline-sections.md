# Intent: Collapse and resize the canvas outline's sections

**Status:** Draft

## Problem statement

The canvas's left panel (`#outline`) stacks Sessions, Work, Prototypes and the object tree in one fixed column. A long Sessions list pushes Work and the objects out of view, and no section can be folded away or given more room.

## Proposed outcome

Each section has a chevron toggle in its header and collapses to that header. The object tree gets an "Objects" header so it can collapse too. The boundary under an expanded section drags, or takes Up/Down on its focused `role="separator"` handle, to set that section's height; the last expanded section takes the room left, and every expanded section keeps 64px. Collapsed sections and heights are stored per device (`codeman:canvas:outline-sections`) and the heights are re-fitted whenever the window or the set of sections changes. Phones collapse but draw no handle.

## Affected users and systems

People using the canvas page on desktop and phone. `packages/canvas/src/outline-sections.ts` (new), `entry.ts`, `work-view.ts`, `storage-keys.ts`, `src/web/public/canvas.html`, `canvas.css`.

## Constraints

No new dependencies. With nothing stored, every section keeps its old CSS size. The handles follow `panel-widths.ts` (drag, arrows, Enter and double-click reset, per-device storage).

## Open questions

None.
