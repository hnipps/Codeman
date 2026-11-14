/**
 * @fileoverview The pure part of brief review: which notes belong to a text object and where their words are now,
 * which of them Send N carries, the comment text a note posts as, and the text an Apply leaves.
 */
import { z } from 'zod';
import { locate, type Located } from '../../../src/canvas/review-anchor.js';
import {
  noteState,
  ReviewNoteSchema,
  type NoteState,
  type ReviewAnchor,
  type ReviewKind,
  type ReviewNote,
} from '../../../src/canvas/review-schema.js';
import type { ViewComment } from './comments.js';

export type ViewNote = {
  comment: ViewComment;
  note: ReviewNote;
  state: NoteState;
  /** Where the words are now; null for a general note, or when they are gone ("text changed"). */
  at: Located | null;
  changed: boolean;
};

const NotesAnswer = z.object({
  success: z.literal(true),
  data: z.object({ notes: z.record(z.string(), z.unknown()) }).passthrough(),
});
/** The notes route's answer by comment id; an entry this page cannot read is left out. */
export function parseNotes(body: unknown): Map<string, ReviewNote> {
  const notes = new Map<string, ReviewNote>();
  const answer = NotesAnswer.safeParse(body);
  if (!answer.success) return notes;
  for (const [id, value] of Object.entries(answer.data.data.notes)) {
    const note = ReviewNoteSchema.safeParse(value);
    if (note.success) notes.set(id, note.data);
  }
  return notes;
}

/** The notes of one text object in reading order: located ones by position, then text changed, then general. */
export function notesOf(
  text: string,
  objectId: string,
  comments: readonly ViewComment[],
  notes: ReadonlyMap<string, ReviewNote>
): ViewNote[] {
  const out: ViewNote[] = [];
  for (const comment of comments) {
    const note = comment.objectId === objectId ? notes.get(comment.id) : undefined;
    if (!note) continue;
    const at = note.kind === 'general' ? null : locate(text, note.anchor);
    out.push({ comment, note, state: noteState(note), at, changed: note.kind !== 'general' && at === null });
  }
  const rank = (n: ViewNote): number => (n.at ? 0 : n.changed ? 1 : 2);
  return out.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.at && b.at ? a.at.start - b.at.start : 0) ||
      a.comment.createdAt - b.comment.createdAt ||
      a.comment.id.localeCompare(b.comment.id)
  );
}

/** What Send N carries: every note of the object not sent yet and not resolved. */
export const unsentIds = (notes: readonly ViewNote[]): string[] =>
  notes.filter((n) => n.state === 'unsent').map((n) => n.comment.id);

/** The line index (0-based, split on `\n`) that holds offset `at`. */
export function lineOf(text: string, at: number): number {
  let line = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < at; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

const QUOTE_IN_COMMENT = 200;
const cut = (quote: string): string => {
  const one = quote.replace(/\s+/g, ' ').trim();
  return one.length > QUOTE_IN_COMMENT ? `${one.slice(0, QUOTE_IN_COMMENT)}…` : one;
};
/**
 * The comment a note posts: the person's words, prefixed for Replace, Delete and Answer so the thread (and a release
 * that does not know review notes) still says what the note asks.
 */
export function commentText(kind: ReviewKind, anchor: ReviewAnchor | null, body: string, replacement = ''): string {
  const note = body.trim();
  const quote = anchor ? `“${cut(anchor.quote)}”` : '';
  switch (kind) {
    case 'replace':
      return `Replace ${quote} with “${cut(replacement)}”.${note ? ` ${note}` : ''}`;
    case 'delete':
      return `Delete ${quote}.${note ? ` ${note}` : ''}`;
    case 'answer':
      return `Answer: ${note}`;
    default:
      return note;
  }
}

/** Whether a note can be posted with this body: Replace and Delete stand on their own, the rest need words. */
export const postable = (kind: ReviewKind, body: string): boolean =>
  kind === 'replace' || kind === 'delete' || body.trim().length > 0;

/** The text after applying a Replace or Delete at its located words; a Delete takes one neighbouring space with it. */
export function applied(text: string, note: ReviewNote, at: Located): string | null {
  if (note.kind !== 'replace' && note.kind !== 'delete') return null;
  if (note.kind === 'replace') return text.slice(0, at.start) + note.replacement + text.slice(at.end);
  let { start, end } = at;
  if (text[end] === ' ' && (start === 0 || /\s/.test(text[start - 1]!))) end++;
  else if (text[start - 1] === ' ' && (end === text.length || /[\s.,;:!?]/.test(text[end]!))) start--;
  return text.slice(0, start) + text.slice(end);
}

/**
 * Whether a Replace already stands in the text: its replacement sits between the words that surrounded the quote.
 * The quote can survive inside its own replacement ("narrow" in "too narrow"), so being located is not enough.
 */
export function alreadyApplied(text: string, note: ReviewNote): boolean {
  if (note.kind !== 'replace' || !note.replacement) return false;
  const near = 8;
  return text.includes(note.anchor.prefix.slice(-near) + note.replacement + note.anchor.suffix.slice(0, near));
}

export const KIND_LABEL: Record<ReviewKind, string> = {
  comment: 'Comment',
  replace: 'Replace',
  delete: 'Delete',
  answer: 'Answer',
  general: 'General note',
};
export const STATE_LABEL: Record<NoteState, string> = { unsent: 'Not sent', sent: 'Sent', resolved: 'Resolved' };
