/** @fileoverview Turns the objects a message names into the reference block that precedes the person's text, and the manifest of what was sent. Pure: it reads a state and returns text; it writes nothing. */
import {
  byteLength,
  CONTEXT_NOTICE,
  MAX_CONTEXT_BLOCK_BYTES,
  MAX_CONTEXT_OBJECTS,
  MAX_OBJECT_TEXT_BYTES,
  type ConversationRef,
} from './conversation-schema.js';
import { type CanvasObject, type CanvasState } from './model.js';

export type ResolvedContext = {
  /** The block, ending with the reference-data notice and a line break; empty when nothing was attached. */
  block: string;
  refs: ConversationRef[];
  /** Ids named by the caller that no longer exist or are deleted; they are left out, never an error. */
  missing: string[];
};

/** One line of plain text: control characters and the block's own tags cannot survive into the pane. */
export function plainLine(value: unknown, limit: number): string {
  const text = typeof value === 'string' ? value : '';
  // eslint-disable-next-line no-control-regex
  return text
    .replace(/<(\/?)canvas-context/gi, '‹$1canvas-context')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, limit);
}
function textOf(o: CanvasObject): string {
  const c = o.content as Record<string, unknown>;
  switch (o.type) {
    case 'text':
      return typeof c.text === 'string' ? c.text : '';
    case 'image':
      return typeof c.alt === 'string' ? c.alt : '';
    case 'link':
    case 'embed':
      return [c.label, c.url].filter((v) => typeof v === 'string' && v).join(' ');
    default:
      return typeof c.label === 'string' ? c.label : '';
  }
}
const labelOf = (o: CanvasObject): string => plainLine(textOf(o), 80) || o.type;
const sortChildren = (a: CanvasObject, b: CanvasObject): number => a.order - b.order || (a.id < b.id ? -1 : 1);

/** Children of every live object, in sibling order. */
function childIndex(state: CanvasState): Map<string, CanvasObject[]> {
  const children = new Map<string, CanvasObject[]>();
  for (const o of Object.values(state.objects)) {
    if (o.parentId === null || o.deletedAt !== null) continue;
    children.set(o.parentId, [...(children.get(o.parentId) ?? []), o]);
  }
  for (const list of children.values()) list.sort(sortChildren);
  return children;
}
function pathOf(state: CanvasState, o: CanvasObject): string {
  const names: string[] = [];
  const seen = new Set([o.id]);
  let parent = o.parentId === null ? undefined : state.objects[o.parentId];
  while (parent && names.length < 12 && !seen.has(parent.id)) {
    seen.add(parent.id);
    names.unshift(labelOf(parent).replaceAll('"', "'"));
    parent = parent.parentId === null ? undefined : state.objects[parent.parentId];
  }
  return names.join(' / ');
}

/**
 * Objects are read in the order the caller named them. A container brings its live descendants in sibling
 * order; a child named beside its own attached ancestor is not repeated. Locked objects are included, deleted
 * ones are not. Bounds: one object's text, the whole block, and the number of objects.
 */
export function resolveContext(
  state: CanvasState,
  workspaceId: string,
  messageId: string,
  refIds: readonly string[]
): ResolvedContext {
  const children = childIndex(state);
  const wanted = [...new Set(refIds)];
  const live = wanted.filter((id) => state.objects[id] && state.objects[id].deletedAt === null);
  const missing = wanted.filter((id) => !live.includes(id));
  const liveSet = new Set(live);
  const roots = live.filter((id) => {
    const seen = new Set([id]);
    let parent = state.objects[id].parentId;
    while (parent !== null && !seen.has(parent)) {
      if (liveSet.has(parent)) return false;
      seen.add(parent);
      parent = state.objects[parent]?.parentId ?? null;
    }
    return true;
  });
  const lines: string[] = [];
  const refs: ConversationRef[] = [];
  let bytes = 0;
  let objects = 0;
  let cut = false;
  const emit = (o: CanvasObject): boolean => {
    if (objects >= MAX_CONTEXT_OBJECTS) return false;
    const full = textOf(o);
    const tooLong = byteLength(full) > MAX_OBJECT_TEXT_BYTES;
    const body = plainLine(tooLong ? full.slice(0, MAX_OBJECT_TEXT_BYTES) : full, MAX_OBJECT_TEXT_BYTES);
    const line = `[${o.id} rev=${o.revision} type=${o.type} path="${pathOf(state, o)}"] ${body}${
      tooLong ? ` … truncated; read with canvas_read ${o.id}` : ''
    }`;
    if (bytes + byteLength(line) + 1 > MAX_CONTEXT_BLOCK_BYTES) return false;
    lines.push(line);
    bytes += byteLength(line) + 1;
    objects++;
    return true;
  };
  for (const id of roots) {
    const root = state.objects[id];
    const ref: ConversationRef = {
      id,
      label: labelOf(root),
      type: root.type,
      revision: root.revision,
      descendants: [],
      truncated: false,
    };
    refs.push(ref);
    if (cut) {
      ref.truncated = true;
      continue;
    }
    if (!emit(root)) {
      ref.truncated = cut = true;
      continue;
    }
    if (byteLength(textOf(root)) > MAX_OBJECT_TEXT_BYTES) ref.truncated = true;
    const stack = [...(children.get(id) ?? [])].reverse();
    const seen = new Set([id]);
    while (stack.length) {
      const next = stack.pop()!;
      if (seen.has(next.id)) continue;
      seen.add(next.id);
      if (!emit(next)) {
        ref.truncated = cut = true;
        break;
      }
      ref.descendants.push({ id: next.id, revision: next.revision });
      if (byteLength(textOf(next)) > MAX_OBJECT_TEXT_BYTES) ref.truncated = true;
      stack.push(...[...(children.get(next.id) ?? [])].reverse());
    }
  }
  if (!refs.length) return { block: '', refs, missing };
  const head = `<canvas-context workspace="${plainLine(workspaceId, 128).replaceAll('"', '')}" seq="${state.seq}" message="${messageId}">`;
  const tail = cut ? ['… more objects were attached than fit; read the rest with canvas_read'] : [];
  return {
    block: [head, ...lines, ...tail, '</canvas-context>', CONTEXT_NOTICE, ''].join('\n'),
    refs,
    missing,
  };
}
