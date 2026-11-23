/**
 * @fileoverview Chat Graph routing from Codeman (intent/2026-11-18-chat-graph.md, ticket 4): one person's message
 * in, its chips out.
 *
 * A turn: store the message in the sidecar first (I2: a stored message is never lost; the sidecar down means 503
 * and nothing stored), then either pass an explicit signal straight through, or ask the sidecar for candidates,
 * run ONE `claude -p` call that resolves references and scores them, and post the scores back. The sidecar's
 * `Decide` writes the memberships. Any failure of the model call, its parse or the scored route files the message
 * to Unsorted, so every stored message ends with a chip (I2); a stored message whose route never arrives is filed
 * to Unsorted by the sidecar's own 20 s deadline.
 *
 * A message starting with `>` is a capture: it is filed like any other and answered with an acknowledgement.
 * This module has no path to an agent session at all, which is what keeps a capture from starting a turn (I10).
 *
 * The last few messages are kept in memory, never written anywhere, so the routing call can resolve "ok do that".
 */

import { buildRoutingPrompt, parseRoutingReply, type RecentMessage, type RoutingCandidate } from './routing-prompt.js';
import type { SidecarAnswer } from './supervisor.js';
import { getErrorMessage } from '../types.js';

export const CHAT_GRAPH_AUTHOR = 'person';
/** Topics offered to the routing call: the retriever's, then the most recently active ones. Matches the sidecar's MaxCandidates. */
const MAX_CANDIDATES = 5;
const RECENT_MESSAGES = 4;

export type ChatSignal = { kind: 'reply' | 'quote'; messageId: string } | { kind: 'chip'; topicId: string };

export type MessageKind = 'chat' | 'capture';

/** How a chip was decided: the sidecar's band, a topic the turn created, or the Unsorted fallback. */
export type ChipBand = 'quiet' | 'prominent' | 'explicit' | 'new' | 'unsorted';

export interface Chip {
  topicId: string;
  title: string;
  band: ChipBand;
  confidence: number | null;
  /** An archived topic this new topic's chip offers to bring back (I3). */
  reactivate?: string;
}

export interface PostedMessage {
  messageId: string;
  kind: MessageKind;
  ts: number;
  /** `routed` by the model, `explicit` from a signal, `unsorted` by the fallback, `pending` when the sidecar's deadline will file it. */
  routing: 'routed' | 'explicit' | 'unsorted' | 'pending';
  chips: Chip[];
  /** A capture's whole answer, e.g. "Filed to Budget". */
  ack?: string;
}

export interface ChatGraphCaller {
  call(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs?: number): Promise<SidecarAnswer>;
}

export interface ChatServiceDeps {
  sidecar: ChatGraphCaller;
  /** Runs the routing prompt through `claude -p`; resolves with its output. */
  runPrompt: (prompt: string, messageId: string) => Promise<string>;
  now: () => number;
  newId: () => string;
}

/** A sidecar answer the route should pass on as it is: its status and its error text. */
export class ChatGraphRefused extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ChatGraphRefused';
  }
}

interface WireDecision {
  attach: { topicId: string; confidence: number | null; band: 'quiet' | 'prominent' | 'explicit' }[];
  newTopic?: { id: string; title: string };
  reactivate?: string;
  unsorted?: boolean;
}

interface RouteAnswer {
  op: { id: string };
  decision: WireDecision;
}

function errorText(body: unknown): string {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === 'string' ? error : 'Chat Graph refused the request';
}

/** Splits `> text` into a capture. Returns null for text with nothing to file. */
export function classifyMessage(raw: string): { kind: MessageKind; text: string } | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith('>')) {
    const text = trimmed.slice(1).trim();
    return text ? { kind: 'capture', text } : null;
  }
  return trimmed ? { kind: 'chat', text: trimmed } : null;
}

export class ChatGraphService {
  private readonly recent: RecentMessage[] = [];

  constructor(private readonly deps: ChatServiceDeps) {}

