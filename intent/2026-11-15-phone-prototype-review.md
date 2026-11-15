# Intent: Review a prototype from a phone

**Status:** Draft

## Problem statement

On a phone the canvas shows a prototype's embed as a card that says "Paused" and nothing else. A phone runs no live frames (`media.ts` keeps none when `mobile.matches`), has no page slots, and refuses `canvas_view open-page`. So a person away from a laptop cannot see what the latest version looks like, cannot use it, and cannot comment on one element of it. Desktop element comments also know only a selector: when a new version renames a class, the comment says "No longer on the page" and loses its context, and no comment says which version it was made on.

## Proposed outcome

The spec is the canvas frame `phone-study` (decisions note `phone-brief`, round 2, mock-up prototype `phone-review` v3, six pictures and their comments).

- On a phone, a prototype's board card shows a picture of the version its embed shows, `v<n>`, and who published it and when, instead of "Paused". States: no picture yet (title and a loading line), a version no longer stored (one line and Reload), offline (the last picture and an "Offline" line).
- The phone object sheet has a primary **Review** action for a prototype embed, next to Comments and Focus parent.
- Review opens the embed's live page full screen. Every touch goes to the page. One live page at a time; Back closes it. The bar holds Back, the title and `v<n> · <author>`, a quiet Reload, a labelled **Pick**, and Comments with a count. A Phone / Desktop switch shows the page at 390 px, or at 1280 px scaled to fit and still usable.
- Pick is one-shot: the next tap chooses an element instead of pressing it, then the thread opens with the element attached, as Pick element does on desktop. A numbered pin marks each commented element the page still has.
- Opening always shows the version the embed shows now. If a version lands while the review is open, a prominent "v<n> is ready · Reload" note appears; nothing reloads by itself.
- Each comment on a prototype embed says which version it was made on ("on v2"). An anchor is looked for by its selector, then by the element's tag and text, nearest its old position. Found: the pin follows it. Not found: no pin, the chip says "not in v<n>", and the thread shows a crop of where it was in the version it was made on.
- Comments are never resolved by an agent. Canvas comments have no resolved state today and this change adds none: no auto-resolve, no fold-away, and no agent tool gains a resolve field (decision, Harry, 2026-11-15; the brief-review notes already refuse an agent's resolve).

## Affected users and systems

- People using the canvas on a phone or a touch device under 600 px.
- `packages/canvas`: `media.ts` (one review frame on a phone, heard by the one message receiver), a new `prototype-review.ts` (the full-screen view), `objects/embed.ts` (the phone card), `element-comments.ts` and `comments.ts` (versions, "not in", crop), `entry.ts` (sheet action and wiring), `canvas.html`, `canvas.css`.
- Server: `src/canvas/frame-bridge.ts` (`codeman:locate` takes hints for the fallback), a new side file `comment-versions.json` per workspace, a picture route and a crop route for stored prototype versions (rendered by the existing headless check browser, one job at a time, cached under the prototype's folder).

## Constraints

- The review frame comes from `createEmbedFrame()` with the same sandbox and capability address as a board frame. Its messages pass the same origin and source checks and `parseFrameMessage()`.
- The previous release must still read the canvas: no new key on a stored comment or operation. The version a comment was made on lives in a side file, like `comment-anchors.json`.
- Picture and crop rendering share the headless browser queue (one job at a time) on an 8 GiB host; a cached picture is served from disk, and rendering is rate limited per workspace.
- Desktop behaviour is unchanged apart from the fallback anchor lookup, the "on v<n>" label and the "not in v<n>" crop, which apply to desktop threads too.
- Keep shared canvas files minimal: the Work tracker is being built in parallel.

## Open questions

- None blocking. Deferred: keeping a version that a comment was made on from being dropped by the version retention (`PROTOTYPE_VERSIONS_KEPT`); until then a crop of a dropped version is simply not shown.
