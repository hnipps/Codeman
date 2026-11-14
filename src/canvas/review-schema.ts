/**
 * @fileoverview The shape of a review note (see `review-notes.ts` for where it is kept). Browser-safe: the canvas
 * page parses the same schema the server writes with.
 */
import { z } from 'zod';

export const MAX_REVIEW_NOTES = 2000;
export const MAX_REVIEW_NOTE_BYTES = 4 * 1024 * 1024;
export const MAX_QUOTE_CHARS = 2000;
export const ANCHOR_CONTEXT_CHARS = 32;
export const MAX_REPLACEMENT_CHARS = 8000;
/** Notes sent in one prompt; more is refused, never cut. */
export const MAX_NOTES_PER_SEND = 50;

export const ReviewAnchorSchema = z
  .object({
    quote: z.string().min(1).max(MAX_QUOTE_CHARS),
    prefix: z.string().max(ANCHOR_CONTEXT_CHARS),
    suffix: z.string().max(ANCHOR_CONTEXT_CHARS),
  })
  .strict();
export type ReviewAnchor = z.infer<typeof ReviewAnchorSchema>;

const Stamps = {
  sentAt: z.number().int().nonnegative().optional(),
  resolvedAt: z.number().int().nonnegative().optional(),
};
const anchored = (kind: 'comment' | 'delete' | 'answer') =>
  z.object({ kind: z.literal(kind), anchor: ReviewAnchorSchema, ...Stamps }).strict();
/** General notes have no words; Replace always has its new words. */
export const ReviewNoteSchema = z.discriminatedUnion('kind', [
  anchored('comment'),
  anchored('delete'),
  anchored('answer'),
  z
    .object({
      kind: z.literal('replace'),
      anchor: ReviewAnchorSchema,
      replacement: z.string().max(MAX_REPLACEMENT_CHARS),
      ...Stamps,
    })
    .strict(),
  z.object({ kind: z.literal('general'), ...Stamps }).strict(),
]);
export type ReviewNote = z.infer<typeof ReviewNoteSchema>;
export type ReviewKind = ReviewNote['kind'];

/** What a page may set: everything but the stamps, which the server owns, plus whether it is resolved. */
export const ReviewNoteBodySchema = z.object({
  note: z.discriminatedUnion('kind', [
    z.object({ kind: z.enum(['comment', 'delete', 'answer']), anchor: ReviewAnchorSchema }).strict(),
    z
      .object({
        kind: z.literal('replace'),
        anchor: ReviewAnchorSchema,
        replacement: z.string().max(MAX_REPLACEMENT_CHARS),
      })
      .strict(),
    z.object({ kind: z.literal('general') }).strict(),
  ]),
  resolved: z.boolean().optional(),
});
export type ReviewNoteBody = z.infer<typeof ReviewNoteBodySchema>;

/** One state per note, derived from the stamps: Send N counts `unsent`, and only Resolve makes `resolved`. */
export type NoteState = 'unsent' | 'sent' | 'resolved';
export const noteState = (note: Pick<ReviewNote, 'sentAt' | 'resolvedAt'>): NoteState =>
  note.resolvedAt !== undefined ? 'resolved' : note.sentAt !== undefined ? 'sent' : 'unsent';
