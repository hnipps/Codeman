# Intent: Render Mermaid diagrams for people and agents

**Status:** Implemented and verified

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
- Do not restart the live server manually or change global settings.
  Deploy only with the owner's explicit authorization through `codeman-deploy`.

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
Keep the renderer offline and do not change the supervisor.
Deployment requires the owner's explicit authorization.

The private runtime now contains the 12 missing libraries, totaling about 2 MB.
The compiled command produces PNG and SVG with no temporary environment
variables or sandbox flags. The VM's explicit opt-out is stored only locally.
Focused runtime tests, all five browser tests, and the 309-test deployment gate
pass. That verification did not deploy the feature.

## Emergency recovery follow-up

The owner requests that the native dependencies be recoverable from Git.
Pinned npm and Chromium downloads during recovery are acceptable. Commit the
small native library bundle with checksums, provenance, applicable license
notices, and corresponding source where required. Keep it outside public web
assets and include it in built packages.

Provide a repeatable instance setup command. It must verify the bundle before
writing configuration, support only the tested native platform, and require an
explicit sandbox opt-out. Repeating setup must be safe and must not overwrite
unrelated existing configuration. Recovery must not depend on session artifacts,
absolute paths from this VM, or files outside Git other than normal package and
browser installation. Verify from a clean Git export and an isolated data dir.

The versioned bundle contains all 12 libraries with official package pins,
notices, full license texts, and matching LGPL source archives. Setup verifies
all 34 bundled files and preserves existing configuration. A clean Git-tree
export built successfully, restored its own isolated native runtime, and
produced inspected PNG and SVG output without the old native library path.
The package dry-run includes every native, notice and source file. Focused
recovery/input tests, all five real browser tests, static checks and the
309-test deployment gate pass. The owner has authorized merge and supervised
deployment after this work.

## Workflow and throughput checkpoint

1. Establish the shared renderer document and verify real SVG output.
2. Add the agent command and verify PNG, SVG, and invalid input.
3. Connect the existing Markdown pipeline and verify all three readers.
4. Update agent guidance and architecture rules. Run focused regression checks.

The shared renderer is the only implementation dependency between the CLI and
UI work. Work stays in this checkout on a branch from master. A design comparison
rejected rendering in the dashboard origin because Mermaid receives untrusted
diagram text. Browser checks cover actual SVG geometry and image decoding.
