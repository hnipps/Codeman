# Ambient capture spike (W-49)

Goal: from any Codeman page, a person draws around what bothers them, adds a note, and Codeman files it as a Work item. They never leave what they were doing. This spike answers W-49's four questions with evidence. It ships a throwaway demo and proposes build items. It does not ship the feature.

Everything in this folder is throwaway. Codeman does not load any of it.

| File | What it is |
| --- | --- |
| `demo.html` | Freeze, draw and send on a mock shell with a WebGL terminal, a canvas object, a sandboxed prototype frame, a hover state and a toast. Press Ctrl+Shift+X or Capture. |
| `check-demo.mjs` | Drives the demo headlessly, draws a loop, sends a note and checks the bundle. |
| `probes/probe-rasterisers.mjs` | Compares two DOM rasterisers with tab capture on `probes/fixture.html`. |
| `probes/probe-patches.mjs` | Measures the two fixes that make the DOM path see a terminal and a sandboxed frame (`probes/fixture2.html`). |
| `prototype/` | The UI prototype for the W-89 spec (`intent/2026-11-19-ambient-capture.md`), published on the canvas as `w89-ambient-capture`. It is a mock of the dashboard, with `index.html` for desktop and `phone.html` for the phone. It needs no network. |
| `probes/probe-filing.mjs` | Files a bundle from `check-demo.mjs` as a real Work item with its four attachments, over plain HTTP, against a running Codeman. Takes the bundle folder, the base URL and a workspace id. |

Run each script with node from the repository after `npm install`, for example `node docs/spikes/w-49-ambient-capture/probes/probe-patches.mjs`. `check-demo.mjs` takes the demo folder and an output folder as arguments, and writes the bundle there, `capture.json` included. The pages load html-to-image, html2canvas and xterm from a CDN, pinned to exact versions. On this host Chromium also needs `LD_LIBRARY_PATH=~/.codeman/mermaid-runtime/lib`.

All numbers below were measured on 2026-11-17 in headless Chromium 148 (Playwright 1223 build, SwiftShader WebGL, device scale factor 1).

## Checklist against the item

Added 2026-11-18 in answer to the review note "Did you do these and answer the questions?". Each line says what was done and how it was checked. Measured means a script in this folder produced the result. Inferred means it was reasoned from code or documentation and not run. Not verified means it was neither.

### Requirements

| Requirement | Status | Evidence |
| --- | --- | --- |
| Everything, everywhere | Partly. Each kind of surface was tested, but the live dashboard was not. | Measured on the probe pages: plain DOM, 2D canvas, WebGL terminal (with `WebglAddon(true)`), sandboxed frame (with self-capture), hover state. Settings, the Work view and side panels are plain DOM, so they fall in a measured class (inferred). Capturing the real dashboard with 6 tiles is build item 1. |
| Exactly what the person sees | Close, not exact by construction. | A DOM rasteriser redraws the DOM in the page. On every measured surface its pixel matched the expected colour (table under question 1). Only tab capture is exact by construction, and it was not run here (no display on this host). |
| Freeze first, then draw | Done in the demo. | Measured: the hover colour is still in `clean.png` after the pointer moves to draw. Freeze took 136 to 188 ms on the demo page. A toast that ends inside that window is lost (inferred). |
| Highlight as its own layer | Done in the demo. | Measured: the bundle holds `clean.png`, the path in CSS pixels with the device pixel ratio, `marked-crop.png` and `marked-wide.png` as separate files. |
| What is under the outline | Done in the demo. | Measured: `capture.json` lists canvas object ids, DOM selectors with their text, the terminal, the frame by title, and the page facts (path, view, theme, window, ratio, build, session, case, workspace). |
| Item goes to the workspace on screen | Proposed, not built. | The demo reads the workspace from the page. Resolving it in the real shell is build item 3. The default when none is on screen is Harry's call. |
| Filing does not depend on an agent | Done, measured on 2026-11-18. | `probe-filing.mjs` against a throwaway Codeman built from master `6be75738`. The results are under question 4. |

### Questions

| Question | Status |
| --- | --- |
| 1. Desktop capture | Answered. The recommendation is a DOM rasteriser plus two fixes, both measured. Whether tab capture prompts on every capture is answered from the spec and Chromium's documented behaviour. It was not run here. |
| 2. Phone | Answered and verified on a real iPhone on 2026-11-18: pick, draw and outline, plus the shorter paste path. A saved image stood in for the hardware screenshot. |
| 3. Entry point | Answered as a proposal from the code: the shortcut registry, the xterm key handler, the frame bridge and the phone surfaces. No entry point was built. |
| 4. Attaching to a Work item | Answered and measured on 2026-11-18, now that W-42 is on master. |

