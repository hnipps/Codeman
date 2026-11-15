/**
 * @fileoverview Work items of a canvas workspace: what an item is, the request shapes that change one, and the pure
 * functions every change goes through. Shared by the server and the canvas page; nothing here touches disk.
 *
 * An item is tracked work, separate from background tasks: a key (`W-12`), a title, a status, a description, an
 * assignee (the person, an agent session, or nobody), linked sessions, the item it was created from and a short
 * history. Items live in `work.json` per workspace (`work-store.ts`), never on the board or in the operation log.
 *
 * Nothing changes an item by itself. `report` is the run-end rule an agent applies to its own work when a run ends
 * (done and verified, keep working, done plus new Backlog items, or ask the person); it is a request the agent makes,
 * and the server only records it.
 */
import { z } from 'zod';
import { AuthorSchema, IdSchema, type Author } from './model.js';

export const WORK_STATUSES = ['backlog', 'todo', 'in-progress', 'done', 'not-doing'] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];
export const WORK_STATUS_NAMES: Record<WorkStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  'in-progress': 'In progress',
  done: 'Done',
  'not-doing': 'Not doing',
};
/** Done and Not doing: the item is closed and its lane is quiet. */
export const workClosed = (status: WorkStatus): boolean => status === 'done' || status === 'not-doing';

export const MAX_WORK_ITEMS = 2000;
export const MAX_WORK_TITLE_CHARS = 200;
export const MAX_WORK_DESCRIPTION_CHARS = 8000;
export const MAX_WORK_NOTE_CHARS = 2000;
export const MAX_LINKED_SESSIONS = 16;
export const MAX_WORK_HISTORY = 50;
/** New Backlog items one `split` report may file. */
export const MAX_FILED_ITEMS = 10;

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
const Key = z.union([z.string().max(16), z.number().int()]).transform((value, ctx) => {
  const n = typeof value === 'number' ? (value > 0 ? value : null) : parseWorkKey(value);
  if (n === null) {
    ctx.addIssue({ code: 'custom', message: 'A work key looks like W-12' });
    return z.NEVER;
  }
  return n;
});

export type WorkAssignee = { kind: 'person' } | { kind: 'session'; sessionId: string };
const AssigneeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('person') }).strict(),
  z.object({ kind: z.literal('session'), sessionId: IdSchema }).strict(),
]);

const at = z.number().int().nonnegative();
const StoredEvent = z.object({ at, author: AuthorSchema, text: z.string().max(400) }).passthrough();
const StoredItem = z
  .object({
    number: z.number().int().positive(),
    title: z.string().min(1).max(MAX_WORK_TITLE_CHARS),
    status: z.enum(WORK_STATUSES),
    description: z.string().max(MAX_WORK_DESCRIPTION_CHARS).catch(''),
    assignee: AssigneeSchema.nullable().catch(null),
    sessions: z.array(IdSchema).max(MAX_LINKED_SESSIONS).catch([]),
    createdFrom: z.number().int().positive().optional().catch(undefined),
    requestId: z.uuid().optional().catch(undefined),
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
  })
  .passthrough();
export type WorkItem = z.infer<typeof StoredItem>;
export type WorkEvent = WorkItem['history'][number];
/** `work.json`. Unknown keys of the file and of each item are kept on every write. */
export const WorkFileSchema = z
  .object({
    version: z.literal(1),
    next: z.number().int().positive(),
    items: z.array(StoredItem).max(MAX_WORK_ITEMS),
  })
  .passthrough();
export type WorkFile = z.infer<typeof WorkFileSchema>;
export const emptyWorkFile = (): WorkFile => ({ version: 1, next: 1, items: [] });

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
    status: z.enum(WORK_STATUSES).default('backlog'),
    description: Description.optional(),
    assignee: AssigneeInput.optional(),
    sessions: z.array(IdSchema).max(MAX_LINKED_SESSIONS).optional(),
    createdFrom: Key.optional(),
  })
  .strict();
export type CreateWork = z.infer<typeof CreateWorkSchema>;
export const UpdateWorkSchema = z
  .object({
    /** Refused with CONFLICT when the item has changed since this revision was read. */
    expectedRevision: z.number().int().positive().optional(),
    title: Title.optional(),
    status: z.enum(WORK_STATUSES).optional(),
    description: Description.optional(),
    assignee: AssigneeInput.optional(),
    linkSessions: z.array(IdSchema).max(MAX_LINKED_SESSIONS).optional(),
    unlinkSessions: z.array(IdSchema).max(MAX_LINKED_SESSIONS).optional(),
    /** `null`: the question was answered. A question is asked only through a report. */
    needs: z.null().optional(),
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
    expectedRevision: z.number().int().positive().optional(),
  })
  .strict();
