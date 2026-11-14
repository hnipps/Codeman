# Intent: Capture a running app as a clickable prototype, and fork prototypes

**Status:** Draft

## Problem statement

The canvas can hold a prototype only as a folder of static files someone wrote by hand. A real app, Codeman itself included, cannot run inside a canvas embed: the frame has an opaque origin, no cookie and no access to the app's API. So a design review of the real UI means screenshots, which cannot be clicked, and every new design direction starts from a blank page instead of from the UI that exists.

## Proposed outcome

An agent, or a person at a terminal, writes a short JSON spec naming a running app's address, the viewports to show and the states to reach (each a few steps: go to a path, click, type, press a key, wait for an element). `codeman prototype capture <spec> -o <dir>` or the MCP `canvas_prototype` action `capture` drives the app through those states in a headless browser and saves each state at each viewport as a static page. In each page, the element that led to a state links to it, and a small switcher lists every state and viewport. The result is published as an ordinary prototype, so it can be clicked, commented on element by element, checked and screenshotted like any other.

`canvas_prototype` action `fork` (and `POST …/prototypes/:id/fork`) makes a new prototype from a stored version of another, so a design direction starts from the captured UI and keeps a record of where it came from (`forkedFrom`).

This works for any web app reachable from the machine the agent runs on, not only Codeman.

## Affected users and systems

- Agents designing UI on the canvas, and the people reviewing it.
- `src/canvas/` (capture modules, prototype store), the prototype routes, the MCP server, the `codeman` CLI.
- No change to how prototypes are stored, served or sandboxed.

## Constraints

- Capture runs in the agent's process only, never in the Codeman server: the server must not gain a route that fetches a URL it is handed.
- The captured folder goes through the existing publish unchanged: same file-type allowlist, same limits (200 files, 5 MB a file, 12 MB a version), same frame sandbox. A capture over a limit fails before anything is published, naming the limit.
- A captured page runs no code from the app. Its only script is Codeman's own runtime, which keeps the app's links and form submits inert and stands down while the canvas is picking an element.
- A capture's `goto` stays on the spec's own origin.
- The operation log and the stored record stay readable by the previous release (`forkedFrom` is an optional field in `meta.json`).

## Open questions

- Steps cannot differ per viewport yet (a phone layout that hides a button needs its own state, limited with `viewports`).
- Hover, focus and animation states are not captured live; a state is one moment.
- Apps behind a login need the spec's `localStorage` seed or a login step; HTTP basic auth is not supported.
- A comment anchored to an element is per embed object, so after a hotspot moves the frame to another state, the selector may resolve on a different page.
