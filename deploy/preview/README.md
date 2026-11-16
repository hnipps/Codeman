# What a preview machine runs in place of Claude

A preview is a branch of Codeman running for a reviewer on a throwaway machine
(`docs/review-instance-address-plan.md`). That machine has no Claude Code login and no API key, and it must
never get one. This folder holds what the branch brings with it so its sessions still have something to show.

## `bin/claude`

A stand-in for the `claude` command. The service that starts a preview puts this `bin` folder at the front of
the preview's `PATH`, so Codeman finds it where it would find the real command.

It is a script with fixed answers. It draws a composer, takes a prompt, shows a working row for two seconds,
prints its answer and waits again. It keeps the parts of the real command that Codeman reads off a pane:

| Codeman reads | The stand-in |
| --- | --- |
| The composer row and its footer | A row that starts with `❯`, over a footer that carries `shift+tab`. |
| The working row | `✻ Thinking… (3s · esc to interrupt)`, gone when the answer is printed. |
| A prompt as one bracketed paste and Enter | Taken as one prompt; the composer is empty afterwards. |
| The conversation file | Each turn is appended to `<config dir>/projects/<folder>/<session id>.jsonl`. |
| Hooks | `UserPromptSubmit`, `Stop` and `Notification` (`idle_prompt`, after a minute) from the workspace's settings and from `--settings`. |
| `claude --version` | A version line the real command could print, marked as the stand-in. |

Escape stops a turn, `/clear` starts a new conversation, and `/exit` leaves. Every other slash command answers
that it is not available. Tools, permission dialogs, the status line, background work and resuming an earlier
conversation are absent.

It opens no network connection. It imports nothing that could, and the only processes it starts are the hooks
above, which Codeman wrote and which report to the Codeman server on the same machine.

### Scripted answers

`CODEMAN_STANDIN_REPLIES` names a JSON file: `[{ "match": "deploy", "reply": "Deployed.", "seconds": 5 }]`.
The first entry whose `match` is part of the prompt, ignoring case, answers it after `seconds`. A match is a
substring, never a pattern. Without the file, or for a prompt nothing matches, the fixed answer is used.
`CODEMAN_STANDIN_SPEED` divides every wait; tests set it.

## Not here yet

- Seed data, so every preview opens on the same sessions, cases and canvas.
- The names above (`deploy/preview/bin`, the two variables) are what this repository offers. The service that
  starts previews is not built, and it may ask for other names.

Tests: `test/preview-standin-claude.test.ts` runs the script in a real terminal and reads it with the claude
entry of the CLI registry, so a change to what Codeman expects of a claude pane fails there.
