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
  knownObjectIds,
  indexKnownObjects,
  classifyObject,
  validateKnownObject,
  knownContentFields,
  descendants,
  walkHierarchy,
  requireHierarchy,
  HierarchyError,
  MAX_HIERARCHY_DEPTH,
  effectiveLock,
  isContainer,
  sameAuthor,
  worldTransform,
  type Author,
  type CanvasObject,
  type CanvasState,
} from './model.js';

export const MAX_CALLER_OPERATIONS = 1000;
export const MAX_EXPANDED_OPERATIONS = MAX_CALLER_OPERATIONS * 10;

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
  code: 'LOCKED' | 'CYCLE' | 'HIERARCHY_LIMIT' | 'REVISION' | 'NOT_FOUND' | 'INVALID' | 'DUPLICATE' | 'DEPENDENTS';
  objectId: string;
  message: string;
  dependents?: { objectId: string; author: Author }[];
};
export type BatchResult =
  | { ok: true; state: CanvasState; operations: Operation[] }
  | { ok: false; reasons: Rejection[] };
const equal = isDeepStrictEqual;
/** The one type change an update may make: a link card shown as a live page, and back. */
const isWebSwitch = (from: string, to: string): boolean =>
  (from === 'link' && to === 'embed') || (from === 'embed' && to === 'link');
const mutableKeys = Object.keys(MutableSchema.shape) as (keyof z.infer<typeof MutableSchema>)[];

export function applyOperation(state: CanvasState, op: Operation): CanvasState {
  if (!knownKinds.has(op.kind)) {
    const next = { ...state, seq: Math.max(state.seq, op.seq) };
    indexKnownObjects(next, knownObjectIds(state));
    return next;
  }
  const objects = { ...state.objects };
  for (const change of op.prev) objects[change.objectId] = change.after;
  const next = {
    seq: op.seq,
    objects,
    comments: op.comment
      ? [...state.comments, op.comment]
      : op.removedComment
        ? state.comments.filter((c) => c.id !== op.removedComment?.id)
        : state.comments,
  };
  indexKnownObjects(next, knownObjectIds(state));
  for (const change of op.prev) classifyObject(next, change.after);
  return next;
}

function hierarchyReason(state: CanvasState, o: CanvasObject, isKnown: (id: string) => boolean): Rejection | null {
  const walk = walkHierarchy(
    {
      ...state,
      objects: new Proxy(state.objects, { get: (target, key) => (key === o.id ? o : Reflect.get(target, key)) }),
    },
    [o.id],
    'parents'
  );
  if (walk.issue) return { ...walk.issue, objectId: o.id };
  for (const p of walk.objects.slice(1)) {
    if (!isKnown(p.id) || !isContainer(p) || (o.deletedAt === null && p.deletedAt !== null))
      return { code: 'INVALID', objectId: o.id, message: 'Parent must be an existing live known container' };
  }
  if (walk.objects.some((p) => p.parentId !== null && !state.objects[p.parentId]))
    return { code: 'INVALID', objectId: o.id, message: 'Parent must exist' };
  return null;
}

export function validateBatch(
  initial: CanvasState,
  commands: Command[],
  author: Author,
  now = 0,
  historyRemovals?: ReadonlySet<string>
): BatchResult {
  try {
    return validateBatchUnchecked(initial, commands, author, now, historyRemovals);
  } catch (error) {
    if (error instanceof HierarchyError) return { ok: false, reasons: [error.reason] };
    throw error;
  }
}

