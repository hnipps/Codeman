import type { ThreadReply } from '../../../src/canvas/conversation-schema.js';
import { sendFailure } from './conversation.js';

/** One Ask agent attempt, kept across reloads so a retry reuses its ids: the comment is posted once and the prompt is written once. */
export type AskAttempt = {
  objectId: string;
  text: string;
  /** The conversation asked, or null for a new one. */
  target: string | null;
  commentRequestId: string;
  commentId: string;
  createRequestId: string;
  messageId: string;
  /** The conversation a "new" attempt created, once it has. */
  conversationId: string | null;
};
const MAX_STORED_ASKS = 8;
const UUID = /^[0-9a-fA-F-]{36}$/;
const isAttempt = (v: unknown): v is AskAttempt => {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.objectId === 'string' &&
    typeof o.text === 'string' &&
    (o.target === null || typeof o.target === 'string') &&
    (o.conversationId === null || typeof o.conversationId === 'string') &&
    [o.commentRequestId, o.commentId, o.createRequestId, o.messageId].every(
      (id) => typeof id === 'string' && UUID.test(id)
    )
  );
};
export function parseAsks(raw: string | null): AskAttempt[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter(isAttempt).slice(-MAX_STORED_ASKS) : [];
  } catch {
    return [];
  }
}
/**
 * The same text on the same object keeps its comment ids whatever conversation is chosen, so choosing another one
 * after a failure never posts the comment twice; the message and create ids are kept only for the same target.
 */
export function nextAsk(
  stored: AskAttempt | undefined,
  objectId: string,
  text: string,
  target: string | null,
  makeId: () => string
): AskAttempt {
  if (!stored || stored.objectId !== objectId || stored.text !== text)
    return {
      objectId,
      text,
      target,
      commentRequestId: makeId(),
      commentId: makeId(),
      createRequestId: makeId(),
      messageId: makeId(),
      conversationId: target,
    };
  if (stored.target === target) return stored;
  return { ...stored, target, createRequestId: makeId(), messageId: makeId(), conversationId: target };
}
export const storeAsks = (list: readonly AskAttempt[], attempt: AskAttempt): AskAttempt[] =>
  [...list.filter((a) => a.objectId !== attempt.objectId), attempt].slice(-MAX_STORED_ASKS);

/** A request a conversation took from a thread, as the conversation list reports it, with its conversation's state. */
export type ThreadRequest = {
  conversationId: string;
  messageId: string;
  objectId: string;
  commentId: string;
  state: 'queued' | 'sending' | 'delivered' | 'failed';
  reply?: ThreadReply;
  working: boolean;
  ended: boolean;
};
export type RequestStatus = { kind: 'queued' | 'sending' | 'working' | 'asked' | 'replied' | 'failed'; text: string };
/** One calm line on the asking comment. */
export function requestStatus(r: ThreadRequest): RequestStatus {
  if (r.state === 'failed') return { kind: 'failed', text: 'Not delivered' };
  if (r.state === 'queued') return { kind: 'queued', text: 'Queued' };
  if (r.state === 'sending') return { kind: 'sending', text: 'Sending' };
  if (r.reply && 'commentId' in r.reply) return { kind: 'replied', text: 'Replied' };
  if (r.reply)
    return {
      kind: 'failed',
      text:
        r.reply.dropped === 'object-removed'
          ? 'Reply not posted: the object was removed'
          : r.reply.dropped === 'no-reply'
            ? 'The agent finished without a reply'
            : 'Reply not posted here. Read it in the conversation.',
    };
  if (r.ended) return { kind: 'failed', text: 'Session ended before a reply' };
  return r.working ? { kind: 'working', text: 'Working' } : { kind: 'asked', text: 'Waiting for a reply' };
}

/** Why a posted comment did not reach the agent, worded for the thread; the server prefixes a refusal with a stable code. */
export function askFailure(message: string, status: number): string {
  switch (/^([A-Z_]+):/.exec(message)?.[1]) {
    case 'SESSION_ENDED':
      return 'that session has ended. Pick another conversation.';
    case 'APPROVAL_PENDING':
      return 'the agent is waiting on a question. Answer it in the conversation first.';
    case 'RATE_LIMITED':
      return 'too many messages in a short time. Try again in a moment.';
    case 'TOO_LARGE':
      return 'the comment and its object are too large to send.';
    case 'ORIGIN_GONE':
      return 'the comment or its object was removed.';
    default:
      return sendFailure(message, status).text;
  }
}
