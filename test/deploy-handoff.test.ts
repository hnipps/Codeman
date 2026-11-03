/**
 * deploy/handoff.mjs end to end: the real script, run as a child process, against fake
 * colours that speak POST /api/deploy/role and move through the real role machine. A colour
 * can be told to fail a request after it changed role or before, the two ways a real one
 * fails, so the tests can check where each colour ends up, not only what was asked.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planRoleChange, type DeployRole } from '../src/deploy-role.js';

const SCRIPT = resolve(import.meta.dirname, '../deploy/handoff.mjs');
const PASSWORD = 'handoff-pass';

interface Report {
  ok: boolean;
  steps: Array<{ name: string; ok: boolean; detail: string }>;
}

interface Colour {
  port: number;
  role: DeployRole;
  /** Roles asked for, in order. */
  asked: string[];
  authorizations: Array<string | undefined>;
  close(): Promise<void>;
}

type Failure = { status: number; after: 'change' | 'refuse' };

const colours: Colour[] = [];

afterEach(async () => {
  await Promise.all(colours.splice(0).map((c) => c.close()));
});

async function fakeColour(
  role: DeployRole,
  options: { noEndpoint?: boolean; fail?: Partial<Record<DeployRole, Failure>> } = {}
): Promise<Colour> {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (options.noEndpoint || req.url !== '/api/deploy/role') {
        return send(404, { success: false, error: 'Not Found', errorCode: 'NOT_FOUND' });
      }
      const target = JSON.parse(raw).role as DeployRole;
      colour.asked.push(target);
      colour.authorizations.push(req.headers.authorization);
      const previous = colour.role;
      const change = planRoleChange(previous, target);
      const failure = options.fail?.[target];
      if (failure?.after === 'refuse') return send(failure.status, { success: false, error: 'boom' });
      if (change.kind === 'refused') return send(409, { success: false, error: change.reason, errorCode: 'CONFLICT' });
      colour.role = target;
      if (failure) return send(failure.status, { success: false, error: 'boom after changing role' });
      send(200, { success: true, data: { role: target, previous } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const colour: Colour = {
    port: (server.address() as AddressInfo).port,
    role,
    asked: [],
    authorizations: [],
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  colours.push(colour);
  return colour;
}

async function closedPort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

function handoff(args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; report: Report }>((done, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { PATH: process.env.PATH, CODEMAN_PASSWORD: PASSWORD } as NodeJS.ProcessEnv,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      const lines = stdout.split('\n').filter(Boolean);
      done({ code, stdout, stderr, report: JSON.parse(lines[lines.length - 1]) });
    });
  });
}

const stepNames = (report: Report) => report.steps.map((s) => [s.name, s.ok]);

