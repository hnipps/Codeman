# Intent: a review submit names the caller's branch, not the session folder's

**Status:** Draft

## Problem statement

`codeman agent review submit` sends only the session id, and `POST /api/reviews` reads the repository, branch and commit from that session's `workingDir`. A subagent shares its parent's `CODEMAN_*` env but can work in its own git worktree, so its walkthrough lands on the parent folder's branch. Seen 2026-11-21: two subagents in worktrees `build/w-130-agent-bypass` and `spec/w116-work-lifecycle` both produced reviews recorded on `fix/mermaid-authenticated-frame`, and one of them was approved under the belief that it was W-130 (W-134).

## Proposed outcome

A walkthrough never lands on a branch the caller did not have checked out. The CLI sends its absolute `cwd`. The server probes that folder (bounded) and applies the Docker and remote refusals. It then requires the folder to share the session folder's git common directory, and reads the review facts there. A folder in another repository is a 400 and nothing is written. A submit without `cwd` (an older CLI, the MCP `submit_review` tool) behaves as before.

## Affected users and systems

Agents and subagents that submit reviews (`codeman agent review submit`), the Reviews page, and work reviews (`WorkReviews.authorFor` matches on the branch read from the caller's folder).

## Constraints

- `cwd` cannot leave the session's repository, so it adds no reach the session did not already have.
- The Docker rule holds for `cwd`: git never runs at or inside a Docker case workspace (realpath-checked).
- The probe follows #516: an `unknown` mount refuses through `describeUnknownPath()`.
- `SubmitSchema` stays `.strict()`. A newer CLI talking to an older server is refused rather than silently reviewing the wrong branch.

## Open questions

None.
