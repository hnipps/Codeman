/**
 * @fileoverview Server-side link preview for canvas link cards: a page title and an
 * optional thumbnail, fetched through the web-tab egress guard.
 *
 * Every request, the page and each redirect hop and the thumbnail, goes through
 * `webviewFetch()`, so a link-local or cloud-metadata target is refused before a
 * connection opens and a name resolving there fails the connect. Redirects are
 * followed by hand (at most `MAX_REDIRECTS`) so each hop is judged again. Requests
 * carry no cookies and no authorization, time and bytes are bounded, and the HTML
 * is scanned as text: nothing in it runs. The thumbnail bytes are returned to the
 * caller, which stores them only after the asset byte check.
 */
import type { RequestInit, Response } from 'undici';
import {
  LINK_PREVIEW_CACHE_ENTRIES,
  LINK_PREVIEW_CACHE_TTL_MS,
  LINK_PREVIEW_CONCURRENCY,
  LINK_PREVIEWS_PER_MINUTE,
} from '../config/canvas-limits.js';
import { LRUMap } from '../utils/lru-map.js';
import { takeToken } from '../web/routes/session-routes.js';
import { WebviewEgressBlockedError, webviewFetch } from '../web/webview-egress.js';
import { blockedWebviewHostReason } from '../web/webview-egress-policy.js';
import { parseWebviewUrl } from '../web/webview-proxy.js';
import { assetExtension } from './canvas-assets.js';

export const LINK_PREVIEW_TIMEOUT_MS = 5000;
export const MAX_PREVIEW_HTML_BYTES = 512 * 1024;
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
export const MAX_PREVIEW_TITLE_CHARS = 200;
/**
 * The one reason every failed preview gives. A refused address, a 404, a timeout and an
 * unreachable host all read the same, so a preview cannot be used to map what this server
 * can reach.
 */
export const PREVIEW_UNAVAILABLE_REASON = 'This page could not be previewed';
const MAX_REDIRECTS = 3;

export type LinkPreview = {
  url: string;
  host: string;
  status: 'ready' | 'unavailable';
  title: string;
  reason?: string;
  thumbnail?: { bytes: Buffer; type: string };
};
export type PreviewFetch = (target: URL, init: RequestInit) => Promise<Response>;

class PreviewUnavailable extends Error {}

async function follow(target: URL, fetcher: PreviewFetch, accept: string, signal: AbortSignal): Promise<Response> {
  let current = target;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Judged here as well as inside webviewFetch, so no fetcher ever sees a refused host.
    const blocked = blockedWebviewHostReason(current.hostname);
    if (blocked) throw new WebviewEgressBlockedError(blocked);
    const response = await fetcher(current, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: { accept, 'user-agent': 'Codeman link preview' },
    });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => undefined);
      const next = parseWebviewUrl(new URL(location, current).href);
      if (!next) throw new PreviewUnavailable();
      current = next;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new PreviewUnavailable();
    }
    return response;
  }
  throw new PreviewUnavailable();
}

async function readBounded(response: Response, limit: number): Promise<Buffer | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/gi, (match, code: string) => {
    if (code[0] !== '#') return entities[code.toLowerCase()] ?? match;
    const point = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
  });
}

const clean = (text: string): string => {
  const flat = decodeEntities(text)
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...flat].slice(0, MAX_PREVIEW_TITLE_CHARS).join('');
};

/** Title and image URL from page text. Bounded patterns over bounded text; nothing is executed. */
export function parsePreviewHtml(html: string): { title: string; image: string | null } {
  const meta = new Map<string, string>();
  for (const tag of html.matchAll(/<meta\s[^>]{0,2000}>/gi)) {
    const attrs = new Map<string, string>();
    for (const attr of tag[0].matchAll(
      /([a-z][a-z:-]{0,40})\s*=\s*(?:"([^"]{0,2000})"|'([^']{0,2000})'|([^\s"'>]{1,2000}))/gi
    ))
      attrs.set(attr[1].toLowerCase(), attr[2] ?? attr[3] ?? attr[4] ?? '');
    const key = (attrs.get('property') ?? attrs.get('name') ?? '').toLowerCase();
    const content = attrs.get('content');
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
  }
  const titleTag = /<title[^>]{0,200}>([^<]{0,2000})/i.exec(html)?.[1];
  const title = clean(meta.get('og:title') ?? meta.get('twitter:title') ?? titleTag ?? '');
  const image = meta.get('og:image') ?? meta.get('twitter:image') ?? null;
  return { title, image: image ? decodeEntities(image).trim() : null };
}

