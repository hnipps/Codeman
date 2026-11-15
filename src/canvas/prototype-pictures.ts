/**
 * @fileoverview Pictures of stored prototype versions, kept beside them: the phone card's picture of a version,
 * and the crop of where a commented element was in the version the comment was made on.
 *
 * Both are drawn by the prototype check's headless browser (one job at a time, no network) the first time they
 * are asked for, then served from `dataPath('canvas/<workspaceId>/prototypes/<id>/pictures/')`. A version never
 * changes, so neither does its picture. The folder goes with the prototype when it is removed. Every name is
 * built from a validated workspace id, prototype id, version number and comment id; a caller never hands this
 * module a path. Only the live deploy colour writes here; another colour draws the picture and keeps nothing.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataPath } from '../config/instance.js';
import { deployRole } from '../deploy-role.js';
import { IdSchema } from './model.js';
import { isPrototypeId } from './prototype-address.js';

/** The width and height a phone card's picture is drawn at: the mock-up's phone. */
export const PHONE_PICTURE = { width: 390, height: 844 } as const;
/** The page width a crop is drawn at when the element sat past a phone's width when it was picked. */
export const DESKTOP_CROP = { width: 1280, height: 800 } as const;
/** An element whose right edge was past this when it was picked was picked at a wider page than a phone's. */
const PHONE_EDGE = 430;

export type PictureTheme = 'dark' | 'light';

function picturesDir(workspaceId: string, prototypeId: string): string | null {
  if (!IdSchema.safeParse(workspaceId).success || !isPrototypeId(prototypeId)) return null;
  return dataPath('canvas', workspaceId, 'prototypes', prototypeId, 'pictures');
}

const versionOk = (version: number): boolean => Number.isInteger(version) && version >= 1 && version <= 1_000_000;

/** Where a version's card picture is kept, or null for a name this module will not build. */
export function versionPicturePath(
  workspaceId: string,
  prototypeId: string,
  version: number,
  theme: PictureTheme
): string | null {
  const dir = picturesDir(workspaceId, prototypeId);
  return dir && versionOk(version) ? join(dir, `v${version}-${theme}.png`) : null;
}

/** Where the crop of one comment's element in one version is kept. */
export function cropPicturePath(
  workspaceId: string,
  prototypeId: string,
  commentId: string,
  version: number,
  theme: PictureTheme
): string | null {
  const dir = picturesDir(workspaceId, prototypeId);
  if (!dir || !versionOk(version) || !IdSchema.safeParse(commentId).success) return null;
  return join(dir, `c-${commentId}-v${version}-${theme}.png`);
}

/** The page size a crop is drawn at: a phone's when the element fitted one when it was picked. */
export function cropViewport(rect: { x: number; width: number }): { width: number; height: number } {
  return rect.x + rect.width > PHONE_EDGE ? DESKTOP_CROP : PHONE_PICTURE;
}

export async function readPicture(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

/** Keeps a picture, 0600 through a temporary file and a rename. A colour that may not write keeps nothing. */
export async function keepPicture(path: string, png: Buffer): Promise<void> {
  if (!deployRole.allows('persist')) return;
  const dir = join(path, '..');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, png, { mode: 0o600, flag: 'wx' });
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
}
