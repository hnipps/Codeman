/**
 * @fileoverview Stored prototypes: folders of static files an agent publishes, kept under
 * `dataPath('canvas/<workspaceId>/prototypes/<id>/')` and served by Codeman itself.
 *
 * Layout per prototype: `meta.json` plus one folder per published version, named by its number.
 * A version is written into a temporary folder and renamed into place, and is never changed after
 * that, so an embed address (`prototype-address.ts`) always names the same bytes.
 *
 * Every path here is built from a validated id, a version number and a file path checked by
 * `prototypeFileRefusal`. No caller hands this module a filesystem path.
 */
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, sep } from 'node:path';
import { z } from 'zod';
import {
  PROTOTYPE_MAX_FILES,
  PROTOTYPE_MAX_FILE_BYTES,
  PROTOTYPE_MAX_VERSION_BYTES,
  PROTOTYPE_VERSIONS_KEPT,
  PROTOTYPES_PER_WORKSPACE,
  canvasPrototypeQuotaBytes,
} from '../config/canvas-limits.js';
import { dataPath } from '../config/instance.js';
import { deployRole, DeployRoleRefusal } from '../deploy-role.js';
import { AuthorSchema, IdSchema, type Author, type CanvasState } from './model.js';
import { isPrototypeEntry, isPrototypeId, parsePrototypeAddress } from './prototype-address.js';

/** What a prototype may hold, with the type each file is served as. Anything else is refused at publish. */
export const PROTOTYPE_FILE_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  wasm: 'application/wasm',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
};

/**
 * The response policy of every served prototype file: the `sandbox` directive alone, the same value
 * a rendered HTML file gets (`HTML_VIEW_CSP`, where the owner's decision is recorded). No
 * `allow-same-origin`, so the page has an opaque origin and cannot reach Codeman, and no fetch
 * directive, so its own network access stays open. Change neither without the owner.
 */
export const PROTOTYPE_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads';

const FILE_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const extensionOf = (path: string): string => extname(path).toLowerCase().replace(/^\./, '');

export type PrototypeRefusal =
  | 'id'
  | 'entry'
  | 'path'
  | 'type'
  | 'size'
  | 'count'
  | 'empty'
  | 'quota'
  | 'limit'
  | 'in-use'
  | 'not-found';
export class PrototypeRefusedError extends Error {
  constructor(
    readonly reason: PrototypeRefusal,
    message: string
  ) {
    super(message);
  }
}

