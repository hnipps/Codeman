import { z } from 'zod';
import { IdSchema, MutableSchema } from '../../../src/canvas/model.js';
import type { CanvasToolName } from '../../../src/canvas/commands.js';
import type { toolSchemas } from '../../../src/canvas/commands.js';
import type { Command } from '../../../src/canvas/operations.js';
import { SnapshotSchema, ViewObjectSchema, type Snapshot, type ViewObject } from './model.js';
import { reparentPosition, worldOrigin } from './drag.js';
import { fetchHistory } from './sync.js';
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
export type CanvasRequest = {
  [Name in CanvasToolName]: { tool: Name; arguments: z.input<(typeof toolSchemas)[Name]> };
}[CanvasToolName];
const RequestSchema = z.object({
  tool: z.enum([
    'canvas_create',
    'canvas_update',
    'canvas_delete',
    'canvas_arrange',
    'canvas_transform',
    'canvas_lock',
    'canvas_history',
  ]),
  arguments: z.unknown(),
  requestId: z.uuid(),
});
export type QueuedRequest = z.infer<typeof RequestSchema>;
export type CommandAcknowledgement = { records: Acknowledged[]; sequences: number[] };
const StoredSchema = z.object({
  requests: z.record(z.string(), RequestSchema).default({}),
  operations: z.array(EditSchema),
  refusal: z.string().nullable(),
  batchSizes: z.array(z.number().int().positive()).default([]),
});
export const RefusalReasonSchema = z.object({
  code: z.string().optional(),
  objectId: z.string().optional(),
  message: z.string(),
  dependents: z.array(z.object({ objectId: z.string() })).optional(),
});
export type RefusalReason = z.infer<typeof RefusalReasonSchema>;
const RefusalSchema = z.object({ error: z.string(), reasons: z.array(RefusalReasonSchema).optional() });
export class Refused extends Error {
  constructor(
    message: string,
    readonly reasons: RefusalReason[] = []
  ) {
    super(message);
  }
}
export class EditQueue {
  private requests: Record<string, QueuedRequest> = {};
  private base: Snapshot = { seq: 0, objects: [] };
  private pending: Edit[] = [];
  private batchSizes: number[] = [];
  /** Storage trouble that stops editing until the user discards. */
  private blocker: string | null = null;
  /** The last server refusal. Informational only: the refused submission is already gone from the queue. */
  private notice: string | null = null;
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
      sendCommand?: (request: QueuedRequest, since: number) => Promise<CommandAcknowledgement>;
      display: (objects: ViewObject[]) => void;
      status: (status: QueueStatus, message: string) => void;
      acknowledged: (operations: Acknowledged[]) => void;
      refused?: (operations: Edit[], message: string, reasons: RefusalReason[]) => void;
      describe?: (operations: Edit[], request: QueuedRequest | undefined, error: Refused) => string;
      id?: () => string;
    }
  ) {
    let raw: string | null = null;
    try {
      raw = options.storage.getItem(options.key);
    } catch {
      this.blocker = 'Draft storage is unavailable. Editing is paused until storage is available.';
    }
    if (raw) {
      try {
        const stored = StoredSchema.parse(JSON.parse(raw));
        this.pending = stored.operations;
        this.requests = stored.requests;
        this.batchSizes =
          stored.batchSizes.reduce((sum, size) => sum + size, 0) === this.pending.length
            ? stored.batchSizes
            : this.pending.length
              ? [this.pending.length]
              : [];
        // Written by an earlier build: a stored refusal names the head batch, which the server already refused.
        if (stored.refusal && this.batchSizes.length) {
          this.notice = stored.refusal;
          this.dropRefused();
        }
      } catch {
        this.blocker = 'Saved edits could not be read. Discard them before editing.';
      }
    }
  }
  receive(snapshot: Snapshot): void {
    if (snapshot.seq >= this.base.seq) {
      const ids = new Set(snapshot.objects.map((o) => o.id));
      this.base = {
        seq: snapshot.seq,
        objects: [...this.base.objects.filter((o) => o.deletedAt !== null && !ids.has(o.id)), ...snapshot.objects],
      };
    }
    this.render();
  }
  online(connected: boolean): void {
    this.connected = connected;
    this.render();
    if (connected) void this.flush();
  }
  enqueue(operations: Edit[]): boolean {
    if (!operations.length) return true;
    if (!this.connected || this.blocker) {
      this.options.status(
        this.connected ? 'refused' : 'offline',
        this.blocker ?? 'Offline. Reconnect before making a new edit.'
      );
      return false;
    }
    this.notice = null;
    const edits = z
      .array(EditSchema)
      .max(1000)
      .parse(operations.map((op) => ({ ...op, opId: op.opId || (this.options.id?.() ?? crypto.randomUUID()) })));
    this.batchSizes.push(edits.length);
    this.pending.push(...edits);
    if (!this.persist()) {
      this.pending.splice(-operations.length);
      this.batchSizes.pop();
      this.render();
      this.options.status('failed', 'Edit was not sent because local draft storage is unavailable.');
      return false;
    }
    this.render();
    void this.flush();
    return true;
  }
  enqueueCommand(request: CanvasRequest): boolean {
    const requestId = crypto.randomUUID();
    this.requests[requestId] = RequestSchema.parse({ ...request, requestId });
    const accepted = this.enqueue([{ kind: 'revert', opId: requestId, objectId: requestId, patch: {} }]);
    if (!accepted) delete this.requests[requestId];
    return accepted;
  }
  retry(): void {
    this.notice = null;
    this.failure = false;
    this.persist();
    this.render();
    void this.flush();
  }
  discard(): void {
    if (this.flight) return;
    this.pending = [];
    this.requests = {};
    this.batchSizes = [];
    this.blocker = null;
    this.notice = null;
    this.failure = false;
    this.persist();
    this.render();
  }
  get busy(): boolean {
    return this.pending.length > 0 || this.flight;
  }
  get blocked(): boolean {
    return this.blocker !== null;
  }
  /** Whether an operation is still queued or in flight. A draft's sent marker is only valid while this holds. */
  holds(opId: string): boolean {
    return this.pending.some((op) => op.opId === opId);
  }
  /**
   * Removes the head batch and every later batch that provably depends on it: an edit of, or under, an object
   * the dropped batches would have created. Unrelated queued edits stay, in order.
   */
  private dropRefused(): Edit[] {
    const batches: Edit[][] = [];
    let offset = 0;
    for (const size of this.batchSizes) {
      batches.push(this.pending.slice(offset, offset + size));
      offset += size;
    }
    const [head = [], ...rest] = batches;
    const dropped = [...head];
    const created = new Set(head.filter((op) => op.kind === 'create').map((op) => op.objectId));
    for (const id of requestCreates(this.requests[head[0]?.opId ?? ''])) created.add(id);
    delete this.requests[head[0]?.opId ?? ''];
    const kept: Edit[][] = [];
    for (const batch of rest) {
      const request = this.requests[batch[0].opId];
      const mentions = request ? requestIds(request.arguments) : new Set<string>();
      const depends = batch.some(
        (op) =>
          (op.kind !== 'create' && created.has(op.objectId)) ||
          ((op.kind === 'create' || op.kind === 'reparent') && created.has(op.patch.parentId ?? '')) ||
          [...mentions].some((id) => created.has(id))
      );
      if (!depends) {
        kept.push(batch);
        continue;
      }
      dropped.push(...batch);
      for (const id of requestCreates(request)) created.add(id);
      delete this.requests[batch[0].opId];
      for (const op of batch) if (op.kind === 'create') created.add(op.objectId);
    }
    this.pending = kept.flat();
    this.batchSizes = kept.map((batch) => batch.length);
    return dropped;
  }
  private persist(): boolean {
    try {
      if (this.pending.length)
        this.options.storage.setItem(
          this.options.key,
          JSON.stringify({
            operations: this.pending,
            refusal: null,
            batchSizes: this.batchSizes,
            requests: this.requests,
          })
        );
      else this.options.storage.removeItem(this.options.key);
      return true;
    } catch {
      return false;
    }
  }
  private render(): void {
    this.options.display(
      this.blocker ? this.base.objects.filter((o) => o.deletedAt === null) : optimistic(this.base.objects, this.pending)
    );
    const status: QueueStatus = !this.connected
      ? 'offline'
      : this.blocker
        ? 'refused'
        : this.failure
          ? 'failed'
          : this.pending.length
            ? 'saving'
            : this.notice
              ? 'refused'
              : 'saved';
    this.options.status(
      status,
      (status === 'refused' ? (this.blocker ?? this.notice) : null) ??
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
    if (this.stopped || this.flight || !this.connected || this.blocker || !this.pending.length) return;
    this.flight = true;
    this.failure = false;
    this.options.status('saving', 'Saving…');
    const batch = this.pending.slice(0, this.batchSizes[0] ?? this.pending.length);
    try {
      const request = this.requests[batch[0].opId];
      let acknowledged: Acknowledged[];
      let mine: Acknowledged[];
      if (request) {
        const result = await this.sendCommand(request);
        const wanted = new Set(result.sequences);
        acknowledged = result.records;
        mine = acknowledged.filter((op) => wanted.has(op.seq));
      } else {
        acknowledged = await this.options.send(batch, this.base.seq);
        const ids = new Set(acknowledged.map((op) => op.opId));
        if (!batch.every((op) => ids.has(op.opId))) throw new Error('Acknowledgement missing');
        mine = acknowledged.filter((op) => batch.some((edit) => edit.opId === op.opId));
      }
      const objects = new Map(this.base.objects.map((o) => [o.id, o]));
      for (const op of acknowledged) {
        if (op.seq > this.base.seq) for (const change of op.prev) objects.set(change.objectId, change.after);
      }
      this.base = { seq: Math.max(this.base.seq, ...acknowledged.map((op) => op.seq)), objects: [...objects.values()] };
      const batchIds = new Set(batch.map((op) => op.opId));
      this.pending = this.pending.filter((op) => !batchIds.has(op.opId));
      this.batchSizes.shift();
      delete this.requests[batch[0].opId];
      this.notice = null;
      this.options.acknowledged(mine);
    } catch (error) {
      if (error instanceof Refused) {
        const request = this.requests[batch[0].opId];
        const notice = this.options.describe?.(batch, request, error) ?? error.message;
        const dropped = this.dropRefused();
        this.notice = notice;
        this.options.refused?.(dropped, notice, error.reasons);
      } else this.failure = true;
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
  private sendCommand(request: QueuedRequest): Promise<CommandAcknowledgement> {
    if (!this.options.sendCommand) throw new Error('Command transport unavailable');
    return this.options.sendCommand(request, this.base.seq);
  }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
/** Every string id a compound's arguments name, found by walking the value, never by searching its text. */
export function requestIds(value: unknown, found = new Set<string>(), depth = 0): Set<string> {
  if (depth > 32 || found.size > 20_000) return found;
  if (typeof value === 'string') {
    if (IdSchema.safeParse(value).success) found.add(value);
  } else if (Array.isArray(value)) for (const item of value) requestIds(item, found, depth + 1);
  else if (value && typeof value === 'object')
    for (const [key, item] of Object.entries(value)) {
      // Free text (labels, text, URLs) can contain anything; only identifier fields name objects.
      if (/^(id|objectId|parentId|groupId|targetIds|ids|operations|patch)$/.test(key))
        requestIds(item, found, depth + 1);
    }
  return found;
}
/** Ids a compound would have created: its create operations and a client-chosen group id. */
export function requestCreates(request: QueuedRequest | undefined): string[] {
  if (!request) return [];
  const args = request.arguments as { operations?: unknown; groupId?: unknown; action?: unknown } | null;
  const ids: string[] = [];
  if (args && typeof args.groupId === 'string') ids.push(args.groupId);
  if (args && Array.isArray(args.operations))
    for (const op of args.operations)
      if (op && typeof op === 'object' && (op as { kind?: unknown }).kind === 'create') {
        const objectId = (op as { objectId?: unknown }).objectId;
        if (typeof objectId === 'string') ids.push(objectId);
      }
  return ids;
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
        const parent = objects.get(op.patch.parentId ?? '');
        const rotation = op.patch.preserveWorld
          ? worldOrigin([...objects.values()], current).rotation -
            (parent ? worldOrigin([...objects.values()], parent).rotation : 0)
          : current.rotation;
        objects.set(current.id, { ...current, parentId: op.patch.parentId, order: op.patch.order, position, rotation });
      } else {
        const next = { ...current, ...op.patch };
        // A link and an embed change into each other; the object type follows its content.
        if (op.kind === 'update' && op.patch.content && op.patch.content.type !== current.type)
          next.type = op.patch.content.type;
        objects.set(current.id, next);
      }
    }
  }
  return [...objects.values()].filter((o) => o.deletedAt === null);
}
const parseAcks = (records: unknown[]): Acknowledged[] =>
  records.flatMap((record) => {
    const parsed = AckSchema.safeParse(record);
    return parsed.success ? [parsed.data] : [];
  });
