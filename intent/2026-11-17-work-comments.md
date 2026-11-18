# Intent: a comment thread on each Work item (W-53)

**Status:** Implemented

## Problem statement

A canvas Work item has a description, a history log and an optional question (`needs`), but nowhere a person and an agent can leave each other notes about the item. Notes end up in the description, in a conversation that the other side never reads, or nowhere.

## Proposed outcome

Every Work item carries a flat comment thread, oldest first. A person adds a comment from the item's detail panel. An agent adds one through `canvas_work` with `action: "comment"`. `read` and the item routes return the thread; `list` does not. A comment records its author and time, adds one `Commented` line to the history and bumps the revision. It never moves the item, never clears `needs` and never changes any other field.

## Affected users and systems

- People using the canvas Work view (detail panel).
- Agents using the `canvas_work` MCP tool.
- `work.json` gains a `comments` array per item. The previous release keeps unknown keys, so it still reads and writes the file.

## Constraints

- Comment text is at most `MAX_WORK_NOTE_CHARS` (2000) and not empty. A thread holds at most `MAX_WORK_COMMENTS` (200); a full thread refuses a new comment and never drops the oldest.
- No replies, edits or deletes.
- Comment text is untrusted data. The browser renders it with `textContent` only.
- A file written before this change, with no `comments`, still loads.

## Open questions

None.
