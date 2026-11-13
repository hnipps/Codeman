import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCanvasRoutes } from '../src/web/routes/canvas-routes.js';
import {
  conversationTurnEnded,
  forgetReplyPasses,
  replyRouting,
  settleDeliveries,
  settleReplies,
} from '../src/web/routes/canvas-conversation-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { CanvasStores } from '../src/canvas/canvas-store.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { readConversations, setMessageReply } from '../src/canvas/conversations.js';
import { CONTEXT_NOTICE } from '../src/canvas/conversation-schema.js';
import {
  MAX_COMMENT_CHARS,
  MAX_REPLY_PARTS,
  REPLY_CUT_NOTE,
  REPLY_MORE_NOTE,
  REPLY_SHARED_NOTE,
  replyCommentId,
  replyPartId,
} from '../src/canvas/thread-reply.js';
import { deployRole } from '../src/deploy-role.js';
import { create, human } from './canvas-fixtures.js';

let dir: string;
const DAY = 24 * 60 * 60 * 1000;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-thread-'));
  vi.stubEnv('CODEMAN_DATA_DIR', dir);
  Object.assign(replyRouting, { settleDelayMs: 2, retryDelaysMs: [], maxAgeMs: DAY });
  forgetReplyPasses();
});
afterEach(() => {
  deployRole.enter('live');
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
const uuid = () => crypto.randomUUID();
type Row = { role: string; text: string; queued?: boolean };
const prompt = (id: string, text: string): Row => ({
  role: 'user',
  text: `<canvas-context workspace="w" seq="1" message="${id}">\n[note1 rev=1 type=text path=""] note1\n</canvas-context>\n${CONTEXT_NOTICE}\n${text}`,
});
const said = (text: string): Row => ({ role: 'assistant', text });

async function harness() {
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    req.authUser = { username: 'admin', role: 'admin' };
  });
  const sessions = new Map<string, Record<string, unknown>>();
  const transcripts = new Map<string, Row[]>();
  /** When this process saw each session's turn end; empty is a process that has seen none, as after a restart. */
  const stops = new Map<string, number>();
  const stamps = new Map<string, string>();
  const stores = new CanvasStores();
  const port = {
    sessions,
    canvasEnabled: async () => true,
    canvasStores: async () => stores,
    broadcast: vi.fn(),
    transcriptRows: vi.fn(async (sessionId: string) => transcripts.get(sessionId) ?? null),
    transcriptStamp: vi.fn(async (sessionId: string) => stamps.get(sessionId) ?? null),
    turnEndObservedAt: (sessionId: string) => stops.get(sessionId) ?? 0,
    startConversationSession: vi.fn(async (_headers: unknown, request: { workingDir: string }) => {
      const id = `session-${sessions.size + 1}`;
      sessions.set(id, { id, workingDir: request.workingDir, writeViaMux: vi.fn(async () => true) });
      return { ok: true as const, sessionId: id };
    }),
  };
  registerCanvasRoutes(app, port as never);
  installRouteErrorHandler(app);
  await app.ready();
  const workspace = workspaceForCase('thread-case');
  const base = `/api/canvas/${workspace.id}`;
  const store = stores.get(workspace.id);
  store.append([create('note1'), create('note2')], human);
  const comment = async (objectId: string, text: string, commentId = uuid()) => {
    const response = await app.inject({
      method: 'POST',
      url: `${base}/command`,
      payload: { tool: 'canvas_comment', requestId: uuid(), arguments: { objectId, text, commentId } },
    });
    expect(response.statusCode).toBe(200);
    return commentId;
  };
  const start = async (payload: Record<string, unknown> = {}) =>
    (
      await app.inject({ method: 'POST', url: `${base}/conversations`, payload: { requestId: uuid(), ...payload } })
    ).json().data.conversation as { id: string; sessionId: string; origin?: unknown };
  const send = async (conversationId: string, payload: Record<string, unknown>) => {
    const response = await app.inject({
      method: 'POST',
      url: `${base}/conversations/${conversationId}/messages`,
      payload,
    });
    await settleDeliveries();
    return response;
  };
  /** Posts the comment and asks the conversation about it, as Ask agent does. */
  const ask = async (conversationId: string, objectId: string, text: string) => {
    const commentId = await comment(objectId, text);
    const messageId = uuid();
    const origin = { kind: 'thread', objectId, commentId };
    const response = await send(conversationId, { messageId, text, refIds: [objectId], origin });
    expect(response.statusCode).toBe(200);
    return { commentId, messageId, origin };
  };
  const stop = async (sessionId: string) => {
    await pause(2);
    stops.set(sessionId, Date.now());
    await conversationTurnEnded(port as never, sessionId);
    await settleReplies();
  };
  const list = async () => {
    const response = await app.inject({ method: 'GET', url: `${base}/conversations` });
    await settleReplies();
    return response.json().data.conversations as {
      id: string;
      origin?: unknown;
      requests?: { messageId: string; commentId: string; objectId: string; state: string; reply?: unknown }[];
    }[];
  };
  const read = async (conversationId: string) => {
    const response = await app.inject({ method: 'GET', url: `${base}/conversations/${conversationId}` });
    await settleReplies();
    return response.json().data.conversation;
  };
  const message = (messageId: string) => {
    const file = readConversations(workspace.id);
    if (!file.ok) throw new Error('unreadable');
    return file.conversations.flatMap((c) => c.messages).find((m) => m.messageId === messageId);
  };
  const thread = (objectId: string) => store.read().comments.filter((c) => c.objectId === objectId);
  return {
    app,
    port,
    sessions,
    transcripts,
    stops,
    stamps,
    workspace,
    base,
    store,
    comment,
    start,
    send,
    ask,
    stop,
    list,
    read,
    message,
    thread,
  };
}

