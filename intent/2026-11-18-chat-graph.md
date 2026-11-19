# Intent: Chat Graph (spec)

**Status:** Draft (revision 5, spec for the owner's Spec review. Revision 2 resolved the eight findings of the consistency audit, listed under Checks run. Revision 3 records the owner's answers to the three decisions, given on 2026-11-18, and names the UI design spec's Work item, W-78. Revision 4 answered the review note "Can we use Dropbox Witchcraft?" with measurements on this host. Revision 5 records the owner's answer to Decision 4, given on 2026-11-19: not now. Ticket 10 is dropped, and the retrieval seam stays. The design is canvas text object `chat-graph-design-doc`, revised 2026-11-18.)

## Problem statement

Harry works on several things at once, and each conversation with an agent is a separate session he picks by hand. Four chores fall on him every day:

1. Finding the conversation about a specific issue.
2. Knowing whether a conversation on a topic already exists.
3. Deciding whether to restart a topic whose conversation went stale and is no longer cached.
4. Capturing a thought before it is lost, without leaving the work in front of him.

Codeman has no way to do any of these for him. A canvas conversation is one session, and its text lives only in that session's transcript.

## Outcomes

1. Harry types into one chat box. Each message is filed to a **topic** without him choosing one, and a chip under the message names the topic.
2. Tapping the chip moves a misfiled message to another topic, adds it to a second topic, or opens the topic. One tap fixes it.
3. Asking "do I have anything on X?" answers with the matching topics, or says there are none.
4. Coming back to a topic after days costs no decision. If its session's prompt cache is still live, the message goes to that session. If not, a fresh session starts from the topic's summary, open items and recent messages.
5. A message that starts with `>` is a **capture**. It is filed and acknowledged ("Filed to Budget") and gets no agent reply. Unprocessed captures show as open items in their topic.
6. Topics can be merged, split and archived, and every one of those is undoable. History is never lost.
7. An agent in one topic can read other topics, and cites the topic each fact came from. It cannot write to another topic. It can only propose a note there, which Harry accepts or rejects.
8. After a reply finishes, Codeman may suggest "Related: X". Harry accepts or dismisses it with one tap.

## Constraints

- **Core in Go.** The owner decided on 2026-11-18 that the core is a Go sidecar that Codeman starts and stops. The sidecar owns the store, the index, scoring, the confidence bands and the lifecycle ops. Codeman's TypeScript owns the routes, the UI, sessions and every model call.
- **Rule 10.** The only path to Claude is the Claude Code CLI. A local model that runs on this host is not a Claude request, so rule 10 does not forbid one. Decision 4 keeps it out of this spec anyway. The sidecar never calls Claude and opens no outbound network connection. Codeman runs `claude -p` through the existing helper (`src/ai-checker-base.ts`, as `src/readmymind-predictor.ts` does) and passes the results to the sidecar.
- **Rule 6, live colour only.** Only the live colour starts the sidecar, sweeps orphans or writes the store. Codeman checks `deployRole.allows('persist')` at each of those moments and before every `claude -p` spawn, because the helper creates a pane. Work that runs without a human message (summary folds, the bootstrap replay and the repair pass) also needs `deployRole.allows('automate')`. A colour may always stop its own child, matched by pid and process start time, whatever its role. A candidate or retired colour never opens the store for writing.
- **Rule 5.** Every store schema change is additive and carries a version row. The previous release must still read the store.
- **The 8 GiB host.** No embedding model, local or hosted (Decision 4). The sidecar's resident memory stays under 64 MB with 1,000 topics and 100,000 messages. The repair pass runs at most once an hour. Codeman, not the sidecar, triggers it, and only while the deploy role allows `automate`.
- **Instance isolation.** Codeman passes the sidecar its directory, `dataPath('chat-graph')`. The sidecar never derives a path. Every tmux call Chat Graph makes, including the `claude -p` helper's `tmux new-session` (today a bare call on tmux's default socket, `src/ai-checker-base.ts:415`), runs on the socket from `resolveTmuxSocketName()`. Ticket 4 fixes the helper.
- **Chat text is private.** The store and the socket are mode 0600. Chat text never reaches `GET /api/search`, logs or SSE payloads beyond the chat's own events. This is a deliberate change from the canvas conversation rule that no message text is stored: Chat Graph needs that text to search, summarise and rebuild context.
- **Naming.** "Thread" already means an object's comment thread on the canvas. The code and the UI say **topic**.
- **`canvas_capabilities` is at its 60 KB cap.** Agent tools for topics are new tools in `src/mcp-server.ts` with their own listings, not entries in that document.
- **Public repository (rule 8).** No hostnames, ports, paths or personal examples in committed files.

