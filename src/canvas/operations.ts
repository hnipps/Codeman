/** @fileoverview Pure atomic command validation, replay and field-aware history. */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  AuthorSchema,
  CommentSchema,
  IdSchema,
  MutableSchema,
  ObjectSchema,
  StoredObjectSchema,
  isKnownObject,
  validateKnownObject,
  knownContentFields,
  descendants,
  effectiveLock,
  isContainer,
  sameAuthor,
  worldTransform,
  type Author,
  type CanvasObject,
  type CanvasState,
} from './model.js';

const fields = { opId: IdSchema, objectId: IdSchema, expectedRevision: z.number().int().nonnegative().optional() };
export const CommandSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...fields,
      kind: z.literal('create'),
      patch: MutableSchema.omit({ deletedAt: true, deletionOpId: true }).extend({
        size: MutableSchema.shape.size.optional(),
        rotation: z.number().finite().default(0),
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
  z.object({ ...fields, kind: z.literal('reorder'), patch: MutableSchema.pick({ order: true }) }).strict(),
  z
    .object({
      ...fields,
      kind: z.literal('lock'),
      patch: z.object({ mode: z.enum(['subtree', 'background']) }).strict(),
    })
    .strict(),
  z.object({ ...fields, kind: z.literal('unlock') }).strict(),
  z.object({ ...fields, kind: z.literal('delete') }).strict(),
  z.object({ ...fields, kind: z.literal('restore') }).strict(),
  z
    .object({
      ...fields,
      kind: z.literal('comment'),
      patch: z.object({ id: IdSchema, text: z.string().max(100_000) }).strict(),
    })
    .strict(),
  z.object({ ...fields, kind: z.literal('remove-comment'), patch: z.object({ id: IdSchema }).strict() }).strict(),
  z.object({ ...fields, kind: z.literal('revert'), patch: MutableSchema.partial() }).strict(),
]);
export type Command = z.infer<typeof CommandSchema>;
export const ChangeSchema = z
  .object({ objectId: IdSchema, before: StoredObjectSchema.nullable(), after: StoredObjectSchema })
  .passthrough();
export const OperationSchema = z
  .object({
    seq: z.number().int().positive(),
    opId: IdSchema,
    author: AuthorSchema,
    kind: z.string(),
    objectId: IdSchema,
    patch: z.unknown(),
    prev: z.array(ChangeSchema),
    comment: CommentSchema.optional(),
    removedComment: CommentSchema.optional(),
  })
  .passthrough();
export type Operation = z.infer<typeof OperationSchema>;
export const knownKinds: ReadonlySet<string> = new Set(CommandSchema.options.map((o) => o.shape.kind.value));
export type Rejection = {
  code: 'LOCKED' | 'CYCLE' | 'REVISION' | 'NOT_FOUND' | 'INVALID' | 'DUPLICATE';
  objectId: string;
  message: string;
};
export type BatchResult =
  | { ok: true; state: CanvasState; operations: Operation[] }
  | { ok: false; reasons: Rejection[] };
const equal = isDeepStrictEqual;
const mutableKeys = Object.keys(MutableSchema.shape) as (keyof z.infer<typeof MutableSchema>)[];

export function applyOperation(state: CanvasState, op: Operation): CanvasState {
  if (!knownKinds.has(op.kind)) return { ...state, seq: Math.max(state.seq, op.seq) };
  const objects = { ...state.objects };
  for (const change of op.prev) objects[change.objectId] = change.after;
  return {
    seq: op.seq,
    objects,
    comments: op.comment
      ? [...state.comments, op.comment]
      : op.removedComment
        ? state.comments.filter((c) => c.id !== op.removedComment?.id)
        : state.comments,
  };
}

function hierarchyReason(state: CanvasState, o: CanvasObject): Rejection | null {
  let parent = o.parentId;
  const seen = new Set([o.id]);
  while (parent !== null) {
    if (seen.has(parent)) return { code: 'CYCLE', objectId: o.id, message: 'Parent would create a cycle' };
    seen.add(parent);
    const p = state.objects[parent];
    if (!p || !isContainer(p) || (o.deletedAt === null && p.deletedAt !== null))
      return { code: 'INVALID', objectId: o.id, message: 'Parent must be an existing live container' };
    parent = p.parentId;
  }
  return null;
}

