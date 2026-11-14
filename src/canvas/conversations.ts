/** @fileoverview Per-workspace index of canvas conversations: which session each one is, and what each message carried. Stores no prompt body and no reply: the session's own transcript is the only history. */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dataPath } from '../config/instance.js';
import { atomicWrite } from './canvas-store.js';
import {
  ConversationsFileSchema,
  MAX_CONVERSATIONS_PER_WORKSPACE,
  MAX_MESSAGES_PER_CONVERSATION,
  type Conversation,
  type ConversationMessage,
  replyExtendable,
  threadReply,
  type ThreadReply,
} from './conversation-schema.js';

export type ConversationFile =
  | { ok: true; conversations: Conversation[]; raw: Record<string, unknown> }
  | { ok: false; reason: 'unreadable' | 'newer' };

export const conversationsPath = (workspaceId: string): string => dataPath('canvas', workspaceId, 'conversations.json');
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Reads the index. A missing file is empty; one that does not parse, or was written by a later release, is reported and never overwritten. */
export function readConversations(workspaceId: string): ConversationFile {
  const path = conversationsPath(workspaceId);
  if (!existsSync(path)) return { ok: true, conversations: [], raw: {} };
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (typeof json === 'object' && json !== null && 'version' in json && json.version !== 1)
    return { ok: false, reason: 'newer' };
  const parsed = ConversationsFileSchema.safeParse(json);
  return parsed.success
    ? { ok: true, conversations: parsed.data.conversations, raw: parsed.data }
    : { ok: false, reason: 'unreadable' };
}
export class ConversationFileError extends Error {
  readonly statusCode = 409;
  constructor(reason: 'unreadable' | 'newer') {
    super(
      reason === 'newer'
        ? 'Conversations were saved by a newer release; nothing was changed'
        : 'The conversations file could not be read; nothing was changed'
    );
  }
}
function mutate<T>(workspaceId: string, change: (list: Conversation[]) => T): T {
  const file = readConversations(workspaceId);
  if (!file.ok) throw new ConversationFileError(file.reason);
  const list = structuredClone(file.conversations);
  const result = change(list);
  atomicWrite(conversationsPath(workspaceId), { ...file.raw, version: 1, conversations: list });
  return result;
}

export const findConversation = (workspaceId: string, id: string): Conversation | undefined => {
  const file = readConversations(workspaceId);
  return file.ok ? file.conversations.find((c) => c.id === id) : undefined;
};

export type CreateResult = { ok: true; conversation: Conversation; duplicate: boolean } | { ok: false; reason: 'FULL' };
/** A retry with the same request id returns the conversation it made; it never starts a second session record. */
export function addConversation(
  workspaceId: string,
  make: () => Pick<Conversation, 'id' | 'sessionId' | 'cliId' | 'createdAt' | 'createdBy'> &
    Pick<Partial<Conversation>, 'model' | 'origin' | 'task'>,
  requestId: string
): CreateResult {
  const existing = readConversations(workspaceId);
  const prior = existing.ok ? existing.conversations.find((c) => c.requestId === requestId) : undefined;
  if (prior) return { ok: true, conversation: prior, duplicate: true };
  return mutate(workspaceId, (list) => {
    if (list.length >= MAX_CONVERSATIONS_PER_WORKSPACE) return { ok: false as const, reason: 'FULL' as const };
    const conversation: Conversation = { ...make(), requestId, messages: [] };
    list.push(conversation);
    return { ok: true as const, conversation, duplicate: false };
  });
}

export type RecordResult =
  | { ok: true; message: ConversationMessage; duplicate: boolean }
  | { ok: false; reason: 'NOT_FOUND' | 'CHANGED' | 'FULL' };
/**
 * Records one outgoing message before it is written to the pane, undelivered. A retry of the same id
 * returns the stored row; one whose text or attachments differ is refused.
 */
