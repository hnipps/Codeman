/**
 * @fileoverview Health and client-error routes (src/web/routes/telemetry-routes.ts).
 *
 * Uses app.inject(); the WebSocket route is exercised against a real WebServer in
 * test/telemetry-server.test.ts. Port: N/A.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerTelemetryRoutes } from '../../src/web/routes/telemetry-routes.js';
import { Telemetry } from '../../src/telemetry.js';

const POLICY = { bindHost: '127.0.0.1', allowedHosts: [] };

let dir: string;
let telemetry: Telemetry | null;
let harness: RouteTestHarness;

async function setup(opts: { withTelemetry?: boolean; authUser?: { username: string; role: 'admin' | 'user' } } = {}) {
  telemetry = opts.withTelemetry === false ? null : new Telemetry(dir, 'route-build', 1024 * 1024);
  harness = await createRouteTestHarness(
    (app, ctx) => registerTelemetryRoutes(app, { ...ctx, buildId: 'route-build', telemetry }, () => POLICY),
    { authUser: opts.authUser }
  );
}

function clientErrorLines(): Array<Record<string, unknown>> {
  return readFileSync(join(dir, 'client-errors.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const post = (payload: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  harness.app.inject({
    method: 'POST',
    url: '/api/client-errors',
    headers,
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codeman-telemetry-routes-'));
});

afterEach(async () => {
  await harness?.app.close();
  await telemetry?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/health', () => {
  it('reports ok with the build identity, uptime, session count and pid', async () => {
    await setup();
    const res = await harness.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const { version } = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'));
    expect(res.json()).toEqual({
      status: 'ok',
      version,
      buildId: 'route-build',
      uptimeS: expect.any(Number),
      sessions: 1,
      pid: process.pid,
    });
    expect(res.json().uptimeS).toBeGreaterThanOrEqual(0);
  });
});

describe('GET /api/health in multi-user mode', () => {
  afterEach(() => {
    delete process.env.CODEMAN_MULTIUSER;
  });

  it('counts only the sessions the caller may see', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    await setup({ authUser: { username: 'bob', role: 'user' } });
    const asUser = await harness.app.inject({ method: 'GET', url: '/api/health' });
    expect(asUser.json().sessions).toBe(0);
    await harness.app.close();

    await setup({ authUser: { username: 'root-admin', role: 'admin' } });
    const asAdmin = await harness.app.inject({ method: 'GET', url: '/api/health' });
    expect(asAdmin.json().sessions).toBe(1);
  });
});

describe('POST /api/client-errors', () => {
  it('appends the report to client-errors.jsonl with the build id and user agent', async () => {
    await setup();
    const res = await post(
      { message: 'x is not a function', source: '/app.js', line: 12, col: 5, stack: 'at f (app.js:12)', url: '/' },
      { 'content-type': 'application/json', 'user-agent': 'TestBrowser/1.0' }
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });

    await telemetry!.flush();
    expect(clientErrorLines()).toEqual([
      expect.objectContaining({
        buildId: 'route-build',
        ua: 'TestBrowser/1.0',
        message: 'x is not a function',
        source: '/app.js',
        line: 12,
        col: 5,
        stack: 'at f (app.js:12)',
        url: '/',
      }),
    ]);
  });

  it('takes a report with only a message, and nulls where a field is absent', async () => {
    await setup();
    expect((await post({ message: 'bare' })).statusCode).toBe(200);
    expect((await post({ message: 'nulls', source: null, line: null, stack: null })).statusCode).toBe(200);
  });

  it.each([
    ['no message', {}],
    ['an empty message', { message: '' }],
    ['a message over the cap', { message: 'm'.repeat(2001) }],
    ['a stack over the cap', { message: 'm', stack: 's'.repeat(8001) }],
    ['a line that is not a number', { message: 'm', line: 'twelve' }],
    ['a negative column', { message: 'm', col: -1 }],
    ['a message that is not a string', { message: { nested: true } }],
  ])('refuses %s with an INVALID_INPUT envelope and writes nothing', async (_name, body) => {
    await setup();
    const res = await post(body);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
    await telemetry!.flush();
    expect(() => clientErrorLines()).toThrow();
  });

  it('keeps a text/plain body raw, so a cross-site simple request cannot reach the log', async () => {
    await setup();
    const res = await post(JSON.stringify({ message: 'forged' }), { 'content-type': 'text/plain' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    await telemetry!.flush();
    expect(() => clientErrorLines()).toThrow();
  });

  it('refuses a body over 16 KiB', async () => {
    await setup();
    const res = await post({ message: 'm', stack: 's'.repeat(20 * 1024) });
    expect(res.statusCode).toBe(413);
  });

  it('answers 429 once one address has sent more than its minute budget, and keeps what it took', async () => {
    await setup();
    const statuses: number[] = [];
    for (let i = 0; i < 35; i++) statuses.push((await post({ message: `e${i}` })).statusCode);

    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(30).every((s) => s === 429)).toBe(true);
    await telemetry!.flush();
    expect(clientErrorLines()).toHaveLength(30);
  });

  it('accepts and drops the report when file telemetry is off', async () => {
    await setup({ withTelemetry: false });
    const res = await post({ message: 'nobody is listening' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
  });
});
