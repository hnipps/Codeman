# Intent: Canvas comments, author revert and the phone view (PC6)

**Status:** Draft

## Problem statement

The canvas stores comments and can revert an author, but nobody can see either. The dock's Comment button is disabled, there is no thread, no history view and no way to revert one agent session from the page. On a phone the canvas is the desktop editor with controls hidden: a real iPhone showed an unfitted first view, a search field that raises the keyboard over the outline, reveals that leave objects under the dock, no single-tap way to read an object, 22 px title targets and pans that select.

## Proposed outcome

- Objects with comments carry a small count mark. The right rail gains a thread view (author, relative time with exact time on demand, inert text, composer with Cmd/Ctrl+Enter, kept draft and Retry on failure). Posting stores an ordinary comment through the command endpoint with a request id and never starts agent work. New comments arriving over SSE never move camera, focus or selection.
- Agents get `canvas_comment`; `canvas_read` already returns comments. `canvas_history` gains `authors` and `preview` read actions so agents read the same history summary and revert preview the page shows.
- The rail gains a history view: authors with operation counts and last activity, and **Revert this session** per agent author with an inline confirm that states what will be removed and that later edits by others stay. `POST /revert` takes an optional request id and answers with a summary of removed objects, restored fields and skipped fields. Locked targets reject the whole revert with reasons (the existing atomic lock policy).
- Phone mode is one helper (narrow width, or a touch handset in landscape). It shows a labelled dock (Sections, Find, Comments, Fit), a bottom sheet for the focused object (Read, Comments, Focus parent), a composer kept above the software keyboard, and never sends a geometry or content operation; the editor's command layer refuses them.
- The phone home screen lists a canvas entry per case when the canvas is enabled, with no new header button.

## Affected users and systems

Canvas page (`packages/canvas`, `canvas.html`, `canvas.css`), canvas commands and routes, the MCP server (24 tools), the phone home screen, docs.

## Constraints

- No new stored record kinds: comments and reverts use operation kinds the previous release already reads. A request-id revert only changes operation ids.
- Revert of 1,000 operations finishes in under a second.
- Edits to files shared with PC5 stay small and additive.

## Open questions

None.
