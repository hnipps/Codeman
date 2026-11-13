/** @fileoverview Pure parts of a canvas background task: the `task` part a conversation record carries, the name a task gets, and the one function that derives its state from evidence the server holds. Shared by the server and the browser; nothing here touches disk, git or a session. */
import { z } from 'zod';
import { IdSchema } from './model.js';
import { MAX_CONTEXT_OBJECTS, ThreadOriginSchema } from './conversation-schema.js';

/** Tasks of one workspace that may be queued, running or waiting at once. */
export const MAX_ACTIVE_TASKS = 4;
export const MAX_TASK_NAME_CHARS = 60;
/** The result text a task list row carries; the whole reply stays in the conversation. */
export const MAX_TASK_RESULT_CHARS = 4000;
export const DEFAULT_TASK_NAME = 'Background task';

export type TaskIsolation = { kind: 'worktree'; name: string; branch: string } | { kind: 'shared' };
/** Why a removed task's worktree is still there: git found changes, a session still runs in it, or the removal failed. */
export type TaskKept = 'changes' | 'in-use' | 'failed';
export type TaskPart = {
  name: string;
  /** The request that created the task; also the conversation's own `requestId`. */
  requestId: string;
  /** The one message the task is: its state and its reply are the task's. */
  messageId: string;
  parentConversationId?: string;
  isolation: TaskIsolation;
  /** Recorded observations; everything else about a task's state is derived when it is read. */
  cancelledAt?: number;
  completedAt?: number;
  removedAt?: number;
  kept?: TaskKept;
};
export type TaskState = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

const at = z.number().int().nonnegative().optional().catch(undefined);
const StoredIsolation = z.union([
  z.object({ kind: z.literal('worktree'), name: z.string().min(1).max(64), branch: z.string().min(1).max(200) }),
  z.object({ kind: z.literal('shared') }),
]);
const StoredTask = z
  .object({
    name: z.string().min(1).max(200),
    requestId: z.uuid(),
    messageId: z.uuid(),
    parentConversationId: z.string().max(128).optional().catch(undefined),
    isolation: StoredIsolation,
    cancelledAt: at,
    completedAt: at,
    removedAt: at,
    kept: z.enum(['changes', 'in-use', 'failed']).optional().catch(undefined),
  })
  .passthrough();
/** The task a conversation is, or undefined for an ordinary conversation and for a shape this release cannot read. */
export function taskPart(source: { task?: unknown }): TaskPart | undefined {
  const parsed = StoredTask.safeParse(source.task);
  if (!parsed.success) return undefined;
  const { name, requestId, messageId, parentConversationId, isolation, cancelledAt, completedAt, removedAt, kept } =
    parsed.data;
  return {
    name,
    requestId,
    messageId,
    ...(parentConversationId ? { parentConversationId } : {}),
    isolation:
      isolation.kind === 'worktree'
        ? { kind: 'worktree', name: isolation.name, branch: isolation.branch }
        : { kind: 'shared' },
    ...(cancelledAt !== undefined ? { cancelledAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(removedAt !== undefined ? { removedAt } : {}),
    ...(kept ? { kept } : {}),
  };
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
export const CreateTaskBodySchema = z
  .object({
    requestId: z.uuid(),
    text: z.string().min(1),
    refIds: z.array(IdSchema).max(MAX_CONTEXT_OBJECTS).default([]),
    name: z
      .string()
      .trim()
      .min(1)
      .max(MAX_TASK_NAME_CHARS)
      .refine((value) => !CONTROL.test(value), 'A task name is printable text')
      .optional(),
    cliId: z.string().min(1).max(64).optional(),
    model: z.string().max(100).optional(),
    /** The person agreed to run in the case folder itself; honoured only where no worktree can be made. */
    shared: z.literal(true).optional(),
    origin: ThreadOriginSchema.optional(),
    parentConversationId: z.uuid().optional(),
  })
  .strict();
export type CreateTaskBody = z.infer<typeof CreateTaskBodySchema>;

/** A task's name when the person gave none: the first words of the request, on one line, cut at a word. */
export function deriveTaskName(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.replace(new RegExp(CONTROL.source, 'g'), ' ').replace(/\s+/g, ' ').trim())
      .find((l) => l.length > 0) ?? '';
  if (!line) return DEFAULT_TASK_NAME;
  const chars = [...line];
  if (chars.length <= MAX_TASK_NAME_CHARS) return line;
  const head = chars.slice(0, MAX_TASK_NAME_CHARS - 1).join('');
  const space = head.lastIndexOf(' ');
  return `${(space >= MAX_TASK_NAME_CHARS / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

export type TaskEvidence = {
  cancelledAt?: number;
  /** Set by the turn-end rule the thread replies use, once two transcript reads agreed. */
  completedAt?: number;
  /** The delivery state of the task's own message; `none` when the record holds no such message. */
  message: 'none' | 'queued' | 'sending' | 'delivered' | 'failed';
  /** `exited`: the agent left its pane; `gone`: the server holds no such session. */
  session: 'live' | 'exited' | 'gone';
  /** A permission or question dialog is pending for the session. */
  approval: boolean;
};
/**
 * One state from what the server holds, first match wins: a recorded cancel, a recorded turn end, then evidence of
 * failure (the message was not delivered or never recorded, the agent exited, the session is gone), then a pending
 * question, then a message still on its way in, and otherwise a delivered request whose turn has not ended.
 */
export function deriveTaskState(e: TaskEvidence): TaskState {
  if (e.cancelledAt !== undefined) return 'cancelled';
  if (e.completedAt !== undefined) return 'completed';
  if (e.message === 'failed' || e.message === 'none') return 'failed';
  if (e.session !== 'live') return 'failed';
  if (e.approval) return 'waiting';
  if (e.message === 'queued' || e.message === 'sending') return 'queued';
  return 'running';
}
export const taskActive = (state: TaskState): boolean =>
  state === 'queued' || state === 'running' || state === 'waiting';

/** Where a task runs, as a label inside the case folder; never a server path. */
export const isolationLabel = (isolation: TaskIsolation): string =>
  isolation.kind === 'worktree' ? `.claude/worktrees/${isolation.name}` : 'Case folder, shared';

/** The result a list row shows, cut without splitting a surrogate pair. */
export function cutResult(text: string, limit = MAX_TASK_RESULT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  let end = limit;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return { text: text.slice(0, end), truncated: true };
}

/** One row of the task list, as the server reports it. */
export type TaskRow = {
  id: string;
  requestId: string;
  name: string;
  sessionId: string;
  cliId: string;
  cliLabel: string;
  model?: string;
  createdAt: number;
  state: TaskState;
  isolation: { kind: TaskIsolation['kind']; label: string; branch?: string };
  /** Present once the task completed and its transcript can still be read. */
  result?: { text: string; truncated: boolean };
  /** The objects the request carried, as recorded when it was sent. */
  refs: { id: string; label: string }[];
  origin?: { objectId: string; commentId: string };
  parentConversationId?: string;
  /** The task was removed and its worktree is still there. */
  kept?: { label: string; reason: TaskKept };
};
