/** @fileoverview Canonical canvas objects, local geometry and derived hierarchy. */
import { z } from 'zod';

export const IdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,128}$/)
  .refine((id) => !['__proto__', 'constructor', 'prototype'].includes(id), 'Reserved id');
export const AuthorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human'), userId: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal('agent'), sessionId: IdSchema }).strict(),
]);
export type Author = z.infer<typeof AuthorSchema>;
export const PositionSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
export const SizeSchema = z
  .object({ width: z.number().positive().finite(), height: z.number().positive().finite() })
  .strict();
export const LockSchema = z.enum(['subtree', 'background']).nullable();
export const ContentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(1_000_000) }).strict(),
  z.object({ type: z.literal('image'), url: z.string().max(8192), alt: z.string().max(8192).default('') }).strict(),
  z.object({ type: z.literal('link'), url: z.string().max(8192), label: z.string().max(8192).default('') }).strict(),
  z.object({ type: z.literal('embed'), url: z.string().max(8192) }).strict(),
  z.object({ type: z.literal('group'), label: z.string().max(8192) }).strict(),
  z.object({ type: z.literal('frame'), label: z.string().max(8192) }).strict(),
  z.object({ type: z.literal('section'), label: z.string().max(8192) }).strict(),
  z.object({ type: z.literal('subcanvas'), workspaceId: IdSchema, label: z.string().max(8192) }).strict(),
]);
export const MutableSchema = z
  .object({
    parentId: IdSchema.nullable(),
    order: z.number().finite(),
    position: PositionSchema,
    size: SizeSchema.nullable(),
    rotation: z.number().finite(),
    lock: LockSchema,
    content: ContentSchema,
    deletedAt: z.number().int().nonnegative().nullable(),
    deletionOpId: IdSchema.nullable(),
  })
  .strict();
const ObjectFieldsSchema = MutableSchema.extend({
  deletionOpId: IdSchema.nullable().default(null),
  id: IdSchema,
  type: z.enum(['text', 'image', 'link', 'embed', 'group', 'frame', 'section', 'subcanvas']),
  author: AuthorSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
});
export const ObjectSchema = ObjectFieldsSchema.refine(
  (o) => o.type === o.content.type,
  'content type must match object type'
)
  .refine(
    (o) => o.type !== 'group' || (o.size === null && o.lock !== 'background'),
    'groups are auto-bounded and only support subtree locks'
  )
  .refine(
    (o) => o.lock !== 'background' || o.type === 'frame' || o.type === 'section',
    'background locks require frame or section'
  )
  .refine((o) => o.type === 'group' || o.size !== null, 'explicitly sized objects require size');
export const StoredObjectSchema = ObjectFieldsSchema.extend({
  type: z.string(),
  content: z.object({ type: z.string() }).passthrough(),
}).passthrough();
export type CanvasObject = z.infer<typeof StoredObjectSchema>;
export const isKnownObject = (o: CanvasObject): boolean => ObjectFieldsSchema.shape.type.safeParse(o.type).success;

export function knownContentFields(content: CanvasObject['content']) {
  const contentSchema = ContentSchema.options.find((schema) => schema.shape.type.value === content.type);
  if (!contentSchema) throw new Error('Unknown content type is read-only');
  return contentSchema.strip().parse(content);
}

