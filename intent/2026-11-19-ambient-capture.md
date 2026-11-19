# Intent: Ambient capture (spec)

**Status:** Draft (revision 1, spec for the owner's Spec review of Work item W-89. Built on the W-49 spike, `docs/spikes/w-49-ambient-capture/README.md`, and its intent `intent/2026-11-17-ambient-capture-spike.md`. The owner settled the spike's three open decisions and a fourth on 2026-11-19; they are recorded under Decisions for Harry.)

## Problem statement

A person who sees something wrong in Codeman has to leave what they are doing to report it: switch to the canvas, open the Work view, write an item, take a screenshot somewhere else and attach it. Most small annoyances are never filed because of that cost. Codeman has no way to capture what is on screen, mark a region and file the result. `canvas_screenshot` is a server-side re-render of a canvas, and it cannot see panels, chrome, terminals or live embeds.

## Outcomes

1. From any Codeman page on desktop (the dashboard, the canvas page, a canvas full view, Settings, the Work view), one chord or one button freezes the screen exactly as the person sees it.
2. On the frozen picture the person draws a freehand outline around what bothers them, types a note, and presses Send. Redraw clears the outline, and Cancel or Escape returns to the page as it was.
3. Send files a Work item at once, in the workspace on screen, in **Needs refinement**. The person stays where they were. A toast names the new item (for example "Filed W-12") and links to it.
4. The item carries four attachments: the clean picture, a crop with the outline drawn on it, the whole picture with the outline drawn on it, and `capture.json`. That file holds the outline path and what lay under it: canvas object ids, terminals, frames, DOM selectors with their text, and the page facts (path, view, theme, window size, pixel ratio, build, session, case, workspace).
5. On a phone, the person takes a native screenshot, opens Capture from a button, pastes or picks the screenshot, draws with a finger, adds a note and sends. The item says where capture was opened, and does not claim the page facts describe the image.
6. A capture that cannot be filed right now (server unreachable, a deploy switching colours) is kept on the device and filed later without filing twice.

## Constraints

- **Filing never depends on an agent.** Filing is two plain HTTP calls from the browser: the Work create route and the W-42 attachment route. No session, routine, MCP tool or `claude -p` call takes part.
- **No new key on a strict schema and no change to the Work file format.** `CreateWorkSchema` already accepts `requestId` and `status`, and attachments already exist (W-42). Rule 5 (the previous release reads the data) holds because nothing new is stored server side except through those routes.
- **Rule 6.** The only server write is through existing Work routes, which already require the live colour (`requireCanvasWriter`). The one new route reads only.
- **The frame bridge stays self-contained** (`src/canvas/frame-bridge.ts`): no import, its limits arrive as its one argument, and every message from a frame is untrusted.
- **The shortcut registry is the only place a chord is defined.** Every xterm key handler swallows it (`attachCustomKeyEventHandler` for Pane A in `terminal-ui.js`, for tiles and Pane B in `terminal-tile.js`, and for teammate terminals in `panels-ui.js`), or xterm writes a control byte into the PTY.
- **Text reaches the DOM through `textContent`.** The note, frame titles and DOM text read into `capture.json` are never rendered with `innerHTML`.
- **Prompt-upload admission is reused on the phone.** A pick or paste is admitted through `_admitPromptAttachments()`, which classifies through `_promptAttachKind()`. Capture never calls `POST /api/sessions/:id/paste-image`, which writes into a session workspace.
- **Generated files are not committed.** The vendored rasteriser is produced by a script from an exactly pinned npm package, as the XLSX preview's bundles are.
- **The 8 GiB host.** Browser tests for this feature run one file at a time. Nobody runs the full suite.
- **Public repository (rule 8).** No hostnames, ports, paths or personal examples in committed files, fixtures or test captures.

## Invariants

## I1: FreezeComesFirst

