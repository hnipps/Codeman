import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CONTEXT_NOTICE,
  ConversationsFileSchema,
  CreateConversationBodySchema,
  SendBodySchema,
  threadOrigin,
  replyExtendable,
  threadReply,
} from '../src/canvas/conversation-schema.js';
import {
  cutReply,
  extractReply,
  MAX_COMMENT_CHARS,
  MAX_REPLY_PARTS,
  REPLY_CUT_NOTE,
  replyCommentId,
  replyPartId,
} from '../src/canvas/thread-reply.js';
import { CommentSchema, IdSchema } from '../src/canvas/model.js';
import {
  askFailure,
  MAX_STORED_DRAFT_CHARS,
  MAX_STORED_DRAFTS,
  nextAsk,
  parseAsks,
  parseDrafts,
  replyCommentIds,
  requestStatus,
  storeAsks,
  storeDraft,
} from '../packages/canvas/src/ask.js';
import { buildThread } from '../packages/canvas/src/conversation.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const prompt = (id: string, text: string) =>
  `<canvas-context workspace="w" seq="1" message="${id}">\n[n rev=1 type=text path=""] x\n</canvas-context>\n${CONTEXT_NOTICE}\n${text}`;
const user = (text: string) => ({ role: 'user', text });
const reply = (text: string) => ({ role: 'assistant', text });

/** The message and file shapes of the release before thread requests, frozen here: that release must read what this one writes. */
const PreviousMessage = z
  .object({
    messageId: z.uuid(),
    sentAt: z.number().int().nonnegative(),
    deliveredAt: z.number().int().nonnegative().nullable(),
    state: z.enum(['queued', 'sending', 'delivered', 'failed']).optional(),
    author: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('human'), userId: z.string().min(1).max(128) }).passthrough(),
      z.object({ kind: z.literal('agent'), sessionId: IdSchema }).passthrough(),
    ]),
    textSha256: z.string().regex(/^[a-f0-9]{64}$/),
    textBytes: z.number().int().nonnegative(),
    namedSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    refs: z.array(z.object({ id: IdSchema }).passthrough()).max(200),
    seq: z.number().int().nonnegative(),
  })
  .passthrough();
const PreviousFile = z
  .object({
    version: z.literal(1),
    conversations: z
      .array(
        z
          .object({
            id: z.uuid(),
            sessionId: z.string().min(1).max(128),
            cliId: z.string().min(1).max(64),
            model: z.string().max(100).optional(),
            title: z.string().max(200).optional(),
            origin: z.unknown().optional(),
            requestId: z.uuid().optional(),
            createdAt: z.number().int().nonnegative(),
            createdBy: z.string().min(1).max(128),
            messages: z.array(PreviousMessage).max(2000),
          })
          .passthrough()
      )
      .max(50),
  })
  .passthrough();
const stored = (extra: object = {}) => ({
  messageId: A,
  sentAt: 1,
  deliveredAt: 2,
  state: 'delivered',
  author: { kind: 'human', userId: 'u' },
  textSha256: 'a'.repeat(64),
  textBytes: 3,
  refs: [],
  seq: 1,
  ...extra,
});
const file = (messages: object[], conversation: object = {}) => ({
  version: 1,
  conversations: [
    { id: B, sessionId: 's1', cliId: 'claude', createdAt: 1, createdBy: '@single', messages, ...conversation },
  ],
});

