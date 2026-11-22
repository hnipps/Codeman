# Intent: agent-started Codex and Antigravity workers honour an approvals-bypass setting

**Status:** Draft

## Problem statement

A Codex or Antigravity worker that an agent starts (`codeman agent spawn`, the MCP `start_session` tool, a `POST /api/quick-start` or `POST /api/sessions` that sends no CLI config) launches with its approvals on. Nobody watches that pane, so the worker stops at its first approval prompt. Only the browser Run button adds the bypass flag today.

## Proposed outcome

A local launch that sends no bypass value takes it from App Settings: Codex from the existing synced `codexDangerouslyBypassApprovals`, Antigravity from a new synced `antigravitySkipPermissions` (default off) with its own toggle in App Settings. A value the caller sends always wins. The Run button behaves as before.

## Affected users and systems

Owners who orchestrate workers from an agent. The registry's `capabilities.launchDefaults`, `applyLaunchDefaults()`, the create and quick-start routes, App Settings.

## Constraints

- The defaults are filled before the multi-user bypass clamp, so a non-granted owner still launches without the flag.
- Remote, Docker and custom-endpoint launches get no defaults, as before.
- A setting can only turn a flag on: `false` reads as unset.
- The new setting is synced and admin-only to write in multi-user mode.

## Open questions

None.
