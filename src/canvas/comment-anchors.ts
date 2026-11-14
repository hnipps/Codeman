/**
 * @fileoverview Which element inside a live frame a comment is about: a side file per workspace,
 * `dataPath('canvas/<workspaceId>/comment-anchors.json')` = `{ version: 1, anchors: { [commentId]: ElementRef } }`.
 *
 * It is a side file because the stored comment and the operation log are parsed strictly by the release before this
 * one, so neither can gain a key. A release that does not know this file ignores it and shows the comments alone.
 *
 * An anchor follows its comment id. It is shown only while a comment with that id sits on the anchor's object, so
 * removing the comment hides it, and an undo that brings the same comment back shows it again. The file keeps the
 * anchors of removed comments until it is full; then those go first, and after them the oldest.
 *
 * Every string in an anchor was written by the page in the frame: `textContent` only in a browser, `plainLine` before
 * an agent prompt. Writes are synchronous (one at a time by construction), 0600 through a temporary file and a
 * rename, and only on the live deploy colour.
 */
import { readFileSync, statSync } from 'node:fs';
import { dataPath } from '../config/instance.js';
import { atomicWrite } from './canvas-store.js';
import { ElementRefSchema, type ElementRef } from './element-ref.js';
import { IdSchema, type CanvasState } from './model.js';

export const MAX_COMMENT_ANCHORS = 2000;
/** The file is read and written whole on request paths, so its size is bounded as well as its count. */
export const MAX_COMMENT_ANCHOR_BYTES = 4 * 1024 * 1024;
export const commentAnchorsPath = (workspaceId: string): string =>
  dataPath('canvas', IdSchema.parse(workspaceId), 'comment-anchors.json');

type AnchorsFile =
  /** `raw` is the file as parsed, kept so a write carries over what this release does not understand. */
  | { ok: true; raw: Record<string, unknown>; entries: Record<string, unknown> }
  /** Not JSON, not this shape, or written by a later release: read as empty and never written over. */
  | { ok: false };

/** The last parse of each file, reused while the file on disk is the one that was parsed. Callers never mutate it. */
const parsed = new Map<string, { stamp: string; file: AnchorsFile }>();
const MAX_PARSED_FILES = 16;

function readFile(workspaceId: string): AnchorsFile {
  const path = commentAnchorsPath(workspaceId);
  let stamp: string;
  try {
    const info = statSync(path);
    stamp = `${info.ino}:${info.size}:${info.mtimeMs}`;
  } catch {
    return { ok: true, raw: {}, entries: {} };
  }
  const held = parsed.get(path);
  if (held?.stamp === stamp) return held.file;
  const file = parseFile(path);
  parsed.delete(path);
  parsed.set(path, { stamp, file });
  if (parsed.size > MAX_PARSED_FILES) parsed.delete(parsed.keys().next().value as string);
  return file;
}

function parseFile(path: string): AnchorsFile {
  try {
    const json: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return { ok: false };
    const raw = json as Record<string, unknown>;
    const entries = raw.anchors;
    if (raw.version !== 1 || typeof entries !== 'object' || entries === null || Array.isArray(entries))
      return { ok: false };
    return { ok: true, raw, entries: entries as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

const commentsById = (state: CanvasState): Map<string, string> =>
  new Map(state.comments.map((c) => [c.id, c.objectId]));

/**
 * The anchors of the comments that exist now, by comment id. An entry this release cannot read is left out, and so
 * is one whose comment is gone or sits on another object.
 */
export function readCommentAnchors(workspaceId: string, state: CanvasState): Record<string, ElementRef> {
  const file = readFile(workspaceId);
  if (!file.ok) return {};
  const comments = commentsById(state);
  const anchors: Record<string, ElementRef> = {};
  for (const [commentId, value] of Object.entries(file.entries)) {
    const objectId = comments.get(commentId);
    if (objectId === undefined) continue;
    const parsed = ElementRefSchema.safeParse(value);
    if (parsed.success && parsed.data.objectId === objectId) anchors[commentId] = parsed.data;
  }
  return anchors;
}

/**
 * Makes the stored anchor of one comment equal to `element`: set, replaced, or removed when there is none. Returns
 * whether the file now says so. It does nothing when the file already does, so a repeat is free, and it returns
 * false without writing when the file on disk cannot be read as version 1.
 */
export function setCommentAnchor(
  workspaceId: string,
  state: CanvasState,
  commentId: string,
  element: ElementRef | undefined
): boolean {
  const file = readFile(workspaceId);
  if (!file.ok) return false;
  const stored = file.entries[commentId];
  if (element === undefined ? stored === undefined : JSON.stringify(stored) === JSON.stringify(element)) return true;
  const entries = { ...file.entries };
  delete entries[commentId];
  if (element !== undefined) {
    entries[commentId] = element;
    const comments = commentsById(state);
    const ids = Object.keys(entries);
    const removedFirst = [...ids.filter((id) => !comments.has(id)), ...ids.filter((id) => comments.has(id))];
    for (const id of removedFirst.slice(0, Math.max(0, ids.length - MAX_COMMENT_ANCHORS)))
      if (id !== commentId) delete entries[id];
    const size = (id: string): number => Buffer.byteLength(JSON.stringify(entries[id])) + id.length + 4;
    let bytes = Object.keys(entries).reduce((sum, id) => sum + size(id), 0);
    for (const id of removedFirst) {
      if (bytes <= MAX_COMMENT_ANCHOR_BYTES) break;
      if (id === commentId || !(id in entries)) continue;
      bytes -= size(id);
      delete entries[id];
    }
  }
  atomicWrite(commentAnchorsPath(workspaceId), { ...file.raw, version: 1, anchors: entries });
  return true;
}
