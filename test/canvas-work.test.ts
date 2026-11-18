/**
 * @fileoverview Canvas Work items: the pure changes in `src/canvas/work.ts` (create, update, the run-end report,
 * revisions, limits, related items), the side file in `work-store.ts` (kept unknown keys, never written over when it
 * does not parse or is newer) and the routes plus the `canvas_work` command tool.
 *
 * Port: 0 (app.inject, no listener is used).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebServer } from '../src/web/server.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';
import {
  attachedBytes,
  attachWork,
  createWork,
  detachWork,
  MAX_WORK_ATTACHMENTS,
  workBrief,
  CreateWorkSchema,
  emptyWorkFile,
  encodeWorkFile,
  parseWorkKey,
  readyQueue,
  reportWork,
  ReportWorkSchema,
  updateWork,
  UpdateWorkSchema,
  workLine,
  workRelated,
  WorkFileSchema,
  workPosition,
  WORK_STATUSES,
  WorkToolSchema,
  type WorkFile,
} from '../src/canvas/work.js';
import { readWork, workPath } from '../src/canvas/work-store.js';
import { toolSchemas, canvasToolNames } from '../src/canvas/commands.js';
import { admitWorkFile, MAX_WORK_FILE_BYTES, servedAs } from '../src/canvas/work-files.js';
import { png } from './canvas-media-fixtures.js';
import { create } from './canvas-fixtures.js';

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
    const b = made(file, 'Second', { status: 'needs-refinement' });
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

    it('ask: records the question as Needs you and moves to Human required; answering sends it to Needs refinement', () => {
      const { file } = made(emptyWorkFile(), 'Unsure', { status: 'in-progress' });
      const asked = report(file, { outcome: 'ask', note: 'Two orders conflict.', question: 'Keep the saved one?' });
      if (!asked.ok) throw new Error(asked.message);
      expect(asked.item.status).toBe('human-required');
      expect(asked.item.history[1]!.text).toBe('Moved from In progress to Human required');
      expect(asked.item.needs).toMatchObject({ question: 'Keep the saved one?', sessionId: agent.sessionId });
      // Not straight to Ready for work, neither with the answer nor before it.
      for (const body of [{ needs: null, status: 'ready-for-work' }, { status: 'ready-for-work' }])
        expect(updateWork(asked.file, 1, UpdateWorkSchema.parse(body), ctx())).toMatchObject({
          ok: false,
          code: 'INVALID_INPUT',
        });
      const answered = updateWork(asked.file, 1, UpdateWorkSchema.parse({ needs: null }), ctx());
      if (!answered.ok) throw new Error(answered.message);
      expect(answered.item.needs).toBeUndefined();
      expect(answered.item.status).toBe('needs-refinement');
      expect(answered.item.history.map((e) => e.text).slice(0, 2)).toEqual([
        'Marked the question answered',
        'Moved from Human required to Needs refinement',
      ]);
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

  describe('Backlog: only a person promotes out of it', () => {
    it('refuses an agent that moves an item out of Backlog without the instruction, and records it when given', () => {
      const { file } = made(emptyWorkFile(), 'Idea');
      for (const status of ['needs-refinement', 'ready-for-work', 'not-doing'])
        expect(updateWork(file, 1, UpdateWorkSchema.parse({ status }), ctx(agent))).toMatchObject({
          ok: false,
          code: 'INVALID_INPUT',
        });
      const result = updateWork(
        file,
        1,
        UpdateWorkSchema.parse({ status: 'needs-refinement', instruction: 'Harry: pick up the idea  about lanes' }),
        ctx(agent)
      );
      if (!result.ok) throw new Error(result.message);
      expect(result.item.history.map((e) => e.text).slice(0, 2)).toEqual([
        `Moved out of Backlog on the person's instruction: "Harry: pick up the idea about lanes"`,
        'Moved from Backlog to Needs refinement',
      ]);
      // A person needs no instruction; an agent may put items into Backlog freely.
      expect(updateWork(file, 1, UpdateWorkSchema.parse({ status: 'done' }), ctx(person)).ok).toBe(true);
      const back = updateWork(result.file, 1, UpdateWorkSchema.parse({ status: 'backlog' }), ctx(agent));
      expect(back.ok && back.item.status).toBe('backlog');
    });

    it('holds a report that would move an item out of Backlog to the same rule', () => {
      const { file } = made(emptyWorkFile(), 'Idea');
      const at = (body: Record<string, unknown>) => reportWork(file, 1, ReportWorkSchema.parse(body), ctx(agent));
      expect(at({ outcome: 'done', note: 'n' })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
      expect(at({ outcome: 'ask', note: 'n', question: 'q?' })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
      expect(at({ outcome: 'continue', note: 'n' }).ok).toBe(true);
      const done = at({ outcome: 'done', note: 'n', instruction: 'Do W-1 now' });
      expect(done.ok && done.item.status).toBe('done');
    });
  });

  describe('Ready for work: priority is position', () => {
    function lane() {
      let file = emptyWorkFile();
      for (const title of ['A', 'B', 'C']) file = made(file, title, { status: 'ready-for-work' }).file;
      return file;
    }
    const keys = (file: WorkFile) => readyQueue(file).map((i) => i.number);

    it('puts an item entering the lane at the bottom, and moves it by position', () => {
      let file = lane();
      expect(keys(file)).toEqual([1, 2, 3]);
      expect(workPosition(file, 3)).toBe(3);
      const top = updateWork(file, 3, UpdateWorkSchema.parse({ position: 1 }), ctx(agent));
      if (!top.ok) throw new Error(top.message);
      file = top.file;
      expect(keys(file)).toEqual([3, 1, 2]);
      expect(top.item.history[0]!.text).toBe('Moved to position 1 in Ready for work');
      // Only the moved item changes; the others keep their revisions.
      expect(file.items.map((i) => i.revision)).toEqual([1, 1, 2]);
      // Past the end is the bottom; the same place changes nothing.
      const bottom = updateWork(file, 3, UpdateWorkSchema.parse({ position: 99 }), ctx());
      expect(bottom.ok && keys(bottom.file)).toEqual([1, 2, 3]);
      const same = updateWork(file, 3, UpdateWorkSchema.parse({ position: 1 }), ctx());
      expect(same.ok && same.file).toBe(file);
    });

    it('places an item entering at a position, drops one leaving, and refuses a position outside the lane', () => {
      let file = lane();
      file = made(file, 'D', { status: 'needs-refinement' }).file;
      const enter = updateWork(file, 4, UpdateWorkSchema.parse({ status: 'ready-for-work', position: 2 }), ctx());
      if (!enter.ok) throw new Error(enter.message);
      expect(keys(enter.file)).toEqual([1, 4, 2, 3]);
      const leave = updateWork(enter.file, 1, UpdateWorkSchema.parse({ status: 'in-progress' }), ctx());
      if (!leave.ok) throw new Error(leave.message);
      expect(keys(leave.file)).toEqual([4, 2, 3]);
      expect(workPosition(leave.file, 1)).toBeNull();
      expect(updateWork(leave.file, 1, UpdateWorkSchema.parse({ position: 1 }), ctx())).toMatchObject({
        ok: false,
        code: 'INVALID_INPUT',
      });
    });
  });

  describe('migration of Todo and the stored form', () => {
    const stored = (items: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
      version: 1,
      next: items.length + 1,
      items: items.map((i, n) => ({
        number: n + 1,
        title: `T${n + 1}`,
        author: person,
        createdAt: 1,
        updatedAt: 1,
        revision: 1,
        history: [],
        ...i,
      })),
      ...extra,
    });

    it('reads a Todo item by its assignee, and a split one by its todoStatus', () => {
      const file = WorkFileSchema.parse(
        stored([
          { status: 'todo', assignee: { kind: 'person' } },
          { status: 'todo', assignee: null },
          { status: 'todo', assignee: { kind: 'session', sessionId: 's-1' }, sessions: ['s-1'] },
          { status: 'todo', assignee: { kind: 'person' }, todoStatus: 'ready-for-work' },
          { status: 'in-progress', todoStatus: 'human-required' },
        ])
      );
      expect(file.items.map((i) => i.status)).toEqual([
        'human-required',
        'needs-refinement',
        'needs-refinement',
        'ready-for-work',
        'in-progress',
      ]);
      expect(file.items[2]!.assignee).toEqual({ kind: 'session', sessionId: 's-1' });
      expect(file.readyOrder).toEqual([4]);
      expect(file.items.every((i) => !('todoStatus' in i))).toBe(true);
    });

    it('writes only the five statuses the previous release reads, and reads back what it wrote', () => {
      let file = emptyWorkFile();
      for (const status of WORK_STATUSES) file = made(file, status, { status }).file;
      const disk = encodeWorkFile(file) as { version: number; items: { status: string; todoStatus?: string }[] };
      expect(disk.version).toBe(1);
      expect(disk.items.map((i) => [i.status, i.todoStatus])).toEqual([
        ['backlog', undefined],
        ['todo', 'needs-refinement'],
        ['todo', 'human-required'],
        ['todo', 'ready-for-work'],
        ['in-progress', undefined],
        ['done', undefined],
        ['not-doing', undefined],
      ]);
      const back = WorkFileSchema.parse(JSON.parse(JSON.stringify(disk)));
      expect(back.items.map((i) => i.status)).toEqual([...WORK_STATUSES]);
      expect(back.readyOrder).toEqual([4]);
    });
  });

  describe('the pull request', () => {
    const url = 'https://github.com/example/repo/pull/58';

    it('takes a bare https address or {url, branch, base}, and refuses anything that is not https', () => {
      expect(CreateWorkSchema.parse({ title: 'T', pr: url }).pr).toEqual({ url });
      expect(CreateWorkSchema.parse({ title: 'T', pr: { url, branch: 'build/w-1', base: 'main' } }).pr).toEqual({
        url,
        branch: 'build/w-1',
        base: 'main',
      });
      for (const pr of [
        'javascript:alert(1)',
        'http://github.com/example/repo/pull/58',
        'not a url',
        `https://example.com/${'x'.repeat(300)}`,
        { url, branch: '-x' },
        { url, branch: 'a..b' },
        { url, extra: 1 },
      ])
        expect(UpdateWorkSchema.safeParse({ pr }).success, JSON.stringify(pr)).toBe(false);
    });

    it('links, relinks and clears, logging each change once', () => {
      const first = made(emptyWorkFile(), 'With PR', { pr: url });
      expect(first.item.pr).toEqual({ url });
      expect(first.item.history[0]!.text).toBe(`Linked PR ${url}`);
      const branched = updateWork(first.file, 1, UpdateWorkSchema.parse({ pr: { url, branch: 'feat/x' } }), ctx());
      if (!branched.ok) throw new Error(branched.message);
      expect(branched.item).toMatchObject({ pr: { url, branch: 'feat/x' }, revision: 2 });
      const same = updateWork(branched.file, 1, UpdateWorkSchema.parse({ pr: { url, branch: 'feat/x' } }), ctx());
      expect(same.ok && same.file).toBe(branched.file);
      const cleared = updateWork(branched.file, 1, UpdateWorkSchema.parse({ pr: null }), ctx());
      if (!cleared.ok) throw new Error(cleared.message);
      expect(cleared.item.pr).toBeUndefined();
      expect(cleared.item.history[0]!.text).toBe('Unlinked PR');
      const again = updateWork(cleared.file, 1, UpdateWorkSchema.parse({ pr: null }), ctx());
      expect(again.ok && again.file).toBe(cleared.file);
    });

    it('reads a stored pr that is not https as no pr, keeping the rest of the item', () => {
      const file = made(emptyWorkFile(), 'Old').file;
      const disk = encodeWorkFile(file) as { items: Record<string, unknown>[] };
      disk.items[0]!.pr = { url: 'javascript:alert(1)' };
      const back = WorkFileSchema.parse(JSON.parse(JSON.stringify(disk)));
      expect(back.items[0]!.pr).toBeUndefined();
      expect(back.items[0]!.title).toBe('Old');
    });
  });

  describe('attachments', () => {
    const file = (n: number, size = 10) => ({
      id: n.toString(16).padStart(32, '0'),
      name: `f${n}.png`,
      type: 'image/png',
      size,
      at: 5,
    });

    it('records a file on the item, logs it, and takes it off again', () => {
      const base = made(emptyWorkFile(), 'With files');
      const attached = attachWork(base.file, 1, file(1), 1000, ctx(agent, 2000));
      if (!attached.ok) throw new Error(attached.message);
      expect(attached.item.attachments).toEqual([file(1)]);
      expect(attached.item.revision).toBe(2);
      expect(attached.item.history[0]!.text).toBe('Attached f1.png');
      expect(workBrief(attached.item)).toMatchObject({ attachments: 1 });
      const back = WorkFileSchema.parse(JSON.parse(JSON.stringify(encodeWorkFile(attached.file))));
      expect(back.items[0]!.attachments).toEqual([file(1)]);
      const detached = detachWork(attached.file, 1, file(1).id, ctx());
      if (!detached.ok) throw new Error(detached.message);
      expect(detached.item.attachments).toBeUndefined();
      expect(detached.item.history[0]!.text).toBe('Removed attachment f1.png');
      const missing = detachWork(detached.file, 1, file(1).id, ctx());
      expect(!missing.ok && missing.code).toBe('NOT_FOUND');
    });

    it('refuses past the per-item count and the workspace byte quota, changing nothing', () => {
      let current = made(emptyWorkFile(), 'Full').file;
      for (let n = 1; n <= MAX_WORK_ATTACHMENTS; n++) {
        const r = attachWork(current, 1, file(n), 1_000_000, ctx());
        if (!r.ok) throw new Error(r.message);
        current = r.file;
      }
      const tooMany = attachWork(current, 1, file(99), 1_000_000, ctx());
      expect(!tooMany.ok && tooMany.code).toBe('FULL');
      const two = made(made(emptyWorkFile(), 'A').file, 'B').file;
      const first = attachWork(two, 1, file(1, 600), 1000, ctx());
      if (!first.ok) throw new Error(first.message);
      const over = attachWork(first.file, 2, file(2, 401), 1000, ctx());
      expect(!over.ok && over.code).toBe('FULL');
      expect(attachWork(first.file, 2, file(2, 400), 1000, ctx()).ok).toBe(true);
    });

    it('references canvas objects by id beside files, and takes a reference off without touching the files', () => {
      const withFile = attachWork(made(emptyWorkFile(), 'Refs').file, 1, file(1), 1000, ctx());
      if (!withFile.ok) throw new Error(withFile.message);
      const update = (f: WorkFile, patch: Record<string, unknown>) =>
        updateWork(f, 1, UpdateWorkSchema.parse(patch), ctx(agent, 3000));
      const added = update(withFile.file, { attachObjects: ['note-a', 'note-b', 'note-a'] });
      if (!added.ok) throw new Error(added.message);
      expect(added.item.attachments).toEqual([
        file(1),
        { kind: 'object', id: 'note-a', at: 3000 },
        { kind: 'object', id: 'note-b', at: 3000 },
      ]);
      expect(added.item.history[0]!.text).toBe('Attached 2 objects');
      expect(update(added.file, { attachObjects: ['note-a'] }).file).toBe(added.file);
      const back = WorkFileSchema.parse(JSON.parse(JSON.stringify(encodeWorkFile(added.file))));
      expect(back.items[0]!.attachments).toEqual(added.item.attachments);
      // A file's id never names an object reference, and an object id never reaches the file bytes.
      expect(detachWork(added.file, 1, 'note-a', ctx()).ok).toBe(false);
      const removed = update(added.file, { detachObjects: ['note-a', 'never-attached'] });
      if (!removed.ok) throw new Error(removed.message);
      expect(removed.item.attachments).toEqual([file(1), { kind: 'object', id: 'note-b', at: 3000 }]);
      expect(removed.item.history[0]!.text).toBe('Removed object note-a');
      const fileGone = detachWork(removed.file, 1, file(1).id, ctx());
      if (!fileGone.ok) throw new Error(fileGone.message);
      expect(fileGone.item.attachments).toEqual([{ kind: 'object', id: 'note-b', at: 3000 }]);
      expect(() => UpdateWorkSchema.parse({ attachObjects: ['../x'] })).toThrow();
    });

    it('counts object references toward the per-item cap and none toward the byte quota', () => {
      const ids = Array.from({ length: MAX_WORK_ATTACHMENTS }, (_, n) => `obj-${n}`);
      const full = updateWork(
        made(emptyWorkFile(), 'Full').file,
        1,
        UpdateWorkSchema.parse({ attachObjects: ids }),
        ctx()
      );
      if (!full.ok) throw new Error(full.message);
      const more = updateWork(full.file, 1, UpdateWorkSchema.parse({ attachObjects: ['one-more'] }), ctx());
      expect(!more.ok && more.code).toBe('FULL');
      expect(!attachWork(full.file, 1, file(1), 1000, ctx()).ok).toBe(true);
      const small = updateWork(
        made(emptyWorkFile(), 'S').file,
        1,
        UpdateWorkSchema.parse({ attachObjects: ['a'] }),
        ctx()
      );
      if (!small.ok) throw new Error(small.message);
      expect(attachedBytes(small.file)).toBe(0);
    });

    it('drops only the attachment records that do not parse, keeping the rest and the item', () => {
      const disk = encodeWorkFile(made(emptyWorkFile(), 'Odd').file) as { items: Record<string, unknown>[] };
      disk.items[0]!.attachments = [file(1), { id: '../../etc/passwd', name: 'x', type: 'text/plain', size: 1, at: 1 }];
      const back = WorkFileSchema.parse(JSON.parse(JSON.stringify(disk)));
      expect(back.items[0]!.attachments).toEqual([file(1)]);
      disk.items[0]!.attachments = [{ id: 'nope' }];
      expect(WorkFileSchema.parse(JSON.parse(JSON.stringify(disk))).items[0]!.attachments).toBeUndefined();
      disk.items[0]!.attachments = 'not a list';
      const odd = WorkFileSchema.parse(JSON.parse(JSON.stringify(disk))).items[0]!;
      expect(odd.attachments).toBeUndefined();
      expect(odd.title).toBe('Odd');
    });

    it('admits allowlisted files whose bytes match their name, and serves only images as themselves', () => {
      expect(admitWorkFile('shot.PNG', png(2, 2))).toMatchObject({ ok: true, name: 'shot.PNG', type: 'image/png' });
      expect(admitWorkFile('C:\\tmp\\notes.md', Buffer.from('# hi'))).toMatchObject({ ok: true, name: 'notes.md' });
      expect(admitWorkFile('a.png', Buffer.from('<html>'))).toMatchObject({ ok: false, reason: 'bytes' });
      expect(admitWorkFile('page.html', Buffer.from('<html>'))).toMatchObject({ ok: false, reason: 'type' });
      expect(admitWorkFile('a.svg', Buffer.from('<svg/>'))).toMatchObject({ ok: false, reason: 'type' });
      expect(admitWorkFile('noext', Buffer.from('x'))).toMatchObject({ ok: false, reason: 'type' });
      expect(admitWorkFile('a.txt', Buffer.alloc(0))).toMatchObject({ ok: false, reason: 'empty' });
      expect(admitWorkFile('/', Buffer.from('x'))).toMatchObject({ ok: false, reason: 'name' });
      const big = Buffer.alloc(MAX_WORK_FILE_BYTES + 1, 0x61);
      expect(admitWorkFile('big.txt', big)).toMatchObject({ ok: false, reason: 'size' });
      const as = (type: string) => servedAs({ id: '0'.repeat(32), name: 'x', type, size: 1, at: 1 });
      expect(as('image/png')).toEqual({ type: 'image/png', download: false });
      expect(as('application/json')).toEqual({ type: 'text/plain; charset=utf-8', download: false });
      expect(as('application/pdf')).toEqual({ type: 'application/octet-stream', download: true });
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
  let inject: (o: { method: string; url: string; payload?: unknown; headers?: Record<string, string> }) => Promise<{
    statusCode: number;
    headers: Record<string, unknown>;
    rawPayload: Buffer;
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
    const created = await inject({
      method: 'POST',
      url: api(),
      payload: { title: 'Outline order', status: 'needs-refinement' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data?.item).toMatchObject({
      key: 'W-1',
      status: 'needs-refinement',
      author: { kind: 'human' },
    });
    expect(JSON.parse(readFileSync(workPath(ws), 'utf8')).items[0]).toMatchObject({
      status: 'todo',
      todoStatus: 'needs-refinement',
    });
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

  it('lists Ready for work in pickup order, with positions', async () => {
    const tool = (args: Record<string, unknown>) =>
      inject({ method: 'POST', url: `/api/canvas/${ws}/command`, payload: { tool: 'canvas_work', arguments: args } });
    for (const title of ['R1', 'R2'])
      await tool({ action: 'create', title, status: 'ready-for-work', requestId: crypto.randomUUID() });
    const moved = await tool({ action: 'update', key: 'W-4', position: 1 });
    expect(moved.json().data).toMatchObject({ item: { key: 'W-4', position: 1 } });
    const listed = await tool({ action: 'list', status: 'ready-for-work' });
    const items = (listed.json().data as { items: { key: string; position: number }[] }).items;
    expect(items.map((i) => [i.key, i.position])).toEqual([
      ['W-4', 1],
      ['W-3', 2],
    ]);
  });

  it('keeps unknown keys on write, and never writes over a file it cannot read', async () => {
    const raw = JSON.parse(readFileSync(workPath(ws), 'utf8'));
    raw.future = { kept: true };
    raw.items[0].later = 'kept';
    writeFileSync(workPath(ws), JSON.stringify(raw));
    await inject({ method: 'PATCH', url: api('/W-2'), payload: { status: 'human-required' } });
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

  it('round-trips a pull request through the routes and the canvas_work tool, and clears it with null', async () => {
    const url = 'https://github.com/example/repo/pull/58';
    const created = await inject({ method: 'POST', url: api(), payload: { title: 'PR item', pr: url } });
    expect(created.statusCode).toBe(201);
    const key = (created.json().data?.item as { key: string }).key;
    expect((await inject({ method: 'GET', url: api(`/${key}`) })).json().data).toMatchObject({ item: { pr: { url } } });
    for (const pr of ['javascript:alert(1)', 'http://example.com/pull/1'])
      expect((await inject({ method: 'PATCH', url: api(`/${key}`), payload: { pr } })).statusCode).toBe(400);
    const tool = (args: Record<string, unknown>) =>
      inject({ method: 'POST', url: `/api/canvas/${ws}/command`, payload: { tool: 'canvas_work', arguments: args } });
    const linked = await tool({ action: 'update', key, pr: { url, branch: 'build/pr-item' } });
    expect(linked.json().data).toMatchObject({ item: { pr: { url, branch: 'build/pr-item' } } });
    const cleared = await inject({ method: 'PATCH', url: api(`/${key}`), payload: { pr: null } });
    expect(cleared.statusCode).toBe(200);
    expect((cleared.json().data?.item as { pr?: unknown }).pr).toBeUndefined();
    expect(
      JSON.parse(readFileSync(workPath(ws), 'utf8')).items.find((i: { title: string }) => i.title === 'PR item').pr
    ).toBeUndefined();
  });

  it('attaches, serves, lists and removes a file, keeping the bytes private and out of every path', async () => {
    const created = await inject({ method: 'POST', url: api(), payload: { title: 'Has a file' } });
    const key = (created.json().data?.item as { key: string }).key;
    const number = Number(key.slice(2));
    const bytes = png(3, 2);
    const upload = (name: string, payload: Buffer) =>
      inject({
        method: 'POST',
        url: api(`/${key}/attachments?name=${encodeURIComponent(name)}`),
        payload,
        headers: { 'content-type': 'application/octet-stream' },
      });
    const up = await upload('../../shot.png', bytes);
    expect(up.statusCode).toBe(201);
    const attachment = up.json().data?.attachment as { id: string; name: string; size: number; type: string };
    expect(attachment).toMatchObject({ name: 'shot.png', size: bytes.length, type: 'image/png' });
    const stored = resolve(workPath(ws), '..', 'work-files', String(number), attachment.id);
    expect(statSync(stored).mode & 0o777).toBe(0o600);
    expect(readFileSync(stored).equals(bytes)).toBe(true);

    expect((await upload('fake.png', Buffer.from('<script>alert(1)</script>xxxx'))).statusCode).toBe(400);
    expect((await upload('page.html', Buffer.from('<html></html>'))).statusCode).toBe(415);

    const got = await inject({ method: 'GET', url: api(`/${key}/attachments/${attachment.id}`) });
    expect(got.statusCode).toBe(200);
    expect(got.rawPayload.equals(bytes)).toBe(true);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(got.headers['content-security-policy']).toBe('sandbox');

    const tool = await inject({
      method: 'POST',
      url: `/api/canvas/${ws}/command`,
      payload: { tool: 'canvas_work', arguments: { action: 'read', key } },
    });
    expect(tool.json().data).toMatchObject({ item: { attachments: [{ id: attachment.id, name: 'shot.png' }] } });

    const gone = await inject({ method: 'DELETE', url: api(`/${key}/attachments/${attachment.id}`) });
    expect(gone.statusCode).toBe(200);
    expect(existsSync(stored)).toBe(false);
    expect((await inject({ method: 'GET', url: api(`/${key}/attachments/${attachment.id}`) })).statusCode).toBe(404);
    expect((await inject({ method: 'GET', url: api(`/${key}/attachments/..%2F..%2Fwork.json`) })).statusCode).toBe(404);
    expect(
      (
        await inject({
          method: 'POST',
          url: api('/W-999/attachments?name=a.png'),
          payload: bytes,
          headers: { 'content-type': 'application/octet-stream' },
        })
      ).statusCode
    ).toBe(404);
  });

  it('attaches a canvas object by reference, and reads it back after the object is deleted', async () => {
    const created = await inject({ method: 'POST', url: api(), payload: { title: 'Points at a note' } });
    const key = (created.json().data?.item as { key: string }).key;
    const command = (tool: string, args: Record<string, unknown>) =>
      inject({ method: 'POST', url: `/api/canvas/${ws}/command`, payload: { tool, arguments: args } });
    expect((await command('canvas_create', { operations: [create('work-note')] })).statusCode).toBe(200);

    const unknown = await inject({
      method: 'PATCH',
      url: api(`/${key}`),
      payload: { attachObjects: ['no-such-object'] },
    });
    expect(unknown.statusCode).toBe(404);
    const attached = await command('canvas_work', { action: 'update', key, attachObjects: ['work-note'] });
    expect(attached.statusCode).toBe(200);
    expect(attached.json().data?.item).toMatchObject({ attachments: [{ kind: 'object', id: 'work-note' }] });
    expect((await inject({ method: 'GET', url: api(`/${key}/attachments/work-note`) })).statusCode).toBe(404);

    const deleted = await command('canvas_delete', {
      operations: [{ kind: 'delete', opId: 'drop-work-note', objectId: 'work-note' }],
    });
    expect(deleted.statusCode).toBe(200);
    const read = await inject({ method: 'GET', url: api(`/${key}`) });
    expect(read.statusCode).toBe(200);
    expect(read.json().data?.item).toMatchObject({ attachments: [{ kind: 'object', id: 'work-note' }] });
    expect(
      (await inject({ method: 'PATCH', url: api(`/${key}`), payload: { attachObjects: ['work-note'] } })).statusCode
    ).toBe(404);
    const removed = await inject({ method: 'PATCH', url: api(`/${key}`), payload: { detachObjects: ['work-note'] } });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().data?.item).not.toHaveProperty('attachments');
  });

  it('removes the stored bytes when the canvas quota refuses the record', async () => {
    const created = await inject({ method: 'POST', url: api(), payload: { title: 'Over quota' } });
    const key = (created.json().data?.item as { key: string }).key;
    process.env.CODEMAN_CANVAS_ASSET_QUOTA_BYTES = '10';
    try {
      const refused = await inject({
        method: 'POST',
        url: api(`/${key}/attachments?name=big.png`),
        payload: png(3, 2),
        headers: { 'content-type': 'application/octet-stream' },
      });
      expect(refused.statusCode).toBe(409);
    } finally {
      delete process.env.CODEMAN_CANVAS_ASSET_QUOTA_BYTES;
    }
    const dir = resolve(workPath(ws), '..', 'work-files', key.slice(2));
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });
});
