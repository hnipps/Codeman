/**
 * @fileoverview Work items of a canvas workspace: what an item is, the request shapes that change one, and the pure
 * functions every change goes through. Shared by the server and the canvas page; nothing here touches disk.
 *
 * An item is tracked work, separate from background tasks: a key (`W-12`), a title, a status, a description, an
 * assignee (the person, an agent session, or nobody), linked sessions, the item it was created from and a short
 * history. Items live in `work.json` per workspace (`work-store.ts`), never on the board or in the operation log.
 *
 * Statuses follow W-48: Backlog, Needs refinement, Human required, Ready for work, In progress, Done, Not doing, plus
 * Deleted (W-22), a soft delete that keeps the whole item. Only a person moves an item out of Backlog or Deleted (an
 * agent quotes their `instruction`), an agent deletes only with a `reason`, an answered question goes back to Needs
 * refinement, and the order of Ready for work (`readyOrder`, `readyQueue()`) is the pickup order.
 *
 * Nothing changes an item by itself, with two exceptions (W-70): an In progress item whose owner ended without a
 * report is released (`releaseFor()`), and a parent whose tickets are all closed follows them. Every write keeps an In
 * progress item owned (`ownerRefusal()`). `report` is the run-end rule an agent applies to its own work when a run
 * ends (done and verified, keep working, done plus new Backlog items, or ask the person); it is a request the agent
 * makes, and the server only records it.
 */
import { z } from 'zod';
import { RefSchema } from '../reviews/review-model.js';
import { AuthorSchema, IdSchema, type Author } from './model.js';
import { taskActive, type TaskState } from './tasks.js';

export type WorkAssignee = { kind: 'person' } | { kind: 'session'; sessionId: string };

/**
 * Board order. Needs refinement, Human required and Ready for work replaced Todo (W-48): Needs refinement is the
 * intake queue that pickup routines ignore, Human required waits for a person (a question in `needs`, or work only a
 * person can do), Ready for work is what an agent may pick up, top first. This is every status but Deleted: what an
 * item is created in, what a deleted item came from, and all a routine trigger or gate may name, so `routines.json`
 * never holds a value the release before W-22 refuses.
 */
export const NOT_DELETED_STATUSES = [
  'backlog',
  'needs-refinement',
  'human-required',
  'ready-for-work',
  'in-progress',
  'done',
  'not-doing',
] as const;
export const NotDeletedStatusSchema = z.enum(NOT_DELETED_STATUSES);
/** Deleted (W-22) comes last: a soft delete, hidden unless asked for. */
export const WORK_STATUSES = [...NOT_DELETED_STATUSES, 'deleted'] as const;
export const WorkStatusSchema = z.enum(WORK_STATUSES);
export type WorkStatus = z.infer<typeof WorkStatusSchema>;
export const WORK_STATUS_NAMES: Record<WorkStatus, string> = {
  backlog: 'Backlog',
  'needs-refinement': 'Needs refinement',
  'human-required': 'Human required',
  'ready-for-work': 'Ready for work',
  'in-progress': 'In progress',
  done: 'Done',
  'not-doing': 'Not doing',
  deleted: 'Deleted',
};
/**
 * The three statuses that replaced Todo. On disk they are `status: "todo"` plus `todoStatus`, so the release before
 * W-48, which knows only the five old statuses and refuses a whole file over one unknown value, still reads the file
 * (self-building rule 5). Only `decodeWorkFile`/`encodeWorkFile` see that form.
 */
export const TODO_STATUSES = ['needs-refinement', 'human-required', 'ready-for-work'] as const;
type TodoStatus = (typeof TODO_STATUSES)[number];
const STORED_STATUSES = ['backlog', 'todo', 'in-progress', 'done', 'not-doing'] as const;
const isTodoStatus = (status: WorkStatus): status is TodoStatus =>
  (TODO_STATUSES as readonly string[]).includes(status);
/**
 * Where a Todo item from before the split goes: assigned to the person, Human required; unassigned, or assigned to a
 * session (the assignee is kept), Needs refinement.
 */
export const migrateTodo = (assignee: WorkAssignee | null): TodoStatus =>
  assignee?.kind === 'person' ? 'human-required' : 'needs-refinement';
/** Done, Not doing and Deleted: the item is closed and its lane is quiet. */
export const workClosed = (status: WorkStatus): boolean =>
  status === 'done' || status === 'not-doing' || status === 'deleted';

export const MAX_WORK_ITEMS = 2000;
export const MAX_WORK_TITLE_CHARS = 200;
export const MAX_WORK_DESCRIPTION_CHARS = 8000;
export const MAX_WORK_NOTE_CHARS = 2000;
export const MAX_LINKED_SESSIONS = 16;
export const MAX_WORK_HISTORY = 50;
/** New Backlog items one `split` report may file. */
export const MAX_FILED_ITEMS = 10;
/** The person's instruction an agent quotes to move an item out of Backlog. */
export const MAX_INSTRUCTION_CHARS = 300;
/** Why an item was deleted; an agent must give one. */
export const MAX_DELETE_REASON_CHARS = 300;
export const MAX_PR_URL_CHARS = 300;
/** The reviewer's notes an item carries back to the agent that picks it up next. */
export const MAX_CHANGES_CHARS = 16_000;
/** Files one item may carry; their bytes live beside `work.json` (`work-files.ts`). */
export const MAX_WORK_ATTACHMENTS = 20;
export const MAX_ATTACHMENT_NAME_CHARS = 200;
/**
 * The type each attachable extension is stored as. `work-files.ts` admits only these (and only the ones the prompt
 * uploads also admit); the page offers the same extensions in its file picker.
 */
export const WORK_FILE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.log': 'text/plain',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.xml': 'application/xml',
};
/** Comments one item's thread holds; a full thread refuses a new one and never drops the oldest. */
export const MAX_WORK_COMMENTS = 200;

export const workKey = (number: number): string => `W-${number}`;
/** `W-12`, `w-12` or `12`; anything else is not a key. */
export function parseWorkKey(key: string): number | null {
  const match = /^(?:[wW]-)?([1-9][0-9]{0,8})$/.exec(key.trim());
  return match ? Number(match[1]) : null;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const LINE_BREAKS = /[\r\n\t]/g;
/** One line of printable text: control characters and runs of white space become one space. */
export const workLine = (text: string): string =>
  text.replace(LINE_BREAKS, ' ').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
/** Text that may keep its line breaks: other control characters go, `\r\n` becomes `\n`. */
export const workText = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(CONTROL, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const Title = z.string().transform(workLine).pipe(z.string().min(1, 'A title is needed').max(MAX_WORK_TITLE_CHARS));
const Description = z.string().transform(workText).pipe(z.string().max(MAX_WORK_DESCRIPTION_CHARS));
const Note = z.string().transform(workText).pipe(z.string().min(1).max(MAX_WORK_NOTE_CHARS));
/** The person's words, quoted by an agent that moves an item out of Backlog. */
const Instruction = z.string().transform(workLine).pipe(z.string().min(1).max(MAX_INSTRUCTION_CHARS));
const Reason = z.string().transform(workLine).pipe(z.string().min(1).max(MAX_DELETE_REASON_CHARS));
const Key = z.union([z.string().max(16), z.number().int()]).transform((value, ctx) => {
  const n = typeof value === 'number' ? (value > 0 ? value : null) : parseWorkKey(value);
  if (n === null) {
    ctx.addIssue({ code: 'custom', message: 'A work key looks like W-12' });
    return z.NEVER;
  }
  return n;
});

const AssigneeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('person') }).strict(),
  z.object({ kind: z.literal('session'), sessionId: IdSchema }).strict(),
]);

