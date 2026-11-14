/**
 * Roll-back safety for prototypes: the canvas records a publish writes are ordinary `embed` records the
 * previous release reads (frozen parser in test/fixtures/canvas-model-previous.ts), with no new key and
 * no new object type. That release shows the embed as unavailable; it must not fail to read the workspace.
 */
import Fastify from 'fastify';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CanvasStores } from '../src/canvas/canvas-store.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { registerCanvasRoutes } from '../src/web/routes/canvas-routes.js';
import * as previous from './fixtures/canvas-model-previous.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-prototype-compat-'));
  vi.stubEnv('CODEMAN_DATA_DIR', dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

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

describe('a prototype published by this release', () => {
  it('leaves a log and a snapshot the previous release parses, as a plain embed', async () => {
    const workspace = workspaceForCase('compat');
    const stores = new CanvasStores();
    const app = Fastify();
    app.addHook('onRequest', async (req) => {
      req.authUser = { username: 'user-a', role: 'user' };
    });
    registerCanvasRoutes(app, {
      sessions: new Map(),
      canvasEnabled: async () => true,
      canvasStores: async () => stores,
      broadcast: vi.fn(),
    });
    await app.ready();
    try {
      const base = `/api/canvas/${workspace.id}`;
      const files = (text: string) => [{ path: 'index.html', base64: Buffer.from(text).toString('base64') }];
      const first = await app.inject({
        method: 'POST',
        url: `${base}/prototypes`,
        payload: { name: 'Demo', files: files('one'), requestId: crypto.randomUUID() },
      });
      expect(first.statusCode, first.body).toBe(200);
      const second = await app.inject({
        method: 'POST',
        url: `${base}/prototypes`,
        payload: { id: 'demo', files: files('two') },
      });
      expect(second.statusCode, second.body).toBe(200);
      const undo = await app.inject({
        method: 'POST',
        url: `${base}/command`,
        payload: { tool: 'canvas_history', arguments: { action: 'undo', sequences: second.json().data.sequences } },
      });
      expect(undo.statusCode, undo.body).toBe(200);

      const store = stores.get(workspace.id);
      store.snapshot();
      const lines = readFileSync(store.logPath, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(3);
      for (const line of lines) {
        const parsed = JSON.parse(line) as { operations?: unknown[] };
        for (const operation of parsed.operations ?? [parsed]) {
          const read = PreviousOperationSchema.safeParse(operation);
          expect(read.success, JSON.stringify(read.error?.issues)).toBe(true);
        }
      }
      const snapshot = JSON.parse(readFileSync(store.snapshotPath, 'utf8')) as { state: unknown };
      const state = previous.StateSchema.parse(snapshot.state);
      const object = state.objects[first.json().data.objectId];
      expect(object.type).toBe('embed');
      expect(previous.validateKnownObject(object)).toBe(true);
      // Every key the object and its content carry is one the previous release already stored for an embed.
      expect(previous.knownContentFields(object.content)).toEqual({
        type: 'embed',
        url: 'https://prototype.invalid/demo/1/index.html',
      });
      expect(Object.keys(object.content).sort()).toEqual(['label', 'type', 'url']);
      expect(Object.keys(object).sort()).toEqual(Object.keys(previous.StoredObjectSchema.shape).sort());
    } finally {
      await app.close();
    }
  });
});
