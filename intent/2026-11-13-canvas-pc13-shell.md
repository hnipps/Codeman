# Intent: Make the canvas Codeman's shell (PC13)

**Status:** Draft

## Problem statement

Codeman opens on a tab dashboard. The canvas is one tab inside it, opened from the case picker. The product documents say the canvas is the workspace and the dashboard is only the delivery shell, but nothing a person does today starts on the canvas: sessions are found in the tab strip, a workspace is opened from a tab, and the phone lands on a session overview. A person who wants to work on the canvas must go through the dashboard every time.

## Proposed outcome

With a new setting on, `/` opens the canvas of the workspace last used on that device. The outline switches and creates workspaces and lists the workspace's live sessions with their state. Any session's terminal opens as a full view over the canvas and closes back to it with the camera, selection and rail as they were. The dashboard stays whole at `classic`. A canvas that cannot load sends the person to the classic view with a notice, and can never loop or lock them out. With the setting off, nothing changes.

The design, the surface inventory and the acceptance criteria are the section "Canvas shell (PC13)" of `docs/agentic-canvas/canvas-ui-ux-brief.md`. This file scopes the build.

## Affected users and systems

- The owner, on a laptop and a phone.
- The root route, the settings schema and the canvas page route in `src/web/server.ts` and `src/web/schemas.ts`.
- The canvas client in `packages/canvas/` and its document `src/web/public/canvas.html`.
- The dashboard's single-session page and header (`src/web/public/app.js`, `index.html`), for a link back and nothing else.
- The service worker's notification click (`src/web/public/sw.js`), read by the canvas page.
- Upstream merges: the dashboard code is kept, so they still apply.

## Constraints

- The shell adds no second write path to a pane. The canvas page sends no session input and opens no terminal socket.
- Sessions write nothing to the canvas operation log. PC13 adds no object type and no operation kind.
- The classic route loads no canvas file.
- `canvasShellEnabled` is synced, default off, independent of `canvasEnabled`. A `GET` never writes.
- Stored data rolls forward. The previous release ignores the new key and still saves settings (`docs/self-building.md`, rule 5).
- No new unauthenticated response. The lost-frame rules in `src/web/middleware/auth.ts` stay as they are.
- The phone makes no canvas edits (existing rule, `packages/canvas/src/mobile.ts`).
- No hostnames, addresses, ports in use, usernames or server paths in the change.
- Do not turn the setting on by default in this change. The close-the-program step does that.

## Open questions

- Whether a previous release's Settings save sends back a synced key it does not know. `SettingsUpdateSchema` is strict (`src/web/schemas.ts`), so if the old client echoes the key, its save fails after a rollback. `canvasEnabled` set the precedent; the builder must prove it with a test before merge (test 6 below).
- Whether the single-session page draws the file preview, the Git indicator and the attach controls the inventory expects of it. `styles.css` hides only the tab strip, sidebar, header stats, notifications, multi-monitor, split, tiles, plan usage, the reboot banner and the lifecycle log in `body.solo-mode`. The builder confirms each "Full view" row of the inventory in the browser and moves a row to classic-only in the brief if the page does not draw it.
- Whether Ctrl+Shift+Backspace is free on every target browser and platform. It is a default in a rebindable registry; remap it if a check fails.
- Whether the first-run state should be a second small bundle or a branch in the main entry. See "Canvas bundle changes".

## Implementation scope

### What the code does today (read before building)

