# Intent: Correct three canvas review defects

**Status:** Complete

## Problem statement

Container readers leave an empty divided section, long outline queries crowd the clear control, and overlapping live-test text fixtures appear heavier than other text in review captures.

## Proposed outcome

Empty body sections have no divider. Containers show their live direct-child count (or Empty). Search reserves space for its clear control. Review fixtures show one inert markup-looking object with the same typography as its siblings.

## Affected users and systems

Canvas readers, outline search users, and browser review evidence.

## Constraints

Limit this round to the three reported defects. Run only the requested checks serially after waiting for other test/build processes. Keep stored data and inert text rendering unchanged.

## Open questions

None.

## Verification

Type checking, lint, format check, canvas build and all 19 canvas browser tests pass. The twelve requested captures were regenerated and opened for visual inspection. DOM assertions cover empty body layout, Empty containers, direct-child count, search-control spacing in both themes and widths, and matching inert-text typography.
