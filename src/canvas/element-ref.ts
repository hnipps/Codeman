/**
 * @fileoverview One element inside a live canvas frame (an embed or a prototype), as the frame bridge
 * reports it. This is the shape a comment anchor, a chat context item and a Q-lasso capture all carry.
 *
 * Every string here was written by the page inside the frame, so it is untrusted text: render it with
 * textContent only, and pass it through `plainLine` before it enters an agent prompt.
 */
import { z } from 'zod';
import { IdSchema } from './model.js';

export const MAX_ELEMENT_REFS = 50;
const bounded = (keys: number, value: number) =>
  z
    .record(z.string().min(1).max(64), z.string().max(value))
    .refine((r) => Object.keys(r).length <= keys, `At most ${keys} entries`);

export const ElementRefSchema = z
  .object({
    /** The embed object whose frame holds the element. */
    objectId: IdSchema,
    /** A CSS selector that found exactly this element when it was picked. */
    selector: z.string().min(1).max(1024),
    /** A readable ancestor trail, such as `main > section.lanes > article.card`. */
    path: z.string().max(2048).default(''),
    tag: z.string().min(1).max(64),
    text: z.string().max(2000).default(''),
    /** Frame CSS pixels, relative to the frame's viewport, at pick time. */
    rect: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().finite().nonnegative(),
        height: z.number().finite().nonnegative(),
      })
      .strict(),
    /** id, class, role, aria-label, data-testid, href and the like. */
    attrs: bounded(16, 512).default({}),
    /** A fixed subset of computed styles. */
    styles: bounded(24, 256).default({}),
    /** `file:line` when the page marks its elements with one (`data-source`), else absent. */
    source: z.string().max(512).optional(),
  })
  .strict();
export type ElementRef = z.infer<typeof ElementRefSchema>;

/** A short human label, such as `button "Start task"`. */
export function elementLabel(ref: Pick<ElementRef, 'tag' | 'text' | 'selector'>): string {
  const text = ref.text.replace(/\s+/g, ' ').trim();
  if (!text) return ref.selector.length > 60 ? `${ref.tag} ${ref.selector.slice(-48)}` : ref.selector;
  return `${ref.tag} "${text.length > 40 ? `${text.slice(0, 39)}…` : text}"`;
}
