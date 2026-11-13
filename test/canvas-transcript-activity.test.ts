/**
 * Tool rows from Claude's own transcript row shapes: the ledger alone, then through the REAL transcript reader, whose
 * prompt and reply rows must stay exactly what reply routing reads. Route registration with a temporary HOME; no port.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerSessionRoutes } from '../src/web/routes/session-routes.js';
import { createMockRouteContext, type MockRouteContext } from './mocks/index.js';
import { MAX_TOOL_EXCERPT, MAX_TOOL_INPUT, MAX_TOOL_ROWS, ToolLedger } from '../src/canvas/transcript-activity.js';

const use = (id: string, name: string, input: unknown) => [{ type: 'tool_use', id, name, input }];
const result = (id: string, content: unknown, error = false) => [
  { type: 'tool_result', tool_use_id: id, content, ...(error ? { is_error: true } : {}) },
];

describe('the tool ledger', () => {
  it('pairs a call with its result and marks a failed one', () => {
    const ledger = new ToolLedger();
    ledger.uses(use('t1', 'Bash', { command: 'ls -la' }), '2026-11-13T10:00:00Z', 2);
    ledger.uses(use('t2', 'Bash', { command: 'false' }), undefined, 2);
    ledger.uses(use('t3', 'Bash', { command: 'sleep 60' }), undefined, 3);
    ledger.results(result('t1', 'a\nb'));
    ledger.results(result('t2', [{ type: 'text', text: 'exit 1' }], true));
    const [a, b, c] = ledger.rows();
    expect(a).toMatchObject({ id: 't1', name: 'Bash', input: 'ls -la', status: 'ok', head: 'a\nb', after: 2 });
    expect(a.at).toBe('2026-11-13T10:00:00Z');
    expect(b).toMatchObject({ status: 'error', head: 'exit 1' });
    expect(c).toMatchObject({ status: 'pending', head: '', tail: '' });
  });

  it('cuts a long input and a long result to fixed lengths and says how much is left out', () => {
    const ledger = new ToolLedger();
    ledger.uses(use('t1', 'Bash', { command: 'echo ' + 'x'.repeat(5000) }), undefined, 0);
    const body = 'HEAD' + 'm'.repeat(10_000) + 'TAIL';
    ledger.results(result('t1', body));
    const [row] = ledger.rows();
    expect(row.input.length).toBeLessThanOrEqual(MAX_TOOL_INPUT);
    expect(row.head.length).toBeLessThanOrEqual(MAX_TOOL_EXCERPT);
    expect(row.tail.length).toBeLessThanOrEqual(MAX_TOOL_EXCERPT);
    expect(row.head.startsWith('HEAD')).toBe(true);
    expect(row.tail.endsWith('TAIL')).toBe(true);
    expect(row.cut).toBe(body.length - 2 * MAX_TOOL_EXCERPT);
  });

  it('masks credentials and strips escape sequences and control characters from what it keeps', () => {
    const ledger = new ToolLedger();
    ledger.uses(
      use('t1', 'Bash', { command: 'curl -H "Authorization: Bearer abc.def.ghi" https://example.test\u0007' }),
      undefined,
      0
    );
    ledger.results(result('t1', '\u001b[31mpassword=hunter2\u001b[0m\nsk-ant-REALLYSECRETVALUE1234567890\nplain line'));
    const [row] = ledger.rows();
    const kept = JSON.stringify(row);
    expect(kept).not.toContain('abc.def.ghi');
    expect(kept).not.toContain('hunter2');
    expect(kept).not.toContain('REALLYSECRETVALUE');
    expect(kept).not.toContain('\\u001b');
    expect(kept).not.toContain('\\u0007');
    expect(row.head).toContain('plain line');
  });

  it('names what a call read: a file, a search, a web address, a canvas read; a write or a command names nothing', () => {
    const ledger = new ToolLedger();
    ledger.uses(use('t1', 'Read', { file_path: '/work/notes.md' }), undefined, 0);
    ledger.uses(use('t2', 'Grep', { pattern: 'TODO', path: 'src' }), undefined, 0);
    ledger.uses(use('t3', 'WebFetch', { url: 'https://example.test/page', prompt: 'summarise' }), undefined, 0);
    ledger.uses(use('t4', 'mcp__codeman__canvas_read', { targetIds: ['n1'] }), undefined, 0);
    ledger.uses(use('t5', 'Write', { file_path: '/work/out.md', content: 'x' }), undefined, 0);
    ledger.uses(use('t6', 'Bash', { command: 'cat /work/notes.md' }), undefined, 0);
    ledger.uses(use('t7', 'mcp__codeman__canvas_update', { operations: [] }), undefined, 0);
    expect(ledger.rows().map((r) => r.reads)).toEqual([
      { kind: 'file', label: '/work/notes.md' },
      { kind: 'search', label: 'TODO in src' },
      { kind: 'web', label: 'https://example.test/page' },
      { kind: 'canvas', label: 'canvas_read {"targetIds":["n1"]}' },
      undefined,
      undefined,
      undefined,
    ]);
    expect(ledger.rows()[3].name).toBe('canvas_read');
  });

  it('reads a release request and its printed outcome from the uncut text, past the excerpt and a masked line', () => {
    const ledger = new ToolLedger();
    ledger.uses(use('t1', 'Bash', { command: 'DEPLOY_TOKEN=abc codeman-deploy 0123456789abcdef' }), undefined, 0);
    ledger.results(
      result(
        't1',
        `queued request r-1\ndeploy d-42; log /x/d-42.log\n${'log line\n'.repeat(2000)}outcome: failed at test: boom\n`
      )
    );
    const [row] = ledger.rows();
    expect(row.release).toEqual({
      request: { action: 'deploy', target: '0123456789abcdef' },
      printed: { deployId: 'd-42', outcome: 'failed', failedStep: 'test' },
    });
    expect(row.input).not.toContain('abc codeman');
  });

  it('keeps the newest rows, counts the rest, and ignores a replayed call and a result with no call', () => {
    const ledger = new ToolLedger();
    for (let i = 0; i < MAX_TOOL_ROWS + 5; i += 1)
      ledger.uses(use(`t${i}`, 'Bash', { command: `echo ${i}` }), undefined, i);
    ledger.uses(use(`t${MAX_TOOL_ROWS + 4}`, 'Bash', { command: 'changed' }), undefined, 9999);
    ledger.results(result('nobody', 'x'));
    const rows = ledger.rows();
    expect(rows).toHaveLength(MAX_TOOL_ROWS);
    expect(ledger.droppedCount).toBe(5);
    expect(rows[0].id).toBe('t5');
    expect(rows.at(-1)).toMatchObject({ input: `echo ${MAX_TOOL_ROWS + 4}`, after: MAX_TOOL_ROWS + 4 });
  });

  it('survives content that is not what the CLI writes', () => {
    const ledger = new ToolLedger();
    ledger.uses('text', undefined, 0);
    ledger.uses([null, 3, { type: 'tool_use' }, { type: 'tool_use', id: 't1', name: 'X', input: null }], undefined, 0);
    ledger.results([{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image' }, 7] }]);
    expect(ledger.rows()).toEqual([
      { id: 't1', name: 'X', input: '', status: 'ok', head: '[image]', tail: '', cut: 0, at: null, after: 0 },
    ]);
  });
});

type Reader = Parameters<NonNullable<NonNullable<Parameters<typeof registerSessionRoutes>[2]>['transcriptReader']>>[0];
const user = (text: string) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
const said = (text: string) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const called = (id: string, name: string, input: unknown, extras: Record<string, unknown> = {}) => ({
  type: 'assistant',
  timestamp: '2026-11-13T10:00:11Z',
  message: { role: 'assistant', content: use(id, name, input) },
  ...extras,
});
const returned = (id: string, content: string) => ({
  type: 'user',
  message: { role: 'user', content: result(id, content) },
});

describe('tool rows through the real transcript reader', () => {
  let app: FastifyInstance, ctx: MockRouteContext, reader: Reader, home: string, previousHome: string | undefined;
  let file: string;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'canvas-activity-reader-'));
    previousHome = process.env.HOME;
    process.env.HOME = home;
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    ctx = createMockRouteContext();
    ctx._session.mode = 'claude';
    registerSessionRoutes(app, ctx, { transcriptReader: (r) => (reader = r) });
    await app.ready();
    const dir = join(home, '.claude', 'projects', '-workspace');
    mkdirSync(dir, { recursive: true });
    file = join(dir, `${ctx._session.id}.jsonl`);
  });
  afterEach(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    await app.close();
  });
  const write = (entries: unknown[]) => writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

  it('places each call after the rows before it, leaves the prompt and reply rows as they were, and skips a subagent', async () => {
    write([
      user('what is in notes?'),
      said('Looking.'),
      called('t1', 'Read', { file_path: 'notes.md' }),
      returned('t1', 'alpha'),
      called('side', 'Bash', { command: 'rm -rf x' }, { isSidechain: true }),
      called('t2', 'Bash', { command: 'wc -l notes.md' }),
      said('It has one line.'),
      user('thanks'),
    ]);
    const rows = (await reader.rows(ctx._session.id))!;
    expect(rows).toEqual([
      { role: 'user', text: 'what is in notes?' },
      { role: 'assistant', text: 'Looking.' },
      { role: 'assistant', text: 'It has one line.' },
      { role: 'user', text: 'thanks' },
    ]);
    const activity = (await reader.activity(ctx._session.id))!;
    expect(activity.dropped).toBe(0);
    expect(activity.tools.map((t) => [t.id, t.after, t.status, t.head])).toEqual([
      ['t1', 2, 'ok', 'alpha'],
      ['t2', 2, 'pending', ''],
    ]);
    expect(activity.tools[0].at).toBe('2026-11-13T10:00:11Z');
  });

  it('the public last-response answer carries no tool row', async () => {
    write([user('q'), called('t1', 'Read', { file_path: 'a' }), returned('t1', 'secret body'), said('a')]);
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${ctx._session.id}/last-response?context=full` });
    expect(res.body).not.toContain('secret body');
    expect(res.json().messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
  });

  it('answers null for a CLI whose transcript is not read this way, and for a session it does not hold', async () => {
    ctx._session.mode = 'shell';
    expect(await reader.activity(ctx._session.id)).toBeNull();
    expect(await reader.activity('nobody')).toBeNull();
  });
});
