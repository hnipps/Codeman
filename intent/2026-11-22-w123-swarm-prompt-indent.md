# Intent: indent agent text in pr-swarm's verdict prompt (W-123)

**Status:** Draft

## Problem statement

`swarmVerdictPrompt()` sends pr-swarm's verdict to the implementing agent. A deferred reason, an R-3 finding or an R-3 deviation can span several lines, and only the first line of each got a marker. The other lines started at column 0. A reason that contains the prompt's closing lines ("Address each note…", "Do not merge or deploy…") then looked exactly like Codeman's own instructions.

## Proposed outcome

Every line after the first of agent-written text is indented by 3 spaces, as finding bodies and person-written review notes already are. Only the prompt's own lines (header, section labels and the closing lines from `requestChangesEnding()`) start at column 0. A prompt built from single-line input is unchanged.

## Affected users and systems

The implementing agent that receives a pr-swarm verdict. Harry, who reads the same prompt in the session. No stored data or API changes.

## Constraints

No new wording or delimiter block. Rendering matches `noteLines` in `review-model.ts`.

## Open questions

None.
