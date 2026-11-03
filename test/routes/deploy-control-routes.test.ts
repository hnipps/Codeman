/**
 * GET /api/deploy/overview and POST /api/deploy/rollback through a real WebServer (port 0, a password
 * set), with a fake supervisor command: an executable script that prints canned status JSON, or
 * `queued request <id>` and then keeps running or exits.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { deployRole } from '../../src/deploy-role.js';
import { WebServer } from '../../src/web/server.js';

const PASSWORD = 'deploy-control-pass';
const AUTH = { authorization: `Basic ${Buffer.from(`admin:${PASSWORD}`).toString('base64')}` };
const SHA = 'c'.repeat(40);

const STATUS = {
  live: { colour: 'blue', sha: SHA, port: 4001, since: '2026-01-01T00:00:00.000Z' },
  releases: [{ sha: SHA, builtAt: '2026-01-01T00:00:00.000Z' }],
  deploys: [
    {
      id: 'd1',
      action: 'deploy',
      sha: SHA,
      outcome: 'success',
      failedStep: null,
      error: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:05.000Z',
      port: 4002,
      log: '/srv/log/d1.log',
    },
  ],
  lock: null,
};

const FAKE_CLI = `#!/usr/bin/env node
const fs = require('fs');
const [cmd, sub, target] = process.argv.slice(2);
const dir = process.env.FAKE_DIR;
if (cmd === 'status') {
  process.stdout.write(fs.readFileSync(dir + '/status.json', 'utf8'));
} else if (cmd === 'request') {
  fs.writeFileSync(dir + '/argv.json', JSON.stringify(process.argv.slice(2)));
  fs.writeFileSync(dir + '/pid', String(process.pid));
  if (process.env.FAKE_MODE === 'exit-early') {
    process.stderr.write('starting\\nno such release\\n');
    process.exit(1);
  }
  process.stdout.write('queued request req-42\\n');
  setInterval(() => process.stdout.write('log line\\n'), 100);
}
`;

let server: WebServer;
let dir: string;
const base = () => `http://127.0.0.1:${server.boundPort}`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function rollback(body: unknown) {
  return fetch(`${base()}/api/deploy/rollback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH },
    body: JSON.stringify(body),
  });
}

function overview() {
  return fetch(`${base()}/api/deploy/overview`, { headers: AUTH });
}

function killFakeChild(): void {
  const pidFile = join(dir, 'pid');
  if (!existsSync(pidFile)) return;
  try {
    process.kill(Number(readFileSync(pidFile, 'utf8')));
  } catch {
    /* already gone */
  }
  rmSync(pidFile);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fake-supervisor-'));
  const cli = join(dir, 'cli');
  writeFileSync(cli, FAKE_CLI);
  chmodSync(cli, 0o755);
  writeFileSync(join(dir, 'status.json'), JSON.stringify(STATUS));
  process.env.FAKE_DIR = dir;
  process.env.CODEMAN_SUPERVISOR_CLI = cli;
  process.env.CODEMAN_PASSWORD = PASSWORD;
  deployRole.initFromEnv({});
  server = new WebServer(0, false, true);
  await server.start();
});

afterEach(() => {
  killFakeChild();
  delete process.env.FAKE_MODE;
  deployRole.initFromEnv({});
  process.env.CODEMAN_SUPERVISOR_CLI = join(dir, 'cli');
});

afterAll(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
  for (const name of ['FAKE_DIR', 'FAKE_MODE', 'CODEMAN_SUPERVISOR_CLI', 'CODEMAN_PASSWORD']) delete process.env[name];
});

describe('GET /api/deploy/overview', () => {
  it('answers with the parsed overview and nothing the browser must not see', async () => {
    const res = await overview();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).data).toEqual({
      configured: true,
      live: { sha: SHA, since: '2026-01-01T00:00:00.000Z' },
      releases: [{ sha: SHA, builtAt: '2026-01-01T00:00:00.000Z', live: true }],
      recent: [
        {
          id: 'd1',
          action: 'deploy',
          sha: SHA,
          outcome: 'success',
          failedStep: null,
          startedAt: '2026-01-01T00:00:00.000Z',
          finishedAt: '2026-01-01T00:00:05.000Z',
        },
      ],
      busy: false,
    });
    expect(text).not.toMatch(/4001|4002|\/srv|blue/);
  });

  it('says not configured when no command is named', async () => {
    delete process.env.CODEMAN_SUPERVISOR_CLI;
    const res = await overview();
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ configured: false });
  });

  it('is behind the normal auth', async () => {
    expect((await fetch(`${base()}/api/deploy/overview`)).status).toBe(401);
  });

  it('answers a short error, without paths, when the command fails', async () => {
    writeFileSync(join(dir, 'status.json'), 'not json');
    const res = await overview();
    writeFileSync(join(dir, 'status.json'), JSON.stringify(STATUS));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).not.toMatch(/\/|at /);
  });
});

describe('POST /api/deploy/rollback', () => {
  it.each([{}, { target: 'latest' }, { target: 'ABCDEF1' }, { target: 'abc12' }, { target: 'previous', extra: 1 }])(
    'refuses the invalid body %j with 400',
    async (body) => {
      expect((await rollback(body)).status).toBe(400);
    }
  );

  it('is 404 when not configured', async () => {
    delete process.env.CODEMAN_SUPERVISOR_CLI;
    expect((await rollback({ target: 'previous' })).status).toBe(404);
  });

  it.each(['candidate', 'retired'] as const)('is 409 naming the role on a %s colour', async (role) => {
    deployRole.initFromEnv({ CODEMAN_DEPLOY_ROLE: 'candidate' });
    if (role === 'retired') {
      deployRole.enter('live');
      deployRole.enter('retired');
    }
    const res = await rollback({ target: 'previous' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain(role);
    expect(existsSync(join(dir, 'argv.json'))).toBe(false);
  });

  it('answers 202 with the request id while the supervisor child is still running', async () => {
    const res = await rollback({ target: SHA.slice(0, 12) });
    expect(res.status).toBe(202);
    expect((await res.json()).data).toEqual({ requestId: 'req-42' });
    expect(JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8'))).toEqual(['request', 'rollback', SHA.slice(0, 12)]);
    expect(alive(Number(readFileSync(join(dir, 'pid'), 'utf8')))).toBe(true);
  });

  it('answers with the last stderr line when the child exits before queuing', async () => {
    process.env.FAKE_MODE = 'exit-early';
    const res = await rollback({ target: 'previous' });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('no such release');
  });
});
