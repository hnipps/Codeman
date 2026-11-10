# Intent: Preserve real Copilot inline link targets

**Status:** Implemented

## Problem statement

The deployed inline link handler passes synthetic xterm tests, but clicking the real Copilot label still does nothing. Its actual terminal output contains an underlined label without an OSC 8 target. The saved assistant message contains the local Markdown destination.

## Proposed outcome

The actual Copilot terminal retains the destination needed to open a report label. Verification includes the transport that lost the target, followed by a real browser click.

## Affected users and systems

People reading Copilot responses. Terminal transport, capture and replay, and native link handling.

## Constraints

Preserve existing sessions and do not send input to user sessions. Keep filesystem access guarded. Do not infer a destination from a label alone.

## Open questions

None.

## Work plan

1. Reproduce it yourself on the matching surface via the control skill.
2. Binary-search the cause.
3. Plan the fix.
4. Verify on the same surface.
5. Stage the commits so the failing repro lands before the fix in git history.
6. Run Opening a PR.

Throughput checkpoint. The original transcript and actual terminal bytes are available. Verify transport before changing browser link handling again.

## Observed cause and chosen fix

The actual tmux capture retains the OSC 8 target. Local attach clients omit it without the hyperlink terminal feature. Snapshot sanitizing and visible-column truncation also discard it. Advertise support on compatible local clients and preserve complete OSC 8 sequences in snapshots. Keep other control sequences stripped and close clipped hyperlinks.

## Verification

A real attach client received zero OSC 8 sequences before the feature flag and received the saved links with it. Three browser regressions failed through the original snapshot formatter while seven direct-input regressions passed. All ten pass after the fix. The actual saved Copilot report row also opens its intended local report after formatting.

The full app reproduced the missing native target before deployment. The focused transport suites pass 161 tests, including old and unknown tmux version fallback. The deployment gate passes 309 tests. Review found and corrected acceptance of C1 controls inside hyperlink payloads. Final verification must click the actual label in the deployed app and confirm the report preview loads.
