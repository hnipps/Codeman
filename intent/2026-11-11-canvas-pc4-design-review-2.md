# Intent: Canvas PC4 design review, round 2

**Status:** Draft

## Problem statement

The PC4 desktop editing controls work but read as unfinished. Arrange opens a 640px panel of two text columns, two inputs and a paragraph of developer prose. Server refusals are shown as raw server text ("Edit refused: Explicitly unlock the protected object or ancestor first (note)."). The lock glyph floats above a corner and overlaps truncated outline labels. The board draws an amber ring around the whole viewport after keyboard use, including during a combined resize. A locked selection still offers Move to, Arrange, Edit, Delete and Group as if they would work, and Group appears for a single object.

## Proposed outcome

- Arrange is a compact menu (240px wide, under 300px tall) of four divided groups: six align icon buttons, two distribute icon buttons, four order rows with right-aligned shortcut hints, and wrap rows (plus Lock background only for frames and sections). Align needs two objects and distribute three; with fewer they are unavailable, not hidden. Arrows move through it; Escape returns to Arrange.
- Keyboard move mode is entered with `M`. Clipboard actions stay on their shortcuts; Duplicate joins the contextual row. Rotation is a numeric field in the reader's position block. Explicit distribution spacing is available only through the command endpoint. Order gains Mod+] / Mod+[ (with Shift for front/back).
- Refusals are one product sentence chosen from the server's reason code, naming the object (32 characters at most); unknown codes say "That change was refused." with the server text only in the title attribute.
- One 12px lock icon in the dock stroke sits outside the top-right of the selection boundary on the label line, shows faintly on hover or focus when unselected, and has reserved trailing space in the outline row.
- The board never draws a focus ring; keyboard focus shows on the focused object.
- A locked selection marks forbidden actions unavailable with the refusal sentence as their description, and Unlock is the one primary action. Group shows only for two or more objects, Ungroup only for a single group.

## Affected users and systems

Desktop canvas users. Client package `packages/canvas`, `src/web/public/canvas.html` and `canvas.css`, the canvas browser tests and design/invariant docs. The server, stored data and operation kinds are unchanged.

## Constraints

No modal, inspector or toast. Amber only for keyboard focus, the selected tool and the primary action. 14px body, 12px metadata, 4px grid and corners, inline SVG icons in the dock's 1.5 stroke, textContent for object text. The contextual row stays one line at 1440. Phone widths keep omitting edit controls.

## Open questions

None.
