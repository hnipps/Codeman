import { z } from 'zod';
import { SnapshotSchema, ViewObjectSchema, type Snapshot } from './model.js';
import { ViewCommentSchema, type ViewComment } from './comments.js';
const envelope = <T extends z.ZodType>(data: T) => z.object({ success: z.literal(true), data }).passthrough();
const OpsSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    operations: z.array(z.unknown()),
  })
  .passthrough();
const HeaderSchema = z.object({ seq: z.number().int().nonnegative(), kind: z.string() }).passthrough();
const ChangesSchema = z
  .object({
    prev: z.array(z.object({ objectId: z.string(), after: ViewObjectSchema }).passthrough()),
    comment: ViewCommentSchema.optional(),
    removedComment: ViewCommentSchema.optional(),
  })
  .passthrough();
/** Comments the snapshot carried; an unreadable list reads as none rather than failing the board. */
export function snapshotComments(state: Snapshot): ViewComment[] {
  const parsed = z.array(ViewCommentSchema).safeParse(state.comments);
  return parsed.success ? parsed.data : [];
}
export const viewOperationKinds = new Set([
  'create',
  'update',
  'move',
  'reparent',
  'reorder',
  'lock',
  'unlock',
  'delete',
  'restore',
  'comment',
  'remove-comment',
  'revert',
]);
const PageSchema = z
  .object({
    seq: z.number().int().nonnegative().optional(),
    operations: z.array(z.unknown()),
    more: z.boolean().optional(),
    next: z.number().int().nonnegative().optional(),
  })
  .passthrough();
/** A long catch-up is a refetch of the snapshot, not an unbounded walk of history. */
const MAX_HISTORY_PAGES = 200;
/** Follows the `/ops` cursor from `since` to the end and returns one combined answer. */
type HistoryAnswer = { seq: number; operations: unknown[] };
/**
 * One catch-up shared by everyone who needs the same history: the command acknowledgement and
 * the change event a write produces both ask for it, and they get one `/ops` walk, not two with
 * the same cursor. A request joins a walk in flight, or reuses a just-finished one, only when
 * that walk started at or before its cursor and its answer reaches the sequence it needs.
 */
