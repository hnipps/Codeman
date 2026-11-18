/**
 * @fileoverview The bytes of files attached to Work items: `dataPath('canvas/<workspaceId>/work-files/<n>/<id>')`.
 *
 * What an item carries (`attachments` in `work.ts`) is the record; this module only admits, writes, finds and
 * removes bytes. A file is named by a random id, never by the name a person gave it, so no request carries a path.
 * It is admitted only when its extension is on the allowlist (the canvas image types plus the prompt-upload
 * documents, `ALLOWED_DOCUMENT_EXTS`), it is at most `MAX_WORK_FILE_BYTES`, and `imageMagicMatchesExt` agrees with
 * its bytes. Writes are a fresh `wx` temporary file renamed into place, 0600 in 0700 directories, and only on the
 * live deploy colour.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dataPath } from '../config/instance.js';
import { ALLOWED_DOCUMENT_EXTS, imageMagicMatchesExt } from '../web/routes/session-routes.js';
import { requireCanvasWriter } from './canvas-store.js';
import { IdSchema } from './model.js';
import { MAX_ATTACHMENT_NAME_CHARS, WORK_FILE_TYPES, workLine, type WorkAttachment } from './work.js';

export const MAX_WORK_FILE_BYTES = 8 * 1024 * 1024;

const TYPES = WORK_FILE_TYPES;
const IMAGE_EXTS = new Set(['.png', '.jpg', '.gif', '.webp']);
const ALLOWED = new Set([...IMAGE_EXTS, ...ALLOWED_DOCUMENT_EXTS]);
const IMAGE_TYPES = new Set([...IMAGE_EXTS].map((ext) => TYPES[ext]));
const TEXT_TYPES = new Set(['application/json', 'application/yaml', 'application/xml']);

export type WorkFileRefusal = { ok: false; reason: 'type' | 'size' | 'bytes' | 'empty' | 'name'; message: string };

/** The name a person gave, cut to its last path segment and one printable line. */
export function workFileName(raw: string): string {
  return workLine(raw.split(/[\\/]/).pop() ?? '').slice(0, MAX_ATTACHMENT_NAME_CHARS);
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : '';
  return ext === '.jpeg' ? '.jpg' : ext;
}

/** Whether these bytes may be attached under this name, and as which type. Nothing is written. */
export function admitWorkFile(
  rawName: string,
  data: Buffer
): { ok: true; name: string; type: string } | WorkFileRefusal {
  const name = workFileName(rawName);
  if (!name) return { ok: false, reason: 'name', message: 'A file name is needed' };
  const ext = extensionOf(name);
  if (!ALLOWED.has(ext) || !TYPES[ext])
    return {
      ok: false,
      reason: 'type',
      message: 'Attach an image (PNG, JPEG, GIF, WebP), a PDF, an Office file, a zip or a text file',
    };
  if (!data.length) return { ok: false, reason: 'empty', message: 'The file is empty' };
  if (data.length > MAX_WORK_FILE_BYTES)
    return { ok: false, reason: 'size', message: `Files are limited to ${MAX_WORK_FILE_BYTES / 1024 / 1024} MB` };
  if (!imageMagicMatchesExt(data, ext))
    return { ok: false, reason: 'bytes', message: 'The file is not the type its name says' };
  return { ok: true, name, type: TYPES[ext] };
}

const itemDir = (workspaceId: string, number: number): string =>
  dataPath('canvas', IdSchema.parse(workspaceId), 'work-files', String(number));
const ID = /^[a-f0-9]{32}$/;

/** Writes admitted bytes under a new id and returns the record to put on the item. */
export async function storeWorkFile(
  workspaceId: string,
  number: number,
  admitted: { name: string; type: string },
  data: Buffer,
  now: number
): Promise<WorkAttachment> {
  requireCanvasWriter();
  const id = randomBytes(16).toString('hex');
  const dir = itemDir(workspaceId, number);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = `${dir}/${id}`;
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, data, { mode: 0o600, flag: 'wx' });
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
  return { id, name: admitted.name, type: admitted.type, size: data.length, at: now };
}

/** The stored bytes of an attachment id, or null. The id is checked to be one, never used as given. */
export function findWorkFile(workspaceId: string, number: number, id: string): { path: string; size: number } | null {
  if (!ID.test(id) || !IdSchema.safeParse(workspaceId).success) return null;
  const path = `${itemDir(workspaceId, number)}/${id}`;
  try {
    const stat = statSync(path);
    return stat.isFile() ? { path, size: stat.size } : null;
  } catch {
    return null;
  }
}

export async function removeWorkFile(workspaceId: string, number: number, id: string): Promise<void> {
  if (!ID.test(id)) return;
  requireCanvasWriter();
  await rm(`${itemDir(workspaceId, number)}/${id}`, { force: true });
}

/**
 * How a stored file is sent back. Only images keep their own type; text is inert `text/plain`; everything else is a
 * download, so nothing a person attached ever runs as a page of this origin.
 */
export function servedAs(attachment: WorkAttachment): { type: string; download: boolean } {
  if (IMAGE_TYPES.has(attachment.type)) return { type: attachment.type, download: false };
  if (attachment.type.startsWith('text/') || TEXT_TYPES.has(attachment.type))
    return { type: 'text/plain; charset=utf-8', download: false };
  return { type: 'application/octet-stream', download: true };
}
