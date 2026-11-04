# Import and remove plugins and skills

Use `codeman extension` when the user asks to add or remove a plugin or a skill
for the agent CLIs on this host. It is a local command: it does not need §0, the
HTTP API, or `CODEMAN_MUX`. Run it only for an import or removal the user asked
for. There is no command that edits file contents.

```bash
codeman extension list
codeman extension import owner/repo
codeman extension import https://github.com/owner/repo/tree/main/skills/review
codeman extension import ./review.zip --case mycase
codeman extension remove skill:review
codeman extension list --json
```

`--json` prints the catalog, the install result, or the removed record. Read
`notes` and each target's `status`. An id is `skill:<slug>` or `plugin:<slug>`
from `list`.

## What you can import

Pass one source.

- A GitHub repository: `owner/repo`, `owner/repo@ref`, `owner/repo#subdir`,
  `owner/repo@ref#subdir`, or `https://github.com/owner/repo` (optional `.git`,
  or a `/tree/<ref>/<path>` or `/blob/<ref>/<path>` link). A blob link whose
  last segment is `SKILL.md` imports that skill's directory. A branch name that
  contains a slash uses the `@ref#path` form.
- A local directory, `.zip`, `.tar.gz` (or `.tgz`), or a single `SKILL.md`.
  On the command line, a path that exists is the file. Anything else that looks
  like a repository is cloned. The HTTP body keeps `github` and `path` apart,
  and `path` must be absolute on this host.

GitHub is cloned over https with no credentials. Other hosts, SSH URLs, and URLs
that contain a username or password are refused. Archives are capped (32 MB
compressed, 64 MB extracted). A path that escapes the archive is refused.

A skill is a directory with `SKILL.md`. A plugin is a directory with
`.claude-plugin/plugin.json` or `.grok-plugin/plugin.json`, a `plugin.json`
beside `skills/`, `commands/`, `agents/`, `hooks/`, or `.mcp.json`, or a folder
named by that repo's marketplace file. Skills inside a plugin stay part of the
plugin. At most 30 skills and plugins are imported at once.

## Where it lands

Skills are copied into each CLI's user skill directory. A plugin is also handed
to that CLI's installer when the binary is on this host: `claude`, `grok`,
`codex`, `agy`, and `copilot`. One CLI failing leaves the others installed. The
import fails only when nothing was installed. If a later item fails, earlier
items stay and the error names them.

A successful plugin install already exposes that plugin's skills to Claude,
Codex, Grok, and Copilot, so those skill directories are not filled again.
Copilot's installer accepts a whole `owner/repo` that contains exactly one
plugin. Any other shape copies skills into `~/.copilot/skills`.

`--case <name>` (HTTP and MCP field `case`) also copies skills into that one
case, which is where Antigravity, DeepSeek Harness, and OMP read them. Pi reads
`~/.agents/skills`, which every install writes. Importing again under the same
name refreshes the copies Codeman owns.

A plugin install runs that CLI's own installer. Grok is installed with
`--trust`, so hooks and MCP servers in the plugin are enabled. Say that when
you report the result.

## Remove

`codeman extension remove <id>` uninstalls a plugin through each CLI that
accepted it, then deletes the skill directories Codeman copied for that id.
A directory Codeman did not import is left in place, including one you wrote
yourself and the packaged `codeman` skill. If an uninstall fails, the row stays.
Run the same remove again after the CLI is available.

Imports run one at a time. A second import waits.

## The same actions over HTTP and MCP

`GET /api/v1/extensions` returns `{ items }`. `POST /api/v1/extensions/import`
takes `{ "github": "owner/repo" }` or `{ "path": "/absolute/dir", "case": "name" }`,
or a multipart upload with field `file` and an optional `case` field. The answer
is `{ installed, notes }`. `DELETE /api/v1/extensions/<id>` returns the removed
record. Encode the colon in the id. In multi-user mode the two writes are
admin-only. `400` is a bad source, `404` an unknown id, `409` a directory
Codeman does not own, `422` an install that produced nothing or an uninstall
that failed.

The MCP tools `list_extensions`, `import_extension`, and `remove_extension` call
those routes. `import_extension` takes `github` or `path`, and an optional
`case`. It reaches GitHub, so allow that call its network. Prefer
`codeman extension` from a shell on this host: it is the same service without
the admin check.
