import { z } from 'zod';
import { AuthorSchema, IdSchema, PositionSchema, SizeSchema, isContainer } from '../../../src/canvas/model.js';

// The read boundary accepts future content types without interpreting their payload.
export const ViewObjectSchema = z
  .object({
    id: IdSchema,
    type: z.string(),
    parentId: IdSchema.nullable(),
    order: z.number().finite(),
    position: PositionSchema.passthrough(),
    size: SizeSchema.passthrough().nullable(),
    rotation: z.number().finite(),
    content: z.object({ type: z.string() }).passthrough(),
    author: z.union(AuthorSchema.options.map((schema) => schema.passthrough())),
    createdAt: z.number(),
    updatedAt: z.number(),
    deletedAt: z.number().nullable(),
  })
  .passthrough();
export type ViewObject = z.infer<typeof ViewObjectSchema>;
export const SnapshotSchema = z
  .object({ seq: z.number().int().nonnegative(), objects: z.array(ViewObjectSchema) })
  .passthrough();
export type Snapshot = z.infer<typeof SnapshotSchema>;
export const container = isContainer;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
export const label = (o: ViewObject): string =>
  text(o.content.label) || text(o.content.alt) || text(o.content.text).split('\n')[0]?.slice(0, 100) || o.type;
export const searchText = (o: ViewObject): string =>
  [label(o), o.type, ...Object.values(o.content).filter((value) => typeof value === 'string')].join('\n');
export function readable(o: ViewObject): string {
  if (o.content.type !== o.type) return `Unsupported content · ${o.content.type}`;
  switch (o.type) {
    case 'text':
      return text(o.content.text);
    case 'group':
    case 'frame':
    case 'section':
    case 'subcanvas':
      return text(o.content.label) || o.type;
    case 'image':
      return `Image · ${text(o.content.alt) || 'Preview unavailable in read-only view'}`;
    case 'link':
      return `Link · ${text(o.content.label) || text(o.content.url)}`;
    case 'embed':
      return 'Embed · Preview unavailable in read-only view';
    default:
      return `Unsupported object · ${o.type}`;
  }
}