## Answers

### 1. Desktop: screen capture or a DOM rasteriser?

**Recommendation.** Use a DOM rasteriser in the top document, plus two fixes Codeman controls. The rasteriser needs no permission prompt and covers every surface Codeman draws. Treat real tab capture as an optional exact-pixels mode, and do not build it first.

A DOM rasteriser on its own misses three surfaces (measured, `probe-rasterisers.mjs`). It draws each region's centre pixel as follows:

| Region | Expected | html2canvas 1.4.1 | html-to-image 1.11.11 |
| --- | --- | --- | --- |
| WebGL canvas, `preserveDrawingBuffer: false` (how Codeman builds xterm today) | `#ff0000` | `#ffffff` | `#ffffff` |
| WebGL canvas, `preserveDrawingBuffer: true` | `#00cc00` | `#00cc00` | `#00cc00` |
| Sandboxed iframe without `allow-same-origin` (prototypes, web tabs, canvas embeds, Mermaid) | `#0033ff` | `#ffffff` | `#ffffff` |
| Cross-origin iframe | `#e000e0` | `#ffffff` | `#ffffff` |
| Plain DOM | `#ffd400` | `#ffd400` | `#ffd400` |
| 2D canvas | `#00e5e5` | `#00e5e5` | `#00e5e5` |

Two fixes close the gaps that matter in Codeman (measured, `probe-patches.mjs`):

- **Terminals.** `app.js` builds the addon as `new WebglAddon.WebglAddon()`, which leaves `preserveDrawingBuffer` false. A rasteriser then reads the terminal as `#000000`. `new WebglAddon.WebglAddon(true)` (xterm addon-webgl 0.19.0) makes it read the true cell colour `#cc0000`. The same change applies to grid tiles and the split's Pane B. The GPU cost of keeping the buffer was not measured.
- **Sandboxed frames.** The parent cannot read an opaque-origin frame. The frame can rasterise itself and post a PNG back. That took 14 to 16 ms for a 200 by 100 frame. Codeman already injects a frame bridge into proxied and prototype pages (`src/canvas/frame-bridge.ts`), so a `capture` message fits there. The frame must pass its body's background colour to the rasteriser, because a cloned body loses root background propagation. Without it the area below the body content came back white (seen in the demo).

Cross-origin frames do not occur in Codeman. Web tabs and prototypes are proxied same-origin under `/webview/<cap>/` and then sandboxed, so the frame-bridge fix covers them. Same-origin frames such as the canvas full view's session page were not tested. html-to-image does not descend into iframes, so the build must rasterise `frame.contentDocument` itself and paint it into place. That is an inference from the library's behaviour, not a measurement.

Freeze cost with html-to-image was 73 to 155 ms on the probe page and 136 to 166 ms on the demo page. The live dashboard has far more DOM, so its time is unmeasured. A `:hover` state survived the rasterise: the hover button read `#00a000` while hovered. The demo kept the hover colour after the pointer moved to draw, which shows that freeze-first works. A toast that disappears inside the freeze window would still be lost, so the build should freeze before it changes anything on screen. A cross-origin stylesheet cannot be inlined, and html-to-image logs a `cssRules` SecurityError for it. Codeman serves its CSS same-origin, so this only affected the CDN-hosted demo.

