import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ChatGraphService, classifyMessage } from '../src/chat-graph/chat-service.js';
import { ChatGraphUnavailable, type SidecarAnswer } from '../src/chat-graph/supervisor.js';
import { registerChatGraphRoutes } from '../src/web/routes/chat-graph-routes.js';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** Answers the sidecar's routes from a script; anything unscripted is a 404. */
class FakeSidecar {
  calls: Call[] = [];
  down = false;
  candidates: { topicId: string; title: string }[] = [];
  topics: { id: string; title: string; status: string }[] = [];
  routeAnswer: (body: Record<string, unknown>, id: string) => SidecarAnswer = (body, id) => {
    if (body.unsorted) {
      return ok({
        op: { id },
        decision: { attach: [], newTopic: { id: 'unsorted', title: 'Unsorted' }, unsorted: true },
      });
    }
    if (body.signal) {
      return ok({ op: { id }, decision: { attach: [{ topicId: 'budget', confidence: null, band: 'explicit' }] } });
    }
    const scores = body.scores as { topicId: string; score: number }[];
    const best = scores.find((s) => s.score >= 0.5);
    return best
      ? ok({ op: { id }, decision: { attach: [{ topicId: best.topicId, confidence: best.score, band: 'quiet' }] } })
      : ok({ op: { id }, decision: { attach: [], newTopic: { id, title: body.title } } });
  };

  async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<SidecarAnswer> {
    if (this.down) throw new ChatGraphUnavailable('the Chat Graph sidecar is not running');
    this.calls.push({ method, path, body });
    if (method === 'POST' && path === '/messages') return ok(body);
    let m = /^\/messages\/([^/]+)\/candidates$/.exec(path);
    if (m) return ok({ candidates: this.candidates });
    m = /^\/messages\/([^/]+)\/route$/.exec(path);
    if (m) return this.routeAnswer(body as Record<string, unknown>, m[1]);
    if (path === '/topics') return ok(this.topics);
    m = /^\/topics\/([^/]+)$/.exec(path);
    if (m) {
      const t = this.topics.find((x) => x.id === m![1]);
      return t ? ok({ ...t, messageIds: [] }) : { status: 404, body: { error: `topic ${m[1]}`, code: 'not_found' } };
    }
    if (path === '/ops') return ok({ id: (body as { id: string }).id, kind: (body as { kind: string }).kind });
    if (path.startsWith('/corrections')) return ok({ corrections: [] });
    return { status: 404, body: { error: 'no route', code: 'not_found' } };
  }

  posted(path: string): unknown[] {
    return this.calls.filter((c) => c.method === 'POST' && c.path === path).map((c) => c.body);
  }

  routeBodies(): Record<string, unknown>[] {
    return this.calls.filter((c) => c.path.endsWith('/route')).map((c) => c.body as Record<string, unknown>);
  }
}

function ok(body: unknown): SidecarAnswer {
  return { status: 200, body };
}

let app: FastifyInstance;
let sidecar: FakeSidecar;
let runPrompt: ReturnType<typeof vi.fn<(prompt: string, id: string) => Promise<string>>>;
let broadcasts: { event: string; data: unknown }[];
let ids: number;

beforeEach(async () => {
  sidecar = new FakeSidecar();
  runPrompt = vi.fn<(prompt: string, id: string) => Promise<string>>();
  broadcasts = [];
  ids = 0;
  const service = new ChatGraphService({
    sidecar,
    runPrompt,
    now: () => 1_000,
    newId: () => `id-${++ids}`,
  });
  app = Fastify({ logger: false });
  registerChatGraphRoutes(app, { service, sidecar, broadcast: (event, data) => broadcasts.push({ event, data }) });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  delete process.env.CODEMAN_MULTIUSER;
});

function post(url: string, payload: unknown) {
  return app.inject({ method: 'POST', url, payload: payload as object });
}

