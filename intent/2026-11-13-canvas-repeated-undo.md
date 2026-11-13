# Intent: Repeated undo on one canvas object, and shell keys from the outline

**Status:** Draft

## Problem statement

Two defects in shipped canvas behaviour, found by the closing check of the Agentic Canvas program.

1. Resize one object twice, then press Ctrl+Z twice. The first undo works. The second is refused with `"<name>" changed after that edit, so it can't be undone.` and so is every later one. Two edits on two different objects undo fine. An agent's `canvas_history undo` fails the same way.
2. With the canvas as the shell, focus on a session row in the outline (after `S`, or after closing a full view). `W` does not open the workspace list, and Escape does not return the keyboard to the board.

## Proposed outcome

Undo walks back through a person's or an agent's own consecutive edits of one object, one step per request, and redo walks forward again, exactly as across different objects.

The data shape does not change. An operation record still holds, per changed object, the object `before` and `after`. The rule the server applies to a history step changes from "the object's revision equals the revision the edit produced" to this invariant:

> A history step over a set of the caller's own operations is accepted only while every object those operations changed still holds the fields the latest of them left, compared on every field except `revision` and `updatedAt`.

When it holds, applying the inverse yields exactly the object as it was before the edit, so no later change is lost. A history step itself bumps the revision and restores an older edit's fields, so the next older edit passes. Any other later edit leaves at least one field different and is refused with `REVISION`, as before.

Checked cases: undo twice; undo, undo, redo, redo; undo after redo; edits interleaved across two objects; a later edit by another author; a later edit by the same author outside this undo stack; a lock taken after the edit (refused as `LOCKED` by the shared validation).

Inverse operation ids include the sequence the step is built on. Undoing one edit, redoing it, and undoing the original sequence again would otherwise repeat the first undo's id, which the store answers as a duplicate that writes nothing.

`S` and `W` act from any non-editable control in the outline, and Escape from there focuses the board. The board's other letter keys stay scoped to the board.

## Affected users and systems

People editing a canvas and agents using `canvas_history`. The rule lives in `historyCommands()` (`src/canvas/commands.ts`), the one path both use. The browser's undo stack is unchanged.

## Constraints

- Stored operation records keep their shape and stay readable by the previous release (`test/canvas-history-compat.test.ts`).
- An undo is still refused when a later edit by anyone else changed the object, and never crosses a lock.
- No new gate, hook or protected surface.

## Open questions

None.
