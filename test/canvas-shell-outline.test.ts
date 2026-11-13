/**
 * The pure half of the canvas shell's outline (PC13): session rows, Go to, the workspace list, New workspace and
 * the notice line. No DOM and no network.
 */
import { describe, expect, it } from 'vitest';
import {
  GOTO_GROUPS,
  MAX_GOTO_PER_GROUP,
  gotoResults,
  launchChoices,
  newlyNeeding,
  parseSessions,
  REFRESH_GAP_MS,
  REFRESH_SETTLE_MS,
  refreshDelay,
  sessionRows,
  withStarted,
  type ShellSessionRow,
} from '../packages/canvas/src/sessions.js';
import {
  CASE_NAME_REFUSAL,
  caseChoices,
  caseNameRefusal,
  parseCases,
  parseWorkspaces,
  refusalText,
  succeeded,
  workspaceHref,
  workspaceRows,
} from '../packages/canvas/src/workspaces.js';
import { releaseUnseen, securityNoticeDue, seenNotices, shellLine } from '../packages/canvas/src/shell-notices.js';
import { CreateCaseSchema } from '../src/web/schemas.js';

const row = (id: string, extra: Partial<ShellSessionRow> = {}): ShellSessionRow => ({
  id,
  name: id,
  mode: 'claude',
  kind: 'terminal',
  state: 'idle',
  since: 0,
  lastActivityAt: 0,
  lastSubmitAt: 0,
  ...extra,
});

