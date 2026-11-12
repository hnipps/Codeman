/**
 * @fileoverview FROZEN copy of src/canvas/model.ts as the previous release shipped it
 * (before canvas media). Never edit it to match the current model: it exists so a
 * test can prove that release still reads what this one writes.
 */
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
export const isKnownObject = (o: CanvasObject): boolean => validateKnownObject(o);
const storedContentSchemas = new Map<string, z.ZodType<z.infer<typeof ContentSchema>>>(
  ContentSchema.options.map((schema) => [schema.shape.type.value, schema.strip()])
);
const objectFieldNames = Object.keys(ObjectFieldsSchema.shape);

export function knownContentFields(content: CanvasObject['content']) {
  const contentSchema = storedContentSchemas.get(content.type);
  if (!contentSchema) throw new Error('Unknown content type is read-only');
  return contentSchema.parse(content);
}

/** Validate understood fields without discarding extensions owned by newer releases. */
export function validateKnownObject(o: CanvasObject): boolean {
  const contentSchema = storedContentSchemas.get(o.content.type);
  if (!contentSchema) return false;
  const content = contentSchema.safeParse(o.content);
  if (!content.success) return false;
  return ObjectSchema.safeParse({
    ...Object.fromEntries(objectFieldNames.map((key) => [key, o[key]])),
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
const classifications = new WeakMap<CanvasState, Set<string>>();

/** Private store state owns an in-memory index; public mutable inputs are classified afresh. */
export function knownObjectIds(state: CanvasState): ReadonlySet<string> {
  return (
    classifications.get(state) ??
    new Set(
      Object.values(state.objects)
        .filter(isKnownObject)
        .map((o) => o.id)
    )
  );
}

export function indexKnownObjects(state: CanvasState, known = knownObjectIds(state)): void {
  classifications.set(state, new Set(known));
}

export function classifyObject(state: CanvasState, object: CanvasObject): void {
  const known = classifications.get(state);
  if (!known) throw new Error('Canvas state must be indexed before replay');
  if (isKnownObject(object)) known.add(object.id);
  else known.delete(object.id);
}

export const emptyState = (): CanvasState => ({ seq: 0, objects: {}, comments: [] });
export const sameAuthor = (a: Author, b: Author): boolean =>
  a.kind === 'human' && b.kind === 'human'
    ? a.userId === b.userId
    : a.kind === 'agent' && b.kind === 'agent' && a.sessionId === b.sessionId;
export const isContainer = (o: Pick<CanvasObject, 'type'>): boolean =>
  ['group', 'frame', 'section', 'subcanvas'].includes(o.type);

export const MAX_HIERARCHY_DEPTH = 256;
export const MAX_HIERARCHY_NODES = 10_000;
export type HierarchyIssue = { code: 'CYCLE' | 'HIERARCHY_LIMIT'; objectId: string; message: string };
export class HierarchyError extends Error {
  constructor(readonly reason: HierarchyIssue) {
    super(reason.message);
  }
}

/** Classify loaded parent cycles without the write traversal's depth cutoff. */
export function hierarchyCycles(state: CanvasState): { cycles: Set<string>; affected: Set<string> } {
  const cycles = new Set<string>();
  const affected = new Set<string>();
  const done = new Set<string>();
  for (const root of Object.keys(state.objects)) {
    const path: string[] = [];
    const active = new Map<string, number>();
    let id: string | null = root;
    while (id !== null && state.objects[id] && !done.has(id) && !active.has(id)) {
      active.set(id, path.length);
      path.push(id);
      id = state.objects[id].parentId;
    }
    const start = id === null ? undefined : active.get(id);
    if (start !== undefined) for (const member of path.slice(start)) cycles.add(member);
    const unsafe = start !== undefined || (id !== null && affected.has(id));
    for (const member of path) {
      done.add(member);
      if (unsafe) affected.add(member);
    }
  }
  return { cycles, affected };
}

/** Every hierarchy consumer shares the same iterative, bounded traversal. */
export function walkHierarchy(
  state: CanvasState,
  roots: Iterable<string>,
  direction: 'parents' | 'children',
  geometryOnly = false,
  childrenIndex?: ReadonlyMap<string, ReadonlySet<string>>
): { objects: CanvasObject[]; cycles: Set<string>; issue: HierarchyIssue | null } {
  const children = new Map<string, string[]>();
  if (direction === 'children' && !childrenIndex) {
    for (const o of Object.values(state.objects)) {
      if (o.parentId === null || (geometryOnly && o.deletedAt !== null)) continue;
      const siblings = children.get(o.parentId) ?? [];
      siblings.push(o.id);
      children.set(o.parentId, siblings);
    }
  }
  const objects: CanvasObject[] = [];
  const seen = new Set<string>();
  const active = new Map<string, number>();
  const path: string[] = [];
  const cycles = new Set<string>();
  let issue: HierarchyIssue | null = null;
  for (const root of roots) {
    const stack = [{ id: root, exit: false }];
    while (stack.length) {
      const step = stack.pop();
      if (!step) break;
      if (step.exit) {
        active.delete(step.id);
        path.pop();
        continue;
      }
      const cycleStart = active.get(step.id);
      if (cycleStart !== undefined) {
        for (const id of path.slice(cycleStart)) cycles.add(id);
        issue = { code: 'CYCLE', objectId: step.id, message: 'Cyclic hierarchy is read-only' };
        continue;
      }
      if (seen.has(step.id)) continue;
      if (path.length >= MAX_HIERARCHY_DEPTH || seen.size >= MAX_HIERARCHY_NODES) {
        issue ??=
          direction === 'parents' && hierarchyCycles(state).affected.has(root)
            ? { code: 'CYCLE', objectId: root, message: 'Cyclic hierarchy is read-only' }
            : { code: 'HIERARCHY_LIMIT', objectId: step.id, message: 'Hierarchy traversal limit exceeded' };
        return { objects, cycles, issue };
      }
      seen.add(step.id);
      const o = state.objects[step.id];
      if (!o) continue;
      objects.push(o);
      active.set(step.id, path.length);
      path.push(step.id);
      stack.push({ id: step.id, exit: true });
      const next =
        direction === 'parents'
          ? o.parentId === null
            ? []
            : [o.parentId]
          : geometryOnly && o.size
            ? []
            : childrenIndex
              ? [...(childrenIndex.get(o.id) ?? [])]
              : (children.get(o.id) ?? []);
      for (let i = next.length - 1; i >= 0; i--) stack.push({ id: next[i], exit: false });
    }
  }
  return { objects, cycles, issue };
}

export function requireHierarchy(walk: ReturnType<typeof walkHierarchy>): CanvasObject[] {
  if (walk.issue) throw new HierarchyError(walk.issue);
  return walk.objects;
}

export function descendants(state: CanvasState, id: string, complete = false): CanvasObject[] {
  const walk = walkHierarchy(state, [id], 'children');
  if (complete && walk.issue?.code === 'HIERARCHY_LIMIT' && hierarchyCycles(state).cycles.has(id))
    walk.issue = { code: 'CYCLE', objectId: id, message: 'Cyclic hierarchy is read-only' };
  if (!complete || !walk.issue) return walk.objects;
  if (walk.issue.code !== 'CYCLE') return requireHierarchy(walk);
  const children = new Map<string, CanvasObject[]>();
  for (const object of Object.values(state.objects)) {
    if (object.parentId === null) continue;
    const siblings = children.get(object.parentId) ?? [];
    siblings.push(object);
    children.set(object.parentId, siblings);
  }
  const objects: CanvasObject[] = [];
  const seen = new Set<string>();
  const pending = [id];
  while (pending.length) {
    const next = pending.pop();
    if (!next || seen.has(next)) continue;
    if (seen.size >= MAX_HIERARCHY_NODES)
      throw new HierarchyError({
        code: 'HIERARCHY_LIMIT',
        objectId: next,
        message: 'Hierarchy traversal limit exceeded',
      });
    seen.add(next);
    const object = state.objects[next];
    if (!object) continue;
    objects.push(object);
    for (const child of [...(children.get(next) ?? [])].reverse()) pending.push(child.id);
  }
  return objects;
}

export function effectiveLock(
  state: CanvasState,
  id: string
): { objectId: string; mode: 'subtree' | 'background' } | null {
  let result: ReturnType<typeof effectiveLock> = null;
  for (const o of requireHierarchy(walkHierarchy(state, [id], 'parents'))) {
    if (o.lock && (o.id === id || o.lock === 'subtree')) result = { objectId: o.id, mode: o.lock };
  }
  return result;
}

export type Transform = { x: number; y: number; rotation: number };
export function worldTransform(state: CanvasState, id: string): Transform {
  if (!state.objects[id]) throw new Error('Unknown object');
  let p: Transform = { x: 0, y: 0, rotation: 0 };
  for (const o of requireHierarchy(walkHierarchy(state, [id], 'parents')).reverse()) {
    const r = (p.rotation * Math.PI) / 180;
    p = {
      x: p.x + o.position.x * Math.cos(r) - o.position.y * Math.sin(r),
      y: p.y + o.position.x * Math.sin(r) + o.position.y * Math.cos(r),
      rotation: p.rotation + o.rotation,
    };
  }
  return p;
}
function geometryPoints(state: CanvasState, id: string): { x: number; y: number }[] {
  if (!state.objects[id]) throw new Error('Unknown object');
  const objects = requireHierarchy(walkHierarchy(state, [id], 'children', true));
  const pointsById = new Map<string, { x: number; y: number }[]>();
  const children = new Map<string, string[]>();
  for (const o of objects) {
    if (o.parentId === null) continue;
    const siblings = children.get(o.parentId) ?? [];
    siblings.push(o.id);
    children.set(o.parentId, siblings);
  }
  for (const o of objects.reverse()) {
    const points = o.size
      ? [
          { x: 0, y: 0 },
          { x: o.size.width, y: 0 },
          { x: 0, y: o.size.height },
          { x: o.size.width, y: o.size.height },
        ]
      : (children.get(o.id) ?? []).flatMap((child) => pointsById.get(child) ?? []);
    const r = (o.rotation * Math.PI) / 180;
    pointsById.set(
      o.id,
      (points.length ? points : [{ x: 0, y: 0 }]).map((p) => ({
        x: o.position.x + p.x * Math.cos(r) - p.y * Math.sin(r),
        y: o.position.y + p.x * Math.sin(r) + p.y * Math.cos(r),
      }))
    );
  }
  return pointsById.get(id) ?? [];
}

/** Local bounds are in the object's parent coordinates; world bounds include every ancestor. */
export function bounds(
  state: CanvasState,
  id: string,
  space: 'local' | 'world' = 'world'
): { x: number; y: number; width: number; height: number } | { hierarchy: 'cycle' } {
  const hierarchy = walkHierarchy(state, [id], 'parents');
  if (hierarchy.issue?.code === 'CYCLE') return { hierarchy: 'cycle' };
  requireHierarchy(hierarchy);
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
