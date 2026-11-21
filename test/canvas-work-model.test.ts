/**
 * @fileoverview The Work view's pure part (`packages/canvas/src/work-model.ts`): an item's live state in the
 * Sessions vocabulary, lane order (Ready for work by position), filters, counts, the outline's list and the steps
 * Shift+Left/Right and Shift+Up/Down take, and the draft Ask an agent writes.
 */
import { describe, expect, it } from 'vitest';
import {
  answeredDescription,
  askAgentDraft,
  assigneeLabel,
  deletedBy,
  deletedCount,
  fileSize,
  isImageAttachment,
  itemState,
  laneItems,
  matchesFilter,
  openCount,
  outlineItems,
  parseWork,
  readyStep,
  restoreStatus,
  stepStatus,
  visibleStatuses,
  workCounts,
  WORK_FILE_ACCEPT,
  type WorkRow,
} from '../packages/canvas/src/work-model.js';
import { WORK_FILE_TYPES } from '../src/canvas/work.js';
import type { ShellSessionRow } from '../src/canvas/shell-sessions.js';

const row = (number: number, patch: Partial<WorkRow> = {}): WorkRow => ({
  key: `W-${number}`,
  number,
  title: `Item ${number}`,
  status: 'needs-refinement',
  description: '',
  assignee: null,
  sessions: [],
  author: { kind: 'human', userId: 'me' },
  createdAt: number,
  updatedAt: number,
  revision: 1,
  history: [],
  comments: [],
  ...patch,
});
const person = { kind: 'human', userId: 'me' } as const;
const session = (id: string, state: ShellSessionRow['state'], name = id): ShellSessionRow => ({
  id,
  name,
  mode: 'claude',
  kind: 'terminal',
  state,
  since: 0,
  lastActivityAt: 0,
  lastSubmitAt: 0,
});