The clean picture is rasterised from the page as it was when the chord or button fired. Capture changes nothing on screen until the rasterise has finished: no overlay, no spinner, no focus change. A toast on screen at that moment is held (its removal timer paused) until the rasterise ends, so it is in the picture. No element of the capture UI (`[data-codeman-capture]`) appears in the clean picture.

- *Why:* outcome 1. The thing that bothers the person is often transient (a hover, a toast, a half-drawn state).
- *Failure condition:* a toast visible at the trigger is missing from `clean.png`, or any pixel of the capture overlay is in it.
- *Test:* a browser test shows a toast with a 50 ms lifetime, fires capture 10 ms later, and finds the toast's colour at its box in `clean.png`. A second case hovers a button, fires capture, moves the pointer, and finds the hover colour.

## I2: LayersStaySeparate

`clean.png` never carries a mark. The outline is stored in `capture.json` as a path in CSS pixels with the device pixel ratio and the scale used. `marked-crop` and `marked-wide` are derived from the clean picture and that path, and only from them.

- *Why:* outcome 4. An agent or a person must be able to see the unmarked pixels, and redraw or move the outline.
- *Failure condition:* `clean.png` differs from the frozen picture, or redrawing the stored path onto `clean.png` does not reproduce `marked-wide`.
- *Test:* a unit test draws a known path onto a fixture image with the shipped draw function and compares the result with the bundle's `marked-wide` pixel for pixel; `clean.png` is byte-identical to the frozen blob.

## I3: NoPasswordLeavesThePage

The value of an `input[type=password]` never appears in a captured picture or in `capture.json`. The rasteriser's clone replaces it with the same number of bullet characters, and the context reader skips it.

- *Why:* a capture lands in a workspace other people and agents can read.
- *Failure condition:* a password field's value, or a picture of it, is in the bundle.
- *Test:* a browser test fills a password field with a known string, captures, and searches `capture.json` for it; the field's box in `clean.png` matches a render of bullets, not of the string.

## I4: OnlyAPersonFiles

A Work item is created only by a Send press in the top document's capture panel. A message from a frame, a forwarded chord, or the outbox replaying a capture a person already sent are the only other triggers that reach capture, and none of them files a new capture: a frame can open the overlay, and the outbox can only finish a send that already happened.

- *Why:* frame messages are untrusted (the page can post them itself), and filing is the person's act.
- *Failure condition:* any path other than Send calls `POST /api/canvas/:workspaceId/work` with a capture that has no outbox entry.
- *Test:* a browser test posts the forwarded-chord message from a sandboxed frame page and checks the overlay opens and the network log has no Work create until Send is clicked.

## I5: FilingIsRetrySafe

Each capture gets one `requestId` (a UUID) when Send is pressed, and keeps it through every retry. Creating again with that id returns the same item (`createWorkItem` already does this). Before each attachment upload the outbox reads the item and skips a name that is already attached, so a retry after a partial upload adds only what is missing. A filed capture ends with exactly one item and exactly its four attachments.

- *Why:* outcome 6. The attachment route is not idempotent by itself.
- *Failure condition:* a retry makes a second item, or an item ends with a duplicated or missing attachment.
- *Test:* a route-level test drives the outbox against `app.inject()` and fails the second attachment once, then retries twice; the item has four attachments with distinct names. A second case replays the create after success; the key is the same.

## I6: CapturesLandInNeedsRefinement

The create call always sends `status: "needs-refinement"`. It never relies on the route's default, which is Backlog.

- *Why:* owner decision 4, 2026-11-19.
- *Failure condition:* a filed capture is in any other status.
- *Test:* the filing test reads the item back and checks its status; a unit test checks the request body the filing module builds.

## I7: TheWorkspaceIsTheOneOnScreen

The workspace is chosen in this order, and `capture.json` records which rule chose it (`workspaceRule`):

1. `page`: the canvas workspace the page shows (the canvas page, or the canvas shell view).
2. `session`: the canvas workspace of the shown session's case.
3. `home`: the canvas workspace of Codeman's own case (owner decision 2, 2026-11-19).

