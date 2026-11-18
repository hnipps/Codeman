# Intent: keep `canvas_capabilities` under its 60,000-byte budget

**Status:** Draft

Work item W-8. This note is a recommendation. It changes no code. Harry decides; the chosen fix is filed as its own Backlog item.

## Problem statement

`capabilities()` in `src/canvas/commands.ts` builds the document that `canvas_capabilities` returns. The command route (`src/web/routes/canvas-routes.ts`, the `canvas_capabilities` case) sends it as `{ ...capabilities(), truncated: false }`. `test/mcp-canvas-tools.test.ts` holds that response to `MAX_CANVAS_TEXT_BYTES` (60,000, `src/canvas/queries.ts`) twice: once on `capabilities()` and once on the text the MCP tool returns.

On master `ca958cfa` (2026-11-17) the response is **59,962 bytes**, which leaves **38 bytes** of headroom. The item measured 59,986 on `ed132f9b`, so recent trims moved the number slightly but did not change the situation. `canvas_work` and `canvas_routine` already appear by name only (`BRIEF_CAPABILITY`). The next tool, or one more field on an existing schema, fails the test.

Nothing enforces the cap at runtime. The route does not cut the document, and no code path truncates it. The cap is a promise the test keeps: "canvas reads are capped text". Breaking the promise would cost every agent that calls the tool about 15k tokens of context, and that cost is the real reason for the cap.

### Measurements

The scripts are `measure.ts` and `options.ts` in the run's scratchpad. To reproduce, put a file under `scripts/` that imports `capabilities` from `../src/canvas/commands.js`, run it with `npx tsx`, and print `Buffer.byteLength(JSON.stringify(...))` for each key. The output is deterministic: the document has no clock, no random value and no I/O, so one run is the whole sample.

| Section                              |  Bytes |
| ------------------------------------ | -----: |
| `tools`                              | 32,174 |
| `commands`                           | 14,966 |
| `compoundCommands`                   |  4,621 |
| `views`                              |  1,778 |
| `conversations`                      |  1,457 |
| `transforms`                         |  1,263 |
| `tasks`                              |    995 |
| `media`                              |    867 |
| `elements`                           |    591 |
| `geometry`                           |    395 |
| `clipboard`                          |    303 |
| `restrictions`                       |    282 |
| `future`                             |     75 |
| `reserved`                           |      2 |
| Whole document, `truncated` included | 59,962 |

The largest entries in `tools` are `canvas_update` 6,816, `canvas_view` 3,741, `canvas_create` 3,315, `canvas_arrange` 3,204, `canvas_conversation` 3,135 and `canvas_query` 1,759. The 69-byte list of object types appears 40 times, about 2,800 bytes in all.

### Where the bytes come from

Most of the document repeats schemas that the agent already has:

- Every `canvas_*` command tool's full typed schema is in the MCP `tools/list` answer (`buildToolDefinitions()` in `src/mcp-server.ts` calls `canvasJsonSchema(toolSchemas[name])`). Those schemas total 49,646 bytes. The `tools[].schema` entries in the document are the same schemas, built untyped.
- `commands` holds one schema per operation kind. The `canvas_create`, `canvas_update` and `canvas_delete` tool schemas are batches of those same kinds. The one exception is `revert`, and no tool accepts a raw `revert` operation (`canvas_history` `revert` takes no operation).
- `compoundCommands` splits the `canvas_arrange` schema by action, and `transforms.schema` is the `canvas_transform` schema again.

So roughly 50 KB of the 60 KB is a second copy of something the client already loaded.

### Who reads the document

- **MCP agents.** They call `canvas_capabilities`. `src/mcp-server.ts` tells them it "lists schemas, supported types and reserved browser view operations". This is the only real reader.
- **HTTP callers.** `POST /api/v1/canvas/current/command` with `tool: canvas_capabilities`, documented in `docs/api-reference.md` ("machine-readable schemas, object-type support, geometry semantics and reserved future view operations").
- **Tests.** `test/mcp-canvas-tools.test.ts` checks the byte cap, `truncated: false`, `reserved`, and the `conversations` and `tasks` command names. `test/canvas-commands.test.ts` checks `compoundCommands` has no `snap` and reads `geometry.snapping`.
- **No browser code.** `packages/canvas` and `src/web/public` never read it.
- **Docs that describe it.** `skills/codeman/reference/verbs.md` (mirrored in `plugins/codeman/`) says it "returns strict schemas and type support for all twelve command tools". That line is already out of date. `docs/architecture-invariants.md` (Capabilities, Canvas routines) and `docs/subsystem-rules.md` (Canvas work) record the "list a new tool briefly" workaround.

