/**
 * @fileoverview Chat Graph's one routing call (intent/2026-11-18-chat-graph.md, Routing step 3): the prompt Codeman
 * gives `claude -p` and the strict parse of its answer. Pure, so tests exercise the shipped text and parser.
 *
 * The call resolves references in the message ("ok do that") and scores every candidate topic from 0 to 1, plus a
 * title for a new topic. The sidecar's `Decide` turns the scores into memberships; nothing here decides.
 */

import { z } from 'zod';

export interface RoutingCandidate {
  topicId: string;
  title: string;
}

export interface RecentMessage {
  text: string;
  /** Titles of the topics it was filed to. */
  topics: string[];
}

export interface RoutingReply {
  resolvedText: string;
  scores: { topicId: string; score: number }[];
  title: string;
}

const MAX_TITLE_CHARS = 80;
const MAX_RESOLVED_CHARS = 4_000;
const MAX_RECENT_CHARS = 300;

/** Quotes text for the prompt as one JSON string, so a message cannot close its own section. */
function quote(text: string, max: number): string {
  return JSON.stringify(text.length > max ? `${text.slice(0, max)}…` : text);
}

export function buildRoutingPrompt(text: string, candidates: RoutingCandidate[], recent: RecentMessage[]): string {
  const lines = [
    'You file one chat message to topics. Answer with one JSON object and nothing else:',
    '{"resolved": string, "scores": [{"topicId": string, "score": number}], "title": string}',
    '- "resolved": the message rewritten so it stands alone, with words like "that" or "it" replaced by what they refer to in the recent messages.',
    '- "scores": one entry per candidate topic below, 0 to 1. 1 means the message clearly continues that topic; 0 means it has nothing to do with it.',
    '- "title": a 2 to 5 word title for a new topic, used only if no candidate fits.',
    '',
    'Candidate topics:',
    ...(candidates.length > 0
      ? candidates.map((c) => `- topicId ${JSON.stringify(c.topicId)}, title ${quote(c.title, MAX_TITLE_CHARS)}`)
      : ['(none: return an empty "scores" list)']),
    '',
    'Recent messages, oldest first:',
    ...(recent.length > 0
      ? recent.map(
          (m) =>
            `- ${quote(m.text, MAX_RECENT_CHARS)} filed to ${m.topics.map((t) => quote(t, MAX_TITLE_CHARS)).join(', ') || 'nothing yet'}`
        )
      : ['(none)']),
    '',
    'The message to file:',
    quote(text, MAX_RESOLVED_CHARS),
  ];
  return lines.join('\n');
}

const ReplySchema = z.object({
  resolved: z.string().optional(),
  scores: z.array(z.object({ topicId: z.string(), score: z.number() })),
  title: z.string(),
});

/**
 * Parses the model's answer. Throws on anything that is not the expected object, so the caller files the
 * message to Unsorted. Scores for topics that were not offered are dropped, repeats keep the first, and every
 * score is clamped to 0 to 1.
 */
export function parseRoutingReply(output: string, candidates: RoutingCandidate[], text: string): RoutingReply {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('routing answer has no JSON object');
  let raw: unknown;
  try {
    raw = JSON.parse(output.slice(start, end + 1));
  } catch {
    throw new Error('routing answer is not valid JSON');
  }
  const parsed = ReplySchema.safeParse(raw);
  if (!parsed.success) throw new Error('routing answer does not have the expected fields');
  const title = parsed.data.title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS);
  if (!title) throw new Error('routing answer has no title');
  const offered = new Set(candidates.map((c) => c.topicId));
  const seen = new Set<string>();
  const scores: RoutingReply['scores'] = [];
  for (const s of parsed.data.scores) {
    if (!offered.has(s.topicId) || seen.has(s.topicId) || !Number.isFinite(s.score)) continue;
    seen.add(s.topicId);
    scores.push({ topicId: s.topicId, score: Math.min(1, Math.max(0, s.score)) });
  }
  const resolved = (parsed.data.resolved ?? '').trim().slice(0, MAX_RESOLVED_CHARS);
  return { resolvedText: resolved || text, scores, title };
}
