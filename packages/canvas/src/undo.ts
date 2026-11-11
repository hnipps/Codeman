import { MutableSchema } from '../../../src/canvas/model.js';
import { EditSchema, type Edit, type Acknowledged } from './edit-queue.js';
import type { ViewObject } from './model.js';
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
type Entry = { operations: Acknowledged[]; focusId: string | null };
export class CanvasUndo {
  private undo: Entry[] = [];
  private redo: Entry[] = [];
  private pending: { direction: 'undo' | 'redo'; ids: Set<string>; focusId: string | null } | null = null;
  acknowledge(operations: Acknowledged[], focusId: string | null): string | null {
    const pending = this.pending;
    if (pending && operations.every((op) => pending.ids.has(op.opId))) {
      (pending.direction === 'undo' ? this.undo : this.redo).pop();
      (pending.direction === 'undo' ? this.redo : this.undo).push({ operations, focusId: pending.focusId });
      this.pending = null;
      return pending.focusId;
    }
    this.undo.push({ operations, focusId });
    this.redo = [];
    return null;
  }
  prepare(direction: 'undo' | 'redo', objects: ViewObject[]): { operations: Edit[]; focusId: string | null } | null {
    if (this.pending) throw new Error('Wait for the previous history edit to save.');
    const entry = (direction === 'undo' ? this.undo : this.redo).at(-1);
    if (!entry) return null;
    const changes = new Map<string, { before: ViewObject | null; after: ViewObject }>();
    for (const op of entry.operations)
      for (const change of op.prev) {
        const earlier = changes.get(change.objectId);
        changes.set(change.objectId, { before: earlier ? earlier.before : change.before, after: change.after });
      }
    const roots = entry.operations.filter((op) => ['create', 'delete', 'restore'].includes(op.kind));
    const covered = new Set(
      roots.flatMap((op) => op.prev.filter((c) => c.objectId !== op.objectId).map((c) => c.objectId))
    );
    const operations: Edit[] = [];
    const guards: Edit[] = [];
    for (const [id, change] of changes) {
      const current = objects.find((o) => o.id === id);
      if (!current) throw new Error('History cannot overwrite an object that is no longer available.');
      const fields = Object.keys(MutableSchema.shape).filter(
        (field) => !change.before || !same(change.before[field], change.after[field])
      );
      if (fields.some((field) => !same(current[field], change.after[field])))
        throw new Error('History would overwrite a later change. That change has been kept.');
      if (
        roots.some((op) => (op.kind === 'create' || op.kind === 'restore') && op.prev.some((c) => c.objectId === id)) &&
        current.revision !== change.after.revision
      )
        throw new Error('History would delete later work. That change has been kept.');
      const revision = typeof current.revision === 'number' ? current.revision : undefined;
      if (covered.has(id)) {
        guards.push({ kind: 'revert', opId: crypto.randomUUID(), objectId: id, expectedRevision: revision, patch: {} });
        continue;
      }
      const root = roots.find((op) => op.objectId === id);
      if (root?.kind === 'create' || root?.kind === 'restore') {
        const known = new Set(root.prev.map((c) => c.objectId));
        const descendants = new Set([id]);
        for (let changed = true; changed; ) {
          changed = false;
          for (const o of objects)
            if (o.parentId && descendants.has(o.parentId) && !descendants.has(o.id) && o.deletedAt === null) {
              descendants.add(o.id);
              changed = true;
            }
        }
        if ([...descendants].some((child) => !known.has(child)))
          throw new Error('History would delete later work inside this container.');
        operations.push({ kind: 'delete', opId: crypto.randomUUID(), objectId: id, expectedRevision: revision });
      } else if (root?.kind === 'delete')
        operations.push({ kind: 'restore', opId: crypto.randomUUID(), objectId: id, expectedRevision: revision });
      else if (change.before && fields.length) {
        operations.push(
          EditSchema.parse({
            kind: 'revert',
            opId: crypto.randomUUID(),
            objectId: id,
            expectedRevision: revision,
            patch: Object.fromEntries(fields.map((field) => [field, change.before?.[field]])),
          })
        );
      }
    }
    const result = [...guards, ...operations];
    if (!result.length) return null;
    this.pending = { direction, ids: new Set(result.map((op) => op.opId)), focusId: entry.focusId };
    return { operations: result, focusId: entry.focusId };
  }
  available(direction: 'undo' | 'redo'): boolean {
    return !this.pending && (direction === 'undo' ? this.undo : this.redo).length > 0;
  }
  refused(): void {
    this.pending = null;
  }
}
