# Canvas and ambient assistant UI/UX brief

Status: Revised to the owner's latest direction. The thin right-hand assistant rail supersedes the floating conversation-card and context-picker designs. This is a design prototype, not a live model, microphone or background-agent implementation. The last section, Canvas shell (PC13), shapes the canvas as Codeman's landing page; it is a brief and is not built.

## Product and current scope

The canvas holds the work and its context. An ambient assistant is available when needed, inside this workspace. Chat is a thin right-hand panel, fully dismissible by keyboard; it is not a draggable canvas card. Comment threads are another entry point into the same real sessions. Users arrange work with agents and can initiate app changes from inside the app, preserving the existing supervised self-building path.

Keep the accepted dark Opsdeck character, no navbar, search inside the outline, and very few persistent system labels on the board. Borrow the invoked-when-needed interaction principle from [HeyClicky](https://www.heyclicky.com/), not its mascot or desktop styling. The owner's lasso gesture is a canvas-specific requirement; the reference is not evidence of that exact gesture.

Current design scope includes direct canvas context capture, voice, background agents, provider/model selection, connected comment threads and a keyboard-first interface. These supersede prior deferrals. The original eight foundation PRs are not the whole product. Native session projection, configured provider catalogs, audio capability and background execution still need implementation contracts and verification.

## Layout and discretion

On desktop the assistant occupies a 320-pixel rail at the right edge, spanning the available canvas height. It uses one subtle left border, a compact conversation title, small task and dismiss controls, a restrained transcript and a compact composer. It overlays that edge without recentering or zooming the board. Hiding it removes the panel completely: no residual tab, handle, chat card or reserved width. Canvas coordinates and selection stay unchanged. Summon it with `C` while the canvas has focus or the app shortcut Cmd/Ctrl+period. A small accessible chat control in the existing canvas tool dock is the pointer alternative.

A 192-pixel collapsible outline holds workspace navigation and Search canvas. `/` opens and focuses this search. The board itself carries user/agent content and section names, not persistent IDs, counts, authorship footers, access labels or instructions. System detail is disclosed where it is useful: message sources, an object thread, task details or an explicit error. Lasso instructions appear only while capture mode is active.

Assistant controls stay close to their task. Context references sit immediately above the composer; voice, background run and Send are small labeled/tooltip controls below it. Provider and model are compact selectors at the foot of the rail. Their keyboard commands are documented and focus the actual controls. Do not hide necessary behavior behind unlabeled decoration or shrink text until it is unreadable.

On a phone the same assistant takes the available width as a dedicated view, with a close action returning to the canvas. The outline is also a nonmodal full-height view. The composer stays above the software keyboard. No layout depends on hover or a hardware key: visible touch controls cover chat, context from the current selection, voice and tasks.

## Required canvas foundations and agent parity

The owner explicitly requires the basic FigJam-style canvas/element controls for the build: selection lassos and marquee, grouping/ungrouping, nested groups, element/group resizing, locking, movement, alignment, ordering, clipboard and history controls. [Canvas foundations](canvas-foundations.md) is the detailed capability matrix and acceptance contract. Its requirements are not optional just because the current prototype does not demonstrate them. The prototype change in this review is limited to selectable group context.

Every human canvas action also needs a structured agent capability and readable state, using the same validated commands, permissions, locks and undo semantics. This includes view/selection/context operations, not only content CRUD. Agents must not depend on pixel-based UI automation. New human controls include their agent equivalent in the same implementation change.

Stickers, washi tape, sticky-note objects and decorative workshop elements are out of scope. Keep the currently agreed object types; ordinary text remains available. The renderer must satisfy the foundations contract rather than silently narrowing it to the prototype's capabilities.

## Direct context capture, without a modal

Named groups and sections are selectable targets from their heading/bounds and the outline. Add a group to context as one named reference with its explicit nested contents, deduplicating selected descendants. The prototype demonstrates this with Design exploration.

There is no attachment dialog or context-picker overlay. Select one object, Shift-click several, or use keyboard navigation and `X` to toggle selected objects. Cmd/Ctrl+Enter on the canvas adds that selection to the next request and focuses the composer. This action does not send a blank message. A contextual Add to chat action is the pointer alternative and appears only when objects are selected. Selection by itself never silently changes a request.

Hold `Q` while the canvas has focus, then primary-drag a freehand circle or lasso. Draw a subtle temporary line and preview the objects it contains. Pointer-up while Q remains held adds the enclosed object IDs to context, deduplicates them and opens the composer. The boundary is closed for hit testing; visible object centers determine inclusion. This is object context capture, not a screenshot crop or a grouping operation. Explicitly captured containers retain their saved membership and avoid duplicate descendant references.

Releasing Q early, Escape, pointer cancellation, lost pointer capture, window blur or tab suspension cancels the unfinished gesture without changing context. Suppress accidental selection and movement only for the lifetime of the gesture. Drawing near another cluster never reparents objects. The keyboard and selection action remain alternatives when drawing is difficult or unavailable.

Context chips name objects and can be removed directly. A sent request records the reference IDs, resolved membership and actual supplied content versions. Later reads appear under Sources used. The agent can still discover the whole authorized canvas; selected context directs its initial attention rather than defining access permissions. Removing a chip changes the next request, not knowledge already in the transcript. Start a new conversation for a fresh transcript. There is no “Clear context” action that pretends to erase prior material.

## Sessions, threads and text entry

The panel projects a real session with one execution/transcript history. Closing the rail changes presentation only; it does not stop a run, discard a draft, reset context or terminate child tasks. Restore the prior keyboard focus when dismissing it. Session switching remains available from a compact inline conversation control, not a second navbar. Agent questions, supported approval controls, errors and previews belong to their session view.

Object comments open in the same nonmodal rail. Ordinary Post stores a comment; Ask agent deliberately invokes a session with the object/thread anchor. Open conversation switches to that same session, with its origin retained. A different selection or open panel cannot reroute a running task. There are no blocking dialogs for assistant context, model choice, help, voice or object comments.

Desktop chat Enter sends, Shift+Enter inserts a line break and Cmd/Ctrl+Enter sends from a composer. From the canvas, Cmd/Ctrl+Enter adds selection instead. On the phone, software Return inserts a line break and Send submits. Comment Return inserts a line break; Post or Ask agent chooses the operation. IME composition, note editors, search, native selects, menus, embedded pages and terminal input keep their own keys. Repeated keydown does not duplicate a request.

## Voice

Dictation and voice conversation are separate modes with separate controls and bindings. `B` while the canvas has focus toggles dictation; Shift+B toggles voice conversation. Dictation produces editable composer text and does not submit it automatically. Voice conversation accepts spoken turns and presents spoken replies, including an explicit interrupt/stop action. Do not silently switch between these behaviors. A future hold-to-talk binding must be distinct from toggle mode and configurable; this design does not overload one key for both.

Microphone capture requires deliberate activation and truthful permission, listening, processing, speaking, muted, denied and unavailable states. While recording is active, a small microphone/stop indicator remains even with the rail closed. Ending capture is always reachable by keyboard and pointer. Closing chat does not silently start, stop or conceal capture. Background agents may not activate a microphone.

Voice context uses the current committed reference set. Capture references with the lasso or direct selection, then use them for the next spoken turn. Already-sent turns keep their supplied context. The chosen model/provider must actually support the configured voice path or use an explicitly configured speech-to-text/text-session/text-to-speech adapter. Do not imply every CLI subscription includes realtime audio. Adapter selection and browser/device capability remain implementation work.

The prototype's voice controls show distinct preview states only, with an explicit microphone-not-connected message. They request no recording permission and synthesize no claim of live capture.

## Background agents

Run in background is an explicit composer action, also Cmd/Ctrl+Shift+Enter. It launches a separately managed child task with a name, request origin, provider/model and captured context. It immediately returns control to the canvas. The task can ask questions, provide results and be inspected or cancelled without replacing the foreground conversation. Code-editing tasks get isolated worktrees or another verified isolation mechanism; parallel agents do not edit one shared checkout. Canvas writes retain their individual authors.

`G` opens the task list in the same rail. Queued, running, waiting for input, completed, failed and cancelled states are distinct. Results link to the generated objects, preview or original thread instead of dumping all child output into the foreground transcript. Completion is a quiet conditional indication, not permanent board metadata. Cancel targets only the chosen task; the rail's close action never means Cancel task.

Task identity, drafts, questions, source references and results survive reconnect. Duplicate submit/retry creates one task. A provider change in the foreground does not alter an already running child. Background agent work is within the user's explicit task; unrelated recurring automation is not part of this feature.

The prototype queues and cancels clearly labeled example tasks only; it starts no sessions or processes.

## Provider and model

The small provider and model selectors are always keyboard reachable when the rail is open. `P` focuses provider and Shift+P focuses model from the canvas. Actual configured adapters populate the provider list and their supported model catalogs. The prototype has Claude Code/Codex examples, a session-default model and a custom-ID field; it is not a verified live model catalog.

Selection affects a subsequent new run. A task stores its provider/model at submission. Existing transcript messages keep their original attribution. If a foreground session cannot switch natively, show the new conversation/branch destination inline before the next Send; never reinterpret old history under a different provider or silently discard it. If a model can be changed in place, the adapter must record which model served each turn. Unsupported models have an inline reason and an alternative; no settings modal or silent fallback.

## Shortcut cheatsheet and scope

`?` from the canvas or F1 from anywhere opens a searchable cheatsheet in the same rail. It is nonmodal: the canvas remains operable and focus is not trapped. The dock also exposes Keys. Use visible shortcut hints in tooltips and context actions, without printing them across the board. Offer disabling or remapping single-letter bindings; none run while entering text. Cmd/Ctrl+period is the global assistant toggle. Browser and OS reserved keys remain intact; implementation must verify or remap any platform conflict.

| Action | Default | Scope / pointer alternative |
| --- | --- | --- |
| Show or fully hide assistant | `C`; Cmd/Ctrl+`.` | C on canvas; global modifier binding; dock assistant button |
| Add current selection to chat | Cmd/Ctrl+Enter | Canvas only, does not submit text; Add to chat on selection |
| Circle objects into chat context | Hold `Q` + primary drag | Canvas only; selection action is the accessible alternative |
| Navigate object focus | `J`/`K`, arrow keys | Canvas only; pointer or outline rows |
| Toggle focused object selection | `X` or tap Space | Canvas only; Shift-click for multi-selection |
| Select immediate objects | Cmd/Ctrl+A | Canvas only; scoped Select all action |
| Search canvas | `/` | Opens/focuses outline search |
| Open focused object's thread | Enter | Canvas object focus; contextual thread action |
| Open shortcut rail | `?` or F1 | ? canvas only, F1 explicit app help; Keys button |
| Dictation | `B` | Canvas only; microphone control |
| Voice conversation | Shift+B | Canvas only; voice control |
| Inspect background agents | `G` | Canvas only; task control |
| Run drafted task in background | Cmd/Ctrl+Shift+Enter | Composer or explicit existing draft; never empty submit |
| Choose provider / model | `P` / Shift+P | Canvas only, focuses inline select; selectors also directly reachable |
| Send / insert line break | Enter / Shift+Enter | Desktop chat composer only; Send button always available |
| Cancel lasso / close current rail view | Escape | Cancels active gesture first; then help/thread/task view, then rail |
| Select / pan tool | `V` / `H` | Canvas only; compact dock |
| Temporary pan | Hold Space + drag | Canvas only; never intercept button Space or typed spaces |

Key bindings are a design default, not proof every browser/OS allows the same combination. The interactive prototype exercises the primary context and rail actions. The prototype also demonstrates named-group selection/context, panning and Fit; full zoom, object creation and durable data editing remain implementation work. Add is visibly disconnected in this preview.

## Visual system for this surface

The scene is sustained laptop work with reference images and text, plus quick phone checks. The owner explicitly requested a dark Opsdeck adaptation. Keep the canvas matte and the controls legible, with no glow, simulated hardware texture or dashboard decoration.

| Token role | Dark candidate | Use |
| --- | --- | --- |
| Canvas | `#16181b` | Untextured work area |
| Panel | `#1e2125` | Outline, menus, focused sheet |
| Raised | `#282c32` | Hover, selected neutral controls |
| Divider | `#353940` | Surface edges; not the only indicator of interactive focus |
| Text | `#f2f1ed` | Body, names and primary controls |
| Secondary text | `#b2b5bc` | Descriptions and supporting metadata |
| Muted text | `#979da6` | Small captions that must remain readable |
| Focus/action | `#f58a45` | Keyboard outline, selected tool, primary-action fill |
| Action ink | `#16181b` | Text on the bright action fill |
| Nominal | `#82c5a0` | Saved state with check and text |
| Warning | `#e8b66b` | Pending/retry state with glyph and text |
| Critical | `#ff9d9d` | Failed operation with glyph and text |

The brighter amber is a dark-surface adaptation of Opsdeck's `#e85d04`. Reserve it for controls and focus, not orange outlines around every selected image. A thin neutral selection boundary plus clear corner marks identifies the active object; keyboard focus adds a separate amber outline. Selection and keyboard focus are distinct states.

System sans carries prose, 14-pixel body text with a 1.45 line height; 12-pixel metadata remains legible, and the focused text view uses 16 pixels with a comfortable reading measure. Tabular monospace is for counts, times, object IDs and shortcut hints, not paragraphs. Use 4-pixel spacing increments, 4-pixel control corners and 6-pixel media corners. Desktop controls are at least 32 pixels high; touch targets are at least 44 × 44 pixels with spacing.

Canvas colors are semantic tokens scoped to the canvas surface. Follow the existing app's light/dark choice rather than adding a competing global theme switch. Use the pinned dark palette for the dark canvas; the light counterpart uses the documented Opsdeck neutral family. An inherited Codeman accent choice must not recolor imported content. This is not a redesign of Codeman's global themes. Contrast calculations for this proposal are recorded in design/contrast-report.json; real implementation states still require verification.

## Canvas behavior and material states

The operation log remains authoritative, object IDs and explicit parents remain stable, and every write has an author. Ordinary layout dragging does not change parents. Named target drops or Move to explicitly reparent. Coordinate changes and sidebar visibility do not change the context attached to a request. Stable object order and ID-based focus prevent agent insertions from moving a person's keyboard target.

A keyboard-visible focus outline is distinct from selection. Author/source/history information stays in contextual disclosures. Agent writes do not steal focus, open chat or move unrelated work. Inline text editing and the rail's object reader replace the previous centered focus modal.

| State | Behavior |
| --- | --- |
| Assistant closed | No reserved space, leftover card or reopening handle; shortcuts and dock summon it |
| Capturing context | Temporary lasso and prospective object outlines only; cancel is lossless |
| Unsent request | Draft and direct context chips visible together; no fake Saved label |
| Failed request | Retain draft/references; explicit retry deduplicates submission |
| Offline | Existing board/transcript readable; new server work waits for connection |
| Voice unavailable or denied | Inline state, no microphone/listening claim; text remains available |
| Task waiting for user | Question belongs to that task; no silent blocked success or auto-answer |
| Task cancelled | Stop just that run, preserve transcript and partial outputs with status |
| Model unavailable | Inline reason and a deliberate alternative, no hidden fallback |
| Provider changed | Next destination made explicit, current history and child tasks unchanged |

Keep the existing data compatibility and supervised release guarantees. Self-building app changes are initiated and discussed through this workspace, with preview, verification and release outcome in the owning conversation. Session, draft, context and background-task identity survive release. Do not portray arbitrary live mutation of production code.

## Evidence and implementation handoff

[Open the interactive prototype](design/ambient-assistant.html) or the [gallery](design/index.html). The [interaction report](design/interaction-report.json) records browser checks through the authenticated Codeman preview. The [render report](design/render-report.json) captures the rail open, fully closed, lasso, help, voice, task and phone studies. The [contrast report](design/contrast-report.json) covers the proposed color pairs only.

The owner-selected direction directly supersedes prior composition choices; no new random concept round is necessary. An independent interaction review checked input scope, lasso cancellation, separate voice modes and child-task identity. This is design review, not implementation verification.

Acceptance requires the full [foundations and parity matrix](canvas-foundations.md), keyboard-only context selection and submission, no modal context flow, camera-stable rail dismissal, lossless lasso cancellation, truthful voice states, isolated background tasks, provider/model attribution and continuity through the self-building path. The real adapters, model catalogs, audio transport, touch/keyboard behavior, durable operations and performance must still be implemented and verified.

## Canvas shell (PC13)

Status: shaped on 2026-11-13 for PC13. This section is a design brief. Nothing in it is built yet. The owner delegated design decisions for this program to the agent, so the discovery interview below was answered from the source documents and its assumptions are listed. Implementation scope is in `intent/2026-11-13-canvas-pc13-shell.md`.

### Job and outcome

One person runs coding agents from a laptop and a phone. Until PC13 they open Codeman on a tab dashboard and reach the canvas as one tab inside it. After PC13 they open Codeman on the canvas of the workspace they last used. Sessions, workspaces and the things they do every day are reached from the canvas. The tab dashboard stays as the classic view at its own address, on the same server and the same state.

The shell is not a rebuild of the dashboard. A surface that is deep or rarely used keeps its home in the classic view, behind a visible link. The shell succeeds when a day of normal work (open a workspace, read and arrange the board, talk to an agent, check which sessions need attention, type into a terminal, come back) never needs the classic view, and when a broken canvas can never keep the owner out of Codeman.

### Decisions

1. **Landing.** With the shell on, `/` shows the canvas of the last-used workspace. Last-used is remembered per device. A device that has no memory yet opens the workspace of the case the server last started a session in, and failing that the first workspace the person can open. `/` answers with the canvas document itself and never with a redirect. The address bar then changes to `canvas/<workspace id>` without a second load, so a reload and a bookmark open the same workspace.
2. **First run.** When the person has no workspace, `/` shows a first-run state, not an empty board. It says what a workspace is in one sentence, lists the existing cases with **Open canvas** beside each, offers one field to name a new case, and links to the classic view. It never creates a case or a workspace by itself.
3. **Workspaces live in the outline.** The workspace name at the top of the outline is a button. It opens an inline list in the outline: the person's workspaces (each with a count of sessions that need them, shown only when the count is not zero), then **New workspace**. Choosing a workspace loads that workspace's canvas as a new page. **New workspace** shows, inline, the cases that have no canvas yet and a field for a new case name. There is no dialog and no tab.
4. **Sessions are listed in the outline, never placed on the board.** The outline gains a **Sessions** section above the object tree. It lists every live session whose working folder is inside the workspace's case: terminals, assistant conversations and background tasks. Each session has exactly one row. A row shows the name, a kind label (Terminal, Conversation, Task) and a state as a glyph and a word: Needs you, Error, Waiting, Working, Idle, Ended. Rows are ordered by that state, with the dashboard's own ordering rule. PC13 creates no board object for a session, adds no object type and writes nothing to the operation log on a session's behalf. A session row has no author because it is not canvas content.
5. **One full view per session: its terminal.** Every session, whatever its kind, has one full view, and it is the session's terminal. A Terminal row opens it with Enter or a click. A Conversation row opens the conversation in the assistant rail, and a Task row opens the task in the rail's task view, exactly as PC9 and PC12 built them; each of those rows also has **Open terminal**, which opens the same session's full view. The rail views are views of the same session and are not new.
6. **The full view is Codeman's own session page.** The terminal full view shows the existing single-session page (`session/<id>`, the page a popped-out session window already uses). It is the dashboard's own terminal, with its own input path, local echo, paste, scrollback, links and phone keyboard. The canvas never writes to a pane and holds no terminal code.
7. **How the full view is hosted.** On a laptop the session page opens in a same-origin frame that covers the canvas. The canvas document stays loaded underneath, so the camera, the selection and the rail are the same objects when the frame is removed. On a phone or any touch-first device the canvas navigates the whole window to the session page, and the session page's **Canvas** button navigates back; the canvas saves a one-use return ticket (camera, selection, focus, rail view, outline state) before it leaves and applies it when it loads again. The reasons are in "Terminal full view" below.
8. **The classic view has its own address.** `classic` always shows the tab dashboard, whatever the settings say. It loads only dashboard files. With the shell on, the dashboard's header carries a **Canvas** link back to `/`; on a phone that link is the Canvases section the phone overview already has.
9. **A broken canvas falls back to the classic view.** If the canvas files are missing on the server, `/` answers with the classic view and a notice. If the canvas document loads but its script does not load or does not start, the document sends the browser to the classic view with a notice. The canvas document also carries a plain **Open classic view** link that works with no script at all. Detection is described in "Fallback" below.
10. **The shell has its own setting.** `canvasShellEnabled` is synced, off by default and independent of `canvasEnabled`. The shell needs both to be on. The switch sits beside the Canvas switch in App Settings, which is in the classic view, so the way to turn the shell off is always reachable.
11. **The phone.** With the shell on, `/` on a phone is the canvas home: the board, the outline as a full-height view with Sessions first, the assistant and comments from PC6 and PC9. It replaces the phone overview as the landing screen. A session row opens the session page with the phone keyboard, toolbar and composer the dashboard already has.
12. **Cmd/Ctrl+K is Go to.** On the canvas it opens the outline and focuses its search field in Go to mode. Results are grouped: Sessions in this workspace, Workspaces, Objects on this canvas. Enter opens the result. Past sessions, pinning, resume and search across all sessions stay in the classic view, and the last row of the results says so with a link.

### Surface inventory

Homes: **Canvas** (an object or a control on the canvas page), **Outline**, **Rail** (a view in the assistant rail), **Full view** (opened from the canvas and closed back to it), **Classic** (reached through the classic view, with the reason), **Server page** (a page the server answers before either view, unchanged).

"Full view" rows are surfaces the session page already draws. They need no new canvas code. "Classic" rows are reached by the **Classic view** link at the foot of the outline, and from a session's full view by that page's own link.

| # | Surface | Today | Home under the shell | How reached | PC13 or classic-only |
| --- | --- | --- | --- | --- | --- |
| 1 | Session tab strip, including the scrolling phone strip | Header (`app.js`, `index.html`) | Outline | Sessions section; `S` | PC13 |
| 2 | Session sidebar and vertical tab rail, rail resize | `app.js`, `tab-rail-resize.js` | Outline | Sessions section | PC13 (layout choices stay classic) |
| 3 | Tab groups, Focus section, tab layouts (state, case, ledger), drag order, Alt+1 to 9 | `tab-layout-browser.js`, `app.js` | Classic | Classic view link | Classic-only: grouping is a drawing layer over the tab strip, and the outline orders by state instead |
| 4 | Session lineage lines | `session-lineage.js` | Classic | Classic view link | Classic-only: drawn between tabs, which the shell does not have |
| 5 | Header stats, token and cost readout, plan-usage chip, token statistics | Header (`settings-ui.js`, `index.html`) | Classic | Classic view link | Classic-only: system telemetry, not workspace content |
| 6 | Welcome screen and desktop home rail | `terminal-ui.js`, `home-sessions.js` | Canvas | `/` is the canvas; first-run state when there is no workspace | PC13 |
| 7 | Resume Conversation list (past sessions) | Welcome screen (`terminal-ui.js`) | Classic | Go to results link; Classic view link | Classic-only: history across every case, outside one workspace |
| 8 | Phone overview home screen | `mobile-overview.js` | Outline | Canvas home on the phone; outline Sessions | PC13 |
| 9 | Session terminal: output, typing, local echo, paste, copy, scrollback, link taps | `terminal-ui.js`, `app.js` | Full view | Sessions row; Enter | PC13 |
| 10 | Split pane | `terminal-split.js`, `terminal-tile.js` | Classic | Classic view link | Classic-only: two sessions side by side is a dashboard layout |
| 11 | Tile grid | `tile-grid.js` | Classic | Classic view link | Classic-only: same reason |
| 12 | Popped-out session window | `app.js` (`/session/:id`) | Full view | It is the page the full view shows | PC13 |
| 13 | Session Options (name, colour, respawn, Ralph settings, prompt cache, context) | `session-ui.js`, `#sessionOptionsModal` | Classic | Classic view link | Classic-only: opened from a tab, which the session page hides |
| 14 | Respawn banner, presets, run summary, timer banner | `respawn-ui.js` | Classic | Classic view link | Classic-only: loop control is rarely changed and has many states |
| 15 | Ralph panel, Ralph wizard, plan versions | `ralph-panel.js`, `ralph-wizard.js` | Classic | Classic view link | Classic-only: same reason |
| 16 | Orchestrator panel | `orchestrator-panel.js` | Classic | Classic view link | Classic-only: same reason |
| 17 | Run button and run-mode menu (start a session) | `session-ui.js`, `#runModeMenu` | Outline | **New session** in the Sessions section | PC13 for the available agent CLIs and a shell; effort, model, custom endpoints and the other options stay classic |
| 18 | Custom model picker and its swap and context warnings | `session-ui.js`, three modals | Classic | Classic view link | Classic-only: per-launch options |
| 19 | Close session, Kill all sessions | Tab close, `#killAllModal` | Classic | Classic view link | Classic-only: destructive and confirmed by a dashboard dialog; a conversation or a task is still ended from the rail as today |
| 20 | File preview: viewer, rendered Markdown, edit mode, document review, spreadsheets, media, folder grid, rendered HTML | `panels-ui.js`, `doc-review.js`, `spreadsheet-preview.js` | Full view | A file path printed in a terminal is a link inside the full view | PC13 by reuse; opening a file with no session is classic |
| 21 | Files panel and file search | `panels-ui.js`, `#fileBrowserPanel` | Classic | Classic view link | Classic-only: a workspace file browser belongs to the documents phase |
| 22 | Git status indicator, panel and Fetch | `git-status-ui.js` | Classic | Classic view link | Classic-only: Git records belong to a later phase |
| 23 | Prompt uploads: paste, drop, Attach | `image-input.js` | Full view | In the terminal | PC13 by reuse |
| 24 | Attachment history | `panels-ui.js`, header button | Classic | Classic view link | Classic-only: opt-in header panel |
| 25 | Response viewer and chat view | `app.js`, `#responseViewer` | Classic | Classic view link | Classic-only: the rail already shows a conversation's transcript |
| 26 | Filesystem path picker | `session-ui.js`, phone keyboard key | Full view | Phone keyboard Path key in the terminal | PC13 by reuse; the Link Existing browse is classic |
| 27 | App Settings, every section: terminal, display, appearance, agents and CLIs, plugins and skills, MCP sync, notifications, webhook, voice, keyboard, diagnostics, paths, config backups, automation, remote access, updates | `settings-ui.js`, `#appSettingsModal` | Classic | **Settings (classic)** at the foot of the outline | Classic-only: about forty sections of server-wide settings; the shell switch itself is here |
| 28 | Deploys section and rollback | `deploy-ui.js` | Classic | Settings (classic) | Classic-only on purpose: recovery must not depend on the canvas |
| 29 | Admin panel, users, change password | `admin-ui.js` | Classic | Classic view link | Classic-only: administration |
| 30 | Help and the dashboard shortcut overlay | `#helpModal`, `#shortcutOverlayModal` | Classic | In the classic view and in the full view | Classic-only; the canvas has its own Keys view (row 61) |
| 31 | Session lifecycle log | `settings-ui.js` | Classic | Classic view link | Classic-only: audit log |
| 32 | Approvals Inbox drawer | `approvals-ui.js` | Outline | A waiting session reads Needs you in Sessions and in the workspace list; it is answered in the rail (conversations and tasks) or in the full view (terminals) | PC13 for state and answering; the cross-session drawer stays classic |
| 33 | In-page notifications and the notification drawer | `notification-manager.js` | Classic | Classic view link | Classic-only: the outline's Needs you state is the shell's signal |
| 34 | Push notifications and their click | `sw.js`, `settings-ui.js` | Full view | A notification click opens that session's full view from the canvas | PC13; subscribing stays in Settings (classic) |
| 35 | Away digest | `#awayDigestModal` | Classic | Classic view link | Classic-only: a report across every session |
| 36 | Reboot-restore banner | `reboot-restore-ui.js` | Canvas | One notice line with a link to the classic view, where the rebuild is offered | PC13 for the notice; the rebuild stays classic |
| 37 | Connection-loss overlay and banner | `app.js`, `constants.js` | Canvas | The canvas's own offline state (existing) | PC13 by reuse; the full view shows the dashboard's own |
| 38 | What's new, update notice, security notices | `settings-ui.js`, `panels-ui.js` | Classic | Shown when the classic view is opened | Classic-only in PC13; see Risks in the intent |
| 39 | Self-update | Settings | Classic | Settings (classic) | Classic-only |
| 40 | Command palette and Session Manager (Cmd+K): live sessions | `app.js`, `#commandPaletteModal`, `#sessionManagerModal` | Outline | Cmd/Ctrl+K, Go to | PC13 |
| 41 | Session Manager: past sessions, pinning, resume | `app.js`, `#sessionManagerModal` | Classic | Go to results link | Classic-only: history outside one workspace |
| 42 | Search across sessions | `#searchPanel` | Classic | Go to results link | Classic-only: same reason |
| 43 | Case picker (choose the case to work in) | `session-ui.js`, `#mobileCasePickerModal` | Outline | Workspace list; `W` | PC13 |
| 44 | Add Case: create a new case | `#createCaseModal` | Outline | New workspace | PC13 |
| 45 | Add Case: link an existing folder, clone a repository, manage agent-created cases | `#createCaseModal` | Classic | Link under New workspace | Classic-only: each has its own safety checks and forms |
| 46 | Remote SSH cases and hosts, wake-on-LAN banner and settings | `session-ui.js`, `host-wake-ui.js` | Classic | Classic view link | Classic-only: host administration |
| 47 | Docker cases, hosts, adoption, export and import | `session-ui.js` | Classic | Classic view link | Classic-only: host administration |
| 48 | Rename case | `#renameCaseModal` | Classic | Classic view link | Classic-only: it can stop sessions and move a folder |
| 49 | Git worktrees of a case | `#worktreeModal` | Classic | Classic view link | Classic-only: background tasks already make their own worktrees |
| 50 | Cron jobs | `cron-ui.js` | Classic | Classic view link | Classic-only: recurring automation is outside the canvas scope |
| 51 | Read My Mind | `readmymind-ui.js` | Classic | Classic view link | Classic-only: opt-in dashboard feature |
| 52 | Web tabs (saved dashboard URLs) and Add URL | `webview-tabs.js`, `#webviewModal` | Classic | Classic view link | Classic-only: a page is shown on the canvas as an embed object (row 60) |
| 53 | Session previews: badge, Terminal and Preview switch, stopped card | `session-ui.js`, `webview-tabs.js` | Classic | Classic view link | Classic-only: live previews are a later phase |
| 54 | Subagent panel, floating subagent windows, monitor, project insights, agent teams | `panels-ui.js`, `subagent-windows.js` | Classic | Classic view link | Classic-only: tasks started from the canvas are in the rail's task view |
| 55 | Ultracode panel and windows | `ultracode-panel.js`, `ultracode-windows.js` | Classic | Classic view link | Classic-only: opt-in visualisation |
| 56 | Dashboard voice input | `voice-input.js` | Full view | Microphone control in the terminal | PC13 by reuse; canvas dictation and voice conversation are in the rail (row 61) |
| 57 | Gesture control | `gesture/`, header | Classic | Classic view link | Classic-only: the server injects it into the dashboard only |
| 58 | Phone keyboard handling, accessory bar, toolbar, Compose, CJK input | `mobile-handlers.js`, `keyboard-accessory.js`, `input-cjk.js` | Full view | A session row on the phone | PC13 by reuse; swiping between sessions is classic |
| 59 | Theme, branding, language | Settings, `i18n.js` | Canvas | The canvas already follows the device's stored theme | PC13 by reuse; choosing a theme is in Settings (classic) |
| 60 | The canvas itself: board, objects, embeds, sub-canvases, dock | `packages/canvas` | Canvas | `/` | Existing |
| 61 | Rail views: assistant, comment thread, history, tasks, Keys, reader | `packages/canvas` | Rail | `C`, Enter, `G`, `?` | Existing |
| 62 | The canvas as a tab in the dashboard | `session-ui.js` (`openCaseCanvas`) | Classic | Case picker, with the shell on or off | Unchanged |
| 63 | DeepSeek web UI entry, multi-monitor button, entrance animations, header divider | `session-ui.js`, `header-divider.js`, `entrance-animations.js` | Classic | Classic view link | Classic-only: dashboard chrome |
| 64 | Tunnel and QR sign-in buttons | `settings-ui.js` | Classic | Settings (classic) | Classic-only: remote access administration |
| 65 | Sign-in challenge and the QR sign-in address | Server (`middleware/auth.ts`, `system-routes.ts`) | Server page | Before either view; a signed-in browser lands on `/` | Unchanged |

No surface lacks a home. Counts: Canvas 5, Outline 8, Rail 1, Full view 8, Classic 42, Server page 1.

### Flows

**Open Codeman.** The person opens `/`. The canvas of the last-used workspace appears with the camera fitted to its content, the outline open on a laptop and closed on a phone, and the rail closed. Sessions that need them show at the top of the Sessions section.

**Switch workspace.** `W`, or a click on the workspace name. The list opens inline in the outline with focus on the current workspace. Arrow keys move, Enter opens, Escape closes the list and returns focus to the name. Opening a workspace loads its canvas and records it as last-used on this device.

**Create a workspace.** In the workspace list, **New workspace** shows the cases without a canvas and a name field. Choosing a case creates its workspace and opens it. Typing a name and pressing Enter creates the case, then its workspace, then opens it. A refused name shows the server's reason under the field and keeps the text. Link, clone, remote and Docker cases are one link away in the classic view.

**Start a session.** **New session** in the Sessions section opens a short inline list: the agent CLIs this server can run, then Shell. Choosing one starts a session in the workspace's case through the route the Run button already uses, adds its row and opens its full view. A row is added once whether the answer or the server's event arrives first.

**Open and close a terminal.** Enter on a Terminal row, or **Open terminal** on any row. On a laptop the session page covers the canvas and takes keyboard focus. **Canvas** in the session page's header, or Ctrl+Shift+Backspace, removes it. Focus returns to the row that opened it. The camera, the selection, the focused object, the open rail view, its scroll position and any draft are what they were. On a phone the same actions navigate to the session page and back, and the return ticket restores the camera, selection, focus, rail view and outline state.

**Answer a session that needs you.** The row reads Needs you. For a conversation or a task the row opens the rail, where the approval or question already appears. For a terminal the row opens the full view, where the dialog is on the screen.

**Go to.** Cmd/Ctrl+K. Type part of a session, workspace or object name. Enter opens it: a session as its row would, a workspace as the list would, an object by focusing it and fitting it in view.

**Leave for the classic view and come back.** **Classic view** at the foot of the outline opens `classic`. **Canvas** in the dashboard's header opens `/`. Sessions, drafts in the dashboard, tab groups and the canvas's own queued edits and drafts are untouched, because both views read the same server state and each keeps its own browser storage.

**The canvas is broken.** The person opens `/` and arrives in the classic view with a notice that says the canvas did not load and why. The notice has **Try the canvas again** and **Dismiss**. Nothing retries by itself.

### Terminal full view

Two ways to show a session's terminal were compared.

| Question | Session page in a same-origin frame over the canvas | Navigate the window to the session page, with a link back |
| --- | --- | --- |
| Camera, selection and rail unchanged on return | True by construction: the canvas document is never unloaded | Only what the return ticket saves; a running voice capture ends and the canvas loads again |
| Terminal geometry | The session page fits its terminal to the frame's box. The frame is removed on close, not hidden, so a hidden terminal never holds a size | The page fits to the window |
| Phone keyboard | The dashboard reads the keyboard from `visualViewport` (`mobile-handlers.js`). A framed page does not see the keyboard there, so the toolbar and the held rows would be wrong | Works as today |
| Existing frame rules | The frame shows Codeman's own page from a fixed prefix and a session id taken from the session list, never a URL from an object or from agent text. It needs the sign-in cookie, so it is not sandboxed. `session/<id>` is a registered route, so the lost-frame page never answers it | No frame |
| Input path | The dashboard's own | The dashboard's own |

The frame is chosen wherever a hardware keyboard is the expected input, because it is the only one of the two that keeps the canvas exactly as it was. Navigation is chosen on a phone and on any device whose primary pointer is coarse, because the frame breaks the software keyboard there. One rule decides, and it is the canvas's existing phone and touch test.

Rules for the full view:

- At most one full view is open. Opening another replaces it.
- The session page is one more client of the session. It joins the existing popped-out window protocol, so an open classic dashboard marks that session as shown elsewhere and does not compete for the terminal's size.
- While the frame is open the canvas underneath is inert: it takes no keys and no pointer, and it is hidden from assistive technology. Server changes still arrive and never move the camera.
- Opening a full view ends an active microphone capture first and sends nothing, like hiding the page.
- The session page tells the canvas it is ready. If it has not within ten seconds, the canvas shows an inline message in place of the frame with **Try again**, **Open in classic view** and **Back to canvas**. Escape closes the full view whenever focus is on the canvas page and not inside the terminal.
- With the shell off, or when the canvas is itself a tab inside the dashboard, there is no Sessions section and no full view. The dashboard's tabs are beside it.

### Fallback

The classic view must be reachable whenever the server is. Three independent pieces give that.

1. **The server checks before it answers.** For `/` with the shell on, the server looks for the canvas files. If one is missing it answers with the classic view and the notice. No redirect is involved.
2. **The canvas document guards its own start.** A small inline script, which is part of the document and not of the canvas bundle, watches the bundle. It sends the browser to the classic view when the bundle's script fails to load, when the script loads but has not reported that it started, or when an uncaught error happens before that report. The bundle reports that it started only after it has drawn the board or one of its own designed states (loading, first run, error, offline). A failure to fetch workspace data is not a broken canvas: the canvas shows its own error state with **Try again**.
3. **A link that needs no script.** The document's loading state carries **Open classic view** as a plain link from its first paint.

The automatic fallback goes to `/?view=classic` with a reason, not to `classic`. The server honours `view=classic` before it reads the shell setting. A release from before PC13 ignores the query and answers `/` with the dashboard, so the fallback still lands on a working page if a rollback happens between loading the document and loading its script.

It cannot loop. The only automatic navigation is from the canvas document to the classic view. The classic view never navigates by itself. The guard never navigates when the address already asks for the classic view, which covers a cached canvas document being served for that address while offline; in that case the document says the server cannot be reached.

The guard acts only when the shell is on and the canvas is the top-level page. As a tab inside the dashboard, a canvas that fails shows its error text in place, as today.

### The shell setting

| `canvasEnabled` | `canvasShellEnabled` | `/` | `classic` | `canvas/<id>` |
| --- | --- | --- | --- | --- |
| off | off | Classic view | Classic view | Not found |
| on | off | Classic view; the canvas is a tab, as today | Classic view | Canvas, no Sessions section |
| off | on | Classic view. Settings says the shell needs the canvas turned on | Classic view | Not found |
| on | on | Canvas shell | Classic view | Canvas with the shell's outline |

The setting is read on every request for `/`, so switching it takes effect on the next load with no restart. In multi-user mode only an admin can change it, like every synced setting. Turning it on never turns `canvasEnabled` on.

A blue-green deploy keeps the setting because both builds read the same settings file. A rollback to a release from before PC13 keeps the key in the file and ignores it: `/` is the dashboard again and the canvas is a tab. Deploying forward again brings the shell back with no step from the person.

### States

| State | What the person sees |
| --- | --- |
| Loading | "Opening your canvas", the workspace name when known, and the Open classic view link |
| First run, no workspace | One sentence on what a workspace is, the cases with Open canvas, a new case field, the classic link |
| No sessions in the workspace | The Sessions section shows "No sessions" and New session |
| A session needs you | Its row moves to the top with a glyph and "Needs you"; the workspace list shows the count |
| Session ended | The row reads Ended and stays until the session is removed; opening it shows the session page's own ended state |
| Full view did not open | Inline message in place of the frame with Try again, Open in classic view, Back to canvas |
| Session list could not load | "Sessions could not load" with Try again in the section; the board is unaffected |
| Workspace list could not load | The same pattern in the workspace list; the current workspace stays open |
| Create refused | The server's reason under the field; the text is kept |
| Offline | The board and the last session list stay readable and are marked as last known; New session, New workspace and Open terminal are unavailable with a reason; the classic link stays |
| Canvas fallback | The classic view with a notice naming the reason, Try the canvas again and Dismiss |
| Shell on, canvas off | The classic view; the Shell row in Settings says the canvas must be on |

### Phone

- `/` opens the canvas home. The outline is a full-height view opened from its control, with Sessions first, then the workspace name and the object tree. Rows are at least 44 pixels high.
- Reading, navigation, comments and the assistant behave as PC6 and PC9 left them. The phone still makes no canvas edits.
- A session row opens the session page in the whole window. The dashboard's keyboard handling, accessory bar, toolbar and composer run there unchanged. **Canvas** in its header returns.
- New session and New workspace work on the phone. They start sessions and create cases, which are not canvas edits.
- The phone overview remains in the classic view.
- Nothing depends on hover or a hardware key. Go to is the outline's search field.

### Key bindings

Additions to the table above. Each was checked against the canvas bindings in `packages/canvas/src/shortcuts.ts` (J, K, X, V, H, C, Q, P, B, G and M are taken) and against the dashboard registry in `app.js`.

| Action | Default | Scope and pointer alternative |
| --- | --- | --- |
| Go to a session, workspace or object | Cmd/Ctrl+K; Alt+K | Canvas page, not while typing in a field other than the search field; outline search field |
| Focus the Sessions section | `S` | Canvas only; opens the outline if it is closed |
| Open the workspace list | `W` | Canvas only; the workspace name |
| Open the focused session | Enter | Session row; click or tap |
| Back to the canvas from a terminal | Ctrl+Shift+Backspace | Session page opened from the canvas only; the Canvas button. Rebindable in the dashboard's registry |
| Close a full view that did not open | Escape | Focus on the canvas page; Back to canvas |

Conflicts considered. Cmd/Ctrl+K and Alt+K are the dashboard's palette keys; inside a full view the terminal page has focus and its own palette answers, which is correct there. Plain `S` and `W` run only with canvas focus and never while typing; Ctrl+W stays unbound everywhere, as the dashboard requires. Escape inside a terminal belongs to the terminal, so it never closes a full view that has focus. Ctrl+Shift+Backspace is not in either table and has no meaning in a shell; the terminal must swallow it so no byte reaches the pane. It is a default: the build must check it on macOS, Windows and Linux browsers and remap it if a platform reserves it.

### Accessibility

- The Sessions section is a labelled list. Each row is a button whose name reads the session name, its kind and its state. State is a glyph and a word, never colour alone.
- A change to Needs you is announced once, politely. Other state changes are not announced.
- The workspace list and New session are disclosures with `aria-expanded`, not dialogs. Focus is not trapped. Escape closes them and returns focus to the control that opened them.
- The full-view frame has a title naming the session. Focus moves into it on open and back to the opening row on close. The canvas underneath is inert while it is open.
- The fallback notice in the classic view is a status region that stays until dismissed. It is not a toast.
- Every new control is reachable by Tab, has a visible focus outline in the focus colour, and is at least 32 pixels high on a laptop and 44 by 44 on touch.
- Nothing new animates. Opening and closing a full view is immediate.
- Session names and case names reach the page as text only.

### Assumptions and the simulated-user record

Shape asks for a discovery interview. The owner delegated design decisions for this program, so the questions were answered from `PRODUCT.md`, the plan's PC13 section, this brief and the code.

| Question | Answer taken | Source |
| --- | --- | --- |
| What is the shell for? | Opening Codeman on the canvas and reaching sessions from it, with the dashboard as a fallback | Plan, PC13 |
| Who uses it and how? | One person, laptop browser and phone, keyboard first | `PRODUCT.md` |
| What must stay untouched? | The dashboard's code, a session's single input path, the operation log's author rule, the deploy and rollback rules | Plan, PC13; `PRODUCT.md` |
| What would make it wrong even if it looked right? | Being locked out by a broken canvas; a second way to write to a pane; session rows written to the board without an author; a navbar | Plan, PC13; this brief |
| How much of the dashboard moves? | Daily surfaces only. Deep and rare surfaces stay classic behind a link | Owner's instruction for this pass |
| Which states matter? | First run, a session that needs the person, a broken canvas, offline, rollback | Plan, PC13 |

Assumptions made where the sources were silent:

1. Last-used workspace is per device. A phone and a laptop are often on different work, and a per-device memory needs no write to server settings.
2. A workspace's sessions are the live sessions whose working folder is inside its case. This is the rule the server already uses to find an agent's workspace.
3. The outline can carry a Sessions section at 192 pixels. Names are cut with an ellipsis and the full name is in the row's accessible name and tooltip.
4. A person does not need to place a session on the board in PC13. A placeable session object would be a new object type with its own log operations and belongs to a later change.
5. Ending a session, session options and loop control are rare enough to stay classic for now.
6. The session page shows enough for daily terminal work. What it lacks is one link away in the classic view.

### Acceptance criteria

Each item can be checked by a script against a throwaway instance. "Shell on" means both settings are on.

1. Shell off: `GET /` returns the dashboard document and contains no reference to the canvas bundle. The response is the same as before PC13 apart from the header link container.
2. Shell on, one workspace: `GET /` returns status 200 with the canvas document, not a redirect. After load the address path ends in `canvas/<that workspace's id>`.
3. Shell on, no workspace: `/` shows the first-run state. No case and no workspace exists afterwards unless the person acted.
4. `GET classic` returns the dashboard document for all four setting combinations, and that document requests no canvas file.
5. `GET /?view=classic` returns the dashboard document with the shell on.
6. Shell on, canvas bundle file removed: `GET /` returns the dashboard document, and the fallback notice is visible in it.
7. Shell on, canvas bundle replaced by a script that throws: loading `/` ends on the classic view with the notice visible, after exactly one navigation. Loading that address again does not navigate.
8. Shell on, canvas bundle request blocked: same result as 7.
9. With scripts disabled, the canvas document shows a link whose target is the classic view.
10. The Sessions section lists exactly the live sessions whose working folder is inside the workspace's case, one row each, and a session created or ended elsewhere appears or changes within five seconds.
11. Starting a session from New session creates exactly one session and one row.
12. Laptop: read the canvas view state, open a terminal's full view, type a command that prints a marker, confirm the marker in the pane, close the full view, read the view state again. Camera, selection, focus and rail view are equal, and the rail's draft text is unchanged.
13. Laptop: while a full view is open, pressing a canvas shortcut key changes nothing on the canvas.
14. Laptop: the operation log's last sequence is the same before and after 10 to 13.
15. No request from the canvas page writes to a pane: during 10 to 13 the canvas page itself sends no request to a session input route and opens no terminal socket. Only the session page does.
16. Phone: `/` shows the canvas home. Opening a session row lands on the session page at the top level; typing with the on-screen keyboard reaches the pane; **Canvas** returns, and the camera and rail view are equal to before.
17. A session is visible, with the same id and state, in the outline and in the classic view's tab list at the same time.
18. Switching from canvas to classic and back loses no session, no dashboard tab group and no canvas draft.
19. The workspace list shows every workspace the person can open and no other person's in multi-user mode. Choosing one opens it, and the next `GET /` from that browser opens the same one.
20. New workspace with a new name creates one case and one workspace and opens it. A name the server refuses creates nothing.
21. Cmd/Ctrl+K focuses the search field and Enter on a session result opens what that session's row opens.
22. In multi-user mode a non-admin's attempt to change `canvasShellEnabled` is refused with 403 and the file is unchanged.
23. With the shell on, the settings file is still read by the previous release: its `/` returns the dashboard and its settings save succeeds.
24. Every row of the surface inventory marked PC13 is reachable with the shell on without opening `classic`. Every row marked classic-only is reachable from the canvas in at most two activations: the classic link, then the surface's own control.
25. Keyboard only: open `/`, move to a session, open its terminal, return, switch workspace, with no pointer event.
26. No new control fails the contrast pairs in `design/contrast-report.json`, and each has an accessible name.