## Invariants

## I1: MembershipIsAppendOnly

A membership row is never deleted and never changed, except that `removed_at` is set once. Merge, split, move and archive add rows or set `removed_at`. Undoing an op restores exactly the live memberships that held before it.

- *Why:* the design's load-bearing decision is that membership is an edge, so every op stays reversible.
- *Test:* a property test applies random sequences of attach, move, merge, split and undo. After each undo, the live membership set equals the set before the undone op. No row count ever decreases.

## I2: EveryMessageLandsVisibly

Once routing finishes, every stored user message has at least one live membership, and the chat shows one chip per live membership. A message is stored before its routing call starts. If the scores do not arrive within the sidecar's 20 s deadline, or the `claude -p` call fails, the sidecar files the message to the topic **Unsorted** and the chip says so. A routing op cannot be undone. Reassign is how a person fixes it. When the sidecar is down, the POST answers 503 and stores nothing, so the person's text stays in the chat box.

- *Why:* outcome 1. A message with no topic is lost to search and to every rebuild.
- *Test:* the route test injects a failing `claude -p` call, then a score post that never arrives. The message lands in Unsorted with a chip each time. `POST /ops/<routing op>/undo` answers 409. With the sidecar stopped, the POST answers 503 and the store gains no row.

## I3: ArchivedNeverAttachedSilently

Neither `Decide` nor an explicit signal (a reply, a quote, a chip tap) ever attaches a message to an archived topic. When an archived topic is the only candidate that scores 0.5 or more, or an explicit signal names one, the message goes to a new topic, and its chip offers to reactivate the archived one.

- *Why:* outcome 6 and user story 15. An archived topic must stop attracting messages without disappearing.
- *Test:* a property test over random candidate lists checks that `Decide` never returns an archived id in `Attach`. A second test replies to, and quotes, a message in an archived topic, and checks that the message lands in a new topic with a reactivate chip.

## I4: BandsUseRerankScoresOnly

The routing decision depends only on the reranker's 0 to 1 scores and the topics' statuses. Activation and retrieval (BM25 in v1) decide which topics become candidates, and nothing more.

- *Why:* activation is a log-scale number, unbounded below. Mixing it into the 0.5 and 0.8 bands made the original thresholds meaningless.
- *Test:* the same scores and statuses with different activations and retrieval values give the same decision.

## I5: OpsAreIdempotent

Every op carries an `opId`. Applying the same `opId` twice changes nothing the second time. This includes routing a message, which uses the message id. A crash at any point leaves a store that the next start of the sidecar accepts.

- *Why:* the sidecar can be stopped mid-write by a deploy, and Codeman retries on a timeout.
- *Test:* every op is applied twice, and the store is byte-identical after the second. A crash test kills the sidecar between the op row and its membership rows, restarts it, and checks that the op is either whole or absent.

## I6: OnlyTheLiveColourRunsTheSidecar

A Codeman whose deploy role does not allow `persist` never starts the sidecar, never sweeps orphans and never forwards a write. When its role changes away from live, it stops its own sidecar, matched by pid and start time, before it answers the role change. A colour promoted to live starts the sidecar after it holds the deploy lease (`src/deploy-lease.ts`).

- *Why:* rule 6, and one SQLite file must have one writer.
- *Test:* with the role stubbed to candidate, the supervisor starts nothing and a chat POST answers 503. Switching the role to retired stops a running sidecar. A child started by another colour, with the same owner marker but a different pid, is never signalled.

## I7: PreviousReleaseReadsTheStore

After any migration, the release before it still reads and writes the store. Its sidecar opens a store with a newer schema version without refusing it or migrating it down. After the roll forward, the new release reads the rows the old one wrote.

- *Why:* rule 5. A rollback restores code only.
- *Test:* a gate test runs a frozen copy of the previous release's writes and reads against a store migrated to the new version, then the new release's reads over the result.

