import Fastify from 'fastify';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCanvasRoutes } from '../src/web/routes/canvas-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { CanvasStores } from '../src/canvas/canvas-store.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { deployRole } from '../src/deploy-role.js';
import { OperationSchema, revertPlan } from '../src/canvas/operations.js';
import { canvasToolNames } from '../src/canvas/commands.js';
import { create, human, agent } from './canvas-fixtures.js';
import {
  HISTORY_REFRESH_MS,
  HistoryView,
  laterChanges,
  previewSentence,
  resultSentence,
} from '../packages/canvas/src/history.js';
import { postFailure } from '../packages/canvas/src/comments.js';

/** Operation kinds the release before PC6 replays; anything else it would carry as a future record. */
const PREVIOUS_RELEASE_KINDS = new Set([
  'create',
  'update',
  'move',
  'reparent',
  'reorder',
  'lock',
  'unlock',
  'delete',
  'restore',
  'comment',
  'remove-comment',
  'revert',
]);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-comments-'));
  vi.stubEnv('CODEMAN_DATA_DIR', dir);
  vi.stubEnv('CODEMAN_MULTIUSER', '1');
});
afterEach(() => {
  deployRole.enter('live');
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
async function harness() {
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    req.authUser = { username: 'user-a', role: 'user' };
  });
  const stores = new CanvasStores();
  const port = {
    sessions: new Map(),
    canvasEnabled: async () => true,
    canvasStores: vi.fn(async () => stores),
    broadcast: vi.fn(),
  };
  registerCanvasRoutes(app, port);
  installRouteErrorHandler(app);
  await app.ready();
  const workspace = workspaceForCase('comments', 'user-a');
  return { app, port, store: stores.get(workspace.id), workspace: workspace.id };
}
const move = (id: string, x: number, opId: string) => ({
  kind: 'move' as const,
  opId,
  objectId: id,
  patch: { position: { x, y: 0 } },
});

