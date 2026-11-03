/**
 * POST /api/deploy/role and the role on GET /api/health, through a real WebServer (port 0,
 * a password set): the normal auth hook, the local-only rule, validation, idempotence and
 * the transitions the role machine refuses.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebServer } from '../../src/web/server.js';

const PASSWORD = 'deploy-role-pass';
const AUTH = { authorization: `Basic ${Buffer.from(`admin:${PASSWORD}`).toString('base64')}` };

let server: WebServer;

function setRole(role: unknown, headers: Record<string, string> = AUTH) {
  return fetch(`http://127.0.0.1:${server.boundPort}/api/deploy/role`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ role }),
  });
}

async function healthRole(): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${server.boundPort}/api/health`, { headers: AUTH });
  return (await res.json()).data.deployRole;
}

async function boot(role: string | undefined): Promise<void> {
  process.env.CODEMAN_PASSWORD = PASSWORD;
  if (role) process.env.CODEMAN_DEPLOY_ROLE = role;
  else delete process.env.CODEMAN_DEPLOY_ROLE;
  server = new WebServer(0, false, true);
  await server.start();
}

async function shutdown(): Promise<void> {
  await server.stop();
  delete process.env.CODEMAN_PASSWORD;
  delete process.env.CODEMAN_DEPLOY_ROLE;
}

describe('a colour started with no role', () => {
  beforeAll(() => boot(undefined));
  afterAll(shutdown);

  it('is live, as Codeman was before deploys had colours', async () => {
    expect(await healthRole()).toBe('live');
  });

  it('is behind the normal auth', async () => {
    const res = await setRole('retired', {});
    expect(res.status).toBe(401);
    expect(await healthRole()).toBe('live');
  });

  it('refuses a non-loopback caller even with valid credentials', async () => {
    const app = (server as unknown as { app: FastifyInstance }).app;
    const res = await app.inject({
      method: 'POST',
      url: '/api/deploy/role',
      remoteAddress: '192.0.2.10',
      headers: { 'content-type': 'application/json', ...AUTH },
      payload: { role: 'retired' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ success: false, errorCode: 'FORBIDDEN' });
    expect(await healthRole()).toBe('live');
  });

  it('refuses a request that came through a proxy, which also connects from loopback', async () => {
    const res = await setRole('retired', { ...AUTH, 'x-forwarded-for': '198.51.100.7' });
    expect(res.status).toBe(403);
    expect(await healthRole()).toBe('live');
  });

  it('rejects a role the endpoint does not move to', async () => {
    const res = await setRole('candidate');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
  });

  it('answers a request for the current role as a no-op', async () => {
    const res = await setRole('live');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { role: 'live', previous: 'live' } });
  });

  it('retires, repeats the retire as a no-op, then reinstates', async () => {
    const retired = await setRole('retired');
    expect(await retired.json()).toEqual({ success: true, data: { role: 'retired', previous: 'live' } });
    expect(await healthRole()).toBe('retired');

    const again = await setRole('retired');
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ success: true, data: { role: 'retired', previous: 'retired' } });

    const reinstated = await setRole('live');
    expect(await reinstated.json()).toEqual({ success: true, data: { role: 'live', previous: 'retired' } });
    expect(await healthRole()).toBe('live');
  });
});

describe('a candidate', () => {
  beforeAll(() => boot('candidate'));
  afterAll(shutdown);

  it('reports its role on /api/health', async () => {
    expect(await healthRole()).toBe('candidate');
  });

  it('cannot be retired before it was ever live: 409, role unchanged', async () => {
    const res = await setRole('retired');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      success: false,
      errorCode: 'CONFLICT',
      error: 'a candidate colour cannot become retired',
    });
    expect(await healthRole()).toBe('candidate');
  });
});