describe('POST /api/chat-graph/messages', () => {
  it('stores the message, scores the candidates once and answers the chip', async () => {
    sidecar.candidates = [{ topicId: 'budget', title: 'Budget' }];
    runPrompt.mockResolvedValue(
      '{"resolved":"draft the march budget","scores":[{"topicId":"budget","score":0.93}],"title":"March budget"}'
    );
    const res = await post('/api/chat-graph/messages', { text: 'draft the march budget' });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data).toMatchObject({ messageId: 'id-1', kind: 'chat', routing: 'routed' });
    expect(data.chips).toEqual([{ topicId: 'budget', title: 'Budget', band: 'quiet', confidence: 0.93 }]);
    expect(sidecar.posted('/messages')).toEqual([
      { id: 'id-1', text: 'draft the march budget', ts: 1_000, author: 'person', kind: 'chat' },
    ]);
    expect(runPrompt).toHaveBeenCalledTimes(1);
    expect(sidecar.routeBodies()).toEqual([
      { resolvedText: 'draft the march budget', scores: [{ topicId: 'budget', score: 0.93 }], title: 'March budget' },
    ]);
    expect(broadcasts).toEqual([
      { event: 'chat-graph:routed', data: { messageId: 'id-1', kind: 'chat', routing: 'routed', chips: data.chips } },
    ]);
  });

  it('offers recently active live topics when retrieval finds none, and passes the recent messages', async () => {
    sidecar.topics = [
      { id: 'budget', title: 'Budget', status: 'live' },
      { id: 'old', title: 'Old', status: 'archived' },
    ];
    runPrompt.mockResolvedValueOnce('{"scores":[{"topicId":"budget","score":0.9}],"title":"Budget"}');
    await post('/api/chat-graph/messages', { text: 'draft the march budget' });
    runPrompt.mockResolvedValueOnce('{"scores":[{"topicId":"budget","score":0.96}],"title":"x"}');
    const res = await post('/api/chat-graph/messages', { text: 'ok do that' });
    const prompt = runPrompt.mock.calls[1][0];
    expect(prompt).toContain('topicId "budget", title "Budget"');
    expect(prompt).not.toContain('"old"');
    expect(prompt).toContain('"draft the march budget" filed to "Budget"');
    expect(res.json().data.chips[0]).toMatchObject({ topicId: 'budget', band: 'quiet' });
  });

  // Invariant I2: EveryMessageLandsVisibly
  it('files the message to Unsorted when the claude -p call fails, with a chip that says so', async () => {
    runPrompt.mockRejectedValue(new Error('Chat Graph routing timed out after 15000ms'));
    const res = await post('/api/chat-graph/messages', { text: 'something' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      routing: 'unsorted',
      chips: [{ topicId: 'unsorted', title: 'Unsorted', band: 'unsorted', confidence: null }],
    });
    expect(sidecar.routeBodies()).toEqual([{ unsorted: true }]);
    expect(broadcasts).toHaveLength(1);
  });

  // Invariant I2: EveryMessageLandsVisibly
  it('files the message to Unsorted when the answer cannot be parsed or the scored route is refused', async () => {
    runPrompt.mockResolvedValueOnce('I think it is about budgets.');
    expect((await post('/api/chat-graph/messages', { text: 'one' })).json().data.routing).toBe('unsorted');

    runPrompt.mockResolvedValueOnce('{"scores":[],"title":"Fine"}');
    const refuse = sidecar.routeAnswer;
    sidecar.routeAnswer = (body, id) =>
      body.unsorted ? refuse(body, id) : { status: 400, body: { error: 'bad', code: 'invalid' } };
    expect((await post('/api/chat-graph/messages', { text: 'two' })).json().data.routing).toBe('unsorted');
  });

  // Invariant I2: EveryMessageLandsVisibly
  it('answers 503 and stores nothing while the sidecar is down', async () => {
    sidecar.down = true;
    const res = await post('/api/chat-graph/messages', { text: 'budget' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ success: false, errorCode: 'CHAT_GRAPH_UNAVAILABLE' });
    expect(sidecar.calls).toEqual([]);
    expect(runPrompt).not.toHaveBeenCalled();
    expect(broadcasts).toEqual([]);
  });

  // Invariant I2: EveryMessageLandsVisibly
  it('leaves a stored message to the sidecar deadline when the sidecar goes away mid-turn', async () => {
    runPrompt.mockImplementation(async () => {
      sidecar.down = true;
      throw new Error('gone');
    });
    const res = await post('/api/chat-graph/messages', { text: 'budget' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ routing: 'pending', chips: [] });
    expect(broadcasts).toEqual([]);
  });

  // Invariant I10: CapturesGetNoReply
  it('stores a > message as a capture and answers only an acknowledgement', async () => {
    sidecar.candidates = [{ topicId: 'errands', title: 'Errands' }];
    runPrompt.mockResolvedValue('{"scores":[{"topicId":"errands","score":0.85}],"title":"Errands"}');
    const res = await post('/api/chat-graph/messages', { text: '> buy stamps' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ kind: 'capture', ack: 'Filed to Errands' });
    expect(sidecar.posted('/messages')).toEqual([
      { id: 'id-1', text: 'buy stamps', ts: 1_000, author: 'person', kind: 'capture' },
    ]);
    // The only things a capture touches are the sidecar and the routing call: the route module has no
    // session port, so nothing can be written to an agent session.
    const touched = sidecar.calls.map((c) => c.path);
    expect(touched.every((p) => p === '/messages' || p.startsWith('/messages/id-1/') || p === '/topics')).toBe(true);
    expect(JSON.stringify(broadcasts)).not.toContain('buy stamps');
  });

  it('passes an explicit signal straight to the sidecar with no model call', async () => {
    sidecar.topics = [{ id: 'budget', title: 'Budget', status: 'live' }];
    const res = await post('/api/chat-graph/messages', { text: 'yes', signal: { kind: 'reply', messageId: 'm-0' } });
    expect(res.json().data).toMatchObject({
      routing: 'explicit',
      chips: [{ topicId: 'budget', title: 'Budget', band: 'explicit' }],
    });
    expect(sidecar.routeBodies()).toEqual([{ signal: { kind: 'reply', messageId: 'm-0' } }]);
    expect(runPrompt).not.toHaveBeenCalled();
  });

  it('refuses an empty message, a bare >, an unknown field and multi-user mode', async () => {
    expect((await post('/api/chat-graph/messages', { text: '' })).statusCode).toBe(400);
    expect((await post('/api/chat-graph/messages', { text: '  >  ' })).statusCode).toBe(400);
    expect((await post('/api/chat-graph/messages', { text: 'x', extra: 1 })).statusCode).toBe(400);
    process.env.CODEMAN_MULTIUSER = '1';
    expect((await post('/api/chat-graph/messages', { text: 'x' })).statusCode).toBe(403);
    expect(sidecar.calls).toEqual([]);
  });
});