describe('canvas thread requests', () => {
  it('an ordinary comment starts no agent work and records no request', async () => {
    const h = await harness();
    try {
      const conversation = await h.start();
      await h.comment('note1', '@agent please look at this');
      await h.stop(conversation.sessionId);
      expect(h.sessions.get(conversation.sessionId)!.writeViaMux).not.toHaveBeenCalled();
      expect(h.port.transcriptRows).not.toHaveBeenCalled();
      expect((await h.list())[0].requests).toBeUndefined();
      expect(h.thread('note1')).toHaveLength(1);
    } finally {
      await h.app.close();
    }
  });

  it('records the origin on the message, sends through the ordinary path and lists the request', async () => {
    const h = await harness();
    try {
      const conversation = await h.start();
      const asked = await h.ask(conversation.id, 'note1', 'what is this note for?');
      const write = h.sessions.get(conversation.sessionId)!.writeViaMux as ReturnType<typeof vi.fn>;
      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0][0]).toContain('[note1 ');
      expect(write.mock.calls[0][0].endsWith('what is this note for?\r')).toBe(true);
      expect(h.message(asked.messageId)).toMatchObject({ origin: asked.origin, state: 'delivered' });
      expect((await h.list())[0].requests).toEqual([
        { messageId: asked.messageId, objectId: 'note1', commentId: asked.commentId, state: 'delivered' },
      ]);
      const again = await h.send(conversation.id, {
        messageId: asked.messageId,
        text: 'what is this note for?',
        refIds: ['note1'],
        origin: asked.origin,
      });
      expect(again.json().data.duplicate).toBe(true);
      expect(write).toHaveBeenCalledTimes(1);
      expect(h.thread('note1')).toHaveLength(1);
    } finally {
      await h.app.close();
    }
  });

  it('refuses an origin whose comment or object is not on the canvas, and writes nothing', async () => {
    const h = await harness();
    try {
      const conversation = await h.start();
      const commentId = await h.comment('note1', 'q');
      const send = (origin: Record<string, unknown>) =>
        h.send(conversation.id, { messageId: uuid(), text: 'q', refIds: ['note1'], origin });
      for (const origin of [
        { kind: 'thread', objectId: 'note1', commentId: 'never-posted' },
        { kind: 'thread', objectId: 'note2', commentId },
        { kind: 'thread', objectId: 'missing', commentId },
      ]) {
        const response = await send(origin);
        expect(response.statusCode).toBe(409);
        expect(response.json().error).toMatch(/^ORIGIN_GONE/);
      }
      expect((await send({ kind: 'thread', objectId: 'note1', commentId, extra: 1 })).statusCode).toBe(400);
      expect(h.sessions.get(conversation.sessionId)!.writeViaMux).not.toHaveBeenCalled();
      const file = readConversations(h.workspace.id);
      expect(file.ok && file.conversations[0].messages).toEqual([]);
    } finally {
      await h.app.close();
    }
  });

  it('sets the conversation origin when a conversation is created from a thread', async () => {
    const h = await harness();
    try {
      const commentId = await h.comment('note1', 'q');
      const origin = { kind: 'thread', objectId: 'note1', commentId };
      const conversation = await h.start({ origin });
      expect(conversation.origin).toEqual(origin);
      const file = readConversations(h.workspace.id);
      expect(file.ok && file.conversations[0].origin).toEqual(origin);
      expect((await h.start()).origin).toBeUndefined();
    } finally {
      await h.app.close();
    }
  });

  it('posts the reply into the asking thread as the agent session when the turn ends, once', async () => {
    const h = await harness();
    try {
      const conversation = await h.start();
      const asked = await h.ask(conversation.id, 'note1', 'what is this?');
      h.transcripts.set(conversation.sessionId, [
        prompt(asked.messageId, 'what is this?'),
        said('It is a note.'),
        said('It holds one line.'),
      ]);
      h.port.broadcast.mockClear();
      await h.stop(conversation.sessionId);
      const replies = h.thread('note1').filter((c) => c.author.kind === 'agent');
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({
        id: replyCommentId(asked.messageId),
        author: { kind: 'agent', sessionId: conversation.sessionId },
        text: 'It is a note.\n\nIt holds one line.',
      });
      expect(h.message(asked.messageId)?.reply).toEqual({
        commentId: replyCommentId(asked.messageId),
        postedAt: expect.any(Number),
        parts: 1,
        chars: 'It is a note.\n\nIt holds one line.'.length,
        hash: expect.any(String),
      });
      expect(h.port.broadcast.mock.calls.map((c) => c[0])).toEqual(['canvas:changed', 'canvas:conversation']);
      const operation = h.store.operations().at(-1)!;
      expect(operation).toMatchObject({
        kind: 'comment',
        author: { kind: 'agent', sessionId: conversation.sessionId },
      });

      h.port.broadcast.mockClear();
      await h.stop(conversation.sessionId);
      await h.stop(conversation.sessionId);
      await h.read(conversation.id);
      expect(h.thread('note1')).toHaveLength(2);
      expect(h.port.broadcast).not.toHaveBeenCalled();
      expect((await h.list())[0].requests?.[0].reply).toMatchObject({ commentId: replyCommentId(asked.messageId) });
      expect(h.thread('note2')).toHaveLength(0);
    } finally {
      await h.app.close();
    }
  });

  it('routes by the recorded origin: two requests in one conversation reach their own threads', async () => {
    const h = await harness();
    try {
      const conversation = await h.start();
      const first = await h.ask(conversation.id, 'note1', 'first?');
      const second = await h.ask(conversation.id, 'note2', 'second?');
      h.transcripts.set(conversation.sessionId, [
        prompt(first.messageId, 'first?'),
        said('answer one'),
        prompt(second.messageId, 'second?'),
        said('answer two'),
      ]);
      await h.stop(conversation.sessionId);
      expect(h.thread('note1').map((c) => c.text)).toEqual(['first?', 'answer one']);
      expect(h.thread('note2').map((c) => c.text)).toEqual(['second?', 'answer two']);
    } finally {
      await h.app.close();
    }
  });

  it('finds a comment already posted under the request id and records it without posting again', async () => {
    const h = await harness();
    try {
      const conversation = await h.start();
      const asked = await h.ask(conversation.id, 'note1', 'q?');
      h.store.append(
        [
          {
            kind: 'comment',
            opId: 'earlier-reply',
            objectId: 'note1',
            patch: { id: replyCommentId(asked.messageId), text: 'posted before the record was saved' },
          },
        ],
        { kind: 'agent', sessionId: conversation.sessionId }
      );
      h.transcripts.set(conversation.sessionId, [prompt(asked.messageId, 'q?'), said('a different text')]);
      await h.stop(conversation.sessionId);
      expect(h.thread('note1').map((c) => c.text)).toEqual(['q?', 'posted before the record was saved']);
      expect(h.message(asked.messageId)?.reply).toMatchObject({ commentId: replyCommentId(asked.messageId) });
    } finally {
      await h.app.close();
    }
  });

  it('settles an open request only on a stop this process saw, and never while the session is working', async () => {
    const h = await harness();
    try {
      const conversation = await h.start();
      const asked = await h.ask(conversation.id, 'note1', 'q?');
      h.transcripts.set(conversation.sessionId, [prompt(asked.messageId, 'q?'), said('partial')]);
      const session = h.sessions.get(conversation.sessionId)!;
      // No stop was seen: an idle-looking session is not evidence, which is the state after a restart.
      await h.read(conversation.id);
      await h.list();
      expect(h.thread('note1')).toHaveLength(1);

      session.isWorking = true;
      await h.stop(conversation.sessionId);
      session.isWorking = false;
      session.hookTurnRunning = true;
      await h.list();
      expect(h.thread('note1')).toHaveLength(1);
      expect(h.message(asked.messageId)?.reply).toBeUndefined();

      session.hookTurnRunning = false;
      h.transcripts.set(conversation.sessionId, [prompt(asked.messageId, 'q?'), said('the whole answer')]);
      await h.read(conversation.id);
      expect(h.thread('note1').map((c) => c.text)).toEqual(['q?', 'the whole answer']);
    } finally {
      await h.app.close();
    }
  });

  it('after a restart nothing is posted for an open request; a later prompt that closes it settles it', async () => {
    const h = await harness();
    try {
      const conversation = await h.start();
      const asked = await h.ask(conversation.id, 'note1', 'q?');
      await h.stop(conversation.sessionId);
      h.transcripts.set(conversation.sessionId, [prompt(asked.messageId, 'q?'), said('written before the restart')]);
      // A fresh process: no stop observed, no remembered pass, flags at their defaults.
      h.stops.clear();
      forgetReplyPasses();
      await h.read(conversation.id);
      await h.list();
      expect(h.thread('note1')).toHaveLength(1);
      expect(h.message(asked.messageId)?.reply).toBeUndefined();
      expect((await h.list())[0].requests?.[0]).toEqual({
        messageId: asked.messageId,
        objectId: 'note1',
        commentId: asked.commentId,
        state: 'delivered',
      });

      h.transcripts.set(conversation.sessionId, [
        prompt(asked.messageId, 'q?'),
        said('written before the restart'),
        { role: 'user', text: 'typed in the terminal' },
        said('still going'),
      ]);
      h.sessions.get(conversation.sessionId)!.isWorking = true;
      await h.list();
      expect(h.thread('note1').map((c) => c.text)).toEqual(['q?', 'written before the restart']);
    } finally {
      await h.app.close();
    }
  });

  it('a stop that finds the session still working tries again and posts once it has stopped', async () => {
    const h = await harness();
    try {
      const conversation = await h.start();
      const asked = await h.ask(conversation.id, 'note1', 'q?');
      h.transcripts.set(conversation.sessionId, [prompt(asked.messageId, 'q?'), said('answer')]);
      const session = h.sessions.get(conversation.sessionId)!;
      session.isWorking = true;
      await h.stop(conversation.sessionId);
      expect(h.thread('note1')).toHaveLength(1);

      replyRouting.retryDelaysMs = [20, 20];
      setTimeout(() => (session.isWorking = false), 30);
      await h.stop(conversation.sessionId);
      expect(h.thread('note1').map((c) => c.text)).toEqual(['q?', 'answer']);
    } finally {
      await h.app.close();
    }
  });

  it('posts only a reply two reads agree on', async () => {
    const h = await harness();
    try {
      const conversation = await h.start();
      const asked = await h.ask(conversation.id, 'note1', 'q?');
      const first = [prompt(asked.messageId, 'q?'), said('part one')];
      const whole = [...first, said('part two')];
      h.port.transcriptRows.mockResolvedValueOnce(first).mockResolvedValue(whole);
      await h.stop(conversation.sessionId);
      expect(h.thread('note1')).toHaveLength(1);
      expect(h.message(asked.messageId)?.reply).toBeUndefined();
      await h.stop(conversation.sessionId);
      expect(h.thread('note1').map((c) => c.text)).toEqual(['q?', 'part one\n\npart two']);
    } finally {
      await h.app.close();
    }
  });

  it('text, a tool call, then text: rows that land between the two reads are posted whole, with no second stop and no read by a client', async () => {
    const h = await harness();
    try {
      Object.assign(replyRouting, { retryDelaysMs: [5, 5] });
      const conversation = await h.start();
      const asked = await h.ask(conversation.id, 'note1', 'q?');
      const atStop = [prompt(asked.messageId, 'q?'), said('Let me look.')];
      const flushed = [...atStop, { role: 'tool', text: 'Read file' }, said('Here is the answer.')];
      h.port.transcriptRows.mockResolvedValueOnce(atStop).mockResolvedValue(flushed);
      await h.stop(conversation.sessionId);
      expect(h.thread('note1').map((c) => c.text)).toEqual(['q?', 'Let me look.\n\nHere is the answer.']);
      expect(h.message(asked.messageId)?.reply).toMatchObject({ parts: 1 });
    } finally {
      await h.app.close();
    }
  });

  it('a row that reaches the file after the reply was posted is added as a further part, once', async () => {
    const h = await harness();
    try {
      Object.assign(replyRouting, { retryDelaysMs: [5, 5] });
      const conversation = await h.start();
      const asked = await h.ask(conversation.id, 'note1', 'q?');
      const early = [prompt(asked.messageId, 'q?'), said('Let me look.')];
      const late = [...early, said('Here is the answer.')];
      // Both reads of the first pass agree on the early text; the last row is in the file only for the try after it.
      h.port.transcriptRows.mockResolvedValueOnce(early).mockResolvedValueOnce(early).mockResolvedValue(late);
      await h.stop(conversation.sessionId);
      const replies = () => h.thread('note1').filter((c) => c.author.kind === 'agent');
      expect(replies().map((c) => [c.id, c.text])).toEqual([
        [replyPartId(asked.messageId, 1), 'Let me look.'],
        [replyPartId(asked.messageId, 2), 'Here is the answer.'],
      ]);
      expect(h.message(asked.messageId)?.reply).toMatchObject({
        commentId: replyCommentId(asked.messageId),
        parts: 2,
        chars: 'Let me look.\n\nHere is the answer.'.length,
      });
      await h.stop(conversation.sessionId);
      await h.list();
      expect(replies()).toHaveLength(2);
    } finally {
      await h.app.close();
    }
  });

  it('a turn that resumed by itself adds its text as one further part; repeated stops and a revert post nothing more', async () => {
    const h = await harness();
    try {
      const conversation = await h.start();
      const asked = await h.ask(conversation.id, 'note1', 'run it?');
      const interim = [prompt(asked.messageId, 'run it?'), said('I will reply once it finishes.')];
      h.transcripts.set(conversation.sessionId, interim);
      await h.stop(conversation.sessionId);
      const replies = () => h.thread('note1').filter((c) => c.author.kind === 'agent');
      expect(replies().map((c) => c.text)).toEqual(['I will reply once it finishes.']);

      // The background task finished and the agent went on with no new prompt row (the reader gives no row for the task notice).
      const resumed = [...interim, said('It passed: 12 tests.')];
      h.transcripts.set(conversation.sessionId, resumed);
      h.sessions.get(conversation.sessionId)!.isWorking = true;
      await h.list();
      expect(replies()).toHaveLength(1);
      h.sessions.get(conversation.sessionId)!.isWorking = false;
      await h.stop(conversation.sessionId);
      expect(replies().map((c) => [c.id, c.text])).toEqual([
        [replyPartId(asked.messageId, 1), 'I will reply once it finishes.'],
        [replyPartId(asked.messageId, 2), 'It passed: 12 tests.'],
      ]);
      expect(replies().every((c) => c.author.kind === 'agent' && c.author.sessionId === conversation.sessionId)).toBe(
        true
      );
      const operations = h.store.operations().length;
      await h.stop(conversation.sessionId);
      await h.stop(conversation.sessionId);
      await h.read(conversation.id);
      expect(h.store.operations()).toHaveLength(operations);

      const reverted = await h.app.inject({
        method: 'POST',
        url: `${h.base}/revert`,
        payload: { author: { kind: 'agent', sessionId: conversation.sessionId }, requestId: uuid() },
      });
      expect(reverted.statusCode).toBe(200);
      expect(replies()).toHaveLength(0);
      const afterRevert = h.store.operations().length;
      forgetReplyPasses();
      await h.stop(conversation.sessionId);
      await h.list();
      expect(replies()).toHaveLength(0);
      expect(h.store.operations()).toHaveLength(afterRevert);
      // The list still names the reply and its parts, so the thread can say it was removed.
      expect((await h.list())[0].requests?.[0].reply).toEqual({
        commentId: replyCommentId(asked.messageId),
        postedAt: expect.any(Number),
        parts: 2,
      });
    } finally {
      await h.app.close();
    }
  });

  it('a reply stops growing once a later prompt closes its turn, at the part limit, and for a record an earlier release wrote', async () => {
    const h = await harness();
    try {
      const conversation = await h.start();
      const closed = await h.ask(conversation.id, 'note1', 'first?');
      const rows = [prompt(closed.messageId, 'first?'), said('a1')];
      h.transcripts.set(conversation.sessionId, rows);
      await h.stop(conversation.sessionId);
      expect(h.message(closed.messageId)?.reply).not.toHaveProperty('final');
      const many = await h.ask(conversation.id, 'note2', 'second?');
      rows.push(prompt(many.messageId, 'second?'));
      await h.list();
      expect(h.message(closed.messageId)?.reply).toMatchObject({ parts: 1, final: true });

      for (let part = 1; part <= MAX_REPLY_PARTS + 2; part++) {
        rows.push(said(`b${part}`));
        await h.stop(conversation.sessionId);
      }
      const parts = h.thread('note2').filter((c) => c.author.kind === 'agent');
      expect(parts.map((c) => c.id)).toEqual(
        Array.from({ length: MAX_REPLY_PARTS }, (_, i) => replyPartId(many.messageId, i + 1))
      );
      expect(parts.at(-1)!.text).toBe(`b${MAX_REPLY_PARTS}${REPLY_MORE_NOTE}`);
      expect(h.message(many.messageId)?.reply).toMatchObject({ parts: MAX_REPLY_PARTS, final: true });

      const old = await h.ask(conversation.id, 'note1', 'third?');
      rows.push(prompt(old.messageId, 'third?'), said('c1'));
      expect(
        setMessageReply(h.workspace.id, conversation.id, old.messageId, {
          commentId: replyCommentId(old.messageId),
          postedAt: 1,
        })
      ).toBe(true);
      const before = h.store.operations().length;
      rows.push(said('c2'));
      await h.stop(conversation.sessionId);
      expect(h.store.operations()).toHaveLength(before);
      expect(h.message(old.messageId)?.reply).toEqual({ commentId: replyCommentId(old.messageId), postedAt: 1 });
    } finally {
      await h.app.close();
    }
  });

  it('a comment planted under a later part id is not taken for the part, and the reply ends where it stands', async () => {
    const h = await harness();
    try {
      const conversation = await h.start();
      const asked = await h.ask(conversation.id, 'note1', 'q?');
      const rows = [prompt(asked.messageId, 'q?'), said('one')];
      h.transcripts.set(conversation.sessionId, rows);
      await h.stop(conversation.sessionId);
      expect(
        h.store.append(
          [
            {
              kind: 'comment',
              opId: 'plant-part',
              objectId: 'note1',
              patch: { id: replyPartId(asked.messageId, 2), text: 'planted' },
            },
          ],
          human
        ).ok
      ).toBe(true);
      rows.push(said('two'));
      const before = h.store.read().comments.length;
      await h.stop(conversation.sessionId);
      rows.push(said('three'));
      await h.stop(conversation.sessionId);
      expect(h.store.read().comments).toHaveLength(before);
      expect(h.message(asked.messageId)?.reply).toMatchObject({
        commentId: replyCommentId(asked.messageId),
        parts: 1,
        final: true,
      });
    } finally {
      await h.app.close();
    }
  });

  it('a prompt absorbed in the middle of a turn does not close the request before it; both get the whole turn', async () => {
    const h = await harness();
    try {
      const conversation = await h.start();
      const first = await h.ask(conversation.id, 'note1', 'first?');
      const second = await h.ask(conversation.id, 'note2', 'second?');
      h.transcripts.set(conversation.sessionId, [
        prompt(first.messageId, 'first?'),
        said('starting'),
        { ...prompt(second.messageId, 'second?'), queued: true },
        said('both answered'),
      ]);
      h.sessions.get(conversation.sessionId)!.hookTurnRunning = true;
      await h.list();
      await h.read(conversation.id);
      expect(h.thread('note1')).toHaveLength(1);
      expect(h.thread('note2')).toHaveLength(1);
      expect(h.message(first.messageId)?.reply).toBeUndefined();

      h.sessions.get(conversation.sessionId)!.hookTurnRunning = false;
      await h.stop(conversation.sessionId);
      const whole = `starting\n\nboth answered${REPLY_SHARED_NOTE}`;
      expect(h.thread('note1').map((c) => c.text)).toEqual(['first?', whole]);
      expect(h.thread('note2').map((c) => c.text)).toEqual(['second?', whole]);
    } finally {
      await h.app.close();
    }
  });

  it('a failure in passing records nothing and the next pass posts', async () => {
    const h = await harness();
    try {
      const conversation = await h.start();
      const asked = await h.ask(conversation.id, 'note1', 'q?');
      h.transcripts.set(conversation.sessionId, [prompt(asked.messageId, 'q?'), said('answer')]);
      const append = vi.spyOn(h.store, 'appendExpanded').mockImplementationOnce(() => {
        throw new Error('disk busy');
      });
      await h.stop(conversation.sessionId);
      expect(append).toHaveBeenCalledTimes(1);
      expect(h.message(asked.messageId)?.reply).toBeUndefined();
      expect(h.thread('note1')).toHaveLength(1);
      await h.read(conversation.id);
      expect(h.thread('note1').map((c) => c.text)).toEqual(['q?', 'answer']);
      expect(h.message(asked.messageId)?.reply).toMatchObject({ commentId: replyCommentId(asked.messageId) });
    } finally {
      await h.app.close();
    }
  });

  it('a comment planted under the reply id is not taken for the reply, and nothing is posted beside it', async () => {
    const h = await harness();
    try {
      const conversation = await h.start();
      const byPerson = await h.ask(conversation.id, 'note1', 'one?');
      const elsewhere = await h.ask(conversation.id, 'note1', 'two?');
      const otherAgent = await h.ask(conversation.id, 'note1', 'three?');
      const plant = (messageId: string, objectId: string, author: Parameters<typeof h.store.append>[1]) =>
        expect(
          h.store.append(
            [
              {
                kind: 'comment',
                opId: `plant-${messageId}`,
                objectId,
                patch: { id: replyCommentId(messageId), text: 'planted' },
              },
            ],
            author
          ).ok
        ).toBe(true);
      plant(byPerson.messageId, 'note1', human);
      plant(elsewhere.messageId, 'note2', { kind: 'agent', sessionId: conversation.sessionId });
      plant(otherAgent.messageId, 'note1', { kind: 'agent', sessionId: 'another-session' });
      h.transcripts.set(conversation.sessionId, [
        prompt(byPerson.messageId, 'one?'),
        said('a1'),
        prompt(elsewhere.messageId, 'two?'),
        said('a2'),
        prompt(otherAgent.messageId, 'three?'),
        said('a3'),
      ]);
      const before = h.store.read().comments.length;
      await h.stop(conversation.sessionId);
      expect(h.store.read().comments).toHaveLength(before);
      for (const asked of [byPerson, elsewhere, otherAgent])
        expect(h.message(asked.messageId)?.reply).toEqual({ dropped: 'refused' });
    } finally {
      await h.app.close();
    }
  });

  it('does not read an unchanged transcript again, and gives up on a prompt that never appears', async () => {
    const h = await harness();
    try {
      const conversation = await h.start();
      const asked = await h.ask(conversation.id, 'note1', 'q?');
      h.transcripts.set(conversation.sessionId, [{ role: 'user', text: 'something else' }, said('unrelated')]);
      h.stamps.set(conversation.sessionId, 'file:1:100');
      await h.list();
      await h.list();
      await h.read(conversation.id);
      expect(h.port.transcriptRows).toHaveBeenCalledTimes(1);
      h.stamps.set(conversation.sessionId, 'file:2:140');
      await h.list();
      await h.list();
      expect(h.port.transcriptRows).toHaveBeenCalledTimes(2);
      expect(h.message(asked.messageId)?.reply).toBeUndefined();

      replyRouting.maxAgeMs = 0;
      await pause(2);
      await h.list();
      expect(h.message(asked.messageId)?.reply).toEqual({ dropped: 'timed-out' });
      expect((await h.list())[0].requests?.[0].reply).toEqual({ dropped: 'timed-out' });
      const reads = h.port.transcriptRows.mock.calls.length;
      await h.list();
      expect(h.port.transcriptRows).toHaveBeenCalledTimes(reads);
      expect(h.thread('note1')).toHaveLength(1);
    } finally {
      await h.app.close();
    }
  });

  it('an agent that exited settles with what it wrote, or records that the session ended', async () => {
    const h = await harness();
    try {
      const conversation = await h.start();
      const answered = await h.ask(conversation.id, 'note1', 'one?');
      const unseen = await h.ask(conversation.id, 'note2', 'two?');
      h.transcripts.set(conversation.sessionId, [prompt(answered.messageId, 'one?'), said('said before exiting')]);
      h.sessions.get(conversation.sessionId)!.paneExit = { status: 0 };
      await h.list();
      expect(h.thread('note1').map((c) => c.text)).toEqual(['one?', 'said before exiting']);
      expect(h.message(unseen.messageId)?.reply).toEqual({ dropped: 'session-ended' });
      expect(h.thread('note2')).toHaveLength(1);
    } finally {
      await h.app.close();
    }
  });

  it('waits for a prompt the transcript does not hold yet and for a turn with no text yet', async () => {
    const h = await harness();
    try {
      const conversation = await h.start();
      const asked = await h.ask(conversation.id, 'note1', 'q?');
      h.transcripts.set(conversation.sessionId, [{ role: 'user', text: 'something else' }, said('unrelated')]);
      await h.stop(conversation.sessionId);
      h.transcripts.set(conversation.sessionId, [prompt(asked.messageId, 'q?')]);
      await h.stop(conversation.sessionId);
      h.transcripts.delete(conversation.sessionId);
      await h.stop(conversation.sessionId);
      expect(h.thread('note1')).toHaveLength(1);
      expect(h.message(asked.messageId)?.reply).toBeUndefined();
      h.transcripts.set(conversation.sessionId, [prompt(asked.messageId, 'q?'), { role: 'user', text: 'moved on' }]);
      await h.stop(conversation.sessionId);
      expect(h.message(asked.messageId)?.reply).toEqual({ dropped: 'no-reply' });
      expect(h.thread('note1')).toHaveLength(1);
    } finally {
      await h.app.close();
    }
  });

  it('drops the reply and records why when the object is gone, and does not throw', async () => {
    const h = await harness();
    try {
      const conversation = await h.start();
      const asked = await h.ask(conversation.id, 'note1', 'q?');
      h.store.append([{ kind: 'delete', opId: 'gone', objectId: 'note1' }], human);
      h.transcripts.set(conversation.sessionId, [prompt(asked.messageId, 'q?'), said('too late')]);
      await h.stop(conversation.sessionId);
      expect(h.message(asked.messageId)?.reply).toEqual({ dropped: 'object-removed' });
      expect(h.store.read().comments.filter((c) => c.author.kind === 'agent')).toEqual([]);
      expect((await h.list())[0].requests?.[0].reply).toEqual({ dropped: 'object-removed' });
      await h.stop(conversation.sessionId);
      expect(h.store.read().comments.filter((c) => c.author.kind === 'agent')).toEqual([]);
    } finally {
      await h.app.close();
    }
  });

  it('cuts a reply to the comment limit with a pointer to the conversation', async () => {
    const h = await harness();
    try {
      const conversation = await h.start();
      const asked = await h.ask(conversation.id, 'note1', 'q?');
      h.transcripts.set(conversation.sessionId, [
        prompt(asked.messageId, 'q?'),
        said('y'.repeat(MAX_COMMENT_CHARS + 10)),
      ]);
      await h.stop(conversation.sessionId);
      const reply = h.thread('note1').find((c) => c.author.kind === 'agent')!;
      expect(reply.text).toHaveLength(MAX_COMMENT_CHARS);
      expect(reply.text.endsWith(REPLY_CUT_NOTE)).toBe(true);
    } finally {
      await h.app.close();
    }
  });

  it('a colour that may not write posts nothing and records nothing; the live colour then routes it', async () => {
    const h = await harness();
    try {
      const conversation = await h.start();
      const asked = await h.ask(conversation.id, 'note1', 'q?');
      h.transcripts.set(conversation.sessionId, [prompt(asked.messageId, 'q?'), said('answer')]);
      deployRole.enter('retired');
      await h.stop(conversation.sessionId);
      await h.read(conversation.id);
      await h.list();
      expect(h.port.transcriptRows).not.toHaveBeenCalled();
      expect(h.thread('note1')).toHaveLength(1);
      expect(h.message(asked.messageId)?.reply).toBeUndefined();
      deployRole.enter('live');
      await h.read(conversation.id);
      expect(h.thread('note1').map((c) => c.text)).toEqual(['q?', 'answer']);
    } finally {
      await h.app.close();
    }
  });

  it('a request that was not delivered gets no reply, and one whose session is gone waits', async () => {
    const h = await harness();
    try {
      const conversation = await h.start();
      const session = h.sessions.get(conversation.sessionId)!;
      (session.writeViaMux as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const failed = await h.ask(conversation.id, 'note1', 'lost?');
      expect(h.message(failed.messageId)?.state).toBe('failed');
      h.transcripts.set(conversation.sessionId, [prompt(failed.messageId, 'lost?'), said('never asked')]);
      await h.stop(conversation.sessionId);
      expect(h.thread('note1')).toHaveLength(1);
      expect((await h.list())[0].requests?.[0]).toMatchObject({ state: 'failed' });

      (session.writeViaMux as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      const retried = await h.send(conversation.id, {
        messageId: failed.messageId,
        text: 'lost?',
        refIds: ['note1'],
        origin: failed.origin,
      });
      expect(retried.statusCode).toBe(200);
      expect(h.message(failed.messageId)?.state).toBe('delivered');
      h.sessions.delete(conversation.sessionId);
      await h.read(conversation.id);
      expect(h.thread('note1')).toHaveLength(1);
      expect(h.message(failed.messageId)?.reply).toBeUndefined();
      expect(h.port.transcriptRows).not.toHaveBeenCalled();
      replyRouting.maxAgeMs = 0;
      await pause(2);
      await h.read(conversation.id);
      expect(h.message(failed.messageId)?.reply).toEqual({ dropped: 'session-ended' });
    } finally {
      await h.app.close();
    }
  });

  it('an agent in the case may ask through the tool; an agent that is a conversation may not', async () => {
    const h = await harness();
    try {
      const conversation = await h.start();
      const commentId = await h.comment('note1', 'from the helper');
      const { resolveCasePath } = await import('../src/web/routes/case-routes.js');
      const workingDir = await resolveCasePath('thread-case', { username: 'admin', role: 'admin' });
      h.sessions.set('helper', { id: 'helper', workingDir });
      const tool = (session: string) =>
        h.app.inject({
          method: 'POST',
          url: '/api/canvas/current/command',
          headers: { 'x-codeman-parent-session': session },
          payload: {
            tool: 'canvas_conversation',
            arguments: {
              action: 'send',
              conversationId: conversation.id,
              messageId: uuid(),
              text: 'from the helper',
              refIds: ['note1'],
              origin: { kind: 'thread', objectId: 'note1', commentId },
            },
          },
        });
      const allowed = await tool('helper');
      await settleDeliveries();
      expect(allowed.statusCode).toBe(200);
      expect((await h.list())[0].requests).toHaveLength(1);
      const refused = await tool(conversation.sessionId);
      expect(refused.statusCode).toBe(409);
      const create = await h.app.inject({
        method: 'POST',
        url: '/api/canvas/current/command',
        headers: { 'x-codeman-parent-session': 'helper' },
        payload: {
          tool: 'canvas_conversation',
          arguments: { action: 'create', requestId: uuid(), origin: { kind: 'thread', objectId: 'note1', commentId } },
        },
      });
      expect(create.statusCode).toBe(400);
    } finally {
      await h.app.close();
    }
  });
});
