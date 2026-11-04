/**
 * @fileoverview Extract a zip, tar, or gzip-compressed tar into a fresh directory.
 *
 * The archive is untrusted: a skill upload is allowed to carry a tree, and it is
 * not allowed to escape that tree. Paths are relative segments, links are refused,
 * and the byte and file caps fail the extract before a huge entry is written.
 * Past a cap, the message tells the caller to import a subdirectory.
 *
 * @module extensions/archive
 */

import { lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { createGunzip, inflateRawSync } from 'node:zlib';
import { ExtensionError } from './types.js';

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_EXTRACT_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 2000;
const MAX_DEPTH = 6;

function reject(message: string): never {
  throw new ExtensionError('INVALID_INPUT', message);
}

function cap(message: string): never {
  reject(`${message} Import a subdirectory.`);
}

function inside(root: string, target: string): boolean {
  const base = resolve(root);
  const resolved = resolve(target);
  return resolved === base || resolved.startsWith(base + sep);
}

/** Relative segments only. `..`, absolute paths and backslashes are refused. */
function segmentsOf(name: string): string[] {
  if (!name || name.includes('\\') || name.includes('\0')) {
    reject('That archive has a path Codeman will not extract.');
  }
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    reject('That archive has an absolute path. Import a subdirectory.');
  }
  const parts = name.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) {
    reject('That archive escapes its directory (a ".." path). Nothing was imported.');
  }
  if (parts.length > MAX_DEPTH) {
    cap('That archive is nested more than 6 directories deep.');
  }
  return parts;
}

/**
 * Extract `archivePath` into `destDir`. The destination is created. A failure
 * leaves it removed, so a rejected archive never becomes a half-written tree.
 */
export async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  const stat = await lstat(archivePath);
  if (stat.isSymbolicLink() || !stat.isFile()) reject('That archive is not a regular file.');
  if (stat.size > MAX_ARCHIVE_BYTES) cap('That archive is larger than 32 MB.');
  const buf = await readFile(archivePath);
  if (buf.length > MAX_ARCHIVE_BYTES) cap('That archive is larger than 32 MB.');

  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });
  try {
    if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) {
      await extractZip(buf, destDir);
    } else if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      const tar = await gunzipLimited(buf, MAX_EXTRACT_BYTES);
      await extractTar(tar, destDir);
    } else if (buf.length > 262 && buf.subarray(257, 262).toString('utf8') === 'ustar') {
      await extractTar(buf, destDir);
    } else {
      reject('That file is not a zip, tar, or tar.gz archive, and it is not a SKILL.md file.');
    }
  } catch (err) {
    await rm(destDir, { recursive: true, force: true });
    throw err;
  }
}

async function writeFileAt(destDir: string, parts: string[], data: Buffer, mode: number): Promise<void> {
  if (parts.length === 0) return;
  const target = resolve(destDir, ...parts);
  if (!inside(destDir, target)) reject('That archive escapes its directory. Nothing was imported.');
  await mkdir(dirname(target), { recursive: true });
  const handle = await open(target, 'w', 0o644 | (mode & 0o111));
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

async function mkdirAt(destDir: string, parts: string[]): Promise<void> {
  if (parts.length === 0) return;
  const target = resolve(destDir, ...parts);
  if (!inside(destDir, target)) reject('That archive escapes its directory. Nothing was imported.');
  await mkdir(target, { recursive: true });
}

// ─── zip ─────────────────────────────────────────────────────────────────────

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - (65535 + 22));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue;
    const comment = buf.readUInt16LE(i + 20);
    if (i + 22 + comment === buf.length) return i;
  }
  reject('That zip archive has no central directory.');
}

async function extractZip(buf: Buffer, destDir: string): Promise<void> {
  const eocd = findEocd(buf);
  const records = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (records === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    cap('That zip archive uses Zip64.');
  }
  if (cdOffset + cdSize > buf.length) reject('That zip archive is truncated.');

  let offset = cdOffset;
  const end = cdOffset + cdSize;
  let files = 0;
  let extracted = 0;
  let wrote = 0;

  for (let n = 0; n < records; n++) {
    if (offset + 46 > end || buf.readUInt32LE(offset) !== 0x02014b50) {
      reject('That zip archive has a damaged central directory.');
    }
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compressed = buf.readUInt32LE(offset + 20);
    const uncompressed = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const external = buf.readUInt32LE(offset + 38);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    offset += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) reject('That zip archive is encrypted. Codeman does not ask for a password.');
    if (method !== 0 && method !== 8) reject('That zip archive uses a compression Codeman does not read.');
    if (flags & 0x8 && (compressed === 0 || uncompressed === 0)) {
      reject('That zip entry does not say its size.');
    }
    if (uncompressed > MAX_FILE_BYTES || compressed > MAX_ARCHIVE_BYTES) {
      cap('One file in that archive is larger than 8 MB.');
    }

    const unixMode = (external >>> 16) & 0xffff;
    if ((unixMode & 0o170000) === 0o120000) {
      reject('That archive contains a symlink. Import a directory without links.');
    }
    const parts = segmentsOf(name);
    const isDir = name.endsWith('/') || (unixMode & 0o170000) === 0o040000;
    if (isDir) {
      await mkdirAt(destDir, parts);
      continue;
    }
    if (parts.length === 0) continue;

    files += 1;
    extracted += uncompressed;
    if (files > MAX_FILES) cap(`That archive has more than ${MAX_FILES} files.`);
    if (extracted > MAX_EXTRACT_BYTES) cap('That archive expands past 64 MB.');

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      reject('That zip archive is missing a file header.');
    }
    const localName = buf.readUInt16LE(localOffset + 26);
    const localExtra = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localName + localExtra;
    const dataEnd = dataStart + compressed;
    if (dataEnd > buf.length) reject('That zip archive is truncated.');
    const compressedBytes = buf.subarray(dataStart, dataEnd);
    let data: Buffer;
    if (method === 0) {
      if (compressed !== uncompressed) reject('That zip entry is the wrong size.');
      data = Buffer.from(compressedBytes);
    } else {
      try {
        data = inflateRawSync(compressedBytes);
      } catch {
        reject('That zip entry could not be decompressed.');
      }
    }
    if (data.length !== uncompressed) reject('That zip entry expanded to an unexpected size.');
    await writeFileAt(destDir, parts, data, unixMode);
    wrote += 1;
  }
  if (wrote === 0) reject('That archive has no files.');
}

