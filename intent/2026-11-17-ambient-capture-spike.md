# Intent: Ambient capture spike (W-49)

**Status:** Draft

## Problem statement

A person who sees something wrong in Codeman has to leave what they are doing to report it. No tool captures what is on screen, marks a region, and files the result as a Work item. `canvas_screenshot` is a server re-render and cannot see panels, chrome, terminals or live embeds.

## Proposed outcome

This spike lands no product change. It records measured answers to W-49's four questions, ships a throwaway demo of freeze, draw and send, and proposes build items. The findings are in `docs/spikes/w-49-ambient-capture/README.md`.

## Affected users and systems

- No runtime system changes. The spike adds documents and scripts under `docs/spikes/` only.
- The proposed build touches the dashboard shell, xterm setup, the canvas frame bridge, the Work routes and W-42 attachments.

## Constraints

- Capture and filing must not depend on an agent.
- No new runtime dependency lands in this spike. The demo loads its libraries from a CDN, for the spike only.

## Open questions

- Who decides whether Codeman vendors a DOM rasteriser (html-to-image, MIT, about 20 KB)? Every recommended desktop path needs one.
- Which workspace receives a capture when none is on screen?
