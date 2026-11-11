import type { Author } from '../src/canvas/model.js';
import { CommandSchema, type Command } from '../src/canvas/operations.js';

export const human: Author = { kind: 'human', userId: 'user-a' };
export const agent: Author = { kind: 'agent', sessionId: 'session-a' };
export function create(
  id: string,
  parentId: string | null = null,
  type: 'text' | 'group' | 'frame' | 'section' | 'subcanvas' = 'text'
): Command {
  return CommandSchema.parse({
    kind: 'create',
    opId: `create-${id}`,
    objectId: id,
    patch: {
      parentId,
      order: 0,
      position: { x: 10, y: 20 },
      size: type === 'group' ? null : { width: 100, height: 80 },
      content:
        type === 'text'
          ? { type, text: id }
          : type === 'subcanvas'
            ? { type, workspaceId: 'nested', label: id }
            : { type, label: id },
    },
  });
}
