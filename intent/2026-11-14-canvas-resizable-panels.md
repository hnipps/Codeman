# Intent: Resizable canvas side panels

**Status:** Draft

## Problem statement

The canvas page's two side panels have fixed widths: the outline on the left is 192px and the rail on the right is 320px. Long object names, session rows, a thread, an assistant conversation or a docked prototype page are cramped, and there is no way to widen either panel.

## Proposed outcome

Each panel resizes from its inner edge. Drag the edge, or focus it and use the arrow keys (Shift for larger steps, Home and End for the bounds, Enter or a double-click to reset). The width is remembered per device and survives a reload. The board always keeps at least 320px between the two panels. Phones keep full-screen panels and show no handle.

## Affected users and systems

People using the canvas on a desktop or tablet. Touches `packages/canvas/src/panel-widths.ts` (new), `entry.ts`, `canvas.html` and `canvas.css`.

## Constraints

Defaults stay 192px and 320px, so nothing moves for someone who never drags. Panel visibility and width never move the camera. Widths are a per-device preference in localStorage, not a synced setting.

## Open questions

None.