export function validateBatch(initial: CanvasState, commands: Command[], author: Author, now = 0): BatchResult {
  const staged = new Map<string, CanvasObject>();
  const objects = new Proxy<Record<string, CanvasObject>>(
    {},
    {
      get: (_target, key) =>
        typeof key === 'string' && staged.has(key) ? staged.get(key) : Reflect.get(initial.objects, key),
      ownKeys: () => [...new Set([...Object.keys(initial.objects), ...staged.keys()])],
      getOwnPropertyDescriptor: (_target, key) =>
        typeof key === 'string' && (staged.has(key) || Object.hasOwn(initial.objects, key))
          ? { configurable: true, enumerable: true, value: staged.get(key) ?? initial.objects[key] }
          : undefined,
    }
  );
  let state = { ...initial, objects };
  const operations: Operation[] = [];
  for (const command of commands) {
    const reject = (code: Rejection['code'], message: string): BatchResult => ({
      ok: false,
      reasons: [{ code, objectId: command.objectId, message }],
    });
    const current = state.objects[command.objectId];
    if (command.kind === 'create' ? !!current : !current)
      return reject(command.kind === 'create' ? 'DUPLICATE' : 'NOT_FOUND', 'Object identity is unavailable');
    if (current && !isKnownObject(current)) return reject('INVALID', 'Unknown object type is read-only');
    if (current && command.expectedRevision !== undefined && command.expectedRevision !== current.revision)
      return reject('REVISION', 'Object revision changed');
    if (
      current?.deletedAt !== undefined &&
      current.deletedAt !== null &&
      !['restore', 'revert', 'remove-comment'].includes(command.kind)
    )
      return reject('INVALID', 'Restore a deleted object before editing it');
    if (current?.deletedAt === null && command.kind === 'restore') return reject('INVALID', 'Object is not deleted');
    const changes: Operation['prev'] = [];
    let comment: Operation['comment'];
    let removedComment: Operation['removedComment'];
    let proposed: CanvasObject;
    if (command.kind === 'create') {
      const parsed = ObjectSchema.safeParse({
        ...command.patch,
        size:
          command.patch.size === undefined
            ? command.patch.content.type === 'group'
              ? null
              : { width: 240, height: 120 }
            : command.patch.size,
        id: command.objectId,
        type: command.patch.content.type,
        author,
        createdAt: now,
        updatedAt: now,
        revision: 1,
        deletedAt: null,
      });
      if (!parsed.success) return reject('INVALID', parsed.error.message);
      proposed = parsed.data;
    } else {
      if (!current) return reject('NOT_FOUND', 'Object not found');
      const inherited = current.parentId === null ? null : effectiveLock(state, current.parentId);
      // A background-only ancestor protects its bounds, not membership or child content.
      if (
        (inherited?.mode === 'subtree' && !['comment', 'remove-comment'].includes(command.kind)) ||
        (effectiveLock(state, current.id) && !['unlock', 'comment', 'remove-comment'].includes(command.kind))
      )
        return reject('LOCKED', 'Explicitly unlock the protected object or ancestor first');
      proposed = { ...current, updatedAt: now, revision: current.revision + 1 };
      switch (command.kind) {
        case 'update':
        case 'move':
        case 'reorder':
        case 'revert':
          proposed = { ...proposed, ...command.patch };
          if ('content' in command.patch && command.patch.content)
            proposed.content = { ...current.content, ...command.patch.content };
          break;
        case 'lock':
          proposed.lock = command.patch.mode;
          break;
        case 'unlock':
          proposed.lock = null;
          break;
        case 'delete':
          proposed.deletedAt = now;
          proposed.deletionOpId = command.opId;
          break;
        case 'restore':
          proposed.deletedAt = null;
          proposed.deletionOpId = null;
          break;
        case 'remove-comment':
          removedComment = state.comments.find((c) => c.id === command.patch.id && c.objectId === current.id);
          if (!removedComment) return reject('NOT_FOUND', 'Comment not found');
          break;
        case 'comment':
          if (state.comments.some((c) => c.id === command.patch.id))
            return reject('DUPLICATE', 'Comment id already exists');
          comment = { ...command.patch, objectId: current.id, author, createdAt: now };
          break;
        case 'reparent': {
          proposed.parentId = command.patch.parentId;
          proposed.order = command.patch.order;
          if (command.patch.preserveWorld) {
            const world = worldTransform(state, current.id);
            const parent =
              proposed.parentId === null
                ? { x: 0, y: 0, rotation: 0 }
                : state.objects[proposed.parentId]
                  ? worldTransform(state, proposed.parentId)
                  : null;
            if (!parent) return reject('INVALID', 'Unknown parent');
            const r = (-parent.rotation * Math.PI) / 180,
              x = world.x - parent.x,
              y = world.y - parent.y;
            proposed.position = { x: x * Math.cos(r) - y * Math.sin(r), y: x * Math.sin(r) + y * Math.cos(r) };
            proposed.rotation = world.rotation - parent.rotation;
          }
          break;
        }
      }
    }
    if (current && ['comment', 'remove-comment'].includes(command.kind)) proposed = current;
    if (!validateKnownObject(proposed)) return reject('INVALID', 'Invalid object fields');
    const parentLock = proposed.parentId === null ? null : effectiveLock(state, proposed.parentId);
    if (
      parentLock?.mode === 'subtree' &&
      (command.kind === 'create' || command.kind === 'reparent' || command.kind === 'revert')
    )
      return reject('LOCKED', 'Destination ancestor is locked');
    const reason = hierarchyReason(state, proposed);
    if (reason) return { ok: false, reasons: [reason] };
    changes.push({ objectId: proposed.id, before: current ?? null, after: proposed });
    const subtree =
      current &&
      isContainer(current) &&
      (['move', 'reparent', 'delete', 'restore', 'revert'].includes(command.kind) ||
        (command.kind === 'update' && command.patch.rotation !== undefined))
        ? descendants(state, current.id).slice(1)
        : [];
    for (const child of subtree) {
      if (!isKnownObject(child)) return reject('INVALID', 'Unknown descendant type is read-only');
      const childLock = effectiveLock(state, child.id);
      if (childLock) return reject('LOCKED', `Protected descendant ${child.id}`);
      if (command.kind === 'delete' && child.deletedAt === null)
        changes.push({
          objectId: child.id,
          before: child,
          after: { ...child, deletedAt: now, deletionOpId: command.opId, updatedAt: now, revision: child.revision + 1 },
        });
      if (command.kind === 'restore' && current?.deletionOpId !== null && child.deletionOpId === current?.deletionOpId)
        changes.push({
          objectId: child.id,
          before: child,
          after: { ...child, deletedAt: null, deletionOpId: null, updatedAt: now, revision: child.revision + 1 },
        });
    }
    const op: Operation = {
      seq: state.seq + 1,
      opId: command.opId,
      author,
      kind: command.kind,
      objectId: command.objectId,
      patch: 'patch' in command ? command.patch : {},
      prev: changes,
      ...(comment ? { comment } : {}),
      ...(removedComment ? { removedComment } : {}),
    };
    for (const change of changes) staged.set(change.objectId, change.after);
    state = {
      seq: op.seq,
      objects,
      comments: comment
        ? [...state.comments, comment]
        : removedComment
          ? state.comments.filter((c) => c.id !== removedComment.id)
          : state.comments,
    };
    operations.push(op);
  }
  for (const operation of operations) {
    for (const change of operation.prev) {
      const o = state.objects[change.objectId];
      const reason = hierarchyReason(state, o);
      if (reason) return { ok: false, reasons: [reason] };
      if (change.before && change.before.deletedAt !== o.deletedAt && isContainer(o)) {
        for (const child of descendants(state, o.id)) {
          const childReason = hierarchyReason(state, child);
          if (childReason) return { ok: false, reasons: [childReason] };
        }
      }
    }
  }
  return {
    ok: true,
    operations,
    get state() {
      return { ...state, objects: { ...initial.objects, ...Object.fromEntries(staged) } };
    },
  };
}

