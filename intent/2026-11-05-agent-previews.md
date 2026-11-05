# Intent: Agent previews

**Status:** Draft

## Problem statement

An agent building a web UI has no way to show it inside Codeman. It can print `http://localhost:5173/`, and the user can save that as a web tab by hand, but nothing ties the tab to the session that made it. Deleting the session leaves the tab pointing at a dead port. A dev server the agent started with `nohup` or `setsid` leaves the session's process tree, so `killSession` (`src/tmux-manager.ts`) never stops it, and it holds its port until someone finds it. A session nobody deletes keeps its server running for days.

## Proposed outcome

An agent runs one command, `codeman agent preview add web --cmd "npm run dev -- --port {port}"`. Codeman picks a free port, starts the command in a process group it records, and shows the page through the existing web tab proxy. The session's tab gets a badge. Opening the session shows a Terminal and Preview switch. A Previews drawer lists every running preview with its session, port, uptime and a Delete button.

Codeman owns every preview server's lifetime. Deleting a preview stops its server. Deleting a session deletes its previews. A preview nobody has opened for 4 hours is stopped. A Codeman restart reconciles the recorded process groups, so no server outlives its record.

## Affected users and systems

- The operator, mostly on an iPhone, who reviews visual work and deletes previews from the UI.
- Agents in any mode, through `codeman agent preview` and `/api/v1/sessions/:id/previews`.
- Web tabs (`src/types/webview.ts`, `src/webview-store.ts`, `src/web/routes/webview-routes.ts`, `src/web/public/webview-tabs.js`). Previews are web tab records with a session origin.
- Session cleanup (`cleanupSession` in `src/web/server.ts`).

## Constraints

- Reuse the web tab proxy and capability model. No second proxy.
- An agent can never mark a preview `trusted`. The server refuses it at the API boundary.
- A new preview never takes focus. It only adds a badge.
- Remote and Docker sessions are refused with a clear error in v1. None exist on this install today.
- `/api/v1` is under SemVer. The new routes are additive.

## Open questions

None. The operator chose placement A with the drawer, deletion with the session, badge only, and a 4 hour idle stop on 2026-11-05.
