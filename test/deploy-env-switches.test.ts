/**
 * The two environment switches a blue-green supervisor sets on every colour:
 * CODEMAN_STABLE_API_URL (the URL panes are handed, so their hooks reach whichever colour
 * is live) and CODEMAN_SSE_PADDING (padding for a buffering proxy Codeman does not manage).
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { SSE_PADDING_SIZE } from '../src/config/server-timing.js';
import { CleanupManager } from '../src/utils/index.js';
import { resolvePaneApiUrl } from '../src/web/pane-api-url.js';
import { WebServer } from '../src/web/server.js';
import { SseStreamManager } from '../src/web/sse-stream-manager.js';

const OWN = 'http://127.0.0.1:4101';

describe('resolvePaneApiUrl', () => {
  it('hands panes this server when no stable URL is set', () => {
    expect(resolvePaneApiUrl(OWN, undefined)).toEqual({ url: OWN });
    expect(resolvePaneApiUrl(OWN, '  ')).toEqual({ url: OWN });
  });

  it.each([
    ['http://127.0.0.1:8090', 'http://127.0.0.1:8090'],
    ['https://localhost:8443/', 'https://localhost:8443'],
    ['http://[::1]:8090', 'http://[::1]:8090'],
    ['http://127.0.0.1:8090/codeman/', 'http://127.0.0.1:8090/codeman'],
  ])('hands panes the stable loopback URL %s', (stable, expected) => {
    expect(resolvePaneApiUrl(OWN, stable)).toEqual({ url: expected });
  });

  it.each([
    ['not a url', 'is not a URL'],
    ['ftp://127.0.0.1:21', 'is not an http(s) URL'],
    ['http://codeman.example.com:8090', 'does not name a loopback host'],
    ['http://192.168.1.4:8090', 'does not name a loopback host'],
    ['http://user:pw@127.0.0.1:8090', 'carries credentials, a query or a fragment'],
  ])('falls back to this server for %j and says why', (stable, why) => {
    const result = resolvePaneApiUrl(OWN, stable);
    expect(result.url).toBe(OWN);
    expect(result.warning).toContain(why);
  });
});

describe('a server started with CODEMAN_STABLE_API_URL', () => {
  let server: WebServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
    delete process.env.CODEMAN_STABLE_API_URL;
    delete process.env.CODEMAN_API_URL;
  });

  it('exports the stable URL to its panes, and its Host guard accepts requests addressed to it', async () => {
    process.env.CODEMAN_STABLE_API_URL = 'http://127.0.0.1:47999';
    server = new WebServer(0, false, true);
    await server.start();
    expect(process.env.CODEMAN_API_URL).toBe('http://127.0.0.1:47999');

    const app = (server as unknown as { app: FastifyInstance }).app;
    const viaProxy = await app.inject({ method: 'GET', url: '/api/health', headers: { host: '127.0.0.1:47999' } });
    expect(viaProxy.statusCode).toBe(200);
    const rebound = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example:47999' } });
    expect(rebound.statusCode).toBe(403);
  });

  it('keeps its own URL when the stable one is not a loopback address', async () => {
    process.env.CODEMAN_STABLE_API_URL = 'http://203.0.113.9:8090';
    server = new WebServer(0, false, true);
    await server.start();
    expect(process.env.CODEMAN_API_URL).toBe(`http://127.0.0.1:${server.boundPort}`);
  });
});

describe('CODEMAN_SSE_PADDING', () => {
  afterEach(() => {
    delete process.env.CODEMAN_SSE_PADDING;
  });

  function heartbeatFrame(): string {
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
    const writes: string[] = [];
    const raw = { socket: { destroyed: false, writable: true }, write: (chunk: string) => writes.push(chunk) > 0 };
    manager.addClient({ raw } as unknown as FastifyReply, null, false);
    manager.cleanupDeadClients();
    cleanup.dispose();
    return writes[0];
  }

  it('pads frames for a proxy even with no Codeman-managed tunnel running', () => {
    process.env.CODEMAN_SSE_PADDING = '1';
    expect(heartbeatFrame()).toContain(':' + 'p'.repeat(SSE_PADDING_SIZE));
  });

  it('leaves frames unpadded without it and without a tunnel', () => {
    expect(heartbeatFrame()).not.toContain('p'.repeat(SSE_PADDING_SIZE));
  });
});