describe('work model', () => {
  it('reads the list answer and leaves out a row it cannot read', () => {
    const body = { success: true, data: { next: 'W-3', items: [row(1), { number: 'two' }] } };
    const parsed = parseWork(body);
    expect(parsed?.next).toBe('W-3');
    expect(parsed?.items.map((i) => i.key)).toEqual(['W-1']);
    expect(parseWork({ success: false, error: 'x' })).toBeNull();
  });

  it('reads Deleted rows with their record, and keeps one whose record it cannot read, restoring it to Backlog', () => {
    const record = {
      at: 5,
      from: 'ready-for-work',
      author: { kind: 'agent', sessionId: 'abcdef1234' },
      reason: 'Dup',
    } as const;
    const gone = { ...row(2), status: 'deleted', deleted: record };
    const bare = { ...row(3), status: 'deleted', deleted: { at: 'soon' } };
    const parsed = parseWork({ success: true, data: { next: 'W-4', items: [row(1), gone, bare] } })!;
    expect(parsed.items.map((i) => [i.key, i.status])).toEqual([
      ['W-1', 'needs-refinement'],
      ['W-2', 'deleted'],
      ['W-3', 'deleted'],
    ]);
    expect(parsed.items[1]!.deleted).toEqual(record);
    expect(parsed.items[2]!.deleted).toBeUndefined();
    // Invariant I8: UndoIsAnOrdinaryMove
    expect(restoreStatus(parsed.items[1]!)).toBe('ready-for-work');
    expect(restoreStatus(parsed.items[2]!)).toBe('backlog');
    const sessions = [session('abcdef1234', 'idle', 'w4-codeman')];
    expect(deletedBy(parsed.items[1]!, sessions)).toBe('w4-codeman');
    expect(deletedBy(row(4, { status: 'deleted', deleted: { ...record, author: person } }), sessions)).toBe('you');
    expect(deletedBy(parsed.items[2]!, sessions)).toBeNull();
  });

  // Invariant I4: HiddenByDefault
  it('leaves Deleted items out of the counts, the outline, the open count and Needs you, and never steps into them', () => {
    const question = { question: 'Which?', at: 1 };
    const deleted = (number: number, from: Exclude<WorkRow['status'], 'deleted'>) =>
      row(number, { status: 'deleted', needs: question, deleted: { at: number, from, author: person } });
    const items = [
      row(1, { status: 'in-progress' }),
      row(2, { status: 'human-required', needs: question }),
      deleted(3, 'human-required'),
      deleted(4, 'in-progress'),
      row(5, { status: 'done' }),
    ];
    expect(workCounts(items).map((c) => c.status)).not.toContain('deleted');
    expect(workCounts(items).reduce((n, c) => n + c.count, 0)).toBe(3);
    expect(outlineItems(items, []).map((i) => i.number)).toEqual([2, 1]);
    expect(openCount(items)).toBe(2);
    expect(deletedCount(items)).toBe(2);
    expect(itemState(items[1]!, [])).toBe('needs');
    expect(itemState(items[2]!, [])).toBeNull();
    expect(visibleStatuses(false)).not.toContain('deleted');
    expect(visibleStatuses(true).at(-1)).toBe('deleted');
    expect(stepStatus('not-doing', 1)).toBeNull();
    expect(stepStatus('deleted', -1)).toBeNull();
    expect(stepStatus('deleted', 1)).toBeNull();
  });

  it('lists Deleted newest deletion first, whatever changed since', () => {
    const items = [
      row(1, { status: 'deleted', updatedAt: 90, deleted: { at: 10, from: 'backlog', author: person } }),
      row(2, { status: 'deleted', updatedAt: 30, deleted: { at: 30, from: 'done', author: person } }),
      row(3, { status: 'deleted', updatedAt: 20, deleted: { at: 20, from: 'backlog', author: person } }),
    ];
    expect(laneItems(items, 'deleted', []).map((i) => i.number)).toEqual([2, 3, 1]);
  });

  it('keeps the attachments it can read and drops one whose id could reach another URL', () => {
    const good = { id: 'a'.repeat(32), name: 'shot.png', type: 'image/png', size: 2048, at: 1 };
    const bad = { id: '../../x', name: 'x.png', type: 'image/png', size: 1, at: 1 };
    const body = (attachments: unknown) => ({
      success: true,
      data: { next: 'W-2', items: [{ ...row(1), attachments }] },
    });
    expect(parseWork(body([good, bad]))?.items[0]!.attachments).toEqual([good]);
    expect(parseWork(body([bad]))?.items[0]!.attachments).toBeUndefined();
    expect(parseWork(body('nope'))?.items[0]!.key).toBe('W-1');
  });

  it('offers every extension the server admits and thumbnails only the images it serves as themselves', () => {
    const offered = WORK_FILE_ACCEPT.split(',');
    for (const ext of Object.keys(WORK_FILE_TYPES)) expect(offered).toContain(ext);
    expect(offered).toContain('.jpeg');
    expect(isImageAttachment('image/png')).toBe(true);
    expect(isImageAttachment('image/svg+xml')).toBe(false);
    expect(isImageAttachment('application/pdf')).toBe(false);
    expect([fileSize(900), fileSize(2048), fileSize(3.5 * 1024 * 1024)]).toEqual(['900 B', '2 KB', '3.5 MB']);
  });

  it('says Needs you while the item holds a question, else the most urgent linked session, Ended when gone', () => {
    const sessions = [session('a', 'idle'), session('b', 'working')];
    expect(itemState(row(1), sessions)).toBeNull();
    expect(itemState(row(1, { sessions: ['a', 'b'] }), sessions)).toBe('working');
    expect(itemState(row(1, { sessions: ['gone'] }), sessions)).toBe('done');
    expect(itemState(row(1, { sessions: ['a'], needs: { question: 'Which?', at: 1 } }), sessions)).toBe('needs');
  });

  it('orders open lanes urgent first then oldest first, and closed lanes newest change first', () => {
    const sessions = [session('a', 'needs'), session('b', 'idle')];
    const items = [
      row(1, { updatedAt: 30, sessions: ['b'] }),
      row(2, { updatedAt: 10, sessions: ['a'] }),
      row(3, { updatedAt: 20 }),
      row(4, { status: 'done', updatedAt: 5, sessions: ['a'] }),
      row(5, { status: 'done', updatedAt: 9 }),
    ];
    expect(laneItems(items, 'needs-refinement', sessions).map((i) => i.number)).toEqual([2, 1, 3]);
    expect(laneItems(items, 'done', sessions).map((i) => i.number)).toEqual([5, 4]);
  });

  it('lists a new item last in Backlog and In progress, whatever changed more recently', () => {
    const a = { createdAt: 1, updatedAt: 50 };
    const b = { createdAt: 2, updatedAt: 5 };
    const added = { createdAt: 3, updatedAt: 10 };
    const items = [
      row(3, { status: 'backlog', ...added }),
      row(2, { status: 'backlog', ...b }),
      row(1, { status: 'backlog', ...a }),
      row(6, { status: 'in-progress', ...added }),
      row(5, { status: 'in-progress', ...b }),
      row(4, { status: 'in-progress', ...a }),
    ];
    expect(laneItems(items, 'backlog', []).map((i) => i.number)).toEqual([1, 2, 3]);
    expect(laneItems(items, 'in-progress', []).map((i) => i.number)).toEqual([4, 5, 6]);
  });

  it('orders Ready for work by position, never by urgency, and steps a card one place up or down', () => {
    const sessions = [session('a', 'needs')];
    const ready = (number: number, position: number, extra: Partial<WorkRow> = {}) =>
      row(number, { status: 'ready-for-work', position, ...extra });
    const items = [ready(1, 2), ready(2, 3, { sessions: ['a'], updatedAt: 99 }), ready(3, 1)];
    expect(laneItems(items, 'ready-for-work', sessions).map((i) => i.number)).toEqual([3, 1, 2]);
    expect(readyStep(items, items[2]!, -1)).toBeNull();
    expect(readyStep(items, items[2]!, 1)).toBe(2);
    expect(readyStep(items, items[1]!, 1)).toBeNull();
    expect(readyStep(items, row(9), 1)).toBeNull();
  });

  it('lists Human required before In progress in the outline', () => {
    const items = [
      row(1, { status: 'in-progress' }),
      row(2, { status: 'human-required' }),
      row(3, { status: 'needs-refinement' }),
    ];
    expect(outlineItems(items, []).map((i) => i.number)).toEqual([2, 1]);
  });

  it('filters by assignee kind and by title or key', () => {
    const mine = row(1, { assignee: { kind: 'person' }, title: 'Fix the rail' });
    const agent = row(12, { assignee: { kind: 'session', sessionId: 's' } });
    const none = row(3);
    expect(matchesFilter(mine, 'you', '')).toBe(true);
    expect(matchesFilter(agent, 'you', '')).toBe(false);
    expect(matchesFilter(agent, 'agents', '')).toBe(true);
    expect(matchesFilter(none, 'none', '')).toBe(true);
    expect(matchesFilter(mine, 'all', 'RAIL')).toBe(true);
    expect(matchesFilter(agent, 'all', 'w-12')).toBe(true);
    expect(matchesFilter(none, 'all', 'rail')).toBe(false);
  });

  it('counts each status, how many Ready for work items have nobody, and what is open', () => {
    const items = [
      row(1, { status: 'ready-for-work' }),
      row(2, { status: 'ready-for-work', assignee: { kind: 'person' } }),
      row(3, { status: 'in-progress' }),
      row(4, { status: 'done' }),
      row(5, { status: 'not-doing' }),
    ];
    expect(workCounts(items).map((c) => c.status)).toEqual([
      'backlog',
      'needs-refinement',
      'human-required',
      'ready-for-work',
      'in-progress',
      'done',
      'not-doing',
    ]);
    expect(workCounts(items).find((c) => c.status === 'ready-for-work')).toEqual({
      status: 'ready-for-work',
      count: 2,
      unassigned: 1,
    });
    expect(workCounts(items).find((c) => c.status === 'in-progress')?.unassigned).toBe(0);
    expect(openCount(items)).toBe(3);
  });

  it('steps one lane left or right and stops at either end', () => {
    expect(stepStatus('ready-for-work', 1)).toBe('in-progress');
    expect(stepStatus('needs-refinement', -1)).toBe('backlog');
    expect(stepStatus('needs-refinement', 1)).toBe('human-required');
    expect(stepStatus('backlog', -1)).toBeNull();
    expect(stepStatus('not-doing', 1)).toBeNull();
  });

  it('names the assignee from the session list, else a short id', () => {
    const sessions = [session('abcdef1234', 'idle', 'w4-codeman')];
    expect(assigneeLabel({ assignee: null }, sessions)).toBe('Unassigned');
    expect(assigneeLabel({ assignee: { kind: 'person' } }, sessions)).toBe('You');
    expect(assigneeLabel({ assignee: { kind: 'session', sessionId: 'abcdef1234' } }, sessions)).toBe('w4-codeman');
    expect(assigneeLabel({ assignee: { kind: 'session', sessionId: 'zzzzzzzzzzzz' } }, sessions)).toBe('zzzzzzzz');
  });

  it('drafts a prompt that names the item and leaves the description to the agent', () => {
    const draft = askAgentDraft(row(43, { title: 'Ask from the detail', description: 'secret long text' }));
    expect(draft).toBe(
      'Work on W-43: Ask from the detail. Read it with canvas_work (action read, key W-43), assign it to yourself and follow its acceptance checks.'
    );
    expect(draft).not.toContain('secret long text');
  });

  it('appends a dated Q and A to the description, refusing a blank answer or an over-long result', () => {
    const at = new Date(2026, 10, 7, 23, 30);
    expect(answeredDescription('Ship it.\n\n', 'Which port?', '  3000 \n', at)).toBe(
      'Ship it.\n\n2026-11-07 Q (Which port?): 3000'
    );
    expect(answeredDescription('', 'Which port?', '3000', at)).toBe('2026-11-07 Q (Which port?): 3000');
    expect(answeredDescription('Ship it.', 'Which port?', ' \n ', at)).toBeNull();
    expect(answeredDescription('x'.repeat(7980), 'Which port?', '3000', at)).toBeNull();
    expect(answeredDescription('x'.repeat(7950), 'Which port?', '3000', at)).toHaveLength(7950 + 2 + 32);
  });
});
