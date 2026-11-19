# Intent: Chat Graph chat UI (design spec)

**Status:** Draft (revision 1, design spec for the owner's Spec review. Work item W-78. It designs ticket 6 of the Chat Graph spec, `intent/2026-11-18-chat-graph.md` on master at revision 5, filed as W-84.)

**Extends:** `intent/2026-11-18-chat-graph.md`. That spec is merged and stays unchanged. This spec adds the five API pieces listed under "Additions to the Chat Graph API", which the screens need and the merged spec does not define. Approving this spec approves those additions.

**Prototypes:** the canvas frame `chat-graph-ui-study`, one row per screen or state, desktop (1280 px) on the left and phone (414 px) on the right. Every embed carries a screenshot thumbnail, so a phone shows a picture instead of a Paused card. The source is `docs/design/chat-graph-ui/` in this change. All content in it is made up.

## Problem statement

The Chat Graph back end (W-76, tickets 1 to 5 and 7 to 9) can file messages to topics, but nothing shows it to Harry. Ticket 6 has no design to build against. The design doc's UX section on the canvas (`chat-graph-design-doc`) is a rough idea, and the merged spec says so. Without a design, the builder would have to decide where the chat lives, how a chip looks at each confidence, what Harry sees during the 5 second routing wait, and how every failure looks, and any of those choices could change something the owner sees.

## Outcomes

1. **One chat box on the canvas.** Chat is a rail view on every canvas workspace, opened with `T` or the dock's Chat button. On a desktop, `F` widens it to a full view with the topic list and the open topic beside the chat. On a phone the rail already fills the screen.
2. **A chip under every message** names its topic. How the chip looks depends on the reranker's band: quiet above 0.8, prominent from 0.5 to 0.8, and "New topic: X" below 0.5. Unsorted and Filing have their own looks. A message filed to two topics shows two chips.
3. **A tap on a chip opens one menu:** Move to another topic, Also add to another topic, Open the topic, and, when an archived topic matched, Reactivate it and move the message there. On a phone the menu is a bottom sheet.
4. **A context line under each reply** names every topic the reply used. A topic used only through its card says "(card)".
5. **Related shows only after a reply finishes**, as one quiet row under it, with "Also file there" and "Dismiss".
6. **The routing wait is visible and does not block.** The message shows at once with a "Filing" chip, a status line counts the seconds, and Harry can keep typing and send the next message.
7. **Capture is one gesture.** A draft that starts with `>` switches the button to Capture and says the message gets no reply. A sent capture shows its chip and one line, "Captured to Errands. No reply."
8. **Topic list.** Active topics by last activity, each with its summary preview, open-item count and message count. A search box filters it, and an Active / Archived switch shows archived topics. Unsorted is pinned at the top while it holds anything.
9. **Topic view.** Proposals (merge, split, a note from another topic) are banners at the top, each with its own buttons. Below them, the summary and the open items, both editable, then the topic's messages. A composer at the bottom writes straight to this topic.
10. **Every failure leaves Harry's text where it was**, and says what happened in one line: the sidecar is down (503), a message landed in Unsorted, the bootstrap import is still running, or nothing exists yet.

## Affected users and systems

- Harry, on the canvas at a desktop and on an iPhone.
- `packages/canvas/src/` (a new rail view and its modules), `src/web/public/canvas.html` and `canvas.css` (or a new `canvas-chat.css`, as Work has `canvas-work.css`), `packages/canvas/src/shortcuts.ts` (two keys), `packages/canvas/src/mobile.ts` (the phone dock).
- `src/web/routes/chat-graph-routes.ts`, `src/web/sse-events.ts` and `constants.js` for the additions below. The sidecar for the two new op kinds.

## Constraints

- **Canvas design language.** The tokens, type, spacing and controls come from `canvas.css` and `DESIGN.md`: system sans 14/1.45, 12 px supporting text, tabular monospace for times and counts, 4 px spacing steps, 4 px control and 6 px content corners, 32 px controls on a desktop and 44 px on a phone, 16 px fields on a phone. Amber means focus or "needs you", nothing else. The rail is never a modal and never a floating card (PRODUCT.md).
- **Topic, never thread.** UI copy, labels, `aria-label`, `title` and placeholders say "topic". The code says topic too, because "thread" already means a canvas comment thread.
- **Rich text only from the agent.** Message text, topic titles, summaries, open items and proposal text from the store go in through `textContent`. Claude's replies render through `renderMarkdown()` (`packages/canvas/src/markdown.ts`), as the assistant's do.
- **The merged spec's rules hold:** I2 (a chip per live membership), I3 (an archived topic is never a silent target), I8 (the context line lists exactly the sources), I9 (an agent never writes another topic), I10 (a capture gets no reply), the 503 `CHAT_GRAPH_UNAVAILABLE` answer and the multi-user refusal.
- **SSE never moves anything.** A `chat-graph:*` event never moves the camera, selection, focus or rail view, and scrolls the chat only when it was already at its end (the assistant's rule).
- **Keys stay out of text fields.** `T` and Shift+T act only on the board or a non-text control, never during IME composition, and a hardware key on a phone does nothing, as with `G` and `B`.
- **Single user.** In multi-user mode the dock button and the rail view are absent, because the routes refuse.

## Invariants

These are the UI's own promises. Each names the test that pins it.

### U1: SentTextIsNeverLost

The composer keeps its draft until the server has answered 2xx to `POST /api/chat-graph/messages`. A 503, a network failure or a timeout leaves the draft and shows one line saying what happened, with Retry.

- *Test:* a browser test answers the POST with 503, then with a dropped connection. The draft is unchanged each time, and the line names the cause.

### U2: EveryFiledMessageShowsItsTopics

Once `chat-graph:routed` arrives for a message, the message shows exactly one chip per live membership in that event, and no Filing chip. Before it arrives the message shows one Filing chip. A reassign, add or undo repaints the chips from the server's answer, never from a local guess.

- *Test:* fixtures for one, two and zero-then-Unsorted memberships. The chip count equals the live membership count after each event.

### U3: RelatedWaitsForTheReply

A Related row is drawn only from a `chat-graph:related` event, and only under a reply whose turn has ended. A related event for a turn still in progress is held until the reply's message arrives.

- *Test:* the event arrives before the reply. Nothing is drawn until the reply is drawn, and then the row appears under it.

### U4: ArchivedOnlyThroughReactivate

The topic picker (Move, Also add) lists active topics only. An archived topic can be reached only through a Reactivate action, which names it.

- *Test:* the picker's rows never include a topic whose status is `archived`. The Reactivate item appears only when the routed event names an archived match.

### U5: CapturesShowNoReplyState

A message of kind `capture` never shows "Replying", a Related row or a context line.

- *Test:* a capture fixture with a stray `chat-graph:related` event for it. None of the three is drawn.

### U6: ProposalsNeedAPress

A proposal is accepted or rejected only by the person's press on its button. Nothing in the view, and no `canvas_view` command, accepts one.

- *Test:* a static scan of the chat modules finds `/proposals/` writes only in the button handlers. A view command cannot reach them.

### U7: NoThreadInCopy

No string the chat UI shows or announces contains "thread".

- *Test:* a gate test reads every chat module's user-facing strings, as `test/tile-grid-i18n.test.ts` harvests strings, and refuses `/thread/i`.

## Non-goals

- A page outside the canvas, or a Chat entry in the classic dashboard.
- Replacing the canvas Assistant. It stays a separate rail view, as the merged spec's non-goals require.
- A visual graph of topics.
- Voice input for the chat. The assistant's voice controls are not copied in this round.
- A digest of captures.
- The split-point picker beyond what is described under Topic view. It is designed in prose here and gets its own frame in ticket UI-5's review.

## Acceptance checks

1. Each screen and state below matches its prototype frame at 1280 px and at 414 px, both themes, checked by the builder with screenshots at device scale 1 and attached to the review.
2. `npm test -- test/chat-graph-ui*.test.ts` passes, with one or more cases per invariant marked `// Invariant U<N>: <Name>`.
3. `npm run test:browser -- test/chat-graph-ui.browser.test.ts` passes on fixtures, with no sidecar, for every state in the Design table.
4. `npm run test:mobile -- test/mobile/chat-graph-ui.test.ts` passes at the 414 px iPhone profile: 44 px targets, the chip menu as a sheet, the composer above the keyboard.
5. The merged spec's acceptance check 7, by hand on a throwaway instance: the chat, the chips, reassign, the topic list, the topic view with summary and open items, merge and undo, on a desktop and on the iPhone.
6. A grep of the chat modules and the canvas HTML finds no user-facing "thread".

## Design

### Where it lives

The chat is a **rail view**, `chat`, on every canvas workspace. There is one chat, not one per workspace. `T` toggles it, like `C` for the assistant, and the dock gains a Chat button beside the Assistant. **Shift+T** opens the topic list. **F** in the chat rail opens the **full view**: topic list (288 px), chat (centred, at most 680 px of text), open topic (360 px). F or Escape returns to the rail. On a phone the rail fills the viewport with a visible Close, as the assistant does, and there is no full view.

The rail is 400 px wide by default when the chat opens, because chips and the context line need the room. The person can still resize it (`panel-widths.ts`).

### Screens and states

Frame ids are canvas object ids inside `chat-graph-ui-study`. The "Reads" column names routes under `/api/chat-graph` and SSE events from the merged spec. Names in *italics* are additions defined below.

| # | Screen or state | Desktop frame | Phone frame | Reads | Writes |
| --- | --- | --- | --- | --- | --- |
| 1 | Chat: chips by band, context line, Related | `132e05d8` | `b14e1324` | *`GET /messages`*, `GET /topics`, `chat-graph:routed`, *`chat-graph:message`*, `chat-graph:related` | `POST /messages` |
| 2 | Chip menu: move, add, open, reactivate | `7fa53207` | `72ec1a0b` | `GET /topics` (picker) | `POST /messages/:id/reassign` (*mode*), `POST /ops` (reactivate) |
| 3 | Routing wait, about 5 s | `116fbe06` | `fa2be192` | `chat-graph:routed` | `POST /messages` |
| 4 | Capture with `>` and its acknowledgement | `fabf1749` | `eee6fe51` | `chat-graph:routed` | `POST /messages` |
| 5 | Topic list, active by last activity | `b49b6724` | `68eeed85` | `GET /topics` | none |
| 6 | Topic list, Archived filter | `22d5c190` | `12e7e06d` | `GET /topics` | `POST /ops` (reactivate) |
| 7 | Topic view: proposals, summary, open items, undo | `b328f7e6` | `9e02d9a0` | `GET /topics/:id`, `GET /proposals`, *`GET /topics/:id/summaries`* | `POST /proposals/:id/{accept,reject}`, `POST /ops` (merge, split, archive, *edit-summary*, *edit-open-items*), `POST /ops/:id/undo`, `POST /messages` (*topicId*) |
| 8 | Full view (desktop only) | `779c369b` | none: the phone rail is already full screen | as 1, 5 and 7 | as 1, 5 and 7 |
| 9 | State: routed to Unsorted | `ebf1ef73` | `f2511cac` | `chat-graph:routed` | `POST /messages/:id/reassign` |
| 10 | State: sidecar down (503) | `71d84c20` | `ab493379` | any route answering 503 `CHAT_GRAPH_UNAVAILABLE` | none |
| 11 | State: empty first run | `3bb81c1e` | `f34d1eff` | *`GET /messages`*, `GET /topics` (both empty) | `POST /messages` |
| 12 | State: bootstrap in progress | `7d1bc060` | `53da547a` | *`GET /status`* | `POST /messages` |

Full object ids, in table order: `132e05d8-6aa4-4f9e-9791-33ee5be40a3c`, `b14e1324-6c1c-4c83-8992-e4dfed5d315b`, `7fa53207-abd7-47c0-8f08-3234eaa5e6f8`, `72ec1a0b-86dc-4e98-b12d-92098257778f`, `116fbe06-f6e6-4e37-a4d7-87b4b22beab8`, `fa2be192-d8a3-499f-a027-d6eaf31c6ee5`, `fabf1749-ba41-420c-845e-31700559e571`, `eee6fe51-b2a3-4ce7-a601-ed8b63da883b`, `b49b6724-562a-443d-a0f1-b9b1769eb952`, `68eeed85-80bf-4de6-8dd1-00c2127e92a9`, `22d5c190-f9cf-47ce-8bbc-a5c8ecfef4c1`, `12e7e06d-ad9a-41b0-9d10-a370a7ee3674`, `b328f7e6-be1c-4fe1-b783-c5abdb4c1a31`, `9e02d9a0-fe30-40c0-bcae-78b92bfdf8b7`, `779c369b-1b0e-4e77-8ea8-441ac736e2d3`, `ebf1ef73-3114-49af-82f7-fd6fd9a48fa5`, `f2511cac-bad1-431c-8be2-c2fa040e7d16`, `71d84c20-f26b-4327-bf17-f8c3efcadbce`, `ab493379-8f94-4b80-9b5e-9b06a0424918`, `3bb81c1e-a987-424a-b368-aa06b8c43489`, `f34d1eff-30eb-442d-bab5-92c8291226e2`, `7d1bc060-b812-4807-a974-ff0ac6009dcc`, `53da547a-b1d6-4e84-bb63-7c3a05595079`.

### The chat (frame 1)

- Turns follow the assistant's quiet style: a small `You` or `Claude` label with the time at the right, no bubbles, a 2 px divider rule beside the person's text. The chat opens at its end.
- **Chips** sit under the person's message, 24 px tall with a 32 px hit area (32 px tall with a 44 px hit area on a phone), 12 px text:

  | Band (reranker score) | Look | Copy |
  | --- | --- | --- |
  | above 0.8 | No border, muted text. A border appears on hover. | `Kitchen budget` |
  | 0.5 to 0.8 | 1 px amber border, a faint amber fill, and an amber tail word | `Conference talk Change` |
  | below 0.5 (new topic) | Raised fill, secondary border, a plus icon | `New topic: Garden shed Change` |
  | Unsorted | Dashed amber border | `Unsorted Pick a topic` |
  | Filing | Dashed muted border, three pulsing dots (static under reduced motion), not pressable | `Filing` |

  The prominent band uses amber because a person should look at it, which is what amber already means on the canvas. The design doc's own risk table asks for low-confidence chips to be visibly different, not only for high-confidence ones to be quiet.
- **Context line** under each reply: `Used Kitchen budget · Laptop upgrade (card)`, 12 px. Each topic name is a link that opens that topic. It lists exactly the reply's source ids (I8).
- **Related** is one row in a 1 px bordered box under a finished reply: "Related: **Laptop upgrade**. The demo was planned on the new laptop." with **Also file there** (adds a membership with mode `add`) and **Dismiss** (drops it for this message; nothing is written).
- While a reply is in progress the line under the chat says "Claude is replying", using the topic conversation's session state, as the assistant's state line does.

### Chip menu (frame 2)

A popover under the chip on a desktop (272 px, one 1 px border, the canvas menu style), a bottom sheet with a scrim on a phone (48 px rows). Its first line says where the message went and why, in words: "Filed to a new topic, **Garden shed**. An archived topic, **Shed plans**, also matched." Then:

- **Move to another topic…** opens a picker in place: a search field over the active topics, most recent first, and "New topic…" at the end. Moving sends `reassign` with mode `move`.
- **Also add to another topic…** opens the same picker and sends mode `add`. The message then shows two chips.
- **Open <topic>** opens the topic view.
- **Reactivate <archived topic> and move this there**, shown only when the routed event named an archived match (I3). It runs the reactivate op, then a move.

Every change shows the canvas's quiet undo notice at the bottom of the rail ("Moved 1 message here from Garden shed. Undo"). Undo calls `POST /ops/:id/undo` with the op the change created. A routing op cannot be undone (I2), so the notice is offered only for a person's own change.

### Routing wait (frame 3)

The message appears the moment the POST answers, with a Filing chip. The status line under the chat says "Finding the topic · 3 s. Replies start once it is filed.", counting whole seconds. The composer stays enabled and says "You can keep typing. Each message is filed on its own." Each message is posted when sent, not held behind the previous one. After 12 s the line adds "This can take up to 20 seconds." At the sidecar's 20 s deadline the event files it to Unsorted (frame 9).

### Capture (frame 4)

A draft starting with `>` gives the field a stronger border, a line under it ("Capture: filed to a topic, no reply."), and turns Send into **Capture**. The sent message shows a small `Capture` tag next to `You`, its chip (from `chat-graph:routed`) and one line, "Captured to Errands. No reply." The leading `>` is not shown in the stored text. In a topic view the open item list marks items that came from captures.

### Topic list (frames 5, 6)

Reached from the list icon in the chat's head, Shift+T, or the full view's left column. Head: back to Chat. A search field ("Find a topic") filters the loaded list in the browser by title and summary; asking the chat "do I have anything on X?" stays the way to search message text. An Active / Archived switch with counts. Rows show the title, last activity as a relative time in tabular figures, a two-line summary preview, and "2 open items · 38 messages". **Unsorted** is pinned at the top with a dashed amber border and "1 message to file" while it holds messages, and is absent when empty. The Archived list ends with "Archived topics never take new messages by themselves. Open one to reactivate it."

### Topic view (frame 7)

- Head: back to Topics, the title, and in the full view a menu for Merge, Split and Archive. The rail shows those three as a link under the head.
- **Proposals** are banners at the top, each a 1 px amber box with its kind as a small amber line: "Merge suggestion" (Review merge, Not now), "Note from Laptop upgrade" with the quoted note (Add note, Reject), "Split suggestion" (Review split, Not now). Review opens the op with its effect listed before Confirm. Nothing is applied without a press (U6).
- **Summary** with Edit. The version line says "Version 6 · updated 10:02 · Earlier versions". Editing saves a new version through `edit-summary`.
- **Open items** as checkboxes, with Add. Checking, adding or rewording an item goes through `edit-open-items`. Captures are marked.
- **Messages**, newest last, compact, with their chips.
- **Split** (designed here, built in UI-5): Split opens a mode where each gap between messages has a "Split here" control, the first press marks the start and the second the end of a contiguous run, and a bar at the bottom names the new topic and Confirm. The repair pass's suggested split point is preselected.
- **Composer**: "Message Kitchen budget". A message written here names this topic as its explicit signal, so it attaches at once with no model call and no wait.

### States (frames 9 to 12)

- **Unsorted.** The chip is "Unsorted · Pick a topic", and a line under it says "Filing took too long, so this went to Unsorted. No reply until you pick a topic." Pick a topic opens the move picker. Picking one moves the message and, as an explicit signal, starts the reply.
- **Sidecar down.** A send keeps the draft and shows, above the actions, "Chat is not running, so nothing was sent. Your message is still here." with Retry beside Send. Opening the chat while it is down shows the same sentence in the chat area and no stale content. Topic list and topic view say "Topics are unavailable while Chat is not running." Nothing retries by itself.
- **Empty first run.** "One chat for everything", then three short lines: what filing does, how `>` works, and that topics appear in the topic list as they are made. The composer is ready.
- **Bootstrap.** A strip under the head: "Filing your canvas conversations from the last 7 days · 46 of 120" with a 2 px bar. The chat works meanwhile, and a line says "Messages you send now are filed before the rest of the import." The strip goes when the import ends, with no toast.

### Copy rules

Topic, never thread. Sentences in the product's plain voice, no exclamation marks. Errors name the problem and what is kept. Buttons name their action ("Also file there", "Add note", "Review merge").

## Additions to the Chat Graph API

The merged spec's routes cannot draw the chat timeline, announce a reply, edit a summary or report the import's progress. These five additions are additive (rule 5), single-user, and refuse with 503 like the rest.

1. **`GET /api/chat-graph/messages?before=<id>&limit=<n>`** (default 50, max 200). Recent messages across all topics, oldest first, each with its kind, author, live memberships (topic id, title, status, band) and, for an agent message, its source topic ids. It feeds the chat's history and its first paint.
2. **SSE `chat-graph:message`.** Sent when an agent message is stored (ticket 5's reply capture), with the message id, its topic id and its source ids. The browser then reads the text with `GET /messages`. This keeps chat text out of the event, which the merged spec's privacy constraint prefers.
3. **Two op kinds, `edit-summary` and `edit-open-items`,** through `POST /ops`, each storing a new summary version (the merged spec already versions summaries), and **`GET /topics/:id/summaries`** to list versions. As ops they are idempotent and undoable (I5).
4. **`GET /api/chat-graph/status`** answering `{ state: 'ready' | 'bootstrapping', done, total }`. The browser reads it on open and every 5 s while `bootstrapping`.
5. **Named fields.** `POST /messages/:id/reassign` takes `{ topicId, mode: 'move' | 'add' }`. `POST /messages` takes an optional `topicId`, the explicit signal from a topic view's composer or a picked Unsorted topic. `chat-graph:routed` carries, per membership, its band and, when one matched, the archived topic's id and title for the Reactivate item.

## Technical design

- **Modules** in `packages/canvas/src/`, following Work's split (pure model, one DOM module):
  - `chat-model.ts` (pure): band from score, chip list from memberships, picker filtering (active only, U4), when a Related row may show (U3), the status-line text for the wait.
  - `chat-view.ts`: the only DOM for the chat, the chip menu and the composer.
  - `topics-view.ts`: the only DOM for the topic list and the topic view.
  - `chat-client.ts`: the routes and the event handlers.
- **Rail and keys:** a new rail view `chat`, with sub-views `list` and `topic`. `T` and Shift+T in `shortcuts.ts`, listed in Keys. `F` inside the chat rail opens the full view, which is the rail at full width, not `#fullView` (that stays the session page).
- **Styles:** `canvas-chat.css`, linked after `canvas-work.css`, on the canvas tokens only.
- **Phone:** the rail at full viewport, the chip menu as a sheet, a Chat icon in the phone dock, hardware `T` ignored.
- **Telemetry:** `uiEvent('chat', <action>)` for send, capture, chip-move, chip-add, reactivate, open-topic, proposal-accept, proposal-reject, with ids only, never text.
- **Risks:**
  - *The rail is narrow for the topic view.* The full view is the answer on a desktop. If the owner finds the rail too cramped, the topic view can open in the full view by default.
  - *Two chips per message can crowd a phone.* Chips wrap. A message with three or more memberships shows two and "+1".
  - *Polling status every 5 s during bootstrap* is the only polling. It stops when the state is `ready`.

## Decisions for Harry

These are assumptions this spec makes. Each is easy to change in review.

1. **Where the chat lives: a canvas rail view on every workspace, plus a desktop full view.** Not its own page, and not in the classic dashboard. Alternative: a dedicated `chat` page.
2. **Chat sits beside the Assistant, not in place of it.** The merged spec keeps canvas conversations as they are. Merging the two is a later spec.
3. **Typing in a topic view files to that topic at once**, as an explicit signal, so there is no 5 s wait there. Alternative: route it like any other message.
4. **The prominent chip (0.5 to 0.8) is amber.** It asks to be checked. Alternative: a neutral border, keeping amber for Unsorted only.
5. **Related's accept files the message in the related topic too** (a membership add). Alternative: a link with no membership.
6. **During the bootstrap import, new messages are filed first**, ahead of the backlog.
7. **Keys: `T` opens the chat, Shift+T the topic list.** Both letters are free today.

## Checks run

- Every frame was loaded headless at 1280 x 800 and 414 x 860, dark theme, device scale 1, with no console or page errors. `canvas_prototype check` was run on the phone chip menu inside the canvas sandbox, with no errors.
- A script read every state's visible text, `aria-label`, `title` and placeholder at both widths. None contains "thread".
- The routes and events in the table were checked against `intent/2026-11-18-chat-graph.md` revision 5 on master. Everything not in that file is listed under Additions.

<details><summary>Tickets for the UI build (6), replacing W-84's single ticket</summary>

**UI-1: API additions.** Order 1. Depends on Chat Graph tickets 4, 5 and 7.
- The five additions above: `GET /messages`, `chat-graph:message`, the two edit ops and `GET /topics/:id/summaries`, `GET /status`, and the named fields.
- Route tests with `app.inject()`, and the SSE registry parity test.

**UI-2: Chat rail view.** Order 2. Depends on UI-1.
- The rail view, `T`, the dock button, the chat, the composer, chips in every band, the routing wait, capture, Unsorted, sidecar down, empty, and the bootstrap strip.
- U1, U2, U5 and U7. Frames 1, 3, 4, 9, 10, 11 and 12.

**UI-3: Chip menu and undo.** Order 3. Depends on UI-2 and Chat Graph ticket 7.
- The menu, the picker, move, add, reactivate and the undo notice.
- U4. Frame 2.

**UI-4: Context line and Related.** Order 4. Depends on UI-2 and Chat Graph ticket 8.
- The context line from source ids, the Related row and its two actions.
- U3. Frame 1.

**UI-5: Topic list and topic view.** Order 5. Depends on UI-3 and Chat Graph tickets 7 and 8.
- The list with search and the archived switch, the topic view with proposals, summary and open items editing, merge, split mode and archive.
- U6. Frames 5, 6 and 7, plus a new frame for split mode in its review.

**UI-6: Full view, phone pass and Keys.** Order 6. Depends on UI-5.
- `F`, the three-column view, the phone sheet and dock, the mobile suite and the Keys entries.
- Acceptance checks 1, 4 and 5. Frame 8 and every phone frame.

</details>
