# Intent: Canvas edit queue survives refusals, no-ops write nothing, acknowledgements stay small

**Status:** Draft

## Problem statement

The round-one audit of the desktop canvas editing branch found three blocking faults and two smaller ones.

- A refused command emptied the whole edit queue. A text draft queued behind it kept its "sent" marker with nothing queued, so the server kept the old text, the editor kept saying "Draft · waiting to save", and later typing never saved.
- A compound that expanded to nothing (Send backward on the backmost object, a drag that snapped back to its start) wrote an empty `revert`. That bumped the object's revision, so a text save holding the earlier revision was refused as someone else's change.
- Every compound action acknowledged itself by downloading the whole operation log (`GET /ops?since=0`), which the server cloned on the request path.
- The edit queue, drafts and clipboard were stored under keys shared by every user of a browser profile.
- Author revert (`canvas_history` `revert`) ignored the request id, so a retried request appended a second revert.

## Proposed outcome

- A refusal discards only the refused submission and edits that provably depend on it. Everything else queued is sent in order. A draft's sent marker is valid only while the queue holds its operation id, and a stale marker is cleared before the next save.
- A command that expands to nothing appends nothing and changes no revision or `updatedAt`. It answers `noop: true` with the current sequence. The validator refuses an `update` or `revert` with an empty patch.
- A write returns the sequences it produced. The client catches up from just before them or from its own sequence, following a capped `/ops` cursor (500 records, 1 MB). No acknowledgement asks for `since=0`.
- Canvas local storage is keyed by the signed-in user, or `@single` without multi-user mode. Unscoped keys are removed; single-user mode adopts them once. The clipboard is capped at 1 MB.
- Author revert is idempotent under its request id.

## Affected users and systems

Desktop canvas editors, agents calling `canvas_history`, the read-only view's catch-up, and any client of `GET /api/canvas/:workspaceId/ops`.

## Constraints

No new on-disk operation kind. The log this writes stays readable by master. The read-only view on master still converges: a capped page omits `seq`, its parse fails, and it refetches the snapshot. Older edit clients follow the same path.

## Open questions

Undo after a reload is not built. The log keeps neither the batch grouping of a browser action nor the redo stack, so rebuilding Ctrl+Z history would need new stored data.
