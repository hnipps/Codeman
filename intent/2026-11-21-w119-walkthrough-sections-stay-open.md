# Intent: walkthrough sections stay open through note actions (W-119)

**Status:** Draft

## Problem statement

On the Reviews page a walkthrough can fold sections with `<details>`. Adding, resolving or deleting a note rebuilds the walkthrough column, so every section the reader opened closes again. Jumping to a text note that sits in a closed section scrolls to a mark the reader cannot see.

## Proposed outcome

After a note action, the sections the reader opened are open again, matched by their order in the document, as long as the review and its walkthrough text did not change. A changed walkthrough starts with every section closed. Jumping to a text note opens the sections around it before it scrolls into view.

## Affected users and systems

The person reviewing on the Reviews page (`src/web/public/reviews.js`). No server change, no visual change.

## Constraints

One render path: `renderWalkthrough()` keeps rebuilding the column, so every caller gets the same behaviour. Smallest diff.

## Open questions

None.