## I8: CrossTopicContentIsCited

Every piece of context taken from a topic other than the target carries that topic's id. The context line under the reply names every topic used. An agent tool that reads another topic returns the source id with every value.

- *Why:* outcome 7. Without it, facts move between topics and Harry cannot tell where a claim came from.
- *Test:* context assembly with related topics returns chunks that each have a source id, and the context line lists exactly the set of source ids.

## I9: AgentsWriteOnlyTheirOwnTopic

An agent's write to a topic other than its own creates a pending proposal. No message, summary or membership changes in that topic until a person accepts it. An explicit reply to, or quote of, a message in another live topic is the one exception. It adds a membership as a hard edge, and undo removes it. An archived topic follows I3.

- *Why:* outcome 7 and the doc's resolved open question.
- *Test:* `propose_note` against another topic leaves that topic's messages and summary byte-identical until a person's accept.

## I10: CapturesGetNoReply

A capture is never written to an agent session. Its only response is the acknowledgement.

- *Why:* outcome 5. A capture must not start a turn or spend tokens.
- *Test:* a `>` message is stored with kind `capture`, and the session layer's write is never called.

## Non-goals

- Several users, shared topics, or multi-user mode. The routes refuse when multi-user mode is on.
- Merge or split with no confirmation.
- Embeddings, including Dropbox Witchcraft (Decision 4). BM25 does retrieval. A later spec can add a second retriever behind the seam.
- A digest of captures, or late replies to them.
- A graph editor. The graph is an index, not a view.
- Replacing canvas conversations. They keep working as they do today.
- The parked ideas in the design doc (conformal thresholds, changepoint detection, Dirichlet processes, submodular context selection).

## Acceptance checks

1. `npm test -- test/chat-graph*.test.ts` passes, and so does `go test ./...` in `chat-graph/`. Each of I1 to I10 has one or more cases marked `// Invariant I<N>: <Name>`.
2. `bash deploy/test.sh` passes, and `npm run build` produces `dist/chat-graph/chat-graph`.
3. On a throwaway instance (`CODEMAN_INSTANCE`, its own port), with `curl`:
   - Send three messages on two unrelated subjects. Two topics exist, and each message has a chip.
   - Send "ok do that" after a budget message. It lands in the budget topic.
   - Reassign one message. `GET /api/chat-graph/corrections` lists it.
   - Send `> buy stamps`. The answer is an acknowledgement, and no session receives text.
   - Merge the two topics, then undo. The memberships match the state before the merge.
4. Routing latency. Over 20 messages, the time from POST to the chip is under 7 s at the 50th percentile and under 12 s at the 95th. On 2026-11-18, one measured `claude -p` routing call took 4.9 to 5.1 s with Haiku.
5. Sidecar memory. `ps -o rss` stays under 64 MB after a load script files 100,000 messages into 1,000 topics.
6. Rollback. Deploy the branch, file messages, then roll back with `codeman-deploy`. The previous release starts, and its health check passes. Then roll forward. Every message is still there.
7. By hand on the throwaway instance, desktop and phone: the chat, the chips, reassign, the topic list, the topic view with summary and open items, merge and undo.

## Design

The design doc on the canvas (`chat-graph-design-doc`) is the product description. This spec changes it in three places:

- **Topic sessions are Claude Code sessions.** A warm topic appends to its live session, so Claude Code manages that context itself. The token-budget window and the summary fold apply only when a cold rebuild seeds a fresh session.
- **Retrieval is BM25 in v1, behind one seam.** The sidecar asks one retriever for ranked candidates. A later spec can add a second retriever, such as Witchcraft, without touching routing, `Decide` or the store.
- **Routing is one `claude -p` call.** It resolves references and scores the candidates together.

**The UI is not designed yet.** The doc's UX section is a rough idea. Ticket 6 has no design to build against. It waits in Backlog for a separate design spec with canvas prototypes, Work item W-78 (see Decisions for Harry).

## Technical design

