import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCanvasRoutes } from '../src/web/routes/canvas-routes.js';
import {
  conversationTurnEnded,
  settleDeliveries,
  settleReplies,
} from '../src/web/routes/canvas-conversation-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { CanvasStores } from '../src/canvas/canvas-store.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { readConversations } from '../src/canvas/conversations.js';
import { CONTEXT_NOTICE } from '../src/canvas/conversation-schema.js';
import { MAX_COMMENT_CHARS, REPLY_CUT_NOTE, replyCommentId } from '../src/canvas/thread-reply.js';
import { deployRole } from '../src/deploy-role.js';
import { create, human } from './canvas-fixtures.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-thread-'));
  vi.stubEnv('CODEMAN_DATA_DIR', dir);
});
afterEach(() => {
  deployRole.enter('live');
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
const uuid = () => crypto.randomUUID();
type Row = { role: string; text: string };
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
  const stores = new CanvasStores();
  const port = {
    sessions,
    canvasEnabled: async () => true,
    canvasStores: async () => stores,
    broadcast: vi.fn(),
    transcriptRows: vi.fn(async (sessionId: string) => transcripts.get(sessionId) ?? null),
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

  it('reconciles on a read or a list when the stop was missed, but never while the turn is running', async () => {
    const h = await harness();
    try {
      const conversation = await h.start();
      const asked = await h.ask(conversation.id, 'note1', 'q?');
      h.transcripts.set(conversation.sessionId, [prompt(asked.messageId, 'q?'), said('partial')]);
      const session = h.sessions.get(conversation.sessionId)!;
      session.hookTurnRunning = true;
      await h.read(conversation.id);
      await h.stop(conversation.sessionId);
      session.hookTurnRunning = false;
      session.isWorking = true;
      await h.list();
      expect(h.thread('note1')).toHaveLength(1);
      expect(h.message(asked.messageId)?.reply).toBeUndefined();

      session.isWorking = false;
      h.transcripts.set(conversation.sessionId, [prompt(asked.messageId, 'q?'), said('the whole answer')]);
      await h.read(conversation.id);
      expect(h.thread('note1').map((c) => c.text)).toEqual(['q?', 'the whole answer']);

      const second = await h.ask(conversation.id, 'note2', 'and this?');
      h.transcripts.set(conversation.sessionId, [
        prompt(asked.messageId, 'q?'),
        said('the whole answer'),
        prompt(second.messageId, 'and this?'),
        said('closed by the next prompt'),
        { role: 'user', text: 'typed in the terminal' },
        said('still going'),
      ]);
      session.isWorking = true;
      await h.list();
      expect(h.thread('note2').map((c) => c.text)).toEqual(['and this?', 'closed by the next prompt']);
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
