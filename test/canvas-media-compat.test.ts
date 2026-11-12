/**
 * Roll-forward safety for canvas media: what this release writes for images, links,
 * embeds, a link turned into an embed and a sub-canvas still reads in the previous
 * release (frozen parser in test/fixtures/canvas-model-previous.ts).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CanvasStore } from '../src/canvas/canvas-store.js';
import { CommandSchema } from '../src/canvas/operations.js';
import * as previous from './fixtures/canvas-model-previous.js';
import { human } from './canvas-fixtures.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-media-compat-'));
  vi.stubEnv('CODEMAN_DATA_DIR', dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const asset = 'a'.repeat(64);
const make = (id: string, content: Record<string, unknown>, parentId: string | null = null) =>
  CommandSchema.parse({
    kind: 'create',
    opId: `create-${id}`,
    objectId: id,
    patch: { parentId, order: 0, position: { x: 0, y: 0 }, size: { width: 200, height: 120 }, content },
  });
// The previous release's log record shape (operations.ts at that release), over its frozen object schema.
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
        .passthrough()
    ),
  })
  .passthrough();

describe('canvas media written by this release', () => {
  it('parses and validates as known objects in the previous release, log and snapshot alike', () => {
    const store = new CanvasStore('compat');
    store.append(
      [
        make('img', { type: 'image', url: '', alt: 'Chart', assetId: asset }),
        make('link', {
          type: 'link',
          url: 'https://example.com/',
          label: 'Example',
          preview: 'ready',
          thumbnailAssetId: asset,
        }),
        make('bare', { type: 'link', url: 'https://example.com/a', preview: 'unavailable' }),
        make('emb', { type: 'link', url: 'https://example.com/b', label: 'B' }),
        make('sub', { type: 'subcanvas', workspaceId: 'compat', label: 'Inside' }),
        make('child', { type: 'text', text: 'In the sub-canvas' }, 'sub'),
      ],
      human
    );
    store.append(
      [
        {
          kind: 'update',
          opId: 'to-embed',
          objectId: 'emb',
          patch: { content: { type: 'embed', url: 'https://example.com/b', label: 'B', thumbnailAssetId: asset } },
        },
      ],
      human
    );
    store.snapshot();
    const lines = readFileSync(store.logPath, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      // The previous release reads a line as one record or as an envelope of several.
      const parsed = JSON.parse(line) as { operations?: unknown[] };
      for (const operation of parsed.operations ?? [parsed])
        expect(PreviousOperationSchema.safeParse(operation).success).toBe(true);
    }
    const snapshot = JSON.parse(readFileSync(store.snapshotPath, 'utf8')) as { state: unknown };
    const state = previous.StateSchema.parse(snapshot.state);
    for (const object of Object.values(state.objects)) expect(previous.validateKnownObject(object)).toBe(true);
    expect(state.objects.emb.type).toBe('embed');
    expect(previous.knownContentFields(state.objects.img.content)).toEqual({ type: 'image', url: '', alt: 'Chart' });
  });
});
