# Intent: Render Mermaid diagrams for people and agents

**Status:** Implemented

## Problem statement

Codeman displays Mermaid fences as source. Agents have no bundled command to
render their diagrams into an image and inspect the result.

## Proposed outcome

Chat, the Response Viewer, and Markdown file previews render Mermaid fences.
Every agent CLI can run `codeman mermaid render diagram.mmd -o diagram.png`
without a Codeman server. SVG output is also supported. Invalid diagrams keep
their source visible in the UI and fail the command without writing an output.

## Affected users and systems

People reading Markdown in Codeman, agents checking diagrams, browser asset
preparation, the local CLI, and the bundled agent instructions.

## Constraints

- Use the same pinned Mermaid engine and configuration for the UI and command.
- Keep diagram code outside the dashboard origin in a sandboxed frame.
- Display generated SVG as an image, never insert it into the dashboard DOM.
- Keep the Markdown sanitizer and existing code-copy behavior.
- Bound source size, graph edges, queued work, and rendering time.
- Do not deploy, restart the live server, or change global settings.

## Open questions

- None. This host needs Chromium libraries and an explicit sandbox opt-out.
  Verification uses session-local extracted libraries, not a system installation.

## Workflow and throughput checkpoint

1. Establish the shared renderer document and verify real SVG output.
2. Add the agent command and verify PNG, SVG, and invalid input.
3. Connect the existing Markdown pipeline and verify all three readers.
4. Update agent guidance and architecture rules. Run focused regression checks.

The shared renderer is the only implementation dependency between the CLI and
UI work. Work stays in this checkout on a branch from master. A design comparison
rejected rendering in the dashboard origin because Mermaid receives untrusted
diagram text. Browser checks cover actual SVG geometry and image decoding.
