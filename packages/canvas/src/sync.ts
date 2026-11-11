import { z } from 'zod';
import { SnapshotSchema, ViewObjectSchema, type Snapshot } from './model.js';
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
  })
  .passthrough();
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
export function replayCatchUp(state: Snapshot, payload: unknown): { state: Snapshot; unreadable: boolean } {
  const data = OpsSchema.parse(payload);
  const objects = new Map(state.objects.map((o) => [o.id, o]));
  const textAuthors = { ...state.textAuthors };
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
    state: { seq: data.seq, textAuthors, objects: [...objects.values()].filter((o) => o.deletedAt === null) },
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
        if (data.workspaceId === this.workspaceId && data.seq > this.state.seq) this.catchUp();
      } catch {
        this.status('offline');
      }
    });
  }
  private catchUp(): void {
    this.pending = this.pending
      .then(async () => {
        if (this.stopped) return;
        const response = await fetch(this.url(`/api/canvas/${this.workspaceId}/ops?since=${this.state.seq}`), {
          signal: this.abort.signal,
        });
        if (!response.ok) throw new Error('Reconnect failed');
        const payload = envelope(z.unknown()).parse(await response.json()).data;
        let replay;
        try {
          replay = replayCatchUp(this.state, payload);
        } catch {
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