  private async ok<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const answer = await this.deps.sidecar.call(method, path, body);
    if (answer.status !== 200) throw new ChatGraphRefused(answer.status, errorText(answer.body));
    return answer.body as T;
  }

  /**
   * Stores and files one message. Throws ChatGraphUnavailable (503) or ChatGraphRefused only before the message
   * is stored; once it is, every failure ends in Unsorted or, with the sidecar gone, in its deadline.
   */
  async post(raw: string, signal?: ChatSignal): Promise<PostedMessage> {
    const classified = classifyMessage(raw);
    if (!classified) throw new ChatGraphRefused(400, 'the message is empty');
    const { kind, text } = classified;
    const messageId = this.deps.newId();
    const ts = this.deps.now();
    await this.ok('POST', '/messages', { id: messageId, text, ts, author: CHAT_GRAPH_AUTHOR, kind });

    let routing: PostedMessage['routing'];
    let answer: RouteAnswer | null;
    const titles = new Map<string, string>();
    if (signal) {
      routing = 'explicit';
      answer = await this.routeExplicit(messageId, signal);
    } else {
      routing = 'routed';
      answer = await this.routeScored(messageId, text, titles);
    }
    if (!answer) {
      routing = 'unsorted';
      answer = await this.routeUnsorted(messageId);
    }
    if (!answer) {
      // The sidecar's own deadline files it; a capture still gets its acknowledgement (I10).
      const pending: PostedMessage = { messageId, kind, ts, routing: 'pending', chips: [] };
      if (kind === 'capture') pending.ack = 'Saved; it will be filed in a moment';
      return pending;
    }
    if (answer.decision.unsorted) routing = 'unsorted';

    const chips = await this.chips(answer.decision, titles);
    this.remember(text, chips);
    const posted: PostedMessage = { messageId, kind, ts, routing, chips };
    if (kind === 'capture') posted.ack = `Filed to ${chips.map((c) => c.title).join(', ')}`;
    return posted;
  }

  /** Moves a message from one topic to another, or with `add` files it to a second one. The move is a correction. */
  async reassign(
    messageId: string,
    to: string,
    opts: { from?: string; add?: boolean; opId?: string }
  ): Promise<unknown> {
    const id = opts.opId ?? this.deps.newId();
    const op = opts.add
      ? { id, kind: 'attach', messageId, topicId: to, source: 'chip' }
      : { id, kind: 'move', messageId, from: opts.from, to };
    return this.ok('POST', '/ops', op);
  }

  private async routeExplicit(messageId: string, signal: ChatSignal): Promise<RouteAnswer | null> {
    try {
      return await this.ok<RouteAnswer>('POST', `/messages/${messageId}/route`, { signal });
    } catch (err) {
      console.warn(`[ChatGraph] explicit route for ${messageId} refused, filing to Unsorted: ${getErrorMessage(err)}`);
      return null;
    }
  }

  private async routeScored(messageId: string, text: string, titles: Map<string, string>): Promise<RouteAnswer | null> {
    try {
      const candidates = await this.candidates(messageId);
      for (const c of candidates) titles.set(c.topicId, c.title);
      const output = await this.deps.runPrompt(buildRoutingPrompt(text, candidates, this.recent), messageId);
      const reply = parseRoutingReply(output, candidates, text);
      return await this.ok<RouteAnswer>('POST', `/messages/${messageId}/route`, reply);
    } catch (err) {
      console.warn(`[ChatGraph] routing ${messageId} failed, filing to Unsorted: ${getErrorMessage(err)}`);
      return null;
    }
  }

  private async routeUnsorted(messageId: string): Promise<RouteAnswer | null> {
    try {
      return await this.ok<RouteAnswer>('POST', `/messages/${messageId}/route`, { unsorted: true });
    } catch (err) {
      console.warn(
        `[ChatGraph] filing ${messageId} to Unsorted failed; the sidecar's deadline will: ${getErrorMessage(err)}`
      );
      return null;
    }
  }

  /** The retriever's candidates, topped up with the most recently active live topics, so a follow-up with no shared words still sees them. */
  private async candidates(messageId: string): Promise<RoutingCandidate[]> {
    const found = await this.ok<{ candidates: { topicId: string; title: string }[] }>(
      'POST',
      `/messages/${messageId}/candidates`,
      {}
    );
    const out: RoutingCandidate[] = found.candidates
      .slice(0, MAX_CANDIDATES)
      .map((c) => ({ topicId: c.topicId, title: c.title }));
    if (out.length < MAX_CANDIDATES) {
      const topics = await this.ok<{ id: string; title: string; status: string }[]>('GET', '/topics');
      for (const t of topics) {
        if (out.length >= MAX_CANDIDATES) break;
        if (t.status === 'live' && !out.some((c) => c.topicId === t.id)) out.push({ topicId: t.id, title: t.title });
      }
    }
    return out;
  }

  private async chips(decision: WireDecision, titles: Map<string, string>): Promise<Chip[]> {
    const chips: Chip[] = [];
    const unsorted = decision.unsorted === true;
    if (decision.newTopic) {
      chips.push({
        topicId: decision.newTopic.id,
        title: decision.newTopic.title,
        band: unsorted ? 'unsorted' : 'new',
        confidence: null,
        ...(decision.reactivate ? { reactivate: decision.reactivate } : {}),
      });
    }
    for (const a of decision.attach) {
      let title = titles.get(a.topicId);
      if (title === undefined) {
        try {
          title = (await this.ok<{ title: string }>('GET', `/topics/${encodeURIComponent(a.topicId)}`)).title;
        } catch {
          title = a.topicId;
        }
      }
      chips.push({ topicId: a.topicId, title, band: unsorted ? 'unsorted' : a.band, confidence: a.confidence ?? null });
    }
    return chips;
  }

  private remember(text: string, chips: Chip[]): void {
    this.recent.push({ text, topics: chips.map((c) => c.title) });
    if (this.recent.length > RECENT_MESSAGES) this.recent.shift();
  }
}
