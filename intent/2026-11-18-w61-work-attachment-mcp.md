# Intent: Fetch a Work item attachment through MCP (W-61, part 4 of 4 of W-42)

**Status:** Draft

## Problem statement

`canvas_work read` lists an item's attachments (`{id, name, type, size}`) but an agent has no way to read the bytes. A screenshot or log a person attached to an item is invisible to the agent that picks the item up.

## Proposed outcome

A new MCP tool, `canvas_work_attachment {key, id, path?}`, reads one attachment through the existing `GET /api/v1/canvas/current/work/:key/attachments/:id`.

- A PNG, JPEG, GIF or WebP up to `MAX_INLINE_IMAGE_BYTES` (its base64 is 5 MiB, the Claude API's per-image limit) comes back as MCP image content.
- A file the route serves as `text/plain` (txt, md, csv, tsv, json, log, yaml, xml) comes back as text, the first `MAX_OUTPUT_CHARS` characters.
- With an absolute `path`, any attachment is saved to a NEW local file (`wx`, 0600). That is how an agent reads a PDF, an Office file, a zip or a larger image with its own tools. Without `path` those are refused with that advice. `path` is not confined to the workspace: the agent can already write any file with its own tools.
- `httpRequest` keeps an `application/octet-stream` body as bytes, as it already does for images, so binary files are not decoded as UTF-8.

## Affected users and systems

- Agents using `codeman mcp` inside a canvas case.
- `src/mcp-server.ts`, `src/cli-agent.ts` (`httpRequest`), the tool counts in `docs/architecture-invariants.md`, `docs/subsystem-rules.md` and `docs/extending-codeman.md`.

## Constraints

- No new route and no server change: the MCP server stays a client of the HTTP API, and the route keeps its workspace scoping and attachment-id checks.
- `path` never overwrites a file.
- No `structuredContent`, like `canvas_screenshot` and `read_output`.

## Open questions

None.
