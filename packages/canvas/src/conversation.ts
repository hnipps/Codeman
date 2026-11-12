import { splitPrompt, type ConversationMessage } from '../../../src/canvas/conversation-schema.js';

/** One prompt or reply row as the session's transcript reports it. */
export type TranscriptRow = { role: 'user' | 'assistant'; text: string; queued?: boolean };
/** A message the person sent that the transcript has not shown yet. */
export type SentMessage = { messageId: string; text: string; refIds: string[] };
export type Turn = {
  key: string;
  who: 'you' | 'agent';
  text: string;
  /** Labels of the objects the message carried, from the recorded manifest, never from the transcript text. */
  refs: string[];
  queued: boolean;
};
const refLabel = (m: ConversationMessage['refs'][number]): string =>
  m.descendants.length ? `${m.label} +${m.descendants.length}` : m.label;

/**
 * The thread is the session's own transcript; the record adds only the chips a prompt carried. A prompt the
 * transcript does not hold yet (sent a moment ago) is shown from what was sent, and dropped the moment its
 * row appears: by the message id in its context block, or by identical text when it carried no context.
 */
export function buildThread(
  rows: readonly TranscriptRow[],
  messages: readonly ConversationMessage[],
  sent: readonly SentMessage[]
): Turn[] {
  const byId = new Map(messages.map((m) => [m.messageId.toLowerCase(), m]));
  const seen = new Set<string>();
  const seenText = new Set<string>();
  const turns: Turn[] = rows.map((row, index) => {
    if (row.role === 'assistant') return { key: `r${index}`, who: 'agent', text: row.text, refs: [], queued: false };
    const { messageId, text } = splitPrompt(row.text);
    if (messageId) seen.add(messageId.toLowerCase());
    else seenText.add(text);
    const record = messageId ? byId.get(messageId.toLowerCase()) : undefined;
    return { key: `r${index}`, who: 'you', text, refs: record?.refs.map(refLabel) ?? [], queued: row.queued === true };
  });
  for (const m of sent) {
    if (seen.has(m.messageId.toLowerCase()) || (!m.refIds.length && seenText.has(m.text))) continue;
    const record = byId.get(m.messageId.toLowerCase());
    turns.push({
      key: `s${m.messageId}`,
      who: 'you',
      text: m.text,
      refs: record?.refs.map(refLabel) ?? [],
      queued: false,
    });
  }
  return turns;
}

export type ThreadStatus = { kind: 'ended' | 'waiting' | 'working' | 'idle'; text: string };
/** One calm line: ended beats waiting beats working. */
export function threadStatus(input: { ended: boolean; waiting: boolean; working: boolean }): ThreadStatus {
  if (input.ended) return { kind: 'ended', text: 'Session ended. Start a new conversation to continue.' };
  if (input.waiting) return { kind: 'waiting', text: 'Waiting for you' };
  if (input.working) return { kind: 'working', text: 'Working' };
  return { kind: 'idle', text: '' };
}

/** Why a send did not go, in words for the composer; the server prefixes its refusal with a stable code. */
export function sendFailure(message: string, status: number): { text: string; ended: boolean; fresh: boolean } {
  const code = /^([A-Z_]+):/.exec(message)?.[1] ?? '';
  const plain = (text: string, ended = false, fresh = false) => ({ text, ended, fresh });
  switch (code) {
    case 'SESSION_ENDED':
      return plain('The session has ended. Your message is kept.', true);
    case 'APPROVAL_PENDING':
      return plain('Answer the pending question first. Your message is kept.');
    case 'NOT_DELIVERED':
      return plain('The agent did not take the message. Nothing was sent and your message is kept.');
    case 'BUSY':
      return plain('The last attempt is still being delivered. Try again in a moment.');
    case 'TOO_LARGE':
      return plain('The message and its context are too large to send. Remove some context or shorten it.');
    case 'START_FAILED':
      return plain(`The assistant session could not start. ${message.replace(/^START_FAILED:\s*/, '')}`.trim());
    case 'TOO_MANY':
      return plain('This canvas has too many conversations. Close some sessions first.');
    case 'MESSAGE_CHANGED':
      return plain('That message changed after a failed attempt. Send it again.', false, true);
    default:
      return status === 404
        ? plain('The conversation was not found. Start a new one.', true)
        : plain(message || 'Could not send. Your message is kept.');
  }
}

/** The server's answer envelope: a text error is the message, anything else is empty. */
export function errorMessage(body: unknown): string {
  return typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
    ? body.error
    : '';
}
