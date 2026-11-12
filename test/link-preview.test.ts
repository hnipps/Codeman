/**
 * Link previews: title and thumbnail through the web-tab egress guard, bounded,
 * with every redirect hop judged again.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLinkPreviewService,
  fetchLinkPreview,
  parsePreviewHtml,
  MAX_PREVIEW_TITLE_CHARS,
  PREVIEW_UNAVAILABLE_REASON,
  type PreviewFetch,
} from '../src/canvas/link-preview.js';
import { png } from './canvas-media-fixtures.js';

let server: http.Server;
let base: string;
const seen: http.IncomingHttpHeaders[] = [];
beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push(req.headers);
    const path = req.url ?? '/';
    if (path === '/page') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(
        `<html><head><title>Fallback</title><meta property="og:title" content="Release notes &amp; plans">` +
          `<meta property="og:image" content="/thumb.png"><script>window.ran = true</script></head></html>`
      );
    } else if (path === '/thumb.png') {
      res.setHeader('content-type', 'image/png');
      res.end(png(3, 2));
    } else if (path === '/json') {
      res.setHeader('content-type', 'application/json');
      res.end('{"title":"no"}');
    } else if (path === '/hop') {
      res.statusCode = 302;
      res.setHeader('location', '/page');
      res.end();
    } else if (path === '/to-metadata') {
      res.statusCode = 302;
      res.setHeader('location', 'http://169.254.169.254/latest/meta-data/');
      res.end();
    } else if (path === '/huge') {
      res.setHeader('content-type', 'text/html');
      res.end(`<title>${'x'.repeat(1000)}</title>`);
    } else if (path === '/slow') {
      setTimeout(() => res.end('<title>late</title>'), 2000);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe('link preview', () => {
  it('reads the og title and stores no script, and fetches the thumbnail without cookies or auth', async () => {
    seen.length = 0;
    const preview = await fetchLinkPreview(`${base}/page`);
    expect(preview).toMatchObject({ status: 'ready', title: 'Release notes & plans', host: '127.0.0.1' });
    expect(preview.thumbnail?.type).toBe('image/png');
    expect(preview.thumbnail?.bytes.subarray(1, 4).toString()).toBe('PNG');
    for (const headers of seen) {
      expect(headers.cookie).toBeUndefined();
      expect(headers.authorization).toBeUndefined();
    }
  });
  it('follows a redirect on the same guard', async () => {
    expect(await fetchLinkPreview(`${base}/hop`)).toMatchObject({ status: 'ready', url: `${base}/hop` });
  });
  it('refuses link-local and metadata targets before any request is made', async () => {
    const fetcher = vi.fn();
    for (const target of ['http://169.254.169.254/latest/', 'http://metadata.google.internal/']) {
      const preview = await fetchLinkPreview(target, { fetch: fetcher });
      expect(preview.status).toBe('unavailable');
      expect(preview.reason).toBe(PREVIEW_UNAVAILABLE_REASON);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('refuses a redirect to a metadata address', async () => {
    const preview = await fetchLinkPreview(`${base}/to-metadata`);
    expect(preview.status).toBe('unavailable');
    expect(preview.reason).toBe(PREVIEW_UNAVAILABLE_REASON);
  });
  it('gives one coarse reason for every failure, so a preview cannot map what the server reaches', async () => {
    const failures = [
      await fetchLinkPreview(`${base}/json`),
      await fetchLinkPreview(`${base}/missing`),
      await fetchLinkPreview('javascript:alert(1)'),
      await fetchLinkPreview(`${base}/slow`, { timeoutMs: 200 }),
      await fetchLinkPreview(`${base}/to-metadata`),
      await fetchLinkPreview('http://127.0.0.1:1/'),
    ];
    for (const failure of failures) {
      expect(failure.status).toBe('unavailable');
      expect(failure.reason).toBe(PREVIEW_UNAVAILABLE_REASON);
    }
  });
  it('caps the title', async () => {
    expect((await fetchLinkPreview(`${base}/huge`)).title).toHaveLength(MAX_PREVIEW_TITLE_CHARS);
  });
  it('parses page text without running it', () => {
    expect(parsePreviewHtml(`<title>A &#x263A; b</title>`)).toEqual({ title: 'A ☺ b', image: null });
    expect(parsePreviewHtml(`<meta name="twitter:title" content='Two'>`).title).toBe('Two');
  });
});

describe('link preview service', () => {
  const page = () =>
    new Response('<title>Held</title>', { headers: { 'content-type': 'text/html' } }) as unknown as Awaited<
      ReturnType<PreviewFetch>
    >;
  /** A fetcher whose answers the test releases by hand. */
  function heldFetcher() {
    const waiting: Array<() => void> = [];
    const calls: string[] = [];
    const fetch: PreviewFetch = (target) => {
      calls.push(target.href);
      return new Promise((resolve) => waiting.push(() => resolve(page())));
    };
    return { fetch, calls, releaseAll: () => waiting.splice(0).forEach((go) => go()) };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  const storeThumbnail = async () => null;

  it('runs at most two fetches at once across the server', async () => {
    const held = heldFetcher();
    const service = createLinkPreviewService({ storeThumbnail, fetch: held.fetch, perMinute: 100 });
    const asks = [1, 2, 3, 4].map((n) => service.preview(`ws${n}`, `http://example.com/${n}`, 'me'));
    await settle();
    expect(held.calls).toHaveLength(2);
    expect(service.busy).toBe(4);
    held.releaseAll();
    await settle();
    expect(held.calls).toHaveLength(4);
    held.releaseAll();
    expect((await Promise.all(asks)).every((a) => a !== 'rate-limited' && a.status === 'ready')).toBe(true);
    expect(service.busy).toBe(0);
  });
  it('fetches one (workspace, URL) once while it is in flight, and answers again from a short cache', async () => {
    let clock = 1_000;
    const held = heldFetcher();
    const service = createLinkPreviewService({
      storeThumbnail,
      fetch: held.fetch,
      now: () => clock,
      cacheTtlMs: 60_000,
    });
    const first = service.preview('ws', 'http://example.com/a', 'me');
    const joined = service.preview('ws', 'http://example.com/a', 'someone-else');
    await settle();
    expect(held.calls).toHaveLength(1);
    held.releaseAll();
    expect(await joined).toEqual(await first);
    await service.preview('ws', 'http://example.com/a', 'me');
    expect(held.calls).toHaveLength(1);
    clock += 60_001;
    const stale = service.preview('ws', 'http://example.com/a', 'me');
    await settle();
    expect(held.calls).toHaveLength(2);
    held.releaseAll();
    await stale;
  });
  it('refuses a caller past its per-workspace budget, but not another caller or workspace', async () => {
    const fetch: PreviewFetch = async () => page();
    const service = createLinkPreviewService({ storeThumbnail, fetch, perMinute: 3, now: () => 5_000 });
    for (let n = 0; n < 3; n++)
      expect(await service.preview('ws', `http://example.com/${n}`, 'me')).not.toBe('rate-limited');
    expect(await service.preview('ws', 'http://example.com/4', 'me')).toBe('rate-limited');
    expect(await service.preview('ws', 'http://example.com/0', 'me')).not.toBe('rate-limited');
    expect(await service.preview('ws', 'http://example.com/4', 'you')).not.toBe('rate-limited');
    expect(await service.preview('ws2', 'http://example.com/4', 'me')).not.toBe('rate-limited');
  });
  it('keeps the title when the thumbnail is refused', async () => {
    const service = createLinkPreviewService({ storeThumbnail: async () => null });
    const answer = await service.preview('ws', `${base}/page`, 'me');
    expect(answer).toMatchObject({ status: 'ready', title: 'Release notes & plans' });
    expect(answer).not.toHaveProperty('thumbnailAssetId');
    expect(answer).not.toHaveProperty('thumbnail');
  });
});
