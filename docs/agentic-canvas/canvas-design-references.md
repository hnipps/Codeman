# Canvas design references

The owner supplied three clips and the Opsdeck app as inspiration during review of the initial canvas plan. The owner also called out keyboard shortcuts as highly desirable and requested a dark version of the Opsdeck look. These notes describe sampled frames from all three clips. They are input to Impeccable shape, not an approved design or proof of usability, performance or implementation details.

## Source clips

The original recordings are local review attachments in the workspace's ignored `.codeman-uploads/` directory. Keep them local; do not add the recordings to the public repository.

| Reference | Local filename | Duration | Visible interaction |
| --- | --- | --- | --- |
| A | `paste-1794346562519-90bcc25d.mp4` | 16.90 seconds | Tall viewport showing selection, movement through clusters and changes of canvas scale |
| B | `paste-1794346562534-0eeb6214.mp4` | 32.13 seconds | A text card opens into a larger editor over the board; block-format menus, selection and image content appear; the board returns to view |
| C | `paste-1794346562467-a2413aad.mp4` | 25.64 seconds | Image and text rearrangement, horizontal and vertical clusters, corner brackets and light group outlines |

The app's identity and the meaning of its orange bottom control have not been established from these clips. Do not invent behavior for that control. The tall recording is evidence of a tall viewport, not proof of phone touch behavior.

## Visual direction to explore

- A pale neutral canvas with substantial open space. Content carries most of the visual weight; persistent interface elements stay small and quiet.
- Floating, compact top controls for navigation and search. Contextual controls appear near the selection rather than occupying a permanent inspector.
- Images with gently rounded corners, mixed aspect ratios and close spacing within clusters. Text can sit directly on the canvas or appear in a document card.
- Selection uses separated curved corner brackets. Group boundaries are lighter than the content and can carry a small caption.
- A document opens into a larger rounded panel while the surrounding board remains visible. Explore a clear return to the previous board position and selection.
- One restrained accent can identify a primary action. Shape must give any such action a clear purpose and accessible name, without copying the unexplained orange control.

These are references for a new canvas surface. Inspect Codeman's existing tokens, themes, tabs and phone navigation and decide how the canvas fits them. Do not restyle the rest of Codeman as a side effect.

## Interaction questions for shape

- How do users pan, zoom, select, drag and edit without confusing the gestures? Define keyboard and touch alternatives and reduced-motion behavior.
- How do objects align and join a group? The clips suggest close placement and snapping. Explore visible insertion or grouping previews, an explicit commit and undo. Save `parentId` when grouping commits. Loose proximity never changes the container an agent reads.
- How does selection distinguish one object, several objects and their container? Show the active target without surrounding every object with heavy controls.
- When does a text card edit inline, and when does it open into a focused panel? Define formatting scope, save feedback, escape behavior and preservation of the canvas viewport. Keep Git-backed document semantics in the later document phase.
- How do these controls work with real agent activity, comments and author revert? Retain the calm composition while making authorship, progress and errors visible.
- What survives on a phone? Define read, navigation, comments and focus-panel behavior independently of the desktop recording. Full phone canvas editing remains outside the initial vision's scope.

## Evidence required before implementation

The shaped brief must name the selected layout and interactions, show representative compositions and states, explain changes from these references and update the implementation plan accordingly. Do not treat the current DOM-renderer proposal or its existing control layout as settled before this design work.

Verify the eventual rendered result with representative images and long text at desktop and phone sizes, including many objects, keyboard focus, selection, grouping, errors and an agent write arriving while the user is working.

## Opsdeck visual system and dark mode