**Tab capture (`getDisplayMedia`) was not verified here.** The headless shell answers `NotSupportedError`. Full Chromium in headless mode hung on the call, because this host has no X display ("Unable to open display" from WebRTC's X11 capturer). An Xvfb taken from Ubuntu's packages would not start without `xkbcomp` at its built-in path. What follows is from the Screen Capture spec and Chromium's documented behaviour, not from a run here. Every `getDisplayMedia` call needs a user gesture and shows a consent dialog. The spec does not let a browser persist a grant. Keeping one stream open after one consent avoids a prompt per capture, but it shows a "sharing this tab" bar for the whole page life and ends on reload. `preferCurrentTab` is Chromium-only, and Safari and Firefox would show a full picker. That is why tab capture should be an opt-in exact-pixels mode at most.

### 2. Phone: native screenshot plus the highlight tool

**Verified on a real iPhone on 2026-11-18** (iPhone XR, iOS 18.1.1, Safari, 414 CSS px wide at 2x). WebDriverAgent drove it through the test rig. It ran on a small probe page with the demo's pick, draw and read-back, not on Codeman. A hardware screenshot cannot be taken over WebDriverAgent, so a PNG saved to Photos from Safari ("Save to Photos") stood in for the native screenshot. All of the following was measured:

1. The person takes a native screenshot. (Stood in for, as above.)
2. They open Capture in Codeman and press Pick.
3. iOS does not open the photo grid at once. A menu comes first, offering Photo Library, Take Photo and Choose File. Photo Library opens the grid, and after the photo is tapped, iOS needs **Done**. That makes four taps: Pick, Photo Library, the photo, Done.
4. The page got the file as `image/png` with the source's exact 1,773 bytes, so iOS did not re-encode it. It decoded at 600 by 400 in 42 ms and was drawn into a canvas.
5. One touch loop on the canvas arrived as 74 pointer events, all of type `touch`. Reading the canvas back, all 73 outline segments were red, and the image pixels under the outline still read their source colours.

**The shorter path works, through the `paste` event.** Safari's image Copy, then focus a field, tap the caret and choose Paste. The event carried one `image/png` file of the same 1,773 bytes, which drew in 33 ms. That is about three taps and skips the picker. It also worked over plain `http://` on a LAN address. `navigator.clipboard.read()` could not be tested, because that API only exists in a secure context and the probe page was not served over HTTPS. Use `clipboardData.files` from the `paste` event, the route Codeman's paste-image upload already takes. Not driven: copying from the screenshot editor's "Copy and Delete", which WebDriverAgent cannot open. That it fills the clipboard the same way is inferred.

Device screenshots and step reports from this run are not committed. The rig's WebDriverAgent signing profile expired on 2026-11-17. This run used a copy of WebDriverAgent that was still running, and a fresh launch needs Harry to re-sign it at the Mac.

Capture should reuse the client admission helper `_admitPromptAttachments()` and `_promptAttachKind()` for the pick. It must not reuse `POST /api/sessions/:id/paste-image`, which writes into a session workspace. The image belongs to the Work item through W-42.

A possibly shorter path, untested: iOS's screenshot editor has "Copy and Delete". Capture could then offer Paste through `navigator.clipboard.read()`, which iOS confirms with its own Paste callout. That skips the photo picker and leaves no screenshot in Photos.

A native screenshot carries no DOM context. Capture can record only the page it was opened from. The item must label that context as where capture was opened, not as what the image shows.

### 3. Where the entry point lives

- **Desktop shortcut.** Add a registry entry `capture` in `DEFAULT_SHORTCUTS`, bound to Ctrl+Shift+X and rebindable. Codeman binds no Ctrl+Shift+X today. Like every chord, it must also be swallowed in the xterm key handler, or xterm writes the control byte into the PTY. Ctrl+Shift+S was rejected because Edge uses it for Web Capture and Firefox for Screenshot. That conflict comes from memory, not a check here.
- **Canvas page.** `canvas.html` is its own document with its own key handling. Board keys are bare letters, so a Ctrl+Shift chord does not collide. Capture must run in the top document. A full view or embed that has focus forwards the chord to the top: a same-origin page by `postMessage`, and a sandboxed page through the frame bridge, which today forwards only Escape and Q.
- **Desktop button.** Add one quiet header control on the dashboard and one in the canvas outline foot, so the feature can be found without the shortcut.
- **Phone.** A Capture button in the phone overview home screen and in the canvas phone dock. Use a button, not a gesture: multi-finger gestures collide with iOS, terminal touch (tap, long-press and swipe) and canvas drawing.

### 4. Attaching the image to a Work item

W-42 is on master. It adds `attachments` to an item, an upload route that reuses the prompt-upload rules (`ALLOWED_DOCUMENT_EXTS` and `imageMagicMatchesExt`) and a raw route. Filing takes two steps, and neither involves an agent:

1. `POST /api/canvas/:workspaceId/work` with a `requestId`, a title from the note's first line, and the note as the description.
2. `POST /api/canvas/:workspaceId/work/:key/attachments?name=...` once each for `clean.png`, `marked-crop.png`, `marked-wide.png` and `capture.json`.

Measured on 2026-11-18 with `probe-filing.mjs`, against a throwaway Codeman from master `6be75738` on this host:

- The item existed once the create call returned, 65 ms after it was sent. A second create with the same `requestId` returned the same key in 10 ms, so a retry cannot file twice.
- Each attachment took 17 to 34 ms. The item read back with four attachments: three `image/png` and one `application/json`.
- The stored `clean.png` came back byte for byte the same as the file sent.
- The item landed in Backlog, the create route's default. The build should decide whether captures land in Needs refinement instead, as the Work tool describes for new captures.

`capture.json` holds the path in CSS pixels with the device pixel ratio, what lies under the outline, and the page facts. In the demo's bundle:

- `under` listed `obj-sticky-1` (a `data-object-id`), the terminal (`terminal: true`), the prototype frame by title, and DOM selectors with their own text.
- `page` listed the path, title, theme, window size, device pixel ratio, build hash, session, case and workspace.

The workspace is the one on screen: a canvas page's own, or the canvas workspace of the shown session's case. With neither, a default applies, and choosing that default is Harry's call.

## Proposed build items

1. **Capture core, desktop.** Rasterise the top document, recurse into same-origin frames, paint frame-bridge captures into place, and use `WebglAddon(true)` for the main terminal, tiles and Pane B. Measure the freeze time on a real dashboard with 6 tiles, and the WebGL frame time before and after. Needs a vendored rasteriser (decision below).
2. **Highlight layer and context.** The freeze overlay, freehand outline, note, Redraw and Cancel. It keeps the clean image, the path and the marked crop and wide shot separate. It records what is under the outline: canvas object ids, selectors and text, page, theme, window, build, session and case.
3. **Filing.** Resolve the workspace, create the item, attach through W-42 and keep a retry-safe outbox. The routes exist and the two-step filing is measured (question 4).
4. **Entry points.** The `capture` registry entry, the xterm swallow, chord forwarding from frames, and the header, outline and phone buttons.
5. **Phone capture.** Offer Paste first (the `paste` event) and Pick second, both through the admission helper, then draw with touch. Both were proven on a real iPhone (section 2).
6. **Optional: exact-pixels mode.** Tab capture on desktop Chromium with one consent per page load. Build it only if item 1 shows a real gap.

## Decisions only Harry can make

- **Vendor a DOM rasteriser.** html-to-image 1.11.11 is MIT and about 20 KB minified. Writing an SVG `foreignObject` rasteriser in-house is the alternative.
- **The default workspace** for a capture made where no workspace is on screen.
- **The shortcut.** Ctrl+Shift+X is proposed.

## Ticket 1 measurements (2026-11-20)

Acceptance check 4 of `intent/2026-11-19-ambient-capture.md`, run on branch `build/w-93-capture-core` (W-93). A throwaway instance served the dev tree with 7 shell sessions: one in the main terminal, six printing a line a second in the tile grid. Playwright's headless Chromium shell 1223 ran with SwiftShader WebGL at a 1600 by 1000 viewport. The host is a 4-core VM. All numbers are measured.

**Freeze time, call to PNG blob, 10 captures each. Budget: 95th percentile under 400 ms at ratio 1, under 800 ms at ratio 2. Missed.**

| View | Ratio 1 p95 (median) | Ratio 2 p95 (median) |
| --- | --- | --- |
| Main terminal, single view | 2249 ms (1169) | 1712 ms (1294) |
| Six-tile grid | 2185 ms (2106) | 2297 ms (2192) |

Where the time goes, at ratio 1, three runs each:

| Step | Single view | Six-tile grid |
| --- | --- | --- |
| html-to-image `toSvg` (clone, inline every computed style, serialise) | 690 to 850 ms, 6.4 MB SVG | 1310 to 1350 ms, 11.7 MB SVG |
| Same with the font CSS computed once and reused | 690 to 720 ms | 1310 to 1350 ms |
| Decoding the SVG image | 340 to 350 ms | 550 to 640 ms |
| Drawing and PNG encoding | 140 to 1060 ms | 180 to 190 ms |

The grid has 4857 elements, of which 1141 are rendered. The library copies each rendered element's whole computed style inline. That copy, and the decode of the large SVG it makes, is the cost. Font embedding is not, so caching the font CSS does not help. Before unrendered HTML was filtered out, the dashboard's SVG was 56 MB, and Chromium refused to load it.

**WebGL frame cost. Budget: 95th percentile rises by no more than 2 ms, and the GPU-stall watchdog does not trip. Not resolvable on this host.** The main terminal streamed for 30 s with `WebglAddon()` and then with `WebglAddon(true)`. Both runs had the same requestAnimationFrame cadence: p95 216.7 ms, median 116.6 ms, about 260 frames. The watchdog did not trip, and the sticky disable marker stayed unset. Under SwiftShader the page draws about 9 frames a second, and the intervals fall on 16.7 ms steps. So a 2 ms difference cannot be seen in this setup. It needs a real GPU and a per-frame render timer.
