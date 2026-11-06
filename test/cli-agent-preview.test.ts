/**
 * @fileoverview `codeman agent preview add|ls|rm|logs`: each verb against a recording
 * fake API, the guard outside a session, the help text, and the whole cycle against a
 * real server with a real preview process.
 */

import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  EXIT,
  agentPreviewAdd,
  agentPreviewLogs,
  agentPreviewLs,
  agentPreviewRm,
  httpRequest,
  registerAgentCommands,
  type AgentDeps,
  type ApiResponse,
  type RequestOptions,
} from '../src/cli-agent.js';
import { readProcSnapshot } from '../src/preview-proc.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { WebServer } from '../src/web/server.js';

const SELF = '058ee7b5-b2aa-4c33-8cc1-e900eb0b28af';
const PREVIEWS = `/api/v1/sessions/${SELF}/previews`;

function fakeDeps(
  answer: (options: RequestOptions) => ApiResponse,
  json = false
): AgentDeps & { calls: RequestOptions[]; out: string[]; err: string[] } {
  const calls: RequestOptions[] = [];
  const out: string[] = [];
  const err: string[] = [];
  return {
    ctx: { apiUrl: 'http://127.0.0.1:1', selfId: SELF },
    calls,
    out,
    err,
    json,
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    request: async (_c, options) => {
      calls.push(options);
      return answer(options);
    },
  };
}

const ok = (data: unknown): ApiResponse => ({ status: 200, json: { success: true, data }, text: '' });
const apiError = (status: number, errorCode: string, error: string): ApiResponse => ({
  status,
  json: { success: false, error, errorCode },
  text: '',
});

const preview = (overrides: Record<string, unknown> = {}) => ({
  webviewId: 'wv-1',
  sessionId: SELF,
  name: 'web',
  cmd: 'python3 -m http.server {port}',
  port: 41234,
  state: 'running',
  ...overrides,
});