const megabytes = (bytes: number): string => `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;

/** Why one file cannot be part of a prototype, or null when it can. */
export function prototypeFileRefusal(
  path: string,
  bytes: number
): { reason: PrototypeRefusal; message: string } | null {
  if (path.length > 256 || !FILE_PATH.test(path))
    return {
      reason: 'path',
      message: `${JSON.stringify(path.slice(0, 80))} is not a usable file path: use letters, digits, dot, dash and underscore, with / between folders`,
    };
  if (path.split('/').some((part) => part.startsWith('.')))
    return { reason: 'path', message: `${path} is hidden (a name starting with a dot) and cannot be published` };
  if (!PROTOTYPE_FILE_TYPES[extensionOf(path)])
    return {
      reason: 'type',
      message: `${path} is not a file type a prototype can hold (${Object.keys(PROTOTYPE_FILE_TYPES).join(', ')})`,
    };
  if (bytes > PROTOTYPE_MAX_FILE_BYTES)
    return { reason: 'size', message: `${path} is over the ${megabytes(PROTOTYPE_MAX_FILE_BYTES)} limit for one file` };
  return null;
}

/** Refuse a file set that breaks a limit, before anything is read in full or written. */
export function checkPrototypeFiles(files: { path: string; bytes: number }[], entry: string): void {
  if (!isPrototypeEntry(entry))
    throw new PrototypeRefusedError('entry', 'entry must be an .html file inside the prototype, such as index.html');
  if (!files.length) throw new PrototypeRefusedError('empty', 'A prototype needs at least one file');
  if (files.length > PROTOTYPE_MAX_FILES)
    throw new PrototypeRefusedError('count', `A prototype holds at most ${PROTOTYPE_MAX_FILES} files`);
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    const refusal = prototypeFileRefusal(file.path, file.bytes);
    if (refusal) throw new PrototypeRefusedError(refusal.reason, refusal.message);
    if (seen.has(file.path.toLowerCase())) throw new PrototypeRefusedError('path', `${file.path} is listed twice`);
    seen.add(file.path.toLowerCase());
    total += file.bytes;
  }
  if (total > PROTOTYPE_MAX_VERSION_BYTES)
    throw new PrototypeRefusedError(
      'size',
      `The prototype is ${megabytes(total)}; one version is limited to ${megabytes(PROTOTYPE_MAX_VERSION_BYTES)}`
    );
  if (!files.some((file) => file.path === entry))
    throw new PrototypeRefusedError('entry', `The entry file ${entry} is not among the published files`);
}

/** A prototype id made from a name: lower case, dashes, at most 40 characters. */
export function prototypeSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'prototype';
}

/** Versions to delete: everything older than the newest `keep`, except a version something still points at. */
export function versionsToDrop(versions: number[], keep: number, referenced: ReadonlySet<number>): number[] {
  const newest = new Set([...versions].sort((a, b) => b - a).slice(0, keep));
  return versions.filter((version) => !newest.has(version) && !referenced.has(version));
}

export type PrototypeReference = { objectId: string; version: number; entry: string; deleted: boolean };
/** Embed objects whose address names a prototype, by prototype id. Deleted objects are included and marked. */
export function prototypeReferences(state: CanvasState): Map<string, PrototypeReference[]> {
  const found = new Map<string, PrototypeReference[]>();
  for (const object of Object.values(state.objects)) {
    if (object.type !== 'embed' || typeof object.content.url !== 'string') continue;
    const address = parsePrototypeAddress(object.content.url);
    if (!address) continue;
    const list = found.get(address.id) ?? [];
    list.push({
      objectId: object.id,
      version: address.version,
      entry: address.entry,
      deleted: object.deletedAt !== null,
    });
    found.set(address.id, list);
  }
  return found;
}

const VersionSchema = z.object({
  version: z.number().int().positive(),
  entry: z.string(),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  author: AuthorSchema,
});
const MetaSchema = z.object({
  format: z.literal(1),
  id: z.string(),
  name: z.string(),
  latest: z.number().int().nonnegative(),
  entry: z.string(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  author: AuthorSchema,
  versions: z.array(VersionSchema),
});
export type PrototypeMeta = z.infer<typeof MetaSchema>;
export type PrototypeFile = { path: string; data: Buffer };

const prototypesDir = (workspaceId: string): string => dataPath('canvas', IdSchema.parse(workspaceId), 'prototypes');
function prototypeDir(workspaceId: string, id: string): string {
  if (!isPrototypeId(id))
    throw new PrototypeRefusedError('id', 'A prototype id is lower-case letters, digits and dashes');
  return join(prototypesDir(workspaceId), id);
}
const versionDir = (workspaceId: string, id: string, version: number): string =>
  join(prototypeDir(workspaceId, id), String(version));

function requireWriter(): void {
  if (!deployRole.allows('persist')) throw new DeployRoleRefusal(deployRole.current, 'may write canvas data');
}

/** One write at a time per workspace, so two publishes cannot both pass a limit or take one version number. */
const writing = new Map<string, Promise<unknown>>();
function serialized<T>(workspaceId: string, task: () => Promise<T>): Promise<T> {
  const run = (writing.get(workspaceId) ?? Promise.resolve()).then(task, task);
  const settled = run.catch(() => undefined);
  writing.set(workspaceId, settled);
  void settled.then(() => {
    if (writing.get(workspaceId) === settled) writing.delete(workspaceId);
  });
  return run;
}

async function writeMeta(dir: string, meta: PrototypeMeta): Promise<void> {
  const path = join(dir, 'meta.json');
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(meta), { mode: 0o600, flag: 'wx' });
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
}

/** A prototype's record, or null when it is not stored (or its record does not read). */
export async function readPrototype(workspaceId: string, id: string): Promise<PrototypeMeta | null> {
  if (!isPrototypeId(id) || !IdSchema.safeParse(workspaceId).success) return null;
  try {
    const parsed = MetaSchema.safeParse(
      JSON.parse(await readFile(join(prototypeDir(workspaceId, id), 'meta.json'), 'utf8'))
    );
    return parsed.success && parsed.data.id === id ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function listPrototypes(workspaceId: string): Promise<PrototypeMeta[]> {
  let names: string[];
  try {
    names = await readdir(prototypesDir(workspaceId));
  } catch {
    return [];
  }
  const metas = await Promise.all(names.filter(isPrototypeId).map((id) => readPrototype(workspaceId, id)));
  return metas.filter((meta): meta is PrototypeMeta => meta !== null).sort((a, b) => a.id.localeCompare(b.id));
}

/** The highest version number a prototype's folder has ever held, so a number is never used twice. */
async function highestVersion(dir: string, meta: PrototypeMeta | null): Promise<number> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    /* A new prototype. */
  }
  const onDisk = names.filter((name) => /^[1-9][0-9]{0,8}$/.test(name)).map(Number);
  return Math.max(0, meta?.latest ?? 0, ...onDisk);
}

/**
 * Store one new version and return the prototype's record with it. `referenced` is the set of this
 * prototype's versions some canvas object points at; they outlive the newest-N rule.
 */
export async function publishPrototype(
  workspaceId: string,
  input: { id: string; name: string; entry: string; files: PrototypeFile[]; author: Author },
  referenced: ReadonlySet<number> = new Set()
): Promise<{ meta: PrototypeMeta; version: number }> {
  const dir = prototypeDir(workspaceId, input.id);
  checkPrototypeFiles(
    input.files.map((file) => ({ path: file.path, bytes: file.data.length })),
    input.entry
  );
  requireWriter();
  const bytes = input.files.reduce((sum, file) => sum + file.data.length, 0);
  return serialized(workspaceId, async () => {
    const all = await listPrototypes(workspaceId);
    const existing = all.find((meta) => meta.id === input.id) ?? null;
    if (!existing && all.length >= PROTOTYPES_PER_WORKSPACE)
      throw new PrototypeRefusedError(
        'limit',
        `This canvas holds ${PROTOTYPES_PER_WORKSPACE} prototypes, the most it can. Remove one with canvas_prototype remove.`
      );
    const quota = canvasPrototypeQuotaBytes();
    const stored = all.reduce((sum, meta) => sum + meta.versions.reduce((s, v) => s + v.bytes, 0), 0);
    if (stored + bytes > quota)
      throw new PrototypeRefusedError(
        'quota',
        `This canvas has reached its ${megabytes(quota)} prototype limit. Remove a prototype it no longer shows.`
      );
    const version = (await highestVersion(dir, existing)) + 1;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    for (const name of await readdir(dir))
      if (name.startsWith('.tmp-')) await rm(join(dir, name), { recursive: true, force: true });
    const tmp = join(dir, `.tmp-${randomUUID()}`);
    try {
      for (const file of input.files) {
        const target = join(tmp, ...file.path.split('/'));
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, file.data, { mode: 0o600, flag: 'wx' });
      }
      await rename(tmp, join(dir, String(version)));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
    const now = Date.now();
    const versions = [
      ...(existing?.versions ?? []),
      { version, entry: input.entry, files: input.files.length, bytes, createdAt: now, author: input.author },
    ];
    const dropped = new Set(
      versionsToDrop(
        versions.map((v) => v.version),
        PROTOTYPE_VERSIONS_KEPT,
        referenced
      )
    );
    const meta: PrototypeMeta = {
      format: 1,
      id: input.id,
      name: input.name,
      latest: version,
      entry: input.entry,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      author: existing?.author ?? input.author,
      versions: versions.filter((v) => !dropped.has(v.version)),
    };
    await writeMeta(dir, meta);
    for (const old of dropped) await rm(join(dir, String(old)), { recursive: true, force: true });
    return { meta, version };
  });
}

/** Take back a version whose canvas operation was refused. The number is not used again. */
export async function discardPrototypeVersion(workspaceId: string, id: string, version: number): Promise<void> {
  requireWriter();
  const dir = prototypeDir(workspaceId, id);
  await serialized(workspaceId, async () => {
    const meta = await readPrototype(workspaceId, id);
    if (!meta) return;
    const versions = meta.versions.filter((v) => v.version !== version);
    if (!versions.length) {
      // Nothing was ever shown from it, so the record goes too and does not count toward the limit.
      await rm(dir, { recursive: true, force: true });
      return;
    }
    await rm(join(dir, String(version)), { recursive: true, force: true });
    await writeMeta(dir, { ...meta, versions, entry: versions.at(-1)?.entry ?? meta.entry });
  });
}

/**
 * Delete a prototype and every version of it. `inUse` is asked inside the write queue, after any publish
 * ahead of this call has placed its object, and a prototype in use is left alone (`'in-use'`).
 */
export async function removePrototype(
  workspaceId: string,
  id: string,
  inUse: () => boolean = () => false
): Promise<boolean | 'in-use'> {
  requireWriter();
  const dir = prototypeDir(workspaceId, id);
  return serialized(workspaceId, async () => {
    // A publish places its object synchronously once its own queued write settles. One turn of the event
    // loop lets every such continuation run before the question is asked.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (inUse()) return 'in-use';
    const found = await stat(dir).then(
      (info) => info.isDirectory(),
      () => false
    );
    if (found) await rm(dir, { recursive: true, force: true });
    return found;
  });
}

/**
 * Whether this workspace holds that version with that entry file. Synchronous, because the
 * operation validator asks it while it decides a write: one stat of a path built from checked parts.
 */
export function prototypeVersionStored(workspaceId: string, id: string, version: number, entry: string): boolean {
  if (!IdSchema.safeParse(workspaceId).success || !isPrototypeId(id) || !isPrototypeEntry(entry)) return false;
  if (!Number.isInteger(version) || version < 1) return false;
  try {
    return statSync(join(versionDir(workspaceId, id, version), ...entry.split('/'))).isFile();
  } catch {
    return false;
  }
}

/**
 * One file of one version, for serving. The requested path passes the publish rules again, symlinks
 * are resolved, and the result must be a regular file still inside that version's own folder.
 */
export async function findPrototypeFile(
  workspaceId: string,
  id: string,
  version: number,
  path: string
): Promise<{ path: string; size: number; mime: string } | null> {
  if (!IdSchema.safeParse(workspaceId).success || !isPrototypeId(id)) return null;
  if (!Number.isInteger(version) || version < 1 || prototypeFileRefusal(path, 0)) return null;
  try {
    const root = await realpath(versionDir(workspaceId, id, version));
    const resolved = await realpath(join(root, ...path.split('/')));
    const landed = relative(root, resolved);
    if (!landed || landed.startsWith('..') || landed.split(sep).some((part) => part.startsWith('.'))) return null;
    const mime = PROTOTYPE_FILE_TYPES[extensionOf(resolved)];
    const info = await stat(resolved);
    if (!mime || !info.isFile() || info.size > PROTOTYPE_MAX_FILE_BYTES) return null;
    return { path: resolved, size: info.size, mime };
  } catch {
    return null;
  }
}

/** The bytes of one file of one version, or null when `findPrototypeFile` would not serve it. */
export async function readPrototypeFile(
  workspaceId: string,
  id: string,
  version: number,
  path: string
): Promise<{ mime: string; bytes: Buffer } | null> {
  const file = await findPrototypeFile(workspaceId, id, version, path);
  if (!file) return null;
  try {
    return { mime: file.mime, bytes: await readFile(file.path) };
  } catch {
    return null;
  }
}