**Processes.**
- `chat-graph`, the Go binary, listens on a Unix socket at `dataPath('chat-graph', 'sock')` with mode 0600. It speaks JSON over HTTP. It has no other listener and makes no outbound connection.
- `src/chat-graph/supervisor.ts` starts and stops it. Its lifecycle copies `src/deepseek-web-server.ts`, which runs one instance, kills it on shutdown and reports failures. It gates every start and kill on `deployRole.allows('persist')`, as `src/preview-supervisor.ts` gates its kills. It marks the child with `CODEMAN_CHAT_GRAPH_OWNER=<data dir>` so a sweep finds orphans. Codeman's password is not passed in the child's environment.

**Store.**
- One SQLite file, `dataPath('chat-graph', 'graph.sqlite')`, opened through `modernc.org/sqlite` (pure Go, no cgo). The Go modules are vendored so the deploy build needs no network.
- Tables:
  - `meta`, which holds the schema version.
  - `messages` holds id, text, ts, author, kind (`chat` or `capture`), and the resolved text.
  - `topics` holds id, title, status, merged_into, last_active_at.
  - `memberships` holds message_id, topic_id, source, confidence, op_id, removed_at.
  - `ops` holds id, kind, payload, created_at, undone_at.
  - `touches`, with the last 50 per topic.
  - `summaries` holds topic_id, version, text, open_items, created_at.
  - `corrections` holds the resolved text, the wrong topic and the right topic.
  - `proposals`.
  - `messages_fts` (FTS5) over message text and topic cards.
- Migrations only add tables and columns.

