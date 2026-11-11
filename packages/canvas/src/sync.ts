import { z } from 'zod';
import { SnapshotSchema, ViewObjectSchema, type Snapshot } from './model.js';
const envelope = <T extends z.ZodType>(data: T) => z.object({ success: z.literal(true), data });
const OpsSchema = z.object({
  seq: z.number().int().nonnegative(),
  operations: z.array(
    z.object({ seq: z.number(), prev: z.array(z.object({ objectId: z.string(), after: ViewObjectSchema })) })
  ),
});
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
      const response = await fetch(this.url(`/api/canvas/${this.workspaceId}/objects`), { signal: this.abort.signal });
      if (!response.ok) throw new Error('Load failed');
      this.state = envelope(SnapshotSchema).parse(await response.json()).data;
      if (this.stopped) return;
      this.receive(this.state);
      this.status('ready');
      this.connect();
    } catch {
      if (!this.stopped) this.status('error');
    }
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
        const data = envelope(OpsSchema).parse(await response.json()).data;
        const objects = new Map(this.state.objects.map((o) => [o.id, o]));
        for (const op of data.operations) for (const change of op.prev) objects.set(change.objectId, change.after);
        this.state = { seq: data.seq, objects: [...objects.values()].filter((o) => o.deletedAt === null) };
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
