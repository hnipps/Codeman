# Intent: Background rewake waits only on a Claude transcript

**Status:** Draft

## Problem statement

The PostToolUse background-rewake helper polls a session transcript for up to six hours, looking for a Claude `queue-operation` completion. Other CLIs load the same settings file, ignore `asyncRewake`, and run that helper in the foreground. They never write that record, so a background shell blocks the turn until the deadline or until the hook is cancelled.

## Proposed outcome

The helper returns immediately unless the transcript path has a `.claude` directory segment. Claude sessions still wake when the matching background command completes. An installed copy of the previous script is replaced because the marker moved to `CODEMAN_BACKGROUND_REWAKE_V4`.

## Affected users and systems

Any CLI that loads `.claude/settings.local.json` and runs the Codeman PostToolUse Bash hook. Claude Code keeps the existing wake. The installed hook is rewritten by `refreshStaleCodemanHooks`.

## Constraints

Keep `asyncRewake` and the Claude poll, including the parent transcript for a subagent. Do not send terminal input from the helper. Do not drop the six-hour deadline for a real Claude transcript. Bump the marker suffix whenever the script changes.

## Open questions

None. A running CLI keeps the previous script in memory until it reloads hooks from disk.