/** True for an `https:` address and nothing else, so a link built from it can never run script. */
export function isHttpsUrl(text: string): boolean {
  if (text.length > MAX_PR_URL_CHARS) return false;
  try {
    return new URL(text).protocol === 'https:';
  } catch {
    return false;
  }
}
const PrUrl = z.string().trim().refine(isHttpsUrl, 'A pull request link is an https address of at most 300 characters');
/**
 * The pull request that carries an item's work. `url` is a link for people and nothing parses it; `branch` is the head
 * branch on `origin`, which is what a review reads, so an item without it shows the link and has no review; `base` is
 * the branch it merges into, the repository's default when absent.
 */
const WorkPrSchema = z.object({ url: PrUrl, branch: RefSchema.optional(), base: RefSchema.optional() }).strict();
export type WorkPr = z.infer<typeof WorkPrSchema>;
/** What the API takes: the full shape, or a bare https address as `{ url }`. */
const WorkPrInput = z.union([PrUrl.transform((url): WorkPr => ({ url })), WorkPrSchema]);

const at = z.number().int().nonnegative();
/** The person's review notes, delivered to the item. Cleared by the next report on the item. */
const WorkChangesSchema = z
  .object({ text: z.string().min(1).max(MAX_CHANGES_CHARS), reviewId: z.string().max(40), at })
  .passthrough();
export type WorkChanges = z.infer<typeof WorkChangesSchema>;
/**
 * A file attached to an item. `id` names the stored bytes and is the only thing a request uses to reach them; `name`
 * is the person's file name, shown and never used as a path; `type` is the MIME type its extension and bytes proved.
 */
const WorkFileAttachmentSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{32}$/),
    name: z.string().min(1).max(MAX_ATTACHMENT_NAME_CHARS),
    type: z.string().min(1).max(100),
    size: z.number().int().nonnegative(),
    at,
  })
  .passthrough();
export type WorkFileAttachment = z.infer<typeof WorkFileAttachmentSchema>;
/** A canvas object of the item's own workspace, by id. It may be deleted since; readers show it as missing. */
const WorkObjectAttachmentSchema = z.object({ kind: z.literal('object'), id: IdSchema, at }).passthrough();
export type WorkObjectAttachment = z.infer<typeof WorkObjectAttachmentSchema>;
export const WorkAttachmentSchema = z.union([WorkObjectAttachmentSchema, WorkFileAttachmentSchema]);
export type WorkAttachment = WorkFileAttachment | WorkObjectAttachment;
export const isObjectAttachment = (a: WorkAttachment): a is WorkObjectAttachment => a.kind === 'object';
export const workFiles = (item: { attachments?: WorkAttachment[] }): WorkFileAttachment[] =>
  (item.attachments ?? []).filter((a): a is WorkFileAttachment => !isObjectAttachment(a));
export const workObjects = (item: { attachments?: WorkAttachment[] }): WorkObjectAttachment[] =>
  (item.attachments ?? []).filter(isObjectAttachment);
/**
 * Who deleted the item, when, from which status and why. On disk a Deleted item is `status: "not-doing"` plus this
 * record, so the release before W-22 reads it as Not doing (self-building rule 5).
 */
const WorkDeletedSchema = z
  .object({
    at,
    from: NotDeletedStatusSchema,
    author: AuthorSchema,
    reason: z.string().min(1).max(MAX_DELETE_REASON_CHARS).optional(),
  })
  .passthrough();
export type WorkDeleted = z.infer<typeof WorkDeletedSchema>;
const StoredEvent = z.object({ at, author: AuthorSchema, text: z.string().max(400) }).passthrough();
const StoredComment = z
  .object({ at, author: AuthorSchema, text: z.string().min(1).max(MAX_WORK_NOTE_CHARS) })
  .passthrough();
const itemFields = {
  number: z.number().int().positive(),
  title: z.string().min(1).max(MAX_WORK_TITLE_CHARS),
  description: z.string().max(MAX_WORK_DESCRIPTION_CHARS).catch(''),
  assignee: AssigneeSchema.nullable().catch(null),
  sessions: z.array(IdSchema).max(MAX_LINKED_SESSIONS).catch([]),
  createdFrom: z.number().int().positive().optional().catch(undefined),
  requestId: z.uuid().optional().catch(undefined),
  pr: WorkPrSchema.optional().catch(undefined),
  changes: WorkChangesSchema.optional().catch(undefined),
  // Entry by entry: one record that does not parse is dropped alone, so a write never loses the others.
  attachments: z
    .array(z.unknown())
    .max(MAX_WORK_ITEMS)
    .transform((list) => list.flatMap((entry) => WorkAttachmentSchema.safeParse(entry).data ?? []))
    .transform((list) => (list.length ? list : undefined))
    .optional()
    .catch(undefined),
  author: AuthorSchema,
  createdAt: at,
  updatedAt: at,
  revision: z.number().int().positive(),
  needs: z
    .object({ question: z.string().min(1).max(MAX_WORK_NOTE_CHARS), sessionId: IdSchema.optional(), at })
    .passthrough()
    .optional()
    .catch(undefined),
  outcome: z
    .object({
      kind: z.enum(['done', 'continue', 'split']),
      text: z.string().min(1).max(MAX_WORK_NOTE_CHARS),
      sessionId: IdSchema.optional(),
      at,
    })
    .passthrough()
    .optional()
    .catch(undefined),
  history: z.array(StoredEvent).max(MAX_WORK_HISTORY).catch([]),
  comments: z.array(StoredComment).max(MAX_WORK_COMMENTS).catch([]),
  /** Present exactly when the item is Deleted. */
  deleted: WorkDeletedSchema.optional().catch(undefined),
};
/** An item as `work.json` holds it: the old five statuses, `todoStatus` naming which of the three a Todo is. */
const StoredItem = z
  .object({
    ...itemFields,
    status: z.enum(STORED_STATUSES),
    todoStatus: z.enum(TODO_STATUSES).optional().catch(undefined),
  })
  .passthrough();
/** An item as every reader above the store sees it: one of the eight statuses. */
const Item = z.object({ ...itemFields, status: WorkStatusSchema }).passthrough();
export type WorkItem = z.infer<typeof Item>;
export type WorkEvent = WorkItem['history'][number];
export type WorkComment = WorkItem['comments'][number];
type FileFields = { version: 1; next: number; items: WorkItem[]; readyOrder: number[] };
export type WorkFile = FileFields & { [key: string]: unknown };

/** The order of Ready for work as stored, cleaned: only items in that lane, once each, missing ones at the bottom. */
function normalizeReady(file: WorkFile): void {
  const ready = new Set(file.items.filter((i) => i.status === 'ready-for-work').map((i) => i.number));
  const order = [...new Set(file.readyOrder)].filter((n) => ready.has(n));
  for (const n of [...ready].sort((x, y) => x - y)) if (!order.includes(n)) order.push(n);
  file.readyOrder = order;
}

