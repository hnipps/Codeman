/** @fileoverview Synchronous single-writer log transactions and replaceable snapshots. */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { dataPath } from '../config/instance.js';
import { deployRole, DeployRoleRefusal } from '../deploy-role.js';
import {
  AuthorSchema,
  IdSchema,
  StateSchema,
  indexKnownObjects,
  classifyObject,
  walkHierarchy,
  hierarchyCycles,
  emptyState,
  sameAuthor,
  type Author,
  type CanvasState,
} from './model.js';
import {
  CommandSchema,
  MAX_CALLER_OPERATIONS,
  MAX_EXPANDED_OPERATIONS,
  OperationSchema,
  knownKinds,
  revertAuthor,
  validateBatch,
  type Command,
  type Operation,
  type BatchResult,
} from './operations.js';

export function requireCanvasWriter(): void {
  if (!deployRole.allows('persist')) throw new DeployRoleRefusal(deployRole.current, 'may write canvas data');
}
export function atomicWrite(path: string, value: unknown): void {
  requireCanvasWriter();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    const fd = openSync(tmp, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}
const SnapshotSchema = z.object({ version: z.literal(1), state: StateSchema });
const EnvelopeSchema = z.object({ version: z.literal(1), operations: z.array(z.unknown()).min(1) });
const ReplayHeaderSchema = z
  .object({ seq: z.number().int().positive(), kind: z.string(), opId: IdSchema })
  .passthrough();
type FutureOperation = z.infer<typeof ReplayHeaderSchema>;
export type AppendResult =
  | { ok: true; seq: number; operations: Operation[]; sequences: number[] }
  | Extract<BatchResult, { ok: false }>;
/** One `/ops` answer holds at most this many records, and this many serialized bytes unless one record is larger. */
export const MAX_OPS_PAGE_RECORDS = 500;
export const MAX_OPS_PAGE_BYTES = 1024 * 1024;
export type OperationsPage = { records: string[]; more: boolean; next: number };

function replayInto(state: CanvasState, op: Operation): void {
  for (const change of op.prev) {
    classifyObject(state, change.after);
    state.objects[change.objectId] = change.after;
  }
  if (op.comment) state.comments.push(op.comment);
  if (op.removedComment) state.comments = state.comments.filter((c) => c.id !== op.removedComment?.id);
  state.seq = op.seq;
}

export class CanvasStore {
  private reportedUnsafeHierarchy = new Set<string>();
  private state: CanvasState = emptyState();
  private log: Operation[] = [];
  private futureLog: FutureOperation[] = [];
  private ordered: (Operation | FutureOperation)[] = [];
  private seen = new Map<string, { seq: number; author?: Author }>();
  private tornOffset: number | undefined;
  readonly logPath: string;
  readonly snapshotPath: string;

  constructor(readonly workspaceId: string) {
    IdSchema.parse(workspaceId);
    this.logPath = dataPath('canvas', workspaceId, 'ops.jsonl');
    this.snapshotPath = dataPath('canvas', workspaceId, 'snapshot.json');
    this.reload();
  }
  read(): CanvasState {
    return structuredClone(this.state);
  }
  get seq(): number {
    return this.state.seq;
  }
  private firstAfter(since: number): number {
    let low = 0;
    let high = this.ordered.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.ordered[mid].seq > since) high = mid;
      else low = mid + 1;
    }
    return low;
  }
  operations(since = 0): (Operation | FutureOperation)[] {
    return structuredClone(this.ordered.slice(this.firstAfter(since)));
  }
  /** Records after `since`, serialized once, capped by MAX_OPS_PAGE_RECORDS and MAX_OPS_PAGE_BYTES. */
  page(since: number): OperationsPage {
    const records: string[] = [];
    let bytes = 0;
    let index = this.firstAfter(since);
    let next = since;
    for (; index < this.ordered.length && records.length < MAX_OPS_PAGE_RECORDS; index++) {
      const json = JSON.stringify(this.ordered[index]);
      const size = Buffer.byteLength(json) + 1;
      if (records.length && bytes + size > MAX_OPS_PAGE_BYTES) break;
      records.push(json);
      bytes += size;
      next = this.ordered[index].seq;
    }
    return { records, more: index < this.ordered.length, next };
  }
  /** Copies of the records at these sequences, for history commands that must not clone the whole log. */
  records(sequences: number[]): (Operation | FutureOperation)[] {
    return structuredClone(
      [...new Set(sequences)].flatMap((seq) => {
        const record = this.ordered[this.firstAfter(seq - 1)];
        return record?.seq === seq ? [record] : [];
      })
    );
  }
  /** Sequences already written under a request-id prefix, read from the opId index. */
  sequencesWithPrefix(prefix: string): { opId: string; seq: number }[] {
    const found: { opId: string; seq: number }[] = [];
    for (const [opId, entry] of this.seen) if (opId.startsWith(prefix)) found.push({ opId, seq: entry.seq });
    return found.sort((a, b) => a.seq - b.seq);
  }
  revertCommands(target: Author): Command[] {
    return revertAuthor(this.state, this.log, target);
  }
  reload(): void {
    let state = emptyState();
    if (existsSync(this.snapshotPath))
      state = SnapshotSchema.parse(JSON.parse(readFileSync(this.snapshotPath, 'utf8'))).state;
    indexKnownObjects(state);
    const snapshotSeq = state.seq;
    const log: Operation[] = [];
    const futureLog: FutureOperation[] = [];
    const seen = new Map<string, { seq: number; author?: Author }>();
    this.tornOffset = undefined;
    const raw = existsSync(this.logPath) ? readFileSync(this.logPath, 'utf8') : '';
    const rawBytes = Buffer.byteLength(raw);
    let offset = 0;
    for (const line of raw.split('\n')) {
      if (!line) {
        offset++;
        continue;
      }
      if (offset + Buffer.byteLength(line) >= rawBytes && !raw.endsWith('\n')) {
        this.tornOffset = offset;
        console.warn('[canvas] Ignoring torn final operation line');
        break;
      }
      const parsed: unknown = JSON.parse(line);
      const records =
        parsed !== null && typeof parsed === 'object' && 'operations' in parsed
          ? EnvelopeSchema.parse(parsed).operations
          : [parsed];
      for (const record of records) {
        const header = ReplayHeaderSchema.parse(record);
        if (!knownKinds.has(header.kind)) {
          futureLog.push(header);
          seen.set(header.opId, { seq: header.seq });
          state.seq = Math.max(state.seq, header.seq);
          continue;
        }
        const op = OperationSchema.parse(record);
        seen.set(op.opId, { seq: op.seq, author: op.author });
        log.push(op);
        if (op.seq > snapshotSeq) {
          replayInto(state, op);
        }
      }
      offset += Buffer.byteLength(line) + 1;
    }
    const cycles = hierarchyCycles(state);
    const unsafe = new Set(cycles.cycles);
    for (const id of Object.keys(state.objects)) {
      if (cycles.affected.has(id)) continue;
      const walk = walkHierarchy(state, [id], 'parents');
      for (const member of walk.cycles) unsafe.add(member);
      if (walk.issue?.code === 'HIERARCHY_LIMIT') unsafe.add(id);
    }
    const unreported = [...unsafe].filter((id) => !this.reportedUnsafeHierarchy.has(id));
    if (unreported.length) {
      console.warn('[canvas] Cyclic or over-limit hierarchy is read-only', {
        workspaceId: this.workspaceId,
        objectIds: unreported,
      });
      for (const id of unreported) this.reportedUnsafeHierarchy.add(id);
    }
    this.state = state;
    this.log = log;
    this.futureLog = futureLog;
    this.ordered = [...log, ...futureLog].sort((a, b) => a.seq - b.seq);
    this.seen = seen;
  }
  append(input: Command[], author: Author): AppendResult {
    return this.appendBatch(input, author, MAX_CALLER_OPERATIONS);
  }
  appendExpanded(input: Command[], author: Author): AppendResult {
    return this.appendBatch(input, author, MAX_EXPANDED_OPERATIONS);
  }
  private appendBatch(input: Command[], author: Author, limit: number): AppendResult {
    requireCanvasWriter();
    author = AuthorSchema.parse(author);
    const commands = z.array(CommandSchema).max(limit).parse(input);
    const duplicates = commands.map((c) => this.seen.get(c.opId));
    if (duplicates.some(Boolean)) {
      if (!duplicates.every((d) => d?.author && sameAuthor(d.author, author)))
        return {
          ok: false,
          reasons: [
            {
              code: 'DUPLICATE',
              objectId: commands[0]?.objectId ?? '',
              message: 'Batch mixes new operations or another author with repeated ids',
            },
          ],
        };
      return {
        ok: true,
        seq: Math.max(0, ...duplicates.map((d) => d?.seq ?? 0)),
        operations: [],
        sequences: [...new Set(duplicates.map((d) => d?.seq ?? 0))],
      };
    }
    if (new Set(commands.map((c) => c.opId)).size !== commands.length)
      return {
        ok: false,
        reasons: [
          {
            code: 'DUPLICATE',
            objectId: commands[0]?.objectId ?? '',
            message: 'Operation ids must be unique in a batch',
          },
        ],
      };
    const result = validateBatch(this.state, commands, author, Date.now());
    if (!result.ok) return result;
    if (!result.operations.length) return { ok: true, seq: this.state.seq, operations: [], sequences: [] };
    requireCanvasWriter();
    mkdirSync(dirname(this.logPath), { recursive: true, mode: 0o700 });
    if (this.tornOffset !== undefined) truncateSync(this.logPath, this.tornOffset);
    const payload =
      result.operations.length === 1 ? result.operations[0] : { version: 1, operations: result.operations };
    const fd = openSync(this.logPath, 'a', 0o600);
    try {
      appendFileSync(fd, `${JSON.stringify(payload)}\n`);
    } catch (error) {
      this.reload();
      throw error;
    } finally {
      closeSync(fd);
    }
    this.tornOffset = undefined;
    for (const operation of result.operations) replayInto(this.state, operation);
    this.log.push(...result.operations);
    this.ordered.push(...result.operations);
    for (const op of result.operations) this.seen.set(op.opId, { seq: op.seq, author: op.author });
    return {
      ok: true,
      seq: this.state.seq,
      operations: structuredClone(result.operations),
      sequences: result.operations.map((op) => op.seq),
    };
  }
  revert(target: Author, actor: Author): AppendResult {
    return this.appendExpanded(this.revertCommands(target), actor);
  }
  snapshot(): void {
    requireCanvasWriter();
    if (existsSync(this.logPath)) {
      const fd = openSync(this.logPath, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    // The current state omits future effects; retaining the previous checkpoint keeps them replayable.
    if (this.futureLog.length) return;
    atomicWrite(this.snapshotPath, { version: 1, state: this.state });
  }
}

export class CanvasStores {
  private stores = new Map<string, CanvasStore>();
  get(id: string): CanvasStore {
    let store = this.stores.get(id);
    if (!store) {
      store = new CanvasStore(id);
      this.stores.set(id, store);
    }
    return store;
  }
  reload(): void {
    for (const store of this.stores.values()) store.reload();
  }
  flush(): void {
    if (!deployRole.allows('persist')) return;
    for (const store of this.stores.values()) store.snapshot();
  }
}
