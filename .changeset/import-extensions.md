---
"aicodeman": minor
---

**Import and remove plugins and skills for every agent CLI.** App Settings → Agents & CLIs → Plugins & skills takes a GitHub repository or a file (a SKILL.md, zip, or tar.gz) and installs it for the agent CLIs on this machine. `codeman extension import`, `codeman extension remove`, and the MCP tools `list_extensions`, `import_extension`, and `remove_extension` do the same thing, so an agent can install and remove them too. Removing uninstalls through each CLI that accepted the plugin and deletes only the copies Codeman made.
