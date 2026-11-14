/**
 * @fileoverview Text-quote anchoring for review notes, shared by the server (prompt building) and the canvas page
 * (highlights, relocation). Ported from `doc-review.js`: an anchor is the quoted words plus up to 32 characters on
 * each side, never an offset, so a note finds its words again after the text is edited, and a quote that no longer
 * occurs is reported as gone rather than moved somewhere wrong.
 */
import { ANCHOR_CONTEXT_CHARS, MAX_QUOTE_CHARS, type ReviewAnchor } from './review-schema.js';

/** The anchor of `text[start, end)`, trimmed of surrounding whitespace; null when nothing but whitespace is selected or it is too long. */
export function anchorFromOffsets(text: string, start: number, end: number): ReviewAnchor | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > text.length || start >= end) return null;
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  if (start >= end || end - start > MAX_QUOTE_CHARS) return null;
  return {
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - ANCHOR_CONTEXT_CHARS), start),
    suffix: text.slice(end, end + ANCHOR_CONTEXT_CHARS),
  };
}

export type Located = { start: number; end: number };
/** Where the anchor's words are now: the occurrence whose surroundings match best, or null when the quote is gone. */
export function locate(text: string, anchor: ReviewAnchor): Located | null {
  const { quote, prefix, suffix } = anchor;
  if (!quote) return null;
  let best: Located | null = null;
  let bestScore = -1;
  for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) {
    const end = at + quote.length;
    let score = 0;
    for (let i = 1; i <= prefix.length && at - i >= 0 && text[at - i] === prefix[prefix.length - i]; i++) score++;
    for (let i = 0; i < suffix.length && end + i < text.length && text[end + i] === suffix[i]; i++) score++;
    if (score > bestScore) {
      bestScore = score;
      best = { start: at, end };
    }
    if (score === prefix.length + suffix.length) break;
  }
  return best;
}

/** A numbered question: "3. Which one?" or "3) Which one?". Only such a line takes an Answer note. */
export const isQuestionLine = (line: string): boolean => /^\s*\d+[.)]\s+\S.*\?\s*$/.test(line);

/** The line of `text` that holds offset `at`, with its start. */
export function lineAt(text: string, at: number): { start: number; end: number; line: string } {
  const start = text.lastIndexOf('\n', Math.max(0, at - 1)) + 1;
  const found = text.indexOf('\n', at);
  const end = found === -1 ? text.length : found;
  return { start, end, line: text.slice(start, end) };
}

/**
 * Whether a selection may become an Answer: it lies within one line, and that line is a numbered question. The
 * answer is anchored to the whole question, so the note sits under it however much of it was selected.
 */
export function answerAnchor(text: string, start: number, end: number): ReviewAnchor | null {
  const line = lineAt(text, start);
  if (end > line.end || !isQuestionLine(line.line)) return null;
  return anchorFromOffsets(text, line.start, line.end);
}
