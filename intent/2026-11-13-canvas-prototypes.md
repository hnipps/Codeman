# Intent: Prototypes on the canvas that Codeman serves, and element-level feedback on them

**Status:** Draft

## Problem statement

An agent asked to prototype on the canvas reported five blockers. Checked against the code, they are:

1. No Claude session gets the Codeman MCP server. Registration is a manual `claude mcp add`, so the canvas tools are missing in canvas-started and terminal-started sessions alike.
2. A prototype can only be a board object. Canvas chrome (a rail view, a full view) cannot be prototyped where it would live.
3. `canvas_screenshot` draws every embed as a card that says "Paused", because the screenshot page refuses all network. An agent cannot see its own prototype on the board.
4. An agent that wants to check a page in a browser must launch its own headless Chromium, which lacks system libraries on some hosts. Codeman's own launcher already has them.
5. A prototype is a loopback preview owned by the agent's session. When the session or the preview ends, the embed goes blank.

Separately, comments, chat context and the hold-Q lasso only know whole canvas objects. Nothing can point at an element inside a live page.

## Proposed outcome

**Every local Claude session launches with the Codeman MCP server attached.** The launch carries one `--mcp-config` argument naming this server's own entry script. It adds to the user's servers and replaces none. A synced setting, `agentMcpEnabled` (absent means on), turns it off. Remote (SSH) and Docker sessions are not covered: this server's entry script does not exist on their side.

**A prototype is a folder of static files that Codeman stores and serves.** An agent publishes a folder with the `canvas_prototype` tool. Codeman copies it into the workspace's data as an immutable version and places (or updates) an `embed` object whose address is `https://prototype.invalid/<id>/<version>/<entry>`. The files are served by Codeman on a capability path, sandboxed like every canvas frame. No agent session, port or process is involved, so the prototype outlives the session that made it.

**A prototype is served only while its workspace is open.** A capability is minted only by the frame route, which a browser calls when the embed is on screen. Each request is refused unless some browser view of that workspace has reported in within the view registry's time limit. The browser also unloads every frame while its tab is hidden. A tab hidden for a few seconds also withdraws its view, so serving stops at once; showing it again publishes the view first and then loads the frames. A frame request refused for want of a view is asked once more after the view is published, and a prototype frame whose page never reports in is asked for again once before it shows as unavailable.

**Publishing again updates the embed in place.** The new version is a new address on the same object, so the frame reloads, undo returns to the earlier version, and comments stay on the object.

**`canvas_screenshot` shows a prototype as it renders.** The screenshot page loads the stored files through its own request handler and still makes no network request. Other embeds keep their card, with a note that says a live page is not drawn in a screenshot.

**`canvas_prototype` can check a page.** The `check` action loads a prototype in Codeman's headless browser at a given size and theme and returns a picture plus the page's console errors.

**Elements inside a live frame can be picked.** Codeman injects one bridge script into every canvas frame, prototype or proxied page. Pick element, on a selected embed, outlines the element under the pointer; a click offers Comment and Add to chat.

- A comment made that way carries the element (selector, path, text, attributes, computed styles, box, and a source location when the page marks one). The thread shows it, a pin marks it in the frame, and Ask agent hands it to the agent.
- Add to chat puts the element on the context shelf as its own chip. The sent message's context block lists it under its embed.
- Holding Q and drawing a loop wholly inside one live frame captures the elements whose centres fall in the loop. Any other loop captures objects, as before. Q is heard while keyboard focus is inside a frame.

**A prototype can stand in for chrome.** Any embed can be opened in the full view or docked in the right rail, by a person (two header actions, keys D and F, and the outline's Prototypes section) or by `canvas_view open-page` and `close-page`, so a view under design is seen at its real size and place. A slot shows an embed that is on the board; it is not an object and is not stored. There is one rail slot and one full slot. A slot's frame is sandboxed exactly like a board frame, has no element pick or lasso, and gets the keyboard only when the person clicks it or tabs into it. The full view for an embed is part of the canvas shell.

## Affected users and systems

People using the canvas on desktop, and agents in any Claude session. `src/config/cli-registry`, `src/session-cli-registry-bridge.ts`, `src/tmux-manager.ts`, `src/mcp-server.ts`, new `src/canvas/{prototypes,element-ref,prototype-address,frame-bridge,comment-anchors}.ts`, `src/canvas/{canvas-screenshot,context-resolve,commands,view-schema,conversation-schema}.ts`, `src/web/webview-proxy.ts`, the canvas routes, `packages/canvas/src/{media,context-capture,context,comments,assistant,entry,shot}.ts` and `objects/embed.ts`, `src/web/public/canvas.{html,css}`, the `codeman` skill text and its plugin mirror.

## Constraints

- Stored data stays readable by the previous release. The operation log, comments and conversation records gain no key and no object type. A prototype is an `embed`; a comment's element lives in a side file keyed by comment id; an element sent as context is written into the prompt's context block, which is stored as text.
- Frames stay untrusted. No `allow-same-origin`. The parent accepts a bridge message only from a frame it mounted, bounds every payload, and renders every string with `textContent`. Element text reaches an agent only inside the context block, through `plainLine`.
- The bridge is injected by Codeman, never fetched by the page, and a prototype's own files cannot be served outside its version folder (realpath containment, extension allowlist, no dotfiles).
- Publishing is bounded: file count, per-file and total bytes, versions kept per prototype, prototypes per workspace. Writes need the live deploy colour.
- The `--mcp-config` value is built from this process's own paths and holds no secret. It passes through the registry's typed argv, never shell text.
- No new spawn path, no process per prototype, no respawn, auto-resume, Ralph or orchestrator.
- Phones keep no live frames, as today.

## Open questions

- A prototype that needs its own server process (an API, a dev server with hot reload) is not covered. It stays a preview of the session that runs it.
- Source mapping reads a `data-source` attribute only. Framework debug metadata is not read.
