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

- The owner approves disabling Chromium's OS sandbox inside this VM.
  Keep that choice local to this instance, never the default for other hosts.

## Host runtime follow-up

The smaller Chromium headless shell still requires native shared libraries.
Those are binary dependencies, not JavaScript that a bundler can remove.
This account has no passwordless package-manager access. Use a private runtime
directory containing only the missing libraries instead of changing system
packages. Persist its library path and the approved sandbox opt-out in an
instance-local renderer configuration. Existing agents must be able to use the
same render command without temporary environment variables or extra flags.

The configuration is read only when the renderer runs. Other commands, browser
Markdown rendering, and hosts without this configuration keep their behavior.
Keep the renderer offline and do not change the supervisor or deploy yet.

The private runtime now contains the 12 missing libraries, totaling about 2 MB.
The compiled command produces PNG and SVG with no temporary environment
variables or sandbox flags. The VM's explicit opt-out is stored only locally.
Focused runtime tests, all five browser tests, and the 309-test deployment gate
pass. The feature remains undeployed.

## Workflow and throughput checkpoint

1. Establish the shared renderer document and verify real SVG output.
2. Add the agent command and verify PNG, SVG, and invalid input.
3. Connect the existing Markdown pipeline and verify all three readers.
4. Update agent guidance and architecture rules. Run focused regression checks.

The shared renderer is the only implementation dependency between the CLI and
UI work. Work stays in this checkout on a branch from master. A design comparison
rejected rendering in the dashboard origin because Mermaid receives untrusted
diagram text. Browser checks cover actual SVG geometry and image decoding.
