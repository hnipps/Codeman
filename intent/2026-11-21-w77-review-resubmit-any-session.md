# Intent: a resubmit of a branch from another session updates its open review (W-77)

**Status:** Draft

## Problem statement

On 2026-11-19 a second worker on the branch `spec/chat-graph` submitted it for review and the Reviews page queued the branch twice, because a submit only updated an open review written by the same session. The stale review had to be moved out of `~/.codeman/reviews` by hand. For spec-w70 a review's `sessionId` was edited by hand after its author's pane ended, so the new worker's submits would update it.

## Proposed outcome

A submit from any session of an owner, for a repository and branch that already has an open session review of that owner, updates that review: the walkthrough and commit are replaced, the notes are kept, `revision` goes up by one, and the submitting session becomes the author. Request changes, stills and the live preview then follow that session.

## Affected users and systems

The owner, who sees one review per branch. Agents that submit through `POST /api/reviews`, `codeman agent review submit` or the MCP `submit_review` tool. The work-review path is unchanged.

## Constraints

Another owner's review is never matched. A work review is never taken over. A decided or closed review is never reopened by a submit, except a review whose deploy failed, which stays open so the agent's next submit answers it.

## Open questions

The work-review path is unchanged, so a session review left open by a worker not linked to the work item can still sit beside the work review of the same branch once a linked worker submits. Whether a work submit should close or absorb that session review is not decided here.
