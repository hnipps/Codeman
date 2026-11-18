# Intent: File attachments on Work items (W-42, part 1 of 4)

**Status:** Draft

## Problem statement

A Work item can hold only text. A person cannot attach a screenshot, a PDF or a log to an item, and an agent that picks the item up has no way to see such a file. W-49 (capture spike) needs somewhere to put what it captures.

## Proposed outcome

A Work item carries file attachments. The server stores the bytes beside `work.json`, serves them back, removes them when a person takes one off, and `canvas_work read` lists them.

- The item gains `attachments: [{id, name, type, size, at}]`, at most 20 per item.
- `POST /api/canvas/:ws/work/:key/attachments?name=` takes the raw bytes; `GET` and `DELETE .../attachments/:id` serve and remove one.
- Admission reuses the prompt-upload rules: the canvas image types plus `ALLOWED_DOCUMENT_EXTS`, judged on their bytes by `imageMagicMatchesExt`, at most 8 MB each.
- A workspace's attached bytes are capped at the canvas image quota's number, counted from what the items record.

Parts 2 to 4 are their own items: canvas object references (W-59), the item detail UI (W-60) and an MCP way to fetch a file's bytes (W-61).

## Affected users and systems

- The owner, through the API now and the canvas Work detail once W-60 lands.
- Agents reading items with `canvas_work`.
- `src/canvas/work.ts`, `src/canvas/work-files.ts`, `routes/canvas-work-routes.ts`, `src/mcp-server.ts` (tool description).

## Constraints

- Self-building rule 5: the previous release must still read `work.json`. `attachments` is optional and items pass unknown keys through, so it does.
- No request may name a path: bytes are reached by a random id the item records.
- Nothing attached may run as a page of Codeman's origin: only images keep their own type, text is `text/plain`, the rest downloads, all with `nosniff` and `Content-Security-Policy: sandbox`.
- Only the live deploy colour writes.

## Open questions

- Items are never deleted today, so "delete with the item" has nothing to hook. If item deletion is added, it must remove `work-files/<n>/`.
