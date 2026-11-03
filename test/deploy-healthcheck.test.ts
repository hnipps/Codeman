/**
 * deploy/healthcheck.mjs end to end: the real script, run as a child process, against
 * a real WebServer on port 0 with a password and a build id.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebServer } from '../src/web/server.js';

const SCRIPT = resolve(import.meta.dirname, '../deploy/healthcheck.mjs');
const PASSWORD = 'hc-pass';
const BUILD_ID = 'hc-build-1';

interface Report {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

let server: WebServer;
let workingDir: string;
let sessionId: string;

// The server enforces CODEMAN_PASSWORD, so a passing run also proves the script sent the credentials.
function runCheck(args: string[], env: Record<string, string | undefined> = { CODEMAN_PASSWORD: PASSWORD }) {
  return new Promise<{ code: number | null; stdout: string; report: Report }>((resolveRun, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { PATH: process.env.PATH, ...env } as NodeJS.ProcessEnv,
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('error', reject);
    child.on('close', (code) => {
      const lines = stdout.split('\n').filter(Boolean);
      resolveRun({ code, stdout, report: JSON.parse(lines[lines.length - 1]) });
    });
  });
}

const byName = (report: Report, name: string) => report.checks.find((c) => c.name === name);

async function closedPort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

beforeAll(async () => {
  process.env.CODEMAN_PASSWORD = PASSWORD;
  process.env.CODEMAN_BUILD_ID = BUILD_ID;
  workingDir = mkdtempSync(join(tmpdir(), 'codeman-healthcheck-'));
  server = new WebServer(0, false, true);
  await server.start();
  const res = await fetch(`http://127.0.0.1:${server.boundPort}/api/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from(`admin:${PASSWORD}`).toString('base64')}`,
    },
    body: JSON.stringify({ workingDir, mode: 'shell' }),
  });
  sessionId = (await res.json()).data.session.id;
});

afterAll(async () => {
  await server.stop();
  delete process.env.CODEMAN_PASSWORD;
  delete process.env.CODEMAN_BUILD_ID;
  rmSync(workingDir, { recursive: true, force: true });
});

describe('deploy/healthcheck.mjs', () => {
  it('passes against a healthy server on the expected build, as one JSON line, exit 0', async () => {
    const { code, stdout, report } = await runCheck(['--port', String(server.boundPort), '--expect-build', BUILD_ID]);
    expect(code).toBe(0);
    expect(stdout.trim().split('\n')).toHaveLength(1);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => [c.name, c.ok])).toEqual([
      ['health', true],
      ['ws', true],
    ]);
    expect(byName(report, 'health')!.detail).toContain(BUILD_ID);
  });

  it('passes without --expect-build and finds an expected live session', async () => {
    const { code, report } = await runCheck(['--port', String(server.boundPort), '--expect-sessions', sessionId]);
    expect(code).toBe(0);
    expect(byName(report, 'sessions')).toMatchObject({ ok: true });
  });

  it('fails, exit 1, when the build is not the expected one', async () => {
    const { code, report } = await runCheck(['--port', String(server.boundPort), '--expect-build', 'some-other-build']);
    expect(code).toBe(1);
    expect(report.ok).toBe(false);
    expect(byName(report, 'health')).toMatchObject({ ok: false });
    expect(byName(report, 'health')!.detail).toContain(`build is ${BUILD_ID}, expected some-other-build`);
    expect(byName(report, 'ws')).toMatchObject({ ok: false });
  });

  it('fails when an expected session is missing and names it', async () => {
    const { code, report } = await runCheck([
      '--port',
      String(server.boundPort),
      '--expect-sessions',
      `${sessionId},gone-session`,
    ]);
    expect(code).toBe(1);
    expect(byName(report, 'sessions')).toMatchObject({ ok: false, detail: 'missing gone-session' });
    expect(byName(report, 'health')).toMatchObject({ ok: true });
  });

  it('fails when nothing is listening', async () => {
    const { code, report } = await runCheck(['--port', String(await closedPort())]);
    expect(code).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.checks.every((c) => !c.ok)).toBe(true);
  });

  it('exits 2 with a JSON line when --port is missing', async () => {
    const { code, report } = await runCheck([]);
    expect(code).toBe(2);
    expect(report).toMatchObject({ ok: false, checks: [{ name: 'args', ok: false }] });
  });
});