const shared = new Map<string, { since: number; at: number; answer: Promise<HistoryAnswer>; seq: number | null }>();
const SHARED_HISTORY_MS = 2000;
export function forgetSharedHistory(): void {
  shared.clear();
}
export async function fetchHistory(
  url: (path: string) => string,
  workspaceId: string,
  since: number,
  signal?: AbortSignal,
  need = Number.POSITIVE_INFINITY
): Promise<HistoryAnswer> {
  const entry = shared.get(workspaceId);
  if (
    entry &&
    entry.since <= since &&
    Number.isFinite(need) &&
    Date.now() - entry.at < SHARED_HISTORY_MS &&
    (entry.seq === null || entry.seq >= need)
  ) {
    try {
      const answer = await entry.answer;
      if (answer.seq >= need) {
        const operations = answer.operations.filter((record) => {
          const header = HeaderSchema.safeParse(record);
          return !header.success || header.data.seq > since;
        });
        return { seq: answer.seq, operations };
      }
    } catch {
      /* The shared walk failed; walk again for this caller. */
    }
  }
  const answer = walkHistory(url, workspaceId, since, signal);
  const record = { since, at: Date.now(), answer, seq: null as number | null };
  shared.set(workspaceId, record);
  answer.then(
    (result) => {
      record.seq = result.seq;
      record.at = Date.now();
    },
    () => {
      if (shared.get(workspaceId) === record) shared.delete(workspaceId);
    }
  );
  return answer;
}
async function walkHistory(
  url: (path: string) => string,
  workspaceId: string,
  since: number,
  signal?: AbortSignal
): Promise<HistoryAnswer> {
  const operations: unknown[] = [];
  let cursor = since;
  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    const response = await fetch(url(`/api/canvas/${workspaceId}/ops?since=${cursor}`), { signal });
    if (!response.ok) throw new Error('History request failed');
    const data = envelope(PageSchema).parse(await response.json()).data;
    operations.push(...data.operations);
    if (data.more && data.next !== undefined && data.next > cursor) {
      cursor = data.next;
      continue;
    }
    if (data.seq === undefined) throw new Error('History page without a sequence');
    return { seq: data.seq, operations };
  }
  throw new Error('History is too long to replay');
}
export function replayCatchUp(state: Snapshot, payload: unknown): { state: Snapshot; unreadable: boolean } {
  const data = OpsSchema.parse(payload);
  const objects = new Map(state.objects.map((o) => [o.id, o]));
  const textAuthors = { ...state.textAuthors };
  let comments = snapshotComments(state);
  let unreadable = false;
  for (const record of data.operations) {
    const header = HeaderSchema.safeParse(record);
    if (!header.success) {
      unreadable = true;
      continue;
    }
    if (!viewOperationKinds.has(header.data.kind)) continue;
    const operation = ChangesSchema.safeParse(record);
    if (!operation.success) {
      unreadable = true;
      continue;
    }
    if (operation.data.comment) comments = [...comments, operation.data.comment];
    const removed = operation.data.removedComment;
    if (removed) comments = comments.filter((c) => c.id !== removed.id);
    const author = ViewObjectSchema.shape.author.safeParse(operation.data.author);
    for (const change of operation.data.prev) {
      if (objects.get(change.objectId)?.content.text !== change.after.content.text) {
        if (author.success)
          textAuthors[change.objectId] =
            author.data.kind === 'human' ? author.data.userId : `Agent ${author.data.sessionId}`;
        else delete textAuthors[change.objectId];
      }
      objects.set(change.objectId, change.after);
    }
  }
  return {
    state: {
      seq: data.seq,
      textAuthors,
      comments,
      objects: [...objects.values()].filter((o) => o.deletedAt === null),
    },
    unreadable,
  };
}
export class CanvasSync {
  private state: Snapshot = { seq: 0, objects: [] };
  private source: EventSource | null = null;
  private stopped = false;
  private pending: Promise<void> = Promise.resolve();
  private abort = new AbortController();
  private online = (): void => {
    if (!this.stopped) this.connect();
  };
  private offline = (): void => {
    this.source?.close();
    this.status('offline');
  };
  constructor(
    private url: (path: string) => string,
    private workspaceId: string,
    private receive: (state: Snapshot) => void,
    private status: (state: 'loading' | 'ready' | 'offline' | 'error') => void
  ) {}
  async start(): Promise<void> {
    window.addEventListener('online', this.online);
    window.addEventListener('offline', this.offline);
    this.status('loading');
    try {
      await this.snapshot();
      if (this.stopped) return;
      this.receive(this.state);
      this.status('ready');
      this.connect();
    } catch {
      if (!this.stopped) this.status('error');
    }
  }
  private async snapshot(): Promise<void> {
    const response = await fetch(this.url(`/api/canvas/${this.workspaceId}/objects`), { signal: this.abort.signal });
    if (!response.ok) throw new Error('Load failed');
    this.state = envelope(SnapshotSchema).parse(await response.json()).data;
  }
  private connect(): void {
    this.source?.close();
    this.source = new EventSource(this.url('/api/events'));
    this.source.onopen = () => this.catchUp();
    this.source.onerror = () => this.status('offline');
    this.source.addEventListener('canvas:changed', (event) => {
      try {
        const data = z.object({ workspaceId: z.string(), seq: z.number() }).parse(JSON.parse(event.data));
        if (data.workspaceId === this.workspaceId && data.seq > this.state.seq) this.catchUp(data.seq);
      } catch {
        this.status('offline');
      }
    });
  }
  private catchUp(need?: number): void {
    this.pending = this.pending
      .then(async () => {
        if (this.stopped) return;
        let replay;
        try {
          replay = replayCatchUp(
            this.state,
            await fetchHistory(this.url, this.workspaceId, this.state.seq, this.abort.signal, need)
          );
        } catch {
          if (this.abort.signal.aborted) return;
          await this.snapshot();
        }
        if (replay) {
          if (replay.unreadable) await this.snapshot();
          else this.state = replay.state;
        }
        if (!this.stopped) {
          this.receive(this.state);
          this.status('ready');
        }
      })
      .catch(() => {
        if (!this.stopped) this.status('offline');
      });
  }
  stop(): void {
    window.removeEventListener('online', this.online);
    window.removeEventListener('offline', this.offline);
    this.stopped = true;
    this.abort.abort();
    this.source?.close();
  }
}
