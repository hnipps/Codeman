# Canvas and ambient assistant UI/UX brief

Status: Revised to the owner's latest direction. The thin right-hand assistant rail supersedes the floating conversation-card and context-picker designs. This is a design prototype, not a live model, microphone or background-agent implementation.

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
