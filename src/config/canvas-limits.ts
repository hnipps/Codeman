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

/**
 * Prototypes: folders of static files an agent publishes and Codeman serves (`src/canvas/prototypes.ts`).
 * One published version is a whole folder, so it is bounded by file count, by file and by total.
 */
export const PROTOTYPE_MAX_FILES = 200;
export const PROTOTYPE_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const PROTOTYPE_MAX_VERSION_BYTES = 12 * 1024 * 1024;
/** The publish request is JSON with base64 file bodies: a full version, its 4/3 encoding and the paths. */
export const PROTOTYPE_PUBLISH_BODY_BYTES = 18 * 1024 * 1024;
/** Newest versions kept per prototype. A version an object still points at is kept past this. */
export const PROTOTYPE_VERSIONS_KEPT = 10;
export const PROTOTYPES_PER_WORKSPACE = 50;
/** Prototype publishes and checks per minute for one caller in one workspace. */
export const PROTOTYPE_PUBLISHES_PER_MINUTE = 12;
export const PROTOTYPE_CHECKS_PER_MINUTE = 12;
/** Prototype embeds one screenshot draws live; the rest keep their card. */
export const PROTOTYPE_SHOT_FRAMES = 6;

/**
 * Stored prototype bytes one canvas workspace may hold, across every kept version.
 * Override: CODEMAN_CANVAS_PROTOTYPE_QUOTA_BYTES (bytes, default 256 MB).
 */
export function canvasPrototypeQuotaBytes(): number {
  return parseNonNegativeIntEnv(process.env.CODEMAN_CANVAS_PROTOTYPE_QUOTA_BYTES, 256 * 1024 * 1024);
}