const WriteSchema = z.object({
  data: z.object({ seq: z.number(), sequences: z.array(z.number()).optional(), noop: z.boolean().optional() }),
});
/** Catch up from the earlier of the client's sequence and just before what this write produced. */
const catchUpFrom = (since: number, sequences: number[]): number =>
  Math.max(0, Math.min(since, ...sequences.map((seq) => seq - 1)));
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
    const reason = RefusalSchema.safeParse(payload);
    if (response.status >= 400 && response.status < 500) throw refusedFrom(reason.success ? reason.data : null);
    throw new Error('Save failed');
  }
  const written = WriteSchema.parse(payload).data;
  const sequences = written.sequences ?? [];
  const history = await fetchHistory(
    url,
    workspace,
    catchUpFrom(since, sequences),
    undefined,
    sequences.length ? Math.max(...sequences) : written.seq
  );
  return parseAcks(history.operations);
}
function refusedFrom(payload: z.infer<typeof RefusalSchema> | null): Refused {
  if (!payload) return new Refused('Edit refused by the server.');
  const reasons = payload.reasons ?? [];
  return new Refused(reasons.map((r) => r.message).join('; ') || payload.error, reasons);
}
export const parseSnapshot = (payload: unknown): Snapshot => z.object({ data: SnapshotSchema }).parse(payload).data;

export async function sendCommand(
  url: (path: string) => string,
  workspace: string,
  request: QueuedRequest,
  since: number
): Promise<CommandAcknowledgement> {
  const response = await fetch(url(`/api/canvas/${workspace}/command`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    if (response.status >= 500) throw new Error('Command save failed');
    const refused = RefusalSchema.safeParse(payload);
    throw refusedFrom(refused.success ? refused.data : null);
  }
  const sequences = WriteSchema.parse(payload).data.sequences ?? [];
  if (!sequences.length) return { records: [], sequences: [] };
  const history = await fetchHistory(url, workspace, catchUpFrom(since, sequences), undefined, Math.max(...sequences));
  const records = parseAcks(history.operations);
  const found = new Set(records.map((op) => op.seq));
  if (!sequences.every((seq) => found.has(seq))) throw new Error('Command acknowledgement missing');
  return { records, sequences };
}
