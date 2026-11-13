/** @fileoverview Pure parts of routing an agent's reply back to the comment thread a request was asked from: which transcript rows are the reply, the comment id it is posted under, and the cut to the comment limit. */
import { splitPrompt } from './conversation-schema.js';

/** Matches `CommentSchema`'s text limit. */
export const MAX_COMMENT_CHARS = 100_000;
export const REPLY_CUT_NOTE = '\n\n[Reply cut here. The full reply is in the conversation.]';

/** One id per request, so a repeated stop signal or a retry finds the comment already there. */
export const replyCommentId = (messageId: string): string => `reply-${messageId.toLowerCase()}`;
/** A reply can grow while its turn is open; each addition is one more comment, up to this many. */
export const MAX_REPLY_PARTS = 5;
/** The comment id of part `n` (from 1): the first is the reply id itself, so each part is found again like the first. */
export const replyPartId = (messageId: string, part: number): string =>
  part <= 1 ? replyCommentId(messageId) : `${replyCommentId(messageId)}-${part}`;
export const REPLY_MORE_NOTE = '\n\n[More may follow. Read the conversation.]';

/** Appended when one turn answered more than one message, so the reader knows the reply is not this request's alone. */
export const REPLY_SHARED_NOTE = '\n\n[This turn answered more than one message; this is its whole reply.]';

/** One transcript row. `queued` marks a prompt the agent absorbed in the middle of a turn: it starts no turn of its own. */
export type ReplyRow = { role: string; text: string; queued?: boolean };
export type ExtractedReply = {
  /** The transcript holds the prompt row that carries this message id. */
  found: boolean;
  /** A later prompt that started a turn of its own follows, so no more reply text can arrive for this request. */
  closed: boolean;
  /** The turn absorbed another prompt, so `text` is the whole turn's reply and belongs to every prompt in it. */
  shared: boolean;
  text: string;
};
const messageIdOf = (row: ReplyRow): string | undefined =>
  row.role === 'user' ? splitPrompt(row.text).messageId?.toLowerCase() : undefined;
/**
 * The reply to the prompt that carries `messageId`. A turn runs from a prompt that started it to the next such prompt;
 * a queued prompt never ends one. When the turn held no queued prompt the reply is the assistant text after this
 * prompt. When it did, nothing in the transcript says which text answered which prompt, so the whole turn's assistant
 * text is the reply to every prompt in it and `shared` says so.
 */
export function extractReply(rows: readonly ReplyRow[], messageId: string): ExtractedReply {
  const wanted = messageId.toLowerCase();
  // A prompt typed during a turn but submitted after it is recorded twice: the row that started its turn is the one that counts.
  const started = new Set(rows.flatMap((r) => (r.queued ? [] : (messageIdOf(r) ?? []))));
  const absorbed = (r: ReplyRow): boolean =>
    r.role === 'user' && r.queued === true && !started.has(messageIdOf(r) ?? '');
  const opens = (r: ReplyRow): boolean => r.role === 'user' && r.queued !== true;
  let at = rows.findIndex((r) => opens(r) && messageIdOf(r) === wanted);
  if (at < 0) at = rows.findIndex((r) => absorbed(r) && messageIdOf(r) === wanted);
  if (at < 0) return { found: false, closed: false, shared: false, text: '' };
  let open = at;
  while (open > 0 && !opens(rows[open])) open--;
  if (!opens(rows[open])) open = at;
  let end = rows.findIndex((r, i) => i > at && opens(r));
  const closed = end >= 0;
  if (!closed) end = rows.length;
  const shared = rows.slice(open, end).some(absorbed);
  const text = rows
    .slice((shared ? open : at) + 1, end)
    .flatMap((r) => (r.role === 'assistant' && r.text.trim() ? [r.text.trim()] : []))
    .join('\n\n');
  return { found: true, closed, shared, text };
}

/** Cuts a reply to the comment limit, ending with a pointer to the conversation; never splits a surrogate pair. */
export function cutReply(text: string, limit = MAX_COMMENT_CHARS): string {
  if (text.length <= limit) return text;
  let end = Math.max(0, limit - REPLY_CUT_NOTE.length);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end) + REPLY_CUT_NOTE;
}