/**
 * `work.json`, decoded: Todo items take their `todoStatus`, or the migration rule when they have none (W-48), a Not
 * doing item with a `deleted` record is Deleted (W-22), and `readyOrder` is cleaned. A `deleted` record on any other
 * stored status is stale: the release before W-22 moved the item, which restores it, so the record is dropped and the
 * next write leaves it out. Unknown keys of the file and of each item are kept on every write.
 */
export const WorkFileSchema = z
  .object({
    version: z.literal(1),
    next: z.number().int().positive(),
    items: z.array(StoredItem).max(MAX_WORK_ITEMS),
    readyOrder: z.array(z.number().int().positive()).max(MAX_WORK_ITEMS).catch([]).optional(),
  })
  .passthrough()
  .transform((stored): WorkFile => {
    const items = stored.items.map(({ status, todoStatus, deleted, ...rest }) => {
      if (status === 'not-doing' && deleted) return { ...rest, status: 'deleted', deleted } as WorkItem;
      const decoded: WorkStatus = status === 'todo' ? (todoStatus ?? migrateTodo(rest.assignee)) : status;
      return { ...rest, status: decoded } as WorkItem;
    });
    const file = { ...stored, items, readyOrder: stored.readyOrder ?? [] } as WorkFile;
    normalizeReady(file);
    return file;
  });
/**
 * The form written to disk: the three statuses that replaced Todo go back to `status: "todo"` plus `todoStatus`, and
 * Deleted to `status: "not-doing"` plus its `deleted` record. No other item carries `deleted`.
 */
export function encodeWorkFile(file: WorkFile): unknown {
  return {
    ...file,
    items: file.items.map((item) => {
      const { todoStatus: _stale, deleted, ...rest } = item as WorkItem & { todoStatus?: unknown };
      void _stale;
      if (item.status === 'deleted') return { ...rest, status: 'not-doing', deleted };
      return isTodoStatus(item.status) ? { ...rest, status: 'todo', todoStatus: item.status } : rest;
    }),
  };
}
export const emptyWorkFile = (): WorkFile => ({ version: 1, next: 1, items: [], readyOrder: [] });

/** Ready for work in pickup order, top first. Pickup routines take from here and nowhere else. */
export function readyQueue(file: WorkFile): WorkItem[] {
  return file.readyOrder.flatMap((n) => {
    const item = findWork(file, n);
    return item && item.status === 'ready-for-work' ? [item] : [];
  });
}
/** An item's place in Ready for work, 1 at the top; null outside that lane. */
export function workPosition(file: WorkFile, number: number): number | null {
  const at = readyQueue(file).findIndex((i) => i.number === number);
  return at === -1 ? null : at + 1;
}

// ---- Requests -------------------------------------------------------------

/** `sessionId: "me"` names the calling agent's own session. */
const AssigneeInput = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('person') }).strict(),
    z.object({ kind: z.literal('session'), sessionId: IdSchema }).strict(),
  ])
  .nullable();
export const CreateWorkSchema = z
  .object({
    /** The same id returns the item it made the first time, so a retry never files twice. */
    requestId: z.uuid().optional(),
    title: Title,
    /** An item is never created Deleted. */
    status: NotDeletedStatusSchema.default('backlog'),
    description: Description.optional(),
    assignee: AssigneeInput.optional(),
    sessions: z.array(IdSchema).max(MAX_LINKED_SESSIONS).optional(),
    createdFrom: Key.optional(),
    pr: WorkPrInput.optional(),
  })
  .strict();
export type CreateWork = z.infer<typeof CreateWorkSchema>;
export const UpdateWorkSchema = z
  .object({
    /** Refused with CONFLICT when the item has changed since this revision was read. */
    expectedRevision: z.number().int().positive().optional(),
    title: Title.optional(),
    status: WorkStatusSchema.optional(),
    description: Description.optional(),
    assignee: AssigneeInput.optional(),
    linkSessions: z.array(IdSchema).max(MAX_LINKED_SESSIONS).optional(),
    unlinkSessions: z.array(IdSchema).max(MAX_LINKED_SESSIONS).optional(),
    /**
     * `null`: the question was answered. A Human required item then goes back to Needs refinement, never straight
     * to Ready for work. A question is asked only through a report.
     */
    needs: z.null().optional(),
    /** Place in Ready for work, 1 at the top; the item is in that lane or moves into it in this call. */
    position: z.number().int().positive().optional(),
    /** An agent moving an item out of Backlog or Deleted quotes the person's instruction to do so; refused without it. */
    instruction: Instruction.optional(),
    /** Why the item is being deleted; only with `status: "deleted"`, and an agent must give it. */
    reason: Reason.optional(),
    /** The item's pull request; `null` clears it. */
    pr: WorkPrInput.nullable().optional(),
    /** Canvas objects of this workspace to reference from the item; each must exist when attached. */
    attachObjects: z.array(IdSchema).min(1).max(MAX_WORK_ATTACHMENTS).optional(),
    /** Object references to take off the item; a deleted object's reference can still be removed. */
    detachObjects: z.array(IdSchema).min(1).max(MAX_WORK_ATTACHMENTS).optional(),
  })
  .strict();
export type UpdateWork = z.infer<typeof UpdateWorkSchema>;
export const WORK_OUTCOMES = ['done', 'continue', 'split', 'ask'] as const;
export type WorkOutcomeKind = (typeof WORK_OUTCOMES)[number];
export const ReportWorkSchema = z
  .object({
    outcome: z.enum(WORK_OUTCOMES),
    /** What was verified and how, what is left, or why the agent is unsure. */
    note: Note,
    question: Note.optional(),
    newItems: z
      .array(z.object({ title: Title, description: Description.optional() }).strict())
      .max(MAX_FILED_ITEMS)
      .optional(),
    /** As for an update: an agent's report that moves an item out of Backlog or Deleted quotes the person's instruction. */
    instruction: Instruction.optional(),
    expectedRevision: z.number().int().positive().optional(),
  })
  .strict();
export type ReportWork = z.infer<typeof ReportWorkSchema>;
export const CommentWorkSchema = z.object({ text: Note }).strict();

/** The `canvas_work` tool. */
export const WorkToolSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), status: WorkStatusSchema.optional() }).strict(),
  z.object({ action: z.literal('read'), key: Key }).strict(),
  CreateWorkSchema.extend({ action: z.literal('create') }).strict(),
  UpdateWorkSchema.extend({ action: z.literal('update'), key: Key }).strict(),
  ReportWorkSchema.extend({ action: z.literal('report'), key: Key }).strict(),
  CommentWorkSchema.extend({ action: z.literal('comment'), key: Key }).strict(),
]);
export type WorkTool = z.infer<typeof WorkToolSchema>;

// ---- Changes --------------------------------------------------------------

export type WorkRefusal = {
  ok: false;
  code: 'NOT_FOUND' | 'CONFLICT' | 'FULL' | 'INVALID_INPUT';
  message: string;
};
export type WorkChange = { ok: true; file: WorkFile; item: WorkItem; filed: WorkItem[]; duplicate: boolean };
const refuse = (code: WorkRefusal['code'], message: string): WorkRefusal => ({ ok: false, code, message });