A rule applies only when the person may write that workspace. With none, Send is refused in the panel with a reason, and the capture stays in the panel so nothing is lost.

- *Why:* outcome 3, and multi-user mode separates workspaces.
- *Failure condition:* an item lands in a workspace other than the first rule that applies, or in one the person may not write.
- *Test:* a unit test of the pure resolver over each combination of page, session and home facts; a route test checks the home-case route refuses a non-admin in multi-user mode.

## I8: FramePicturesAreUntrusted

A picture posted by a frame is painted only inside that frame's own box, only after it decodes as a PNG within the size cap, and only if it answers the parent's `requestId` within 500 ms. A frame that does not answer in time, or answers with something else, is painted as a neutral placeholder labelled "Frame not captured", and `capture.json` marks it `captured: false`. A frame's answer never delays the freeze by more than 500 ms.

- *Why:* the frame bridge's rule. A page can post any message.
- *Failure condition:* frame pixels appear outside the frame's box, a non-PNG answer is drawn, or a silent frame blocks capture.
- *Test:* browser tests with a frame that answers correctly, one that answers with a JPEG data URL, one that answers with a picture larger than its box, and one that never answers.

## I9: PhoneContextIsLabelled

A capture made from a pasted or picked image records the page facts under `openedFrom`, not `page`, has no `under` list, and the item's description says "Where capture was opened:" before the path.

- *Why:* a native screenshot carries no DOM context, and the page Capture was opened from may not be the page in the picture.
- *Failure condition:* a phone capture's bundle or description presents the opening page as the picture's context.
- *Test:* a unit test of the bundle builder with `source: "image"`; a browser test at phone width pastes a PNG and reads the filed description.

## I10: TheChordNeverReachesThePTY

The capture chord, with its default or a rebound binding, typed while a terminal has focus (Pane A, a grid tile, split Pane B or a teammate terminal) opens capture and writes no byte to the PTY.

- *Why:* the shortcut-registry rule. Ctrl+Shift+X would otherwise reach the CLI as a control byte.
- *Failure condition:* the PTY receives input when the chord is pressed in a focused terminal.
- *Test:* a browser test focuses each kind of terminal, presses the chord, and checks the session's input log is unchanged; repeated after rebinding the chord.

## Non-goals

- **W-50, the intake routine.** Turning a capture into a spec, a fix or a question is follow-on work. This spec files the item and stops. Nothing here enables a routine, and filing never waits for one.
- Video, screen recording or annotation beyond one freehand outline and a note.
- Capturing pages outside Codeman, or other browser tabs.
- Native apps or a browser extension.
- Editing a capture after it is filed. The attachments are ordinary W-42 attachments and can be removed or added like any other.
- Tab capture (`getDisplayMedia`) unless ticket 1's measurements show a gap (ticket 7).
- A phone gesture to start capture. Phones get a button only.

## Acceptance checks

1. `npm test -- test/capture*.test.ts` passes. Each of I1 to I10 has one or more cases marked `// Invariant I<N>: <Name>`, in the unit suite or the browser suite.
2. The browser tests for this feature pass, each file run on its own with `npm run test:browser -- <file>`, and the file count printed is not zero.
3. `bash deploy/test.sh` and `npm run build` pass, and the build writes `dist/web/public/vendor/html-to-image.<hash>.js`.
4. **Freeze time and WebGL cost, on a real dashboard (ticket 1).** On a throwaway instance with 6 live sessions in the tile grid plus the main terminal, in desktop Chromium at device pixel ratio 1 and 2:
   - Freeze time, from the chord to the clean blob, over 10 captures: the 95th percentile is under 400 ms at ratio 1 and under 800 ms at ratio 2.
   - Main terminal frame time with `WebglAddon(true)` against `WebglAddon()`, while a session streams output for 30 s: the 95th percentile rises by no more than 2 ms, and the GPU-stall watchdog does not trip.
   - The numbers are written into ticket 1's PR and into `docs/spikes/w-49-ambient-capture/README.md` under a new dated heading. If either budget is missed, ticket 1 stops and escalates with the measurements (trigger: a constraint cannot be met).
