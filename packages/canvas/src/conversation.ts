import {
  splitPrompt,
  threadOrigin,
  type ConversationMessage,
  type ThreadOrigin,
} from '../../../src/canvas/conversation-schema.js';

/** One prompt or reply row as the session's transcript reports it. */
export type TranscriptRow = { role: 'user' | 'assistant'; text: string; queued?: boolean };
/** A message the person sent that the transcript has not shown yet. */
export type SentMessage = { messageId: string; text: string; refIds: string[] };
export type Turn = {
  key: string;
  who: 'you' | 'agent' | 'claude';
  /** The small label: You, Agent or Claude, with a quiet suffix for a queued or unconfirmed message. */
  label: string;
  text: string;
  /** Labels of the objects the message carried, from the recorded manifest, never from the transcript text. */
  refs: string[];
  /** Set for a message the transcript does not hold yet. */
  pending?: 'queued' | 'sending' | 'failed';
  messageId?: string;
  /** Set for a prompt asked from a comment thread: the rail links back to it. */
  origin?: ThreadOrigin;
};
const refLabel = (m: ConversationMessage['refs'][number]): string =>
  m.descendants.length ? `${m.label} +${m.descendants.length}` : m.label;
const stateOf = (m: ConversationMessage): NonNullable<ConversationMessage['state']> =>
  m.state ?? (m.deliveredAt !== null ? 'delivered' : 'failed');
const who = (m: ConversationMessage | undefined): 'you' | 'agent' => (m?.author.kind === 'agent' ? 'agent' : 'you');
const labelFor = (kind: 'you' | 'agent', suffix = ''): string => `${kind === 'agent' ? 'Agent' : 'You'}${suffix}`;

/**
 * The thread is the session's own transcript; the record adds the chips a prompt carried, who sent it, and where a
 * message that has not reached the transcript is (queued, sending, not delivered). Such a message is shown from the
 * text this page still holds, and is replaced the moment its row appears, matched by the message id in its context
 * block, which survives the CLI's own wrapper around a long paste.
 */
export function buildThread(
  rows: readonly TranscriptRow[],
  messages: readonly ConversationMessage[],
  sent: readonly SentMessage[],
  agent = 'Claude'
): Turn[] {
  const byId = new Map(messages.map((m) => [m.messageId.toLowerCase(), m]));
  const seen = new Set<string>();
  const turns: Turn[] = rows.map((row, index): Turn => {
    if (row.role === 'assistant') return { key: `r${index}`, who: 'claude', label: agent, text: row.text, refs: [] };
    const { messageId, text } = splitPrompt(row.text);
    if (messageId) seen.add(messageId.toLowerCase());
    const record = messageId ? byId.get(messageId.toLowerCase()) : undefined;
    const kind = who(record);
    return {
      key: `r${index}`,
      who: kind,
      label: labelFor(kind, row.queued ? ' · queued' : ''),
      text,
      refs: record?.refs.map(refLabel) ?? [],
      ...(record && threadOrigin(record) ? { origin: threadOrigin(record) } : {}),
    };
  });
  const local = new Map(sent.map((m) => [m.messageId.toLowerCase(), m]));
  for (const m of messages) {
    const id = m.messageId.toLowerCase();
    if (seen.has(id)) continue;
    const state = stateOf(m);
    const text = local.get(id)?.text;
    // A delivered message the transcript has not caught up with yet still shows, if this page knows its text.
    if (state === 'delivered' && text === undefined) continue;
    const kind = who(m);
    const word =
      state === 'queued'
        ? ' · Queued'
        : state === 'sending'
          ? ' · Sending'
          : state === 'failed'
            ? ' · Not delivered'
            : '';
    turns.push({
      key: `s${m.messageId}`,
      who: kind,
      label: labelFor(kind, word),
      text: text ?? 'This message was sent from another page; its text is not kept here.',
      refs: m.refs.map(refLabel),
      ...(state === 'delivered' ? {} : { pending: state }),
      messageId: m.messageId,
      ...(threadOrigin(m) ? { origin: threadOrigin(m) } : {}),
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
    case 'TASK_CANCELLED':
      return plain('This task was cancelled. Start a new one.');
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
    case 'CASE_UNSUPPORTED':
      return plain('Conversations are not available for Docker or remote cases yet.');
    case 'RATE_LIMITED':
      return plain('Too many messages in a short time. Your message is kept; try again in a moment.');
    case 'UNKNOWN_CLI':
      return plain('That provider is no longer available. Pick another one; your message is kept.');
    case 'CLI_UNAVAILABLE':
      return plain(
        `${message.replace(/^CLI_UNAVAILABLE:\s*/, '')} Pick another provider; your message is kept.`.trim()
      );
    case 'INVALID_MODEL':
      return plain(`${message.replace(/^INVALID_MODEL:\s*/, '')} Your message is kept.`.trim());
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
