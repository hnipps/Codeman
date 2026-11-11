import { z } from 'zod';
import { AuthorSchema, IdSchema, PositionSchema, SizeSchema } from '../../../src/canvas/model.js';

// The read boundary accepts future content types without interpreting their payload.
export const ViewObjectSchema = z.object({
  id: IdSchema,
  type: z.string(),
  parentId: IdSchema.nullable(),
  order: z.number().finite(),
  position: PositionSchema,
  size: SizeSchema.nullable(),
  rotation: z.number().finite(),
  content: z.object({
    type: z.string(),
    text: z.string().optional(),
    label: z.string().optional(),
    alt: z.string().optional(),
    url: z.string().optional(),
  }),
  author: AuthorSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  deletedAt: z.number().nullable(),
});
export type ViewObject = z.infer<typeof ViewObjectSchema>;
export const SnapshotSchema = z.object({ seq: z.number().int().nonnegative(), objects: z.array(ViewObjectSchema) });
export type Snapshot = z.infer<typeof SnapshotSchema>;
export const container = (o: ViewObject): boolean => ['group', 'frame', 'section'].includes(o.type);
export const label = (o: ViewObject): string =>
  o.content.label || o.content.alt || o.content.text?.split('\n')[0]?.slice(0, 100) || o.type;
export function readable(o: ViewObject): string {
  switch (o.type) {
    case 'text':
      return o.content.text ?? '';
    case 'group':
    case 'frame':
    case 'section':
    case 'subcanvas':
      return o.content.label ?? o.type;
    case 'image':
      return `Image · ${o.content.alt || 'Preview unavailable in read-only view'}`;
    case 'link':
      return `Link · ${o.content.label || o.content.url || ''}`;
    case 'embed':
      return 'Embed · Preview unavailable in read-only view';
    default:
      return `Unsupported object · ${o.type}`;
  }
}