/** Resolved assignees and session ids: the caller checked that every session exists and may be seen. */
export type WorkContext = { author: Author; now: number };

function log(item: WorkItem, ctx: WorkContext, text: string): void {
  item.history = [{ at: ctx.now, author: ctx.author, text: workLine(text).slice(0, 400) }, ...item.history].slice(
    0,
    MAX_WORK_HISTORY
  );
}
const sameAssignee = (a: WorkAssignee | null, b: WorkAssignee | null): boolean =>
  a === b || (!!a && !!b && a.kind === b.kind && (a.kind !== 'session' || a.sessionId === (b as typeof a).sessionId));
function link(item: WorkItem, ids: readonly string[]): string | null {
  const next = [...new Set([...item.sessions, ...ids])];
  if (next.length > MAX_LINKED_SESSIONS) return `An item links at most ${MAX_LINKED_SESSIONS} sessions`;
  item.sessions = next;
  return null;
}
const describeAssignee = (a: WorkAssignee | null): string =>
  a === null ? 'Unassigned' : a.kind === 'person' ? 'Assigned to the person' : `Assigned to session ${a.sessionId}`;
const samePr = (a: WorkPr | undefined, b: WorkPr): boolean =>
  !!a && a.url === b.url && a.branch === b.branch && a.base === b.base;
function touch(item: WorkItem, ctx: WorkContext): void {
  item.updatedAt = ctx.now;
  item.revision += 1;
}

/**
 * The items of one lane in the order they are taken, first first: Ready for work in its queue order (`readyQueue`,
 * the pickup order a person sets), every other lane by item number. The one place a reader of lane order asks.
 */
export function laneOrder(file: WorkFile, status: WorkStatus): WorkItem[] {
  if (status === 'ready-for-work') return readyQueue(file);
  return file.items.filter((i) => i.status === status).sort((a, b) => a.number - b.number);
}

export function findWork(file: WorkFile, number: number): WorkItem | undefined {
  return file.items.find((i) => i.number === number);
}

/** The statuses only a person moves an item out of: an agent may when it quotes the person's instruction. */
const personOnlyExit = (status: WorkStatus): boolean => status === 'backlog' || status === 'deleted';
/**
 * Only a person moves an item out of Backlog or Deleted; an agent may when it quotes the person's instruction.
 * Deleting is not that move: an agent may delete a Backlog item, with a reason.
 */
function backlogRefusal(item: WorkItem, to: WorkStatus, ctx: WorkContext, instruction?: string): WorkRefusal | null {
  if (ctx.author.kind !== 'agent' || !personOnlyExit(item.status) || to === item.status || instruction) return null;
  if (item.status === 'backlog' && to === 'deleted') return null;
  return refuse(
    'INVALID_INPUT',
    `Only a person moves ${workKey(item.number)} out of ${WORK_STATUS_NAMES[item.status]}. Ask them; if they told you to, quote their words in instruction`
  );
}
/**
 * Moves an item and logs `Moved from <A> to <B>` (routines read when an item entered a status from that event). An
 * agent's move out of Backlog or Deleted also logs the instruction it quoted. An item entering Ready for work goes to
 * the bottom. Moving into Deleted records who, when, from where and why; moving out of it drops that record.
 */
function setStatus(
  file: WorkFile,
  item: WorkItem,
  to: WorkStatus,
  ctx: WorkContext,
  instruction?: string,
  reason?: string
): void {
  log(item, ctx, `Moved from ${WORK_STATUS_NAMES[item.status]} to ${WORK_STATUS_NAMES[to]}`);
  if (personOnlyExit(item.status) && to !== 'deleted' && ctx.author.kind === 'agent' && instruction)
    log(item, ctx, `Moved out of ${WORK_STATUS_NAMES[item.status]} on the person's instruction: "${instruction}"`);
  if (to === 'deleted' && item.status !== 'deleted') {
    item.deleted = { at: ctx.now, from: item.status, author: ctx.author, ...(reason ? { reason } : {}) };
    log(item, ctx, reason ? `Deleted: "${reason}"` : 'Deleted');
  } else if (to !== 'deleted') delete item.deleted;
  item.status = to;
  file.readyOrder = file.readyOrder.filter((n) => n !== item.number);
  if (to === 'ready-for-work') file.readyOrder.push(item.number);
}
/** Puts a Ready for work item at `position` (1 is the top, past the end is the bottom); true when it moved. */
function place(file: WorkFile, item: WorkItem, position: number, ctx: WorkContext): boolean {
  const order = file.readyOrder.filter((n) => n !== item.number);
  const at = Math.min(position, order.length + 1) - 1;
  if (file.readyOrder.indexOf(item.number) === at) return false;
  order.splice(at, 0, item.number);
  file.readyOrder = order;
  log(item, ctx, `Moved to position ${at + 1} in Ready for work`);
  return true;
}

function newItem(
  file: WorkFile,
  ctx: WorkContext,
  fields: Pick<WorkItem, 'title' | 'status' | 'description' | 'assignee' | 'sessions'> & {
    createdFrom?: number;
    requestId?: string;
    pr?: WorkPr;
  },
  firstEvent: string
): WorkItem {
  const item: WorkItem = {
    number: file.next,
    title: fields.title,
    status: fields.status,
    description: fields.description,
    assignee: fields.assignee,
    sessions: fields.sessions,
    ...(fields.createdFrom !== undefined ? { createdFrom: fields.createdFrom } : {}),
    ...(fields.requestId ? { requestId: fields.requestId } : {}),
    ...(fields.pr ? { pr: fields.pr } : {}),
    author: ctx.author,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    revision: 1,
    history: [],
    comments: [],
  };
  log(item, ctx, firstEvent);
  if (fields.pr) log(item, ctx, `Linked PR ${fields.pr.url}`);
  file.next += 1;
  file.items.push(item);
  if (item.status === 'ready-for-work') file.readyOrder.push(item.number);
  return item;
}

/** A new item. `input.assignee`'s session is already resolved (no `"me"`); the item's sessions include it. */
export function createWork(file: WorkFile, input: CreateWork, ctx: WorkContext): WorkChange | WorkRefusal {
  if (input.requestId) {
    const made = file.items.find((i) => i.requestId === input.requestId);
    if (made) return { ok: true, file, item: made, filed: [], duplicate: true };
  }
  if (file.items.length >= MAX_WORK_ITEMS) return refuse('FULL', `A canvas keeps at most ${MAX_WORK_ITEMS} items`);
  if (input.createdFrom !== undefined && !findWork(file, input.createdFrom))
    return refuse('NOT_FOUND', `${workKey(input.createdFrom)} does not exist`);
  const next = structuredClone(file);
  const assignee = input.assignee ?? null;
  const sessions = [
    ...new Set([...(input.sessions ?? []), ...(assignee?.kind === 'session' ? [assignee.sessionId] : [])]),
  ];
  if (sessions.length > MAX_LINKED_SESSIONS)
    return refuse('INVALID_INPUT', `An item links at most ${MAX_LINKED_SESSIONS} sessions`);
  const item = newItem(
    next,
    ctx,
    {
      title: input.title,
      status: input.status,
      description: input.description ?? '',
      assignee,
      sessions,
      createdFrom: input.createdFrom,
      requestId: input.requestId,
      pr: input.pr,
    },
    input.createdFrom !== undefined
      ? `Created from ${workKey(input.createdFrom)} in ${WORK_STATUS_NAMES[input.status]}`
      : `Created in ${WORK_STATUS_NAMES[input.status]}`
  );
  const unowned = ownerRefusal(next, item, ctx, true);
  if (unowned) return unowned;
  return { ok: true, file: next, item, filed: [], duplicate: false };
}

