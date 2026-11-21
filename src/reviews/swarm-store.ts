/**
 * @fileoverview Where a review's pr-swarm runs are kept: `<data dir>/reviews/<id>.swarm.json`, `{ version: 1, ... }`,
 * beside the review and never inside it, so the previous release reads every review file unchanged (I7).
 *
 * The rules are `review-store.ts`'s: only the live colour writes, a write is tmp + fsync + rename at mode 0600, a file
 * that does not parse or that a newer release wrote is never overwritten, and a change reads, applies a pure function
 * and writes in one synchronous tick.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dataPath } from '../config/instance.js';
import { ReviewIdSchema } from './review-model.js';
import { writeReviewsFile } from './review-store.js';
import { emptySwarmFile, SwarmFileSchema, type SwarmFile } from './swarm-model.js';

const swarmPath = (id: string): string => dataPath('reviews', `${id}.swarm.json`);

export type SwarmRead = { ok: true; file: SwarmFile } | { ok: false; reason: 'missing' | 'unreadable' | 'newer' };

/** A review with no runs yet reads as an empty file. `missing` means the id itself is not a review id. */
export function readSwarm(rawId: string): SwarmRead {
  const id = ReviewIdSchema.safeParse(rawId);
  if (!id.success) return { ok: false, reason: 'missing' };
  const path = swarmPath(id.data);
  if (!existsSync(path)) return { ok: true, file: emptySwarmFile(id.data) };
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (typeof json === 'object' && json !== null && 'version' in json && json.version !== 1)
    return { ok: false, reason: 'newer' };
  const parsed = SwarmFileSchema.safeParse(json);
  return parsed.success && parsed.data.reviewId === id.data
    ? { ok: true, file: parsed.data }
    : { ok: false, reason: 'unreadable' };
}

export function writeSwarm(file: SwarmFile): void {
  writeReviewsFile(swarmPath(file.reviewId), SwarmFileSchema.parse(file));
}

/** Applies one pure change and writes it. A change that returns the same file writes nothing. */
export function changeSwarm<T extends { file: SwarmFile }>(
  reviewId: string,
  change: (file: SwarmFile) => T
): ({ ok: true } & T) | Extract<SwarmRead, { ok: false }> {
  const read = readSwarm(reviewId);
  if (!read.ok) return read;
  const result = change(read.file);
  if (result.file !== read.file) writeSwarm(result.file);
  return { ok: true, ...result };
}
