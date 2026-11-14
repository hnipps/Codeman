# Intent: Review a canvas text object like a plan

**Status:** Draft

## Problem statement

An agent writes a brief as a canvas text object. To give feedback today a person leaves comments on the whole object or rewrites it by hand. A comment cannot point at the words it is about, cannot say "replace these words with these", and every comment reaches the agent only by Ask agent, one comment at a time, in a canvas conversation rather than in the session that wrote the brief.

## Proposed outcome

A text object has a Review mode. A person selects words and leaves a typed note: Comment, Replace (old to new), Delete, Answer (only under a numbered line ending in "?"), or a general note tied to no words. Each note is an ordinary canvas comment on the object, so threads, counts, replies and undo keep working, and the previous release shows it as a plain comment. Its review metadata (kind, quoted words, replacement, when it was sent, when it was resolved) lives in a side file per workspace keyed by comment id, the same way `comment-anchors.json` keeps an element.

Post saves a note. Post & send also delivers it. Send N delivers every unsent note in one prompt, to the session that wrote the object, or to a session the person picks when that one has ended. Nothing sends twice and nothing sends without a press. A note stays open until it is resolved. Replace and Delete notes have Apply, which edits the object through the ordinary update command (so undo works). Notes find their words again after an edit; a note whose words are gone says "text changed" and keeps its quote.

Desktop: Review in the reader rail (the rail is at least 420px wide while reviewing), notes under their paragraph, highlights on the board and no pins. F opens the full layout (document in the centre, notes on the right). Phone: Review in the object sheet opens the full layout, with Comment / Replace / Delete in a bottom bar and the notes in a bottom sheet.

## Affected users and systems

People reviewing an agent's brief on the canvas, and the agent that receives the notes. Systems: `packages/canvas` (reader rail, full layout, phone sheet, board highlights), canvas routes (a side file and a send route), the data directory (a new `review-notes.json` per workspace).

## Constraints

- Data stays readable by the previous release (self-building rule 5): no key is added to stored comments, objects or the operation log. The side file is new and is ignored by a release that does not know it.
- Only the live colour writes (rule 6): the side file goes through `atomicWrite`, which refuses elsewhere; the send route checks `deployRole.allows('persist')`.
- Note and quote text reach the DOM through `textContent` only. The prompt is built on the server through `normalizePrompt` / `promptRefusal` and the message byte limit.
- Sending is a person's action only: the route refuses an agent caller.

## Open questions

- Delivery confirmation: the send awaits the same `deliver()` the canvas conversations use. A paste that was written but not confirmed is stamped as sent (it is in the composer, and sending again would paste twice) and the answer says it was not confirmed.