/** Why the item cannot be changed, or null when it can. */
function unchangeable(file: WorkFile, number: number, expected: number | undefined): WorkRefusal | null {
  const item = findWork(file, number);
  if (!item) return refuse('NOT_FOUND', `${workKey(number)} does not exist`);
  if (expected !== undefined && expected !== item.revision)
    return refuse('CONFLICT', `${workKey(number)} changed since revision ${expected}; read it again`);
  return null;
}

/** Changes one item. Sessions named here are already resolved and checked by the caller. */
export function updateWork(
  file: WorkFile,
  number: number,
  patch: UpdateWork,
  ctx: WorkContext
): WorkChange | WorkRefusal {
  const refused = unchangeable(file, number, patch.expectedRevision);
  if (refused) return refused;
  const next = structuredClone(file);
  const item = findWork(next, number)!;
  let changed = false;
  if (patch.title !== undefined && patch.title !== item.title) {
    item.title = patch.title;
    log(item, ctx, 'Renamed');
    changed = true;
  }
  if (patch.description !== undefined && patch.description !== item.description) {
    item.description = patch.description;
    log(item, ctx, 'Edited the description');
    changed = true;
  }
  const answering = patch.needs === null && !!item.needs;
  // An answered question sends a Human required item back to Needs refinement, so readiness is checked again.
  const to = patch.status ?? (answering && item.status === 'human-required' ? 'needs-refinement' : undefined);
  if (answering && to === 'ready-for-work')
    return refuse(
      'INVALID_INPUT',
      'An answered question goes back to Needs refinement, not straight to Ready for work; move it on in another change'
    );
  if (to === 'ready-for-work' && item.status !== 'ready-for-work' && item.needs)
    return refuse(
      'INVALID_INPUT',
      `${workKey(number)} has an open question; mark it answered, which sends it to Needs refinement, first`
    );
  if (patch.position !== undefined && (to ?? item.status) !== 'ready-for-work')
    return refuse('INVALID_INPUT', 'position is a place in Ready for work; the item is not in that lane');
  const deleting = to === 'deleted' && item.status !== 'deleted';
  if (patch.reason !== undefined && !deleting)
    return refuse('INVALID_INPUT', 'reason says why an item is deleted; send it with status deleted');
  if (deleting && ctx.author.kind === 'agent' && !patch.reason)
    return refuse('INVALID_INPUT', `Say why you are deleting ${workKey(number)} in reason`);
  const enteringInProgress = to === 'in-progress' && item.status !== 'in-progress';
  if (to !== undefined && to !== item.status) {
    const refused = backlogRefusal(item, to, ctx, patch.instruction);
    if (refused) return refused;
    setStatus(next, item, to, ctx, patch.instruction, patch.reason);
    changed = true;
  }
  if (patch.assignee !== undefined && !sameAssignee(item.assignee, patch.assignee)) {
    item.assignee = patch.assignee;
    if (patch.assignee?.kind === 'session') {
      const failed = link(item, [patch.assignee.sessionId]);
      if (failed) return refuse('INVALID_INPUT', failed);
    }
    log(item, ctx, describeAssignee(patch.assignee));
    changed = true;
  }
  const adding = (patch.linkSessions ?? []).filter((id) => !item.sessions.includes(id));
  if (adding.length) {
    const failed = link(item, adding);
    if (failed) return refuse('INVALID_INPUT', failed);
    log(item, ctx, `Linked ${adding.length === 1 ? `session ${adding[0]}` : `${adding.length} sessions`}`);
    changed = true;
  }
  const removing = (patch.unlinkSessions ?? []).filter((id) => item.sessions.includes(id));
  if (removing.length) {
    item.sessions = item.sessions.filter((id) => !removing.includes(id));
    if (item.assignee?.kind === 'session' && removing.includes(item.assignee.sessionId)) item.assignee = null;
    log(item, ctx, `Unlinked ${removing.length === 1 ? `session ${removing[0]}` : `${removing.length} sessions`}`);
    changed = true;
  }
  if (answering) {
    delete item.needs;
    log(item, ctx, 'Marked the question answered');
    changed = true;
  }
  if (patch.position !== undefined && place(next, item, patch.position, ctx)) changed = true;
  if (patch.pr === null && item.pr) {
    delete item.pr;
    log(item, ctx, 'Unlinked PR');
    changed = true;
  } else if (patch.pr && !samePr(item.pr, patch.pr)) {
    item.pr = patch.pr;
    log(item, ctx, `Linked PR ${patch.pr.url}`);
    changed = true;
  }
  const held = new Set(workObjects(item).map((a) => a.id));
  const attaching = [...new Set(patch.attachObjects ?? [])].filter((id) => !held.has(id));
  if (attaching.length) {
    if ((item.attachments ?? []).length + attaching.length > MAX_WORK_ATTACHMENTS)
      return refuse('FULL', `An item carries at most ${MAX_WORK_ATTACHMENTS} attachments`);
    item.attachments = [
      ...(item.attachments ?? []),
      ...attaching.map((id): WorkObjectAttachment => ({ kind: 'object', id, at: ctx.now })),
    ];
    log(item, ctx, `Attached ${attaching.length === 1 ? `object ${attaching[0]}` : `${attaching.length} objects`}`);
    changed = true;
  }
  const detaching = (patch.detachObjects ?? []).filter((id) => held.has(id));
  if (detaching.length) {
    const left = item.attachments!.filter((a) => !isObjectAttachment(a) || !detaching.includes(a.id));
    if (left.length) item.attachments = left;
    else delete item.attachments;
    log(item, ctx, `Removed ${detaching.length === 1 ? `object ${detaching[0]}` : `${detaching.length} objects`}`);
    changed = true;
  }
  if (!changed) return { ok: true, file, item: findWork(file, number)!, filed: [], duplicate: false };
  const unowned = ownerRefusal(next, item, ctx, enteringInProgress);
  if (unowned) return unowned;
  touch(item, ctx);
  return { ok: true, file: next, item, filed: [], duplicate: false };
}

/**
 * The run-end rule, as the agent decided it. `done`: verified, moves to Done. `continue`: not done or not verified,
 * stays where it is with a note. `split`: done and verified, with unrelated work found: moves to Done and files each
 * of `newItems` in Backlog, created from this item. `ask`: unsure: records the question, which shows as Needs you,
 * and moves the item to Human required. A report that moves an item out of Backlog needs the person's instruction.
 * The reporting session is linked to the item. A report changes nothing else.
 */