- `src/web/server.ts`: `GET /` answers the lost-frame page for a credential-free framed request, else `renderIndexHtml()`. `GET /index.html` and `GET /session/:id` also call `renderIndexHtml()`; the latter passes the session id and the page enters single-session ("solo") mode. `GET /canvas/:workspaceId` returns 404 unless `canvasEnabled`, checks the workspace against `readWorkspaces()` and `canAccessOwned()`, returns a plain 503 when `canvas.js` is missing, and otherwise reads `canvas.html` from disk on every request, rewrites `<base href>` with `joinBasePath()`, adds a viewer meta tag and runs `cacheBustAssets()`. `index.html` is read once, in the constructor, into `indexHtmlTemplate`.
- `src/web/server.ts`: `rewriteUrl` strips the base path with `stripBasePath()` before routing, so a new route needs no base-path code of its own.
- `src/web/middleware/auth.ts`: every response carries `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`, so Codeman may frame its own pages. `serveLostWebviewFrame()` never answers a registered route other than `/`, so a framed `session/<id>` is safe. A framed `/` without credentials is answered with the lost-frame page; the shell must not frame `/`.
- `src/web/schemas.ts`: `canvasEnabled: z.boolean().optional()` sits in the strict settings schema. `src/web/routes/system-routes.ts`: `PUT /api/settings` refuses a non-admin in multi-user mode before parsing and writes through the settings writer (`src/web/settings-writer.ts`).
- `src/web/routes/canvas-routes.ts`: `GET /api/canvas/workspaces` lists the caller's workspaces; `POST /api/canvas/workspaces` makes one for an existing case and needs the live deploy colour; the per-workspace scope's `preHandler` checks ownership. `src/web/routes/case-routes.ts`: `GET /api/cases`, `POST /api/cases`. `src/web/routes/session-routes.ts`: `GET /api/sessions`, `POST /api/quick-start`.
- `src/canvas/workspace-registry.ts`: a workspace is `{ id, caseName, owner? }` in `workspaces.json`.
- `packages/canvas/src/entry.ts`: the workspace id is the last path segment of the address, read once at module load; the workspace name comes from `GET /api/canvas/workspaces`. `packages/canvas/src/commands.ts`: rail views are `keys | reader | thread | history | assistant | tasks`. `packages/canvas/src/shortcuts.ts`: the key table. `packages/canvas/src/mobile.ts`: `isPhone()` and the touch flag. `packages/canvas/src/storage-keys.ts`: per-viewer storage keys; the camera is not stored today.
- `src/web/public/app.js`: `_detectSoloSessionId()`, `_applySoloMode()`, `_closeSoloWindow()` and the window channel that marks a session as shown in another window; `_takeUrlSession()` already follows a `#session=<id>` link in the dashboard. `src/web/public/styles.css`: `body.solo-mode` rules.
- `src/web/public/sw.js`: navigation is network-first; `/` is precached at install; the offline fallback matches with `ignoreSearch`; a notification click posts `notification-click` to the first open Codeman window or opens `/?session=<id>`.
- `src/web/public/mobile-handlers.js`: the keyboard is read from `window.visualViewport`, which is why the session page is not framed on a phone.
- `src/web/public/mobile-overview.js` and `session-ui.js`: the phone overview's Canvases section and `openCaseCanvas()` already lead from the dashboard to a canvas.

### Server changes

