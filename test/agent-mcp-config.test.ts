/**
 * @fileoverview Codeman's own MCP server on every local Claude launch (`--mcp-config`, synced
 * setting `agentMcpEnabled`, absent = on).
 *
 * The rendered flag is read back through REAL shells, the two layers a pane command passes
 * through (`sh -c` running `bash -c "<JSON.stringify(command)>"`), so a quoting mistake shows
 * up as the wrong argv, never as a string that only looks right.
 *
 * Port: none (pure builders plus a settings file under the per-file temp HOME).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildAgentMcpConfigJson, resolveAgentMcpConfigJson } from '../src/agent-mcp-config.js';
import { cliTakesAgentMcp } from '../src/session-cli-registry-bridge.js';
import { buildInteractiveArgs } from '../src/session-cli-builder.js';
import { buildSpawnCommand, TmuxManager } from '../src/tmux-manager.js';
import { cliIds } from '../src/config/cli-registry/registry.js';
import { SETTINGS_PATH } from '../src/web/route-helpers.js';

const NODE = '/opt/node/bin/node';
const ENTRY = '/srv/app/dist/index.js';
const SID = '0f9c2b14-1111-2222-3333-444455556666';

function configFor(entryScript = ENTRY, execArgv: string[] = []): string {
  const built = buildAgentMcpConfigJson({ execPath: NODE, execArgv, entryScript });
  if (!built.ok) throw new Error(built.reason);
  return built.json;
}

/** The argv a pane's `bash -c` would hand to the CLI, resolved by the same two shells. */
function paneArgv(command: string): string[] {
  const inner = `printf '%s\\0' ${command.replace(/^claude /, '')}`;
  const out = execFileSync('sh', ['-c', `bash -c ${JSON.stringify(inner)}`]).toString();
  return out.split('\0').slice(0, -1);
}

describe('buildAgentMcpConfigJson', () => {
  it("names this process's own entry as a stdio server called codeman", () => {
    expect(JSON.parse(configFor())).toEqual({
      mcpServers: { codeman: { type: 'stdio', command: NODE, args: [ENTRY, 'mcp'] } },
    });
  });

  it('keeps the runtime flags a dev server was started with, ahead of the entry script', () => {
    const execArgv = ['--require', '/srv/app/node_modules/tsx/dist/preflight.cjs', '--import', 'file:///srv/tsx.mjs'];
    expect(JSON.parse(configFor('/srv/app/src/index.ts', execArgv)).mcpServers.codeman.args).toEqual([
      ...execArgv,
      '/srv/app/src/index.ts',
      'mcp',
    ]);
  });

  it('drops a debugger flag, which the MCP child would fight the server over', () => {
    const args = JSON.parse(configFor(ENTRY, ['--inspect=9229', '--enable-source-maps', '--inspect-brk'])).mcpServers
      .codeman.args;
    expect(args).toEqual(['--enable-source-maps', ENTRY, 'mcp']);
  });

  it.each([
    ['a single quote', "/srv/it's/index.js"],
    ['a double quote', '/srv/a"b/index.js'],
    ['a dollar sign', '/srv/$HOME/index.js'],
    ['a backtick', '/srv/`id`/index.js'],
    ['a backslash', '/srv/a\\b/index.js'],
    ['a newline', '/srv/a\nb/index.js'],
  ])('refuses an entry script holding %s', (_label, entryScript) => {
    const built = buildAgentMcpConfigJson({ execPath: NODE, execArgv: [], entryScript });
    expect(built.ok).toBe(false);
  });

  it('refuses an unsafe node path or runtime flag the same way', () => {
    expect(buildAgentMcpConfigJson({ execPath: "/opt/o'neil/node", execArgv: [], entryScript: ENTRY }).ok).toBe(false);
    expect(buildAgentMcpConfigJson({ execPath: NODE, execArgv: ['--import', '$(id)'], entryScript: ENTRY }).ok).toBe(
      false
    );
  });

  it('refuses when the process has no entry script', () => {
    expect(buildAgentMcpConfigJson({ execPath: NODE, execArgv: [], entryScript: undefined }).ok).toBe(false);
  });

  it('accepts a path with spaces', () => {
    const json = configFor('/srv/my app/dist/index.js');
    const argv = paneArgv(buildSpawnCommand({ mode: 'claude', sessionId: SID, mcpConfigJson: json }));
    expect(argv.slice(-2)).toEqual(['--mcp-config', json]);
  });
});

