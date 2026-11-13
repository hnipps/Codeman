/**
 * Reply extraction over the rows the REAL transcript reader produces from Claude's own row shapes: a prompt absorbed
 * in the middle of a turn (`attachment/queued_command`), text → tool → text, and a compaction summary.
 * Uses app.inject()-style route registration with a temporary HOME; no port.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerSessionRoutes } from '../src/web/routes/session-routes.js';
import { createMockRouteContext, type MockRouteContext } from './mocks/index.js';
import { CONTEXT_NOTICE } from '../src/canvas/conversation-schema.js';
import { extractReply } from '../src/canvas/thread-reply.js';

type Reader = Parameters<NonNullable<NonNullable<Parameters<typeof registerSessionRoutes>[2]>['transcriptReader']>>[0];
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const composed = (id: string, text: string) =>
  `<canvas-context workspace="w" seq="1" message="${id}">\n[n1 rev=1 type=text path=""] n1\n</canvas-context>\n${CONTEXT_NOTICE}\n${text}`;
const user = (text: string, extras: Record<string, unknown> = {}) => ({
  type: 'user',
  timestamp: '2026-11-12T10:00:00Z',
  message: { role: 'user', content: [{ type: 'text', text }] },
  ...extras,
});
const assistant = (text: string) => ({
  type: 'assistant',
  timestamp: '2026-11-12T10:00:10Z',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const toolUse = () => ({
  type: 'assistant',
  timestamp: '2026-11-12T10:00:11Z',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a' } }],
  },
});
const toolResult = () => ({
  type: 'user',
  timestamp: '2026-11-12T10:00:12Z',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file text' }] },
});
/** Shape of a real CLI row for a prompt typed while the agent works. */
const queued = (prompt: string) => ({
  type: 'attachment',
  timestamp: '2026-11-12T10:00:13Z',
  attachment: {
    type: 'queued_command',
    prompt,
    source_uuid: 'src-1',
    commandMode: 'prompt',
    origin: { kind: 'human' },
    timestamp: '2026-11-12T10:00:13Z',
  },
});
const taskNotification = () => ({
  type: 'attachment',
  timestamp: '2026-11-12T10:00:14Z',
  attachment: {
    type: 'queued_command',
    prompt: '<task-notification>done</task-notification>',
    commandMode: 'task-notification',
  },
});

describe('thread reply extraction over the real transcript reader', () => {
  let app: FastifyInstance, ctx: MockRouteContext, reader: Reader, home: string, previousHome: string | undefined;
  let file: string;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'canvas-reply-reader-'));
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
  const rows = async () => (await reader.rows(ctx._session.id))!;

  it('joins text → tool → text into one reply and ignores tool rows', async () => {
    write([
      user(composed(A, 'what is this?')),
      assistant('Looking.'),
      toolUse(),
      toolResult(),
      assistant('It is a note.'),
    ]);
    expect(extractReply(await rows(), A)).toEqual({
      found: true,
      closed: false,
      shared: false,
      text: 'Looking.\n\nIt is a note.',
    });
  });

  it('passes the queued mark through, and a queued prompt never closes the request before it', async () => {
    write([
      user(composed(A, 'first?')),
      assistant('Starting on the first.'),
      toolUse(),
      queued(composed(B, 'second?')),
      toolResult(),
      assistant('Both are answered here.'),
    ]);
    const read = await rows();
    expect(read.map((r) => [r.role, r.queued === true])).toEqual([
      ['user', false],
      ['assistant', false],
      ['user', true],
      ['assistant', false],
    ]);
    const whole = 'Starting on the first.\n\nBoth are answered here.';
    expect(extractReply(read, A)).toEqual({ found: true, closed: false, shared: true, text: whole });
    expect(extractReply(read, B)).toEqual({ found: true, closed: false, shared: true, text: whole });

    appendFileSync(file, JSON.stringify(user('typed in the terminal afterwards')) + '\n');
    appendFileSync(file, JSON.stringify(assistant('A later turn.')) + '\n');
    const later = await rows();
    expect(extractReply(later, A)).toEqual({ found: true, closed: true, shared: true, text: whole });
    expect(extractReply(later, B)).toEqual({ found: true, closed: true, shared: true, text: whole });
  });

  it("the CLI's own queue rows and a compaction summary neither close a request nor share its turn", async () => {
    write([
      user(composed(A, 'first?')),
      assistant('Part one.'),
      taskNotification(),
      user('This session is being continued from a previous conversation.', { isCompactSummary: true }),
      user('<system-reminder>noise</system-reminder>'),
      assistant('Part two.'),
    ]);
    expect(extractReply(await rows(), A)).toEqual({
      found: true,
      closed: false,
      shared: false,
      text: 'Part one.\n\nPart two.',
    });
  });

  it('a turn that resumed by itself after a background task keeps adding to the same reply', async () => {
    write([user(composed(A, 'run it?')), assistant('I will reply once it finishes.')]);
    const interim = extractReply(await rows(), A);
    expect(interim).toEqual({ found: true, closed: false, shared: false, text: 'I will reply once it finishes.' });
    appendFileSync(file, JSON.stringify(taskNotification()) + '\n');
    appendFileSync(file, JSON.stringify(assistant('It passed: 12 tests.')) + '\n');
    const resumed = extractReply(await rows(), A);
    expect(resumed).toEqual({
      found: true,
      closed: false,
      shared: false,
      text: 'I will reply once it finishes.\n\nIt passed: 12 tests.',
    });
    expect(resumed.text.startsWith(interim.text)).toBe(true);
  });

  it('a prompt typed during a turn but submitted after it answers from its own turn', async () => {
    write([
      user(composed(A, 'first?')),
      assistant('First answer.'),
      queued(composed(B, 'second?')),
      assistant('Still the first.'),
      user(composed(B, 'second?')),
      assistant('Second answer.'),
    ]);
    const read = await rows();
    expect(extractReply(read, A)).toEqual({
      found: true,
      closed: true,
      shared: false,
      text: 'First answer.\n\nStill the first.',
    });
    expect(extractReply(read, B)).toEqual({ found: true, closed: false, shared: false, text: 'Second answer.' });
  });

  it('a request that is not in the transcript is not found', async () => {
    write([user('typed in the terminal'), assistant('ok')]);
    expect(extractReply(await rows(), A)).toEqual({ found: false, closed: false, shared: false, text: '' });
  });

  it('the stamp changes when the file does and only then', async () => {
    write([user(composed(A, 'first?'))]);
    const first = await reader.stamp(ctx._session.id);
    expect(first).toEqual(expect.any(String));
    expect(await reader.stamp(ctx._session.id)).toBe(first);
    appendFileSync(file, JSON.stringify(assistant('more')) + '\n');
    expect(await reader.stamp(ctx._session.id)).not.toBe(first);
    expect(await reader.stamp('no-such-session')).toBeNull();
  });
});
