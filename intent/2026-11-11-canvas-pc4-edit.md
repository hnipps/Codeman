# Intent: Desktop canvas editing, part one

**Status:** Draft

## Problem statement

The canvas can be read and navigated but desktop users cannot create, edit or arrange their own objects.

## Proposed outcome

Desktop edits use a durable optimistic queue with server acknowledgements, explicit conflict resolution and safe history. Selection gestures, deliberate reparenting, movement and bounded resize fit the existing dock, outline and reader. Phone viewing stays read-only.

## Affected users and systems

Canvas desktop users, the browser client and its existing operation API.

## Constraints

Use existing server operation kinds only. No deployment, full test run, new server commands, grouping, locks, clipboard, alignment, order or rotation controls in this packet. Keep pending writes durable until acknowledged; refuse new writes offline. Keep all text inert and preserve later authors' work during undo. Tests and builds run serially after the machine process gate.

## Open questions

None. Explicit reparenting uses the existing `reparent` operation with world placement preservation; ordinary dragging uses `move`.
