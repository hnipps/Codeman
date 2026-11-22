/**
 * @fileoverview Where reviews are kept: one file per review, `<data dir>/reviews/<id>.json`, `{ version: 1, review }`.
 *
 * - Only the live deploy colour writes (`deployRole.allows('persist')`, checked at the write).
 * - A write is tmp + fsync + rename, mode 0600: a walkthrough can quote code from a private repository.
 * - A file that does not parse, or that a newer release wrote, is skipped on read and never overwritten.
 * - A change reads, applies a pure function and writes in one synchronous tick, so two requests cannot interleave.
 * - A review's stills are files in `<data dir>/reviews/<id>.captures/`, named by the review's own record. A file
 *   the record does not name is never served, and no request names a path.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
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
import {
  CaptureNameSchema,
  captureFile,
  MAX_CAPTURES,
  ReviewFileSchema,
  ReviewIdSchema,
  type Capture,
  type Review,
} from './review-model.js';

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
  // Only `<id>.json`: a review's pr-swarm runs sit beside it as `<id>.swarm.json` and are not reviews.
  const ids = names.flatMap((n) => {
    const id = n.endsWith('.json') ? n.slice(0, -'.json'.length) : '';
    return ReviewIdSchema.safeParse(id).success ? [id] : [];
  });
  for (const id of ids.slice(-MAX_FILES_READ)) {
    const read = readReview(id);
    if (read.ok) out.push(read.review);
  }
  return out;
}

export function writeReview(review: Review): void {
  writeReviewsFile(reviewPath(review.id), ReviewFileSchema.parse({ version: 1, review }));
}

/** Writes one file of the reviews folder: live colour only, tmp + fsync + rename, mode 0600. */
export function writeReviewsFile(path: string, value: unknown): void {
  if (!deployRole.allows('persist')) throw new DeployRoleRefusal(deployRole.current, 'may write reviews');
  mkdirSync(reviewsDir(), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
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

const capturesDir = (id: string): string => dataPath('reviews', `${id}.captures`);

/** Writes one still's bytes. The caller has already judged the bytes and holds the record that names the file. */
export function writeCaptureFile(reviewId: string, capture: Pick<Capture, 'name' | 'ext'>, data: Buffer): void {
  if (!deployRole.allows('persist')) throw new DeployRoleRefusal(deployRole.current, 'may write reviews');
  const id = ReviewIdSchema.parse(reviewId);
  CaptureNameSchema.parse(capture.name);
  const dir = capturesDir(id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = `${dir}/${captureFile(capture)}`;
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** The file of a still the review's record names, or null. A symlink or anything but a regular file is refused. */
export function findCaptureFile(review: Review, name: string): { path: string; size: number; capture: Capture } | null {
  const capture = review.captures?.find((c) => c.name === name);
  if (!capture) return null;
  const path = `${capturesDir(review.id)}/${captureFile(capture)}`;
  try {
    const info = lstatSync(path);
    return info.isFile() ? { path, size: info.size, capture } : null;
  } catch {
    return null;
  }
}

/**
 * Copies the stills of `from` (newest review first) that have a file into the folder of review `toId`, and returns
 * those copied. A name already taken by a newer review is skipped, and at most `MAX_CAPTURES` are copied. The work
 * review that takes session reviews over gets its stills this way; the session reviews keep their own files.
 */
export function copyCaptureFiles(from: readonly Review[], toId: string): Capture[] {
  if (!deployRole.allows('persist')) throw new DeployRoleRefusal(deployRole.current, 'may write reviews');
  const id = ReviewIdSchema.parse(toId);
  const copied: Capture[] = [];
  for (const review of from)
    for (const capture of review.captures ?? []) {
      if (copied.length >= MAX_CAPTURES || copied.some((c) => c.name === capture.name)) continue;
      const found = findCaptureFile(review, capture.name);
      if (!found) continue;
      const dir = capturesDir(id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = `${dir}/${captureFile(capture)}`;
      const tmp = `${path}.${randomUUID()}.tmp`;
      try {
        copyFileSync(found.path, tmp, fsConstants.COPYFILE_EXCL);
        chmodSync(tmp, 0o600);
        renameSync(tmp, path);
      } finally {
        rmSync(tmp, { force: true });
      }
      copied.push(capture);
    }
  return copied;
}

/** Removes every still file the review's record no longer names. With no record left, the folder goes too. */
export function pruneCaptureFiles(review: Review): void {
  if (!deployRole.allows('persist')) return;
  const dir = capturesDir(review.id);
  const keep = new Set((review.captures ?? []).map(captureFile));
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) if (!keep.has(name)) rmSync(`${dir}/${name}`, { force: true });
  if (!keep.size) rmSync(dir, { recursive: true, force: true });
}
