# Intent: the journal merges by union on Approve

**Status:** Draft

## Problem statement

Every change adds its entry at the top of `docs/JOURNAL.md`. Two reviews in flight therefore always conflict there, and Approve refuses the second one until the agent merges the base and resubmits. Every review conflict on 2026-11-21 (W-88, W-112, W-117, W-128 twice) was in this file.

## Proposed outcome

Two branches that each add a top journal entry merge on Approve with both entries kept. A conflict in any other file is still refused.

## Affected users and systems

The Reviews page Approve merge (`src/reviews/review-merge.ts`) and R-4, which merges in a worktree and reads the branch's own `.gitattributes` once this rule is on master.

## Constraints

Approve never reads the shared checkout's working tree, so the rule comes from the base tip through `git --attr-source` (git 2.40+; the host has 2.43). The reviewed branch must not decide how it merges. GitHub's mergeability check ignores merge drivers.

## Open questions

None.
