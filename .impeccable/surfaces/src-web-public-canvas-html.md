---
version: 1
slug: "src-web-public-canvas-html"
primary_target: "src/web/public/canvas.html"
related_targets: ["packages/canvas"]
---

# Canvas surface

Scope: the Agentic Canvas tab (`/canvas/:workspaceId`) and its assistant rail. Mode: Operate. Build path: code-led.
Audience and job: one owner arranging product context and directing coding agents, on a laptop for long sessions and on a phone for quick reads and comments.
Source of truth: `docs/agentic-canvas/canvas-ui-ux-brief.md` (layout, palette, shortcut map, states) and `docs/agentic-canvas/canvas-foundations.md` (control and agent-parity matrix). The owner pinned this direction on 2026-11-10; no concept round is owed.
Critique reference: `docs/agentic-canvas/design/group-context.png`, `canvas-hidden.png`, `phone-focus.png`.

## Direction contract

THESIS: The board is the work and nothing else. It refuses the whiteboard-app arrangement of top navbar, floating toolbars, inspector and chat card; system detail appears only where asked for.

OWN-WORLD: Matte dark Opsdeck adaptation. Canvas `#16181b`, panel `#1e2125`, raised `#282c32`, divider `#353940`, text `#f2f1ed`. One amber `#f58a45` reserved for keyboard focus, the selected tool and the primary action. Selection is a thin neutral boundary with corner marks, never amber. System sans for prose, tabular mono only for keys, counts, ids. 4px grid, 4px control corners, 6px media corners. No glow, texture or gradient.

STORY: The owner opens a case's canvas, sees their own content first, selects or circles objects, and hands them to an agent without leaving the board.

FIRST VIEWPORT: Full-bleed board. 192px collapsible outline at left with Search canvas at its top. Compact five-control tool dock bottom centre, Fit beside it. 320px assistant rail overlaying the right edge, composer at its foot with context chips directly above, provider and model selectors beneath. Rail closed leaves no handle, tab or reserved width, and the camera does not move.

SIGNATURE INTERACTION: Hold Q and draw a freehand loop; enclosed objects outline as a preview and on release become named context chips with the composer focused. Releasing Q early, Escape or blur cancels with no change. Motion grammar: 120ms opacity and transform only, rail slides 160ms, nothing animates on agent writes; reduced motion removes all of it.

FORM: Pinned by the owner's review, position 1 of 1. seed:70e5d97c709181a0

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