describe('preview add', () => {
  it('PUTs the command for this session and prints name, state, port and url', async () => {
    const deps = fakeDeps(() => ok(preview({ url: '/webview/cap1/', ready: true })));
    expect(await agentPreviewAdd(deps, { name: 'web', cmd: 'python3 -m http.server {port}' })).toBe(EXIT.ok);
    expect(deps.calls).toEqual([
      expect.objectContaining({
        method: 'PUT',
        path: `${PREVIEWS}/web`,
        body: { cmd: 'python3 -m http.server {port}' },
      }),
    ]);
    expect(deps.out).toEqual(['web  running  :41234  /webview/cap1/']);
    expect(deps.err).toEqual([]);
  });

  it('--json prints the server data, port and url included', async () => {
    const data = preview({ url: '/webview/cap1/', ready: true });
    const deps = fakeDeps(() => ok(data), true);
    expect(await agentPreviewAdd(deps, { name: 'web', cmd: 'x {port}' })).toBe(EXIT.ok);
    const parsed = JSON.parse(deps.out.join('\n'));
    expect(parsed).toEqual(data);
    expect(parsed.port).toBe(41234);
    expect(parsed.url).toBe('/webview/cap1/');
  });

  it('says when a replacement left the old server listening', async () => {
    const deps = fakeDeps(() =>
      ok(preview({ url: '/webview/cap1/', ready: true, leftRunning: { port: 41000, pids: [77] } }))
    );
    expect(await agentPreviewAdd(deps, { name: 'web', cmd: 'x {port}' })).toBe(EXIT.ok);
    expect(deps.err.join('\n')).toMatch(/old server still listens on :41000 \(pids 77\).*could not stop it/);
  });

  it('exits 2 when the port never answered and 3 when the command exited', async () => {
    const slow = fakeDeps(() => ok(preview({ url: '/webview/c/', ready: false })));
    expect(await agentPreviewAdd(slow, { name: 'web', cmd: 'x' })).toBe(EXIT.timeout);
    expect(slow.err.join('\n')).toContain('preview logs web');

    const exited = fakeDeps(() => ok(preview({ url: '/webview/c/', ready: false, state: 'exited' })));
    expect(await agentPreviewAdd(exited, { name: 'web', cmd: 'x' })).toBe(EXIT.dead);
    expect(exited.out).toEqual(['web  exited  :41234  /webview/c/']);
    expect(exited.err.join('\n')).toMatch(/command exited.*preview logs web/);
  });

  it('names a server that outlived its exited command', async () => {
    const deps = fakeDeps(() =>
      ok(preview({ url: '/webview/c/', state: 'exited', stillListening: { port: 41234, pids: [] } }))
    );
    expect(await agentPreviewAdd(deps, { name: 'web', cmd: 'setsid x &' })).toBe(EXIT.dead);
    expect(deps.err.join('\n')).toMatch(/still listens on :41234 \(another user's process\)/);
  });

  it('maps a 400 to exit 1 with the server message', async () => {
    const deps = fakeDeps(() =>
      apiError(400, 'INVALID_INPUT', 'Previews run on this host, and w1 is a Docker session')
    );
    expect(await agentPreviewAdd(deps, { name: 'web', cmd: 'x' })).toBe(EXIT.error);
    expect(deps.err.join('\n')).toContain(
      'INVALID_INPUT: Previews run on this host, and w1 is a Docker session (HTTP 400)'
    );
  });

  it('a 409 says nothing was started', async () => {
    const deps = fakeDeps(() => apiError(409, 'CONFLICT', 'This server is the standby deploy colour'), true);
    expect(await agentPreviewAdd(deps, { name: 'web', cmd: 'x' })).toBe(EXIT.error);
    expect(JSON.parse(deps.out[0])).toEqual({
      success: false,
      error: 'CONFLICT: This server is the standby deploy colour (HTTP 409) Nothing was started.',
    });
  });

  it('refuses an empty command before any request', async () => {
    const deps = fakeDeps(() => ok({}));
    expect(await agentPreviewAdd(deps, { name: 'web', cmd: '  ' })).toBe(EXIT.refused);
    expect(deps.calls).toEqual([]);
  });
});

describe('preview ls', () => {
  const list = {
    previews: [preview(), preview({ webviewId: 'wv-2', name: 'api', port: 41300, state: 'exited' })],
    leftRunning: [{ port: 41999, pids: [12, 13], sessionId: SELF, name: 'old', since: 1 }],
  };
  const answer = (o: RequestOptions) => {
    if (o.path === PREVIEWS) return ok(list);
    const name = o.path.slice(PREVIEWS.length + 1);
    const p = list.previews.find((x) => x.name === name);
    return p ? ok({ ...p, url: `/webview/cap-${name}/` }) : apiError(404, 'NOT_FOUND', 'Preview not found');
  };

  it('lists every preview with state, port and url, and the servers left running', async () => {
    const deps = fakeDeps(answer);
    expect(await agentPreviewLs(deps)).toBe(EXIT.ok);
    expect(deps.out).toEqual([
      [
        'NAME  STATE    PORT    URL',
        'web   running  :41234  /webview/cap-web/',
        'api   exited   :41300  /webview/cap-api/',
      ].join('\n'),
    ]);
    expect(deps.err.join('\n')).toMatch(/old: a server still listens on :41999 \(pids 12 13\)/);
    expect(deps.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('--json carries previews with url and leftRunning', async () => {
    const deps = fakeDeps(answer, true);
    expect(await agentPreviewLs(deps)).toBe(EXIT.ok);
    const parsed = JSON.parse(deps.out.join('\n'));
    expect(parsed.previews.map((p: { url: string }) => p.url)).toEqual(['/webview/cap-web/', '/webview/cap-api/']);
    expect(parsed.leftRunning).toEqual(list.leftRunning);
  });

  it('keeps a preview deleted between the list and its GET, without a url', async () => {
    const deps = fakeDeps((o) => (o.path === PREVIEWS ? ok(list) : apiError(404, 'NOT_FOUND', 'Preview not found')));
    expect(await agentPreviewLs(deps)).toBe(EXIT.ok);
    expect(deps.out[0]).toContain('web   running  :41234');
  });

  it('says so when there is none', async () => {
    const deps = fakeDeps(() => ok({ previews: [], leftRunning: [] }));
    expect(await agentPreviewLs(deps)).toBe(EXIT.ok);
    expect(deps.out).toEqual(['(no previews)']);
  });
});

describe('preview rm', () => {
  it('DELETEs the preview and confirms', async () => {
    const deps = fakeDeps(() => ok({ name: 'web', webviewId: 'wv-1' }));
    expect(await agentPreviewRm(deps, { name: 'web' })).toBe(EXIT.ok);
    expect(deps.calls).toEqual([expect.objectContaining({ method: 'DELETE', path: `${PREVIEWS}/web` })]);
    expect(deps.out.join('\n')).toContain('removed web');
  });

  it('exits 1 and names the listener when the server outlived the stop', async () => {
    const deps = fakeDeps(() => ok({ name: 'web', webviewId: 'wv-1', leftRunning: { port: 41234, pids: [9] } }));
    expect(await agentPreviewRm(deps, { name: 'web' })).toBe(EXIT.error);
    expect(deps.err.join('\n')).toMatch(/removed web, but a server still listens on :41234 \(pids 9\)/);
  });

  it('a 409 says the preview was kept', async () => {
    const deps = fakeDeps(() => apiError(409, 'CONFLICT', 'This server is the standby deploy colour'));
    expect(await agentPreviewRm(deps, { name: 'web' })).toBe(EXIT.error);
    expect(deps.err.join('\n')).toContain('Nothing was stopped; the preview and its tab are kept.');
  });

  it('a 404 is exit 1', async () => {
    const deps = fakeDeps(() => apiError(404, 'NOT_FOUND', 'Preview not found'));
    expect(await agentPreviewRm(deps, { name: 'nope' })).toBe(EXIT.error);
  });
});

describe('preview logs', () => {
  it('GETs the log route with the tail and prints the text', async () => {
    const deps = fakeDeps(() =>
      ok({ text: 'Serving HTTP on 0.0.0.0\n\u001b[32mGET /\u001b[0m 200\n', size: 40, state: 'running' })
    );
    expect(await agentPreviewLogs(deps, { name: 'web', tail: 500 })).toBe(EXIT.ok);
    expect(deps.calls).toEqual([
      expect.objectContaining({ method: 'GET', path: `${PREVIEWS}/web/log`, query: { tail: 500 } }),
    ]);
    expect(deps.out).toEqual(['Serving HTTP on 0.0.0.0\nGET / 200']);
    expect(deps.err.join('\n')).toContain('web is running; log is 40 bytes');
  });

  it('--json prints the log as stored', async () => {
    const data = { text: '\u001b[32mok\u001b[0m\n', size: 12, state: 'exited' };
    const deps = fakeDeps(() => ok(data), true);
    expect(await agentPreviewLogs(deps, { name: 'web' })).toBe(EXIT.ok);
    expect(JSON.parse(deps.out.join('\n'))).toEqual(data);
  });
});

describe('the commands', () => {
  it('agent --help lists preview with its four verbs', () => {
    const agent = registerAgentCommands(new Command());
    const preview = agent.commands.find((c) => c.name() === 'preview')!;
    expect(agent.helpInformation().replace(/\s+/g, ' ')).toMatch(/ preview Serve [^]*?: add, ls, rm, logs\./);
    expect(preview.commands.map((c) => c.name())).toEqual(['add', 'ls', 'rm', 'logs']);
    const cmd = preview.commands[0].options.find((o) => o.long === '--cmd')!;
    expect(cmd.description).toMatch(/never daemonize/);
    expect(preview.commands[0].description()).toMatch(/\{port\} replaced by a free port/);
  });

  it('outside a session it exits 4 naming CODEMAN_SESSION_ID', async () => {
    const saved = { ...process.env };
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: string) => void errors.push(line));
    try {
      delete process.env.CODEMAN_MUX;
      delete process.env.CODEMAN_API_URL;
      delete process.env.CODEMAN_SESSION_ID;
      const program = new Command();
      program.exitOverride();
      registerAgentCommands(program);
      await program.parseAsync(['node', 'codeman', 'agent', 'preview', 'add', 'web', '--cmd', 'x {port}']);
      expect(process.exitCode).toBe(EXIT.refused);
      expect(errors.join('\n')).toContain('CODEMAN_SESSION_ID');
    } finally {
      process.env = saved;
      process.exitCode = undefined;
      spy.mockRestore();
    }
  });
});

describe('against a real server', () => {
  const SERVER = `${process.execPath} -e "require('http').createServer((q,s)=>s.end('hello')).listen(Number(process.argv[1]),()=>console.log('listening on '+process.env.PORT))" {port}`;
  let server: WebServer;
  let dataDir: string;
  let workDir: string;
  let savedDataDir: string | undefined;
  let sessionId: string;

  const portOpen = (port: number) =>
    new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });

  const liveDeps = (json = false) => {
    const out: string[] = [];
    const err: string[] = [];
    const deps: AgentDeps = {
      ctx: { apiUrl: `http://127.0.0.1:${server.boundPort}`, selfId: sessionId },
      request: httpRequest,
      json,
      io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    };
    return { deps, out, err };
  };

  beforeAll(async () => {
    vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-preview-data-'));
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-preview-work-'));
    savedDataDir = process.env.CODEMAN_DATA_DIR;
    process.env.CODEMAN_DATA_DIR = dataDir;
    server = new WebServer(0, false, true);
    await server.start();
    const res = await fetch(`http://127.0.0.1:${server.boundPort}/api/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: workDir, name: 'cli-preview' }),
    });
    const body = await res.json();
    sessionId = body.data.id ?? body.data.session?.id;
  });

  afterAll(async () => {
    for (const p of server?.previews.list() ?? []) await server.previews.remove(p.webviewId);
    await server?.stop();
    for (const entry of readProcSnapshot().values()) {
      if (entry.zombie || entry.previewOwner !== dataDir) continue;
      try {
        process.kill(entry.pid, 'SIGKILL');
      } catch {}
    }
    if (savedDataDir === undefined) delete process.env.CODEMAN_DATA_DIR;
    else process.env.CODEMAN_DATA_DIR = savedDataDir;
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('add serves the page, ls and logs show it, rm frees the port', async () => {
    const add = liveDeps();
    expect(await agentPreviewAdd(add.deps, { name: 'web', cmd: SERVER })).toBe(EXIT.ok);
    const match = add.out[0].match(/^web {2}running {2}:(\d+) {2}(\/webview\/[^/]+\/)$/);
    expect(match, add.out[0]).not.toBeNull();
    const port = Number(match![1]);
    const page = await fetch(`http://127.0.0.1:${server.boundPort}${match![2]}`);
    expect(await page.text()).toBe('hello');

    const ls = liveDeps(true);
    expect(await agentPreviewLs(ls.deps)).toBe(EXIT.ok);
    const listed = JSON.parse(ls.out.join('\n'));
    expect(listed.previews.map((p: { name: string; port: number; url: string }) => [p.name, p.port, p.url])).toEqual([
      ['web', port, match![2]],
    ]);

    const logs = liveDeps();
    expect(await agentPreviewLogs(logs.deps, { name: 'web' })).toBe(EXIT.ok);
    expect(logs.out.join('\n')).toContain(`listening on ${port}`);

    const rm = liveDeps();
    expect(await agentPreviewRm(rm.deps, { name: 'web' })).toBe(EXIT.ok);
    expect(await portOpen(port)).toBe(false);
    const after = liveDeps();
    expect(await agentPreviewLs(after.deps)).toBe(EXIT.ok);
    expect(after.out).toEqual(['(no previews)']);
  });
});
