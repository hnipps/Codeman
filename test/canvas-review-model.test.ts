/**
 * @fileoverview The browser side of brief review that needs no DOM: which notes Send N carries, the comment a note
 * posts, the text an Apply leaves, and when a Replace already stands in the text.
 */
import { describe, expect, it } from 'vitest';
import {
  alreadyApplied,
  applied,
  commentText,
  notesOf,
  parseNotes,
  postable,
  unsentIds,
} from '../packages/canvas/src/review-model.js';
import { anchorFromOffsets, locate } from '../src/canvas/review-anchor.js';
import type { ReviewNote } from '../src/canvas/review-schema.js';
import type { ViewComment } from '../packages/canvas/src/comments.js';

const TEXT = 'The rail is narrow today and opens on the right.';
const anchorOf = (words: string) => {
  const at = TEXT.indexOf(words);
  return anchorFromOffsets(TEXT, at, at + words.length)!;
};
const comment = (id: string, createdAt: number, objectId = 'brief'): ViewComment =>
  ({ id, objectId, createdAt }) as unknown as ViewComment;

describe('review model', () => {
  it('orders notes by position, then text changed, then general, and Send N carries only unsent ones', () => {
    const notes = new Map<string, ReviewNote>([
      ['g', { kind: 'general' }],
      ['late', { kind: 'comment', anchor: anchorOf('opens') }],
      ['early', { kind: 'delete', anchor: anchorOf('narrow') }],
      ['gone', { kind: 'comment', anchor: { quote: 'vanished words', prefix: '', suffix: '' } }],
      ['sent', { kind: 'comment', anchor: anchorOf('rail'), sentAt: 5 }],
      ['done', { kind: 'comment', anchor: anchorOf('right'), resolvedAt: 6 }],
      ['other', { kind: 'general' }],
    ]);
    const comments = ['g', 'late', 'early', 'gone', 'sent', 'done'].map((id, i) => comment(id, i));
    comments.push(comment('other', 9, 'elsewhere'));
    const view = notesOf(TEXT, 'brief', comments, notes);
    expect(view.map((n) => n.comment.id)).toEqual(['sent', 'early', 'late', 'done', 'gone', 'g']);
    expect(view.find((n) => n.comment.id === 'gone')!.changed).toBe(true);
    expect(unsentIds(view)).toEqual(['early', 'late', 'gone', 'g']);
  });

  it('writes a readable comment for each kind and needs words only where the kind does', () => {
    const anchor = anchorOf('narrow');
    expect(commentText('replace', anchor, '', 'tight')).toBe('Replace “narrow” with “tight”.');
    expect(commentText('delete', anchor, 'Not needed.')).toBe('Delete “narrow”. Not needed.');
    expect(commentText('answer', anchor, 'Yes')).toBe('Answer: Yes');
    expect(commentText('comment', anchor, '  plain  ')).toBe('plain');
    expect(postable('delete', '')).toBe(true);
    expect(postable('comment', '  ')).toBe(false);
  });

  it('applies a Replace once and a Delete with one neighbouring space', () => {
    const replace: ReviewNote = { kind: 'replace', anchor: anchorOf('narrow'), replacement: 'too narrow for notes' };
    const after = applied(TEXT, replace, locate(TEXT, replace.anchor)!)!;
    expect(after).toBe('The rail is too narrow for notes today and opens on the right.');
    expect(alreadyApplied(TEXT, replace)).toBe(false);
    // The quote survives inside its own replacement, so it still locates; Apply must not be offered again.
    expect(locate(after, replace.anchor)).not.toBeNull();
    expect(alreadyApplied(after, replace)).toBe(true);

    const del: ReviewNote = { kind: 'delete', anchor: anchorOf('today') };
    expect(applied(TEXT, del, locate(TEXT, del.anchor)!)).toBe('The rail is narrow and opens on the right.');
  });

  it('keeps only the entries it can read from the notes answer', () => {
    const notes = parseNotes({
      success: true,
      data: { notes: { a: { kind: 'general' }, b: { kind: 'bogus' }, c: { kind: 'delete' } } },
    });
    expect([...notes.keys()]).toEqual(['a']);
    expect(parseNotes({ success: false }).size).toBe(0);
  });
});
