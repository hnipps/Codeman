/** @fileoverview Shared compound canvas commands and machine-readable capabilities. */
import { z } from 'zod';
import { ViewActionSchema } from './view-schema.js';
import { ConversationToolSchema } from './conversation-schema.js';
import { randomUUID, createHash } from 'node:crypto';
import {
  AuthorSchema,
  IdSchema,
  PositionSchema,
  SizeSchema,
  ContentSchema,
  walkHierarchy,
  requireHierarchy,
  worldTransform,
  bounds,
  knownContentFields,
  isKnownObject,
  sameAuthor,
  HierarchyError,
  type CanvasState,
  type CanvasObject,
  type Author,
} from './model.js';
import {
  CommandSchema,
  MAX_CALLER_OPERATIONS,
  MAX_EXPANDED_OPERATIONS,
  OperationSchema,
  knownKinds,
  invertOperation,
  validateBatch,
  type Command,
  type Operation,
  type Rejection,
} from './operations.js';

const targets = z.array(IdSchema).min(1).max(MAX_CALLER_OPERATIONS);
export const ArrangeSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('group'),
      targetIds: targets,
      groupId: IdSchema,
      label: z.string().max(8192),
      parentId: IdSchema.nullable(),
      containerType: z.enum(['group', 'frame', 'section']).optional(),
    })
    .strict(),
  z.object({ action: z.literal('ungroup'), targetIds: targets }).strict(),
  z
    .object({
      action: z.enum(['reparent', 'nest']),
      targetIds: targets,
      parentId: IdSchema.nullable(),
      translation: PositionSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('order'),
      targetIds: targets,
      placement: z.enum(['front', 'back', 'forward', 'backward']),
    })
    .strict(),
  z
    .object({
      action: z.literal('align'),
      targetIds: targets,
      axis: z.enum(['x', 'y']),
      anchor: z.enum(['start', 'center', 'end']),
    })
    .strict(),
  z
    .object({
      action: z.literal('distribute'),
      targetIds: targets,
      axis: z.enum(['x', 'y']),
      spacing: z.number().finite().optional(),
    })
    .strict(),
  z.object({ action: z.literal('duplicate'), targetIds: targets, offset: PositionSchema }).strict(),
]);
export const TransformSchema = z
  .object({
    targetIds: targets,
    space: z.enum(['local', 'world']),
    anchor: PositionSchema,
    translation: PositionSchema,
    scale: SizeSchema,
    rotation: z.number().finite(),
  })
  .strict();
export const LockCommandSchema = z
  .object({ targetIds: targets, mode: z.enum(['subtree', 'background', 'unlock']) })
  .strict();
export const HistorySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read'), since: z.number().int().nonnegative().default(0) }).strict(),
  z
    .object({
      action: z.enum(['undo', 'redo']),
      sequences: z.array(z.number().int().positive()).min(1).max(MAX_EXPANDED_OPERATIONS),
    })
    .strict(),
  z.object({ action: z.literal('revert') }).strict(),
  z.object({ action: z.literal('authors') }).strict(),
  z.object({ action: z.literal('preview'), author: AuthorSchema }).strict(),
]);
export const CommentToolSchema = z
  .object({
    objectId: IdSchema,
    text: z
      .string()
      .max(100_000)
      .refine((text) => text.trim().length > 0, 'Comment text is empty'),
    commentId: IdSchema.optional(),
  })
  .strict();
/** An ordinary comment: one `comment` operation, never an agent invocation. */
export function commentCommand(input: z.infer<typeof CommentToolSchema>): Command {
  const id = input.commentId ?? randomUUID();
  return { kind: 'comment', opId: randomUUID(), objectId: input.objectId, patch: { id, text: input.text } };
}
export const ReadSchema = z.object({ root: IdSchema.optional(), includeDeleted: z.boolean().default(false) }).strict();
export const SearchSchema = z.object({ text: z.string().min(1).max(8192), root: IdSchema.optional() }).strict();
export const QuerySchema = z.discriminatedUnion('shape', [
  z.object({ shape: z.literal('point'), point: PositionSchema, root: IdSchema.optional() }).strict(),
  z
    .object({
      shape: z.literal('rectangle'),
      position: PositionSchema,
      size: SizeSchema,
      semantics: z.enum(['containment', 'intersection', 'center']),
      root: IdSchema.optional(),
    })
    .strict(),
  z
    .object({
      shape: z.literal('polygon'),
      points: z.array(PositionSchema).min(3).max(1000),
      semantics: z.enum(['containment', 'intersection', 'center']),
      root: IdSchema.optional(),
    })
    .strict(),
]);
const ViewId = z.uuid();
const RequestId = z.uuid().optional();
const [setViewport, fitView, selectView, clearSelection, focusView, railView, , contextAdd, contextRemove] =
  ViewActionSchema.options;