describe('reassign and reads', () => {
  it('turns a reassign into a move op, or an attach with add', async () => {
    let res = await post('/api/chat-graph/messages/m1/reassign', { from: 'a', to: 'b', opId: 'op-1' });
    expect(res.statusCode).toBe(200);
    res = await post('/api/chat-graph/messages/m1/reassign', { to: 'c', add: true });
    expect(res.statusCode).toBe(200);
    expect(sidecar.posted('/ops')).toEqual([
      { id: 'op-1', kind: 'move', messageId: 'm1', from: 'a', to: 'b' },
      { id: 'id-1', kind: 'attach', messageId: 'm1', topicId: 'c', source: 'chip' },
    ]);
    expect((await post('/api/chat-graph/messages/m1/reassign', { to: 'b' })).statusCode).toBe(400);
    expect((await post('/api/chat-graph/messages/m%2F1/reassign', { from: 'a', to: 'b' })).statusCode).toBe(400);
  });

  it('proxies topics and corrections, passing 404 through and 503 when down', async () => {
    sidecar.topics = [{ id: 'budget', title: 'Budget', status: 'live' }];
    expect((await app.inject({ method: 'GET', url: '/api/chat-graph/topics' })).json().data).toEqual(sidecar.topics);
    expect((await app.inject({ method: 'GET', url: '/api/chat-graph/topics/nope' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/chat-graph/corrections?limit=5' })).json().data).toEqual({
      corrections: [],
    });
    expect(sidecar.calls.at(-1)?.path).toBe('/corrections?limit=5');
    sidecar.down = true;
    const res = await app.inject({ method: 'GET', url: '/api/chat-graph/topics' });
    expect(res.statusCode).toBe(503);
  });
});

describe('classifyMessage', () => {
  it('reads a leading > as a capture', () => {
    expect(classifyMessage('  > buy stamps ')).toEqual({ kind: 'capture', text: 'buy stamps' });
    expect(classifyMessage('a > b')).toEqual({ kind: 'chat', text: 'a > b' });
    expect(classifyMessage('>')).toBeNull();
  });
});