export function reportWork(
  file: WorkFile,
  number: number,
  report: ReportWork,
  ctx: WorkContext
): WorkChange | WorkRefusal {
  const refused = unchangeable(file, number, report.expectedRevision);
  if (refused) return refused;
  if (report.outcome === 'split' && !report.newItems?.length)
    return refuse('INVALID_INPUT', 'A split report files at least one new item (newItems)');
  if (report.outcome !== 'split' && report.newItems?.length)
    return refuse('INVALID_INPUT', 'Only a split report files new items');
  if (report.outcome === 'ask' && !report.question)
    return refuse('INVALID_INPUT', 'An ask report carries the question for the person (question)');
  if (file.items.length + (report.newItems?.length ?? 0) > MAX_WORK_ITEMS)
    return refuse('FULL', `A canvas keeps at most ${MAX_WORK_ITEMS} items`);
  const moves = report.outcome === 'continue' ? null : report.outcome === 'ask' ? 'human-required' : 'done';
  if (moves) {
    const refused = backlogRefusal(findWork(file, number)!, moves, ctx, report.instruction);
    if (refused) return refused;
  }
  const next = structuredClone(file);
  const item = findWork(next, number)!;
  const sessionId = ctx.author.kind === 'agent' ? ctx.author.sessionId : undefined;
  if (sessionId && !item.sessions.includes(sessionId)) {
    const failed = link(item, [sessionId]);
    if (failed) return refuse('INVALID_INPUT', failed);
  }
  // The report answers the review notes it was picked up with; the review itself reads the new tip from origin.
  delete item.changes;
  const filed: WorkItem[] = [];
  const moveTo = (to: WorkStatus): void => {
    if (item.status !== to) setStatus(next, item, to, ctx, report.instruction);
  };
  const toDone = (): void => moveTo('done');
  switch (report.outcome) {
    case 'done':
      toDone();
      delete item.needs;
      item.outcome = { kind: 'done', text: report.note, ...(sessionId ? { sessionId } : {}), at: ctx.now };
      log(item, ctx, 'Reported done and verified');
      break;
    case 'continue':
      delete item.needs;
      item.outcome = { kind: 'continue', text: report.note, ...(sessionId ? { sessionId } : {}), at: ctx.now };
      log(item, ctx, 'Reported not done yet and kept working');
      break;
    case 'split': {
      for (const fresh of report.newItems!)
        filed.push(
          newItem(
            next,
            ctx,
            {
              title: fresh.title,
              status: 'backlog',
              description: fresh.description ?? '',
              assignee: null,
              sessions: [],
              createdFrom: number,
            },
            `Filed from ${workKey(number)}`
          )
        );
      toDone();
      delete item.needs;
      item.outcome = { kind: 'split', text: report.note, ...(sessionId ? { sessionId } : {}), at: ctx.now };
      log(item, ctx, `Reported done and filed ${filed.map((f) => workKey(f.number)).join(', ')}`);
      break;
    }
    case 'ask':
      // A question for the person: the item waits in Human required until it is answered.
      moveTo('human-required');
      item.needs = { question: report.question!, ...(sessionId ? { sessionId } : {}), at: ctx.now };
      log(item, ctx, 'Asked the person a question');
      break;
  }
  // A report says its author is on the item, so a report that leaves it In progress unowned assigns the reporter.
  const unowned = ownerRefusal(next, item, ctx, true);
  if (unowned) return unowned;
  touch(item, ctx);
  return { ok: true, file: next, item, filed, duplicate: false };
}

/**
 * The reviewer asked for changes on the item's pull request: the notes go on the item, an open question is closed by
 * them, and the item goes to the top of Ready for work, unassigned, so the next run picks it up and reads the notes
 * first.
 */
export function requestChangesOnWork(
  file: WorkFile,
  number: number,
  changes: WorkChanges,
  ctx: WorkContext
): WorkChange | WorkRefusal {
  const refused = unchangeable(file, number, undefined);
  if (refused) return refused;
  if (workClosed(findWork(file, number)!.status))
    return refuse('INVALID_INPUT', `${workKey(number)} is closed; reopen it to send it changes`);
  const next = structuredClone(file);
  const item = findWork(next, number)!;
  item.changes = { ...changes, text: changes.text.slice(0, MAX_CHANGES_CHARS) };
  delete item.needs;
  if (item.status !== 'ready-for-work') setStatus(next, item, 'ready-for-work', ctx);
  place(next, item, 1, ctx);
  // The pickup routine takes only unassigned items; the finished session stays linked (W-70 I6).
  if (item.assignee) {
    item.assignee = null;
    log(item, ctx, describeAssignee(null));
  }
  log(item, ctx, 'Changes requested in review');
  touch(item, ctx);
  return { ok: true, file: next, item, filed: [], duplicate: false };
}

/** Approve merged the item's pull request: the item is done. An item already done is left as it is. */
export function approveWork(
  file: WorkFile,
  number: number,
  mergedSha: string,
  ctx: WorkContext
): WorkChange | WorkRefusal {
  const refused = unchangeable(file, number, undefined);
  if (refused) return refused;
  const current = findWork(file, number)!;
  if (current.status === 'done') return { ok: true, file, item: current, filed: [], duplicate: false };
  const next = structuredClone(file);
  const item = findWork(next, number)!;
  setStatus(next, item, 'done', ctx);
  delete item.needs;
  delete item.changes;
  log(item, ctx, `Approved and merged ${mergedSha.slice(0, 7)} in review`);
  touch(item, ctx);
  return { ok: true, file: next, item, filed: [], duplicate: false };
}

/**
 * Whether Approve of a review written by `sessionId` closes this item (W-70 I8, revised 2026-11-21): it links the
 * session, the newest line of its history is the session's own write, so nobody else has written to it since, and that
 * write left it waiting on the session's work. That is In progress held by the session, Human required on a question
 * the session asked, or the session's own release (whichever status and question the release gave it).
 */
export function waitsOnSessionReview(item: WorkItem, sessionId: string): boolean {
  if (workClosed(item.status) || !item.sessions.includes(sessionId)) return false;
  const newest = item.history[0];
  if (newest?.author.kind !== 'agent' || newest.author.sessionId !== sessionId) return false;
  if (item.status === 'in-progress') return item.assignee?.kind === 'session' && item.assignee.sessionId === sessionId;
  if (item.status === 'human-required' && item.needs?.sessionId === sessionId) return true;
  return newest.text.startsWith(`${RELEASED}session ${sessionId} `);
}

/**
 * Approve merged a review written by `sessionId`: each item `waitsOnSessionReview` picks is done (W-70 I8). Any other
 * item is returned as it is, so a second call changes nothing.
 */
export function closeLinkedWork(
  file: WorkFile,
  number: number,
  sessionId: string,
  reviewId: string,
  mergedSha: string,
  ctx: WorkContext
): WorkChange | WorkRefusal {
  const refused = unchangeable(file, number, undefined);
  if (refused) return refused;
  const current = findWork(file, number)!;
  if (!waitsOnSessionReview(current, sessionId)) return { ok: true, file, item: current, filed: [], duplicate: false };
  const next = structuredClone(file);
  const item = findWork(next, number)!;
  const cleared = [item.needs && 'its question', item.changes && 'its requested changes'].filter(Boolean);
  setStatus(next, item, 'done', ctx);
  delete item.needs;
  delete item.changes;
  if (cleared.length) log(item, ctx, `Cleared ${cleared.join(' and ')}`);
  log(item, ctx, `Done: review ${reviewId} merged ${mergedSha.slice(0, 7)}`);
  touch(item, ctx);
  return { ok: true, file: next, item, filed: [], duplicate: false };
}

