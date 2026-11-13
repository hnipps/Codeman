/**
 * The conversation activity read (route and `canvas_conversation activity`) over a fake port, and the browser's pure
 * placement of tool rows, release outcomes and Sources used among a thread's turns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  conversationTool,
  MAX_TOOL_ACTIVITY_BYTES,
  registerConversationRoutes,
  releaseReads,
} from '../src/web/routes/canvas-conversation-routes.js';
import { addConversation } from '../src/canvas/conversations.js';
import { ConversationToolSchema } from '../src/canvas/conversation-schema.js';
import { ToolLedger, type ToolRow } from '../src/canvas/transcript-activity.js';
import type { ReleaseRecord } from '../src/canvas/release.js';
import type { CanvasPort } from '../src/web/ports/canvas-port.js';
import { dataPath } from '../src/config/instance.js';
import {
  MAX_GROUP_ROWS,
  NO_ACTIVITY,
  parseActivity,
  sourceLine,
  toolResult,
  toolState,
  weave,
  type Activity,
} from '../packages/canvas/src/activity.js';
import type { Turn } from '../packages/canvas/src/conversation.js';

const WORKSPACE = 'w1';
const SHA = '0123456789abcdef0123456789abcdef01234567';
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-activity-'));
  vi.stubEnv('CODEMAN_DATA_DIR', dir);
  Object.assign(releaseReads, { at: 0, records: null });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function ledgerRows(): { tools: ToolRow[]; dropped: number } {
  const ledger = new ToolLedger();
  ledger.uses([{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'notes.md' } }], undefined, 1);
  ledger.results([{ type: 'tool_result', tool_use_id: 't1', content: 'alpha' }]);
  ledger.uses(
    [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: `codeman-deploy ${SHA}` } }],
    '2026-11-13T10:00:00.000Z',
    2
  );
  ledger.results([{ type: 'tool_result', tool_use_id: 't2', content: 'deploy d-1; log /x\noutcome: success\n' }]);
  return { tools: ledger.rows(), dropped: 0 };
}
const record: ReleaseRecord = {
  id: 'd-1',
  action: 'deploy',
  sha: SHA,
  outcome: 'failed',
  failedStep: 'health',
  startedAt: '2026-11-13T10:00:02.000Z',
  finishedAt: '2026-11-13T10:03:00.000Z',
};

async function harness(user = { username: 'admin', role: 'admin' }) {
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    (req as unknown as { authUser: unknown }).authUser = user;
  });
  const sessions = new Map<string, Record<string, unknown>>([['s1', { id: 's1', owner: 'admin' }]]);
  const port = {
    sessions,
    canvasEnabled: async () => true,
    broadcast: vi.fn(),
    transcriptStamp: vi.fn(async () => 'stamp-1' as string | null),
    transcriptActivity: vi.fn(async () => ledgerRows() as { tools: ToolRow[]; dropped: number } | null),
    releaseRecords: vi.fn(async () => [record] as ReleaseRecord[] | null),
  };
  registerConversationRoutes(app, port as unknown as CanvasPort);
  await app.ready();
  const id = crypto.randomUUID();
  const made = addConversation(
    WORKSPACE,
    () => ({ id, sessionId: 's1', cliId: 'claude', createdAt: 1, createdBy: 'admin' }),
    crypto.randomUUID()
  );
  expect(made.ok).toBe(true);
  const read = async (conversation = id) =>
    app.inject({ method: 'GET', url: `/api/canvas/${WORKSPACE}/conversations/${conversation}/activity` });
  return { app, port, sessions, id, read };
}

describe('GET conversations/:id/activity', () => {
  it('answers the tool rows without the raw release fields, and the release joined with the supervisor record', async () => {
    const h = await harness();
    const res = await h.read();
    expect(res.statusCode).toBe(200);
    const { activity } = res.json().data;
    expect(activity.supported).toBe(true);
    expect(activity.tools.map((t: ToolRow) => [t.id, t.name, t.after, t.status])).toEqual([
      ['t1', 'Read', 1, 'ok'],
      ['t2', 'Bash', 2, 'ok'],
    ]);
    expect(activity.tools[1]).not.toHaveProperty('release');
    expect(activity.releases).toEqual([
      {
        toolId: 't2',
        action: 'deploy',
        sha: '0123456',
        state: 'failed',
        failedStep: 'health',
        source: 'supervisor',
        finishedAt: '2026-11-13T10:03:00.000Z',
      },
    ]);
    await h.app.close();
  });

  it('writes nothing: conversations.json is byte for byte what it was', async () => {
    const h = await harness();
    const file = dataPath(join('canvas', WORKSPACE, 'conversations.json'));
    const before = readFileSync(file);
    await h.read();
    await h.read();
    expect(readFileSync(file).equals(before)).toBe(true);
    await h.app.close();
  });

  it('parses an unchanged transcript once, and reads the supervisor at most once per interval', async () => {
    const h = await harness();
    await h.read();
    await h.read();
    expect(h.port.transcriptActivity).toHaveBeenCalledTimes(1);
    expect(h.port.releaseRecords).toHaveBeenCalledTimes(1);
    h.port.transcriptStamp.mockResolvedValue('stamp-2');
    releaseReads.at = 0;
    await h.read();
    expect(h.port.transcriptActivity).toHaveBeenCalledTimes(2);
    expect(h.port.releaseRecords).toHaveBeenCalledTimes(2);
    await h.app.close();
  });

  it('never reads the supervisor for a conversation that asked for no release', async () => {
    const h = await harness();
    h.port.transcriptActivity.mockResolvedValue({ tools: ledgerRows().tools.slice(0, 1), dropped: 0 });
    expect((await h.read()).json().data.activity.releases).toEqual([]);
    expect(h.port.releaseRecords).not.toHaveBeenCalled();
    await h.app.close();
  });

  it('a supervisor that fails or is absent leaves the outcome the command printed, marked as such', async () => {
    const h = await harness();
    h.port.releaseRecords.mockRejectedValue(new Error('down'));
    expect((await h.read()).json().data.activity.releases[0]).toMatchObject({ state: 'succeeded', source: 'printed' });
    await h.app.close();
  });

  it('answers unsupported and empty for a transcript with no tool reader, a session not held, and another owner', async () => {
    const h = await harness();
    h.port.transcriptActivity.mockResolvedValue(null);
    expect((await h.read()).json().data.activity).toEqual(NO_ACTIVITY);
    h.sessions.clear();
    expect((await h.read()).json().data.activity).toEqual(NO_ACTIVITY);
    await h.app.close();
    vi.stubEnv('CODEMAN_MULTIUSER', '1');
    const other = await harness({ username: 'bea', role: 'user' });
    expect((await other.read()).json().data.activity).toEqual(NO_ACTIVITY);
    expect(other.port.transcriptActivity).not.toHaveBeenCalled();
    await other.app.close();
  });

  it('is 404 for a conversation this workspace does not have', async () => {
    const h = await harness();
    expect((await h.read(crypto.randomUUID())).statusCode).toBe(404);
    await h.app.close();
  });

  it('gives an agent the same answer inside canvas_conversation read, while the HTTP read stays as it was', async () => {
    const h = await harness();
    const input = ConversationToolSchema.parse({ action: 'read', conversationId: h.id });
    const req = { authUser: { username: 'admin', role: 'admin' }, headers: {} } as never;
    const outcome = await conversationTool(h.port as unknown as CanvasPort, req, WORKSPACE, input as never);
    expect(outcome.code).toBe(200);
    const data = (outcome.body as { data: { conversation: { id: string }; activity: unknown } }).data;
    expect(data.conversation.id).toBe(h.id);
    expect(data.activity).toEqual((await h.read()).json().data.activity);
    const http = await h.app.inject({ method: 'GET', url: `/api/canvas/${WORKSPACE}/conversations/${h.id}` });
    expect(http.json().data).not.toHaveProperty('activity');
    await h.app.close();
  });

  it('cuts the agent answer to the newest calls that fit one tool result, and counts the rest', async () => {
    const h = await harness();
    const ledger = new ToolLedger();
    for (let i = 0; i < 120; i += 1) {
      ledger.uses([{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: `echo ${i}` } }], undefined, 1);
      ledger.results([{ type: 'tool_result', tool_use_id: `t${i}`, content: 'x'.repeat(5000) }]);
    }
    h.port.transcriptActivity.mockResolvedValue({ tools: ledger.rows(), dropped: 2 });
    const input = ConversationToolSchema.parse({ action: 'read', conversationId: h.id });
    const req = { authUser: { username: 'admin', role: 'admin' }, headers: {} } as never;
    const outcome = await conversationTool(h.port as unknown as CanvasPort, req, WORKSPACE, input as never);
    const { activity } = (outcome.body as { data: { activity: { tools: ToolRow[]; dropped: number } } }).data;
    expect(Buffer.byteLength(JSON.stringify(activity))).toBeLessThanOrEqual(MAX_TOOL_ACTIVITY_BYTES + 200);
    expect(activity.tools.length).toBeGreaterThan(5);
    expect(activity.tools.at(-1)?.id).toBe('t119');
    expect(activity.tools.length + activity.dropped).toBe(122);
    expect((await h.read()).json().data.activity.tools).toHaveLength(120);
    await h.app.close();
  });
});

const turn = (key: string, who: Turn['who'], refs: string[] = []): Turn => ({ key, who, label: who, text: key, refs });
const tool = (id: string, after: number, over: Partial<ToolRow> = {}): Activity['tools'][number] => ({
  id,
  name: 'Read',
  input: id,
  status: 'ok',
  head: '',
  tail: '',
  cut: 0,
  at: null,
  after,
  ...over,
});

describe('placing activity in the thread', () => {
  it('puts tool calls before the row they precede, a release after its call, and one sources item at each turn end', () => {
    const turns = [
      turn('r0', 'you', ['Note A']),
      turn('r1', 'claude'),
      turn('r2', 'claude'),
      turn('r3', 'you'),
      turn('r4', 'claude'),
    ];
    const activity: Activity = {
      supported: true,
      dropped: 0,
      tools: [
        tool('t1', 1, { reads: { kind: 'file', label: 'notes.md' } }),
        tool('t2', 2, { reads: { kind: 'file', label: 'notes.md' } }),
        tool('t3', 2, { name: 'Bash' }),
        tool('t4', 5, { reads: { kind: 'canvas', label: 'canvas_read' } }),
      ],
      releases: [
        {
          toolId: 't3',
          action: 'deploy',
          sha: null,
          state: 'running',
          failedStep: null,
          source: 'none',
          finishedAt: null,
        },
      ],
    };
    const items = weave(turns, 5, activity);
    expect(
      items.map((i) =>
        i.kind === 'turn' ? i.turn.key : i.kind === 'tools' ? `tools(${i.rows.map((r) => r.id)})` : i.key
      )
    ).toEqual([
      'r0',
      'tools(t1)',
      'r1',
      'tools(t2,t3)',
      'release:t3',
      'r2',
      'src:r0',
      'r3',
      'r4',
      'tools(t4)',
      'src:r3',
    ]);
    const [first, second] = items.filter((i) => i.kind === 'sources');
    expect(first).toMatchObject({ sent: ['Note A'], read: [{ kind: 'file', label: 'notes.md' }] });
    expect(second).toMatchObject({ sent: [], read: [{ kind: 'canvas', label: 'canvas_read' }] });
  });

  it('shows no sources item for a turn that sent and read nothing, and keeps unsent messages after everything', () => {
    const turns = [turn('r0', 'you'), turn('r1', 'claude'), turn('s-pending', 'you', ['Note B'])];
    const items = weave(turns, 2, { supported: true, dropped: 0, tools: [tool('t1', 2)], releases: [] });
    expect(items.map((i) => i.kind)).toEqual(['turn', 'turn', 'tools', 'turn']);
  });

  it('shows the newest calls of a long run and counts the rest with those the server dropped', () => {
    const tools = Array.from({ length: MAX_GROUP_ROWS + 3 }, (_, i) => tool(`t${i}`, 1));
    const [, group] = weave([turn('r0', 'you'), turn('r1', 'claude')], 2, {
      supported: true,
      dropped: 4,
      tools,
      releases: [],
    });
    expect(group).toMatchObject({ kind: 'tools', hidden: 7 });
    expect(group.kind === 'tools' && group.rows.at(-1)?.id).toBe(`t${MAX_GROUP_ROWS + 2}`);
  });

  it('with no activity the thread is exactly its turns', () => {
    const turns = [turn('r0', 'you'), turn('r1', 'claude')];
    expect(weave(turns, 2, NO_ACTIVITY)).toEqual(turns.map((t) => ({ kind: 'turn', turn: t })));
  });

  it('reads the server answer leniently and words a row', () => {
    expect(parseActivity(null)).toEqual(NO_ACTIVITY);
    expect(parseActivity({ supported: false, tools: [tool('t', 0)] })).toEqual(NO_ACTIVITY);
    const parsed = parseActivity({
      supported: true,
      dropped: 'x',
      tools: [tool('ok', 0), { id: 3 }, { ...tool('odd', 1), status: 'weird', reads: { kind: 'shell', label: 'x' } }],
      releases: [
        { toolId: 'ok', state: 'nonsense' },
        { toolId: 'ok', state: 'succeeded', source: 'x', action: 'x' },
      ],
    });
    expect(parsed.tools.map((t) => [t.id, t.status, t.reads])).toEqual([
      ['ok', 'ok', undefined],
      ['odd', 'pending', undefined],
    ]);
    expect(parsed.releases).toEqual([
      {
        toolId: 'ok',
        action: 'deploy',
        sha: null,
        state: 'succeeded',
        failedStep: null,
        source: 'none',
        finishedAt: null,
      },
    ]);
    expect(parsed.dropped).toBe(0);
    expect(toolState(tool('a', 0, { status: 'pending' }), true)).toBe('Running');
    expect(toolState(tool('a', 0, { status: 'pending' }), false)).toBe('No result');
    expect(toolState(tool('a', 0, { status: 'error' }), false)).toBe('Failed');
    expect(toolState(tool('a', 0), true)).toBe('');
    expect(toolResult(tool('a', 0))).toBe('No output.');
    expect(toolResult(tool('a', 0, { head: 'H', tail: 'T', cut: 1200 }))).toBe('H\n… 1,200 characters not shown …\nT');
    expect(sourceLine({ kind: 'web', label: 'https://example.test' })).toBe('Web · https://example.test');
  });
});