1. **Setting.** Add `canvasShellEnabled: z.boolean().optional()` beside `canvasEnabled` in `src/web/schemas.ts`. It is synced: not in the `displayKeys` set. The existing `PUT /api/settings` gate and writer cover the admin-only rule and `mutateSettingsFile()`; add no second writer. Add the switch as a row beside the Canvas row in App Settings (`index.html`, `settings-ui.js`), loaded only from an explicit `true` and saved by id, as `test/canvas-setting.test.ts` pins for the Canvas row. The row shows "Needs Canvas turned on" while `canvasEnabled` is off.
2. **A pure decision.** New `src/web/shell-landing.ts`: `decideLanding({ canvasEnabled, shellEnabled, viewQuery, bundlePresent, workspaces, cookieWorkspaceId, lastUsedCase })` returns `{ kind: 'classic', notice? }`, `{ kind: 'canvas', workspaceId }` or `{ kind: 'first-run' }`. Rules, in order: `view=classic` → classic (with the notice when `canvas=failed` is present); shell or canvas off → classic; bundle missing → classic with notice `missing`; a cookie id that is in `workspaces` → that workspace; the workspace whose `caseName` equals `lastUsedCase` → it; the first workspace → it; else first run. `workspaces` is already filtered by `canAccessOwned()`.
3. **`GET /`** (`src/web/server.ts`). Keep the lost-frame check first. Then read settings fresh (`readSettings(true)`), call `decideLanding()`, and answer: classic → `renderIndexHtml()` as today; canvas or first run → the canvas document through one shared helper. Never answer `/` with a redirect: the service worker precaches `/` and a redirected response cannot be served to a navigation.
4. **One helper for the canvas document.** Move the body of the `/canvas/:workspaceId` handler into `renderCanvasHtml({ workspaceId | null, shell, viewer })`. It injects, by string replacement that uses replacer functions (the rule noted in `renderIndexHtml`): the base, the viewer meta, `codeman-canvas-workspace` (empty for first run), and `codeman-canvas-shell` (`on` or `off`). `/canvas/:workspaceId` calls it with `shell` true only when both settings are on. Keep reading `canvas.html` per request.
5. **`GET /classic`.** A registered route that answers `renderIndexHtml()` with `Cache-Control: no-cache`, like `/index.html`. Register it before the static plugin. It never reads the shell setting.
6. **Classic knows two facts.** `renderIndexHtml()` injects `window.__CODEMAN_SHELL__ = { on: boolean, notice: null | 'missing' | 'load' | 'boot' }` before `</head>` with a replacer function, only when the shell is on or a notice applies, so the template stays byte-identical otherwise. The notice reason from the query is matched against that fixed list, never echoed.
7. **Sessions of a workspace.** New read route `GET /api/canvas/:workspaceId/sessions` in the existing workspace scope (ownership comes from its `preHandler`). It returns, for each live session the caller can see whose working folder is inside the case folder (the containment test the same file uses to resolve `current`): `id`, `name`, `mode`, `kind` (`terminal`, `conversation` or `task`, from `conversations.json` through the existing readers), `state` and `since`. State is derived, never stored, from the same sources `canvas-conversation-routes.ts` and `canvas-task-routes.ts` use (session busy, pane exit, approvals inbox). Bound the list at the server's session cap. Probe the case folder with the bounded probe; an unknown folder answers 503 with `describeUnknownPath()`.
8. **Counts in the workspace list.** Add an optional `sessions: { live, needsYou }` to each workspace in `GET /api/canvas/workspaces`. The field is additive.
9. **Last-used memory.** The canvas page sets a cookie `codeman_canvas_ws` (path = base path or `/`, `SameSite=Lax`, not a credential, not `HttpOnly`) when it opens a workspace. `GET /` reads it, validates it against the id pattern and the caller's workspaces, and ignores anything else. Cookies are not scoped by port, so another instance on the same host may hold a different id; validation makes that harmless.
10. **Nothing else.** No new SSE event: `packages/canvas/src/entry.ts` already subscribes to `session:working`, `session:idle`, `session:exit`, `session:deleted`, `session:error` and the `approval:*` events on `/api/events` (`sync.ts`); the Sessions section adds `session:created` and `session:updated` to that list and refetches, debounced. No change to auth, the host guard or the origin guard: every new request is same-origin and every new route is behind the normal credential check. No change to `sw.js` beyond what the canvas page reads from it.

### Canvas bundle changes (`packages/canvas/src`, `src/web/public/canvas.html`, `canvas.css`)