describe('canvas comments', () => {
  it('posts an ordinary comment through the command path, once per request id, and reads it back', async () => {
    const { app, port, store, workspace } = await harness();
    try {
      store.append([create('note')], human);
      const payload = {
        tool: 'canvas_comment',
        requestId: crypto.randomUUID(),
        arguments: { objectId: 'note', text: '<img src=x onerror=alert(1)>', commentId: 'c1' },
      };
      const first = await app.inject({ method: 'POST', url: `/api/canvas/${workspace}/command`, payload });
      expect(first.statusCode).toBe(200);
      const replay = await app.inject({ method: 'POST', url: `/api/canvas/${workspace}/command`, payload });
      expect(replay.json().data.sequences).toEqual(first.json().data.sequences);
      expect(store.read().comments).toEqual([
        expect.objectContaining({ id: 'c1', objectId: 'note', author: human, text: '<img src=x onerror=alert(1)>' }),
      ]);
      expect(port.broadcast).toHaveBeenCalledTimes(1);
      const read = await app.inject({
        method: 'POST',
        url: `/api/canvas/${workspace}/command`,
        payload: { tool: 'canvas_read', arguments: {} },
      });
      expect(read.json().data.comments).toHaveLength(1);
      const empty = await app.inject({
        method: 'POST',
        url: `/api/canvas/${workspace}/command`,
        payload: { tool: 'canvas_comment', arguments: { objectId: 'note', text: '   ' } },
      });
      expect(empty.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('accepts a comment on a locked object, since comments are not edits', async () => {
    const { app, store, workspace } = await harness();
    try {
      store.append(
        [create('note'), { kind: 'lock', opId: 'lock', objectId: 'note', patch: { mode: 'subtree' } }],
        human
      );
      const response = await app.inject({
        method: 'POST',
        url: `/api/canvas/${workspace}/command`,
        payload: { tool: 'canvas_comment', arguments: { objectId: 'note', text: 'Still readable' } },
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('leaves the object revision unchanged, so a comment never stales another writer', async () => {
    const { app, store, workspace } = await harness();
    try {
      store.append([create('note')], human);
      const before = store.read().objects.note.revision;
      const response = await app.inject({
        method: 'POST',
        url: `/api/canvas/${workspace}/command`,
        payload: { tool: 'canvas_comment', arguments: { objectId: 'note', text: 'hi' } },
      });
      expect(response.statusCode).toBe(200);
      expect(store.read().objects.note.revision).toBe(before);
    } finally {
      await app.close();
    }
  });

  it('refuses a comment on a deleted object, and the page names that instead of offering Retry', async () => {
    const { app, store, workspace } = await harness();
    try {
      store.append([create('note'), { kind: 'delete', opId: 'del', objectId: 'note' }], human);
      const response = await app.inject({
        method: 'POST',
        url: `/api/canvas/${workspace}/command`,
        payload: { tool: 'canvas_comment', arguments: { objectId: 'note', text: 'late' } },
      });
      expect(response.statusCode).toBe(409);
      expect(postFailure(response.statusCode, response.json())).toEqual({
        retry: false,
        message: expect.stringContaining('this object was removed'),
      });
    } finally {
      await app.close();
    }
  });

  it('offers Retry only for failures that can succeed as sent', () => {
    expect(postFailure(null, null).retry).toBe(true);
    expect(postFailure(502, null).retry).toBe(true);
    expect(postFailure(429, null).retry).toBe(true);
    expect(postFailure(400, { success: false }).retry).toBe(false);
    expect(postFailure(400, { success: false }).message).toContain('100,000 characters');
    expect(postFailure(409, { reasons: [{ code: 'NOT_FOUND' }] }).message).toContain('removed');
    expect(postFailure(403, null)).toEqual({ retry: false, message: expect.stringContaining('refused') });
  });

  it('exposes canvas_comment among the command tools', () => {
    expect(canvasToolNames).toContain('canvas_comment');
  });
});

describe('author history and revert', () => {
  it('lists authors with counts and previews what a revert removes, restores and skips', async () => {
    const { app, store, workspace } = await harness();
    try {
      store.append([create('mine')], human);
      store.append(
        [create('a1'), create('a2'), move('mine', 50, 'agent-move'), move('a2', 70, 'agent-move-a2')],
        agent
      );
      store.append([move('a2', 90, 'human-later')], human);
      const authors = await app.inject({
        method: 'POST',
        url: `/api/canvas/${workspace}/command`,
        payload: { tool: 'canvas_history', arguments: { action: 'authors' } },
      });
      const list = authors.json().data.data;
      expect(list.map((a: { author: unknown; operations: number }) => [a.author, a.operations])).toEqual(
        expect.arrayContaining([
          [human, 2],
          [agent, 4],
        ])
      );
      const preview = await app.inject({
        method: 'POST',
        url: `/api/canvas/${workspace}/command`,
        payload: { tool: 'canvas_history', arguments: { action: 'preview', author: agent } },
      });
      const summary = preview.json().data.data;
      expect(summary.removed).toEqual(['a1']);
      expect(summary.kept).toEqual(['a2']);
      expect(summary.restored).toEqual([{ objectId: 'mine', fields: ['position'] }]);
      expect(summary.skipped).toEqual([{ objectId: 'a2', fields: ['position'] }]);
      expect(summary.refused).toEqual([]);
      expect(store.operations()).toHaveLength(6);
    } finally {
      await app.close();
    }
  });

  it('reverts one agent through POST /revert once per request id and leaves later edits by others', async () => {
    const { app, store, workspace } = await harness();
    try {
      store.append([create('mine')], human);
      store.append([create('a1'), create('a2'), move('mine', 50, 'agent-move')], agent);
      store.append([move('a2', 90, 'human-later')], human);
      const payload = { author: agent, requestId: crypto.randomUUID() };
      const first = await app.inject({ method: 'POST', url: `/api/canvas/${workspace}/revert`, payload });
      expect(first.statusCode).toBe(200);
      expect(first.json().data.summary.data).toMatchObject({ removed: ['a1'], kept: ['a2'] });
      const state = store.read();
      expect(state.objects.a1.deletedAt).not.toBeNull();
      expect(state.objects.a2.deletedAt).toBeNull();
      expect(state.objects.a2.position.x).toBe(90);
      expect(state.objects.mine.position).toEqual({ x: 10, y: 20 });
      const count = store.operations().length;
      const replay = await app.inject({ method: 'POST', url: `/api/canvas/${workspace}/revert`, payload });
      expect(replay.json().data).toMatchObject({ replayed: true, sequences: first.json().data.sequences });
      expect(store.operations()).toHaveLength(count);
    } finally {
      await app.close();
    }
  });

  it('rejects the whole revert with reasons when a target is locked, and the preview says so first', async () => {
    const { app, store, workspace } = await harness();
    try {
      store.append([create('frame', null, 'frame')], human);
      store.append([create('a1', 'frame'), create('a2')], agent);
      store.append([{ kind: 'lock', opId: 'lock-frame', objectId: 'frame', patch: { mode: 'subtree' } }], human);
      const preview = await app.inject({
        method: 'POST',
        url: `/api/canvas/${workspace}/command`,
        payload: { tool: 'canvas_history', arguments: { action: 'preview', author: agent } },
      });
      expect(preview.json().data.data.refused[0]).toMatchObject({ code: 'LOCKED' });
      const before = store.operations().length;
      const response = await app.inject({
        method: 'POST',
        url: `/api/canvas/${workspace}/revert`,
        payload: { author: agent },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().reasons[0].code).toBe('LOCKED');
      expect(store.operations()).toHaveLength(before);
      expect(store.read().objects.a1.deletedAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('reverts 1,000 agent operations in under a second', async () => {
    const { store } = await harness();
    store.append([create('frame', null, 'frame')], human);
    store.append(
      [
        create('box', null, 'frame'),
        create('inner', 'box', 'frame'),
        ...Array.from({ length: 998 }, (_, i) => create(`n${i}`, i % 2 ? 'box' : 'inner')),
      ],
      agent
    );
    const started = performance.now();
    const result = store.revert(agent, human);
    const elapsed = performance.now() - started;
    expect(result.ok).toBe(true);
    expect(store.read().objects.n997.deletedAt).not.toBeNull();
    expect(store.read().objects.box.deletedAt).not.toBeNull();
    expect(store.read().objects.inner.deletedAt).not.toBeNull();
    expect(store.read().objects.frame.deletedAt).toBeNull();
    expect(elapsed).toBeLessThan(1000);
  });

  it('writes only records the previous release reads: known kinds and the v1 operation shape', async () => {
    const { app, store, workspace } = await harness();
    try {
      store.append([create('note')], human);
      store.append([create('a1')], agent);
      await app.inject({
        method: 'POST',
        url: `/api/canvas/${workspace}/command`,
        payload: {
          tool: 'canvas_comment',
          requestId: crypto.randomUUID(),
          arguments: { objectId: 'note', text: 'hi' },
        },
      });
      await app.inject({
        method: 'POST',
        url: `/api/canvas/${workspace}/revert`,
        payload: { author: agent, requestId: crypto.randomUUID() },
      });
      const lines = readFileSync(store.logPath, 'utf8').trim().split('\n');
      const records = lines.flatMap((line) => {
        const parsed = JSON.parse(line);
        return 'operations' in parsed ? parsed.operations : [parsed];
      });
      expect(records.length).toBeGreaterThanOrEqual(4);
      for (const record of records) {
        expect(PREVIOUS_RELEASE_KINDS.has(record.kind)).toBe(true);
        expect(OperationSchema.safeParse(record).success).toBe(true);
        expect(record.opId.length).toBeLessThanOrEqual(128);
      }
    } finally {
      await app.close();
    }
  });

  it('revertPlan removes, restores, keeps and skips by the field-protection rules', async () => {
    const { store } = await harness();
    expect(revertPlan({ seq: 0, objects: {}, comments: [] }, [], agent).summary).toEqual({
      removed: [],
      restored: [],
      skipped: [],
      kept: [],
      comments: 0,
    });
    store.append([create('mine'), create('shared')], human);
    store.append(
      [
        create('gone'),
        create('touched'),
        move('mine', 50, 'agent-mine'),
        move('shared', 60, 'agent-shared'),
        { kind: 'comment', opId: 'agent-note', objectId: 'mine', patch: { id: 'agent-note', text: 'mine' } },
      ],
      agent
    );
    store.append([move('shared', 70, 'human-shared'), move('touched', 80, 'human-touched')], human);
    const plan = store.revertPlan(agent);
    expect(plan.summary).toEqual({
      removed: ['gone'],
      restored: [{ objectId: 'mine', fields: ['position'] }],
      skipped: [
        { objectId: 'shared', fields: ['position'] },
        { objectId: 'touched', fields: ['position'] },
      ],
      kept: ['touched'],
      comments: 1,
    });
    expect(laterChanges(plan.summary)).toBe(2);
    expect(store.revert(agent, human).ok).toBe(true);
    const state = store.read();
    expect(state.objects.gone.deletedAt).not.toBeNull();
    expect(state.objects.touched.deletedAt).toBeNull();
    expect(state.objects.mine.position).toEqual({ x: 10, y: 20 });
    expect(state.objects.shared.position.x).toBe(70);
    expect(state.comments).toEqual([]);
  });

  it('counts each later edit by others once, even when an object is both kept and skipped', () => {
    const summary = {
      removed: ['a1'],
      restored: [],
      skipped: [
        { objectId: 'a2', fields: ['position'] },
        { objectId: 'b', fields: ['position', 'size'] },
      ],
      kept: ['a2'],
      comments: 0,
    };
    expect(laterChanges(summary)).toBe(3);
    expect(previewSentence(summary, (id) => id)).toContain('Later edits by others stay: 3 changes');
    expect(resultSentence(summary)).toContain('Skipped 3 changes');
    const single = { ...summary, skipped: [{ objectId: 'a2', fields: ['position'] }] };
    expect(previewSentence(single, (id) => id)).toContain('1 change on “a2”.');
    expect(resultSentence(single)).toContain('Skipped 1 change others');
  });
});

describe('history refresh', () => {
  it('re-reads authors at most once a second while open, and once after a burst', () => {
    vi.useFakeTimers();
    try {
      const view = new HistoryView({
        url: (path) => path,
        workspace: 'w',
        phone: { matches: false, touch: false, addEventListener: () => {} },
        objects: () => [],
      });
      const refresh = vi.spyOn(view, 'refresh').mockResolvedValue();
      view.changed();
      expect(refresh).not.toHaveBeenCalled();
      view.show();
      expect(refresh).toHaveBeenCalledTimes(1);
      (view as unknown as { lastRefresh: number }).lastRefresh = Date.now();
      for (let i = 0; i < 50; i++) view.changed();
      expect(refresh).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(HISTORY_REFRESH_MS);
      expect(refresh).toHaveBeenCalledTimes(2);
      view.hide();
      view.changed();
      vi.advanceTimersByTime(HISTORY_REFRESH_MS * 2);
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
