/**
 * @fileoverview Routines on disk, two side files per workspace with one writer each (`routines.ts` has the shapes):
 *
 * - `dataPath('canvas/<workspaceId>/routines.json')`: the definitions, written only by the routine routes.
 * - `dataPath('canvas/<workspaceId>/routine-state.json')`: the last due time and recent fires, written only by the
 *   routine runner.
 *
 * The release before this one does not know either file and ignores both. A missing file is empty. A file that does
 * not parse, or carries another version, is reported and never written over. Writes are synchronous (read, change,
 * write in one tick), 0600 through a temporary file and a rename, and only on the live deploy colour (`atomicWrite`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dataPath } from '../config/instance.js';
import { atomicWrite } from './canvas-store.js';
import {
  emptyRoutineFile,
  emptyRoutineState,
  RoutineFileSchema,
  RoutineStateFileSchema,
  type RoutineChange,
  type RoutineFile,
  type RoutineStateFile,
} from './routines.js';

export const routinesPath = (workspaceId: string): string => dataPath('canvas', workspaceId, 'routines.json');
export const routineStatePath = (workspaceId: string): string => dataPath('canvas', workspaceId, 'routine-state.json');

type Read<T> = { ok: true; file: T } | { ok: false; reason: 'unreadable' | 'newer' };

function readFile<T>(path: string, empty: () => T, parse: (json: unknown) => T | undefined): Read<T> {
  if (!existsSync(path)) return { ok: true, file: empty() };
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (typeof json === 'object' && json !== null && 'version' in json && json.version !== 1)
    return { ok: false, reason: 'newer' };
  const file = parse(json);
  return file ? { ok: true, file } : { ok: false, reason: 'unreadable' };
}

export const readRoutines = (workspaceId: string): Read<RoutineFile> =>
  readFile(routinesPath(workspaceId), emptyRoutineFile, (json) => RoutineFileSchema.safeParse(json).data);
export const readRoutineState = (workspaceId: string): Read<RoutineStateFile> =>
  readFile(routineStatePath(workspaceId), emptyRoutineState, (json) => RoutineStateFileSchema.safeParse(json).data);

export const routineFileProblem = (reason: 'unreadable' | 'newer'): string =>
  reason === 'newer'
    ? 'FILE: routines were saved by a newer release; nothing was changed'
    : 'FILE: the routines file could not be read; nothing was changed';

/** Applies one change to `routines.json`. A refusal or a duplicate writes nothing. */
export function changeRoutines(
  workspaceId: string,
  change: (file: RoutineFile) => RoutineChange
): RoutineChange | { ok: false; code: 'FILE'; message: string } {
  const read = readRoutines(workspaceId);
  if (!read.ok) return { ok: false, code: 'FILE', message: routineFileProblem(read.reason) };
  const result = change(read.file);
  if (result.ok && !result.duplicate) atomicWrite(routinesPath(workspaceId), result.file);
  return result;
}

/** Applies one change to `routine-state.json`; false when the file cannot be read (it is then never written over). */
export function changeRoutineState(workspaceId: string, change: (file: RoutineStateFile) => RoutineStateFile): boolean {
  const read = readRoutineState(workspaceId);
  if (!read.ok) return false;
  atomicWrite(routineStatePath(workspaceId), change(read.file));
  return true;
}