describe('thread reply extraction', () => {
  it('takes the assistant text between the asking prompt and the next prompt', () => {
    const rows = [
      user('an earlier prompt'),
      reply('earlier answer'),
      user(`<pasted_content id="1">${prompt(A, 'what is this?')}</pasted_content>`),
      reply('First part.'),
      reply('  '),
      reply('Second part.'),
      user(prompt(B, 'next')),
      reply('about the next one'),
    ];
    expect(extractReply(rows, A)).toEqual({
      found: true,
      closed: true,
      shared: false,
      text: 'First part.\n\nSecond part.',
    });
    expect(extractReply(rows, B)).toEqual({ found: true, closed: false, shared: false, text: 'about the next one' });
    expect(extractReply(rows, A.toUpperCase()).text).toBe('First part.\n\nSecond part.');
  });
  it('reports a prompt the transcript does not hold, and one with no reply text', () => {
    expect(extractReply([user('plain'), reply('x')], A)).toEqual({
      found: false,
      closed: false,
      shared: false,
      text: '',
    });
    expect(extractReply([user(prompt(A, 'q'))], A)).toEqual({ found: true, closed: false, shared: false, text: '' });
    expect(extractReply([user(prompt(A, 'q')), user('again')], A)).toEqual({
      found: true,
      closed: true,
      shared: false,
      text: '',
    });
  });
  it('derives one comment id per message that the comment schema accepts', () => {
    expect(replyCommentId(A.toUpperCase())).toBe(replyCommentId(A));
    expect(replyCommentId(A)).not.toBe(replyCommentId(B));
    expect(IdSchema.safeParse(replyCommentId(A)).success).toBe(true);
  });
  it('names each part of a reply, the first under the reply id itself', () => {
    expect(replyPartId(A, 1)).toBe(replyCommentId(A));
    expect(replyPartId(A, 2)).toBe(`${replyCommentId(A)}-2`);
    expect(IdSchema.safeParse(replyPartId(A, MAX_REPLY_PARTS)).success).toBe(true);
    expect(replyCommentIds({ commentId: replyCommentId(A), parts: 3 })).toEqual(
      [1, 2, 3].map((part) => replyPartId(A, part))
    );
    expect(replyCommentIds({ commentId: 'r' })).toEqual(['r']);
  });
  it('cuts a long reply to the comment limit with a pointer, never through a surrogate pair', () => {
    expect(cutReply('short')).toBe('short');
    const long = cutReply('x'.repeat(MAX_COMMENT_CHARS + 50));
    expect(long).toHaveLength(MAX_COMMENT_CHARS);
    expect(long.endsWith(REPLY_CUT_NOTE)).toBe(true);
    const pair = cutReply('😀'.repeat(60), 20 + REPLY_CUT_NOTE.length + 1);
    expect(pair.slice(0, -REPLY_CUT_NOTE.length)).toBe('😀'.repeat(10));
    const comment = { id: 'c', objectId: 'o', author: { kind: 'human', userId: 'u' }, text: long, createdAt: 1 };
    expect(CommentSchema.safeParse(comment).success).toBe(true);
  });
});