describe('the rendered claude command', () => {
  const json = configFor();

  it('carries --mcp-config once on a new launch, as one argument that survives both shells', () => {
    const cmd = buildSpawnCommand({ mode: 'claude', sessionId: SID, mcpConfigJson: json, claudeCliVersion: null });
    expect(cmd.match(/--mcp-config/g)).toHaveLength(1);
    expect(paneArgv(cmd)).toEqual(['--dangerously-skip-permissions', '--session-id', SID, '--mcp-config', json]);
  });

  it('carries it once in each arm of a resume launch (resume, then the new-session fallback)', () => {
    const resumeId = 'aaaaaaaa-1111-2222-3333-444455556666';
    const cmd = buildSpawnCommand({
      mode: 'claude',
      sessionId: SID,
      resumeSessionId: resumeId,
      mcpConfigJson: json,
      claudeCliVersion: null,
    });
    const arms = cmd.split(' || ');
    expect(arms).toHaveLength(2);
    expect(paneArgv(arms[0])).toEqual(['--dangerously-skip-permissions', '--resume', resumeId, '--mcp-config', json]);
    expect(paneArgv(arms[1])).toEqual(['--dangerously-skip-permissions', '--session-id', SID, '--mcp-config', json]);
  });

  it('is followed only by another flag, since --mcp-config takes every following positional', () => {
    const cmd = buildSpawnCommand({
      mode: 'claude',
      sessionId: SID,
      effort: 'ultracode',
      statusLineCommand: '/tmp/exporter.sh',
      mcpConfigJson: json,
      sessionName: 'my tab',
      claudeCliVersion: '99.0.0',
    });
    const argv = paneArgv(cmd);
    const at = argv.indexOf('--mcp-config');
    expect(argv[at + 1]).toBe(json);
    expect(argv.slice(at + 2)).toEqual(['--name', 'my tab']);
    expect(argv.filter((a) => a === '--settings')).toHaveLength(1);
  });

  it('is byte-identical to a launch from before the flag existed when no config is passed', () => {
    const base = { mode: 'claude' as const, sessionId: SID, effort: 'high' as const, claudeCliVersion: null };
    expect(buildSpawnCommand({ ...base, mcpConfigJson: undefined })).toBe(
      `claude --dangerously-skip-permissions --session-id "${SID}" --effort 'high'`
    );
  });

  it('never reaches a CLI whose launch template does not take it', () => {
    for (const mode of cliIds().filter((id) => !cliTakesAgentMcp(id))) {
      const cmd = buildSpawnCommand({ mode, sessionId: SID, mcpConfigJson: json } as never);
      expect(cmd, mode).not.toContain('--mcp-config');
    }
  });

  it('is taken by claude alone among the stock CLIs', () => {
    expect(cliIds().filter((id) => cliTakesAgentMcp(id))).toEqual(['claude']);
  });
});

describe('the direct-PTY fallback', () => {
  it('passes the config as one argv element ahead of --name', () => {
    const json = configFor();
    const args = buildInteractiveArgs(SID, 'auto', undefined, undefined, undefined, 'tab', '99.0.0', undefined, json);
    expect(args.slice(-4)).toEqual(['--mcp-config', json, '--name', 'tab']);
  });

  it('is unchanged without one', () => {
    expect(buildInteractiveArgs(SID, 'auto')).toEqual(['--permission-mode', 'auto', '--session-id', SID]);
  });
});

describe('the agentMcpEnabled setting, read at every launch', () => {
  type Resolve = (mode: string, remoteOrDocker: boolean) => Promise<string | undefined>;
  let resolve: Resolve;
  let savedEntry: string | undefined;

  beforeEach(() => {
    const mux = new TmuxManager() as unknown as { _resolveAgentMcpConfig: Resolve };
    resolve = mux._resolveAgentMcpConfig.bind(mux);
    mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
    savedEntry = process.argv[1];
    process.argv[1] = ENTRY;
  });
  afterEach(() => {
    process.argv[1] = savedEntry as string;
    rmSync(SETTINGS_PATH, { force: true });
    vi.restoreAllMocks();
  });

  it('attaches the server when the key is absent, naming the running entry script', async () => {
    const json = await resolve('claude', false);
    const server = JSON.parse(json as string).mcpServers.codeman;
    expect(server.command).toBe(process.execPath);
    expect(server.args.slice(-2)).toEqual([ENTRY, 'mcp']);
  });

  it('attaches nothing once the setting is stored as false, and picks a later change up', async () => {
    writeFileSync(SETTINGS_PATH, JSON.stringify({ agentMcpEnabled: false }));
    expect(await resolve('claude', false)).toBeUndefined();
    writeFileSync(SETTINGS_PATH, JSON.stringify({ agentMcpEnabled: true }));
    expect(await resolve('claude', false)).toBeTruthy();
  });

  it('attaches nothing to a remote or docker launch, or to another CLI', async () => {
    expect(await resolve('claude', true)).toBeUndefined();
    expect(await resolve('codex', false)).toBeUndefined();
  });

  it('launches without the server, and says so, when the entry path is unsafe to quote', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.argv[1] = "/srv/it's here/index.js";
    expect(await resolveAgentMcpConfigJson()).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain('without the Codeman MCP server');
  });
});
