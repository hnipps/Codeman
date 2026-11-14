# Intent: Element-comment pins follow a page that changes itself

**Status:** Draft

## Problem statement

A comment can point at one element of a live prototype, and a numbered pin marks that element over the frame. When the page's own script removes the element (a prototype that switches state, a single-page app that re-renders), the pin stays where the element was and the thread chip keeps saying the element is there. The pin only goes away after something else makes the canvas ask the frame again: a scroll, a resize, a reload or a click elsewhere.

Separately, the comment count mark on a board object looks like a control but does nothing: a click passes through it to the empty board.

## Proposed outcome

The frame bridge watches the page's DOM once the canvas has asked it where some elements are. When a DOM change moves, adds or removes one of those elements, it sends the same `codeman:frame-rects-changed` message a scroll sends, at most once per animation frame. The pins and the chip state ("No longer on the page") then follow the page within a frame or two, with no reload.

The count mark is a button. Clicking or tapping it opens that object's thread in the rail, as a task's Open thread does, without starting a drag, a marquee or a pan.

## Affected users and systems

People reviewing prototypes on the canvas. `src/canvas/frame-bridge.ts` (the script injected into every canvas frame, proxied embeds included), `packages/canvas/src/comments.ts`, `entry.ts`, `canvas.css`.

## Constraints

The bridge stays one self-contained script, its text ASCII, its hash computed from its source. A page that re-renders all the time must not flood the canvas: the bridge compares the boxes of the selectors it was asked for (the last 64) and says nothing when none changed. The canvas side keeps its limits (`MAX_LOCATE_SELECTORS`, one `locate` per frame per animation frame).

## Open questions

None. Not covered on purpose: an element moved by a CSS animation or transition, an image loading above it, or a change inside a shadow root alone; those wait for the next scroll, resize or DOM change.