## Options

### (a) Schemas by reference

Each tool is listed as name, `objectTypes` and an optional note, because its schema is already in the MCP tool listing. The per-type operation lists and every non-schema section stay. `BRIEF_CAPABILITY` becomes the rule for every tool, so the special case goes away.

| Variant | What leaves the document                                                                                   |   Size | Headroom |
| ------- | ---------------------------------------------------------------------------------------------------------- | -----: | -------: |
| a1      | `tools[].schema` only                                                                                      | 30,876 |   29,124 |
| a2      | a1, plus the schemas in `commands`, `compoundCommands` and `transforms` (the names and `objectTypes` stay) | 12,471 |   47,529 |
| a3      | a2, plus the type list stated once at the top and `"all"` where it was repeated                            | 10,251 |   49,749 |

- **What breaks.** A reader that took schemas from this document has to take them from `tools/list`. Every MCP client already has them there. An HTTP caller with no MCP listing loses its only machine-readable schema source. Nothing in the repository is such a caller, but `docs/api-reference.md` promises the schemas and must change. Removing fields from a response under `/api/v1` is arguably a breaking change (`docs/versioning-policy.md`). Under a2, the raw `revert` operation schema is no longer listed, and no tool accepts it.
- **Growth.** A new tool adds about 100 bytes, not 1 to 7 KB. At a2, about 400 more tools would fit.
- **Code size.** One `.map` loses its `schema` field, two `.map`s drop a key, `BRIEF_CAPABILITY` and its two special entries are deleted, and the test and docs are updated. One small PR.

### (b) Sections or paging

`canvas_capabilities` takes an optional `section` (`tools`, `commands`, `views` and so on) and returns that section only.

- **What `{}` returns.** It either keeps returning the whole document, which is already at the cap and solves nothing, or it returns an index of sections (about 490 bytes). An index changes what every current caller gets from `{}`, including the assertions on `reserved`, `conversations` and `tasks` in `test/mcp-canvas-tools.test.ts`.
- **Headroom.** Each section has its own 60 KB. The largest, `tools`, is 32,202 bytes by itself, so it has about 28 KB of room before it needs paging too. About five more tools the size of `canvas_create` would fill it.
- **Cost.** Each agent makes two calls instead of one. The tool's schema (`z.object({}).strict()`), its description and the documentation change. The duplication stays, and so does the 15k-token full read for anyone who asks for every section.
- **Code size.** Small: an optional enum field and a pick. It adds a mechanism and keeps the waste.

### (c) Code mode

Expose the canvas as a typed TypeScript API. The agent writes a short script that calls it instead of calling about 21 JSON-schema tools one at a time. The client would be generated from the same zod schemas, which work in `z.infer` and `z.toJSONSchema` today, and would call the existing command route. It might be a `codeman canvas` module, or a `.d.ts` plus a runner that `codeman agent` or a single MCP tool such as `canvas_run` executes.

- **What it would replace.** The 21 canvas tool definitions in `tools/list`: 49,646 bytes of schema, plus descriptions, that every MCP client loads into context at the start of each session whether or not it uses the canvas. It would also replace the capability document itself, because the types _are_ the capability description. A multi-step edit (read, decide, create a batch, arrange) becomes one script and one round trip instead of several tool calls.
- **What it costs.**
  - It needs somewhere to run agent-written code. Running it on the server is a new code-execution surface on a server that so far only runs fixed argv. It would need a sandbox (a V8 isolate or a locked-down child process with only the canvas bindings), limits on time, memory and output, and the same parent-session authorship stamping as today's `X-Codeman-Parent-Session` path. Running it on the agent's side (`npx tsx` against the HTTP API) needs no sandbox, but it is mostly what an agent with a shell can already do with `codeman agent` and curl.
  - It needs a generator for the `.d.ts` and the client, and a test that keeps them in step with `toolSchemas`.
  - Clients with no shell and no runner, such as a desktop MCP client, need the MCP tools, so the tools stay during any migration and both surfaces have to be maintained.
  - It is several PRs over more than one release, with a security review. It is not the next small fix.
