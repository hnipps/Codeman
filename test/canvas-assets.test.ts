/**
 * Canvas image assets: bytes judged before anything is written, content-addressed
 * names, a size cap, and reads by id alone.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AssetRefusedError,
  MAX_CANVAS_ASSET_BYTES,
  assetExtension,
  findAsset,
  imageSize,
  storeAsset,
} from '../src/canvas/canvas-assets.js';
import { deployRole } from '../src/deploy-role.js';
import { gifHeader, jpegHeader, png } from './canvas-media-fixtures.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-assets-'));
  vi.stubEnv('CODEMAN_DATA_DIR', dir);
});
afterEach(() => {
  deployRole.enter('live');
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
const refusal = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof AssetRefusedError ? error.reason : 'other';
  }
};
const assetsDir = () => join(dir, 'canvas', 'ws', 'assets');

describe('canvas assets', () => {
  it('stores bytes under their SHA-256 with the proved extension and private modes, once', () => {
    const bytes = png(4, 3);
    const first = storeAsset('ws', bytes, 'image/png');
    expect(first).toMatchObject({ mime: 'image/png', bytes: bytes.length, width: 4, height: 3 });
    expect(first.assetId).toMatch(/^[a-f0-9]{64}$/);
    expect(readdirSync(assetsDir())).toEqual([`${first.assetId}.png`]);
    expect(statSync(join(assetsDir(), `${first.assetId}.png`)).mode & 0o777).toBe(0o600);
    expect(statSync(assetsDir()).mode & 0o777).toBe(0o700);
    expect(storeAsset('ws', bytes, 'image/png').assetId).toBe(first.assetId);
    expect(readdirSync(assetsDir())).toHaveLength(1);
  });
  it('refuses bytes that are not the declared type, unknown types, empty and oversized bodies, writing nothing', () => {
    expect(refusal(() => storeAsset('ws', png(2, 2), 'image/jpeg'))).toBe('bytes');
    expect(
      refusal(() => storeAsset('ws', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'))
    ).toBe('type');
    expect(refusal(() => storeAsset('ws', Buffer.from('<html>not an image</html>'), 'image/png'))).toBe('bytes');
    expect(refusal(() => storeAsset('ws', Buffer.alloc(0), 'image/png'))).toBe('empty');
    const big = Buffer.concat([png(1, 1), Buffer.alloc(MAX_CANVAS_ASSET_BYTES)]);
    expect(refusal(() => storeAsset('ws', big, 'image/png'))).toBe('size');
    expect(() => readdirSync(assetsDir())).toThrow();
  });
  it('refuses to write from a retired colour', () => {
    deployRole.enter('retired');
    expect(() => storeAsset('ws', png(2, 2), 'image/png')).toThrow(/may write canvas data/);
  });
  it('finds an asset by id only: a path, a short id or another workspace finds nothing', () => {
    const { assetId } = storeAsset('ws', png(2, 2), 'image/png');
    expect(findAsset('ws', assetId)).toMatchObject({ mime: 'image/png' });
    expect(findAsset('other', assetId)).toBeNull();
    expect(findAsset('ws', assetId.slice(0, 40))).toBeNull();
    expect(findAsset('ws', `../${assetId}`)).toBeNull();
    expect(findAsset('ws', `${assetId}.png`)).toBeNull();
    expect(findAsset('../ws', assetId)).toBeNull();
  });
  it('maps declared types to stored extensions', () => {
    expect(assetExtension('image/jpeg')).toBe('.jpg');
    expect(assetExtension('image/png; charset=binary')).toBe('.png');
    expect(assetExtension('webp')).toBe('.webp');
    expect(assetExtension('image/svg+xml')).toBeNull();
    expect(assetExtension(undefined)).toBeNull();
  });
  it('reads pixel sizes from PNG, GIF and JPEG headers and answers null for a short header', () => {
    expect(imageSize(png(7, 5), '.png')).toEqual({ width: 7, height: 5 });
    expect(imageSize(gifHeader(9, 4), '.gif')).toEqual({ width: 9, height: 4 });
    expect(imageSize(jpegHeader(640, 480), '.jpg')).toEqual({ width: 640, height: 480 });
    expect(imageSize(Buffer.from([0x89, 0x50]), '.png')).toBeNull();
  });
});