/** Validate understood fields without discarding extensions owned by newer releases. */
export function validateKnownObject(o: CanvasObject): boolean {
  const contentSchema = ContentSchema.options.find((schema) => schema.shape.type.value === o.content.type);
  if (!contentSchema) return false;
  const content = contentSchema.strip().safeParse(o.content);
  if (!content.success) return false;
  return ObjectSchema.safeParse({
    ...Object.fromEntries(Object.keys(ObjectFieldsSchema.shape).map((key) => [key, o[key]])),
    content: content.data,
  }).success;
}
export type MutableFields = z.infer<typeof MutableSchema>;
export const CommentSchema = z
  .object({
    id: IdSchema,
    objectId: IdSchema,
    author: AuthorSchema,
    text: z.string().max(100_000),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type Comment = z.infer<typeof CommentSchema>;
export const StateSchema = z.object({
  seq: z.number().int().nonnegative(),
  objects: z.record(z.string(), StoredObjectSchema),
  comments: z.array(CommentSchema),
});
export type CanvasState = z.infer<typeof StateSchema>;
export const emptyState = (): CanvasState => ({ seq: 0, objects: {}, comments: [] });
export const sameAuthor = (a: Author, b: Author): boolean =>
  a.kind === 'human' && b.kind === 'human'
    ? a.userId === b.userId
    : a.kind === 'agent' && b.kind === 'agent' && a.sessionId === b.sessionId;
export const isContainer = (o: CanvasObject): boolean => ['group', 'frame', 'section', 'subcanvas'].includes(o.type);

export function descendants(state: CanvasState, id: string): CanvasObject[] {
  const children = new Map<string, CanvasObject[]>();
  for (const o of Object.values(state.objects)) {
    if (o.parentId !== null) {
      const siblings = children.get(o.parentId) ?? [];
      siblings.push(o);
      children.set(o.parentId, siblings);
    }
  }
  const result: CanvasObject[] = [];
  const visit = (key: string): void => {
    const o = state.objects[key];
    if (o) result.push(o);
    for (const child of children.get(key) ?? []) visit(child.id);
  };
  visit(id);
  return result;
}

export function effectiveLock(
  state: CanvasState,
  id: string
): { objectId: string; mode: 'subtree' | 'background' } | null {
  let o: CanvasObject | undefined = state.objects[id];
  let result: ReturnType<typeof effectiveLock> = null;
  while (o) {
    if (o.lock && (o.id === id || o.lock === 'subtree')) result = { objectId: o.id, mode: o.lock };
    o = o.parentId === null ? undefined : state.objects[o.parentId];
  }
  return result;
}

export type Transform = { x: number; y: number; rotation: number };
export function worldTransform(state: CanvasState, id: string): Transform {
  const o = state.objects[id];
  if (!o) throw new Error('Unknown object');
  const p = o.parentId === null ? { x: 0, y: 0, rotation: 0 } : worldTransform(state, o.parentId);
  const r = (p.rotation * Math.PI) / 180;
  return {
    x: p.x + o.position.x * Math.cos(r) - o.position.y * Math.sin(r),
    y: p.y + o.position.x * Math.sin(r) + o.position.y * Math.cos(r),
    rotation: p.rotation + o.rotation,
  };
}
function geometryPoints(state: CanvasState, id: string): { x: number; y: number }[] {
  const o = state.objects[id];
  if (!o) throw new Error('Unknown object');
  const points = o.size
    ? [
        { x: 0, y: 0 },
        { x: o.size.width, y: 0 },
        { x: 0, y: o.size.height },
        { x: o.size.width, y: o.size.height },
      ]
    : Object.values(state.objects)
        .filter((c) => c.parentId === id && c.deletedAt === null)
        .flatMap((c) => geometryPoints(state, c.id));
  const r = (o.rotation * Math.PI) / 180;
  return (points.length ? points : [{ x: 0, y: 0 }]).map((p) => ({
    x: o.position.x + p.x * Math.cos(r) - p.y * Math.sin(r),
    y: o.position.y + p.x * Math.sin(r) + p.y * Math.cos(r),
  }));
}

/** Local bounds are in the object's parent coordinates; world bounds include every ancestor. */
export function bounds(
  state: CanvasState,
  id: string,
  space: 'local' | 'world' = 'world'
): { x: number; y: number; width: number; height: number } {
  const o = state.objects[id];
  if (!o) throw new Error('Unknown object');
  const parent =
    space === 'world' && o.parentId !== null ? worldTransform(state, o.parentId) : { x: 0, y: 0, rotation: 0 };
  const r = (parent.rotation * Math.PI) / 180;
  const points = geometryPoints(state, id).map((p) => ({
    x: parent.x + p.x * Math.cos(r) - p.y * Math.sin(r),
    y: parent.y + p.x * Math.sin(r) + p.y * Math.cos(r),
  }));
  const x = Math.min(...points.map((p) => p.x)),
    y = Math.min(...points.map((p) => p.y));
  return { x, y, width: Math.max(...points.map((p) => p.x)) - x, height: Math.max(...points.map((p) => p.y)) - y };
}
