import { z } from 'zod';
import { IdSchema, MutableSchema } from '../../../src/canvas/model.js';
import type { Command } from '../../../src/canvas/operations.js';
import { SnapshotSchema, ViewObjectSchema, type Snapshot, type ViewObject } from './model.js';
import { reparentPosition } from './drag.js';
const fields = { opId: IdSchema, objectId: IdSchema, expectedRevision: z.number().int().nonnegative().optional() };
export const EditSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...fields,
      kind: z.literal('create'),
      patch: MutableSchema.omit({ deletedAt: true, deletionOpId: true }).extend({
        size: MutableSchema.shape.size.optional(),
        rotation: z.number().default(0),
        lock: MutableSchema.shape.lock.default(null),
      }),
    })
    .strict(),
  z
    .object({
      ...fields,
      kind: z.literal('update'),
      patch: MutableSchema.pick({ content: true, size: true, rotation: true }).partial(),
    })
    .strict(),
  z.object({ ...fields, kind: z.literal('move'), patch: MutableSchema.pick({ position: true }) }).strict(),
  z
    .object({
      ...fields,
      kind: z.literal('reparent'),
      patch: MutableSchema.pick({ parentId: true, order: true }).extend({ preserveWorld: z.boolean().default(true) }),
    })
    .strict(),
  z.object({ ...fields, kind: z.literal('delete') }).strict(),
  z.object({ ...fields, kind: z.literal('restore') }).strict(),
  z.object({ ...fields, kind: z.literal('revert'), patch: MutableSchema.partial() }).strict(),
]);
export type Edit = z.infer<typeof EditSchema> & Command;
export const AckSchema = z.object({
  seq: z.number(),
  opId: IdSchema,
  kind: z.string(),
  objectId: IdSchema,
  prev: z.array(z.object({ objectId: IdSchema, before: ViewObjectSchema.nullable(), after: ViewObjectSchema })),
});
export type Acknowledged = z.infer<typeof AckSchema>;
export type QueueStatus = 'saved' | 'saving' | 'failed' | 'refused' | 'offline';
const StoredSchema = z.object({ operations: z.array(EditSchema), refusal: z.string().nullable() });
export class Refused extends Error {}
export class EditQueue {
  private base: Snapshot = { seq: 0, objects: [] };
  private pending: Edit[] = [];
  private refusal: string | null = null;
  private flight = false;
  private connected = false;
  private failure = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  constructor(
    private options: {
      storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
      key: string;
      send: (operations: Edit[], since: number) => Promise<Acknowledged[]>;
      display: (objects: ViewObject[]) => void;
      status: (status: QueueStatus, message: string) => void;
      acknowledged: (operations: Acknowledged[]) => void;
      id?: () => string;
    }
  ) {
    const raw = options.storage.getItem(options.key);
    if (raw) {
      try {
        const stored = StoredSchema.parse(JSON.parse(raw));
        this.pending = stored.operations;
        this.refusal = stored.refusal;
      } catch {
        this.refusal = 'Saved edits could not be read. Discard them before editing.';
      }
    }
  }
  receive(snapshot: Snapshot): void {
    if (snapshot.seq >= this.base.seq) this.base = snapshot;
    this.render();
  }
  online(connected: boolean): void {
    this.connected = connected;
    this.render();
    if (connected) void this.flush();
  }
  enqueue(operations: Edit[]): boolean {
    if (!this.connected || this.refusal) {
      this.options.status(
        this.connected ? 'refused' : 'offline',
        this.refusal ?? 'Offline. Reconnect before making a new edit.'
      );
      return false;
    }
    this.pending.push(
      ...operations.map((op) =>
        EditSchema.parse({ ...op, opId: op.opId || (this.options.id?.() ?? crypto.randomUUID()) })
      )
    );
    if (!this.persist()) {
      this.pending.splice(-operations.length);
      this.render();
      this.options.status('failed', 'Edit was not sent because local draft storage is unavailable.');
      return false;
    }
    this.render();
    void this.flush();
    return true;
  }
  retry(): void {
    this.refusal = null;
    this.failure = false;
    this.persist();
    this.render();
    void this.flush();
  }
  discard(): void {
    if (this.flight) return;
    this.pending = [];
    this.refusal = null;
    this.failure = false;
    this.persist();
    this.render();
  }
  get busy(): boolean {
    return this.pending.length > 0 || this.flight;
  }
  private persist(): boolean {
    try {
      if (this.pending.length || this.refusal)
        this.options.storage.setItem(
          this.options.key,
          JSON.stringify({ operations: this.pending, refusal: this.refusal })
        );
      else this.options.storage.removeItem(this.options.key);
      return true;
    } catch {
      return false;
    }
  }
  private render(): void {
    this.options.display(this.refusal ? this.base.objects : optimistic(this.base.objects, this.pending));
    const status: QueueStatus = !this.connected
      ? 'offline'
      : this.refusal
        ? 'refused'
        : this.failure
          ? 'failed'
          : this.pending.length
            ? 'saving'
            : 'saved';
    this.options.status(
      status,
      this.refusal ??
        (status === 'offline'
          ? 'Offline. Pending edits and drafts are retained.'
          : status === 'failed'
            ? 'Save failed. Your edits are retained; retry or discard.'
            : status === 'saving'
              ? 'Saving…'
              : 'Saved')
    );
  }
  private async flush(): Promise<void> {
    if (this.stopped || this.flight || !this.connected || this.refusal || !this.pending.length) return;
    this.flight = true;
    this.failure = false;
    const batch = this.pending.slice();
    try {
      const acknowledged = await this.options.send(batch, this.base.seq);
      const ids = new Set(acknowledged.map((op) => op.opId));
      if (!batch.every((op) => ids.has(op.opId))) throw new Error('Acknowledgement missing');
      const objects = new Map(this.base.objects.map((o) => [o.id, o]));
      for (const op of acknowledged) {
        if (op.seq > this.base.seq) for (const change of op.prev) objects.set(change.objectId, change.after);
      }
      this.base = { seq: Math.max(this.base.seq, ...acknowledged.map((op) => op.seq)), objects: [...objects.values()] };
      this.pending = this.pending.filter((op) => !ids.has(op.opId));
      this.options.acknowledged(acknowledged.filter((op) => batch.some((edit) => edit.opId === op.opId)));
    } catch (error) {
      if (error instanceof Refused) this.refusal = error.message;
      else this.failure = true;
    } finally {
      this.flight = false;
      this.persist();
      this.render();
      if (!this.failure) void this.flush();
      else if (!this.stopped)
        this.timer = setTimeout(() => {
          void this.flush();
        }, 1500);
    }
  }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
export function optimistic(source: ViewObject[], operations: Edit[]): ViewObject[] {
  const objects = new Map(source.map((o) => [o.id, o]));
  for (const op of operations) {
    const current = objects.get(op.objectId);
    if (op.kind === 'create') {
      objects.set(op.objectId, {
        ...op.patch,
        size: op.patch.size ?? { width: 240, height: 160 },
        id: op.objectId,
        type: op.patch.content.type,
        author: { kind: 'human', userId: 'You' },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        deletedAt: null,
      });
    } else if (current) {
      if (op.kind === 'delete' || op.kind === 'restore') {
        const ids = new Set([current.id]);
        for (let changed = true; changed; ) {
          changed = false;
          for (const o of objects.values())
            if (o.parentId && ids.has(o.parentId) && !ids.has(o.id)) {
              ids.add(o.id);
              changed = true;
            }
        }
        for (const id of ids) {
          const o = objects.get(id);
          if (o) objects.set(id, { ...o, deletedAt: op.kind === 'delete' ? Date.now() : null });
        }
      } else if (op.kind === 'reparent') {
        const position = op.patch.preserveWorld
          ? reparentPosition([...objects.values()], current, op.patch.parentId)
          : current.position;
        objects.set(current.id, { ...current, parentId: op.patch.parentId, order: op.patch.order, position });
      } else objects.set(current.id, { ...current, ...op.patch });
    }
  }
  return [...objects.values()].filter((o) => o.deletedAt === null);
}
export async function sendEdits(
  url: (path: string) => string,
  workspace: string,
  operations: Edit[],
  since: number
): Promise<Acknowledged[]> {
  const response = await fetch(url(`/api/canvas/${workspace}/ops`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operations }),
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const reason = z
      .object({ error: z.string(), reasons: z.array(z.object({ message: z.string() })).optional() })
      .safeParse(payload);
    if (response.status >= 400 && response.status < 500)
      throw new Refused(
        `Edit refused: ${reason.success ? reason.data.reasons?.map((r) => r.message).join('; ') || reason.data.error : 'the server rejected this write'}.`
      );
    throw new Error('Save failed');
  }
  const history = await fetch(url(`/api/canvas/${workspace}/ops?since=${since}`));
  if (!history.ok) throw new Error('Acknowledgement failed');
  const schema = z.object({ data: z.object({ operations: z.array(AckSchema) }) });
  const acknowledged = schema.parse(await history.json()).data.operations;
  if (operations.every((edit) => acknowledged.some((op) => op.opId === edit.opId))) return acknowledged;
  const full = await fetch(url(`/api/canvas/${workspace}/ops?since=0`));
  if (!full.ok) throw new Error('Acknowledgement recovery failed');
  return schema.parse(await full.json()).data.operations;
}
export const parseSnapshot = (payload: unknown): Snapshot => z.object({ data: SnapshotSchema }).parse(payload).data;
