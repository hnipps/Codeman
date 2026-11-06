/**
 * @fileoverview Limits and timeouts for preview servers.
 */

function envInt(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function previewIdleStopMs(): number {
  return envInt('CODEMAN_PREVIEW_IDLE_STOP_MS', 4 * 60 * 60 * 1000);
}

export const PREVIEW_RECONCILE_INTERVAL_MS = 60_000;

export const PREVIEW_STOP_GRACE_MS = 5_000;

export const PREVIEW_READY_TIMEOUT_MS = 20_000;

export const MAX_PREVIEWS_PER_SESSION = 8;

export const MAX_PREVIEW_CMD_LENGTH = 4096;

export const PREVIEW_LOG_TAIL_DEFAULT_BYTES = 64 * 1024;
export const PREVIEW_LOG_TAIL_MAX_BYTES = 1024 * 1024;

export const PREVIEW_LOG_MAX_BYTES = 16 * 1024 * 1024;