describe('thread request records', () => {
  const origin = { kind: 'thread', objectId: 'note1', commentId: 'c1' };
  it('reads an origin and a reply, and treats a shape it does not know as recorded but unreadable', () => {
    expect(threadOrigin({ origin })).toEqual(origin);
    expect(threadOrigin({ origin: { ...origin, later: 1 } })).toEqual(origin);
    expect(threadOrigin({ origin: { kind: 'voice' } })).toBeUndefined();
    expect(threadOrigin({})).toBeUndefined();
    expect(threadReply({})).toBeUndefined();
    expect(threadReply({ reply: { commentId: 'reply-x', postedAt: 5 } })).toEqual({
      commentId: 'reply-x',
      postedAt: 5,
    });
    expect(threadReply({ reply: { dropped: 'object-removed' } })).toEqual({ dropped: 'object-removed' });
    expect(threadReply({ reply: { dropped: 'a-later-reason' } })).toBe('unknown');
  });
  it('a posted reply can grow only while its progress is whole and it is not final', () => {
    const grown = { commentId: 'reply-x', postedAt: 5, parts: 2, chars: 40, hash: 'abc' };
    expect(threadReply({ reply: grown })).toEqual(grown);
    expect(replyExtendable(threadReply({ reply: grown }))).toBe(true);
    expect(replyExtendable(threadReply({ reply: { ...grown, final: true } }))).toBe(false);
    // The record the first release wrote, and progress this release cannot read, are settled replies.
    expect(replyExtendable(threadReply({ reply: { commentId: 'reply-x', postedAt: 5 } }))).toBe(false);
    expect(replyExtendable(threadReply({ reply: { ...grown, chars: 'many' } }))).toBe(false);
    expect(threadReply({ reply: { ...grown, hash: 7 } })).toEqual({ commentId: 'reply-x', postedAt: 5, parts: 2 });
    expect(replyExtendable(threadReply({ reply: { dropped: 'no-reply' } }))).toBe(false);
    expect(replyExtendable(undefined)).toBe(false);
  });
  it('a file written with origin and reply parses under the previous schema, and a previous file under this one', () => {
    const now = file(
      [
        stored({ origin, reply: { commentId: replyCommentId(A), postedAt: 9, parts: 2, chars: 12, hash: 'ab' } }),
        stored({ messageId: B, origin, reply: { dropped: 'no-reply' } }),
      ],
      { origin }
    );
    expect(ConversationsFileSchema.safeParse(now).success).toBe(true);
    const before = PreviousFile.safeParse(now);
    expect(before.success).toBe(true);
    expect(before.data?.conversations[0].messages[0]).toMatchObject({ origin, reply: { postedAt: 9 } });
    const old = file([stored()]);
    expect(PreviousFile.safeParse(old).success).toBe(true);
    const read = ConversationsFileSchema.parse(old);
    expect(threadOrigin(read.conversations[0].messages[0])).toBeUndefined();
    expect(threadReply(read.conversations[0].messages[0])).toBeUndefined();
  });
  it('a later release that records another origin or reply shape leaves the file readable', () => {
    const later = file([stored({ origin: { kind: 'voice', clip: 3 }, reply: { moved: true } })], { origin: 7 });
    expect(ConversationsFileSchema.safeParse(later).success).toBe(true);
  });
  it('the send and create bodies take a thread origin and nothing else new', () => {
    expect(SendBodySchema.safeParse({ messageId: A, text: 'q', refIds: ['note1'], origin }).success).toBe(true);
    expect(SendBodySchema.safeParse({ messageId: A, text: 'q' }).success).toBe(true);
    expect(SendBodySchema.safeParse({ messageId: A, text: 'q', origin: { ...origin, extra: 1 } }).success).toBe(false);
    expect(SendBodySchema.safeParse({ messageId: A, text: 'q', origin: { kind: 'voice' } }).success).toBe(false);
    expect(CreateConversationBodySchema.safeParse({ requestId: A, origin }).success).toBe(true);
    expect(CreateConversationBodySchema.safeParse({ requestId: A, thread: origin }).success).toBe(false);
  });
});