5. **Every surface is in the picture.** On the same instance, one capture of the dashboard shows the main terminal's text, a tile's text, an open Settings panel, and a canvas full view with a prototype embed. A canvas-page capture shows a sticky, a Mermaid frame (as a placeholder or its pixels, labelled either way) and a web tab. Checked by a script that samples known colours in `clean.png`.
6. **Filing by hand.** On the throwaway instance, desktop: press Ctrl+Shift+X on the dashboard with a session of a case shown, draw, write a two-line note, Send. A toast names the item. The item is in that case's workspace, in Needs refinement, its title is the note's first line, and it has four attachments. Repeat on the canvas page and with no session shown (it lands in Codeman's own case).
7. **Outbox.** Stop the throwaway server between Send and the first attachment (a test hook delays the uploads), restart it, reload the page. The capture files once, with four attachments.
8. **Phone, by hand on a real iPhone.** Take a screenshot, copy it, open Capture from the overview home screen, paste, draw, Send. Then the same with Pick. The item says "Where capture was opened:".

## Design

The spike's demo (`docs/spikes/w-49-ambient-capture/demo.html`) is the working description of the freeze, draw and send flow. This spec changes it in these places.

**Freeze.**
- The chord's handler, or the button's click handler, calls `capture.freeze()` synchronously first. `freeze()` pauses toast timers (`showToast` in `panels-ui.js` gains a hold count), records the page facts, then starts the rasterise. The overlay is created only after the clean blob exists (I1).
- The rasteriser is html-to-image 1.11.11 (`toBlob`), with `pixelRatio` set to the device pixel ratio capped at 2, a filter that drops `[data-codeman-capture]`, and a clone hook that masks password values (I3).
- **Same-origin frames** (the canvas full view's session page, `canvas.html` inside the dashboard, file previews): html-to-image does not descend into frames, so `freeze()` walks `iframe` elements whose `contentDocument` it can read, rasterises each with the same call (depth at most 2), and paints the result at the frame's box in the parent's picture. Their WebGL terminals are the same `app.js` and so carry the same fix.
- **Sandboxed frames with the bridge** (prototypes, web tabs, canvas embeds): the parent posts `codeman:capture` with a `requestId` and the box size. The bridge rasterises its own document, passing its body's computed background colour (the spike found the clone otherwise loses it), and posts `codeman:frame-capture` with a PNG data URL. The parent applies I8.
- **Sandboxed frames without the bridge** (Mermaid, `html-view`) get the placeholder.
- **Terminals.** `_initWebGL()` in `app.js` builds `new WebglAddon.WebglAddon(true)`. Correction to the spike: on master only the main terminal (Pane A) loads the WebGL addon. Grid tiles and Pane B use xterm's DOM renderer, which the rasteriser reads as plain DOM (inferred; acceptance check 5 measures it).

**The rasteriser inside a frame.** The bridge cannot import anything, so bridged pages get a second injected script, `CAPTURE_RASTERISER_SCRIPT`, built from the same vendored file, placed right after the bridge by `rewriteHtml()` and `injectFrameBridge()`. `allowFrameBridge()` adds its sha256 hash beside the bridge's, so it runs under a page's own CSP. It defines nothing on the page's globals except a frozen `__codemanCapture` the bridge calls. This adds about 20 KB (about 7 KB compressed) to each bridged page.

**Highlight layer.** A full-screen overlay (`[data-codeman-capture]`, z-index above every panel, listed in `src/web/CLAUDE.md`'s z-index stack) shows the clean picture. Pointer events draw one freehand path, closed on release. A floating panel beside the outline holds the note field, Send, Redraw and Cancel. Escape cancels, and is handled by the global Escape handler's close method, which returns early when the overlay is not open (the `closeCommandPalette()` rule). The marked crop is the outline's bounding box plus 48 CSS px, clamped to the picture.

**What is under the outline.** `elementsFromPoint` sampled on a grid inside the path (at most 400 samples), deduplicated and capped like the bridge (`FRAME_LIMITS`: 24 elements, 2000 characters of text each). It records canvas object ids (`data-object-id`), a terminal (with its session id, never its buffer text), frames (by title and object id, plus the bridge's own `codeman:query-polygon` answer for elements inside a bridged frame), and other elements by selector and text.

**The bundle.** `clean.png`, `marked-crop.png`, `marked-wide.png` and `capture.json`. If a PNG is over the Work file cap (`MAX_WORK_FILE_BYTES`, 8 MB), it is encoded as WebP at quality 0.92, then scaled down by 0.75 until it fits; the name changes to `.webp` and `capture.json` records the scale. `capture.json` has `version: 1`, `source` (`dom` or `image`), `path`, `dpr`, `scale`, `under`, `page` or `openedFrom`, `frames`, `workspaceRule`, `freezeMs` and `capturedAt`.

**Filing.**
1. Resolve the workspace (I7). The `home` rule asks a new read-only route, `GET /api/capture/home-case`, for the case name, then gets its workspace with the existing `POST /api/canvas/workspaces { caseName }`, which returns the existing workspace or makes one.
2. `POST /api/canvas/:workspaceId/work` with `requestId`, `status: "needs-refinement"`, the title (the note's first line, cut to 200 characters; "Capture: <page title>" when the note is empty), and the description (the note, then a facts line: "Captured on <path>, build <short sha>" or "Where capture was opened: <path>").
3. `GET` the item, then `POST .../attachments?name=<file>` for each file not yet attached (I5).
4. Toast "Filed W-<n>" with a link that opens the item in the Work view.

**Codeman's own case** (`GET /api/capture/home-case`). The server answers with the first case, in case-name order, whose folder is the main checkout (not a linked worktree) of a git repository that contains the commit in `CODEMAN_BUILD_ID`. Without a build id (an upstream install), it is the case whose folder is the git top level of the server's own install directory. The answer is cached for 10 minutes, git runs bounded (`probePathKind()` first, a time limit on each call), and remote and Docker cases are skipped. With no match it answers 404 `NO_HOME_CASE`. In multi-user mode only an admin gets an answer. The route is internal, not under `/api/v1`.

**Outbox.** IndexedDB database `codeman-capture-outbox`, one record per sent capture: `requestId`, workspace id, item key once known, title, description and the blobs. Every access is wrapped in `try`/`catch`. Without IndexedDB the record lives in memory and the panel says it will be lost on reload. The outbox retries on Send, on SSE reconnect and on page load, with backoff from 2 s to 5 min, and deletes the record once the item reads back with every file. A pending count shows on the capture button while records remain.

**Entry points.**
- A registry entry `capture` in `DEFAULT_SHORTCUTS` (group Panels, default Ctrl+Shift+X, Cmd+Shift+X on macOS), shown in App Settings → Shortcuts and the `Ctrl+?` overlay, rebindable, with conflicts refused by `findShortcutConflict`.
- The xterm swallow in every xterm key handler (I10), through the same registry lookup.
- `canvas.html` registers the same chord when it is the top document. When it is a same-origin frame of the dashboard, it posts `codeman:capture-chord` to the top window, which checks `event.origin` and that `event.source` is one of its own frames.
- The frame bridge gains a message `codeman:capture-keys` from the parent, carrying the current binding. A matching keydown in the frame posts `codeman:frame-key` with `key: "capture"`. The bridge sends nothing for a chord it was not told about.
- One quiet header button on the dashboard (desktop only, as the header rule requires) and one in the canvas outline foot.

**Phone.**
- A Capture button on the phone overview home screen and in the canvas phone dock. It opens a sheet with Paste first (a focused field that takes the `paste` event's `clipboardData.files`) and Pick second (a file input). Both admit through `_admitPromptAttachments()`.
- The image fills the overlay, and touch draws the outline (pointer events with `touch-action: none` on the overlay only). Send follows the same filing path with `source: "image"` (I9).

**Modules touched.**
- New: `src/web/public/capture.js` (freeze, overlay, bundle, filing, outbox), `scripts/prepare-capture-assets.mjs`, `src/web/routes/capture-routes.ts`, tests `test/capture-*.test.ts` and browser tests under `test/browser/`.
- Changed: `package.json` (pinned dependency), `scripts/build.mjs`, `src/web/public/app.js` (registry entry, `WebglAddon(true)`), `terminal-ui.js`, `terminal-tile.js`, `panels-ui.js` (swallow; toast hold in `panels-ui.js`), `index.html` and `canvas.html` (script tags, buttons), `src/canvas/frame-bridge.ts`, `packages/canvas/src/frame-messages.ts`, `src/web/webview-proxy.ts`, `src/web/CLAUDE.md` (z-index stack, capture paragraph), `docs/architecture-invariants.md` (an Ambient capture section), `docs/subsystem-rules.md` and `CLAUDE.md` (index entry).

**Risks.**
- *The live dashboard may freeze slowly.* The spike measured 136 to 188 ms on a small demo page; the real DOM is far larger. Acceptance check 4 sets the budget and ticket 1 escalates if it is missed. A fallback (rasterise only the visible viewport's subtree) is listed in the escalation, not built ahead.
- *`preserveDrawingBuffer` costs GPU memory and frame time.* Measured in acceptance check 4. The fallback, if it is too costly, is to draw the terminal's visible cells from its buffer into a 2D canvas at freeze time; it is not built ahead.
- *The rasteriser's picture is close, not exact.* Fonts, filters and some CSS (for example `backdrop-filter`) may differ. Ticket 7 exists for that case, gated.
- *A capture can hold secrets on screen* (a token in a terminal). It lands in a workspace the person may already write, which is the same exposure as attaching any screenshot. I3 covers password fields; nothing else is redacted.
- *Routines may react.* A canvas routine enabled on "entering Needs refinement" will see captures. That is how W-50 is meant to plug in later; nothing in this spec enables one.

## Decisions for Harry

All four were settled by the owner on 2026-11-19.

1. **Rasteriser: vendor html-to-image 1.11.11** (MIT, about 20 KB). It is pinned exactly in `package.json` as `"html-to-image": "1.11.11"`. `scripts/prepare-capture-assets.mjs` copies its UMD build (`dist/html-to-image.js`), with source-map comments stripped, into a vendor folder: `src/web/public/vendor/` for dev (by `postinstall`, gitignored like the XLSX bundles) and `dist/web/public/vendor/` for the build. It is cache-busted the way the other page scripts are: `scripts/build.mjs` lists `vendor/html-to-image.js` in its hashed assets, so the build renames it to `html-to-image.<hash>.js`, rewrites the references in `index.html` and `canvas.html`, and the service worker precaches it. In dev the `?v=<mtime>` rule covers it. The frame-side copy is the same file's text, read once at server start and injected inline with its hash in the CSP.
2. **No workspace on screen: Codeman's own case.** Captures go to the canvas workspace of Codeman's own case, found as described under Design. When it cannot be found, Send is refused with a reason and the capture stays in the panel.
3. **Shortcut: Ctrl+Shift+X** (Cmd+Shift+X on macOS), rebindable through the shortcut registry.
4. **New captures land in Needs refinement.** The create route defaults to Backlog (measured by the spike), so filing sends `status: "needs-refinement"` explicitly (I6). No route default changes.

## Checks run

- **Spike evidence**, from `docs/spikes/w-49-ambient-capture/README.md` (2026-11-17 and 2026-11-18): the rasteriser comparison, both fixes, freeze-first with a hover state, the two-step filing against a throwaway server (create 65 ms, a repeated `requestId` returned the same key, each attachment 17 to 34 ms, `clean.png` byte-identical), and paste and pick on a real iPhone.
- **Code read for this spec**, on master `30642161`:
  - `CreateWorkSchema` (`src/canvas/work.ts`) accepts `requestId` and `status`, defaulting to `backlog`. `createWorkItem` returns the existing item for a known `requestId`, and the id is stored on the item, so the guard does not expire.
  - The attachment route (`canvas-work-routes.ts`) appends on every call, so retry safety on attachments must come from the client (I5). Files are capped at 8 MB (`MAX_WORK_FILE_BYTES`) and 20 per item (`MAX_WORK_ATTACHMENTS`); `.json` and `.webp` are admitted.
  - `app.js` builds `new WebglAddon.WebglAddon()` in `_initWebGL()`, and no other file creates a WebGL addon: tiles and Pane B do not use it. This corrects the spike, which said the change applies to them too.
  - No entry in `DEFAULT_SHORTCUTS` binds Ctrl+Shift+X.
  - The frame bridge is injected inline and allowed by its sha256 in a page's CSP (`allowFrameBridge()`), so a second hashed inline script can follow the same path. It forwards only Escape and bare Q today.
- **Not run:** no consistency audit by a separate agent, and no new measurement. The freeze and WebGL numbers on a real dashboard are acceptance check 4, owned by ticket 1.

<details><summary>Tickets (7)</summary>

**Ticket 1: Capture core, desktop.** Order 1. No dependencies.
- Pin and vendor html-to-image (Decision 1), `capture.freeze()` for the top document and same-origin frames, the toast hold, password masking, the capture-UI filter, and `WebglAddon(true)` for the main terminal.
- No UI. A test hook calls `freeze()`.
- I1 and I3, plus acceptance checks 3 and 4. The measurements decide whether ticket 7 is built.

**Ticket 2: Frame-bridge capture.** Order 2. Depends on ticket 1.
- `codeman:capture` and `codeman:frame-capture` in the bridge and `frame-messages.ts`, the inline rasteriser script and its CSP hash, painting into place, and the placeholder for frames without the bridge.
- I8, plus acceptance check 5.

**Ticket 3: Highlight layer and context.** Order 3. Depends on ticket 1.
- The overlay, freehand outline, note panel, Redraw, Cancel and Escape, the crop and wide renders, the `under` reader (including the bridge's polygon answer once ticket 2 is in), and the `capture.json` builder.
- I2, and I9's bundle half.

**Ticket 4: Filing and outbox.** Order 4. Depends on ticket 3.
- The workspace resolver, `GET /api/capture/home-case`, the two-step filing with `status: "needs-refinement"`, the size fallback to WebP, the IndexedDB outbox, and the "Filed W-n" toast.
- I4, I5, I6 and I7, plus acceptance check 7.

**Ticket 5: Desktop entry points.** Order 5. Depends on ticket 4.
- The `capture` registry entry, the xterm swallow in every xterm key handler, `canvas.html`'s chord and its forwarding, the bridge's `codeman:capture-keys`, and the header and outline-foot buttons. This ticket makes the feature reachable.
- I10, plus acceptance check 6, and the doc updates (`docs/architecture-invariants.md`, `src/web/CLAUDE.md`, `docs/subsystem-rules.md`, the `CLAUDE.md` index).

**Ticket 6: Phone capture.** Order 6. Depends on tickets 4 and 3.
- The Capture buttons on the overview home screen and the canvas phone dock, the Paste-then-Pick sheet through `_admitPromptAttachments()`, touch drawing, and the `openedFrom` labelling.
- I9's filing half, plus acceptance check 8.

**Ticket 7 (gated): Exact-pixels mode.** Order 7. Built only if ticket 1's measurements, or acceptance check 5, show a surface the rasteriser gets visibly wrong. Otherwise it stays in Backlog.
- Tab capture through `getDisplayMedia` with `preferCurrentTab` on desktop Chromium, one consent per page load, offered as an opt-in setting. Other browsers keep the rasteriser.
- Its own invariants and checks are written when it is unblocked.

</details>
