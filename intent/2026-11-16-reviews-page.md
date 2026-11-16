# Intent: Reviews page

**Status:** Draft

## Problem statement

Harry judges finished agent work on GitHub: he opens a pull request, reads a diff with no explanation of where to look, and cannot see the change running. The agent that did the work knows what changed and why, and nothing in Codeman lets it say so beside the running result.

## Proposed outcome

A full-screen Reviews page inside Codeman.

- An agent submits a review for a finished branch: a title and a walkthrough written as Markdown. It does this with `codeman agent review submit` or the MCP tool `submit_review`.
- The page shows three columns: a queue of reviews waiting and decided today, the walkthrough, and a stage with **Preview** and **Changes** tabs and a Desktop or Phone switch.
- Links in the walkthrough move the stage. A code link opens Changes at a file and line range. A preview link moves the preview to a path.
- Harry leaves notes anchored to walkthrough text, to a line of the diff, or to a preview link. **Request changes** sends every unsent note to the authoring session as one prompt. Harry resolves notes; agents never do.
- **Approve** merges the branch. For the Codeman repository it then deploys with `codeman-deploy`. For any other project it merges only. No GitHub pull request is involved.
- Nothing is merged, deployed or sent without a button press by a person.
- The sessions rail links to the page, and a Work item in review links to its review.
- On a phone the page shows one column at a time, opens the preview or the code full screen from a link, and keeps the verdict buttons in a fixed bar.

Preview differs by project:

- Any project other than Codeman: the authoring session's preview server, live in the stage.
- A Codeman branch: still captures in the stage, plus **Open live**, which opens the branch running in its own throwaway VM on its own address (`docs/review-instance-address-plan.md`).

### Slices

1. Store, routes, submit, the page with queue, walkthrough, Changes, notes and Request changes.
2. Preview in the stage for other projects; stale-link marks when the branch moves.
3. Approve: merge, and deploy for the Codeman repository.
4. Captures: stills the agent takes of the running branch and sends with the review (built). **Open live** for Codeman branches, against the supervisor's `review` commands (waits for the host-side service).
5. Entry points from the rail and from Work items; the stand-in `claude` and seed data for preview VMs.

## Affected users and systems

- Harry, on desktop and phone.
- Agents, through one new CLI verb and one new MCP tool.
- New: `src/reviews/`, `src/web/routes/review-routes.ts`, `src/web/public/reviews.{html,js,css}`, one SSE event, one data directory `reviews/`.
- Reused, not changed in behaviour: prompt delivery (`deliver()`), preview servers and their web tabs, the Markdown sanitizer, the deploy supervisor command.

## Constraints

- Only the live colour writes. Every write checks `deployRole.allows('persist')` when it acts; merge and deploy check `requestDeploy`.
- Stored data stays readable by the previous release: one new directory, `version: 1`, and a file that does not parse is never overwritten.
- Person-only actions (notes, resolve, Request changes, Approve) refuse a request that carries the agent header.
- Git runs argv-only, non-interactive, with a timeout, and never for a remote or Docker session or inside a Docker case workspace.
- A review belongs to its author session's owner. Lists, reads and the SSE event are scoped by owner.
- Every string from an agent or from git is written with `textContent`. Markdown goes only through the existing parser and sanitizer.
- A preview in the stage is a sandboxed frame without `allow-same-origin`. A running Codeman branch is never framed.
- The repository is public: no host, address, port or path in code, tests or docs.
- Merge never rewrites history and never force-updates a branch. If the merge does not apply cleanly, Approve refuses and says why.

## Decisions (owner, 2026-11-16)

- A note on a preview anchors to an element on the page, not to a path. Notes on the preview can be hidden and shown, so they do not cover the page while it is being tested.
- Approve merges into the base branch without touching a checkout of it. A base branch that is checked out, with or without uncommitted changes, keeps its working tree as it was.
- The owner does not review the pull request. The feature is merged and deployed once every slice is built and verified.
