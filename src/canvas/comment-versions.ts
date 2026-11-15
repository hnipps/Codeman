/**
 * @fileoverview Which version of a stored prototype a comment was made on: a side file per workspace,
 * `dataPath('canvas/<workspaceId>/comment-versions.json')` = `{ version: 1, versions: { [commentId]: number } }`.
 *
 * A comment belongs to its embed, not to one version, so it carries over to every version published into that
 * embed. The thread still says which version a person or an agent was looking at ("on v2"), and the crop of an
 * element that a later version no longer has is drawn from that version.
 *
 * It is a side file for the same reason as `comment-anchors.json`: the stored comment and the operation log are
 * parsed strictly by the release before this one, so neither can gain a key. A release that does not know this
 * file ignores it.
 *
 * The version is stamped by the server when the comment is written, from the address the embed showed at that
 * moment, so it is never something a caller chooses. A comment on any other object gets no entry. Writes are
 * synchronous, 0600 through a temporary file and a rename, and only on the live deploy colour (`atomicWrite`).
 */
import { readFileSync, statSync } from 'node:fs';
import { dataPath } from '../config/instance.js';
import { atomicWrite } from './canvas-store.js';
import { IdSchema, type CanvasState } from './model.js';
import { parsePrototypeAddress } from './prototype-address.js';

export const MAX_COMMENT_VERSIONS = 5000;
export const commentVersionsPath = (workspaceId: string): string =>
  dataPath('canvas', IdSchema.parse(workspaceId), 'comment-versions.json');

type VersionsFile = { ok: true; raw: Record<string, unknown>; entries: Record<string, unknown> } | { ok: false };

function readFile(workspaceId: string): VersionsFile {
  const path = commentVersionsPath(workspaceId);
  try {
    statSync(path);
  } catch {
    return { ok: true, raw: {}, entries: {} };
  }
  try {
    const json: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return { ok: false };
    const raw = json as Record<string, unknown>;
    const entries = raw.versions;
    if (raw.version !== 1 || typeof entries !== 'object' || entries === null || Array.isArray(entries))
      return { ok: false };
    return { ok: true, raw, entries: entries as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

const isVersion = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1_000_000;

/** The version each existing comment was made on, by comment id. Comments on anything but a prototype are absent. */
export function readCommentVersions(workspaceId: string, state: CanvasState): Record<string, number> {
  const file = readFile(workspaceId);
  if (!file.ok) return {};
  const present = new Set(state.comments.map((c) => c.id));
  const versions: Record<string, number> = {};
  for (const [commentId, value] of Object.entries(file.entries))
    if (present.has(commentId) && isVersion(value)) versions[commentId] = value;
  return versions;
}

/** The prototype version the object shows now, or null when it is not an embed of a stored prototype. */
export function shownVersion(state: CanvasState, objectId: string): number | null {
  const object = state.objects[objectId];
  if (!object || object.deletedAt || object.type !== 'embed') return null;
  const url = (object.content as { url?: unknown }).url;
  return typeof url === 'string' ? (parsePrototypeAddress(url)?.version ?? null) : null;
}

/**
 * Records the version a just-written comment was made on, read from its object's address. Does nothing for a
 * comment on anything but a prototype embed, or when the entry already says so; never writes over a file it
 * cannot read. The entries of removed comments go first past the bound, then the oldest.
 */
export function stampCommentVersion(workspaceId: string, state: CanvasState, commentId: string): boolean {
  const comment = state.comments.find((c) => c.id === commentId);
  const version = comment ? shownVersion(state, comment.objectId) : null;
  if (version === null) return false;
  const file = readFile(workspaceId);
  if (!file.ok) return false;
  if (file.entries[commentId] === version) return true;
  const entries = { ...file.entries };
  delete entries[commentId];
  entries[commentId] = version;
  const present = new Set(state.comments.map((c) => c.id));
  const ids = Object.keys(entries);
  const removedFirst = [...ids.filter((id) => !present.has(id)), ...ids.filter((id) => present.has(id))];
  for (const id of removedFirst.slice(0, Math.max(0, ids.length - MAX_COMMENT_VERSIONS)))
    if (id !== commentId) delete entries[id];
  atomicWrite(commentVersionsPath(workspaceId), { ...file.raw, version: 1, versions: entries });
  return true;
}