1. **Boot guard, in `canvas.html`, inline, first in `<head>`.** It defines `window.__canvasBoot = { ok: false, ready(), fail(reason) }`, reads the two meta tags, and for a shell page whose address is `/` replaces the address with `canvas/<id>` by `history.replaceState` before the module runs, so `entry.ts` keeps reading the id from the path. `fail(reason)` does nothing when `ok` is set, when the shell meta is off, when the page is framed, or when the address already carries `view=classic`; otherwise it calls `location.replace('./?view=classic&canvas=failed&reason=' + reason)` once. Triggers: the module script's `error` event (`load`), its `load` event with `ok` still false (`boot`), and a window `error` or `unhandledrejection` before `ok` (`boot`). The static loading state gains `<a href="./?view=classic">Open classic view</a>`, shown only when the shell meta is on.
2. **`entry.ts`** calls `__canvasBoot.ready()` after it has drawn the board or one of its own states. It writes the last-used cookie. It reads `?session=<id>` and the service worker's `notification-click` message and opens that session's full view.
3. **New `workspaces.ts`.** The workspace list and New workspace as an inline disclosure under `#workspaceName`, and the first-run state. Pure helpers (`workspaceRows()`, `caseChoices()`, name validation mirroring the server's message) are separate from the DOM code. First run needs a page with no workspace id: either a second small entry (`home.ts` → `canvas-home.js`, added to `scripts/build-canvas-bundle.mjs`) or a guarded branch at the top of `entry.ts`. Prefer the second entry: the first-run page then does not depend on the large one, and the boot guard covers both.
4. **New `sessions.ts` and `sessions-view.ts`.** Fetch and render the Sessions section; pure `sessionRows()` with the state order ported from `CodemanSessionOrder` in `src/web/public/constants.js` and a parity test against it; New session through `POST /api/quick-start` with the provider list the rail already loads (`providers.ts`). All names through `textContent`.
5. **New `full-view.ts`.** `openFullView(sessionId)` and `closeFullView()`. Frame mode when not phone and not touch (`mobile.ts`): append one `<iframe>` with `src = 'session/' + encodeURIComponent(id) + '?from=canvas&ws=' + workspaceId`, no `sandbox`, a `title`, sized to the viewport; set the canvas root `inert`; end any voice capture first (`voice-view.ts`); remove the frame on close and restore focus. Navigate mode otherwise: write the return ticket to `sessionStorage` (new key in `storage-keys.ts`: camera, selection, focus, rail view, outline state, a timestamp), then `location.assign` the same address. On boot, apply and delete a ticket for this workspace that is under twelve hours old. Accept `message` events only when `origin === location.origin` and `source` is the frame's window; `codeman:full-view-ready` clears the ten-second timer, `codeman:full-view-close` closes.
6. **Typed commands.** Add `full-view` open and close to the reducer in `commands.ts` and the view state published through `view-sync.ts` (`src/canvas/view-schema.ts` gains an optional field; the registry is in memory only, so no stored data changes). An agent can read it and issue it for a named view, and, as with the rail, an agent-issued open never moves DOM focus.
7. **Keys.** Add Go to (Mod+K, Alt+K), `S` and `W` to `shortcuts.ts` and the Keys view. Go to extends the outline search (`#search`) with grouped results; it stays a literal substring match.
8. **Outline foot.** Add **Classic view** and **Settings (classic)** links (`classic`) beside History and Keys, shown only for a shell page.
9. **Reboot notice.** On a shell page, one `GET /api/reboot-restore`; when it offers sessions, show one line in `#notice` with a link to `classic`.
10. Sessions section, workspace list, full view and the outline-foot links are absent when the shell meta is off or the page is framed.

### Dashboard changes (`src/web/public/app.js`, `index.html`, `styles.css`)

Three things and nothing else.

1. **The session page knows it came from the canvas.** When the address has `from=canvas`, the single-session page shows a **Canvas** button in place of the re-dock button, registers `back-to-canvas` (default Ctrl+Shift+Backspace) in `DEFAULT_SHORTCUTS`, swallows that chord in `attachCustomKeyEventHandler` so no byte reaches the pane, posts `codeman:full-view-ready` to its parent once its session list has loaded (also in the "session unavailable" state), and on Canvas, on the chord, or when a dashboard takes the session back: posts `codeman:full-view-close` to `window.parent` with `location.origin` as the target when framed, else navigates to `canvas/<ws>` after checking `ws` against the id pattern. It keeps the existing window-channel behaviour unchanged.
2. **A link back.** With `__CODEMAN_SHELL__.on`, the dashboard header shows a **Canvas** link to `./`. It stays off phones (`test/mobile-header-buttons-policy.test.ts`); the phone overview's Canvases section is the phone's link.
3. **The fallback notice.** With `__CODEMAN_SHELL__.notice`, a status region under the header says the canvas did not load and why, with **Try the canvas again** (a link to `./`) and **Dismiss**. Fixed strings per reason; nothing from the query reaches the DOM.

`index.html` is read once at server start, so the new markup appears after the restart a deploy already performs.

### Stored data

- `settings.json` gains `canvasShellEnabled`. The previous release ignores it.
- No canvas file changes. No new file in the data directory.
- Browser only: one cookie, one `sessionStorage` key.
- A rollback restores code only: `/` is the dashboard again, `classic` is not found on the older release (its `/` is the classic view), and the automatic fallback target `/?view=classic` still answers there.

### Tests

Unit (`npm test`):

1. `test/shell-landing.test.ts`: every row of the setting table, the `view=classic` override, missing bundle, cookie valid, cookie for another owner's workspace, cookie malformed, `lastUsedCase` match, no workspace.
2. `test/canvas-shell-sessions.test.ts`: `sessionRows()` order and kinds; parity with `CodemanSessionOrder`.
3. `test/canvas-full-view.test.ts`: frame or navigate by device; message checks (wrong origin, wrong source, unknown type ignored); ticket write, apply, expiry, wrong workspace.
4. `test/canvas-boot-guard.test.ts`: the inline guard extracted from `canvas.html` and run in a DOM: each trigger, no action when framed, shell off, or `view=classic` already present, and at most one navigation.
5. `test/canvas-setting.test.ts` extended: the Shell row loads only from `true` and saves by id.
6. Compatibility: a frozen copy of the previous settings reader and of the previous client's save body accepts a file that holds `canvasShellEnabled: true` (the pattern of `test/canvas-media-compat.test.ts`).

Route (`app.inject()`):

7. `GET /`, `/classic`, `/?view=classic`, `/canvas/:id` for the four setting combinations; `GET /` is never a 3xx; `/classic` never references `canvas.js`; missing bundle gives the dashboard with the notice flag; a framed credential-free `/` still gets the lost-frame page; all of it again under a base path.
8. `GET /api/canvas/:workspaceId/sessions`: containment, kinds, another owner's workspace is 404, canvas off is 404, unknown folder is 503.
9. Multi-user: a non-admin `PUT /api/settings` with the key is 403 and the file is unchanged; `GET /` for a non-admin opens only their own workspace.

Browser (`npm run test:browser`, added to `BROWSER_TEST_GLOBS`):

10. `test/canvas-shell.browser.test.ts`: landing, address becomes `canvas/<id>`, workspace switch and create, first run, New session makes one row, Go to, keyboard-only pass, outline and classic show the same session.
11. Full view: acceptance criteria 12 to 15, with typed input through `page.keyboard.type()` and the pane checked with a capture, never through an HTTP 200.
12. **The deliberately broken bundle**, in a throwaway instance: (a) `canvas.js` removed, (b) `canvas.js` replaced with `throw new Error('x')`, (c) the `canvas.js` request aborted, (d) scripts disabled. Each ends on the dashboard with the notice, with at most one navigation, and a second load does not navigate. Then (e) offline with a cached canvas document at `/?view=classic`: no navigation loop.

Phone (`npm run test:mobile`):

13. `test/mobile/canvas-shell.test.ts`: canvas home on `/`, Sessions first in the outline, a row navigates to the session page at the top level, on-screen typing reaches the pane (`app._localEchoEnabled = true` forced, per the testing rules), **Canvas** returns and the ticket restores the camera and rail view. No header button was added on phones.

Live checks before merge: the boot recipe of the plan, at laptop and phone sizes, under a throwaway `CODEMAN_INSTANCE`, with the shell on and off, with a password and without one, and under a base path.

### Suggested split

Three parts, each mergeable and deployable with the setting off.

1. **Routes and fallback.** The setting and its Settings row, `shell-landing.ts`, `GET /`, `GET /classic`, `renderCanvasHtml()`, the boot guard, the classic notice and Canvas link, the last-used cookie. Tests 1, 4, 5, 6, 7, 9, 12. After this part the shell lands on the canvas and can always get back.
2. **Outline.** Workspace list, New workspace, first run, the sessions route and Sessions section, New session, Go to, the reboot notice, the outline-foot links. Tests 2, 8, 10.
3. **Full view and phone.** `full-view.ts`, the session page's `from=canvas` behaviour, the return ticket, the notification click, the view commands. Tests 3, 11, 13, then the plan's verification box at laptop and phone sizes.

### Risks

- **A stale service-worker copy of `/`.** The worker caches `/` and matches offline with `ignoreSearch`, so an offline request for `/?view=classic` can be answered with a cached canvas document. The guard's rule "never navigate when the address already asks for classic" is what stops a loop; test 12(e) pins it.
- **Framing the session page.** It is the first time Codeman frames its own dashboard document. Watch for code that assumes the top window (`window.open`, `window.close`, focus, the detach channel, the service worker registration in `settings-ui.js`). The ready message and the ten-second inline error keep a bad frame from trapping the person.
- **Two clients sizing one terminal.** A full view and an open classic dashboard are two clients of one pane. The existing shown-elsewhere marking handles it; verify with both open.
- **Touch laptops and tablets.** The frame-or-navigate rule keys on the primary pointer. A tablet with a hardware keyboard gets navigation, which is correct but slower. Accepted.
- **Security and update notices are classic-only.** A person who never opens the classic view will not see a new security notice. Accepted for PC13; a canvas notice line is the natural follow-up and is not in this scope.
- **The rollback window.** Between a rollback and a reload, an open canvas page links to `classic`, which the older release does not have. Reloading `/` recovers. The automatic fallback avoids the route for this reason.
- **Scope creep.** The inventory lists 42 classic-only surfaces on purpose. A request to move one is a new intent, not part of this change.
- **Root-route regressions with the shell off.** `/` is the most used route. Test 7 asserts the shell-off response is unchanged.

## Decisions

Made while building. Each replaces what the sections above say where they differ.

### Part 1

- **`/` is never a redirect.** The canvas document is served at `/` and the page writes `canvas/<id>` into the address with `history.replaceState`. One load, and the auth, host-guard and lost-frame rules see the request they saw before.
- **The dashboard's shell flag needs both settings on.** "Server changes" says the flag is injected when the shell is on or a notice applies. With the shell off the query is ignored instead, so `/` stays byte-identical for everyone who has not turned the shell on.
- **`/classic` reads the settings.** It goes through `renderIndexHtml`, which reads them to decide on the Canvas link. It references no canvas file either way.
- **The workspace memory is a cookie** (`codeman_canvas_ws`, written by the page, path = base path, `SameSite=Lax`). The server has to choose before a script runs, so `localStorage` cannot hold it. It is checked against the caller's own workspaces and grants nothing.
- **First run is a second entry** (`canvas-home.js`), answering the fourth open question. The main entry assumes a workspace throughout.
- **No-script.** The canvas page carries a plain link to the classic view. There is no meta refresh: the dashboard needs scripts too.
- **A registry that does not parse counts as a missing canvas**: `/` answers the classic view with the `missing` notice.
- **The Canvas link and the notice are built in script**, so `index.html` gains no header markup; the link is hidden at phone width, and the notice is fixed-position so the terminal keeps its size.
- **First open question, answered.** A previous release's Settings page builds its save from a fixed list of fields and never sends `canvasShellEnabled`; the server merges a save into the stored file, so the key survives. This release's page sends the key only when its box changed, and when a rolled-back server refuses it, saves the rest and says so (`test/canvas-shell-compat.test.ts`).
- **Service worker: no change to `sw.js`.** Offline, a saved canvas document can answer a classic address; the guard does not navigate from a classic address and the page says Codeman cannot be reached.

### Part 2

- **State words.** `needs` Needs you, `error` Error, `waiting` Waiting, `working` Working, `idle` Idle, `done` Ended, each with its own glyph. An idle prompt somebody has already looked at (or one that opened quiet) reads Idle: the dashboard spends that alert the same way.
- **An exited agent reads Ended** even when the inbox still holds an item for it. Error comes first of all.
- **Counts.** `needsYou` counts blocking dialogs only. `live` leaves out ended sessions.
- **One row per session, across kinds.** The kind comes from the conversation index; an index that cannot be read leaves every row a terminal.
- **The row order is ported, not shared.** `src/canvas/shell-sessions.ts` carries a copy of `CodemanSessionOrder` and a parity test, because the canvas bundle cannot load `constants.js`.
- **Go to** lists sessions and the other workspaces for an empty query and adds objects once something is typed. Each group is bounded at eight. The current workspace is not a result.
- **New workspace** offers local cases that answered and have no canvas. Remote and Docker cases stay in the classic view, one link away.
- **The notice line** (added to the scope by the coordinator; "Risks" had it as a follow-up): one line, most pressing first: sessions to rebuild, a due security notice, a release not yet seen. "Update available" was asked for and is not built: the server has no stored answer and would have to ask GitHub on every canvas load. The line says "Codeman was updated" instead, from data already on the page's origin.
- **Reboot notice** is that same line, in the outline, not in `#notice` as "Canvas bundle changes" item 9 says: `#notice` is the connection status and is overwritten by it.
- **Settings (classic)** is `classic?open=settings`; the dashboard opens App Settings after the server's settings load and drops the parameter. Shell on only, so nothing changes with the shell off.
- **A terminal row navigates to the session's page** in this part. Part 3 frames it on a laptop.
- **Offline** uses the canvas's existing connection state. The last session list stays, marked as last known.

### Part 3

- **The switch on the session page is its address.** `from=canvas` alone turns on the Canvas button and the back chord. The page is still rendered without settings and without shell facts, as part 1 pinned; only the canvas shell writes that address.
- **The back chord is listed only where it works.** `back-to-canvas` is in `DEFAULT_SHORTCUTS` with `shellOnly`, and the registry leaves it out on every page that was not opened by the canvas. With the shell off the Shortcuts list and Ctrl+Shift+Backspace are what they were. It is rebound from the session page's own settings.
- **Canvas is a script-built button** (`#soloCanvasBtn`) where the re-dock button is; `index.html` has no new markup. It is the phone's way back, so it shows at phone width, at 44 px on a coarse pointer.
- **"Canvas root inert" is every child of `<body>` but the full view.** The canvas document has no single root element. A capture listener on `window` also stops keys, because an inert tree still lets a key reach `document` through `<body>`.
- **The ticket also carries the open sub-canvas and the session**, so the phone returns into the sub-canvas it left and focus lands on the row that opened the session.
- **An agent's open is refused on a phone.** It would navigate a person's window away. It answers success and changes nothing, like the `letters` action.
- **A notification for a session of another workspace opens the classic view** on that session, after one read of `GET /api/sessions/:id` says the caller may open it. An unknown id opens nothing. The item said only "opens that session's full view".
- **Open in classic view** is `classic#session=<id>`, the dashboard's existing session link.
- **The ready message is also sent in the "session unavailable" state**, whose button reads Back to canvas on such a page.
- **The pane in the tests is the test stand-in's.** Under vitest a session is a PTY that echoes and tmux is not run, so the typed marker is read from the session's own terminal capture on the server, not from `tmux capture-pane`.
- **Inventory rows confirmed in the frame:** terminal, voice input, the file viewer button and overlay, paste upload and the shortcut overlay are drawn by the session page. The Git indicator is opt-in per device (`showGitStatus`) and was not switched on in the check.
- **Phone outline order:** the head (name, Close) stays first, then the workspace list when open, then Sessions, then search and the tree. The dock control that opens it is still labelled Sections.

### Audit fix round 1

- **An agent's view command only steers the view.** It never starts a CLI, never raises a dialog and never takes a keystroke. An agent's open frames the session page with `passive=1`; that page shows a stopped session as stopped, with **Start session** for the person, and skips the automatic reattach and the breaker question. A person's own open is unchanged.
- **A refused open says why.** The command route cannot know the browser's focus, so it still answers success with a `commandId`. The view publishes the latest refusal as `refused: { commandId, reason }`, read with `canvas_view read`. This replaces Part 3's "answers success and changes nothing" for the phone, which now also publishes its reason. Reasons: not a shell page, session not listed, session ended, phone or touch device, the person is typing on the canvas.
- **Typing means focus in an editable element of the canvas page** (a text input, textarea, select or contenteditable). The open is refused, not queued: the agent retries. Focus inside an open full view counts as typing too, so an agent can neither replace nor close a terminal the person is working in.
- **A reload of `canvas/<id>` with a canvas file missing goes to `/`** (a 302) when the shell is on, found by the live check: the shell writes that address into the bar, and its plain 503 had no way out. `/` then answers the dashboard with the notice and never redirects, so there is no loop. With the shell off the 503 stays.
- **An agent-opened page takes no focus.** Measured in the browser suite: the framed session page focused its own terminal on load, so an agent's open did move keyboard focus and the person's next keys went to the pane; `inert` on the frame did not stop it. A `passive` page now holds every focus call until its window is focused, and the canvas covers the frame with one control that hands it over on the person's click.
- **The session list is throttled, not debounced.** 400 ms after an event, at most one fetch per 2 s, none while hidden, one on becoming visible. The route's probe drops `pastCap`.
- **Remote sessions are not listed.** Docker-case sessions stay.
- **The settings row stays editable while Canvas is off.** "Server changes" item 1 already said it shows a hint; the frontend notes said disabled and were wrong.
- **Test 7's "unchanged" reference is the template on disk**, plus equality with `/index.html` per request shape. A previous release's bytes are not available to a test.
- **Test 12(d) is a link, not a fallback.** With scripts disabled nothing can navigate by itself, so the test proves the plain link is visible and opens the classic document. That document needs scripts too, as Part 1 said.

