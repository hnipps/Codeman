/**
 * @fileoverview Bounds on the canvas's outward-facing work: stored image bytes per workspace,
 * uploads, and link previews (each one an outbound fetch made by this server).
 *
 * The defaults suit one person or a small team on one machine. The byte quota is
 * env-overridable because a workspace of screenshots can legitimately outgrow it.
 */

function parseNonNegativeIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Stored image bytes one canvas workspace may hold (uploads and link-preview thumbnails alike).
 * Read at call time so a test or an operator change applies without a restart of the module.
 * Override: CODEMAN_CANVAS_ASSET_QUOTA_BYTES (bytes, default 512 MB).
 */
export function canvasAssetQuotaBytes(): number {
  return parseNonNegativeIntEnv(process.env.CODEMAN_CANVAS_ASSET_QUOTA_BYTES, 512 * 1024 * 1024);
}

/** Image uploads per minute for one caller (user, or address when there are no users) in one workspace. */
export const CANVAS_UPLOADS_PER_MINUTE = 30;

/** Link previews fetching at once, across the whole server. */
export const LINK_PREVIEW_CONCURRENCY = 2;
/** Link previews per minute for one caller in one workspace (cache hits and joined fetches are free). */
export const LINK_PREVIEWS_PER_MINUTE = 20;
/** How long a finished preview answers again without a fetch. */
export const LINK_PREVIEW_CACHE_TTL_MS = 60_000;
/** Finished previews held; the least recently used past this is dropped. */
export const LINK_PREVIEW_CACHE_ENTRIES = 256;
