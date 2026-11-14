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
import { type ElementRef } from './element-ref.js';

/** One element's lines in the block, the marker included, are cut here. */
export const MAX_ELEMENT_BLOCK_BYTES = 2 * 1024;

export type ResolvedContext = {
  /** The block, ending with the reference-data notice and a line break. Always present: its `message` id is how a prompt row is matched to its record, even with nothing attached. */
  block: string;
  refs: ConversationRef[];
  /** Ids named by the caller that no longer exist or are deleted; they are left out, never an error. */
  missing: string[];
};

/** The object is on the canvas and is an embed: the only kind whose frame holds elements. */
export const liveEmbed = (state: CanvasState, objectId: string): boolean => {
  const o = state.objects[objectId];
  return o !== undefined && o.deletedAt === null && o.type === 'embed';
};
/** One line of plain text: control characters and the block's own tags cannot survive into the pane. */
export function plainLine(value: unknown, limit: number): string {
  const text = typeof value === 'string' ? value : '';
  return (
    text
      .replace(/<(\/?)canvas-context/gi, '‹$1canvas-context')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, limit)
  );
}
/** The longest prefix of `text` that fits `limit` UTF-8 bytes, never half a character. */
function cutBytes(text: string, limit: number): string {
  if (byteLength(text) <= limit) return text;
  let out = '';
  let used = 0;
  for (const char of text) {
    used += byteLength(char);
    if (used > limit) break;
    out += char;
  }
  return out;
}
/**
 * A value between double quotes in an element line. It holds no double quote and no line break, so the value ends
 * at the next `"` and nothing a page writes can close the bracket or start a line of its own.
 */
const quoted = (value: unknown, bytes: number): string => cutBytes(plainLine(value, bytes).replaceAll('"', "'"), bytes);
const bareName = (value: string, limit: number): string => value.replace(/[^A-Za-z0-9_:.-]/g, '').slice(0, limit);
const ELEMENT_CUT = ' … truncated';
const ELEMENT_FIELD_BYTES = { selector: 600, path: 320, source: 160, text: 480 } as const;

/**
 * One element as indented lines under its embed: the bracketed facts and the text, then `attrs:` and `styles:`
 * where there are any. Every string came from the page in the frame; see `quoted`.
 */
export function elementLines(element: ElementRef): { lines: string[]; truncated: boolean } {
  let truncated = false;
  const field = (value: string | undefined, bytes: number): string => {
    const out = quoted(value, bytes);
    if (out !== plainLine(value, Infinity).replaceAll('"', "'")) truncated = true;
    return out;
  };
  const box = [element.rect.x, element.rect.y, element.rect.width, element.rect.height].map((n) => Math.round(n));
  const head =
    `  [${element.objectId} element selector="${field(element.selector, ELEMENT_FIELD_BYTES.selector)}"` +
    ` path="${field(element.path, ELEMENT_FIELD_BYTES.path)}"` +
    ` tag=${bareName(element.tag.toLowerCase(), 32) || 'unknown'}` +
    ` box=${box[0]},${box[1]},${box[2]}x${box[3]}` +
    (element.source ? ` source="${field(element.source, ELEMENT_FIELD_BYTES.source)}"` : '') +
    ']';
  const text = field(element.text, ELEMENT_FIELD_BYTES.text);
  const lines = [text ? `${head} ${text}` : head];
  let left = MAX_ELEMENT_BLOCK_BYTES - byteLength(ELEMENT_CUT) - byteLength(lines[0]) - 1;
  for (const [name, entries] of [
    ['attrs', element.attrs],
    ['styles', element.styles],
  ] as const) {
    let line = `    ${name}:`;
    let any = false;
    for (const [key, value] of Object.entries(entries)) {
      const pair = ` ${bareName(key, 64) || 'unknown'}="${quoted(value, 512)}"`;
      if (byteLength(line) + byteLength(pair) + 1 > left) {
        truncated = true;
        break;
      }
      line += pair;
      any = true;
    }
    if (!any) continue;
    lines.push(line);
    left -= byteLength(line) + 1;
  }
  if (truncated) lines[lines.length - 1] += ELEMENT_CUT;
  return { lines, truncated };
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
 *
 * An element is written directly under the line of the embed whose frame holds it, and brings that embed into the
 * block when the caller did not name it. One on an object that is gone or is not an embed is left out. Elements
 * count against the block's bytes: the ones that do not fit are dropped, and the block says so.
 */
export function resolveContext(
  state: CanvasState,
  workspaceId: string,
  messageId: string,
  refIds: readonly string[],
  elements: readonly ElementRef[] = []
): ResolvedContext {
  const children = childIndex(state);
  const inside = new Map<string, ElementRef[]>();
  for (const element of elements) {
    if (!liveEmbed(state, element.objectId)) continue;
    inside.set(element.objectId, [...(inside.get(element.objectId) ?? []), element]);
  }
  const wanted = [...new Set([...refIds, ...inside.keys()])];
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
  let elementsCut = false;
  /** Objects whose elements were shortened or dropped. */
  const clipped = new Set<string>();
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
    for (const element of inside.get(o.id) ?? []) {
      const written = elementLines(element);
      const size = written.lines.reduce((sum, l) => sum + byteLength(l) + 1, 0);
      if (bytes + size > MAX_CONTEXT_BLOCK_BYTES) {
        elementsCut = true;
        clipped.add(o.id);
        break;
      }
      if (written.truncated) clipped.add(o.id);
      lines.push(...written.lines);
      bytes += size;
    }
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
    if (byteLength(textOf(root)) > MAX_OBJECT_TEXT_BYTES || clipped.has(id)) ref.truncated = true;
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
      if (byteLength(textOf(next)) > MAX_OBJECT_TEXT_BYTES || clipped.has(next.id)) ref.truncated = true;
      stack.push(...[...(children.get(next.id) ?? [])].reverse());
    }
  }
  const head = `<canvas-context workspace="${plainLine(workspaceId, 128).replaceAll('"', '')}" seq="${state.seq}" message="${messageId}">`;
  const tail = [
    ...(elementsCut ? ['… more elements were attached than fit'] : []),
    ...(cut ? ['… more objects were attached than fit; read the rest with canvas_read'] : []),
  ];
  return {
    block: [
      head,
      ...(refs.length ? lines : ['(no objects attached)']),
      ...tail,
      '</canvas-context>',
      CONTEXT_NOTICE,
      '',
    ].join('\n'),
    refs,
    missing,
  };
}