- **Does it remove the limit.** Yes for this document. The types become files read on demand, so `MAX_CANVAS_TEXT_BYTES` no longer applies. A typed client for the current schemas would be roughly the size of the schemas (about 40 to 50 KB of `.d.ts`, estimated), so the bytes move rather than vanish. They are only read when needed, and an agent could read one module at a time.
- **Judgment.** It is worth a separate design note if the goal is a smaller `tools/list` and fewer round trips. It is the wrong tool for a 38-byte problem.

## Comparison

|                    | (a) by reference, a2                                            | (b) sections                               | (c) code mode                                                       |
| ------------------ | --------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| Size after         | 12,471 bytes, one call                                          | 491-byte index plus up to 32 KB a section  | Document gone; about 40 to 50 KB of types read on demand (estimate) |
| Room for growth    | About 47 KB, about 100 bytes per new tool                       | About 28 KB in `tools`, then paging        | No cap                                                              |
| Callers broken     | HTTP callers that read schemas from it (none in the repo); docs | Every `{}` caller if `{}` becomes an index | None at first (it is additive); MCP tools would be retired later    |
| Duplication        | Removed                                                         | Kept                                       | Removed                                                             |
| Agent context cost | About 3k tokens                                                 | Two calls, the same bytes in total         | Smaller `tools/list`, types on demand                               |
| Work               | One small PR                                                    | One small PR                               | Several PRs, a sandbox and a security review                        |

## Recommendation

**(a), variant a2.** List every canvas tool by name, `objectTypes` and note, and drop the schema copies in `tools`, `commands`, `compoundCommands` and `transforms`. Keep the operation names, type support, restrictions, geometry, views, conversations, tasks, clipboard and `reserved`. Delete `BRIEF_CAPABILITY`, because every tool is then brief.

Why this one:

- It removes the cause: about 50 KB of the 60 KB is a copy of what `tools/list` already gives every MCP agent. (b) keeps that copy and adds a second call. (c) removes it but needs a sandbox for a problem one map can fix.
- The document goes from 59,962 to 12,471 bytes. A new tool then costs about 100 bytes, so the "list it briefly or it does not fit" rule in `docs/architecture-invariants.md` and `docs/subsystem-rules.md` can be removed rather than repeated.
- The diff is small. One function, the test, and four doc passages.

Do a3, the hoisted type list, only if a2 turns out not to be enough. It saves another 2.2 KB and makes the document harder to read.

Keep (c) as its own Backlog idea if Harry still wants it after (a) lands. The case for it is a smaller `tools/list` and fewer round trips, not this cap.

## Affected users and systems

MCP agents on the canvas see a shorter `canvas_capabilities` answer and take schemas from their tool listing, which they already do in practice. HTTP callers of the command route lose the schema fields. `docs/api-reference.md`, `skills/codeman/reference/verbs.md` (and its plugin mirror), `docs/architecture-invariants.md` (Capabilities) and `docs/subsystem-rules.md` (Canvas work) need updates in the same change.

## Constraints

- Keep `MAX_CANVAS_TEXT_BYTES` and the test that measures the document. The fix makes room under the cap; it does not raise it.
- `truncated: false`, `reserved: []`, and the `conversations` and `tasks` command lists stay, because the tests and callers read them.
- `docs/versioning-policy.md` covers the `/api/v1` response shape. Decide whether removing schema fields from this response needs a changeset note or a minor bump, or whether the canvas surface counts as experimental.

## Open questions

- Is the canvas command route under `/api/v1` covered by SemVer, or is it experimental? This decides how the a2 change is announced, not whether it is made.
- Does anyone outside this repository call `canvas_capabilities` over HTTP for schemas? Nothing in the repository does.
