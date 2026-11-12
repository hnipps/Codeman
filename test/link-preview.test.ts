/**
 * Link previews: title and thumbnail through the web-tab egress guard, bounded,
 * with every redirect hop judged again.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fetchLinkPreview, parsePreviewHtml, MAX_PREVIEW_TITLE_CHARS } from '../src/canvas/link-preview.js';
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
      expect(preview.reason).toMatch(/link-local or cloud-metadata/);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('refuses a redirect to a metadata address', async () => {
    const preview = await fetchLinkPreview(`${base}/to-metadata`);
    expect(preview.status).toBe('unavailable');
    expect(preview.reason).toMatch(/link-local or cloud-metadata/);
  });
  it('answers unavailable for a non-HTML answer, a 404, a non-web address and a slow page', async () => {
    expect((await fetchLinkPreview(`${base}/json`)).reason).toBe('Not a web page');
    expect((await fetchLinkPreview(`${base}/missing`)).reason).toBe('The page answered 404');
    expect((await fetchLinkPreview('javascript:alert(1)')).reason).toBe('Not a web address');
    expect((await fetchLinkPreview(`${base}/slow`, { timeoutMs: 200 })).reason).toBe(
      'The page took too long to answer'
    );
  });
  it('caps the title', async () => {
    expect((await fetchLinkPreview(`${base}/huge`)).title).toHaveLength(MAX_PREVIEW_TITLE_CHARS);
  });
  it('parses page text without running it', () => {
    expect(parsePreviewHtml(`<title>A &#x263A; b</title>`)).toEqual({ title: 'A ☺ b', image: null });
    expect(parsePreviewHtml(`<meta name="twitter:title" content='Two'>`).title).toBe('Two');
  });
});
