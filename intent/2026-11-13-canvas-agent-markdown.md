# Intent: Agent text on the canvas renders Markdown and Mermaid

**Status:** Draft

## Problem statement

Claude answers in Markdown. The canvas assistant rail and the comment threads showed that answer as raw text, with `**`, `##`, list markers and fenced code visible, and a Mermaid diagram as its source. The classic dashboard's Chat and Response Viewer already render both.

## Proposed outcome

Agent text on the canvas page reads as the dashboard's Chat does:

- Claude's turns in the assistant rail.
- Agent-authored comments in a thread (an Ask agent reply).

Both render through the dashboard's existing pipeline: the vendored `marked`, the DOMPurify allowlist in `sanitize-html.js`, and the shared Mermaid frame in `mermaid-render.js`. `canvas.html` loads those four files as classic scripts ahead of the bundle. `packages/canvas/src/markdown.ts` holds only the glue. No second parser, sanitizer or diagram path exists.

A person's own prompt and a person's comment stay plain text. That is what they typed, and `**` there is not a request for bold.

## Affected users and systems

People reading agent replies on the canvas. The rail repaints its whole list on every state change, so a rendered turn is reused across repaints, keyed by conversation, row and text, and its diagram renders once.

## Constraints

- Fail closed: without the parser and sanitizer the turn is plain `textContent`, as before.
- Links get `target="_blank"` and `rel="noopener noreferrer"` after sanitizing, as in the dashboard.
- The Mermaid frame rules in `src/web/CLAUDE.md` are unchanged: opaque frame, no network, the diagram an inert image.
- No new route, stored field or setting.

## Open questions

None.
