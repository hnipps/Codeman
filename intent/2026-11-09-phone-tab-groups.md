# Intent: Show named tab groups on phones

**Status:** Done

## Problem statement

Named tab groups only appear in the desktop vertical rail. `resolveTabOrientation()` always gives phones the horizontal strip, so a group someone made on the desktop never appears on their phone. Nothing on the phone shows which sessions belong together.

## Proposed outcome

On the phone home screen, Current sessions is split into one heading per named group that holds a current session, in layout order, with an "Ungrouped" heading last. Needs you stays flat. If no group holds a current session, the screen is unchanged. Group membership comes from the rail's own projection, so a child session sits in its parent's group, just as it does on the desktop.

## Affected users and systems

- Phone users with tab groups: the home screen (`mobile-overview.js`, `mobile.css`).
- `app.js`: both places that replace `tabLayout` redraw the home screen.
- Nothing changes for the tab strip, the desktop rail or the stored layout.

## Constraints

- Read-only: no layout writes from the phone.
- Group names are user content and are not translated.
- Collapse state is per device and set on the rail, so the phone ignores it.

## Open questions

None.