export function recordMessage(
  workspaceId: string,
  conversationId: string,
  message: ConversationMessage,
  refIds: readonly string[]
): RecordResult {
  const file = readConversations(workspaceId);
  const prior = file.ok
    ? file.conversations.find((c) => c.id === conversationId)?.messages.find((m) => m.messageId === message.messageId)
    : undefined;
  if (prior) {
    const same = prior.textSha256 === message.textSha256 && prior.namedSha256 === namedHash(refIds);
    return same ? { ok: true, message: prior, duplicate: true } : { ok: false, reason: 'CHANGED' };
  }
  return mutate(workspaceId, (list): RecordResult => {
    const conversation = list.find((c) => c.id === conversationId);
    if (!conversation) return { ok: false, reason: 'NOT_FOUND' };
    if (conversation.messages.length >= MAX_MESSAGES_PER_CONVERSATION) return { ok: false, reason: 'FULL' };
    conversation.messages.push(message);
    return { ok: true, message, duplicate: false };
  });
}
export const namedHash = (ids: readonly string[]): string => sha256([...new Set(ids)].sort().join('\n'));
/**
 * What a sender named, as `namedHash` takes it: the object ids, and one entry per element so a retry that names
 * other elements is a changed message. With no element this is the ids alone, as every earlier record was hashed.
 */
export const namedEntries = (ids: readonly string[], elements: readonly unknown[] = []): string[] => [
  ...ids,
  ...elements.map((element) => `element:${sha256(JSON.stringify(element))}`),
];
export type MessageState = NonNullable<ConversationMessage['state']>;
/** A row from an earlier release carries no state: it was delivered if it has a time, else it was not. */
export const messageState = (m: Pick<ConversationMessage, 'state' | 'deliveredAt'>): MessageState =>
  m.state ?? (m.deliveredAt !== null ? 'delivered' : 'failed');
/** Moves one message to a new state; `deliveredAt` is set only by a confirmed submit. */
export function setMessageState(
  workspaceId: string,
  conversationId: string,
  messageId: string,
  state: MessageState,
  at?: number
): void {
  mutate(workspaceId, (list) => {
    const message = list.find((c) => c.id === conversationId)?.messages.find((m) => m.messageId === messageId);
    if (!message) return;
    message.state = state;
    if (state === 'sending' && message.submittedAt === undefined) message.submittedAt = Date.now();
    if (state === 'delivered' && message.deliveredAt === null) message.deliveredAt = at ?? Date.now();
  });
}
/** A retry wrote the message to the pane again: the turn it starts is no earlier than this write. */
export function setMessageSubmitted(workspaceId: string, conversationId: string, messageId: string, at: number): void {
  mutate(workspaceId, (list) => {
    const message = list.find((c) => c.id === conversationId)?.messages.find((m) => m.messageId === messageId);
    if (message) message.submittedAt = at;
  });
}
/** Records what became of a thread request's reply. A record is replaced only by further progress of the same posted reply. */
export function setMessageReply(
  workspaceId: string,
  conversationId: string,
  messageId: string,
  reply: ThreadReply
): boolean {
  return mutate(workspaceId, (list) => {
    const message = list.find((c) => c.id === conversationId)?.messages.find((m) => m.messageId === messageId);
    if (!message) return false;
    if (message.reply !== undefined) {
      const current = threadReply(message);
      if (!replyExtendable(current) || !('commentId' in reply) || reply.commentId !== current.commentId) return false;
    }
    message.reply = reply;
    return true;
  });
}

/** Merges recorded observations into a task's part (a cancel, an observed turn end, a removal). False when the conversation holds no task part to merge into. */
export function setTaskHint(workspaceId: string, conversationId: string, patch: Record<string, unknown>): boolean {
  return mutate(workspaceId, (list) => {
    const conversation = list.find((c) => c.id === conversationId);
    if (!conversation || typeof conversation.task !== 'object' || conversation.task === null) return false;
    conversation.task = { ...conversation.task, ...patch };
    return true;
  });
}
/** Drops one conversation's record: a task that was removed, or one whose creation failed part-way. */
export function removeConversation(workspaceId: string, conversationId: string): boolean {
  return mutate(workspaceId, (list) => {
    const index = list.findIndex((c) => c.id === conversationId);
    if (index < 0) return false;
    list.splice(index, 1);
    return true;
  });
}
