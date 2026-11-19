# Intent: Chat Graph chat UI (design spec)

**Status:** Draft (revision 2, design spec for the owner's Spec review. Work item W-78. It designs ticket 6 of the Chat Graph spec, `intent/2026-11-18-chat-graph.md` on master at revision 5, filed as W-84.)

**Extends:** `intent/2026-11-18-chat-graph.md`. That spec is merged and stays unchanged. This spec adds the API pieces listed under "Additions to the Chat Graph API", which the screens need and the merged spec does not define. Approving this spec approves those additions.

**Prototypes:** the canvas frame `chat-graph-ui-study`, one row per screen or state, desktop (1280 px) on the left and phone (414 px) on the right. Every embed carries a screenshot thumbnail, so a phone shows a picture instead of a Paused card. The source is `docs/design/chat-graph-ui/` in this change. All content in it is made up.

**Revision 2** answers the owner's review notes of 2026-11-19. They are listed, each with what changed, under "Review notes, revision 1".

## Problem statement

The Chat Graph back end (W-76, tickets 1 to 5 and 7 to 9) can file messages to topics, but nothing shows it to Harry. Ticket 6 has no design to build against. The design doc's UX section on the canvas (`chat-graph-design-doc`) is a rough idea, and the merged spec says so. Without a design, the builder would have to decide where the chat lives, how a chip looks at each confidence, what Harry sees during the 5 second routing wait, how a thought is captured without leaving the conversation, and how every failure looks. Any of those choices could change something the owner sees.

## Vocabulary

The owner calls a topic a **thread**. Every word the UI shows says "thread". The API, the store, the merged spec and the code keep "topic", because those are merged names and renaming them is no help to anyone. So `GET /topics` feeds the thread list, and `topics-view.ts` draws it. A canvas comment thread stays a "comment" in the UI wherever the two could meet (U7).

## Outcomes

1. **One chat, and threads.** The chat is a rail view on every canvas workspace, opened with `T` or the dock's Chat button. Each thread opens in the same rail, with its summary and latest messages. On a phone the rail fills the screen.
2. **The outline lists threads, not sessions.** The canvas outline's Sessions section gives way to Threads: Unsorted when it holds anything, then Active, Inactive and Archived, each collapsible. Sessions keep one collapsed row at the end of the outline.
3. **A chip under every message** names its thread. Its look depends on the reranker's band: quiet above 0.8, amber from 0.5 to 0.8, and a "New" tag below 0.5. Unsorted and Filing have their own looks. The chip carries no extra words.
4. **A tap on a chip opens one short menu:** Move…, Also file in…, Open the thread, and, when an archived thread matched, Move to it with an "Archived" tag. On a phone the menu is a bottom sheet.
5. **A context line under each reply** names every thread the reply used. A thread used only through its card says "(card)".
6. **Related shows only after a reply finishes**, as one quiet row with "File there too" and "Dismiss".
7. **The routing wait shows and does not block.** The message shows at once with a Filing chip, the status line counts the seconds, and Harry can keep typing.
8. **Capture works from any chat field on the canvas.** Typing `>` at the start of a draft, or `Mod+U`, puts the field in capture mode, shown as a "Capture" pill. Captures can be several lines and can hold Markdown quotes. Backspace on an empty pill, or `Mod+U` again, leaves capture mode with the text kept.
9. **Thread view.** Summary and to-do list pinned at the top, the latest messages below them, a composer that writes straight to the thread. Suggestions (merge, split, a note from another thread) wait behind one badge with their count, and open into one bounded, scrollable section.
10. **Chat keeps working when the sidecar is down.** A send that cannot be filed copies the message, keeps it in the field, and offers the most recent threads. In a thread the message goes straight to that thread's conversation and is filed when the sidecar is back.
11. **Every other failure leaves Harry's text where it was** and says what happened in one line: a message landed in Unsorted, the import is still running, or nothing exists yet.
12. **The full view is undecided on purpose.** Five layouts are prototyped (8A to 8E), two of them with a command palette. Harry picks one in this review (decision 1). Its ticket is written after the pick.

## Affected users and systems

- Harry, on the canvas at a desktop and on an iPhone.
- `packages/canvas/src/` (a new rail view and its modules, the outline, `shortcuts.ts`, `mobile.ts`), `src/web/public/canvas.html` and a new `canvas-chat.css`.
- The canvas Assistant's composer, which gains capture mode (outcome 8).
- `src/web/routes/chat-graph-routes.ts`, `src/web/sse-events.ts` and `constants.js` for the additions below. The sidecar for the two new op kinds.

## Constraints

- **Canvas design language.** The tokens, type, spacing and controls come from `canvas.css` and `DESIGN.md`: system sans 14/1.45, 12 px supporting text, tabular monospace for times and counts, 4 px spacing steps, 4 px control and 6 px content corners, 32 px controls on a desktop and 44 px on a phone, 16 px fields on a phone. Amber means focus or "needs you", nothing else. The rail is never a modal and never a floating card (PRODUCT.md). A palette (8D, 8E) is a deliberate exception that PRODUCT.md does not yet allow, and it is listed as such under decision 1.
- **Short copy.** Labels are one to three words. A line of explanation is one sentence, at most about ten words. A menu item never wraps or overflows; a long thread name is cut with an ellipsis and the full name goes in `title`.
- **Thread in the UI, topic in the code** (see Vocabulary).
- **Rich text only from the agent.** Message text, thread titles, summaries, to-do items and suggestion text from the store go in through `textContent`. Claude's replies and a captured Markdown quote render through `renderMarkdown()` (`packages/canvas/src/markdown.ts`), as the assistant's do.
- **The merged spec's rules hold:** I2 (a chip per live membership), I3 (an archived topic is never a silent target), I8 (the context line lists exactly the sources), I9 (an agent never writes another topic), I10 (a capture gets no reply), the 503 `CHAT_GRAPH_UNAVAILABLE` answer and the multi-user refusal.
- **SSE never moves anything.** A `chat-graph:*` event never moves the camera, selection, focus or rail view, and scrolls a conversation only when it was already at its end (the assistant's rule).
- **Keys stay out of text fields**, except `Mod+U`, which acts in a chat field because toggling capture is what it is for. `T` and Shift+T act only on the board or a non-text control, never during IME composition, and a hardware key on a phone does nothing, as with `G` and `B`.
- **Single user.** In multi-user mode the dock button, the outline's Threads section and the rail view are absent, because the routes refuse.

## Invariants

These are the UI's own promises. Each names the test that pins it.

### U1: SentTextIsNeverLost

The composer keeps its draft until the server has answered 2xx. A 503, a network failure or a timeout leaves the draft in the field, writes it to the clipboard when the browser allows it, and shows one line saying what happened.

- *Test:* a browser test answers the POST with 503, then with a dropped connection. The draft is unchanged each time, the clipboard holds it, and the line names the cause.

### U2: EveryFiledMessageShowsItsThreads

Once `chat-graph:routed` arrives for a message, the message shows exactly one chip per live membership in that event, and no Filing chip. Before it arrives the message shows one Filing chip. A reassign, add or undo repaints the chips from the server's answer, never from a local guess.

- *Test:* fixtures for one, two and zero-then-Unsorted memberships. The chip count equals the live membership count after each event.

### U3: RelatedWaitsForTheReply

A Related row is drawn only from a `chat-graph:related` event, and only under a reply whose turn has ended. A related event for a turn still in progress is held until the reply's message arrives.

- *Test:* the event arrives before the reply. Nothing is drawn until the reply is drawn, and then the row appears under it.

### U4: ArchivedOnlyThroughItsOwnItem

The thread picker (Move…, Also file in…) lists active and inactive threads only. An archived thread can be reached from a chip only through the menu item that names it and carries the "Archived" tag, which unarchives it.

- *Test:* the picker's rows never include a topic whose status is `archived`. The archived item appears only when the routed event names an archived match.

### U5: CapturesShowNoReplyState

A message of kind `capture` never shows "Replying", a Related row or a context line.

- *Test:* a capture fixture with a stray `chat-graph:related` event for it. None of the three is drawn.

### U6: SuggestionsNeedAPress

A suggestion (a proposal in the API) is accepted or rejected only by the person's press on its button. Nothing in the view, and no `canvas_view` command, accepts one.

- *Test:* a static scan of the chat modules finds `/proposals/` writes only in the button handlers. A view command cannot reach them.

### U7: ThreadInCopyTopicInCode

No string the chat UI shows or announces contains "topic". Where the chat UI and canvas comments share a screen, comments are called comments.

- *Test:* a gate test reads every chat module's user-facing strings, as `test/tile-grid-i18n.test.ts` harvests strings, and refuses `/\btopic/i`.

### U8: CaptureModeIsVisibleAndReversible

The composer is in capture mode exactly when its pill shows. Leaving capture mode (Backspace on the pill with the caret at the start, or `Mod+U`) never changes the text. A message is sent as a capture only from capture mode, so a draft whose text starts with `>` after the pill (a Markdown quote) is captured as a quote.

- *Test:* a model test: `>` typed first enters the mode and is not kept in the text; `>>` enters the mode and keeps one `>`; Backspace on the pill leaves the mode with the text intact; the POST carries `capture: true` only in the mode.

## Non-goals

- A page outside the canvas, or a Chat entry in the classic dashboard.
- Replacing the canvas Assistant. It stays a separate rail view, as the merged spec's non-goals require. It only gains capture mode.
- A visual graph of threads.
- Voice input for the chat. The assistant's voice controls are not copied in this round.
- A digest of captures.
- Building the full view before Harry picks a layout.
- The split-point picker beyond what is described under Thread view. It gets its own frame in that ticket's review.

## Acceptance checks

1. Each screen and state below matches its prototype frame at 1280 px and at 414 px, both themes, checked by the builder with screenshots at device scale 1 and attached to the review.
2. `npm test -- test/chat-graph-ui*.test.ts` passes, with one or more cases per invariant marked `// Invariant U<N>: <Name>`.
3. `npm run test:browser -- test/chat-graph-ui.browser.test.ts` passes on fixtures, with no sidecar, for every state in the Design table.
4. `npm run test:mobile -- test/mobile/chat-graph-ui.test.ts` passes at the 414 px iPhone profile: 44 px targets, the chip menu as a sheet, the composer above the keyboard.
5. The merged spec's acceptance check 7, by hand on a throwaway instance: the chat, the chips, reassign, the thread list, the thread view with summary and to-dos, merge and undo, on a desktop and on the iPhone.
6. A grep of the chat modules and the canvas HTML finds no user-facing "topic".

## Design

### Where it lives

The chat is a **rail view**, `chat`, on every canvas workspace. There is one chat, not one per workspace. `T` toggles it, like `C` for the assistant, and the dock gains a Chat button beside the Assistant. **Shift+T** opens the thread list in the rail (on a desktop the outline already shows it). A thread opens in the same rail. **F** in the rail opens the full view on whatever the rail shows; F or Escape returns. On a phone the rail fills the viewport with a visible Close, as the assistant does, and there is no full view.

The rail is 400 px wide by default when the chat opens, because chips and the context line need the room. The person can still resize it (`panel-widths.ts`).

### Screens and states

Frame ids are canvas object ids inside `chat-graph-ui-study`. The "Reads" column names routes under `/api/chat-graph` and SSE events from the merged spec. Names in *italics* are additions defined below.

| # | Screen or state | Desktop frame | Phone frame | Reads | Writes |
| --- | --- | --- | --- | --- | --- |
| 1 | Chat: chips by band, context line, Related | `132e05d8` | `b14e1324` | *`GET /messages`*, `GET /topics`, `chat-graph:routed`, *`chat-graph:message`*, `chat-graph:related` | `POST /messages` |
| 2 | Chip menu: move, also file, open, archived match | `7fa53207` | `72ec1a0b` | `GET /topics` (picker) | `POST /messages/:id/reassign` (*mode*), `POST /ops` (reactivate) |
| 3 | Routing wait, about 5 s | `116fbe06` | `fa2be192` | `chat-graph:routed` | `POST /messages` |
| 4 | Capture: pill, several lines, a quote | `fabf1749` | `eee6fe51` | `chat-graph:routed` | `POST /messages` (*capture*) |
| 5 | Thread list: Active, Inactive, Archived | `b49b6724` | `68eeed85` | `GET /topics` | none |
| 6 | Thread list, Archived open | `22d5c190` | `12e7e06d` | `GET /topics` | `POST /ops` (reactivate) |
| 7 | Thread view: summary, to do, latest messages | `b328f7e6` | `9e02d9a0` | `GET /topics/:id`, `GET /proposals` (count), *`GET /topics/:id/summaries`* | `POST /ops` (merge, split, archive, *edit-summary*, *edit-open-items*), `POST /ops/:id/undo`, `POST /messages` (*topicId*) |
| 8A | Full view: three columns | `779c369b` | none (desktop only) | as 1, 5 and 7 | as 1, 5 and 7 |
| 8B | Full view: tabs and a capture line | `1c7410b6` | none | as 8A | as 8A |
| 8C | Full view: Chat and a thread side by side | `f4ff5d48` | none | as 8A | as 8A |
| 8D | Full view of threads; Chat in a `Mod+K` palette | `aa3724ac` | none | as 8A | as 8A |
| 8E | Capture palette, `Mod+U`, over the board | `18f1e9ad` | none | `chat-graph:routed` | `POST /messages` (*capture*) |
| 9 | State: routed to Unsorted | `ebf1ef73` | `f2511cac` | `chat-graph:routed` | `POST /messages/:id/reassign` |
| 10 | State: sidecar down, in Chat | `71d84c20` | `ab493379` | any route answering 503 `CHAT_GRAPH_UNAVAILABLE`, the cached thread list | none |
| 11 | State: empty first run | `3bb81c1e` | `f34d1eff` | *`GET /messages`*, `GET /topics` (both empty) | `POST /messages` |
| 12 | State: bootstrap in progress | `7d1bc060` | `53da547a` | *`GET /status`* | `POST /messages` |
| 13 | Outline: threads by activity | `585c2f8f` | none (the phone has no outline; frame 5 is its list) | `GET /topics`, `chat-graph:routed` | none |
| 14 | Thread view, suggestions open | `b24fcf42` | `0c52e05d` | `GET /proposals` | `POST /proposals/:id/{accept,reject}` |
| 15 | State: sidecar down, in a thread | `eecdfef0` | `2e4821a6` | the cached thread | *`POST /topics/:id/direct`* |

Full object ids, in table order: `132e05d8-6aa4-4f9e-9791-33ee5be40a3c`, `b14e1324-6c1c-4c83-8992-e4dfed5d315b`, `7fa53207-abd7-47c0-8f08-3234eaa5e6f8`, `72ec1a0b-86dc-4e98-b12d-92098257778f`, `116fbe06-f6e6-4e37-a4d7-87b4b22beab8`, `fa2be192-d8a3-499f-a027-d6eaf31c6ee5`, `fabf1749-ba41-420c-845e-31700559e571`, `eee6fe51-b2a3-4ce7-a601-ed8b63da883b`, `b49b6724-562a-443d-a0f1-b9b1769eb952`, `68eeed85-80bf-4de6-8dd1-00c2127e92a9`, `22d5c190-f9cf-47ce-8bbc-a5c8ecfef4c1`, `12e7e06d-ad9a-41b0-9d10-a370a7ee3674`, `b328f7e6-be1c-4fe1-b783-c5abdb4c1a31`, `9e02d9a0-fe30-40c0-bcae-78b92bfdf8b7`, `779c369b-1b0e-4e77-8ea8-441ac736e2d3`, `1c7410b6-2934-44ec-8307-0e03485c0620`, `f4ff5d48-714d-45c8-9932-0be494d6b33a`, `aa3724ac-9770-4a68-be1d-681706b1ae78`, `18f1e9ad-ace4-4201-ab05-8f12751b0f14`, `ebf1ef73-3114-49af-82f7-fd6fd9a48fa5`, `f2511cac-bad1-431c-8be2-c2fa040e7d16`, `71d84c20-f26b-4327-bf17-f8c3efcadbce`, `ab493379-8f94-4b80-9b5e-9b06a0424918`, `3bb81c1e-a987-424a-b368-aa06b8c43489`, `f34d1eff-30eb-442d-bab5-92c8291226e2`, `7d1bc060-b812-4807-a974-ff0ac6009dcc`, `53da547a-b1d6-4e84-bb63-7c3a05595079`, `585c2f8f-0b23-4219-b4b6-60120440483d`, `b24fcf42-8585-4e7b-83eb-7ef81a7cf04f`, `0c52e05d-d492-4e70-a6cc-512383b59014`, `eecdfef0-e0c3-4af8-89b5-3188122cebf4`, `2e4821a6-f51f-458f-a233-e5e40374a42b`. Prototype ids are `cg-ui-<state>` and `cg-ui-<state>-phone`; the full-view explorations are `cg-ui-full` (8A) and `cg-ui-full-b` to `cg-ui-full-e`.

### The chat (frame 1)

- Turns follow the assistant's quiet style: a small `You` or `Claude` label with the time at the right, no bubbles, a 2 px divider rule beside the person's text. The chat opens at its end.
- **Chips** sit under the person's message, 24 px tall with a 32 px hit area (32 px tall with a 44 px hit area on a phone), 12 px text. A chevron on the chip says it opens a menu.

  | Band (reranker score) | Look | Copy |
  | --- | --- | --- |
  | above 0.8 | No border, muted text. A border appears on hover. | `Kitchen budget` |
  | 0.5 to 0.8 | 1 px amber border, a faint amber fill, an amber chevron | `Conference talk ⌄` |
  | below 0.5 (new thread) | Raised fill, secondary border, a small "New" tag | `New │ Garden shed ⌄` |
  | Unsorted | Dashed amber border | `Unsorted ⌄` |
  | Filing | Dashed muted border, three pulsing dots (static under reduced motion), not pressable | `Filing ···` |

  The amber band asks to be checked, which is what amber already means on the canvas. The design doc's risk table asks for low-confidence chips to look different, not only for high-confidence ones to be quiet.
- **Context line** under each reply: `Used Kitchen budget · Laptop upgrade (card)`, 12 px. Each name opens that thread. It lists exactly the reply's source ids (I8).
- **Related** is one row in a 1 px bordered box under a finished reply: "Related: **Laptop upgrade**", with **File there too** (adds a membership with mode `add`) and **Dismiss** (drops it for this message; nothing is written). The card's one-line reason is the row's `title`.
- While a reply is in progress the status line says "Replying", from the thread conversation's session state, as the assistant's state line does.

### Chip menu (frame 2)

A popover under the chip on a desktop (248 px, one 1 px border, the canvas menu style), a bottom sheet with a scrim on a phone (48 px rows). Each item is one line. The first line says what happened in one sentence: "New thread. Also matched **Shed plans**, archived."

- **Move…** opens a picker in place: a search field over the active and inactive threads, most recent first, and "New thread…" at the end. It sends `reassign` with mode `move`.
- **Also file in…** opens the same picker and sends mode `add`. The message then shows two chips.
- **Open Garden shed** opens the thread.
- **Move to Shed plans** with an "Archived" tag, shown only when the routed event named an archived match (I3). Its `title` says it unarchives the thread. It runs the reactivate op, then a move.

Every change shows the canvas's quiet undo notice at the bottom of the rail ("Moved 1 message. Undo"). Undo calls `POST /ops/:id/undo` with the op the change created. A routing op cannot be undone (I2), so the notice is offered only for a person's own change.

### Routing wait (frame 3)

The message appears the moment the POST answers, with a Filing chip. The status line says "Filing · 3 s", counting whole seconds. The composer stays enabled and says "Keep typing. Each message files on its own." Each message is posted when sent, not held behind the previous one. After 12 s the line adds "Can take up to 20 s." At the sidecar's 20 s deadline the event files it to Unsorted (frame 9). The owner will try the 5 s wait in use; the timings are the merged spec's, so changing them is a change to that spec, not to this one.

### Capture (frames 4 and 8E)

- **Entering capture mode.** In any chat field on the canvas (the chat, a thread's composer, the Assistant's composer, the palette in 8D and 8E): typing `>` as the first character, or pressing `Mod+U` (⌘U on a Mac, Ctrl+U elsewhere). The `>` is not kept in the text; it becomes a **Capture** pill at the start of the field, the field's border strengthens, and Send becomes **Capture**. The status line says "No reply. ⌘U or Backspace to leave capture."
- **Several lines.** Shift+Enter adds a line, as in every canvas composer. The whole draft is one capture.
- **Quotes.** After the pill the text is taken as written, so `>>` at the start captures a Markdown quote (`> …`), and a quote on any later line stays a quote. The captured message renders through `renderMarkdown()`, so the quote shows as one.
- **Leaving.** Backspace with the caret at the start of the field, or `Mod+U` again, removes the pill and keeps the text. To send an ordinary message that starts with a quote, leave capture mode first; the field then holds the `>` as text and sends it as a message (U8, addition 6).
- **Outside a field.** `Mod+U` on the board opens capture where capture lives in the chosen full-view layout: the rail's composer in capture mode (8A to 8C) or the capture palette (8D, 8E). The person's focus returns where it was after Capture or Escape.
- **Sent.** The message shows a small `Capture` tag next to `You`, its chip (from `chat-graph:routed`) and one line, "Captured to Errands". In a thread view, to-do items that came from captures carry a `capture` tag.

### Outline (frame 13)

The canvas outline (desktop only) shows threads instead of sessions:

- **Search** stays at the top, as today.
- **Threads**, with a + for a new thread. Under it, **Unsorted** with its count and a dashed amber border, only while it holds messages. Then three collapsible groups, each with its count:
  - **Active:** a message in the last 7 days, newest first, each with its age (`2m`, `1d`).
  - **Inactive:** no message for 7 days. Nothing changes about the thread; it is only grouped lower.
  - **Archived:** archived by a person or by a merge. Muted text. Opening one shows it read-only with Unarchive in its actions.
- **Objects**, as today.
- **Sessions**, one collapsed group at the end, for the agent sessions that still back each conversation.

Active and Archived open by default, Inactive and Sessions closed; the outline remembers each group's state per device. Clicking a thread opens it in the rail. The thread open in the rail is highlighted.

### Thread list (frames 5, 6)

On a phone, and from Shift+T or the rail's list icon on a desktop: back to Chat, a search field ("Find a thread", filters titles and summaries in the browser), Unsorted pinned at the top while it holds anything, then the same three collapsible groups as the outline. Rows show the title, the age, a two-line summary preview and "2 to do · 38 messages". The open Archived group ends with "Archived threads take no new messages by themselves. Open one to unarchive it."

### Thread view (frames 7, 14)

Opening a thread shows what it is about and where it got to:

- **Head:** back to Threads, the title, the suggestions badge, a … menu (Merge, Split, Archive), full view and close.
- **Pinned at the top**, outside the scroll: the **summary**, cut to three lines (the whole text in the full view or by pressing it), with "Summary v6 · 10:02 · Edit · History". Editing saves a new version through `edit-summary`. Under it, **To do** with its count and the hint "Tasks and captures still open in this thread", collapsible. To-dos are what the merged spec calls open items: tasks and questions Claude keeps when it folds old messages into the summary, plus captures not yet dealt with. Checking, adding or rewording one goes through `edit-open-items`.
- **Latest messages** fill the rest and open at the end. "Earlier messages 33" at the top loads more.
- **Suggestions** (merge, split, a note from another thread) never sit in the view. The head shows one badge with their count, in amber because they need a decision. Pressing it opens one section under the head, "Suggestions 3", with the cards in a scroll area at most 232 px tall (40% of the screen on a phone), and a chevron to close it. Each card is a kind line and one sentence with two buttons: Review / Not now, or Add / Reject. Review opens the op with its effect listed before Confirm (U6). With no suggestions the badge is absent.
- **Split** (built in its ticket): Split opens a mode where each gap between messages has a "Split here" control. The first press marks the start and the second the end of a run, and a bar at the bottom names the new thread and Confirm. The repair pass's suggested split point is preselected.
- **Composer:** "Message Kitchen budget". A message written here names this thread as its explicit signal, so it attaches at once with no model call and no wait. `Mod+U` captures into this thread.

### Full view explorations (frames 8A to 8E)

The goal, in the owner's words: focus on one chat or thread, keep every chat and thread within reach, and capture something that does not belong in the focused conversation without moving focus. `F` opens the full view on what the rail shows: the chat, or the open thread. Each layout is desktop only.

- **8A Three columns.** Threads on the left with Chat pinned first (`Mod+0`), the focused conversation in the middle (680 px of text), Details on the right (summary, to do, suggestions). Capture is `Mod+U` in the composer.
- **8B Tabs.** Chat and each opened thread as tabs, the conversation full width, Threads and Details as buttons that open drawers. `Mod+U` opens a one-line capture bar under the tabs, so the conversation does not move.
- **8C Side by side.** Chat on the left is where Harry thinks aloud; the focused thread on the right, with a Switch menu. Capture is the left composer in capture mode.
- **8D Threads plus a chat palette.** The full view is threads only (list, thread, details). The main chat lives in a palette over anything: `Mod+K` opens it on Chat with the last few turns and the composer, `Mod+U` opens it on Capture, `Mod+P` on Commands (the canvas's other commands). `Mod+Enter` sends and opens the thread the message was filed to.
- **8E Capture palette.** The same palette on its Capture tab, opened with `Mod+U` over the board while a thread is open in the rail: the pill, several lines, "No reply. Filed to a thread on its own. Your focus stays where it was.", and the recent captures with their chips.

8D and 8E are one idea, the palette, shown in its two main modes. They can combine with any of 8A to 8C, because the palette replaces only where the main chat lives.

### States (frames 9 to 12, 15)

- **Unsorted.** The chip is "Unsorted ⌄", and a line under it says "Not filed in time. Pick a thread to get a reply." The chip opens the move picker. Picking one moves the message and, as an explicit signal, starts the reply.
- **Sidecar down, in Chat (frame 10).** Chat is not blocked. A send that gets 503 keeps the draft, copies it to the clipboard, and shows a panel above the composer: "**Chat can't file messages right now.** Your message is copied. Send it in a thread:" with the three most recent threads and "All threads". The send button becomes Retry. The thread list comes from the browser's last good `GET /topics`. If the clipboard write is refused, the line says "Copy your message" with a Copy button instead.
- **Sidecar down, in a thread (frame 15).** Picking a thread opens it with the draft already in its composer and the line "Pasted from Chat." A strip under the head says "Chat is down. Messages here go straight to this thread and are filed when it is back." The summary is the cached copy, marked "Saved copy from 10:02". Sending uses addition 7, so the reply comes from the thread's own conversation. Suggestions and edits are hidden while the sidecar is down.
- **Empty first run.** "One chat for everything", then two lines: what filing does, and how `>` and `Mod+U` capture. The composer is ready.
- **Bootstrap.** A strip under the head: "Filing your last 7 days of conversations · 46 of 120 filed" with a 2 px bar. The chat works meanwhile, and a line says "New messages are filed first." The strip goes when the import ends, with no toast.

### Copy rules

"Thread" in every visible word, "topic" in none (U7). Labels of one to three words. Explanations of one sentence, about ten words. No exclamation marks. Errors name the problem and what is kept. Buttons name their action ("File there too", "Add", "Review").

## Additions to the Chat Graph API

The merged spec's routes cannot draw the chat timeline, announce a reply, edit a summary, report the import's progress, tell a capture from a quote, or reach a thread while the sidecar is down. These additions are additive (rule 5) and single-user. All but 7 refuse with 503 like the rest.

1. **`GET /api/chat-graph/messages?before=<id>&limit=<n>`** (default 50, max 200). Recent messages across all topics, oldest first, each with its kind, author, live memberships (topic id, title, status, band) and, for an agent message, its source topic ids. It feeds the chat's history and its first paint.
2. **SSE `chat-graph:message`.** Sent when an agent message is stored (ticket 5's reply capture), with the message id, its topic id and its source ids. The browser then reads the text with `GET /messages`. This keeps chat text out of the event, which the merged spec's privacy constraint prefers.
3. **Two op kinds, `edit-summary` and `edit-open-items`,** through `POST /ops`, each storing a new summary version (the merged spec already versions summaries), and **`GET /topics/:id/summaries`** to list versions. As ops they are idempotent and undoable (I5).
4. **`GET /api/chat-graph/status`** answering `{ state: 'ready' | 'bootstrapping', done, total }`. The browser reads it on open and every 5 s while `bootstrapping`.
5. **Named fields.** `POST /messages/:id/reassign` takes `{ topicId, mode: 'move' | 'add' }`. `POST /messages` takes an optional `topicId`, the explicit signal from a thread's composer or a picked Unsorted thread. `chat-graph:routed` carries, per membership, its band and, when one matched, the archived topic's id and title.
6. **`capture: boolean` on `POST /messages`.** When present it decides the kind, and the text is stored as sent. When absent the merged spec's leading-`>` rule applies, so older clients keep working. This is what lets a message start with a Markdown quote.
7. **`POST /api/chat-graph/topics/:id/direct`**, the one route that works while the sidecar is down. The TypeScript side keeps `dataPath('chat-graph', 'conversations.json')`, a map from topic id to its title and current conversation, updated on every `chat-graph:routed` and every new conversation. `direct` sends the message to that conversation through the canvas conversation route, and appends `{ topicId, text, at }` to an outbox file. When the sidecar answers again, Codeman posts each outbox entry to `POST /messages` with that `topicId` (an explicit signal, so no model call) and clears it. If the topic has no recorded conversation, `direct` answers 409 `CHAT_GRAPH_NO_CONVERSATION` and the UI says "This thread can't take messages until Chat is back."

## Technical design

- **Modules** in `packages/canvas/src/`, following Work's split (pure model, one DOM module):
  - `chat-model.ts` (pure): band from score, chip list from memberships, picker filtering (U4), when a Related row may show (U3), capture-mode transitions (U8), Active/Inactive grouping, the status-line text.
  - `chat-view.ts`: the only DOM for the chat, the chip menu and the composer, including capture mode, which the Assistant's composer reuses.
  - `topics-view.ts`: the only DOM for the thread list, the thread view and the suggestions section.
  - `outline-threads.ts`: the outline's Threads section; the outline module calls it in place of Sessions.
  - `chat-client.ts`: the routes, the event handlers, the cached thread list and the down-mode flow.
- **Rail and keys:** a new rail view `chat`, with sub-views `list` and `topic`. `T`, Shift+T and `Mod+U` in `shortcuts.ts`, listed in Keys. `Mod+K` and `Mod+P` only if 8D or 8E is chosen. `F` inside the rail opens the chosen full view.
- **Browser keys:** `Ctrl+U` (view source in Chrome on Linux and Windows) and `Ctrl+P`/`⌘P` (print) can be taken with `preventDefault()` on a keydown in the page. The builder checks each on Chrome, Firefox and Safari; where a browser keeps the key, Keys shows the fallback `Mod+Shift+U`.
- **Styles:** `canvas-chat.css`, linked after `canvas-work.css`, on the canvas tokens only.
- **Phone:** the rail at full viewport, the chip menu as a sheet, a Chat icon in the phone dock, hardware keys ignored.
- **Telemetry:** `uiEvent('chat', <action>)` for send, capture, chip-move, chip-add, unarchive-move, open-thread, suggestion-accept, suggestion-reject and direct-send, with ids only, never text.
- **Risks:**
  - *The rail is narrow for the thread view.* The pinned summary is cut to three lines and To do can collapse, so the latest messages keep most of the height.
  - *Two chips per message can crowd a phone.* Chips wrap. A message with three or more memberships shows two and "+1".
  - *Polling status every 5 s during bootstrap* is the only polling. It stops when the state is `ready`.
  - *Down mode can send a message the graph never sees* if the outbox is lost. The outbox is written before the conversation send, through the same atomic write as the canvas's other side files.

## Decisions for Harry

Decisions 1 to 3 are new in revision 2 and need an answer. The rest are assumptions this spec makes; each is easy to change.

1. **Which full view (8A to 8E)?** My recommendation: **8A with the 8D palette.** 8A keeps every thread and the details in view, which suits long work in one thread; the palette gives the main chat and capture a home that is one key away from anywhere on the canvas, which is what makes capture cost no focus. It needs PRODUCT.md to allow a palette, since it is a floating surface; the palette never holds state the rail does not also show. If you prefer no palette, 8A alone, with `Mod+U` toggling capture in whichever composer has focus.
2. **What "inactive" means.** No message for 7 days. Alternatives: 3 days, or 14.
3. **Sessions in the outline.** One collapsed group at the end. Alternative: drop them from the outline entirely; they stay reachable from the dashboard and from session objects on the board.
4. **Where the chat lives: a canvas rail view on every workspace,** not its own page and not in the classic dashboard.
5. **Chat sits beside the Assistant, not in place of it.** The merged spec keeps canvas conversations as they are. The Assistant only gains capture mode.
6. **Typing in a thread view files to that thread at once**, as an explicit signal, so there is no 5 s wait there.
7. **The uncertain chip (0.5 to 0.8) is amber.** Alternative: a neutral border, keeping amber for Unsorted only.
8. **Related's "File there too" adds a membership.** Alternative: a link with no membership.
9. **During the bootstrap import, new messages are filed first**, ahead of the backlog.
10. **Keys: `T` opens the chat, Shift+T the thread list, `Mod+U` captures.**

## Review notes, revision 1

The owner's notes on the prototypes, 2026-11-19, and what changed:

1. *Chip menu: "Text overflows button. Label seems very long too."* and *"labels and copy are verbose. make more concise."* The menu items are now Move…, Also file in…, Open Garden shed, and Move to Shed plans with an "Archived" tag; items never wrap and cut long names with an ellipsis. Copy across every frame is shorter, and the Copy rules section now sets the length (frame 2).
2. *Outline: "Sessions don't mean anything to me anymore … show threads with active threads on top, inactive below and archived at the bottom, potentially all collapsible."* The outline now lists threads in collapsible Active, Inactive and Archived groups, with Sessions as one collapsed group at the end (outcome 2, frame 13, and every desktop frame). Decisions 2 and 3.
3. *Routing wait: "happy to try it out."* No change. The timings stay the merged spec's.
4. *Capture: "How do I capture markdown text with a block-quote? Maybe `>> this is a quote`? Does capture handle multi-line text?"* Yes to both. `>` becomes a mode pill rather than part of the text, so `>>` captures a quote and any line can be a quote; captures can be several lines; `Mod+U` toggles the mode (frame 4, U8, addition 6).
5. *Thread list: "we're calling these Threads not Topics."* Every visible word now says thread; the code keeps topic (Vocabulary, U7).
6. *Thread view: suggestion cards into one expandable row with a count, bounded and scrollable, collapsed as a small icon; "When I open a Thread I want to see a summary and the latest messages."* Suggestions are a badge with a count in the head that opens one bounded, scrollable, collapsible section; the summary is pinned at the top and the latest messages fill the rest (frames 7 and 14).
7. *"What are open items?"* They are renamed **To do** and carry the one-line hint "Tasks and captures still open in this thread"; the Thread view section says where they come from.
8. *Full view: "How do I navigate to this view? … I want to see 5 different layout explorations … at least one and no more than 2 should explore [the cmd+k palette]."* `F` opens it on what the rail shows. Five layouts, 8A to 8E, two of them (8D, 8E) the palette. Capture works from any chat field with `Mod+U`. Decision 1.
9. *Sidecar down: "I don't want chat to be blocked … prompt the user to go to threads and select a thread … automatically copy their unsent message to clipboard."* Done: the message is copied and kept, three recent threads are offered, and a picked thread opens with the draft pasted and sends straight to its conversation (frames 10 and 15, addition 7, U1).
10. *Bootstrap: "'46 of 120' what?"* Now "46 of 120 filed", after "Filing your last 7 days of conversations" (frame 12).

## Checks run

- Every frame was loaded headless at 1280 x 800 and 414 x 860, dark theme, device scale 1, with no console or page errors. `canvas_prototype check` was run on 8D (`cg-ui-full-d`) inside the canvas sandbox, with no errors.
- A script read every state's visible text, `aria-label`, `title` and placeholder at both widths. None contains "topic".
- The routes and events in the table were checked against `intent/2026-11-18-chat-graph.md` revision 5 on master. Everything not in that file is listed under Additions.

<details><summary>Tickets for the UI build (7), replacing W-84's single ticket</summary>

**UI-1: API additions.** Order 1. Depends on Chat Graph tickets 4, 5 and 7.
- Additions 1 to 7, including the conversation map and the outbox for `direct`.
- Route tests with `app.inject()`, the SSE registry parity test, and an outbox replay test with the sidecar stubbed down then up.

**UI-2: Chat rail view and capture mode.** Order 2. Depends on UI-1.
- The rail view, `T`, the dock button, the chat, the composer with capture mode (also in the Assistant's composer), `Mod+U`, chips in every band, the routing wait, Unsorted, sidecar down in Chat, empty, and the bootstrap strip.
- U1, U2, U5, U7 and U8. Frames 1, 3, 4, 9, 10, 11 and 12.

**UI-3: Chip menu and undo.** Order 3. Depends on UI-2 and Chat Graph ticket 7.
- The menu, the picker, move, also file, the archived-match item and the undo notice.
- U4. Frame 2.

**UI-4: Context line and Related.** Order 4. Depends on UI-2 and Chat Graph ticket 8.
- The context line from source ids, the Related row and its two actions.
- U3. Frame 1.

**UI-5: Thread list, thread view and down mode.** Order 5. Depends on UI-3 and Chat Graph tickets 7 and 8.
- The list with search and its three groups; the thread view with the pinned summary, To do, latest messages, the suggestions badge and section, merge, split mode and archive; sidecar down in a thread.
- U6. Frames 5, 6, 7, 14 and 15, plus a new frame for split mode in its review.

**UI-6: Outline threads.** Order 6. Depends on UI-5.
- The outline's Threads section in place of Sessions, its groups and remembered open state, Sessions as the last group.
- Frame 13 and every desktop frame's outline.

**UI-7: Full view, phone pass and Keys.** Order 7. Depends on UI-5 and on decision 1.
- The layout Harry picks from 8A to 8E (and the palette if chosen), the phone sheet and dock, the mobile suite and the Keys entries.
- Acceptance checks 1, 4 and 5. Every phone frame.

</details>
