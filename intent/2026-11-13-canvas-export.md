# Intent: a person can export the open canvas or a selected object

**Status:** Draft

## Problem statement

The foundations matrix (`docs/agentic-canvas/canvas-foundations.md`, "Reading and inspection") asks that a person can capture or export a view or group. An agent can already ask for a PNG of one object (`canvas_screenshot`) and for the typed objects (`canvas_read`). A person has no control that does either, and neither side can ask for a picture of the top level of a workspace, because the screenshot takes one object id and the top level has none.

The same matrix lists flip beside rotate. `canvas_capabilities` reports flip as unsupported.

## Proposed outcome

A person opens Export from the outline, from the phone sheet of a tapped object, or with the E key. The menu offers the open canvas and the one selected object, each as an image (PNG) and as its objects (JSON). The file is saved by the browser and the page does not navigate.

The image is the answer of the screenshot route and the JSON is the answer of the `canvas_read` command, so a person and an agent that ask for the same target get the same bytes. The screenshot route and the `canvas_screenshot` tool also accept no object, which means the top level of the workspace.

Flip stays unsupported, and the journal records why.

## Affected users and systems

- A person on the canvas page, desktop and phone.
- Agents using `canvas_screenshot`: `objectId` becomes optional.
- `src/canvas/canvas-screenshot.ts`, the canvas routes, the MCP server, the canvas page bundle and the screenshot page bundle.

## Constraints

- One render path. The person's export adds no renderer and no second serializer.
- The screenshot page stays without login and without network.
- Nothing stored changes shape, so the previous release reads everything this one writes.
- Keyboard reachable, usable at phone width, no navigation.
- `packages/canvas/src/entry.ts` is shared with other work in flight, so the feature lives in its own module and entry gains only its wiring.

## Open questions

None.
