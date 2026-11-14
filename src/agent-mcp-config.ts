/**
 * @fileoverview The `--mcp-config` value that attaches the Codeman MCP server (`codeman mcp`,
 * src/mcp-server.ts) to a Claude launch, so the session's agent gets the session and canvas
 * tools with no `claude mcp add`.
 *
 * The server entry is THIS process's own entry script, never a `codeman` found on PATH: two
 * Codeman instances on one machine can run different code, and a session must attach the
 * server of the instance that launched it. The entry carries no env: the pane already exports
 * `CODEMAN_API_URL`, `CODEMAN_MUX` and `CODEMAN_SESSION_ID`, which `codeman mcp` reads.
 *
 * The value rides the launch as one single-quoted argument inside `bash -c "…"`, which the
 * server's own `sh -c` runs. `buildAgentMcpConfigJson` refuses any path that either shell
 * layer would read as syntax rather than emit a command line that might break.
 *
 * @module agent-mcp-config
 */

import { readAgentMcpEnabled } from './hooks-config.js';

/** The name the server is attached under. Claude Code shows its tools as `mcp__codeman__*`. */
export const AGENT_MCP_SERVER_NAME = 'codeman';

/** How this process was started: `process.execPath`, `process.execArgv` and `process.argv[1]`. */
export interface AgentMcpProcessEntry {
  execPath: string;
  execArgv: readonly string[];
  entryScript: string | undefined;
}

export type AgentMcpConfigResult = { ok: true; json: string } | { ok: false; reason: string };

// Quotes, `$`, backtick and backslash are syntax to one of the two shells the launch passes
// through; a control character has no place in a path that is about to be executed.
// eslint-disable-next-line no-control-regex
const UNSAFE_IN_LAUNCH = /['"`$\\\u0000-\u001f\u007f]/;

/** A debugger flag would make the MCP child fight the server for the inspector port. */
const isInspectorFlag = (arg: string): boolean => arg.startsWith('--inspect');

/**
 * Build the inline `--mcp-config` JSON from how this process was started. Pure: the caller
 * passes the process facts, so a test can name any entry.
 */
export function buildAgentMcpConfigJson(entry: AgentMcpProcessEntry): AgentMcpConfigResult {
  if (!entry.execPath || !entry.entryScript) {
    return { ok: false, reason: 'this process has no entry script to start the MCP server from' };
  }
  const args = [...entry.execArgv.filter((arg) => !isInspectorFlag(arg)), entry.entryScript, 'mcp'];
  const unsafe = [entry.execPath, ...args].find((part) => UNSAFE_IN_LAUNCH.test(part));
  if (unsafe !== undefined) {
    return { ok: false, reason: `${JSON.stringify(unsafe)} holds a character that is unsafe on a launch command line` };
  }
  return {
    ok: true,
    json: JSON.stringify({
      mcpServers: { [AGENT_MCP_SERVER_NAME]: { type: 'stdio', command: entry.execPath, args } },
    }),
  };
}

/**
 * The `--mcp-config` value for a launch starting now, or undefined when the synced
 * `agentMcpEnabled` setting is off or the entry cannot be put on a command line safely.
 * Reads the setting and the process facts at call time, so a toggle applies from the next
 * create or respawn.
 */
export async function resolveAgentMcpConfigJson(): Promise<string | undefined> {
  if (!(await readAgentMcpEnabled())) return undefined;
  const built = buildAgentMcpConfigJson({
    execPath: process.execPath,
    execArgv: process.execArgv,
    entryScript: process.argv[1],
  });
  if (built.ok) return built.json;
  console.warn(`[agent-mcp] Launching without the Codeman MCP server: ${built.reason}`);
  return undefined;
}