function validateBatchUnchecked(
  initial: CanvasState,
  commands: Command[],
  author: Author,
  now = 0,
  historyRemovals?: ReadonlySet<string>
): BatchResult {
  const known = knownObjectIds(initial);
  const staged = new Map<string, CanvasObject>();
  const children = new Map<string, Set<string>>();
  const addChild = (parentId: string | null, id: string) => {
    if (parentId === null) return;
    const siblings = children.get(parentId) ?? new Set<string>();
    siblings.add(id);
    children.set(parentId, siblings);
  };
  for (const object of Object.values(initial.objects)) addChild(object.parentId, object.id);
  const isKnown = (id: string): boolean => staged.has(id) || known.has(id);
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
    if (current) requireHierarchy(walkHierarchy(state, [current.id], 'parents'));
    if (current && !isKnown(current.id)) return reject('INVALID', 'Unknown object type is read-only');
    if (current && command.expectedRevision !== undefined && command.expectedRevision !== current.revision)
      return reject('REVISION', 'Object revision changed');
    if (
      current?.deletedAt !== undefined &&
      current.deletedAt !== null &&
      !['restore', 'revert', 'remove-comment'].includes(command.kind)
    )
      return reject('INVALID', 'Restore a deleted object before editing it');
    if (current?.deletedAt === null && command.kind === 'restore') return reject('INVALID', 'Object is not deleted');
    // An empty patch would bump the revision and stale every other writer's expectedRevision for no change.
    if (
      (command.kind === 'update' || command.kind === 'revert') &&
      Object.values(command.patch).every((value) => value === undefined)
    )
      return reject('INVALID', 'The edit changes nothing');
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
          if ('content' in command.patch && command.patch.content) {
            if (command.patch.content.type === current.type)
              proposed.content = { ...current.content, ...command.patch.content };
            else if (isWebSwitch(current.type, command.patch.content.type)) proposed.type = command.patch.content.type;
            else return reject('INVALID', 'Only a link and an embed can change into each other');
          }
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
    const reason = hierarchyReason(state, proposed, isKnown);
    if (reason) return { ok: false, reasons: [reason] };
    changes.push({ objectId: proposed.id, before: current ?? null, after: proposed });
    const subtree =
      current &&
      isContainer(current) &&
      (['move', 'reparent', 'delete', 'restore', 'revert'].includes(command.kind) ||
        (command.kind === 'update' && command.patch.rotation !== undefined))
        ? requireHierarchy(walkHierarchy(state, [current.id], 'children', false, children)).slice(1)
        : [];
    if (historyRemovals && (command.kind === 'delete' || (command.kind === 'revert' && proposed.deletedAt !== null))) {
      const dependents = subtree
        .filter((child) => child.deletedAt === null && !historyRemovals.has(child.id))
        .map((child) => ({ objectId: child.id, author: child.author }));
      if (dependents.length)
        return {
          ok: false,
          reasons: [
            {
              code: 'DEPENDENTS',
              objectId: command.objectId,
              message: 'History would remove later dependent objects',
              dependents,
            },
          ],
        };
    }
    for (const child of subtree) {
      if (!isKnown(child.id)) return reject('INVALID', 'Unknown descendant type is read-only');
      if (child.lock) return reject('LOCKED', `Protected descendant ${child.id}`);
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
    for (const change of changes) {
      if (change.before?.parentId !== change.after.parentId) {
        if (change.before?.parentId) children.get(change.before.parentId)?.delete(change.objectId);
        addChild(change.after.parentId, change.objectId);
      }
      staged.set(change.objectId, change.after);
    }
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
  const roots = new Set<string>();
  for (const operation of operations) {
    const o = state.objects[operation.objectId];
    const reason = hierarchyReason(state, o, isKnown);
    if (reason) return { ok: false, reasons: [reason] };
    if (
      isContainer(o) &&
      operation.prev.some(
        (change) => change.objectId === o.id && change.before && change.before.deletedAt !== o.deletedAt
      )
    )
      roots.add(o.id);
  }
  const facts = new Map<string, { depth: number; deleted: boolean }>();
  for (const id of roots) {
    const ancestors = requireHierarchy(walkHierarchy(state, [id], 'parents'));
    facts.set(id, { depth: ancestors.length, deleted: ancestors.some((o) => o.deletedAt !== null) });
  }
  for (const o of roots.size ? requireHierarchy(walkHierarchy(state, roots, 'children', false, children)) : []) {
    if (roots.has(o.id)) continue;
    const parent = o.parentId === null ? undefined : state.objects[o.parentId];
    const inherited = parent ? facts.get(parent.id) : undefined;
    if (
      !parent ||
      !inherited ||
      !isKnown(parent.id) ||
      !isContainer(parent) ||
      (o.deletedAt === null && inherited.deleted)
    )
      return {
        ok: false,
        reasons: [{ code: 'INVALID', objectId: o.id, message: 'Parent must be an existing live known container' }],
      };
    const depth = inherited.depth + 1;
    if (depth > MAX_HIERARCHY_DEPTH)
      return {
        ok: false,
        reasons: [{ code: 'HIERARCHY_LIMIT', objectId: o.id, message: 'Hierarchy traversal limit exceeded' }],
      };
    facts.set(o.id, { depth, deleted: inherited.deleted || o.deletedAt !== null });
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
  if (
    !knownKinds.has(op.kind) ||
    op.prev.some((change) => !isKnownObject(change.after) || (change.before && !isKnownObject(change.before)))
  )
    return [];
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
          kind: 'revert',
          patch: {
            parentId: before.parentId,
            order: before.order,
            position: before.position,
            rotation: before.rotation,
          },
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
  const known = knownObjectIds(state);
  const patches = new Map<string, Partial<z.infer<typeof MutableSchema>>>();
  const protectedFields = new Set<string>();
  for (const op of [...log].reverse()) {
    if (!knownKinds.has(op.kind)) continue;
    for (const change of op.prev) {
      const current = state.objects[change.objectId];
      if (
        !current ||
        !known.has(current.id) ||
        !isKnownObject(change.after) ||
        (change.before && !isKnownObject(change.before)) ||
        walkHierarchy(state, [current.id], 'parents').issue
      )
        continue;
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
              (!known.has(child.id) ||
                !sameAuthor(child.author, author) ||
                [...protectedFields].some((f) => f.startsWith(`${child.id}:`)))
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
      (c) =>
        sameAuthor(c.author, author) &&
        !!state.objects[c.objectId] &&
        isKnownObject(state.objects[c.objectId]) &&
        !walkHierarchy(state, [c.objectId], 'parents').issue
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