const historyId = (key: string): string => createHash('sha256').update(key).digest('hex');

export function invertOperation(op: Operation): Command[] {
  if (!knownKinds.has(op.kind) || op.prev.some((change) => !isKnownObject(change.after))) return [];
  const changedObject = op.prev.find((change) => change.objectId === op.objectId);
  if (op.kind === 'delete')
    return [
      {
        kind: 'restore',
        opId: historyId(`inverse:${op.opId}`),
        objectId: op.objectId,
        expectedRevision: changedObject?.after.revision,
      },
    ];
  if (op.kind === 'lock')
    return [
      {
        kind: 'unlock',
        opId: historyId(`inverse:${op.opId}`),
        objectId: op.objectId,
        expectedRevision: changedObject?.after.revision,
      },
    ];
  if (op.kind === 'unlock' && changedObject?.before?.lock)
    return [
      {
        kind: 'lock',
        opId: historyId(`inverse:${op.opId}`),
        objectId: op.objectId,
        expectedRevision: changedObject.after.revision,
        patch: { mode: changedObject.before.lock },
      },
    ];

  if (op.comment)
    return [
      {
        kind: 'remove-comment',
        opId: historyId(`inverse:${op.opId}:${op.objectId}`),
        objectId: op.objectId,
        patch: { id: op.comment.id },
      },
    ];
  if (op.removedComment)
    return [
      {
        kind: 'comment',
        opId: historyId(`inverse:${op.opId}:${op.objectId}`),
        objectId: op.objectId,
        patch: { id: op.removedComment.id, text: op.removedComment.text },
      },
    ];
  const inverse = {
    opId: historyId(`inverse:${op.opId}:${op.objectId}`),
    objectId: op.objectId,
    expectedRevision: changedObject?.after.revision,
  };
  if (op.kind === 'create' || op.kind === 'restore') return [{ ...inverse, kind: 'delete' }];
  const before = changedObject?.before;
  if (!changedObject || !before) return [];
  switch (op.kind) {
    case 'move':
      return [{ ...inverse, kind: 'move', patch: { position: before.position } }];
    case 'reorder':
      return [{ ...inverse, kind: 'reorder', patch: { order: before.order } }];
    case 'update':
      return [
        {
          ...inverse,
          kind: 'update',
          patch: { content: knownContentFields(before.content), size: before.size, rotation: before.rotation },
        },
      ];
    case 'reparent':
      return [
        {
          ...inverse,
          kind: 'reparent',
          patch: { parentId: before.parentId, order: before.order, preserveWorld: false },
        },
        {
          ...inverse,
          opId: historyId(`inverse-position:${op.opId}`),
          expectedRevision: changedObject.after.revision + 1,
          kind: 'move',
          patch: { position: before.position },
        },
        {
          ...inverse,
          opId: historyId(`inverse-rotation:${op.opId}`),
          expectedRevision: changedObject.after.revision + 2,
          kind: 'update',
          patch: { rotation: before.rotation },
        },
      ];
    case 'revert':
      break;
    default:
      return [];
  }
  return op.prev.map((change) => ({
    kind: 'revert',
    opId: historyId(`inverse:${op.opId}:${change.objectId}`),
    objectId: change.objectId,
    expectedRevision: change.after.revision,
    patch: change.before
      ? MutableSchema.parse({
          ...Object.fromEntries(mutableKeys.map((key) => [key, change.before?.[key]])),
          content: knownContentFields(change.before.content),
        })
      : { deletedAt: change.after.updatedAt, deletionOpId: historyId(`inverse:${op.opId}:${change.objectId}`) },
  }));
}

