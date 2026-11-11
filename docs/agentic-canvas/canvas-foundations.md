# Canvas foundations and human/agent parity

Status: Required build scope, clarified by the owner after approving the ambient-assistant direction. The prototype adds group selection/context only. The rest of this document specifies the product we must build; it does not claim those controls or agent APIs already exist.

## Scope

Use FigJam's basic canvas and element interactions as the usability benchmark. Keep the agreed element types and quiet dark visual system. This is not a request for FigJam's complete element catalog: stickers, washi tape, sticky-note objects and decorative workshop elements are out of scope. Ordinary canvas text is still in scope. Referencing FigJam does not silently add unrelated drawing, diagramming or decorative object types.

Use selection handles, contextual actions, outline navigation, keyboard commands and the nonmodal command/shortcut rail. Do not add a permanent inspector full of labels or a blocking dialog to expose these foundations.

## Required controls

| Area | Human controls required for the build | Structured agent capability required |
| --- | --- | --- |
| Viewport | Pan, scroll, pointer-centered zoom, pinch where supported, fit all, fit selection/group, and return to a named target | Read/set the specified view's viewport and fit object IDs without estimating screen pixels |
| Selection | Click, Shift-toggle, multi-select, marquee/box selection, freehand selection lasso, select all in the active container, clear selection, and predictable keyboard navigation | Read/set/clear a selection by IDs and query hits by point, rectangle or polygon, with explicit containment/intersection semantics |
| Group selection | Select a group/section from its name, outline or bounds; select multiple groups; select a group together with unrelated elements; drill into a child and return to its parent | Address containers as first-class targets, read their hierarchy, select the parent or descendants explicitly, and normalize overlapping targets |
| Chat context | Add selected elements or whole groups to the next request; use the hold-key capture gesture; remove references directly | Add/remove typed references, resolve explicit descendants and inspect the same context manifest supplied to a request |
| Grouping | Group, ungroup, name/rename, wrap a selection, nest groups, move children between groups and reparent deliberately | Atomic group/ungroup/reparent commands over stable IDs, preserving world placement and returning the resulting hierarchy |
| Position and movement | Drag, keyboard nudge, coarse/fine movement, coordinate entry and moving a selected group as one unit | Read/set geometry in declared local or world coordinates and transform selected targets or a group hierarchy as one operation |
| Resize and transform | Side/corner resizing, proportional constraints, resize from center, numeric size entry, multi-element/group transforms, and rotate/flip where the element type supports them | Equivalent typed resize/scale/rotate/flip commands, with anchor, coordinate space and target IDs; report unsupported operations rather than guessing |
| Alignment and layout | Align edges/centers, distribute horizontally/vertically, equalize spacing, snap and alignment guides with a way to disable snapping | Deterministic align/distribute/layout commands with explicit anchors, spacing and snap settings |
| Layer ordering | Bring forward/back, bring to front/back and inspect order within a container | Read/set sibling order with stable IDs, preserving unrelated objects |
| Locking | Lock/unlock one or many elements and groups, inspect locked state, and intentionally unlock before editing | Read effective/local lock state and use the same explicit lock/unlock commands and edit restrictions as a human |
| Editing and clipboard | Edit supported content/properties, copy/cut/paste, duplicate, rename, soft delete/restore, and undo/redo | Structured create/update/clone/delete/restore/history commands that preserve author/revision rules and allocate new IDs when copying |
| Reading and inspection | Find elements, inspect properties, traverse the outline, open supported content, comments, history and sources, and capture/export a view or group | Search/read typed content, bounds, transforms, hierarchy, comments, sources and history; request equivalent renders/exports without using screenshots as the data model |
| Workspace and assistant actions | Change supported layout/preferences, choose context/session/provider/model, comment or ask an agent, and inspect/run/cancel permitted background work | Equivalent typed actions and readable lifecycle state through the same authorized command path; UI controls are never the only interface |

Selection lassos and context capture are different commands. A selection lasso changes the selection. The hold-Q capture gesture adds references to chat and does not group, move or reparent anything. Both need their own keyboard/pointer alternatives and agent equivalents.

## Groups are real objects

Groups, sections and frames have stable IDs and explicit membership. A title is not merely a text annotation. A named group such as Design exploration can be selected and attached as one context reference, including nested groups and their descendants. Do not flatten its name away into a collection of unrelated chips. If a parent and one of its children are both targeted, deduplicate the overlap so content is supplied or transformed once.

Support nested groups and deterministic parent/child navigation. Selection must let a user act on a group as a unit or deliberately drill down to an individual child. Nesting comes from stored parent IDs, never visual proximity. Reparenting must preserve the intended world placement; cycles are rejected. Ungroup preserves child IDs and their visible placement. Duplicating a subtree allocates new IDs and preserves its structure. Deleting a group soft-deletes its subtree and is distinct from ungrouping; restore/undo reconstruct the original hierarchy.

