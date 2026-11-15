/**
 * @fileoverview Canvas Work items: the pure changes in `src/canvas/work.ts` (create, update, the run-end report,
 * revisions, limits, related items), the side file in `work-store.ts` (kept unknown keys, never written over when it
 * does not parse or is newer) and the routes plus the `canvas_work` command tool.
 *
 * Port: 0 (app.inject, no listener is used).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebServer } from '../src/web/server.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';
import {
  createWork,
  CreateWorkSchema,
  emptyWorkFile,
  parseWorkKey,
  reportWork,
  ReportWorkSchema,
  updateWork,
  UpdateWorkSchema,
  workLine,
  workRelated,
  WorkToolSchema,
  type WorkFile,
} from '../src/canvas/work.js';
import { readWork, workPath } from '../src/canvas/work-store.js';
import { toolSchemas, canvasToolNames } from '../src/canvas/commands.js';

const person = { kind: 'human' as const, userId: 'admin' };
const agent = { kind: 'agent' as const, sessionId: 'sess-agent-1' };
const ctx = (author: typeof person | typeof agent = person, now = 1000) => ({ author, now });

function made(file: WorkFile, title: string, extra: Record<string, unknown> = {}) {
  const result = createWork(file, CreateWorkSchema.parse({ title, ...extra }), ctx());
  if (!result.ok) throw new Error(result.message);
  return result;
}

describe('work items: pure changes', () => {
  it('reads keys in the forms people type and nothing else', () => {
    expect(parseWorkKey('W-12')).toBe(12);
    expect(parseWorkKey('w-3')).toBe(3);
    expect(parseWorkKey('7')).toBe(7);
    for (const bad of ['W-0', 'W12', 'x-1', '', 'W-1.5', '-1']) expect(parseWorkKey(bad), bad).toBeNull();
  });

  it('numbers items in order, defaults to Backlog and records who made them', () => {
    let file = emptyWorkFile();
    const a = made(file, 'First');
    file = a.file;
    const b = made(file, 'Second', { status: 'todo' });
    expect(a.item.number).toBe(1);
    expect(a.item.status).toBe('backlog');
    expect(b.item.number).toBe(2);
    expect(b.file.next).toBe(3);
    expect(a.item.author).toEqual(person);
    expect(a.item.history[0]!.text).toBe('Created in Backlog');
  });

  it('keeps a title to one printable line and refuses an empty one', () => {
    expect(workLine('  a\n\tb\u0007 c  ')).toBe('a b c');
    expect(CreateWorkSchema.safeParse({ title: ' \n ' }).success).toBe(false);
    expect(CreateWorkSchema.safeParse({ title: 'x'.repeat(201) }).success).toBe(false);
  });

  it('answers a repeated requestId with the first item and files nothing', () => {
    const requestId = '7d8a0d55-08b3-4b55-9a73-8f2c3b8d9e10';
    const first = made(emptyWorkFile(), 'Once', { requestId });
    const again = createWork(first.file, CreateWorkSchema.parse({ title: 'Once', requestId }), ctx());
    expect(again.ok && again.duplicate).toBe(true);
    expect(again.ok && again.file).toBe(first.file);
    expect(first.file.items).toHaveLength(1);
  });

  it('moves, assigns and links, logging each change and bumping the revision once', () => {
    const { file } = made(emptyWorkFile(), 'Move me');
    const result = updateWork(
      file,
      1,
      UpdateWorkSchema.parse({ status: 'in-progress', assignee: { kind: 'session', sessionId: 's-1' } }),
      ctx(person, 2000)
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.item.status).toBe('in-progress');
    expect(result.item.sessions).toEqual(['s-1']);
    expect(result.item.revision).toBe(2);
    expect(result.item.updatedAt).toBe(2000);
    expect(result.item.history.map((e) => e.text)).toEqual([
      'Assigned to session s-1',
      'Moved from Backlog to In progress',
      'Created in Backlog',
    ]);
    // The input file is not changed in place.
    expect(file.items[0]!.status).toBe('backlog');
  });

  it('refuses a stale revision with CONFLICT and an unknown key with NOT_FOUND', () => {
    const { file } = made(emptyWorkFile(), 'Guarded');
    const stale = updateWork(file, 1, UpdateWorkSchema.parse({ title: 'x', expectedRevision: 5 }), ctx());
    expect(stale).toMatchObject({ ok: false, code: 'CONFLICT' });
    expect(updateWork(file, 9, UpdateWorkSchema.parse({ title: 'x' }), ctx())).toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
    });
  });

  it('writes nothing for a change that changes nothing', () => {
    const { file } = made(emptyWorkFile(), 'Same');
    const result = updateWork(file, 1, UpdateWorkSchema.parse({ title: 'Same', status: 'backlog' }), ctx());
    expect(result.ok && result.file).toBe(file);
  });

  it('unlinking the assigned session leaves the item unassigned', () => {
    let { file } = made(emptyWorkFile(), 'Unlink', { assignee: { kind: 'session', sessionId: 's-1' } });
    expect(file.items[0]!.sessions).toEqual(['s-1']);
    const result = updateWork(file, 1, UpdateWorkSchema.parse({ unlinkSessions: ['s-1'] }), ctx());
    if (!result.ok) throw new Error(result.message);
    file = result.file;
    expect(file.items[0]!.assignee).toBeNull();
    expect(file.items[0]!.sessions).toEqual([]);
  });

  describe('the run-end report', () => {
    const report = (file: WorkFile, body: Record<string, unknown>) =>
      reportWork(file, 1, ReportWorkSchema.parse(body), ctx(agent, 5000));

    it('done: moves to Done, records the note and links the reporting session', () => {
      const { file } = made(emptyWorkFile(), 'Ship it', { status: 'in-progress' });
      const result = report(file, { outcome: 'done', note: 'Tests pass; checked at 390px.' });
      if (!result.ok) throw new Error(result.message);
      expect(result.item.status).toBe('done');
      expect(result.item.outcome).toMatchObject({ kind: 'done', sessionId: agent.sessionId });
      expect(result.item.sessions).toContain(agent.sessionId);
    });

    it('continue: keeps the status and records what is left', () => {
      const { file } = made(emptyWorkFile(), 'Not yet', { status: 'in-progress' });
      const result = report(file, { outcome: 'continue', note: 'Phone check failed.' });
      if (!result.ok) throw new Error(result.message);
      expect(result.item.status).toBe('in-progress');
      expect(result.item.outcome?.kind).toBe('continue');
    });

    it('split: moves to Done and files each new item in Backlog, created from this one', () => {
      const { file } = made(emptyWorkFile(), 'Parent', { status: 'in-progress' });
      const result = report(file, {
        outcome: 'split',
        note: 'Verified.',
        newItems: [{ title: 'Found one' }, { title: 'Found two', description: 'More' }],
      });
      if (!result.ok) throw new Error(result.message);
      expect(result.item.status).toBe('done');
      expect(result.filed.map((f) => [f.number, f.status, f.createdFrom])).toEqual([
        [2, 'backlog', 1],
        [3, 'backlog', 1],
      ]);
      const related = workRelated(result.file, result.item);
      expect(related.created.map((r) => r.key)).toEqual(['W-2', 'W-3']);
      expect(workRelated(result.file, result.filed[0]!).createdFrom?.key).toBe('W-1');
    });

    it('ask: records the question as Needs you and leaves the status alone; answering clears it', () => {
      const { file } = made(emptyWorkFile(), 'Unsure', { status: 'in-progress' });
      const asked = report(file, { outcome: 'ask', note: 'Two orders conflict.', question: 'Keep the saved one?' });
      if (!asked.ok) throw new Error(asked.message);
      expect(asked.item.status).toBe('in-progress');
      expect(asked.item.needs).toMatchObject({ question: 'Keep the saved one?', sessionId: agent.sessionId });
      const answered = updateWork(asked.file, 1, UpdateWorkSchema.parse({ needs: null }), ctx());
      expect(answered.ok && answered.item.needs).toBeUndefined();
    });

    it('refuses a report whose parts do not fit its outcome', () => {
      const { file } = made(emptyWorkFile(), 'Rules');
      expect(report(file, { outcome: 'split', note: 'n' })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
      expect(report(file, { outcome: 'ask', note: 'n' })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
      expect(report(file, { outcome: 'done', note: 'n', newItems: [{ title: 'x' }] })).toMatchObject({
        ok: false,
        code: 'INVALID_INPUT',
      });
    });
  });

  it('is one command tool, with the run-end rule in its schema', () => {
    expect(canvasToolNames).toContain('canvas_work');
    expect(toolSchemas.canvas_work).toBe(WorkToolSchema);
    expect(WorkToolSchema.safeParse({ action: 'report', key: 'W-1', outcome: 'done', note: 'ok' }).success).toBe(true);
    expect(WorkToolSchema.safeParse({ action: 'delete', key: 'W-1' }).success).toBe(false);
  });
});

describe('work items: routes and side file', () => {
  let server: WebServer;
  let ws: string;
  let inject: (o: { method: string; url: string; payload?: unknown }) => Promise<{
    statusCode: number;
    json: () => { success: boolean; data?: Record<string, unknown>; error?: string };
  }>;
  const api = (path = '') => `/api/canvas/${ws}/work${path}`;

  beforeAll(async () => {
    mkdirSync(resolve(resolveCasesDir(), 'work-case'), { recursive: true });
    server = new WebServer(0, false, true);
    await server.start();
    ws = workspaceForCase('work-case').id;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inject = (server as any).app.inject.bind((server as any).app);
  }, 60000);
  afterAll(async () => {
    await server?.stop();
  }, 60000);

  it('lists nothing before the first item and writes no file for a read', async () => {
    const r = await inject({ method: 'GET', url: api() });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toEqual({ next: 'W-1', items: [] });
    expect(existsSync(workPath(ws))).toBe(false);
  });

  it('creates, changes and reads an item, keeping the file private', async () => {
    const created = await inject({ method: 'POST', url: api(), payload: { title: 'Outline order', status: 'todo' } });
    expect(created.statusCode).toBe(201);
    expect(created.json().data?.item).toMatchObject({ key: 'W-1', status: 'todo', author: { kind: 'human' } });
    expect(statSync(workPath(ws)).mode & 0o077).toBe(0);
    const moved = await inject({
      method: 'PATCH',
      url: api('/W-1'),
      payload: { status: 'in-progress', expectedRevision: 1 },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().data?.item).toMatchObject({ status: 'in-progress', revision: 2 });
    const stale = await inject({ method: 'PATCH', url: api('/W-1'), payload: { title: 'x', expectedRevision: 1 } });
    expect(stale.statusCode).toBe(409);
    const read = await inject({ method: 'GET', url: api('/w-1') });
    expect(read.json().data).toMatchObject({ item: { key: 'W-1' }, related: { created: [] } });
    expect((await inject({ method: 'GET', url: api('/nope') })).statusCode).toBe(400);
    expect((await inject({ method: 'GET', url: api('/W-99') })).statusCode).toBe(404);
  });

  it('refuses to link a session the server does not hold, and "me" from a person', async () => {
    const r = await inject({ method: 'PATCH', url: api('/W-1'), payload: { linkSessions: ['no-such-session'] } });
    expect(r.statusCode).toBe(400);
    const me = await inject({
      method: 'PATCH',
      url: api('/W-1'),
      payload: { assignee: { kind: 'session', sessionId: 'me' } },
    });
    expect(me.statusCode).toBe(400);
  });

  it('runs the canvas_work tool through the command route', async () => {
    const tool = (args: Record<string, unknown>) =>
      inject({ method: 'POST', url: `/api/canvas/${ws}/command`, payload: { tool: 'canvas_work', arguments: args } });
    const split = await tool({
      action: 'report',
      key: 'W-1',
      outcome: 'split',
      note: 'Verified in the browser.',
      newItems: [{ title: 'Found on the way' }],
    });
    expect(split.statusCode).toBe(200);
    expect(split.json().data).toMatchObject({ item: { status: 'done' }, filed: [{ key: 'W-2', createdFrom: 1 }] });
    const listed = await tool({ action: 'list', status: 'backlog' });
    expect((listed.json().data as { items: { key: string }[] }).items.map((i) => i.key)).toEqual(['W-2']);
    const read = await tool({ action: 'read', key: 'W-1' });
    expect(read.json().data).toMatchObject({ related: { created: [{ key: 'W-2' }] } });
  });

  it('keeps unknown keys on write, and never writes over a file it cannot read', async () => {
    const raw = JSON.parse(readFileSync(workPath(ws), 'utf8'));
    raw.future = { kept: true };
    raw.items[0].later = 'kept';
    writeFileSync(workPath(ws), JSON.stringify(raw));
    await inject({ method: 'PATCH', url: api('/W-2'), payload: { status: 'todo' } });
    const after = JSON.parse(readFileSync(workPath(ws), 'utf8'));
    expect(after.future).toEqual({ kept: true });
    expect(after.items[0].later).toBe('kept');

    writeFileSync(workPath(ws), JSON.stringify({ ...after, version: 2 }));
    expect(readWork(ws)).toEqual({ ok: false, reason: 'newer' });
    const refused = await inject({ method: 'POST', url: api(), payload: { title: 'Blocked' } });
    expect(refused.statusCode).toBe(409);
    expect(JSON.parse(readFileSync(workPath(ws), 'utf8')).version).toBe(2);
    writeFileSync(workPath(ws), '{not json');
    expect((await inject({ method: 'GET', url: api() })).statusCode).toBe(409);
    expect(readFileSync(workPath(ws), 'utf8')).toBe('{not json');
    rmSync(workPath(ws));
  });
});