const target = { viewId: ViewId, requestId: RequestId };
export const ViewToolSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('read'), viewId: ViewId }).strict(),
  z.object({ ...setViewport.shape, ...target }).strict(),
  z.object({ ...fitView.shape, ...target }).strict(),
  z.object({ ...selectView.shape, ...target }).strict(),
  z.object({ ...clearSelection.shape, ...target }).strict(),
  z.object({ ...focusView.shape, ...target }).strict(),
  z.object({ ...railView.shape, ...target }).strict(),
]);
export const ContextToolSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read'), viewId: ViewId }).strict(),
  z.object({ action: z.literal('add'), targetIds: contextAdd.shape.targetIds, ...target }).strict(),
  z.object({ action: z.literal('remove'), targetIds: contextRemove.shape.targetIds, ...target }).strict(),
]);
const batch = <Schema extends z.ZodType>(schema: Schema) =>
  z.object({ operations: z.array(schema).min(1).max(MAX_CALLER_OPERATIONS) }).strict();
export const toolSchemas = {
  canvas_read: ReadSchema,
  canvas_search: SearchSchema,
  canvas_create: batch(CommandSchema.options[0]),
  canvas_update: batch(
    z.union(CommandSchema.options.filter((s) => !['create', 'delete', 'revert'].includes(s.shape.kind.value)))
  ),
  canvas_delete: batch(CommandSchema.options.find((s) => s.shape.kind.value === 'delete')!),
  canvas_query: QuerySchema,
  canvas_arrange: ArrangeSchema,
  canvas_transform: TransformSchema,
  canvas_lock: LockCommandSchema,
  canvas_history: HistorySchema,
  canvas_comment: CommentToolSchema,
  canvas_view: ViewToolSchema,
  canvas_context: ContextToolSchema,
  canvas_conversation: ConversationToolSchema,
  canvas_capabilities: z.object({}).strict(),
  canvas_link_preview: z.object({ url: z.string().min(1).max(8192) }).strict(),
};
export type CanvasToolName = keyof typeof toolSchemas;
export const canvasToolNames = Object.keys(toolSchemas) as CanvasToolName[];
export function canvasJsonSchema(schema: z.ZodType) {
  const generated = z.toJSONSchema(schema, { io: 'input' });
  if (generated.type === 'object') return generated;
  const properties = Object.fromEntries(
    (generated.anyOf ?? generated.oneOf ?? []).flatMap((branch) =>
      typeof branch === 'object' ? Object.keys(branch.properties ?? {}).map((name) => [name, {}]) : []
    )
  );
  return { ...generated, type: 'object', properties, additionalProperties: false };
}
export function capabilities() {
  const types = ContentSchema.options.map((s) => s.shape.type.value);
  return {
    tools: [
      ...canvasToolNames.map((name) => ({
        name,
        schema: canvasJsonSchema(toolSchemas[name]),
        objectTypes: types,
      })),
      {
        name: 'canvas_upload_image',
        available: true,
        objectTypes: ['image'],
        note: 'POST assets with the image bytes (PNG, JPEG, GIF or WebP, 8 MB). Returns assetId, width and height; create an image object with content.assetId.',
      },
      {
        name: 'canvas_screenshot',
        available: true,
        objectTypes: types,
        note: 'PNG of one container or object via GET screenshot. The page has no network.',
      },
    ],
    compoundCommands: ArrangeSchema.options.flatMap((s) => {
      const actions = s.shape.action instanceof z.ZodEnum ? s.shape.action.options : [s.shape.action.value];
      return actions.map((command) => ({
        command,
        schema: z.toJSONSchema(s, { io: 'input' }),
        objectTypes: command === 'ungroup' ? ['group'] : types,
      }));
    }),
    transforms: {
      schema: z.toJSONSchema(TransformSchema, { io: 'input' }),
      objectTypes: types,
      groupScale: 'Uniform only; includes the entire subtree',
      nonuniformScale:
        'Only axis-aligned non-group targets in the declared coordinate space; rotated axes requiring shear are rejected',
      resize: 'canvas_update size edits bounds of explicitly sized types; use positive scale factors for group content',
    },
    commands: CommandSchema.options.map((s) => ({
      command: s.shape.kind.value,
      schema: z.toJSONSchema(s, { io: 'input' }),
      objectTypes: types,
    })),
    geometry: {
      coordinates: ['local', 'world'],
      scale: 'Positive factors; explicit containers resize bounds only; groups scale descendants. Flip is unsupported.',
      snapping: 'Snapping is a pointer aid in the browser, not a stored command',
      spatial:
        'Queries test world axis-aligned bounds, including edges; polygons must be simple. Containment includes the whole bounds; intersection includes touching edges.',
    },
    restrictions: {
      group: 'Auto bounds; no direct resize or background lock',
      backgroundLock: ['frame', 'section'],
      opaque: 'Read only',
      history:
        'Undo selected own operation sequences; redo selects sequences returned by undo. All inverse operations form one atomic batch; changed revisions reject.',
    },
    media: {
      image:
        'content { type: image, url: "", alt, assetId }; assetId comes from canvas_upload_image and must be stored in this workspace',
      link: 'content { type: link, url, label, preview?, thumbnailAssetId? }; canvas_link_preview fetches label and thumbnail through the egress guard',
      embed:
        'Convert with canvas_update: content type link becomes embed and back, keeping the object id. Embeds show a sandboxed live page; at most six frames load at once',
      subcanvas: 'A container in this workspace; read its contents with canvas_read root',
      assets: 'Assets are content addressed and kept when no object references them',
    },
    views: [
      {
        command: 'canvas.view.enter',
        available: 'browser',
        note: 'window.canvasView.dispatch({ kind: "enter", id }) opens a sub-canvas in that view; agents read it with canvas_read root',
      },
      {
        command: 'canvas.view.leave',
        available: 'browser',
        note: 'window.canvasView.dispatch({ kind: "leave" }) returns to the parent view',
      },
      ...[
        ['canvas.viewport.read', 'canvas_view read'],
        ['canvas.viewport.set', 'canvas_view set-viewport'],
        ['canvas.viewport.fit', 'canvas_view fit'],
        ['canvas.selection.read', 'canvas_view read'],
        ['canvas.selection.set', 'canvas_view select'],
        ['canvas.selection.clear', 'canvas_view clear-selection'],
        ['canvas.focus.set', 'canvas_view focus'],
        ['canvas.rail.set', 'canvas_view rail'],
        ['canvas.context.read', 'canvas_context read'],
        ['canvas.context.add', 'canvas_context add'],
        ['canvas.context.remove', 'canvas_context remove'],
      ].map(([command, tool]) => ({
        command,
        available: true,
        tool,
        note: 'Acts on one open browser view named by viewId (canvas_view list). The view reports its state every few seconds; a closed view answers VIEW_GONE.',
      })),
    ],
    conversations: [
      ['canvas.conversation.list', 'canvas_conversation list'],
      ['canvas.conversation.read', 'canvas_conversation read'],
      ['canvas.conversation.create', 'canvas_conversation create'],
      ['canvas.conversation.send', 'canvas_conversation send'],
    ].map(([command, tool]) => ({
      command,
      available: true,
      tool,
      note: 'A conversation is one real Claude session in this case. Send pastes the prompt with the session write primitive and carries the named objects as reference text; it never answers a pending question and an agent cannot message its own conversation.',
    })),
    reserved: [],
    clipboard: {
      copy: 'canvas_read retains typed content and hierarchy',
      cut: 'Read then canvas_delete; retain the returned state in the caller clipboard',
      paste: 'canvas_create atomic batch with fresh object/op IDs and remapped parent IDs',
      duplicate: 'canvas_arrange duplicate allocates and remaps IDs server-side',
    },
    future: { contextSessionActions: 'PC9/PC10', voice: 'PC11', backgroundWork: 'PC12' },
  };
}
export class CanvasCommandError extends Error {
  constructor(public readonly reasons: Rejection[]) {
    super('Canvas operation rejected');
  }
}
function refuse(objectId: string, code: Rejection['code'], message: string): never {
  throw new CanvasCommandError([{ objectId, code, message }]);
}
export function normalizeTargets(state: CanvasState, ids: string[]): CanvasObject[] {
  const selected = new Set(ids);
  return [...selected]
    .map((id) => {
      const o = state.objects[id];
      if (!o) return refuse(id, 'NOT_FOUND', 'Object identity is unavailable');
      return o;
    })
    .filter(
      (o) =>
        !requireHierarchy(walkHierarchy(state, [o.id], 'parents'))
          .slice(1)
          .some((p) => selected.has(p.id))
    );
}
const op = (objectId: string) => ({ objectId, opId: randomUUID() });
function moveWorld(state: CanvasState, o: CanvasObject, x: number, y: number): Extract<Command, { kind: 'move' }> {
  const parent = o.parentId === null ? { x: 0, y: 0, rotation: 0 } : worldTransform(state, o.parentId);
  const r = (-parent.rotation * Math.PI) / 180;
  return {
    ...op(o.id),
    kind: 'move',
    patch: {
      position: {
        x: (x - parent.x) * Math.cos(r) - (y - parent.y) * Math.sin(r),
        y: (x - parent.x) * Math.sin(r) + (y - parent.y) * Math.cos(r),
      },
    },
  };
}
export function deferCreatedLocks(commands: Command[]): Command[] {
  const locks: Command[] = [];
  const creates = commands.map((command) => {
    if (command.kind !== 'create' || !command.patch.lock) return command;
    locks.unshift({
      kind: 'lock',
      objectId: command.objectId,
      opId: `lock_${createHash('sha256').update(command.opId).digest('hex')}`,
      patch: { mode: command.patch.lock },
    });
    return { ...command, patch: { ...command.patch, lock: null } };
  });
  return [...creates, ...locks];
}
export function arrange(state: CanvasState, input: z.infer<typeof ArrangeSchema>): Command[] {
  const roots = normalizeTargets(state, input.targetIds);
  const reparent = (o: CanvasObject, parentId: string | null, order = o.order): Command => ({
    ...op(o.id),
    kind: 'reparent',
    patch: { parentId, order, preserveWorld: true },
  });
  switch (input.action) {
    case 'group': {
      const type = input.containerType ?? 'group';
      const boxes =
        type === 'group'
          ? [{ x: 0, y: 0, width: 0, height: 0 }]
          : roots.map((o) => {
              const box = bounds(state, o.id);
              if ('hierarchy' in box) return refuse(o.id, 'CYCLE', 'Cyclic hierarchy is read-only');
              return box;
            });
      const x = Math.min(...boxes.map((b) => b.x)) - 24;
      const y = Math.min(...boxes.map((b) => b.y)) - 48;
      const parent =
        input.parentId === null || type === 'group'
          ? { x: 0, y: 0, rotation: 0 }
          : state.objects[input.parentId]
            ? worldTransform(state, input.parentId)
            : refuse(input.parentId, 'NOT_FOUND', 'Destination identity is unavailable');
      const angle = (-parent.rotation * Math.PI) / 180;
      return [
        CommandSchema.parse({
          ...op(input.groupId),
          kind: 'create',
          patch: {
            parentId: input.parentId,
            order: Math.min(...roots.map((o) => o.order)),
            position:
              type === 'group'
                ? { x: 0, y: 0 }
                : {
                    x: (x - parent.x) * Math.cos(angle) - (y - parent.y) * Math.sin(angle),
                    y: (x - parent.x) * Math.sin(angle) + (y - parent.y) * Math.cos(angle),
                  },
            rotation: type === 'group' ? 0 : -parent.rotation,
            ...(type === 'group'
              ? {}
              : {
                  size: {
                    width: Math.max(...boxes.map((b) => b.x + b.width)) - x + 24,
                    height: Math.max(...boxes.map((b) => b.y + b.height)) - y + 24,
                  },
                }),
            content: { type, label: input.label },
          },
        }),
        ...roots.map((o) => reparent(o, input.groupId)),
      ];
    }
    case 'reparent':
    case 'nest':
      return roots.flatMap((o) => {
        const world = worldTransform(state, o.id);
        return [
          ...(input.translation
            ? [moveWorld(state, o, world.x + input.translation.x, world.y + input.translation.y)]
            : []),
          reparent(o, input.parentId),
        ];
      });
    case 'ungroup':
      return roots.flatMap((o) => {
        if (o.type !== 'group') return refuse(o.id, 'INVALID', 'Ungroup requires an auto-bounded group');
        return [
          ...Object.values(state.objects)
            .filter((c) => c.parentId === o.id && c.deletedAt === null)
            .map((c) => reparent(c, o.parentId)),
          { ...op(o.id), kind: 'delete' as const },
        ];
      });
    case 'duplicate': {
      const all = roots
        .flatMap((o) => requireHierarchy(walkHierarchy(state, [o.id], 'children')))
        .filter((o) => o.deletedAt === null);
      const ids = new Map(all.map((o) => [o.id, randomUUID()]));
      for (const o of all) if (!isKnownObject(o)) refuse(o.id, 'INVALID', 'Unknown object type is read-only');
      return deferCreatedLocks(
        all.map((o) =>
          CommandSchema.parse({
            ...op(ids.get(o.id)!),
            kind: 'create',
            patch: {
              parentId: ids.get(o.parentId ?? '') ?? o.parentId,
              order: o.order,
              position: {
                x: o.position.x + (ids.has(o.parentId ?? '') ? 0 : input.offset.x),
                y: o.position.y + (ids.has(o.parentId ?? '') ? 0 : input.offset.y),
              },
              size: o.size,
              rotation: o.rotation,
              lock: o.lock,
              content: knownContentFields(o.content),
            },
          })
        )
      );
    }
    case 'order': {
      const commands: Command[] = [];
      for (const parent of new Set(roots.map((o) => o.parentId))) {
        const siblings = Object.values(state.objects)
          .filter((o) => o.parentId === parent && o.deletedAt === null)
          .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        const selected = new Set(roots.map((o) => o.id));
        const before = siblings.map((o) => o.id).join('\n');
        if (input.placement === 'front' || input.placement === 'back')
          siblings.sort(
            (a, b) => (Number(selected.has(a.id)) - Number(selected.has(b.id))) * (input.placement === 'front' ? 1 : -1)
          );
        else {
          const forward = input.placement === 'forward';
          for (
            let i = forward ? siblings.length - 2 : 1;
            forward ? i >= 0 : i < siblings.length;
            i += forward ? -1 : 1
          ) {
            const j = i + (forward ? 1 : -1);
            if (selected.has(siblings[i].id) && !selected.has(siblings[j].id))
              [siblings[i], siblings[j]] = [siblings[j], siblings[i]];
          }
        }
        // Stacking is relative: when nothing changes place, sparse orders such as 200/420/720 are
        // left alone instead of being renumbered into a write that changes nothing visible.
        if (siblings.map((o) => o.id).join('\n') === before) continue;
        siblings.forEach((o, order) => {
          if (o.order !== order) commands.push({ ...op(o.id), kind: 'reorder', patch: { order } });
        });
      }
      return commands;
    }
    case 'align':
    case 'distribute': {
      const axis = input.axis;
      const extent = axis === 'x' ? 'width' : 'height';
      const entries = roots
        .map((o) => {
          const box = bounds(state, o.id);
          if ('hierarchy' in box) return refuse(o.id, 'CYCLE', 'Cyclic hierarchy is read-only');
          return { o, box, world: worldTransform(state, o.id) };
        })
        .sort((a, b) => a.box[axis] - b.box[axis] || a.o.id.localeCompare(b.o.id));
      const start = Math.min(...entries.map((e) => e.box[axis]));
      const end = Math.max(...entries.map((e) => e.box[axis] + e.box[extent]));
      const gap =
        input.action === 'distribute'
          ? (input.spacing ??
            (end - start - entries.reduce((n, e) => n + e.box[extent], 0)) / Math.max(1, entries.length - 1))
          : 0;
      let cursor = start;
      return entries
        .map(({ o, box, world }) => {
          const target =
            input.action === 'align'
              ? input.anchor === 'start'
                ? start
                : input.anchor === 'end'
                  ? end - box[extent]
                  : (start + end - box[extent]) / 2
              : cursor;
          cursor += box[extent] + gap;
          return moveWorld(
            state,
            o,
            world.x + (axis === 'x' ? target - box.x : 0),
            world.y + (axis === 'y' ? target - box.y : 0)
          );
        })
        .filter((move) => {
          const current = state.objects[move.objectId].position;
          return move.patch.position.x !== current.x || move.patch.position.y !== current.y;
        });
    }
  }
}
export function transform(state: CanvasState, input: z.infer<typeof TransformSchema>): Command[] {
  const roots = normalizeTargets(state, input.targetIds);
  const commands: Command[] = [];
  const visit = (o: CanvasObject, root: boolean, scaleChildren: boolean): void => {
    const base =
      root && input.space === 'world' ? worldTransform(state, o.id) : { ...o.position, rotation: o.rotation };
    const anchor = root ? input.anchor : { x: 0, y: 0 };
    const r = ((root ? input.rotation : 0) * Math.PI) / 180;
    const x = (base.x - anchor.x) * input.scale.width,
      y = (base.y - anchor.y) * input.scale.height;
    const position = {
      x: anchor.x + x * Math.cos(r) - y * Math.sin(r) + (root ? input.translation.x : 0),
      y: anchor.y + x * Math.sin(r) + y * Math.cos(r) + (root ? input.translation.y : 0),
    };
    const movement: Extract<Command, { kind: 'move' }> =
      root && input.space === 'world'
        ? moveWorld(state, o, position.x, position.y)
        : { ...op(o.id), kind: 'move', patch: { position } };
    if (movement.patch.position.x !== o.position.x || movement.patch.position.y !== o.position.y)
      commands.push(movement);
    if ((root && input.rotation !== 0) || (o.size && (input.scale.width !== 1 || input.scale.height !== 1)))
      commands.push({
        ...op(o.id),
        kind: 'update',
        patch: {
          ...(root && input.rotation !== 0 ? { rotation: o.rotation + input.rotation } : {}),
          ...(o.size && (input.scale.width !== 1 || input.scale.height !== 1)
            ? { size: { width: o.size.width * input.scale.width, height: o.size.height * input.scale.height } }
            : {}),
        },
      });
    if (scaleChildren)
      for (const c of Object.values(state.objects).filter((c) => c.parentId === o.id && c.deletedAt === null))
        visit(c, false, true);
  };
  for (const root of roots) {
    requireHierarchy(walkHierarchy(state, [root.id], 'children'));
    const rotation = input.space === 'world' ? worldTransform(state, root.id).rotation : root.rotation;
    if (input.scale.width !== input.scale.height && rotation % 180 !== 0)
      refuse(root.id, 'INVALID', 'Nonuniform scaling in rotated axes would require unsupported affine shear');
    if (root.type === 'group' && input.scale.width !== input.scale.height)
      refuse(root.id, 'INVALID', 'Group scaling must be uniform; affine shear is unsupported');
    visit(root, true, root.type === 'group');
  }
  return commands;
}
export function historyCommands(
  state: CanvasState,
  log: Pick<Operation, 'seq' | 'kind' | 'opId'>[],
  sequences: number[],
  author: Author
): Command[] {
  const wanted = new Set(sequences);
  const chosen = log
    .filter((o) => wanted.has(o.seq))
    .map((record) => {
      const parsed = OperationSchema.safeParse(record);
      if (!parsed.success || !knownKinds.has(record.kind))
        return refuse('', 'INVALID', 'Unknown history operation is read-only');
      return parsed.data;
    })
    .reverse();
  if (chosen.length !== wanted.size) return refuse('', 'NOT_FOUND', 'Unknown history sequence');
  const latest = new Map<string, number>();
  for (const operation of [...chosen].reverse()) {
    if (!sameAuthor(operation.author, author))
      return refuse(operation.objectId, 'INVALID', 'History may only undo the caller author');
    for (const c of operation.prev) latest.set(c.objectId, c.after.revision);
  }
  for (const [id, revision] of latest)
    if (state.objects[id]?.revision !== revision) return refuse(id, 'REVISION', 'Object revision changed');
  const historyRemovals = new Set(
    chosen.flatMap((operation) =>
      operation.prev
        .filter(
          (change) =>
            (operation.kind === 'create' && change.before === null) ||
            (change.before !== null && change.before.deletedAt !== null && change.after.deletedAt === null)
        )
        .map((change) => change.objectId)
    )
  );
  const comments = new Map(state.comments.map((comment) => [comment.id, comment]));
  const commands: Command[] = chosen.flatMap((operation) => {
    if (operation.comment) {
      const current = comments.get(operation.comment.id);
      if (!current || !sameAuthor(current.author, operation.comment.author) || current.text !== operation.comment.text)
        return refuse(operation.objectId, 'REVISION', 'Comment changed');
      comments.delete(operation.comment.id);
    }
    if (operation.removedComment) comments.set(operation.removedComment.id, { ...operation.removedComment, author });
    return invertOperation(operation).map((inverse) => {
      // Intermediate revision preconditions are derived from the validated batch below.
      const { expectedRevision: _expectedRevision, ...command } = inverse;
      return command;
    });
  });
  const result = validateBatch(state, commands, author, 0, historyRemovals);
  if (!result.ok) throw new CanvasCommandError(result.reasons);
  return commands.map((command, index) => ({
    ...command,
    expectedRevision: result.operations[index].prev.find((change) => change.objectId === command.objectId)?.before
      ?.revision,
  }));
}
export function commandFailure(error: unknown): Rejection[] | null {
  return error instanceof CanvasCommandError ? error.reasons : error instanceof HierarchyError ? [error.reason] : null;
}
