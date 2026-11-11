# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The initial user is one person designing and building products with coding agents, from a laptop browser and a phone. Multiplayer is a future goal.

## Product Purpose

Agentic Canvas is a working name for a self-hosted workspace that holds product context from design exploration through software delivery and operation. The canvas is intended to become the primary workspace, with an ambient assistant in a thin, fully collapsible right-hand rail and comment threads as interfaces to agents inside it. Codeman is the current delivery shell, not the target interaction model. The app is modified with agents from within the same workspace.

## Positioning

Objects, containers, records and logs have stable identities and agent-readable content. Requests can refer to explicit containers rather than relying on screenshots or visual proximity. The same workspace ultimately builds products, internal tools and itself.

## Operating Context

Codeman runs existing agent CLIs. The current self-building deployment uses Claude Code in tmux, supervised deployment, telemetry and rollback. The browser is the interface. The approved canvas plan delegates bounded orchestration, verification, PR landing and deployment to the coordinating agent for that program.

## Capabilities and Constraints

The initial canvas scope is C1–C5, O1–O3 and L1–L2 of docs/agentic-canvas/vision.md: pan/zoom; images, text, links, embeds and explicit containers; screenshots; agent object access; and queryable redacted logs. Phone use emphasizes viewing, navigation and comments. The owner has added canvas-native conversations and agent participation in comment threads to the design target. Git-backed document editing, automated canvas worktree management, PR/CI records and production operations remain later work. Existing Codeman sessions remain the execution base during migration. Canvas conversation views should refer to real sessions rather than introduce a second agent loop. Users can arrange canvas content and ask agents to change the app itself through its supervised self-building path. Sessions are addressable records accessed through the assistant rail, not floating chat cards. Direct selection and a hold-key lasso add objects to request context without a modal. Voice, independently managed background agents and configured provider/model choice are required design scope.

The build requires FigJam-style interaction foundations: selection marquee/lasso, grouping and ungrouping, nested groups, resizing and transforms, locking, movement, alignment/order, clipboard and undo/redo. Groups and sections are selectable and attach as named context including descendants. The prototype does not need to implement the complete control set. Stickers, washi tape, sticky-note objects and decorative workshop elements are excluded; the agreed element types stay in scope.

Every action a human can perform in the canvas must also be possible through structured agent-native controls with readable state and the same permissions, lock and undo rules. UI automation and basic CRUD alone do not satisfy this requirement. See docs/agentic-canvas/canvas-foundations.md for the shared capability matrix.

Every write records authorship. Group membership is explicit. The server operation log is the planned authority. Data must remain readable by the previous release; rollback restores code only. Changes go through the supervisor. No server identifiers belong in public source.

## Brand Commitments

The owner supplied three spatial-canvas recordings and Opsdeck as design references, asked for a dark adaptation and emphasized keyboard shortcuts. Subsequent feedback removes the canvas navbar, moves search into the outline and reduces system annotations on the board. Latest feedback rejects floating chat cards and modal context pickers, requests a thin dismissible assistant rail and cites HeyClicky as an interaction reference. The references are documented in docs/agentic-canvas/canvas-design-references.md. The rest of Codeman is outside this design's visual scope.

## Evidence on Hand

The vision, minimal PRD, coding brief, approved initial-version plan, owner review and design references establish the requirements. Recordings demonstrate reference interactions, not behavior already implemented in Codeman. Opsdeck's source establishes its visual rules; its inherited dark palette is not a verified dark theme. Composition examples in this design use illustrative project content.

## Product Principles

- Keep design context readable by people and agents.
- Make containment, per-message starting context and authorship explicit. Agents can discover the whole workspace; an attached group guides attention without silently hiding everything else.
- Treat sessions, comment threads, references and tools as addressable workspace records with shared context; the assistant stays ambient and keyboard accessible.
- Preserve work and sessions across releases and recovery.
- Keep frequent actions accessible from keyboard, pointer and touch where supported.

## Accessibility & Inclusion

The owner explicitly values keyboard access. Design must preserve text entry, IME, browser shortcuts and terminal input, expose visible focus and keep pointer or touch alternatives to shortcut actions. Exact contrast targets are design acceptance criteria, not claims of existing compliance.

## Open Decisions

The canvas renderer and eventual multiplayer architecture remain implementation decisions. The design must not require an unverified renderer or promise offline writes.
