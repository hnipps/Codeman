/**
 * @fileoverview Where reviews are kept: one file per review, `<data dir>/reviews/<id>.json`, `{ version: 1, review }`.
 *
 * - Only the live deploy colour writes (`deployRole.allows('persist')`, checked at the write).
 * - A write is tmp + fsync + rename, mode 0600: a walkthrough can quote code from a private repository.
 * - A file that does not parse, or that a newer release wrote, is skipped on read and never overwritten.
 * - A change reads, applies a pure function and writes in one synchronous tick, so two requests cannot interleave.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dataPath } from '../config/instance.js';
import { deployRole, DeployRoleRefusal } from '../deploy-role.js';
import { ReviewFileSchema, ReviewIdSchema, type Review } from './review-model.js';

/** Files read by one listing. Past it the newest are kept, so an old backlog cannot slow every request. */
const MAX_FILES_READ = 1000;

const reviewsDir = (): string => dataPath('reviews');
const reviewPath = (id: string): string => dataPath('reviews', `${id}.json`);

export const newReviewId = (): string => randomBytes(8).toString('hex');

export type ReviewRead = { ok: true; review: Review } | { ok: false; reason: 'missing' | 'unreadable' | 'newer' };

export function readReview(rawId: string): ReviewRead {
  const id = ReviewIdSchema.safeParse(rawId);
  if (!id.success) return { ok: false, reason: 'missing' };
  const path = reviewPath(id.data);
  if (!existsSync(path)) return { ok: false, reason: 'missing' };
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (typeof json === 'object' && json !== null && 'version' in json && json.version !== 1)
    return { ok: false, reason: 'newer' };
  const parsed = ReviewFileSchema.safeParse(json);
  // The file name is the id a route was asked for; a file that claims another id is not that review.
  return parsed.success && parsed.data.review.id === id.data
    ? { ok: true, review: parsed.data.review }
    : { ok: false, reason: 'unreadable' };
}

export function listReviews(): Review[] {
  let names: string[];
  try {
    names = readdirSync(reviewsDir());
  } catch {
    return [];
  }
  const out: Review[] = [];
  for (const name of names.filter((n) => n.endsWith('.json')).slice(-MAX_FILES_READ)) {
    const read = readReview(name.slice(0, -'.json'.length));
    if (read.ok) out.push(read.review);
  }
  return out;
}

export function writeReview(review: Review): void {
  if (!deployRole.allows('persist')) throw new DeployRoleRefusal(deployRole.current, 'may write reviews');
  mkdirSync(reviewsDir(), { recursive: true, mode: 0o700 });
  const path = reviewPath(review.id);
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(ReviewFileSchema.parse({ version: 1, review })), { mode: 0o600 });
    const fd = openSync(tmp, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export type StoreProblem = { ok: false; code: 'FILE'; message: string };
const problem = (reason: 'missing' | 'unreadable' | 'newer'): StoreProblem => ({
  ok: false,
  code: 'FILE',
  message:
    reason === 'missing'
      ? 'Review not found'
      : reason === 'newer'
        ? 'This review was saved by a newer release; nothing was changed'
        : 'The review file could not be read; nothing was changed',
});

/** Applies one pure change and writes it. A refusal, or a change that changed nothing, writes nothing. */
export function changeReview<R extends { ok: false }>(
  id: string,
  change: (review: Review) => { ok: true; review: Review } | R
): { ok: true; review: Review } | R | (StoreProblem & { missing: boolean }) {
  const read = readReview(id);
  if (!read.ok) return { ...problem(read.reason), missing: read.reason === 'missing' };
  const result = change(read.review);
  if (result.ok && result.review !== read.review) writeReview(result.review);
  return result;
}