/** Adds a comment to the end of the item's thread. It changes no other field: status, `needs` and the rest stay. */
export function commentWork(file: WorkFile, number: number, text: string, ctx: WorkContext): WorkChange | WorkRefusal {
  const refused = unchangeable(file, number, undefined);
  if (refused) return refused;
  if (findWork(file, number)!.comments.length >= MAX_WORK_COMMENTS)
    return refuse('FULL', `An item holds at most ${MAX_WORK_COMMENTS} comments`);
  const next = structuredClone(file);
  const item = findWork(next, number)!;
  item.comments = [...item.comments, { at: ctx.now, author: ctx.author, text }];
  log(item, ctx, 'Commented');
  touch(item, ctx);
  return { ok: true, file: next, item, filed: [], duplicate: false };
}

/** Bytes every attachment of the file takes, as recorded on the items. */
export const attachedBytes = (file: WorkFile): number =>
  file.items.reduce((sum, i) => sum + workFiles(i).reduce((s, a) => s + a.size, 0), 0);

/**
 * Records a file whose bytes are already stored. Refused when the item is full or the workspace's attachments would
 * pass `quotaBytes`; the caller then removes the bytes it stored.
 */
export function attachWork(
  file: WorkFile,
  number: number,
  attachment: WorkFileAttachment,
  quotaBytes: number,
  ctx: WorkContext
): WorkChange | WorkRefusal {
  const refused = unchangeable(file, number, undefined);
  if (refused) return refused;
  if ((findWork(file, number)!.attachments ?? []).length >= MAX_WORK_ATTACHMENTS)
    return refuse('FULL', `An item carries at most ${MAX_WORK_ATTACHMENTS} attachments`);
  if (attachedBytes(file) + attachment.size > quotaBytes)
    return refuse(
      'FULL',
      `This canvas has reached its ${Math.round(quotaBytes / 1024 / 1024)} MB limit for attached files`
    );
  const next = structuredClone(file);
  const item = findWork(next, number)!;
  item.attachments = [...(item.attachments ?? []), attachment];
  log(item, ctx, `Attached ${attachment.name}`);
  touch(item, ctx);
  return { ok: true, file: next, item, filed: [], duplicate: false };
}

/** Takes a file off an item. The caller removes its bytes once this is written. */
export function detachWork(file: WorkFile, number: number, id: string, ctx: WorkContext): WorkChange | WorkRefusal {
  const refused = unchangeable(file, number, undefined);
  if (refused) return refused;
  const attachment = workFiles(findWork(file, number)!).find((a) => a.id === id);
  if (!attachment) return refuse('NOT_FOUND', `${workKey(number)} has no attachment ${id}`);
  const next = structuredClone(file);
  const item = findWork(next, number)!;
  const left = item.attachments!.filter((a) => isObjectAttachment(a) || a.id !== id);
  if (left.length) item.attachments = left;
  else delete item.attachments;
  log(item, ctx, `Removed attachment ${attachment.name}`);
  touch(item, ctx);
  return { ok: true, file: next, item, filed: [], duplicate: false };
}

// ---- Owners (W-70) ---------------------------------------------------------

/** What the server knows about a session at one moment: `unknown` before the restore after a boot has finished. */
export type SessionState = 'live' | 'exited' | 'gone' | 'unknown';
/** Who keeps an item In progress, derived every tick and never stored. */
export type Owner =
  | { kind: 'person' }
  | { kind: 'run'; sessionId: string; runId: string; taskId: string; state: TaskState }
  | { kind: 'session'; sessionId: string; state: SessionState }
  | { kind: 'tickets'; open: number[] }
  | { kind: 'none' };
/** The one write a release makes: where the item goes, the history line, and the question when it asks. */
export type Release = { to: WorkStatus; reason: string; question?: string };
/** The facts the runner supplies: a routine run by its session, and any other session's state. */
export type OwnerFacts = {
  run: (sessionId: string) => { runId: string; taskId: string; state: TaskState } | undefined;
  session: (sessionId: string) => SessionState;
};
/** Releases in a row after which the next release asks the person, and a claim is refused (I4, F2). */
export const MAX_RELEASES_IN_A_ROW = 2;
const RELEASED = 'Released: ';

/** The items created from `item` that are not closed: they own it while nobody is assigned (I7). */
export const openTickets = (file: WorkFile, item: WorkItem): WorkItem[] =>
  file.items.filter((i) => i.createdFrom === item.number && !workClosed(i.status));

export function ownerOf(item: WorkItem, file: WorkFile, facts: OwnerFacts): Owner {
  const assignee = item.assignee;
  if (assignee?.kind === 'person') return { kind: 'person' };
  if (assignee?.kind === 'session') {
    const { sessionId } = assignee;
    const state = facts.session(sessionId);
    // A run's task state is read from the session map, so it means nothing until the session itself is known.
    const run = state === 'unknown' ? undefined : facts.run(sessionId);
    return run ? { kind: 'run', sessionId, ...run } : { kind: 'session', sessionId, state };
  }
  const tickets = file.items.filter((i) => i.createdFrom === item.number);
  if (tickets.length) return { kind: 'tickets', open: openTickets(file, item).map((i) => i.number) };
  return { kind: 'none' };
}

/**
 * I1: an In progress item has an assignee or open tickets. A write that moved an unassigned item in (or a report)
 * assigns its author; any other write that would leave the item unowned is refused.
 */
function ownerRefusal(file: WorkFile, item: WorkItem, ctx: WorkContext, assignAuthor: boolean): WorkRefusal | null {
  if (item.status !== 'in-progress' || item.assignee || openTickets(file, item).length) return null;
  if (!assignAuthor)
    return refuse(
      'INVALID_INPUT',
      `${workKey(item.number)} is In progress, so it needs an owner. Assign someone, or move it out of In progress in the same change`
    );
  const mover: WorkAssignee =
    ctx.author.kind === 'agent' ? { kind: 'session', sessionId: ctx.author.sessionId } : { kind: 'person' };
  if (mover.kind === 'session') {
    const failed = link(item, [mover.sessionId]);
    if (failed) return refuse('INVALID_INPUT', failed);
  }
  item.assignee = mover;
  log(item, ctx, describeAssignee(mover));
  return null;
}

/**
 * The `Released:` lines since the last report or person's move, newest first. A release's own move shares its time
 * and author, so it is not read as a person's move.
 */
function releasesInARowOf(item: Pick<WorkItem, 'history'>): WorkEvent[] {
  const released: WorkEvent[] = [];
  let last: WorkEvent | undefined;
  for (const event of item.history) {
    if (event.text.startsWith(RELEASED)) {
      released.push(event);
      last = event;
      continue;
    }
    if (last && event.at === last.at && sameAuthor(event.author, last.author)) continue;
    if (event.text.startsWith('Reported ') || event.text === 'Asked the person a question') break;
    if (event.author.kind === 'human' && event.text.startsWith('Moved from ')) break;
  }
  return released;
}
export const releasesInARow = (item: Pick<WorkItem, 'history'>): number => releasesInARowOf(item).length;
const sameAuthor = (a: Author, b: Author): boolean =>
  a.kind === b.kind &&
  (a.kind === 'human' ? a.userId === (b as typeof a).userId : a.sessionId === (b as typeof a).sessionId);