export async function fetchLinkPreview(
  raw: string,
  options: { fetch?: PreviewFetch; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<LinkPreview> {
  const target = parseWebviewUrl(raw);
  if (!target) return { url: raw, host: '', title: '', status: 'unavailable', reason: PREVIEW_UNAVAILABLE_REASON };
  const base = { url: target.href, host: target.hostname, title: '' };
  const fetcher = options.fetch ?? webviewFetch;
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? LINK_PREVIEW_TIMEOUT_MS),
    ...(options.signal ? [options.signal] : []),
  ]);
  try {
    const page = await follow(target, fetcher, 'text/html,application/xhtml+xml', signal);
    const type = page.headers.get('content-type') ?? '';
    if (!/^\s*(text\/html|application\/xhtml\+xml)/i.test(type)) {
      await page.body?.cancel().catch(() => undefined);
      return { ...base, status: 'unavailable', reason: PREVIEW_UNAVAILABLE_REASON };
    }
    const body = await readBounded(page, MAX_PREVIEW_HTML_BYTES);
    const parsed = parsePreviewHtml(new TextDecoder().decode(body ?? Buffer.alloc(0)));
    const preview: LinkPreview = { ...base, status: 'ready', title: parsed.title };
    const imageUrl = parsed.image ? parseWebviewUrl(new URL(parsed.image, page.url || target).href) : null;
    if (imageUrl) {
      try {
        const image = await follow(imageUrl, fetcher, 'image/png,image/jpeg,image/gif,image/webp', signal);
        const imageType = image.headers.get('content-type') ?? '';
        const bytes = assetExtension(imageType) ? await readBounded(image, MAX_THUMBNAIL_BYTES) : null;
        if (!bytes) await image.body?.cancel().catch(() => undefined);
        if (bytes?.length) preview.thumbnail = { bytes, type: imageType };
      } catch {
        /* A page without a usable image still has its title. */
      }
    }
    return preview;
  } catch {
    return { ...base, status: 'unavailable', reason: PREVIEW_UNAVAILABLE_REASON };
  }
}

type PreviewAnswer = Omit<LinkPreview, 'thumbnail'> & { thumbnailAssetId?: string };

/**
 * The one path a request takes to a preview. Each preview is an outbound fetch made by this
 * server on a caller's behalf, so it is bounded four ways:
 *
 * - at most `LINK_PREVIEW_CONCURRENCY` fetches run at once across the server (the rest queue);
 * - one fetch per (workspace, URL) at a time: a second ask joins the first (single-flight);
 * - a finished answer is reused for `LINK_PREVIEW_CACHE_TTL_MS` (bounded LRU);
 * - `LINK_PREVIEWS_PER_MINUTE` fresh fetches per (caller, workspace), refused past that.
 *
 * Joined and cached answers spend no token. The thumbnail is stored through `storeThumbnail`
 * (the workspace's asset quota applies); one that is refused is dropped and the title stands.
 */
export function createLinkPreviewService(options: {
  storeThumbnail: (workspaceId: string, bytes: Buffer, type: string) => Promise<string | null>;
  fetch?: PreviewFetch;
  timeoutMs?: number;
  now?: () => number;
  concurrency?: number;
  perMinute?: number;
  cacheTtlMs?: number;
  cacheEntries?: number;
}) {
  const now = options.now ?? Date.now;
  const concurrency = options.concurrency ?? LINK_PREVIEW_CONCURRENCY;
  const perMinute = options.perMinute ?? LINK_PREVIEWS_PER_MINUTE;
  const ttl = options.cacheTtlMs ?? LINK_PREVIEW_CACHE_TTL_MS;
  const cache = new LRUMap<string, { at: number; answer: PreviewAnswer }>({
    maxSize: options.cacheEntries ?? LINK_PREVIEW_CACHE_ENTRIES,
  });
  const inFlight = new Map<string, Promise<PreviewAnswer>>();
  const buckets = new Map<string, { tokens: number; lastRefill: number }>();
  let running = 0;
  const queue: Array<() => void> = [];
  const slot = async () => {
    if (running >= concurrency) await new Promise<void>((go) => queue.push(go));
    else running++;
  };
  const release = () => {
    const next = queue.shift();
    if (next) next();
    else running--;
  };
  const run = async (workspaceId: string, url: string): Promise<PreviewAnswer> => {
    await slot();
    try {
      const { thumbnail, ...preview } = await fetchLinkPreview(url, {
        fetch: options.fetch,
        timeoutMs: options.timeoutMs,
      });
      if (!thumbnail) return preview;
      const thumbnailAssetId = await options.storeThumbnail(workspaceId, thumbnail.bytes, thumbnail.type);
      return thumbnailAssetId ? { ...preview, thumbnailAssetId } : preview;
    } finally {
      release();
    }
  };
  return {
    /** The preview for `url`, or `'rate-limited'` when `caller` has spent this minute's fetches. */
    async preview(workspaceId: string, url: string, caller: string): Promise<PreviewAnswer | 'rate-limited'> {
      const key = `${workspaceId}\n${url}`;
      const cached = cache.get(key);
      if (cached && now() - cached.at < ttl) return cached.answer;
      const joined = inFlight.get(key);
      if (joined) return joined;
      if (!takeToken(buckets, `${caller}\n${workspaceId}`, perMinute, now())) return 'rate-limited';
      const fetching = run(workspaceId, url).finally(() => inFlight.delete(key));
      inFlight.set(key, fetching);
      const answer = await fetching;
      cache.set(key, { at: now(), answer });
      return answer;
    },
    /** Fetches running or queued right now (tests and diagnostics). */
    get busy(): number {
      return running + queue.length;
    },
  };
}