export type ReportWork = z.infer<typeof ReportWorkSchema>;

/** The `canvas_work` tool. */
export const WorkToolSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), status: z.enum(WORK_STATUSES).optional() }).strict(),
  z.object({ action: z.literal('read'), key: Key }).strict(),
  CreateWorkSchema.extend({ action: z.literal('create') }).strict(),
  UpdateWorkSchema.extend({ action: z.literal('update'), key: Key }).strict(),
  ReportWorkSchema.extend({ action: z.literal('report'), key: Key }).strict(),
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
function touch(item: WorkItem, ctx: WorkContext): void {
  item.updatedAt = ctx.now;
  item.revision += 1;
}

export function findWork(file: WorkFile, number: number): WorkItem | undefined {
  return file.items.find((i) => i.number === number);
}

function newItem(
  file: WorkFile,
  ctx: WorkContext,
  fields: Pick<WorkItem, 'title' | 'status' | 'description' | 'assignee' | 'sessions'> & {
    createdFrom?: number;
    requestId?: string;
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
    author: ctx.author,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    revision: 1,
    history: [],
  };
  log(item, ctx, firstEvent);
  file.next += 1;
  file.items.push(item);
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
    },
    input.createdFrom !== undefined
      ? `Created from ${workKey(input.createdFrom)} in ${WORK_STATUS_NAMES[input.status]}`
      : `Created in ${WORK_STATUS_NAMES[input.status]}`
  );
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
  if (patch.status !== undefined && patch.status !== item.status) {
    log(item, ctx, `Moved from ${WORK_STATUS_NAMES[item.status]} to ${WORK_STATUS_NAMES[patch.status]}`);
    item.status = patch.status;
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
  if (patch.needs === null && item.needs) {
    delete item.needs;
    log(item, ctx, 'Marked the question answered');
    changed = true;
  }
  if (!changed) return { ok: true, file, item: findWork(file, number)!, filed: [], duplicate: false };
  touch(item, ctx);
  return { ok: true, file: next, item, filed: [], duplicate: false };
}

/**
 * The run-end rule, as the agent decided it. `done`: verified, moves to Done. `continue`: not done or not verified,
 * stays where it is with a note. `split`: done and verified, with unrelated work found: moves to Done and files each
 * of `newItems` in Backlog, created from this item. `ask`: unsure: records the question, which shows as Needs you.
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
  const next = structuredClone(file);
  const item = findWork(next, number)!;
  const sessionId = ctx.author.kind === 'agent' ? ctx.author.sessionId : undefined;
  if (sessionId && !item.sessions.includes(sessionId)) {
    const failed = link(item, [sessionId]);
    if (failed) return refuse('INVALID_INPUT', failed);
  }
  const filed: WorkItem[] = [];
  const toDone = (): void => {
    if (item.status !== 'done') {
      log(item, ctx, `Moved from ${WORK_STATUS_NAMES[item.status]} to Done`);
      item.status = 'done';
    }
  };
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
      item.needs = { question: report.question!, ...(sessionId ? { sessionId } : {}), at: ctx.now };
      log(item, ctx, 'Asked the person a question');
      break;
  }
  touch(item, ctx);
  return { ok: true, file: next, item, filed, duplicate: false };
}

// ---- Reading --------------------------------------------------------------

/** An item as the API answers it: its key spelled out, its request id left out. */
/** The item's declared fields: `Omit` over the passthrough index signature would lose every one of them. */
type KnownWorkFields = { [K in keyof WorkItem as string extends K ? never : K]: WorkItem[K] };
export type WorkRow = Omit<KnownWorkFields, 'requestId'> & { key: string };
export function workRow(item: WorkItem): WorkRow {
  const { requestId: _requestId, ...rest } = item;
  void _requestId;
  return { ...rest, key: workKey(item.number) };
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
/** The list an agent reads: no description or history, newest change first. */
export function workBrief(item: WorkItem) {
  return {
    key: workKey(item.number),
    title: item.title,
    status: item.status,
    assignee: item.assignee,
    sessions: item.sessions,
    revision: item.revision,
    updatedAt: item.updatedAt,
    ...(item.createdFrom !== undefined ? { createdFrom: workKey(item.createdFrom) } : {}),
    ...(item.needs ? { needsYou: true } : {}),
  };
}
