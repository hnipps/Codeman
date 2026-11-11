# Intent: Shape the initial Agentic Canvas

**Status:** Complete

## Problem statement

The approved implementation plan needs a concrete canvas UI/UX before its PRs begin. The owner supplied spatial interaction recordings, Opsdeck as a visual reference, a dark-mode requirement and a strong preference for keyboard shortcuts.

## Proposed outcome

Revise the accepted direction into a canvas-first agent workspace: remove the navbar, put search in the outline, reduce system labels and replace the floating chat card with an ambient assistant in a thin right-hand panel that collapses completely. Add direct selection and hold-key lasso context capture, voice, background tasks, provider/model selection and a keyboard-first interaction map without a context modal. Make named groups selectable/contextual in the prototype. Record the required FigJam-style canvas interaction foundations and human/agent capability parity for implementation, without adding decorative element types or implementing the entire control set in the prototype. Deliver a shaped brief, reviewable desktop and phone sketches, a dark palette, a scoped keyboard map, material states and implementation-plan updates. Design sketches demonstrate intended composition, not implemented canvas functionality.

## Affected users and systems

The owner and future canvas implementation agents. Work is isolated on a branch from master and changes design artifacts only.

## Constraints

Honor the approved delegation of design decisions. Preserve explicit containment, authorship, existing terminal behavior, forward-compatible storage and the supervisor deployment path. The owner has brought canvas-native chat and agent participation in comment threads into the design scope. Keep Git/CI, worktree automation and production-operation UI deferred. Do not change production UI or deploy a design sketch.

## Open questions

The current brief records the thin ambient rail, lossless lasso context, nonmodal shortcuts and threads, separate voice modes, isolated background task identity and provider/model routing. Native session/audio adapters, configured model catalogs, real agent execution, durable data and performance remain implementation work. Selectable group context is verified in the prototype. The full FigJam-style foundations and human/agent capability parity are required implementation scope, not additional prototype features. The browser prototype verifies UI behavior only.
