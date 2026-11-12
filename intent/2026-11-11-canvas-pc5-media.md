# Intent: Canvas images, links, website embeds and sub-canvases (PC5)

**Status:** Implemented on `feat/canvas-pc5-media`, awaiting landing

## Problem statement

The canvas stores `image`, `link`, `embed` and `subcanvas` types but cannot make or show them. A pasted screenshot, a pasted URL or a dropped file does nothing. A sub-canvas is an ordinary box with no way to open it. Agents have no command to upload an image, read a link preview, convert a link to a live page or enter a sub-canvas view.

## Proposed outcome

- Image bytes are stored per workspace under `dataPath('canvas/<workspaceId>/assets/')`, named by SHA-256, judged by `imageMagicMatchesExt`, capped in size and served by id with `sendFileBody()`. No request carries a path. Unreferenced assets are kept.
- Paste or drop of an image creates an image object at its aspect ratio; a URL creates a link card; plain text creates a text block.
- The server fetches a link title and thumbnail through the web-tab egress guard (bounded time and bytes, no cookies, no auth, redirects re-checked). The thumbnail is stored as an asset after the same byte check.
- A link converts to an embed and back through `canvas_update` (the only object type switch allowed is link ↔ embed). An embed renders a sandboxed iframe on `/webview/<cap>/` from a web tab record with a `canvas` origin, never trusted, removed when its object is deleted or converted back. At most six frames are live; offscreen and over-cap frames show the card with "Paused". A shield keeps drags on the canvas, and the frame takes keyboard focus only after a click into it.
- Double-click (or Open) enters a sub-canvas by setting the view root; a breadcrumb in the outline header and Escape lead back.
- Agents get the same capabilities: `canvas_upload_image`, `canvas_link_preview`, image/link/embed content in `canvas_create`/`canvas_update`, and sub-canvas reading through `root`. The browser exposes enter/leave as view commands.
- The screenshot renderer draws stored image bytes and draws links and embeds as inert cards; it never loads a remote URL.
- Carried PC4 nits 1–8 are fixed with tests.

## Affected users and systems

Canvas users on desktop (phone stays read-only), agents through MCP, `src/canvas/**`, `src/web/routes/canvas-routes.ts`, the web tab store and routes, `packages/canvas/**`, `src/web/public/canvas.*`.

## Constraints

- Stored data stays readable by the previous release: new content fields are optional, the previous parser strips them.
- No second write path: every object write goes through the command route or `/ops`.
- `canvasEnabled` still gates every route.
- Public repo: no host names, addresses or ports in committed text.

## Decisions made while building

- The embed frame record uses its own `canvas` origin kind, not `managed`, so it is never listed as a tab and is removed with its object.
- `canvas_link_preview` writes nothing; the caller writes the result through `canvas_update`.
- A restored text draft is resent once only when it came from storage at load; a draft refused in this session still waits for the user.
- A closed sub-canvas keeps its children in the DOM and hides them with `visibility`, so the PC3 read-view test now expects `data-view="out"` rather than a visible child.

## Open questions

None.
