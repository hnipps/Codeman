# Intent: The canvas cap counts only active conversations

**Status:** Draft

## Problem statement

A canvas keeps at most 50 conversations and background tasks. Every record ever made counted toward that cap, and a plain conversation had no remove path. The cap filled with conversations whose sessions had ended or sat idle, and routine fires were refused with `TOO_MANY: a canvas keeps at most 50 conversations and tasks`. The owner cleaned the live canvas by hand.

## Proposed outcome

A start on a full canvas evicts the oldest inactive record and goes ahead. A record is active while its session is live and its agent is working now or was active in the last hour; a record waiting on a person for more than an hour, or whose session ended, is inactive. `TOO_MANY` is answered only when every record is active, and it says so.

## Affected users and systems

The canvas owner, agents and routines that start conversations or tasks. Touches the conversation and task create routes, the task Remove path (shared), the `canvas:conversation` SSE event (new `change: 'removed'`) and the MCP tool descriptions.

## Constraints

- `conversations.json` stays readable by the previous release, whose schema refuses more than 50 records (self-building rule 5), so 50 stays the stored bound.
- Eviction runs Remove: a worktree with changes is never force-removed.
- Only the live colour evicts (self-building rule 6).

## Open questions

- Whether an idle Claude pane stays output-quiet. If a CLI redraws on a timer, its idle records stay active, which is conservative.