Reference source: [nicholls-inc/opsdeck](https://github.com/nicholls-inc/opsdeck), inspected at commit `7da4fe58e0c20042cdc48230af19a852bd6ef941`. The [design system](https://github.com/nicholls-inc/opsdeck/blob/7da4fe58e0c20042cdc48230af19a852bd6ef941/DESIGN.md) and [shipped CSS](https://github.com/nicholls-inc/opsdeck/blob/7da4fe58e0c20042cdc48230af19a852bd6ef941/web/styles.css) establish the visual reference. This inspection covers source, not a live capture of the app.

Opsdeck uses a Braun-inspired instrument aesthetic: neutral planes, tight geometry, thin structural rings, compact typography and a single signal-amber action accent. System sans carries titles and prose; tabular monospace carries counts, ages and identifiers. Its documented spacing scale is based on 4 pixels and its usual component radii are 2, 4 and 6 pixels. Color has a function: status includes a glyph and label, and amber identifies focus, primary actions and active navigation.

Use Opsdeck as the visual reference for canvas controls, contextual tools, status and focused panels. Use the supplied clips for the spatial composition and manipulation of content. Do not copy the dashboard's bay layout onto the infinite canvas or let dense dashboard controls crowd the board. Reconcile the clips' softer image cards with the tighter control geometry during shape.

Dark mode is a required design deliverable. Opsdeck has inherited dark palette tokens, but its CSS explicitly ships light-only components and its design document says the dark tokens are not a shipped theme. Start from these source values as candidates, not an already verified dark theme:

| Role | Existing Opsdeck candidate |
| --- | --- |
| Canvas | `#16181b` |
| Card or panel | `#1e2125` |
| Raised controls | `#282c32` |
| Border | `#353940` |
| Action and focus accent | `#e85d04` |

Shape must choose primary, secondary and muted text, visible selection and focus rings, hover and pressed states, and dark semantic status colors. Check contrast for their actual sizes and backgrounds; do not invert light colors or assume the inherited tokens pass. Separate canvas, content cards and focused overlays through neutral surface steps and borders. Avoid glow effects. Preserve the colors of imported images and embedded content.

Include a dark desktop canvas and dark phone view in the shaped concepts. Specify how the canvas follows Codeman's existing theme preference and how images, embeds and text remain legible when themes differ. Keep theme changes scoped to the canvas and its controls.

## Keyboard interaction is part of the design

The owner explicitly values Opsdeck's keyboard shortcuts. Its [HTML](https://github.com/nicholls-inc/opsdeck/blob/7da4fe58e0c20042cdc48230af19a852bd6ef941/web/index.html) exposes visible key hints and `aria-keyshortcuts`; its [event handler](https://github.com/nicholls-inc/opsdeck/blob/7da4fe58e0c20042cdc48230af19a852bd6ef941/web/app.js) supplies navigation and context-sensitive actions.

| Opsdeck behavior observed in source | Canvas design question |
| --- | --- |
| `/` focuses the filter | Search objects in the active workspace without losing canvas position |
| `j`/`k`, `h`/`l` and arrow keys navigate records and bays | Define predictable object/container navigation, distinct from moving objects or panning |
| Space lifts a record; Enter opens it | Define selection, focus-panel opening and edit entry; resolve Space's possible pan gesture before assigning bindings |
| Escape closes the lifted panel, then selection mode, then returns to bays | Unwind one active layer at a time and restore focus to its originating object |
| `x` selects; Shift+X selects the bay | Define toggle, multi-selection and the scope of select-all |
| Number keys switch views | Reuse only where the canvas has meaningful destinations and no conflict with Codeman tabs |
| Visible key hints accompany controls | Make shortcuts discoverable through contextual hints and a shortcut reference |

These are behaviors to adapt, not a binding map to copy wholesale. Shape must write a shortcut table with action, key, scope, disabled contexts and a pointer/touch alternative. Include search, navigation, selection, focus/edit, pan/zoom, grouping, delete, undo/redo and escape. Give single-letter bindings a way to be disabled or remapped, or activate them only while the relevant canvas component has focus. Do not let a selected object silently capture keystrokes intended for another component.

The canvas handler must respect input, textarea, select, contenteditable, composition/IME, focused buttons, terminal panes, embedded documents and open dialogs. Modified browser and OS shortcuts retain their normal behavior unless a canvas editing command deliberately handles that combination while the canvas has focus. An undo shortcut must not revert an entire agent session or another author's work; keep author revert a distinct named action. Every action remains available through a labeled control or menu.

Verification must exercise a keyboard-only sequence from opening the canvas through selecting and editing an object, undoing, opening and closing its focus panel and returning to the board. Also verify that typing shortcut letters in an editor, terminal or embed does not trigger canvas actions. Record visible focus and shortcut hints in the dark-theme evidence.

## Owner clarification after the first design review

The owner accepted the visual direction and requested removal of the navbar, search inside the outline and fewer persistent system labels on the board. Conversation sessions must exist as canvas objects; comment threads are another interface to agents. Users control starting context while agents can discover the whole canvas. The workspace can be reshaped by users and agents, and app changes happen through work initiated within it. This clarification supersedes the initial brief's treatment of embedded chat and agent comments as deferred. Codeman is today's shell, not the target UI model.

## Latest direction: ambient assistant, not a chat card

The owner rejected the floating conversation design and modal attachment picker. Chat is now a thin right-side rail that collapses fully, invoked mainly through shortcuts. Direct selection and a hold-key freehand lasso add canvas objects to context. Voice, background agents, provider/model selection and a readily accessible nonmodal cheatsheet are part of the current design target. This supersedes the previous movable-conversation and context-modal studies.

[HeyClicky](https://www.heyclicky.com/) is an interaction reference. Its public page describes a hotkey-invoked assistant that uses visible work, supports spoken interaction and can run agent tasks. Two public demo clips were sampled locally: `heyclicky-draw.mp4` and `usecase.mp4`. They show assistance and annotations alongside the user's existing work. This does not establish the exact lasso interaction, which is the owner's requirement. Keep the pinned dark Opsdeck styling; do not copy the mascot, retro webpage or desktop-wide capture scope.

## Foundation controls and agent parity clarification

The owner explicitly requires groups such as Design exploration to be selectable and attachable as named context with their contents. The production canvas must also have basic FigJam-style selection lassos, grouping, resizing, locks, nesting and the related canvas/element interaction foundations, without stickers, washi tape, sticky-note objects or decorative workshop types. The prototype need not demonstrate the full set. Every human canvas action must have structured agent-native controls and readable state. [The capability matrix](canvas-foundations.md) records this requirement and links Figma's primary documentation as the benchmark.
