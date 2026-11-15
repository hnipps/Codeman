/**
 * The server's own principal (src/web/internal-principal.ts), which canvas routines use to start a run through the
 * task route: only this process can mint one, it expires, a forged or client-made header is ignored by the auth hook,
 * and the webview proxy never forwards it.
 */
import fastifyCookie from '@fastify/cookie';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INTERNAL_PRINCIPAL_HEADER,
  INTERNAL_PRINCIPAL_TTL_MS,
  internalHeaders,
  verifyInternalPrincipal,
} from '../src/web/internal-principal.js';
import { registerAuthMiddleware } from '../src/web/middleware/auth.js';
import { buildUpstreamRequestHeaders } from '../src/web/webview-proxy.js';

const user = { username: 'admin', role: 'admin' as const };
const routine = { routineId: 'r1', runId: 'run1', workspaceId: 'ws1' };
const now = 1_000_000;
const value = (headers: Record<string, string>) => headers[INTERNAL_PRINCIPAL_HEADER]!;

afterEach(() => vi.unstubAllEnvs());

describe('minting and verifying', () => {
  it('round-trips the user and the routine it is bound to', () => {
    expect(verifyInternalPrincipal(value(internalHeaders({ user, routine }, now)), now)).toEqual({ user, routine });
    expect(verifyInternalPrincipal(value(internalHeaders({ user }, now)), now)).toEqual({ user });
  });
  it('refuses an expired header', () => {
    const header = value(internalHeaders({ user, routine }, now));
    expect(verifyInternalPrincipal(header, now + INTERNAL_PRINCIPAL_TTL_MS - 1)).toBeDefined();
    expect(verifyInternalPrincipal(header, now + INTERNAL_PRINCIPAL_TTL_MS)).toBeUndefined();
  });
  it('refuses a forged body, a moved binding and a signature from another key', () => {
    const header = value(internalHeaders({ user, routine }, now));
    const [body, signature] = header.split('.');
    const json = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8'));
    for (const changed of [
      { ...json, routine: { ...json.routine, workspaceId: 'ws2' } },
      { ...json, routine: { ...json.routine, routineId: 'r2' } },
      { ...json, user: { username: 'other', role: 'admin' } },
      { ...json, expiresAt: json.expiresAt + 60_000 },
    ]) {
      const forged = Buffer.from(JSON.stringify(changed), 'utf8').toString('base64url');
      expect(verifyInternalPrincipal(`${forged}.${signature}`, now)).toBeUndefined();
    }
    expect(verifyInternalPrincipal(`${body}.${'A'.repeat(43)}`, now)).toBeUndefined();
    for (const junk of [undefined, '', 'x', 'a.b.c', ['a', 'b'], `${body}.`, '.'.repeat(5000)])
      expect(verifyInternalPrincipal(junk, now)).toBeUndefined();
  });
});

describe('the auth hook', () => {
  async function app() {
    vi.stubEnv('CODEMAN_USERNAME', 'principal-test-user');
    vi.stubEnv('CODEMAN_PASSWORD', 'principal-test-password');
    const server = Fastify();
    await server.register(fastifyCookie);
    const auth = registerAuthMiddleware(server, false);
    server.get('/api/who', async (req) => ({ user: req.authUser ?? null, routine: req.internalPrincipal?.routine }));
    await server.ready();
    return { server, auth };
  }
  it('lets a minted header through as its user and turns a forged one away', async () => {
    const { server, auth } = await app();
    try {
      const good = await server.inject({ url: '/api/who', headers: internalHeaders({ user, routine }, Date.now()) });
      expect(good.statusCode).toBe(200);
      expect(good.json()).toEqual({ user, routine });
      const header = value(internalHeaders({ user, routine }, Date.now()));
      const forged = `${header.split('.')[0]}.${'B'.repeat(43)}`;
      const refused = await server.inject({ url: '/api/who', headers: { [INTERNAL_PRINCIPAL_HEADER]: forged } });
      expect(refused.statusCode).toBe(401);
    } finally {
      for (const map of Object.values(auth)) map?.dispose();
      await server.close();
    }
  });
});

describe('the webview proxy', () => {
  it('never forwards the header to a page', () => {
    const headers = buildUpstreamRequestHeaders(
      { ...internalHeaders({ user, routine }, now), accept: 'text/html' },
      new URL('http://127.0.0.1:9/'),
      { forwardCookies: false, sessionCookieName: 'codeman_session' }
    );
    expect(headers).not.toHaveProperty(INTERNAL_PRINCIPAL_HEADER);
    expect(headers.accept).toBe('text/html');
  });
});