function gunzipLimited(input: Buffer, maxOut: number): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const gunzip = createGunzip();
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      gunzip.destroy();
      rejectPromise(err);
    };
    gunzip.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxOut) {
        fail(new ExtensionError('INVALID_INPUT', 'That archive expands past 64 MB. Import a subdirectory.'));
        return;
      }
      chunks.push(chunk);
    });
    gunzip.on('error', () => fail(new ExtensionError('INVALID_INPUT', 'That gzip archive could not be read.')));
    gunzip.on('end', () => {
      if (settled) return;
      settled = true;
      resolvePromise(Buffer.concat(chunks, total));
    });
    gunzip.end(input);
  });
}

// ─── tar ─────────────────────────────────────────────────────────────────────

function octal(field: Buffer): number {
  if (field.length > 0 && field[0] & 0x80) {
    let value = 0;
    for (let i = 1; i < field.length; i++) value = value * 256 + field[i];
    return value;
  }
  const text = field.toString('utf8').replace(/\0.*$/, '').trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) reject('That tar header has a size Codeman will not read.');
  return parseInt(text, 8);
}

function checksumOk(header: Buffer): boolean {
  const stored = header.subarray(148, 156).toString('utf8').replace(/\0/g, '').trim();
  if (!/^[0-7]+$/.test(stored)) return false;
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  return parseInt(stored, 8) === sum;
}

function cString(field: Buffer): string {
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString('utf8');
}

function parsePax(data: Buffer): Record<string, string> {
  const text = data.toString('utf8');
  const out: Record<string, string> = {};
  let i = 0;
  while (i < text.length) {
    const space = text.indexOf(' ', i);
    if (space < 0) break;
    const len = Number(text.slice(i, space));
    if (!Number.isInteger(len) || len <= 0 || i + len > text.length) break;
    const body = text.slice(space + 1, i + len);
    const eq = body.indexOf('=');
    if (eq > 0) {
      let value = body.slice(eq + 1);
      if (value.endsWith('\n')) value = value.slice(0, -1);
      out[body.slice(0, eq)] = value;
    }
    i += len;
  }
  return out;
}

function padded(size: number): number {
  return Math.ceil(size / 512) * 512;
}

async function extractTar(buf: Buffer, destDir: string): Promise<void> {
  let offset = 0;
  let files = 0;
  let extracted = 0;
  let wrote = 0;
  let longName: string | undefined;
  let paxNext: Record<string, string> | undefined;

  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;
    if (!checksumOk(header)) reject('That tar archive has a damaged header.');

    const type = header[156];
    const size = octal(header.subarray(124, 136));
    if (size > MAX_EXTRACT_BYTES) cap('That archive expands past 64 MB.');
    const dataEnd = offset + padded(size);
    if (dataEnd > buf.length) reject('That tar archive is truncated.');
    const data = buf.subarray(offset, offset + size);
    offset = dataEnd;

    if (type === 0x4c) {
      // GNU long name. The following header is the file.
      longName = cString(data);
      continue;
    }
    if (type === 0x4b) reject('That archive contains a link. Import a directory without links.');
    if (type === 0x78 || type === 0x67) {
      const records = parsePax(data);
      if (type === 0x78) paxNext = records;
      continue;
    }

    const pax = paxNext;
    paxNext = undefined;
    const prefix = cString(header.subarray(345, 500));
    const shortName = cString(header.subarray(0, 100));
    const name = pax?.path ?? longName ?? (prefix ? `${prefix}/${shortName}` : shortName);
    longName = undefined;
    if (pax?.size) {
      const declared = Number(pax.size);
      if (!Number.isFinite(declared) || declared < 0) reject('That tar entry does not say its size.');
      if (declared !== size) reject('That tar entry does not agree about its size.');
    }

    if (type === 0x31 || type === 0x32) {
      reject('That archive contains a link. Import a directory without links.');
    }
    if (type !== 0x30 && type !== 0x00 && type !== 0x35) {
      reject('That tar archive contains an entry Codeman will not extract.');
    }

    const parts = segmentsOf(name);
    if (type === 0x35) {
      await mkdirAt(destDir, parts);
      continue;
    }
    if (size > MAX_FILE_BYTES) cap('One file in that archive is larger than 8 MB.');
    files += 1;
    extracted += size;
    if (files > MAX_FILES) cap(`That archive has more than ${MAX_FILES} files.`);
    if (extracted > MAX_EXTRACT_BYTES) cap('That archive expands past 64 MB.');
    const mode = octal(header.subarray(100, 108));
    await writeFileAt(destDir, parts, Buffer.from(data), mode);
    wrote += 1;
  }
  if (wrote === 0) reject('That archive has no files.');
}