/** The status the item entered In progress from, by its newest `Moved from <A> to In progress` line. */
function cameFrom(item: WorkItem): WorkStatus | undefined {
  const into = ` to ${WORK_STATUS_NAMES['in-progress']}`;
  for (const event of item.history) {
    if (!event.text.startsWith('Moved from ') || !event.text.endsWith(into)) continue;
    const name = event.text.slice('Moved from '.length, -into.length);
    return WORK_STATUSES.find((s) => WORK_STATUS_NAMES[s] === name);
  }
  return undefined;
}

const ownerName = (owner: Owner): string =>
  owner.kind === 'run' ? `run ${owner.runId}` : owner.kind === 'session' ? `session ${owner.sessionId}` : 'nobody';

/**
 * The release decision (I2, I3, I4, I7), or null when the item keeps its owner. Pure: `owner` is the runner's facts.
 * A live owner is never released: a person, a run still queued, running or waiting, a live or unknown session, or open
 * tickets. Applied to its own result it returns null (I5).
 */
export function releaseFor(item: WorkItem, file: WorkFile, owner: Owner): Release | null {
  if (item.status !== 'in-progress') return null;
  switch (owner.kind) {
    case 'person':
      return null;
    case 'run':
      if (taskActive(owner.state)) return null;
      break;
    case 'session':
      if (owner.state === 'live' || owner.state === 'unknown') return null;
      break;
    case 'tickets': {
      if (owner.open.length) return null;
      const tickets = file.items.filter((i) => i.createdFrom === item.number);
      const keys = tickets.map((i) => workKey(i.number)).join(', ');
      if (tickets.every((i) => i.status === 'done')) return { to: 'done', reason: `Done: all tickets done (${keys})` };
      const dropped = tickets
        .filter((i) => i.status !== 'done')
        .map((i) => `${workKey(i.number)} ${WORK_STATUS_NAMES[i.status]}`);
      return {
        to: 'human-required',
        reason: `Tickets closed: ${keys}`,
        question: `Every ticket of ${workKey(item.number)} is closed, but not all are Done (${dropped.join(', ')}). Is ${workKey(item.number)} done?`,
      };
    }
    case 'none':
      break;
  }
  const who = ownerName(owner);
  const reason =
    owner.kind === 'run'
      ? `${RELEASED}run ${owner.runId} ended without a report`
      : owner.kind === 'session'
        ? `${RELEASED}session ${owner.sessionId} ${owner.state === 'gone' ? 'ended' : 'exited'} without a report`
        : `${RELEASED}it was In progress with no owner`;
  const key = workKey(item.number);
  const earlier = releasesInARowOf(item);
  if (earlier.length + 1 >= MAX_RELEASES_IN_A_ROW) {
    const before = /^Released: (run \S+|session \S+)/.exec(earlier[0]!.text)?.[1] ?? 'an earlier owner';
    const both =
      before.startsWith('run ') && owner.kind === 'run'
        ? `runs ${before.slice(4)} and ${owner.runId}`
        : `${before} and ${who}`;
    return {
      to: 'human-required',
      reason,
      question: `${key} was released twice: ${both} ended without reporting. Send it back to Ready for work when the cause is fixed.`,
    };
  }
  if (item.pr && !item.changes)
    return {
      to: 'human-required',
      reason,
      question: `${key} has pull request ${item.pr.url} waiting, and ${who} ended without a report. Review it, or send it back to Ready for work.`,
    };
  const from = cameFrom(item);
  return { to: !from || workClosed(from) || from === 'in-progress' ? 'needs-refinement' : from, reason };
}

/**
 * Writes a release: the move (Ready for work at the top), the question, the history line. A released item loses its
 * assignee, and a run's session is unlinked; a parent following its tickets keeps everything else. Refused with
 * CONFLICT when the item changed since `expectedRevision`, so a release decided on stale facts waits a tick (I5).
 */
export function applyRelease(
  file: WorkFile,
  number: number,
  release: Release,
  owner: Owner,
  expectedRevision: number,
  ctx: WorkContext
): WorkChange | WorkRefusal {
  const refused = unchangeable(file, number, expectedRevision);
  if (refused) return refused;
  const next = structuredClone(file);
  const item = findWork(next, number)!;
  if (item.status !== release.to) setStatus(next, item, release.to, ctx);
  if (release.to === 'ready-for-work') place(next, item, 1, ctx);
  item.assignee = null;
  if (owner.kind === 'run') item.sessions = item.sessions.filter((id) => id !== owner.sessionId);
  if (release.question) item.needs = { question: release.question.slice(0, MAX_WORK_NOTE_CHARS), at: ctx.now };
  log(item, ctx, release.reason);
  touch(item, ctx);
  return { ok: true, file: next, item, filed: [], duplicate: false };
}

// ---- Reading --------------------------------------------------------------

/** An item as the API answers it: its key spelled out, its request id left out. */
/** The item's declared fields: `Omit` over the passthrough index signature would lose every one of them. */
type KnownWorkFields = { [K in keyof WorkItem as string extends K ? never : K]: WorkItem[K] };
export type WorkRow = Omit<KnownWorkFields, 'requestId'> & { key: string; position?: number };
/** With the file, an item in Ready for work also carries its `position` there (1 is the top). */
export function workRow(item: WorkItem, file?: WorkFile): WorkRow {
  const { requestId: _requestId, ...rest } = item;
  void _requestId;
  const position = file ? workPosition(file, item.number) : null;
  return { ...rest, key: workKey(item.number), ...(position !== null ? { position } : {}) };
}
export type WorkRelated = { key: string; title: string; status: WorkStatus };
/** The item it was created from, and the items created from it. */
export function workRelated(file: WorkFile, item: WorkItem): { createdFrom?: WorkRelated; created: WorkRelated[] } {
  const brief = (i: WorkItem): WorkRelated => ({ key: workKey(i.number), title: i.title, status: i.status });
  const parent = item.createdFrom !== undefined ? findWork(file, item.createdFrom) : undefined;
  return {
    ...(parent ? { createdFrom: brief(parent) } : {}),
    created: file.items.filter((i) => i.createdFrom === item.number).map(brief),
  };
}
/** The list an agent reads: no description or history. */
export function workBrief(item: WorkItem, file?: WorkFile) {
  const position = file ? workPosition(file, item.number) : null;
  return {
    // The reviewer's notes come first: an agent picking the item up reads them before anything else.
    ...(item.changes ? { changesRequested: item.changes.text } : {}),
    key: workKey(item.number),
    title: item.title,
    status: item.status,
    ...(position !== null ? { position } : {}),
    assignee: item.assignee,
    sessions: item.sessions,
    revision: item.revision,
    updatedAt: item.updatedAt,
    ...(item.createdFrom !== undefined ? { createdFrom: workKey(item.createdFrom) } : {}),
    ...(item.pr ? { pr: item.pr.url } : {}),
    ...(item.attachments?.length ? { attachments: item.attachments.length } : {}),
    ...(item.needs ? { needsYou: true } : {}),
  };
}
