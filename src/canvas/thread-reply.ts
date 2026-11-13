/** @fileoverview Pure parts of routing an agent's reply back to the comment thread a request was asked from: which transcript rows are the reply, the comment id it is posted under, and the cut to the comment limit. */
import { splitPrompt } from './conversation-schema.js';

/** Matches `CommentSchema`'s text limit. */
export const MAX_COMMENT_CHARS = 100_000;
export const REPLY_CUT_NOTE = '\n\n[Reply cut here. The full reply is in the conversation.]';

/** One id per request, so a repeated stop signal or a retry finds the comment already there. */
export const replyCommentId = (messageId: string): string => `reply-${messageId.toLowerCase()}`;

export type ReplyRow = { role: string; text: string };
export type ExtractedReply = {
  /** The transcript holds the prompt row that carries this message id. */
  found: boolean;
  /** A later prompt row follows, so no more reply text can arrive for this request. */
  closed: boolean;
  text: string;
};
/** The assistant text between the prompt row that carries `messageId` and the next prompt row. */
export function extractReply(rows: readonly ReplyRow[], messageId: string): ExtractedReply {
  const wanted = messageId.toLowerCase();
  const start = rows.findIndex((r) => r.role === 'user' && splitPrompt(r.text).messageId?.toLowerCase() === wanted);
  if (start < 0) return { found: false, closed: false, text: '' };
  const parts: string[] = [];
  let closed = false;
  for (const row of rows.slice(start + 1)) {
    if (row.role === 'user') {
      closed = true;
      break;
    }
    if (row.role === 'assistant' && row.text.trim()) parts.push(row.text.trim());
  }
  return { found: true, closed, text: parts.join('\n\n') };
}

/** Cuts a reply to the comment limit, ending with a pointer to the conversation; never splits a surrogate pair. */
export function cutReply(text: string, limit = MAX_COMMENT_CHARS): string {
  if (text.length <= limit) return text;
  let end = Math.max(0, limit - REPLY_CUT_NOTE.length);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end) + REPLY_CUT_NOTE;
}