**Routing (one turn).**
1. Codeman posts the message to the sidecar. An explicit signal (a reply to a message, a quote, a chip tap) names the topic. In that case the sidecar attaches and returns at once, with no model call.
2. Otherwise the sidecar returns the top 5 candidates, ranked by `RetrievalScore` (the retriever's score normalised within the result set, plus activation), each with its card. In v1 the retriever is BM25.
3. Codeman runs one `claude -p --model haiku` call. It returns the resolved message, a 0 to 1 score per candidate and a title for a new topic.
4. Codeman posts the scores back. The sidecar runs `Decide`, which is pure and is the doc's revised code. Then it writes the memberships under the message id as `opId` (I5).
5. Codeman broadcasts the chips over SSE (`chat-graph:routed`).

**Replies.**
- Each topic records the id of its current canvas conversation.
- If `Session.promptCache.expiresAt` is in the future, Codeman delivers the message to that conversation's session through the existing delivery path (`src/canvas/conversation-delivery.ts`).
- Otherwise Codeman assembles a preamble with the summary, the open items, recent messages, retrieved chunks and up to 3 related cards, each with its source id (I8). The preamble and the message together stay under the conversation message cap, 16 KiB (`MAX_MESSAGE_BYTES`), with recent messages trimmed first. It starts a new conversation with that text and records it as the topic's current one.
- Topic conversations live in one canvas workspace, **Chat**, which Chat Graph creates on first start. A workspace holds at most 50 conversations. Before a new one would pass that cap, Codeman retires the conversation whose topic was touched longest ago. Retiring ends its session. The topic keeps its messages and summary, so nothing is lost.
- Codeman reads the reply out of the transcript when the turn ends (`extractReply` in `src/canvas/thread-reply.ts`) and posts it to the sidecar as an agent message.

**Summaries.**
- When a topic's messages beyond the token budget grow by a quarter of it, Codeman runs `claude -p` to fold them into the summary and open items. It also does this on a merge or split.
- The sidecar stores a new version and keeps the previous one for rollback.

**Lifecycle ops.**
- Merge, split, archive and undo are sidecar ops with an `opId` (I1, I5).
- Split takes the user's chosen contiguous run of messages. v1 suggests a split point from BM25 similarity between neighbouring runs, and always asks.

**Agent tools.** The MCP tools are `chat_graph_search`, `chat_graph_read` and `chat_graph_propose_note`. Every session lists them. A call answers 403 unless the calling session (`CODEMAN_SESSION_ID`) is a topic's current conversation, checked on each call. They return source ids (I8). Proposals wait for Harry (I9).

**Linker and repair pass.**
- The linker reuses each turn's candidate scores. It holds a high match until the reply's turn ends, then emits `chat-graph:related`.
- The repair pass re-clusters the last 7 days of messages over BM25 vectors. Codeman asks the sidecar to run it at most once an hour, and only while its role allows `automate`. It writes only proposals.

**Bootstrap.** On the first start, the canvas conversations of the last 7 days are read from their transcripts. They are replayed through routing in time order, and then the repair pass runs once.

**HTTP routes**, all under `/api/chat-graph`:
- `POST /messages`
- `GET /topics` and `GET /topics/:id`
- `POST /messages/:id/reassign`
- `POST /ops` and `POST /ops/:id/undo`
- `GET /proposals` and `POST /proposals/:id/{accept,reject}`
- `GET /corrections`

Each route answers 503 `CHAT_GRAPH_UNAVAILABLE` when the sidecar is down, and refuses in multi-user mode.

**Modules touched.**
- New files are `chat-graph/` (the Go module), `src/chat-graph/*`, `src/web/routes/chat-graph-routes.ts`, the SSE events in `src/web/sse-events.ts` and `constants.js`, and the MCP tools in `src/mcp-server.ts`.
- Changed files are `deploy/build.sh` or `scripts/build.mjs` (the Go build), `docs/architecture-invariants.md` (a new Chat Graph section) and `CLAUDE.md` (one paragraph).

**Risks.**
- *The deploy build may not have `go` on its PATH.* Ticket 1 checks this first. If it is missing, the fallback is a committed binary, built the way `src/mermaid-runtime` is shipped, which needs Harry's approval.
- *Similar topics get confused.* The chip and the correction log are the mitigation. Corrections become few-shot examples in the routing prompt.
- *A bad summary hurts every cold rebuild.* Summaries are versioned, and Harry can read and edit them in the topic view.
- *Routing adds about 5 s per turn.* Explicit signals skip the call. Acceptance check 4 sets the budget.

## Decisions for Harry

Decisions 1 to 3 were settled by the owner on 2026-11-18, and Decision 4 on 2026-11-19.

1. **The UI gets its own design spec.** Agreed. Tickets 1 to 5 and 7 to 9 are built and checked through the API. Ticket 6 stays in Backlog until a design spec with canvas prototypes is approved. That design spec is Work item W-78, filed in Needs refinement on 2026-11-18 at the owner's request so it gets done.
2. **Chat Graph stores chat text.** Agreed. It departs from the canvas rule that no message text is stored, and it keeps the text 0600 and out of search, as `intents.json` does.
3. **Routing uses Haiku, and about 5 s per routed message is accepted for the MVP.** Agreed. The owner noted that it seems slow. Haiku and Sonnet measured about the same (4.9 to 5.1 s against 5.0 to 5.6 s), because CLI start-up dominates. Settings can change the model. Cutting that start-up is a later spec, not part of this one.
4. **Witchcraft: not now.** Settled. The owner asked on 2026-11-19 whether Chat Graph can use Dropbox Witchcraft. It builds and runs on this host (measured under Checks run), but it held about 650 MB while loaded against BM25's 11 MB. On 11 held-out messages it found the right topic in the top 5 exactly as often as BM25 did (9 of 11). The owner chose option (c): ticket 10 is dropped, v1 retrieves with BM25 only, and the retrieval seam stays so a later spec can bring Witchcraft back. The other options were (a) a gated ticket 10 and (b) Witchcraft in v1.

## Checks run

- **Prototype.** Six timed `claude -p` routing calls, three on Haiku and three on Sonnet, against three topics and an ambiguous follow-up ("ok do that"). Every call resolved the reference and scored the right topic at 0.96 to 0.97.
- **Prototype.** The doc's revised `Decide` compiled and passed `go vet`, and was run on the multi-topic, archived and reactivation cases. The results matched the prose.
- **Witchcraft on this host** (2026-11-19, `dropbox/witchcraft` at its default branch, the ModernBERT quantized encoder, CPU only, run in a scratch directory outside the repository):
  - Build. It needs the Rust toolchain and two crates pinned to git forks (`candle`, `fbgemm-rs`). The first build took 6.5 min at 2 jobs with a 1.2 GB peak. On Linux without a GPU the upstream Makefile leaves out the `sqlite` feature and fails, so the build needs `EXTRA_FEATURES=sqlite`. The model is an 85 MB GGUF file, made from a 280 MB download.
  - Embedding. 2,811 real chat messages (median 126 characters, taken from local Claude Code transcripts) took 388 s at 2.8 cores, with a 716 MB peak. That is about 0.14 s per message, so a 100,000-message backfill is about 4 hours of three cores. The index build took 3 s, and the files took 7 MB.
  - Search. With the model loaded, the 95th percentile was 88 ms (semantic) and 93 ms (hybrid with SQLite BM25), at about 650 MB resident. A fresh process took 1.6 s per query. BM25 alone was 4 ms at 11 MB.
  - Quality. 11 sessions, with each session's last prompt held out as the query. Semantic, BM25 and hybrid each put the right session in the top 5 for 9 of 11 queries. Top 1 was 6, 6 and 5. The set is far too small to tell them apart. The README reports 34% NDCG@10 on NFCorpus, which this check did not reproduce.
- **Consistency audit** (`audit-invariant-consistency`, run by a separate agent against this spec, `docs/self-building.md` rules 5, 6, 8 and 10, `docs/architecture-invariants.md` and `CLAUDE.md`). It found five contradictions and three gaps, and revision 2 resolves each one:
  - A retired colour has no `persist`, so it could never stop its sidecar. Resolved in I6 and Constraints.
  - Topic replies would break the 50-conversation cap and the 16 KiB message cap, and a topic had no workspace. Resolved in Replies.
  - An explicit reply could attach a message to an archived topic. Resolved in I3 and I9.
  - Undoing a routing op would leave a message with no topic. Resolved in I2.
  - I2's test assumed a stopped sidecar could still file a message. Resolved in I2.
  - The `claude -p` helper uses tmux's default socket and creates panes without a role check. Resolved in Constraints and ticket 4.
  - I7 covered only reads by the previous release. Resolved in I7.
  - Per-session tool lists would be stale under the MCP server's cached tool list. Resolved in Agent tools.

  This audit is a search, not a proof. It cannot find conflicts that show up only at run time.

<details><summary>Tickets (9)</summary>

**Ticket 1: Go sidecar that Codeman builds, starts and stops.** Order 1. No dependencies.
- The `chat-graph/` module with vendored modules, the build step into `dist/chat-graph/`, and `src/chat-graph/supervisor.ts`.
- The sidecar answers `GET /health` on its socket.
- First, check that the deploy build has `go` on its PATH. If it does not, stop and ask.
- I6, plus acceptance check 2.

**Ticket 2: The store.** Order 2. Depends on ticket 1.
- The schema, migrations, FTS5, ops with undo, and mode 0600.
- I1, I5 and I7, plus acceptance check 5.

**Ticket 3: Routing in the sidecar.** Order 3. Depends on ticket 2.
- Retrieval with BM25 and activation, `Decide`, explicit-signal hard edges, and the correction log.
- I3 and I4.

**Ticket 4: Routing from Codeman.** Order 4. Depends on ticket 3.
- `POST /api/chat-graph/messages`, the `claude -p` routing call, the Unsorted fallback, captures, reassign, and `chat-graph:routed`.
- The `claude -p` helper moves onto Codeman's tmux socket and checks the deploy role before each spawn.
- I2 and I10, plus acceptance checks 3 and 4.

**Ticket 5: Topic sessions and context.** Order 5. Depends on ticket 4.
- The warm or cold choice from `promptCache.expiresAt`, the cold preamble with source ids, reply capture, and summary refresh with versions.
- I8, the assembly half.

**Ticket 6: Chat UI.** Order 6. Depends on ticket 5 and on the approved design spec from W-78. Filed in Backlog.
- The chat box, chips, the context line, the topic list, the topic view, proposals and Related suggestions.
- Acceptance check 7.

**Ticket 7: Merge, split, archive and undo.** Order 7. Depends on ticket 4.
- The routes and the sidecar ops, the split-point suggestion, and reactivation of an archived topic.
- I1 and I3 end to end.

**Ticket 8: Cross-topic tools and the linker.** Order 8. Depends on ticket 5.
- The three MCP tools, proposals, hard edges from replies and quotes, and `chat-graph:related`.
- I8, the tool half, and I9.

**Ticket 9: Repair pass and bootstrap.** Order 9. Depends on tickets 7 and 8.
- The hourly re-cluster that writes proposals only, and the 7-day bootstrap from canvas conversation transcripts.
- Acceptance check 6.

</details>
