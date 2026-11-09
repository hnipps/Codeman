# Agent environment

Agents in Codeman sessions lose turns when the host lacks a tool they reach for, or when a tool is installed but not on the PATH a session gets. This page lists the gaps a transcript review found on one self-hosted deployment, and the scripts in `scripts/agent-env/` that check and fix them.

## Check and fix

| Script                                         | What it does                                                                                                                                                                                         | Needs   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `scripts/agent-env/check.sh`                   | Runs each check under the PATH Codeman gives agent sessions (`~/.local/bin` first, then the system directories), not under a login shell. Prints `PASS` or `FAIL` per check and exits 1 if any fail. | nothing |
| `scripts/agent-env/fix.sh`                     | Installs the missing user-level tools into `~/.local`. Steps skip themselves when the tool already resolves, so it is safe to rerun.                                                                 | network |
| `scripts/agent-env/install-system-packages.sh` | Installs the packages that only apt can provide.                                                                                                                                                     | sudo    |

Run `check.sh` before and after `fix.sh`. On the reviewed host, all 13 checks failed before the fix and 6 failed after it. Those 6 need sudo or an operator decision.

## What `fix.sh` covers

| Gap                                                             | What agents saw                                                                           | Fix                                                      |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `grok`, `lean`, `lake` and `elan` missing from the session PATH | `command not found`. Only interactive shell rc files add `~/.grok/bin` and `~/.elan/bin`. | Symlinks in `~/.local/bin`                               |
| No `python`                                                     | `python: command not found`                                                               | `~/.local/bin/python` links to `python3`                 |
| No pip and no venv                                              | `No module named pip`, missing Python packages                                            | `uv`. Use `uv venv --seed` or `uv run --with <package>`. |
| No ripgrep                                                      | `rg: command not found`                                                                   | ripgrep, checksum verified                               |
| No hyperfine                                                    | Perf work fell back to hand-written timers                                                | hyperfine. Upstream publishes no checksum.               |
| No Go toolchain                                                 | Projects with `go.mod` could not build                                                    | Go, checksum verified                                    |

## Needs sudo

`install-system-packages.sh` covers `unzip`, `fontconfig` and fonts for headless browser screenshots, the system `pip` and `venv`, and Pillow.

## Open issues found by the review

- **Copilot hooks fail on every tool call.** Codeman writes the `PostToolUse` and `SubagentStop` hooks in `.claude/settings.local.json` as `"command": "node"` with a separate `"args": ["-e", "<script>"]`. Claude Code reads `args`. Copilot reads the same file but ignores `args`, so it pipes the hook's JSON event into bare `node`, which fails with `SyntaxError: Unexpected token ':'`. The review counted 301 of these. The fix is to write those hooks as one `command` string.
- **Copilot and Grok stop on a folder-trust dialog in every new case.** Codeman does not answer either one, so an automated worker waits until someone does. Copilot also starts in Manual Approval mode.
- **Antigravity cannot run until it is signed in.** Its first screen is the Google login.
- **Agents read `/proc/<pid>/environ` to find the Codeman password** after a raw `curl` returned 401. Agents should call the API through `codeman agent` or the codeman skill's preamble.
- **The crosscheck Dafny and Lean MCP tools need Docker.** Without it they fail with `spawn docker ENOENT`.
- **Preview isolation falls back to environment markers** when the tmux service's cgroup is not delegated to the app user.
- **A shell started directly by a systemd unit gets the default PATH**, so it finds none of the CLIs in `~/.local/bin`. Agent sessions are not affected, because Codeman puts `~/.local/bin` on their PATH.

## How the review ran

Codeman workers each scanned one CLI's transcript store and wrote one finding per root cause. Claude covered Claude Code transcripts, Copilot covered its session state and logs, and Grok covered its sessions. A second Claude worker took Antigravity's slice, because Antigravity kept no transcripts. That slice was Codeman's session lifecycle log, a dependency check of each case project, and PATH resolution for each CLI. Each finding was rechecked on the host before anything changed. The raw findings stay off this repository, because they hold host paths and session ids.