export function revertAuthor(state: CanvasState, log: Operation[], author: Author): Command[] {
  const patches = new Map<string, Partial<z.infer<typeof MutableSchema>>>();
  const protectedFields = new Set<string>();
  for (const op of [...log].reverse()) {
    if (!knownKinds.has(op.kind)) continue;
    for (const change of op.prev) {
      const current = state.objects[change.objectId];
      if (!current || !isKnownObject(current) || (change.before && !isKnownObject(change.before))) continue;
      for (const key of mutableKeys) {
        if (change.before && equal(change.before[key], change.after[key])) continue;
        const field = `${change.objectId}:${key}`;
        if (!sameAuthor(op.author, author)) {
          protectedFields.add(field);
          continue;
        }
        if (protectedFields.has(field)) continue;
        const patch = patches.get(current.id) ?? {};
        if (change.before)
          Object.assign(patch, {
            [key]: key === 'content' ? knownContentFields(change.before.content) : change.before[key],
          });
        else if (
          ![...protectedFields].some((f) => f.startsWith(`${current.id}:`)) &&
          !descendants(state, current.id).some(
            (child) =>
              child.id !== current.id &&
              child.deletedAt === null &&
              (!sameAuthor(child.author, author) || [...protectedFields].some((f) => f.startsWith(`${child.id}:`)))
          )
        )
          Object.assign(patch, {
            deletedAt: current.updatedAt + 1,
            deletionOpId: historyId(`revert:${state.seq}:${current.id}`),
          });
        patches.set(current.id, patch);
      }
    }
  }
  const comments: Command[] = state.comments
    .filter(
      (c) => sameAuthor(c.author, author) && !!state.objects[c.objectId] && isKnownObject(state.objects[c.objectId])
    )
    .map((c) => ({
      kind: 'remove-comment',
      opId: historyId(`revert-comment:${state.seq}:${c.id}`),
      objectId: c.objectId,
      patch: { id: c.id },
    }));
  return [
    ...comments,
    ...[...patches]
      .filter(([, patch]) => Object.keys(patch).length > 0)
      .map<Command>(([objectId, patch]) => ({
        kind: 'revert',
        opId: historyId(`revert:${state.seq}:${objectId}`),
        objectId,
        expectedRevision: state.objects[objectId]?.revision,
        patch,
      })),
  ];
}