Distinguish auto-bounded groups from explicitly sized frames/sections. Resizing a frame's bounds is not silently the same as scaling its contents. A group's transform applies coherently to its children. Define supported resize/scale behavior for each existing element type before implementing handles, and use the same meaning in agent commands. Resizing or grouping must not change context membership accidentally.

A group reference is resolved at request submission with its hierarchy and actual supplied content revisions. It remains one named reference in the composer, with descendant details on demand. Earlier sent context does not change when the group is later edited. A subsequent request resolves the current group contents. Locked descendants are still readable context when access is allowed.

## Lock contract

Locking prevents accidental editing, not reading or attachment as context. Locked objects remain discoverable and inspectable, for example through the outline. No hidden agent API may bypass a lock. A human or agent must explicitly unlock through the same permitted action before changing protected geometry, content, membership or deletion state.

Group lock protects the group and its subtree. Preserve each child's local lock when the parent is unlocked. A child's unlock cannot override a locked ancestor. Where fixed frames/sections offer background-only locking, distinguish that mode from locking the whole subtree: the container bounds remain protected while its content stays editable. Do not offer a background-only mode for an auto-bounded group unless its geometry semantics are defined.

An operation affecting a locked descendant must either be rejected with structured reasons or explicitly target only editable objects with a visible partial-result summary. Do not silently skip or half-apply a compound transform. Use one consistent policy for pointer, keyboard and agent commands. Failed actions are understandable and recoverable.

## Agent-native means the same capability, not mouse imitation

Every human canvas action must have a structured agent operation and readable state/result. This includes ephemeral view actions such as selection, navigation and context attachment as well as stored content changes. A five-tool CRUD wrapper does not satisfy parity by itself. Agents must be able to group, resize, lock, align and perform the rest of the control set directly.

Route human controls and agent tools to the same validated domain commands. Keep actor identity, role permissions, lock rules, revision/conflict checks and undo semantics consistent. Expose stable IDs, typed arguments, coordinate spaces, hierarchy, capabilities and outcomes so agents do not need to guess from screenshots or reproduce a mouse gesture. Provide a machine-readable capability list with schemas and supported operations per element type. A newly added human feature includes its agent command and state query in the same implementation change.

Viewport, focus and selection are view-specific. Agents can inspect or operate on a specified view ID, including an explicitly requested human view; background work does not steal the human's focus merely because it wrote content. The agent can work in its own view or request a render. Group and document operations still share the canonical workspace model.

Pointer-free context capture might be expressed as the following proposed command. The name is illustrative; the final API must preserve its meaning:

```json
{
  "command": "canvas.context.add",
  "viewId": "view-7",
  "targetIds": ["design-exploration"],
  "includeDescendants": true,
  "requestId": "context-request-12"
}
```

The same principle covers agent control of existing session, model, task and configured voice workflows. It does not manufacture external input such as a human's speech or bypass the same device/access permissions a human faces.

## Build acceptance evidence

- Select a named group from the canvas and the outline, add it to chat, and inspect the one named reference plus its descendants. Repeat with nested groups, multiple groups and overlapping child selections.
- Exercise selection marquee/lasso independently of chat capture. Verify add/remove modifiers, keyboard alternatives, coordinate transforms and cancellation without structural writes.
- Group, nest, move, resize, reparent, reorder, duplicate, ungroup, delete and undo a representative hierarchy without ID loss, unintended movement or double transforms.
- Lock an element and a group, try the same prohibited actions from pointer, keyboard and agent commands, then explicitly unlock. Verify descendant locks, background-only section locking and atomic failure behavior.
- For each row in the capability matrix, perform the human action and the structured agent equivalent on equivalent fixtures; compare resulting content, geometry, hierarchy, state, failures and undo. No human-only command may be declared complete without its agent counterpart.
- Confirm snapping/alignment, coordinate editing and group transforms stay usable at different zoom levels. Preserve keyboard focus and the quiet ambient rail during these actions.
- Verify existing stored data and previous-release readability under the supervisor path. These are product acceptance requirements, not evidence the prototype has implemented them.

## References

Figma's own documentation grounds the interaction benchmark: [selection, movement and ordering](https://help.figma.com/hc/en-us/articles/1500004292221-Select-move-and-order-objects-in-FigJam), [grouping](https://help.figma.com/hc/en-us/articles/1500004414962-Group-objects-in-FigJam), [resizing and transforms](https://help.figma.com/hc/en-us/articles/1500006206242-Resize-rotate-and-flip-objects-in-FigJam), and [locking](https://help.figma.com/hc/en-us/articles/1500004291361-Lock-and-unlock-objects-in-FigJam). The controls above are this product's requirements; they are not a promise to copy every FigJam behavior or limitation.