describe('session rows', () => {
  it('words every row with a kind, a glyph and a state, most urgent first', () => {
    const rows = sessionRows([
      row('quiet', { lastActivityAt: 5 }),
      row('chat', { kind: 'conversation', state: 'working', lastSubmitAt: 3 }),
      row('blocked', { kind: 'task', state: 'needs', lastActivityAt: 9 }),
      row('gone', { state: 'done', lastActivityAt: 8 }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['blocked', 'chat', 'quiet', 'gone']);
    expect(rows[0]).toMatchObject({ kindWord: 'Task', stateWord: 'Needs you', label: 'blocked, Task, Needs you' });
    expect(rows[3]).toMatchObject({ stateWord: 'Ended' });
    for (const r of rows) expect(r.glyph).toMatch(/^\S$/);
    expect(new Set(rows.map((r) => r.glyph)).size).toBe(4);
  });
  it('keeps one row per session', () => {
    expect(sessionRows([row('a'), row('a', { state: 'working' }), row('b')]).map((r) => r.id)).toEqual(['a', 'b']);
  });
  it('adds a started session once, whichever of the answer and the list arrives first', () => {
    const started = { id: 'new', name: 'Shell session', mode: 'shell', at: 100 };
    const answerFirst = withStarted([row('a')], started);
    expect(answerFirst.map((r) => r.id)).toEqual(['a', 'new']);
    expect(withStarted(answerFirst, started)).toHaveLength(2);
    const listFirst = [row('a'), row('new', { name: 'w2-case' })];
    expect(withStarted(listFirst, started)).toEqual(listFirst);
  });
  it('announces only a session that newly needs the person', () => {
    const before = [row('a', { state: 'needs' }), row('b')];
    const after = [
      row('a', { state: 'needs' }),
      row('b', { state: 'needs', name: 'build' }),
      row('c', { state: 'error' }),
    ];
    expect(newlyNeeding(before, after)).toEqual(['build']);
    expect(newlyNeeding(after, after)).toEqual([]);
  });
  it('reads the route answer, leaving out a row it cannot read', () => {
    const body = {
      success: true,
      data: { sessions: [row('a'), { id: 'b', state: 'sideways' }, row('c', { kind: 'task' })] },
    };
    expect(parseSessions(body)?.map((r) => r.id)).toEqual(['a', 'c']);
    expect(parseSessions({ success: false, error: 'no' })).toBeNull();
    expect(parseSessions(null)).toBeNull();
  });
  it('offers the listed agent CLIs and then a shell, with the reason for one that cannot start', () => {
    expect(
      launchChoices([
        { id: 'claude', label: 'Claude', available: true },
        { id: 'codex', label: 'Codex', available: false, reason: 'Not installed' },
      ])
    ).toEqual([
      { mode: 'claude', label: 'Claude', available: true, reason: '' },
      { mode: 'codex', label: 'Codex', available: false, reason: 'Not installed' },
      { mode: 'shell', label: 'Shell', available: true, reason: '' },
    ]);
    expect(launchChoices([]).map((c) => c.mode)).toEqual(['shell']);
  });
});

describe('the session list refetch', () => {
  it('follows an event shortly, and at most once per gap while events keep arriving', () => {
    const now = 1_000_000;
    expect(refreshDelay(now, 0)).toBe(REFRESH_SETTLE_MS);
    expect(refreshDelay(now, now - REFRESH_GAP_MS * 5)).toBe(REFRESH_SETTLE_MS);
    expect(refreshDelay(now, now)).toBe(REFRESH_GAP_MS);
    expect(refreshDelay(now, now - 500)).toBe(REFRESH_GAP_MS - 500);
    // A clock that moved back never makes the wait longer than the gap, so a change still shows within it.
    expect(refreshDelay(now, now + 60_000)).toBe(REFRESH_GAP_MS);
    expect(REFRESH_GAP_MS).toBe(2000);
  });
  it('makes a busy server cost one fetch per gap, not one per event', () => {
    // Events every 500 ms for a minute, each fetch starting when its timer fires.
    let last = 0,
      due = -1,
      fetches = 0;
    for (let now = 10_000; now < 70_000; now += 100) {
      if (due >= 0 && now >= due) {
        last = now;
        due = -1;
        fetches++;
      }
      if (now % 500 === 0 && due < 0) due = now + refreshDelay(now, last);
    }
    expect(fetches).toBeLessThanOrEqual(31);
    expect(fetches).toBeGreaterThanOrEqual(28);
  });
});

describe('Go to', () => {
  const source = {
    sessions: sessionRows([row('s1', { name: 'api server' }), row('s2', { name: 'Docs (v2)' })]),
    workspaces: [
      { id: 'w1', name: 'api', current: true },
      { id: 'w2', name: 'api-docs', current: false },
    ],
    objects: [
      { id: 'o1', label: 'API plan' },
      { id: 'o2', label: 'Budget' },
    ],
  };
  it('groups matches as sessions, workspaces, then objects', () => {
    expect(GOTO_GROUPS.map((g) => g.group)).toEqual(['sessions', 'workspaces', 'objects']);
    expect(gotoResults('API', source).map((r) => [r.group, r.id])).toEqual([
      ['sessions', 's1'],
      ['workspaces', 'w2'],
      ['objects', 'o1'],
    ]);
  });
  it('matches a literal substring, never a pattern', () => {
    expect(gotoResults('(v2)', source).map((r) => r.id)).toEqual(['s2']);
    expect(gotoResults('.*', source)).toEqual([]);
    expect(gotoResults('a.i', source)).toEqual([]);
  });
  it('lists sessions and other workspaces for an empty query, and no objects', () => {
    expect(gotoResults('  ', source).map((r) => r.id)).toEqual(['s1', 's2', 'w2']);
  });
  it('bounds every group', () => {
    const many = { ...source, objects: Array.from({ length: 40 }, (_, i) => ({ id: `o${i}`, label: `note ${i}` })) };
    expect(gotoResults('note', many)).toHaveLength(MAX_GOTO_PER_GROUP);
  });
});

describe('workspaces', () => {
  it('reads the list with and without session counts', () => {
    const list = parseWorkspaces({
      data: {
        workspaces: [
          { id: 'w1', caseName: 'alpha', sessions: { live: 2, needsYou: 1 } },
          { id: 'w2', caseName: 'beta' },
          { id: 'bad id', caseName: 'x' },
        ],
      },
    });
    expect(list?.map((w) => w.id)).toEqual(['w1', 'w2']);
    expect(parseWorkspaces({ data: {} })).toBeNull();
    const rows = workspaceRows(list!, 'w2');
    expect(rows).toEqual([
      { id: 'w1', name: 'alpha', current: false, needsYou: 1, label: 'alpha, 1 session needs you' },
      { id: 'w2', name: 'beta', current: true, needsYou: 0, label: 'beta, open' },
    ]);
    expect(workspaceRows([{ id: 'w3', caseName: 'c', sessions: { live: 4, needsYou: 3 } }], 'w3')[0]!.label).toBe(
      'c, open, 3 sessions need you'
    );
    expect(workspaceHref('w1')).toBe('canvas/w1');
  });
  it('offers the local cases that answered and have no canvas yet', () => {
    const cases = parseCases([
      { name: 'alpha', location: 'local' },
      { name: 'beta' },
      { name: 'far', location: 'remote' },
      { name: 'box', location: 'docker' },
      { name: 'mount', location: 'linked-local', unreachable: true },
      { name: 'linked', location: 'linked-local' },
      { nope: true },
    ]);
    expect(caseChoices(cases!, [{ caseName: 'alpha' }])).toEqual(['beta', 'linked']);
    expect(parseCases({ success: true, data: [{ name: 'a' }] })?.map((c) => c.name)).toEqual(['a']);
    expect(parseCases({ success: false })).toBeNull();
  });
  it("refuses a name the server would refuse, in the server's words", () => {
    expect(caseNameRefusal('notes-2')).toBe('');
    for (const name of ['two words', 'a/b', '..', 'naïve', 'x;y']) {
      expect(caseNameRefusal(name)).toBe(CASE_NAME_REFUSAL);
      const server = CreateCaseSchema.safeParse({ name });
      expect(server.success).toBe(false);
      if (!server.success) expect(server.error.issues[0]!.message).toBe(CASE_NAME_REFUSAL);
    }
    expect(caseNameRefusal('')).not.toBe('');
    expect(caseNameRefusal('a'.repeat(101))).not.toBe('');
    expect(CreateCaseSchema.safeParse({ name: 'notes-2' }).success).toBe(true);
  });
  it("shows the server's reason for a refusal and reads a failed envelope as a failure", () => {
    expect(refusalText(409, { success: false, error: 'Case already exists' })).toBe('Case already exists');
    expect(refusalText(500, null)).toBe('Codeman refused this (500).');
    expect(refusalText(0, null)).toBe('Codeman could not be reached.');
    expect(succeeded(true, { success: false, error: 'x' })).toBe(false);
    expect(succeeded(true, { sessionId: 'a' })).toBe(true);
    expect(succeeded(false, { success: true })).toBe(false);
  });
});

describe('the notice line', () => {
  const now = new Date(2026, 10, 13, 12).getTime();
  const notice = (extra: Record<string, unknown> = {}) => ({
    id: 'n1',
    message: 'Check your keys',
    published: '2026-11-01',
    expires: '2026-11-30',
    ...extra,
  });
  it('is due for a notice in its window that nobody closed and whose CLI is installed', () => {
    const opts = { seen: [], now, available: { opencode: true } };
    expect(securityNoticeDue([notice()], opts)).toBe(true);
    expect(securityNoticeDue([notice({ cli: 'opencode' })], opts)).toBe(true);
    expect(securityNoticeDue([notice({ cli: 'codex' })], opts)).toBe(false);
    expect(securityNoticeDue([notice()], { ...opts, seen: ['n1'] })).toBe(false);
    expect(securityNoticeDue([notice({ expires: '2026-11-12' })], opts)).toBe(false);
    expect(securityNoticeDue([notice({ published: '2026-11-14' })], opts)).toBe(false);
    expect(securityNoticeDue([notice({ expires: '2026-02-30' })], opts)).toBe(false);
    expect(securityNoticeDue([null, 'x', {}, notice({ id: '' })], opts)).toBe(false);
    expect(securityNoticeDue('nope', opts)).toBe(false);
  });
  it('reads the seen list the dashboard keeps, and nothing from a broken one', () => {
    expect(seenNotices('["a",2,"b"]')).toEqual(['a', 'b']);
    expect(seenNotices('{broken')).toEqual([]);
    expect(seenNotices(null)).toEqual([]);
  });
  it('knows a release this browser has not seen, and stays quiet on a first visit', () => {
    expect(releaseUnseen('1.46.0', '1.47.0')).toBe(true);
    expect(releaseUnseen('1.47.0', '1.47.0')).toBe(false);
    expect(releaseUnseen(null, '1.47.0')).toBe(false);
    expect(releaseUnseen('1.46.0', undefined)).toBe(false);
  });
  it('shows at most one line, the most pressing first', () => {
    expect(shellLine({ reboot: 2, security: true, release: true })).toEqual({
      kind: 'reboot',
      text: '2 sessions can be rebuilt after a restart',
    });
    expect(shellLine({ reboot: 1, security: false, release: false })?.text).toBe(
      '1 session can be rebuilt after a restart'
    );
    expect(shellLine({ reboot: 0, security: true, release: true })).toEqual({
      kind: 'security',
      text: 'Security notice',
    });
    expect(shellLine({ reboot: 0, security: false, release: true })?.kind).toBe('release');
    expect(shellLine({ reboot: 0, security: false, release: false })).toBeNull();
  });
});
