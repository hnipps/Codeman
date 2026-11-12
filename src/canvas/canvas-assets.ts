/**
 * @fileoverview Per-workspace image assets: content-addressed bytes under
 * `dataPath('canvas/<workspaceId>/assets/')`.
 *
 * A file is named by the SHA-256 of its bytes plus the extension its bytes proved,
 * and is read back by that hash alone, so no request ever names a path. Bytes are
 * judged by `imageMagicMatchesExt` against the declared type before anything is
 * written. Assets are only ever added: an object that stops referencing one leaves
 * the file in place, since undo, restore and copies may reference it again.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dataPath } from '../config/instance.js';
import { imageMagicMatchesExt } from '../web/routes/session-routes.js';
import { requireCanvasWriter } from './canvas-store.js';
import { AssetIdSchema, IdSchema } from './model.js';

export const MAX_CANVAS_ASSET_BYTES = 8 * 1024 * 1024;
export const ASSET_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const extensions = Object.keys(ASSET_TYPES);

/** The declared type of an upload, as a stored extension, or null when it is not an image type the canvas keeps. */
export function assetExtension(declared: string | undefined): string | null {
  const value = (declared ?? '').toLowerCase().split(';')[0].trim();
  const ext = value.startsWith('image/')
    ? `.${value.slice('image/'.length)}`
    : value.startsWith('.')
      ? value
      : `.${value}`;
  const normalized = ext === '.jpeg' ? '.jpg' : ext;
  return ASSET_TYPES[normalized] ? normalized : null;
}

export type AssetRefusal = 'type' | 'size' | 'bytes' | 'empty';
export class AssetRefusedError extends Error {
  constructor(
    readonly reason: AssetRefusal,
    message: string
  ) {
    super(message);
  }
}

export type StoredAsset = {
  assetId: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
};

const assetsDir = (workspaceId: string): string => dataPath('canvas', IdSchema.parse(workspaceId), 'assets');

/** Validate and store image bytes. Storing the same bytes again returns the existing asset. */
export function storeAsset(workspaceId: string, data: Buffer, declared: string | undefined): StoredAsset {
  const ext = assetExtension(declared);
  if (!ext) throw new AssetRefusedError('type', 'Only PNG, JPEG, GIF and WebP images can be added to the canvas');
  if (!data.length) throw new AssetRefusedError('empty', 'The image is empty');
  if (data.length > MAX_CANVAS_ASSET_BYTES)
    throw new AssetRefusedError('size', `Images are limited to ${MAX_CANVAS_ASSET_BYTES / 1024 / 1024} MB`);
  if (!imageMagicMatchesExt(data, ext))
    throw new AssetRefusedError('bytes', 'The file is not the image type it claims to be');
  requireCanvasWriter();
  const assetId = createHash('sha256').update(data).digest('hex');
  const dir = assetsDir(workspaceId);
  const path = `${dir}/${assetId}${ext}`;
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, data, { mode: 0o600 });
      renameSync(tmp, path);
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  const size = imageSize(data, ext);
  return {
    assetId,
    mime: ASSET_TYPES[ext],
    bytes: data.length,
    width: size?.width ?? null,
    height: size?.height ?? null,
  };
}

/** Find a stored asset by id. The id is a hash, never a path; anything else is not found. */
export function findAsset(workspaceId: string, assetId: string): { path: string; mime: string; size: number } | null {
  if (!AssetIdSchema.safeParse(assetId).success || !IdSchema.safeParse(workspaceId).success) return null;
  const dir = assetsDir(workspaceId);
  for (const ext of extensions) {
    const path = `${dir}/${assetId}${ext}`;
    try {
      const stat = statSync(path);
      if (stat.isFile()) return { path, mime: ASSET_TYPES[ext], size: stat.size };
    } catch {
      /* Not stored under this extension. */
    }
  }
  return null;
}

/** Pixel dimensions read from the image header, or null when the header does not say. */
export function imageSize(data: Buffer, ext: string): { width: number; height: number } | null {
  const valid = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : null);
  try {
    switch (ext) {
      case '.png':
        return data.length >= 24 ? valid(data.readUInt32BE(16), data.readUInt32BE(20)) : null;
      case '.gif':
        return data.length >= 10 ? valid(data.readUInt16LE(6), data.readUInt16LE(8)) : null;
      case '.webp': {
        const chunk = data.subarray(12, 16).toString('ascii');
        if (chunk === 'VP8X' && data.length >= 30) return valid(data.readUIntLE(24, 3) + 1, data.readUIntLE(27, 3) + 1);
        if (chunk === 'VP8 ' && data.length >= 30)
          return valid(data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff);
        if (chunk === 'VP8L' && data.length >= 25) {
          const bits = data.readUInt32LE(21);
          return valid((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
        }
        return null;
      }
      case '.jpg': {
        let offset = 2;
        for (let markers = 0; offset + 9 < data.length && markers < 4096; markers++) {
          if (data[offset] !== 0xff) return null;
          const marker = data[offset + 1];
          if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
            offset += 2;
            continue;
          }
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
            return valid(data.readUInt16BE(offset + 7), data.readUInt16BE(offset + 5));
          offset += 2 + data.readUInt16BE(offset + 2);
        }
        return null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}
