import { z } from 'zod';
import { lockOwner } from './arrange.js';
import { label, type ViewObject } from './model.js';
import type { Edit, RefusalReason } from './edit-queue.js';

export type RefusalVerb =
  | 'move'
  | 'arrange'
  | 'edit'
  | 'resize'
  | 'rotate'
  | 'delete'
  | 'group'
  | 'ungroup'
  | 'undo'
  | 'redo'
  | 'change';
export type RefusalCopy = { text: string; detail?: string };

const NAME_LIMIT = 32;
export function shortName(object: ViewObject | undefined): string {
  if (!object) return 'That object';
  const name = label(object).trim() || object.type;
  const short = name.length > NAME_LIMIT ? `${name.slice(0, NAME_LIMIT - 1).trimEnd()}…` : name;
  return `"${short}"`;
}
const phrase = (verb: RefusalVerb): string =>
  verb === 'undo' || verb === 'redo' ? `${verb} that change` : `${verb} it`;

/** The sentence for an action a lock forbids on `object`, or null when nothing locks it. */
export function lockedSentence(objects: ViewObject[], object: ViewObject, verb: RefusalVerb): string | null {
  const owner = lockOwner(objects, object);
  if (!owner) return null;
  if (owner.id === object.id) return `${shortName(object)} is locked. Unlock it to ${phrase(verb)}.`;
  return `${shortName(object)} is inside locked ${shortName(owner)}. Unlock ${shortName(owner)} first.`;
}

const Loose = z.object({}).passthrough();
const ArgumentsSchema = z
  .object({
    action: z.string().optional(),
    parentId: z.string().nullable().optional(),
    scale: z.object({ width: z.number(), height: z.number() }).optional(),
    rotation: z.number().optional(),
    operations: z.array(Loose.extend({ kind: z.string().optional(), patch: Loose.optional() })).optional(),
  })
  .passthrough();
type Request = { tool: string; arguments: unknown } | undefined;

function patchVerb(kind: string | undefined, patch: Record<string, unknown> | undefined): RefusalVerb {
  if (kind === 'delete') return 'delete';
  if (kind === 'move' || kind === 'reparent') return 'move';
  if (patch?.content) return 'edit';
  if (patch?.size) return 'resize';
  if (patch?.rotation !== undefined) return 'rotate';
  if (patch?.position) return 'move';
  return 'change';
}

/** The verb a refused request attempted, read from its typed request or native operations. */
export function requestVerb(request: Request, operations: Edit[]): RefusalVerb {
  if (!request) {
    const op = operations[0];
    return op ? patchVerb(op.kind, 'patch' in op ? op.patch : undefined) : 'change';
  }
  const args = ArgumentsSchema.safeParse(request.arguments);
  const data = args.success ? args.data : {};
  switch (request.tool) {
    case 'canvas_delete':
      return 'delete';
    case 'canvas_transform':
      if (data.scale && (data.scale.width !== 1 || data.scale.height !== 1)) return 'resize';
      return data.rotation ? 'rotate' : 'move';
    case 'canvas_update': {
      const op = data.operations?.[0];
      return patchVerb(op?.kind, op?.patch);
    }
    case 'canvas_arrange':
      if (data.action === 'reparent') return 'move';
      if (data.action === 'group' || data.action === 'ungroup') return data.action;
      return data.action === 'duplicate' ? 'change' : 'arrange';
    case 'canvas_history':
      return data.action === 'redo' ? 'redo' : 'undo';
    default:
      return 'change';
  }
}

function destination(request: Request): string | null {
  const args = ArgumentsSchema.safeParse(request?.arguments);
  if (!args.success) return null;
  if (args.data.parentId) return args.data.parentId;
  const parent = args.data.operations?.find((op) => typeof op.patch?.parentId === 'string')?.patch?.parentId;
  return typeof parent === 'string' ? parent : null;
}

function descendantsOf(objects: ViewObject[], id: string): ViewObject[] {
  const found: ViewObject[] = [];
  const queue = [id];
  const seen = new Set(queue);
  while (queue.length && found.length < 10_000) {
    const parent = queue.shift();
    for (const o of objects)
      if (o.parentId === parent && !seen.has(o.id)) {
        seen.add(o.id);
        found.push(o);
        queue.push(o.id);
      }
  }
  return found;
}

/**
 * Product copy for a server refusal, chosen from the structured reason code only. The server's
 * own text is never parsed; an unknown code keeps it as `detail` for a title attribute.
 */
export function refusalCopy(
  objects: ViewObject[],
  reasons: RefusalReason[],
  verb: RefusalVerb,
  request?: Request,
  serverText = ''
): RefusalCopy {
  const reason = reasons[0];
  const fallback = { text: 'That change was refused.', detail: reason?.message || serverText || undefined };
  if (!reason) return fallback;
  const object = objects.find((o) => o.id === reason.objectId);
  const name = shortName(object);
  switch (reason.code) {
    case 'LOCKED': {
      if (object) {
        const sentence = lockedSentence(objects, object, verb);
        if (sentence) return { text: sentence };
        const child = descendantsOf(objects, object.id).find((o) => o.lock === 'subtree' || o.lock === 'background');
        if (child) return { text: `${name} contains locked ${shortName(child)}. Unlock ${shortName(child)} first.` };
      }
      const target = objects.find((o) => o.id === destination(request));
      const owner = target ? lockOwner(objects, target) : null;
      if (owner) return { text: `${shortName(owner)} is locked. Unlock it to move things into it.` };
      return { text: `${name} is locked. Unlock it to ${phrase(verb)}.` };
    }
    case 'CYCLE':
      return { text: `${name} can't be placed inside itself.` };
    case 'HIERARCHY_LIMIT':
      return { text: `${name} is nested too deeply to change.` };
    case 'REVISION':
      return verb === 'undo' || verb === 'redo'
        ? { text: `${name} changed after that edit, so it can't be ${verb === 'undo' ? 'undone' : 'redone'}.` }
        : { text: `${name} changed in the meantime. Check it and try again.` };
    case 'DEPENDENTS': {
      const dependents = reason.dependents ?? [];
      const first = objects.find((o) => o.id === dependents[0]?.objectId);
      const more = dependents.length > 1 ? ` and ${dependents.length - 1} more` : '';
      const added = dependents.length > 1 ? 'were' : 'was';
      return {
        text: `Can't ${verb === 'redo' ? 'redo' : 'undo'}: ${first ? shortName(first) : 'an object'}${more} ${added} added to ${name} later.`,
      };
    }
    default:
      return fallback;
  }
}
