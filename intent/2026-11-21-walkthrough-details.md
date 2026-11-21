# Intent: fold walkthrough detail with details and summary

**Status:** Draft

## Problem statement

An agent's walkthrough on the Reviews page cannot hide detail. The shared Markdown sanitizer drops `<details>` and `<summary>` and keeps their text, so a walkthrough with full context reads as a wall of text (raised in the W-66 review, filed as W-69).

## Proposed outcome

A walkthrough that writes `<details><summary>More</summary>…</details>` shows the summary line collapsed, and a click opens it. Only the Reviews page walkthrough gets the two tags and the `open` attribute. Event handlers stay stripped.

## Affected users and systems

The person reading reviews, and agents writing walkthroughs. Code: `sanitize-html.js` (optional extras on the factory, a second global), `reviews.js` `markdownBody()`, `reviews.css`.

## Constraints

Chat, the response viewer, file previews, the canvas and the changed-file document view keep the default sanitizer unchanged. No new dependency. `FORBID_TAGS`/`FORBID_ATTR` stay as they are.

## Open questions

None.
