/**
 * Roll-forward safety for canvas history: the records this release writes for undo and redo, repeated on one
 * object, still read in the previous release (frozen parser in test/fixtures/canvas-model-previous.ts).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CanvasStore } from '../src/canvas/canvas-store.js';
import { historyCommands } from '../src/canvas/commands.js';
import * as previous from './fixtures/canvas-model-previous.js';
import { create, human } from './canvas-fixtures.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-history-compat-'));
  vi.stubEnv('CODEMAN_DATA_DIR', dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

// The previous release's log record shape (operations.ts at that release), strict so an added key fails here.
const PreviousOperationSchema = z
  .object({
    seq: z.number().int().positive(),
    opId: previous.IdSchema,
    author: previous.AuthorSchema,
    kind: z.string(),
    objectId: previous.IdSchema,
    patch: z.unknown(),
    prev: z.array(
      z
        .object({
          objectId: previous.IdSchema,
          before: previous.StoredObjectSchema.nullable(),
          after: previous.StoredObjectSchema,
        })
        .strict()
    ),
  })
  .strict();

describe('canvas history written by this release', () => {
  it('writes undo and redo records the previous release parses, with no new field', () => {
    const store = new CanvasStore('compat');
    const write = (commands: Parameters<CanvasStore['append']>[0]) => {
      const result = store.appendExpanded(commands, human);
      if (!result.ok) throw new Error(JSON.stringify(result.reasons));
      return result.sequences;
    };
    const step = (sequences: number[]) =>
      write(historyCommands(store.read(), store.records(sequences), sequences, human));
    const resize = (opId: string, width: number) =>
      write([{ kind: 'update', opId, objectId: 'a', patch: { size: { width, height: 80 } } }]);
    write([create('a')]);
    const first = resize('r1', 200);
    const second = resize('r2', 300);
    const undoSecond = step(second);
    const undoFirst = step(first);
    step(undoFirst);
    step(undoSecond);
    expect(store.read().objects.a.size).toEqual({ width: 300, height: 80 });

    const lines = readFileSync(store.logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(7);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { operations?: unknown[] };
      for (const operation of parsed.operations ?? [parsed]) {
        const read = PreviousOperationSchema.safeParse(operation);
        expect(read.success, JSON.stringify(read.error?.issues)).toBe(true);
      }
    }
  });
});
