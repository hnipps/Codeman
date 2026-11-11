# Intent: Render a container screenshot on the server

**Status:** Draft

## Problem statement

An agent can read a canvas as text, but it cannot see the container the way a person does. There is no server render of a section, frame, group, or single object, and the name `canvas_screenshot` is only a reserved capability.

## Proposed outcome

`GET /api/canvas/:workspaceId/objects/:id/screenshot` and the MCP tool `canvas_screenshot` return a PNG of that object. The picture uses the shipped canvas renderer and the same tokens as the canvas view. The page has no login, no cookies, and no network except image bytes the server itself already stored. One render runs at a time. The browser process is closed when the render finishes, times out, or throws. With the canvas off, the route is 404 and the tool says the canvas is off. With no Chromium, the route is a 503 that names `codeman mermaid setup`.

## Affected users and systems

Agents using `codeman mcp`. Humans calling the same HTTP route. The Mermaid renderer, which now shares the headless browser launch. The canvas read view, whose embed label includes the URL so the screenshot and the view draw the same box.

## Constraints

The render page is hostile content. Object text is escaped and drawn as text. The clip comes from the store, at device scale factor 1, with a 4096-pixel cap on the long side. The caller's limit is 20 seconds, including time spent waiting for the single render slot. Stored canvas data stays forward-compatible. Mermaid sandbox, `mermaid-runtime.json`, and `libraryPath` behaviour stay as they are. `canvas_screenshot` is not a command-batch tool.

## Open questions

None for this slice. The margin is 48 pixels so a container title drawn above the box is inside the clip. A title wider than the object can still meet the clip edge. Remote image URLs are not fetched. Only a stored `data:image` of png, jpeg, gif, or webp is painted; anything else stays the view's text label.