describe('ask agent attempts', () => {
  const ids = () => {
    let n = 0;
    return () => `${String(++n).padStart(8, '0')}-0000-4000-8000-000000000000`;
  };
  it('reuses every id for the same ask, and keeps the comment ids when only the conversation changes', () => {
    const make = ids();
    const first = nextAsk(undefined, 'o', 'why?', null, make);
    expect(nextAsk(first, 'o', 'why?', null, make)).toBe(first);
    const created = { ...first, conversationId: B };
    expect(nextAsk(created, 'o', 'why?', null, make)).toBe(created);
    const moved = nextAsk(created, 'o', 'why?', A, make);
    expect([moved.commentId, moved.commentRequestId]).toEqual([first.commentId, first.commentRequestId]);
    expect(moved.messageId).not.toBe(first.messageId);
    expect(moved.conversationId).toBe(A);
    const edited = nextAsk(first, 'o', 'why not?', null, make);
    expect(edited.commentId).not.toBe(first.commentId);
    expect(nextAsk(first, 'other', 'why?', null, make).commentId).not.toBe(first.commentId);
  });
  it('stores one attempt per object and reads back only well-formed ones', () => {
    const make = ids();
    const a = nextAsk(undefined, 'o', 'one', null, make);
    const b = nextAsk(undefined, 'o', 'two', null, make);
    const c = nextAsk(undefined, 'p', 'three', A, make);
    const list = storeAsks(storeAsks(storeAsks([], a), b), c);
    expect(list.map((x) => x.text)).toEqual(['two', 'three']);
    expect(parseAsks(JSON.stringify(list))).toEqual(list);
    expect(parseAsks(JSON.stringify([{ ...a, messageId: 'nope' }, 5, null]))).toEqual([]);
    expect(parseAsks('{')).toEqual([]);
    expect(parseAsks(null)).toEqual([]);
  });
  it('words a request state in one line', () => {
    const base = {
      conversationId: B,
      messageId: A,
      objectId: 'o',
      commentId: 'c',
      working: false,
      ended: false,
    };
    const say = (extra: object) => requestStatus({ ...base, state: 'delivered', ...extra } as never);
    expect(say({ state: 'queued' })).toEqual({ kind: 'queued', text: 'Queued' });
    expect(say({ state: 'sending' }).text).toBe('Sending');
    expect(say({ state: 'failed' })).toEqual({ kind: 'failed', text: 'Not delivered' });
    expect(say({ working: true })).toEqual({ kind: 'working', text: 'Working' });
    expect(say({}).kind).toBe('asked');
    expect(say({ reply: { commentId: 'r', postedAt: 1 }, working: true })).toEqual({
      kind: 'replied',
      text: 'Replied',
    });
    expect(say({ reply: { dropped: 'object-removed' } }).text).toContain('removed');
    expect(say({ reply: { dropped: 'no-reply' } }).text).toContain('without a reply');
    expect(say({ ended: true }).text).toBe('Session ended before a reply');
    expect(say({ ended: true, reply: { commentId: 'r', postedAt: 1 } }).kind).toBe('replied');
  });
  it('says a reply was removed once none of its comments is in the thread', () => {
    const request = {
      conversationId: 'c',
      messageId: A,
      objectId: 'o',
      commentId: 'q',
      state: 'delivered',
      reply: { commentId: 'r', postedAt: 1, parts: 2 },
      working: false,
      ended: false,
    } as const;
    expect(requestStatus(request, (id) => id === 'r-2')).toEqual({ kind: 'replied', text: 'Replied' });
    expect(requestStatus(request, () => false)).toEqual({ kind: 'removed', text: 'Reply removed' });
  });
  it('keeps thread drafts per object within a bound, and drops an empty or oversized one', () => {
    let drafts = storeDraft({}, 'a', 'one');
    drafts = storeDraft(drafts, 'b', 'two');
    drafts = storeDraft(drafts, 'a', 'one more');
    expect(Object.entries(drafts)).toEqual([
      ['b', 'two'],
      ['a', 'one more'],
    ]);
    expect(storeDraft(drafts, 'a', '  ')).toEqual({ b: 'two' });
    expect(storeDraft(drafts, 'b', 'x'.repeat(MAX_STORED_DRAFT_CHARS + 1))).toEqual({ a: 'one more' });
    for (let i = 0; i < MAX_STORED_DRAFTS + 4; i++) drafts = storeDraft(drafts, `o${i}`, 'text');
    expect(Object.keys(drafts)).toHaveLength(MAX_STORED_DRAFTS);
    expect(drafts).not.toHaveProperty('a');
    expect(parseDrafts(JSON.stringify(drafts))).toEqual(drafts);
    expect(parseDrafts('not json')).toEqual({});
    expect(parseDrafts('[1]')).toEqual({});
    expect(parseDrafts(JSON.stringify({ a: 1, b: 'kept' }))).toEqual({ b: 'kept' });
  });
  it('words a refusal for the thread from the server code', () => {
    expect(askFailure('SESSION_ENDED: the session has ended', 409)).toContain('Pick another conversation');
    expect(askFailure('ORIGIN_GONE: gone', 409)).toContain('removed');
    expect(askFailure('APPROVAL_PENDING: answer', 409)).toContain('question');
    expect(askFailure('', 404)).toContain('not found');
  });
  it('a prompt asked from a thread carries its origin into the rail, delivered or not', () => {
    const record = stored({ origin: { kind: 'thread', objectId: 'note1', commentId: 'c1' } }) as never;
    const shown = buildThread([{ role: 'user', text: prompt(A, 'why?') }], [record], []);
    expect(shown[0]).toMatchObject({ text: 'why?', origin: { objectId: 'note1', commentId: 'c1' } });
    const waiting = buildThread(
      [],
      [{ ...(record as object), state: 'queued', deliveredAt: null } as never],
      [{ messageId: A, text: 'why?', refIds: ['note1'] }]
    );
    expect(waiting[0]).toMatchObject({ pending: 'queued', origin: { objectId: 'note1' } });
    expect(buildThread([{ role: 'user', text: prompt(A, 'x') }], [stored() as never], [])[0].origin).toBeUndefined();
  });
});
