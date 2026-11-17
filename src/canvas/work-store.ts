/**
 * @fileoverview Work items on disk: `dataPath('canvas/<workspaceId>/work.json')`, the `WorkFile` of `work.ts`.
 *
 * A side file, like `conversations.json` and `review-notes.json`: the release before this one does not know it and
 * ignores it, so nothing about the board or its operation log changes. A missing file is empty. A file that does not
 * parse, or carries another version, is reported and never written over. Writes are synchronous (read, change,
 * write in one tick, so two requests cannot interleave), 0600 through a temporary file and a rename, and only on the
 * live deploy colour (`atomicWrite`).
 *
 * The file stays readable by the release before W-48 (self-building rule 5): `readWork` decodes the stored Todo items
 * into Needs refinement, Human required or Ready for work (`WorkFileSchema`), and every write encodes them back
 * (`encodeWorkFile`), so nothing above this module ever sees `todo`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dataPath } from '../config/instance.js';
import { atomicWrite } from './canvas-store.js';
import {
  emptyWorkFile,
  encodeWorkFile,
  WorkFileSchema,
  type WorkChange,
  type WorkFile,
  type WorkRefusal,
} from './work.js';

export const workPath = (workspaceId: string): string => dataPath('canvas', workspaceId, 'work.json');

export type WorkRead = { ok: true; file: WorkFile } | { ok: false; reason: 'unreadable' | 'newer' };

export function readWork(workspaceId: string): WorkRead {
  const path = workPath(workspaceId);
  if (!existsSync(path)) return { ok: true, file: emptyWorkFile() };
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (typeof json === 'object' && json !== null && 'version' in json && json.version !== 1)
    return { ok: false, reason: 'newer' };
  const parsed = WorkFileSchema.safeParse(json);
  return parsed.success ? { ok: true, file: parsed.data } : { ok: false, reason: 'unreadable' };
}

export const workFileProblem = (reason: 'unreadable' | 'newer'): string =>
  reason === 'newer'
    ? 'Work items were saved by a newer release; nothing was changed'
    : 'The work items file could not be read; nothing was changed';

type WorkListener = (workspaceId: string, change: WorkChange) => void;
const listeners = new Set<WorkListener>();
/**
 * Called after every write of an item, whichever route or routine made it, so a module that follows items needs no
 * list of call sites. A listener that throws is ignored. Returns the unsubscribe.
 */
export function subscribeWork(listener: WorkListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Applies one change and writes it. A refusal, a duplicate or a change that changed nothing writes nothing. */
export function changeWork(
  workspaceId: string,
  change: (file: WorkFile) => WorkChange | WorkRefusal
): WorkChange | WorkRefusal | { ok: false; code: 'FILE'; message: string } {
  const read = readWork(workspaceId);
  if (!read.ok) return { ok: false, code: 'FILE', message: workFileProblem(read.reason) };
  const result = change(read.file);
  if (result.ok && result.file !== read.file) {
    atomicWrite(workPath(workspaceId), encodeWorkFile(result.file));
    for (const listener of listeners) {
      try {
        listener(workspaceId, result);
      } catch {
        // A follower's failure never fails the write that already happened.
      }
    }
  }
  return result;
}