describe('deploy/handoff.mjs', () => {
  it('retires the old colour, then promotes the new one: one JSON line, exit 0', async () => {
    const old = await fakeColour('live');
    const next = await fakeColour('candidate');
    const { code, stdout, report } = await handoff(['--new-port', `${next.port}`, '--old-port', `${old.port}`]);

    expect(code).toBe(0);
    expect(stdout.trim().split('\n')).toHaveLength(1);
    expect(report.ok).toBe(true);
    expect(stepNames(report)).toEqual([
      ['retire-old', true],
      ['promote-new', true],
    ]);
    expect([old.role, next.role]).toEqual(['retired', 'live']);
    const basic = `Basic ${Buffer.from(`admin:${PASSWORD}`).toString('base64')}`;
    expect([...old.authorizations, ...next.authorizations]).toEqual([basic, basic]);
  });

  it('only promotes when no old colour is running', async () => {
    const next = await fakeColour('candidate');
    const { code, report } = await handoff(['--new-port', `${next.port}`]);
    expect(code).toBe(0);
    expect(stepNames(report)).toEqual([['promote-new', true]]);
    expect(next.role).toBe('live');
  });

  it('carries on past an older release that has no role endpoint, with a warning', async () => {
    const old = await fakeColour('live', { noEndpoint: true });
    const next = await fakeColour('candidate');
    const { code, stderr, report } = await handoff(['--new-port', `${next.port}`, '--old-port', `${old.port}`]);

    expect(code).toBe(0);
    expect(report.steps[0]).toMatchObject({ name: 'retire-old', ok: true, detail: expect.stringContaining('skipped') });
    expect(stderr).toContain(`port ${old.port} has no /api/deploy/role`);
    expect(next.role).toBe('live');
  });

  it('puts the old colour back to live when its retire fails, and never touches the new one', async () => {
    const old = await fakeColour('live', { fail: { retired: { status: 500, after: 'change' } } });
    const next = await fakeColour('candidate');
    const { code, report } = await handoff(['--new-port', `${next.port}`, '--old-port', `${old.port}`]);

    expect(code).toBe(1);
    expect(stepNames(report)).toEqual([
      ['retire-old', false],
      ['reinstate-old', true],
    ]);
    expect(old.role).toBe('live');
    expect(next.asked).toEqual([]);
  });

  it('leaves an old colour that refused the retire exactly as it was', async () => {
    const old = await fakeColour('candidate');
    const next = await fakeColour('candidate');
    const { code, report } = await handoff(['--new-port', `${next.port}`, '--old-port', `${old.port}`]);

    expect(code).toBe(1);
    expect(stepNames(report)).toEqual([['retire-old', false]]);
    expect(old.asked).toEqual(['retired']);
    expect(old.role).toBe('candidate');
  });

  it('when the promotion fails after the new colour went live, retires it and reinstates the old one', async () => {
    const old = await fakeColour('live');
    const next = await fakeColour('candidate', { fail: { live: { status: 500, after: 'change' } } });
    const { code, report } = await handoff(['--new-port', `${next.port}`, '--old-port', `${old.port}`]);

    expect(code).toBe(1);
    expect(stepNames(report)).toEqual([
      ['retire-old', true],
      ['promote-new', false],
      ['retire-new', true],
      ['reinstate-old', true],
    ]);
    expect([old.role, next.role]).toEqual(['live', 'retired']);
  });

  it('when the promotion fails before any change, the new colour stays a candidate and the old one is live', async () => {
    const old = await fakeColour('live');
    const next = await fakeColour('candidate', { fail: { live: { status: 500, after: 'refuse' } } });
    const { code, report } = await handoff(['--new-port', `${next.port}`, '--old-port', `${old.port}`]);

    expect(code).toBe(1);
    expect(report.steps.find((s) => s.name === 'retire-new')).toMatchObject({
      ok: true,
      detail: expect.stringContaining('still a candidate'),
    });
    expect([old.role, next.role]).toEqual(['live', 'candidate']);
  });

  it('reinstates the old colour when nothing answers on the new port', async () => {
    const old = await fakeColour('live');
    const { code, report } = await handoff(['--new-port', `${await closedPort()}`, '--old-port', `${old.port}`]);

    expect(code).toBe(1);
    expect(report.steps.find((s) => s.name === 'promote-new')).toMatchObject({ ok: false });
    expect(old.asked).toEqual(['retired', 'live']);
    expect(old.role).toBe('live');
  });

  it('--undo after a completed handoff retires the new colour and puts the old one back to live', async () => {
    const old = await fakeColour('retired');
    const next = await fakeColour('live');
    const { code, report } = await handoff(['--undo', '--old-port', `${old.port}`, '--new-port', `${next.port}`]);

    expect(code).toBe(0);
    expect(stepNames(report)).toEqual([
      ['retire-new', true],
      ['reinstate-old', true],
    ]);
    expect([old.role, next.role]).toEqual(['live', 'retired']);
  });

  it('--undo still reinstates the old colour when the new one is already gone', async () => {
    const old = await fakeColour('retired');
    const { code, report } = await handoff([
      '--undo',
      '--old-port',
      `${old.port}`,
      '--new-port',
      `${await closedPort()}`,
    ]);
    expect(code).toBe(0);
    expect(old.role).toBe('live');
    expect(report.steps.at(-1)).toMatchObject({ name: 'reinstate-old', ok: true });
  });

  it.each([
    [['--undo', '--new-port', '4000'], '--undo needs --old-port'],
    [[], '--new-port <1-65535> is required'],
    [['--new-port', '4000', '--old-port', '4000'], '--old-port and --new-port must differ'],
  ])('exits 2 with a JSON line on bad arguments %j', async (args, message) => {
    const { code, report } = await handoff(args);
    expect(code).toBe(2);
    expect(report).toEqual({ ok: false, steps: [{ name: 'args', ok: false, detail: message }] });
  });
});
