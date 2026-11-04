# Intent: Import and remove plugins and skills

**Status:** Landed

## Problem statement

Codeman can launch many agent CLIs, and each one looks for skills and plugins in its own directory. There is no one place to add a plugin or a skill for all of them, and no one place to take it back. An agent inside a session cannot do it either, because the action exists nowhere the agent can call.

## Proposed outcome

A person can import a file or a GitHub repository, and can remove what was imported, from Settings. The same actions are `codeman extension`, `POST`/`DELETE /api/v1/extensions`, and three MCP tools. Installed copies are marked. Unmarked files are left alone. File contents are not edited.

## Affected users and systems

The person using Settings, and any agent that can call the CLI, the HTTP API, or the MCP server. The install touches the user-level skill directories of Claude Code, Codex, Grok, OpenCode, Gemini CLI, GitHub Copilot, and Pi, plus the plugin installers those CLIs ship. An optional case also receives a copy for CLIs that only scan the project.

## Constraints

GitHub over https only, with no credentials and no other hosts. Copies, never content edits. Never overwrite a directory Codeman does not own, and never follow or write through a symlink. HTTP writes stay admin-only in multi-user mode. The packaged Codeman skill is a different feature and stays on its own marker.

## Open questions

None.
