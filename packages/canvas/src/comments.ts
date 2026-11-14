import { uuid } from './ids.js';
import { z } from 'zod';
import { label, type ViewObject } from './model.js';
import {
  askFailure,
  nextAsk,
  parseAsks,
  parseDrafts,
  requestStatus,
  storeAsks,
  storeDraft,
  type AskAttempt,
  type ThreadDrafts,
  type ThreadRequest,
} from './ask.js';
import { errorMessage, sendFailure } from './conversation.js';
import { hydrateDiagrams, renderMarkdown } from './markdown.js';
import { normalizePrompt, promptRefusal } from '../../../src/canvas/conversation-schema.js';
import type { FreshTarget } from './assistant.js';
import { elementLabel, type ElementRef } from '../../../src/canvas/element-ref.js';
import { parseDraftElements, sameElement, storeDraftElement, type DraftElements } from './element-anchors.js';
import type { AnchoredComment } from './element-comments.js';
import { CommentMarks } from './comment-marks.js';

export const ViewCommentSchema = z
  .object({
    id: z.string(),
    objectId: z.string(),
    author: z.union([
      z.object({ kind: z.literal('human'), userId: z.string() }).passthrough(),
      z.object({ kind: z.literal('agent'), sessionId: z.string() }).passthrough(),
    ]),
    text: z.string(),
    createdAt: z.number(),
  })
  .passthrough();
export type ViewComment = z.infer<typeof ViewCommentSchema>;
export type ViewAuthor = ViewComment['author'];

export function commentCounts(comments: ViewComment[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of comments) counts.set(c.objectId, (counts.get(c.objectId) ?? 0) + 1);
  return counts;
}

export function thread(comments: ViewComment[], objectId: string): ViewComment[] {
  return comments
    .filter((c) => c.objectId === objectId)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const exactTime = (at: number): string =>
  new Date(at).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

/** Agents are told apart from people by name and a neutral mark, never colour alone. */
export function authorName(author: ViewAuthor): { name: string; agent: boolean } {
  return author.kind === 'agent'
    ? { name: `Agent ${author.sessionId.slice(0, 8)}`, agent: true }
    : { name: author.userId, agent: false };
}

export function agentMark(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('agent-mark');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', 'M10 2.5l6.5 3.75v7.5L10 17.5l-6.5-3.75v-7.5zM7.5 9h.01M12.5 9h.01M7.5 12.5h5');
  svg.append(path);
  return svg;
}

export function authorLabel(author: ViewAuthor): HTMLElement {
  const span = document.createElement('span');
  span.className = 'author';
  const { name, agent } = authorName(author);
  if (agent) {
    span.append(agentMark());
    const sr = document.createElement('span');
    sr.className = 'sr';
    sr.textContent = 'Agent: ';
    span.append(sr);
  }
  const text = document.createElement('span');
  text.className = 'author-name';
  text.textContent = name;
  span.append(text);
  return span;
}

function bubble(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', 'M4 4h12v9H9l-5 3.5z');
  svg.append(path);
  return svg;
}

const node = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing comment element: ${id}`);
  return el;
};

type Pending = { requestId: string; commentId: string; text: string; objectId: string; element: ElementRef | null };
/** One object's composer: its draft, the element it is about, the post it is sending or retrying, and why the last one failed. */
type Composer = {
  draft: string;
  /** The element inside the embed's page this comment is about, or null for a comment on the whole object. */
  element: ElementRef | null;
  name: string;
  pending: Pending | null;
  sending: boolean;
  /** The operation in flight or last failed: Retry repeats that one. */
  action: 'post' | 'ask';
  failure: PostFailure | null;
};
/** What the thread needs of the assistant to ask it: where a request can go, and what became of earlier ones. */
export type AskPort = {
  targets(): { id: string; label: string }[];
  preferred(): string | null;
  fresh(): FreshTarget;
  requests(): ThreadRequest[];
  asked(message: { messageId: string; text: string; refIds: string[] }): void;
  /** Opens that conversation in the assistant rail; the camera and selection stay. */
  open(conversationId: string): void;
};
/** What the thread needs of the live frames: the element a comment is about, and a way to point at one. */
export type ElementsPort = {
  of(commentId: string): AnchoredComment | null;
  /** Shows the embed on the board and marks the element where its page has it now. */
  show(element: ElementRef): void;
  /** Whether this object's page is live here, so an element can be picked in it. */
  canPick(objectId: string): boolean;
  /** Lets the person point at one element; null when picking ended any other way. */
  pick(objectId: string): Promise<ElementRef | null>;
  cancelPick(): void;
  /** The server kept this element with the comment just posted. */
  anchored(commentId: string, element: ElementRef): void;
};
const NEW_TARGET = '';
const ASK_INTERRUPTED =
  'Ask agent did not finish before the page reloaded. Retry finishes it; nothing is posted twice.';
/** Composers kept at once; the oldest idle one goes first. */
export const MAX_COMPOSERS = 64;

export type PostFailure = { retry: boolean; message: string };

/** Product copy for a post that did not land; only network and server faults are worth retrying as is. */
export function postFailure(status: number | null, body: unknown): PostFailure {
  if (status === null || status >= 500 || status === 408 || status === 429)
    return { retry: true, message: 'Not posted. Your comment is kept here.' };
  const code = z.object({ reasons: z.array(z.object({ code: z.string() }).passthrough()) }).safeParse(body);
  const reason = code.success ? code.data.reasons[0]?.code : undefined;
  if (status === 404 || reason === 'NOT_FOUND' || reason === 'INVALID')
    return { retry: false, message: 'Not posted: this object was removed. Your comment is kept here to copy.' };
  const refusal = z.object({ error: z.string() }).passthrough().safeParse(body);
  if (status === 400 && refusal.success && refusal.data.error.startsWith('NOT_AN_EMBED'))
    return {
      retry: false,
      message: 'Not posted: this object no longer shows a live page. Remove the element, then post again.',
    };
  if (status === 400)
    return { retry: false, message: 'Not posted: comments hold up to 100,000 characters. Shorten it and post again.' };
  return { retry: false, message: 'Not posted: the canvas refused this comment. Your comment is kept here.' };
}

/** What `canvas_comment` takes: the element only when the comment is about one. */
const commentArguments = (comment: {
  objectId: string;
  text: string;
  commentId: string;
  element: ElementRef | null;
}) => ({
  objectId: comment.objectId,
  text: comment.text,
  commentId: comment.commentId,
  ...(comment.element ? { element: comment.element } : {}),
});
const AnchoredSchema = z.object({ data: z.object({ anchored: z.literal(true) }).passthrough() }).passthrough();
const wasAnchored = (body: unknown): boolean => AnchoredSchema.safeParse(body).success;

/** The thread view in the rail. Post is an ordinary comment and never starts agent work; only Ask agent sends one to a conversation. */
export class CommentsView {
  private comments: ViewComment[] = [];
  private marks: CommentMarks | undefined;
  private shown: string | null = null;
  private rendered = new Map<string, HTMLElement>();
  private composers = new Map<string, Composer>();
  private clock: ReturnType<typeof setInterval> | undefined;
  private list = node('threadList');
  private draft: HTMLTextAreaElement;
  private asks: AskAttempt[] = [];
  private drafts: ThreadDrafts = {};
  private draftElements: DraftElements = {};
  /** The object a pick started from this thread is running for. */
  private pickingFor: string | null = null;
  /** The press now turning into a click landed on Pick element while a pick was running, and so ended it. */
  private pressEndedPick = false;
  /** A comment the thread should open at, once it is drawn. */
  private wanted: string | null = null;
  private target = node('askTarget') as HTMLSelectElement;
  /** The person picked a target in this thread; until then the choice follows the rail. */
  private picked: string | null = null;
  private targetSignature = '';

  constructor(
    private options: {
      url: (path: string) => string;
      workspace: string;
      objects: () => ViewObject[];
      choose: (objectId: string) => void;
      assistant: AskPort;
      /** Where Ask agent attempts are kept across reloads. */
      askKey: string;
      /** Where unposted drafts are kept across reloads, one per object. */
      draftKey: string;
      /** Where the element an unposted draft is about is kept, beside the draft. */
      draftElementKey: string;
      elements: ElementsPort;
      /** A count mark on the board was used: open that object's thread. */
      open: (objectId: string) => void;
    }
  ) {
    // A count mark sits inside its object on the board. Document capture runs before the board's own capture
    // listeners, so a press on the mark never starts a drag, a marquee, a lasso or a pan, nor selects first.
    const markOf = (e: Event) =>
      e.target instanceof Element ? e.target.closest<HTMLElement>('#board .comment-mark') : null;
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (markOf(e)) e.stopPropagation();
      },
      true
    );
    document.addEventListener('click', (e) => {
      const id = markOf(e)?.dataset.markFor;
      if (!id) return;
      e.preventDefault();
      this.options.open(id);
    });
    try {
      this.asks = parseAsks(localStorage.getItem(options.askKey));
      this.drafts = parseDrafts(localStorage.getItem(options.draftKey));
      this.draftElements = parseDraftElements(localStorage.getItem(options.draftElementKey));
    } catch {
      /* Storage that cannot be read keeps no attempt; a retry then uses fresh ids. */
    }
    const draft = node('commentDraft');
    if (!(draft instanceof HTMLTextAreaElement)) throw new Error('Expected comment draft');
    this.draft = draft;
    draft.addEventListener('input', () => {
      if (this.shown) {
        const composer = this.composer(this.shown);
        composer.draft = draft.value;
        this.keepDraft(this.shown, draft.value);
        if (composer.failure && !composer.failure.retry) composer.failure = null;
      }
      this.paintComposer();
    });
    draft.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        node('threadView').focus({ preventScroll: true });
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) void this.post();
      }
    });
    node('commentForm').addEventListener('submit', (e) => {
      e.preventDefault();
      void this.post();
    });
    node('retryComment').addEventListener('click', () => {
      const composer = this.shown ? this.composers.get(this.shown) : undefined;
      void (composer?.action === 'ask' ? this.ask() : this.post());
    });
    node('askAgent').addEventListener('click', () => void this.ask());
    node('commentPick').addEventListener('click', () => void this.pick());
    // Any press outside the page being picked in ends the pick before this button hears its click; window capture
    // runs first, so the click can tell "cancel" from "start again".
    window.addEventListener(
      'pointerdown',
      (e) => {
        this.pressEndedPick =
          this.pickingFor !== null && e.target instanceof Node && node('commentPick').contains(e.target);
      },
      true
    );
    node('commentAboutShow').addEventListener('click', () => {
      const element = this.shown ? this.composers.get(this.shown)?.element : null;
      if (element) this.options.elements.show(element);
    });
    node('commentAboutRemove').addEventListener('click', () => {
      if (!this.shown) return;
      this.setElement(this.shown, null);
      this.draft.focus({ preventScroll: true });
    });
    this.target.addEventListener('change', () => {
      this.picked = this.target.value;
      this.paintTarget();
    });
  }

  /** The composer for one object, kept most recent last; idle empty ones are dropped past the bound. */
  private composer(objectId: string): Composer {
    let composer = this.composers.get(objectId);
    if (composer) this.composers.delete(objectId);
    else {
      const object = this.options.objects().find((o) => o.id === objectId);
      // An Ask agent attempt a reload interrupted comes back with its text, so finishing it reuses its ids.
      const interrupted = this.asks.find((ask) => ask.objectId === objectId);
      composer = {
        draft: interrupted?.text ?? this.drafts[objectId] ?? '',
        element: (interrupted ? interrupted.element : this.draftElements[objectId]) ?? null,
        name: object ? label(object) : '',
        pending: null,
        sending: false,
        action: interrupted ? 'ask' : 'post',
        failure: interrupted ? { retry: true, message: ASK_INTERRUPTED } : null,
      };
    }
    this.composers.set(objectId, composer);
    for (const [id, c] of this.composers) {
      if (this.composers.size <= MAX_COMPOSERS) break;
      if (id !== objectId && !c.sending) this.composers.delete(id);
    }
    return composer;
  }

  private forget(objectId: string): void {
    const composer = this.composers.get(objectId);
    if (composer && !composer.sending && !composer.draft && !composer.failure && !composer.element)
      this.composers.delete(objectId);
  }

  /** The comment being written on this object is about this element, or about the whole object when null. */
  private setElement(objectId: string, element: ElementRef | null): void {
    const composer = this.composer(objectId);
    composer.element = element;
    if (composer.failure && !composer.failure.retry) composer.failure = null;
    this.draftElements = storeDraftElement(this.draftElements, objectId, element);
    try {
      if (Object.keys(this.draftElements).length)
        localStorage.setItem(this.options.draftElementKey, JSON.stringify(this.draftElements));
      else localStorage.removeItem(this.options.draftElementKey);
    } catch {
      /* An element that cannot be stored stays with the composer; only a reload loses it. */
    }
    if (!element) this.forget(objectId);
    if (this.shown === objectId) this.paintComposer();
  }

  /** Start a comment about one element of an embed's page; the thread for that embed shows it above the draft. */
  about(element: ElementRef): void {
    this.setElement(element.objectId, element);
  }

  /** Open the shown thread at one comment, now or as soon as it is drawn. */
  goTo(commentId: string): void {
    this.wanted = commentId;
    this.reveal();
  }

  private reveal(): void {
    const li = this.wanted ? this.rendered.get(this.wanted) : undefined;
    if (!li) return;
    this.wanted = null;
    li.scrollIntoView({ block: 'nearest' });
    (li.querySelector<HTMLElement>('.comment-element') ?? li.querySelector<HTMLElement>('.comment-time'))?.focus({
      preventScroll: true,
    });
  }

  /** Which comments have an element, or what a live page says of one, changed: chips and the Pick control follow. */
  elementsChanged(): void {
    if (this.shown === null) return;
    this.paintElements();
    this.paintComposer();
  }

  /** Pick element from the composer: the next element the person points at in this embed's page is what the comment is about. */
  private async pick(): Promise<void> {
    const objectId = this.shown;
    if (!objectId) return;
    const ended = this.pressEndedPick;
    this.pressEndedPick = false;
    if (this.pickingFor) return this.options.elements.cancelPick();
    if (ended) return;
    this.pickingFor = objectId;
    this.paintComposer();
    const element = await this.options.elements.pick(objectId);
    this.pickingFor = null;
    if (element) this.setElement(objectId, element);
    if (this.shown !== objectId) return;
    this.paintComposer();
    if (element) this.draft.focus({ preventScroll: true });
  }

  get all(): ViewComment[] {
    return this.comments;
  }

  update(comments: ViewComment[]): void {
    this.comments = comments;
    if (this.shown !== null) this.paintThread(false);
  }

  /** The conversations were read again: repaint request states and the target chooser, never the scroll or focus. */
  requestsChanged(): void {
    this.settleAsks();
    if (this.shown === null) return;
    this.paintRequests();
    this.paintTarget();
  }

  /** Quiet count marks on objects that have comments; no mark at zero. */
  mark(elements: Map<string, HTMLElement>): void {
    const counts = commentCounts(this.comments);
    this.marks ??= new CommentMarks(node('board'), bubble);
    this.marks.update(counts, elements);
    for (const [id, el] of elements) {
      const count = counts.get(id) ?? 0;
      if (!count) continue;
      const base = el.getAttribute('aria-label') ?? '';
      if (!base.includes(' comment'))
        el.setAttribute('aria-label', `${base} · ${count} ${count === 1 ? 'comment' : 'comments'}`);
    }
  }

  title(objectId: string | null): string {
    return objectId ? 'Comments' : 'Comments on this canvas';
  }

  /** Show the thread for one object, or a list of commented objects when nothing is focused. */
  show(objectId: string | null): void {
    const changed = this.shown !== objectId;
    this.shown = objectId;
    if (changed) {
      this.rendered.clear();
      this.list.replaceChildren();
      const kept =
        objectId !== null &&
        (this.asks.some((ask) => ask.objectId === objectId) ||
          objectId in this.drafts ||
          objectId in this.draftElements);
      const composer = objectId ? (kept ? this.composer(objectId) : this.composers.get(objectId)) : undefined;
      this.draft.value = composer?.draft ?? '';
    }
    this.paintThread(changed);
    clearInterval(this.clock);
    this.clock = setInterval(() => this.paintTimes(), 60_000);
  }

  hide(): void {
    this.shown = null;
    this.rendered.clear();
    this.list.replaceChildren();
    clearInterval(this.clock);
  }

  focusComposer(): void {
    if (this.shown) this.draft.focus({ preventScroll: true });
  }

  private paintThread(scrollToEnd: boolean): void {
    const objectId = this.shown;
    const object = objectId ? this.options.objects().find((o) => o.id === objectId) : undefined;
    node('threadTarget').textContent = objectId ? (object ? label(object) : 'This object was removed.') : '';
    node('threadTarget').hidden = !objectId;
    node('commentForm').hidden = !objectId || !object;
    node('threadPicker').hidden = !!objectId;
    if (!objectId) {
      this.list.hidden = true;
      node('threadEmpty').hidden = true;
      this.paintPicker();
      return;
    }
    const items = thread(this.comments, objectId);
    const atEnd = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 8;
    const keep = new Set(items.map((c) => c.id));
    for (const [id, el] of this.rendered)
      if (!keep.has(id)) {
        el.remove();
        this.rendered.delete(id);
      }
    let added = false;
    for (const comment of items) {
      if (this.rendered.has(comment.id)) continue;
      const li = this.item(comment);
      this.rendered.set(comment.id, li);
      this.list.append(li);
      added = true;
    }
    if (added) hydrateDiagrams(this.list);
    this.list.hidden = !items.length;
    node('threadEmpty').hidden = !!items.length;
    this.paintElements();
    this.paintRequests();
    if (scrollToEnd || (added && atEnd)) this.list.scrollTop = this.list.scrollHeight;
    this.reveal();
    this.paintComposer();
  }

  /**
   * The element chip on each comment that is about one: its pin number, its label and where the page marks its
   * source, or that the page no longer has it. Every word but the last is the page's own: `textContent` only.
   */
  private paintElements(): void {
    for (const [id, li] of this.rendered) {
      const anchor = this.options.elements.of(id);
      let chip = li.querySelector<HTMLButtonElement>(':scope > .comment-element');
      if (!anchor) {
        chip?.remove();
        continue;
      }
      const { element, number, state } = anchor;
      const signature = JSON.stringify([element.selector, element.tag, element.text, element.source, number, state]);
      if (chip?.dataset.signature === signature) continue;
      if (!chip) {
        chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'comment-element';
        for (const part of ['element-number', 'element-name', 'element-where']) {
          const span = document.createElement('span');
          span.className = part;
          chip.append(span);
        }
        chip.addEventListener('click', () => {
          const current = this.options.elements.of(id);
          if (current) this.options.elements.show(current.element);
        });
        li.querySelector(':scope > .comment-head')?.after(chip);
      }
      chip.dataset.signature = signature;
      chip.dataset.state = state;
      const [mark, name, where] = [...chip.children] as HTMLElement[];
      mark.textContent = String(number);
      name.textContent = elementLabel(element);
      name.dataset.i18nSkip = '';
      const missing = state === 'missing';
      where.textContent = missing ? 'No longer on the page' : (element.source ?? element.selector);
      where.toggleAttribute('data-i18n-skip', !missing);
      chip.title = [element.selector, element.source, missing ? '' : 'Show this element on the canvas']
        .filter(Boolean)
        .join('\n');
    }
  }

  /** The state line on each asking comment, with Open conversation and, for one not delivered, Retry. */
  private paintRequests(): void {
    const requests = new Map(this.options.assistant.requests().map((r) => [r.commentId, r]));
    const present = new Set(this.comments.map((c) => c.id));
    for (const [id, li] of this.rendered) {
      const request = requests.get(id);
      let line = li.querySelector<HTMLElement>(':scope > .comment-request');
      if (!request) {
        line?.remove();
        continue;
      }
      const status = requestStatus(request, (commentId) => present.has(commentId));
      const signature = JSON.stringify([status, request.conversationId]);
      if (line?.dataset.signature === signature) continue;
      const held = line?.contains(document.activeElement) ? document.activeElement?.className : undefined;
      line?.remove();
      line = document.createElement('div');
      line.className = 'comment-request';
      line.dataset.signature = signature;
      line.dataset.state = status.kind;
      const text = document.createElement('span');
      text.className = 'request-state';
      text.textContent = `Asked an agent · ${status.text}`;
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'quiet request-open';
      open.textContent = 'Open conversation';
      open.addEventListener('click', () => this.options.assistant.open(request.conversationId));
      line.append(text, open);
      if (request.state === 'failed' && !request.ended) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'quiet request-retry';
        retry.textContent = 'Retry';
        retry.addEventListener('click', () => void this.retryRequest(request, retry));
        line.append(retry);
      }
      li.append(line);
      if (held) line.querySelector<HTMLElement>(`.${held.split(' ').at(-1)}`)?.focus({ preventScroll: true });
    }
  }

  /** The same message again: its id, the comment's own text and its origin, so the server checks the composer first and never writes it twice. */
  private async retryRequest(request: ThreadRequest, button: HTMLButtonElement): Promise<void> {
    const comment = this.comments.find((c) => c.id === request.commentId);
    if (!comment) return;
    button.toggleAttribute('disabled', true);
    const result = await this.send(request.conversationId, request.messageId, comment.text, {
      kind: 'thread',
      objectId: request.objectId,
      commentId: request.commentId,
    });
    if (!result.ok && button.isConnected) {
      button.toggleAttribute('disabled', false);
      const state = button.parentElement?.querySelector('.request-state');
      if (state) state.textContent = `Not delivered: ${result.message}`;
    }
  }

  private send = async (
    conversationId: string,
    messageId: string,
    text: string,
    origin: { kind: 'thread'; objectId: string; commentId: string }
  ): Promise<{ ok: true } | { ok: false; message: string }> => {
    try {
      const response = await fetch(
        this.options.url(`/api/canvas/${this.options.workspace}/conversations/${conversationId}/messages`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageId, text, refIds: [origin.objectId], origin }),
        }
      );
      if (response.ok) {
        this.options.assistant.asked({ messageId, text: normalizePrompt(text), refIds: [origin.objectId] });
        return { ok: true };
      }
      const message = errorMessage(await response.json().catch(() => null));
      return { ok: false, message: askFailure(message, response.status) };
    } catch {
      return { ok: false, message: 'could not reach the server.' };
    }
  };

  /** The inline chooser: live conversations of this canvas, or a new one on the rail's provider and model. */
  private paintTarget(): void {
    const assistant = this.options.assistant;
    const targets = assistant.targets();
    const fresh = assistant.fresh();
    const wanted = this.picked ?? assistant.preferred() ?? targets[0]?.id ?? NEW_TARGET;
    const value = wanted !== NEW_TARGET && !targets.some((t) => t.id === wanted) ? NEW_TARGET : wanted;
    const signature = JSON.stringify([targets, fresh, value]);
    if (signature !== this.targetSignature) {
      this.targetSignature = signature;
      this.target.replaceChildren();
      for (const t of targets) {
        const option = document.createElement('option');
        option.value = t.id;
        option.textContent = t.label;
        this.target.append(option);
      }
      const option = document.createElement('option');
      option.value = NEW_TARGET;
      option.textContent = fresh.ok ? fresh.label : 'New conversation (unavailable)';
      this.target.append(option);
      this.target.value = value;
    }
    const note = node('askNote');
    const blocked = value === NEW_TARGET && !fresh.ok;
    note.textContent = blocked ? `${fresh.reason} Pick a conversation, or another provider in the assistant.` : '';
    note.hidden = !blocked;
  }

  private paintPicker(): void {
    const counts = commentCounts(this.comments);
    const picker = node('threadPicker');
    picker.replaceChildren();
    const live = new Set(this.options.objects().map((o) => o.id));
    for (const [id, composer] of this.composers)
      if (!live.has(id) && composer.draft.trim() && !composer.sending) picker.append(this.orphan(id, composer));
    const objects = this.options.objects().filter((o) => counts.has(o.id));
    const intro = document.createElement('p');
    intro.className = 'secondary';
    intro.textContent = objects.length
      ? 'Objects with comments. Select one to read its thread.'
      : 'No comments on this canvas yet. Select an object, then add one here.';
    picker.append(intro);
    for (const o of objects) {
      const row = document.createElement('button');
      row.className = 'picker-row';
      const name = document.createElement('span');
      name.textContent = label(o);
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = String(counts.get(o.id));
      row.append(name, count);
      row.setAttribute('aria-label', `${label(o)} · ${counts.get(o.id)} comments`);
      row.onclick = () => this.options.choose(o.id);
      picker.append(row);
    }
  }

  /** A draft whose object was removed stays readable, copyable and discardable; a restore brings it back. */
  private orphan(objectId: string, composer: Composer): HTMLElement {
    const box = document.createElement('section');
    box.className = 'orphan-draft';
    box.dataset.orphanFor = objectId;
    const line = document.createElement('p');
    line.textContent = `Your comment on “${composer.name || 'a removed object'}” was not posted because the object was removed.`;
    const text = document.createElement('blockquote');
    text.className = 'orphan-text';
    text.textContent = composer.draft;
    const actions = document.createElement('div');
    actions.className = 'orphan-actions';
    const copy = document.createElement('button');
    copy.textContent = 'Copy';
    copy.onclick = () => {
      void navigator.clipboard?.writeText(composer.draft).then(
        () => (copy.textContent = 'Copied'),
        () => {
          const range = document.createRange();
          range.selectNodeContents(text);
          getSelection()?.removeAllRanges();
          getSelection()?.addRange(range);
          copy.textContent = 'Selected: press Ctrl+C';
        }
      );
    };
    const discard = document.createElement('button');
    discard.className = 'quiet';
    discard.textContent = 'Discard';
    discard.onclick = () => {
      this.composers.delete(objectId);
      this.keepDraft(objectId, '');
      this.paintPicker();
      node('threadView').focus({ preventScroll: true });
    };
    actions.append(copy, discard);
    box.append(line, text, actions);
    return box;
  }

  private item(comment: ViewComment): HTMLElement {
    const li = document.createElement('li');
    li.className = 'comment';
    li.dataset.commentId = comment.id;
    const head = document.createElement('div');
    head.className = 'comment-head';
    const time = document.createElement('button');
    time.className = 'comment-time';
    time.dataset.at = String(comment.createdAt);
    time.title = exactTime(comment.createdAt);
    time.setAttribute('aria-label', `Posted ${exactTime(comment.createdAt)}. Show exact time`);
    time.setAttribute('aria-pressed', 'false');
    time.onclick = () => {
      time.setAttribute('aria-pressed', String(time.getAttribute('aria-pressed') !== 'true'));
      this.paintTime(time);
    };
    this.paintTime(time);
    head.append(authorLabel(comment.author), time);
    // An agent's comment (an Ask agent reply) is its Markdown rendered; a person's stays the text they typed.
    let body = comment.author.kind === 'agent' ? renderMarkdown(comment.text) : null;
    if (!body) {
      body = document.createElement('p');
      body.textContent = comment.text;
    }
    body.classList.add('comment-text');
    li.append(head, body);
    return li;
  }

  private paintTime(time: HTMLElement): void {
    const at = Number(time.dataset.at);
    time.textContent = time.getAttribute('aria-pressed') === 'true' ? exactTime(at) : relativeTime(at, Date.now());
  }

  private paintTimes(): void {
    for (const time of this.list.querySelectorAll<HTMLElement>('.comment-time')) this.paintTime(time);
  }

  private paintComposer(): void {
    const composer = this.shown ? this.composers.get(this.shown) : undefined;
    const sending = !!composer?.sending;
    const failure = composer?.failure ?? null;
    const post = node('postComment');
    const empty = !this.draft.value.trim();
    const asking = sending && composer?.action === 'ask';
    post.setAttribute('aria-disabled', String(sending || empty));
    post.textContent = sending && !asking ? 'Posting…' : 'Post';
    const ask = node('askAgent');
    ask.setAttribute('aria-disabled', String(sending || empty));
    ask.textContent = asking ? 'Asking…' : 'Ask agent';
    ask.hidden = !!failure?.retry;
    this.target.disabled = sending;
    this.paintTarget();
    this.draft.readOnly = sending;
    const element = composer?.element ?? null;
    const picking = this.pickingFor !== null && this.pickingFor === this.shown;
    node('commentAbout').hidden = !element;
    const about = node('commentAboutShow');
    const name = element ? elementLabel(element) : '';
    if (about.textContent !== name) about.textContent = name;
    about.title = element ? [element.selector, element.source].filter(Boolean).join('\n') : '';
    node('commentAboutRemove').toggleAttribute('disabled', sending);
    const pick = node('commentPick');
    pick.hidden = !!element || !this.shown || !(picking || this.options.elements.canPick(this.shown));
    pick.setAttribute('aria-pressed', String(picking));
    pick.textContent = picking ? 'Cancel picking' : 'Pick element';
    pick.toggleAttribute('disabled', sending);
    const status = node('commentStatus');
    status.textContent = failure
      ? failure.message
      : picking
        ? 'Click an element in the page. Escape cancels.'
        : sending || document.documentElement.hasAttribute('data-touch')
          ? ''
          : `${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter to post`;
    status.dataset.state = failure ? 'failed' : '';
    node('retryComment').hidden = !failure?.retry;
    post.hidden = !!failure?.retry;
  }

  /** Posts the shown object's draft once; a retry resends the same request id so it cannot duplicate. */
  async post(): Promise<boolean> {
    const objectId = this.shown;
    if (!objectId) return false;
    const composer = this.composer(objectId);
    const text = this.draft.value;
    if (composer.sending || !text.trim()) return false;
    const object = this.options.objects().find((o) => o.id === objectId);
    if (object) composer.name = label(object);
    composer.draft = text;
    composer.action = 'post';
    const element = composer.element;
    if (!composer.pending || composer.pending.text !== text || !sameElement(composer.pending.element, element)) {
      // The same text an Ask agent attempt already posted here goes out under that attempt's ids, so it lands once.
      const asked = this.asks.find(
        (ask) => ask.objectId === objectId && ask.text === text && sameElement(ask.element, element)
      );
      composer.pending = {
        requestId: asked?.commentRequestId ?? uuid(),
        commentId: asked?.commentId ?? uuid(),
        text,
        objectId,
        element,
      };
    }
    const pending = composer.pending;
    composer.sending = true;
    composer.failure = null;
    this.paintComposer();
    let ok = false;
    let failure: PostFailure | null = null;
    try {
      const response = await fetch(this.options.url(`/api/canvas/${this.options.workspace}/command`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool: 'canvas_comment',
          requestId: pending.requestId,
          arguments: commentArguments(pending),
        }),
      });
      ok = response.ok;
      const body: unknown = await response.json().catch(() => null);
      if (!ok) failure = postFailure(response.status, body);
      else if (pending.element && wasAnchored(body)) this.options.elements.anchored(pending.commentId, pending.element);
    } catch {
      failure = postFailure(null, null);
    }
    composer.sending = false;
    if (ok) {
      composer.pending = null;
      if (pending.element && sameElement(composer.element, pending.element)) this.setElement(objectId, null);
      if (this.asks.some((ask) => ask.objectId === objectId && ask.text === pending.text)) this.keepAsk(null, objectId);
      if (composer.draft === pending.text) {
        composer.draft = '';
        this.keepDraft(objectId, '');
      }
      if (this.shown === objectId && this.draft.value === pending.text) {
        this.draft.value = '';
        this.list.scrollTop = this.list.scrollHeight;
      }
      this.forget(objectId);
    } else {
      composer.failure = failure ?? postFailure(null, null);
      // A refusal that cannot succeed as sent gets fresh ids once the text is edited.
      if (!composer.failure.retry) composer.pending = null;
    }
    if (this.shown === objectId) this.paintComposer();
    else if (this.shown === null) this.paintPicker();
    return ok;
  }

  /** An attempt the server already took (its answer was lost, or a reload cut in) is finished: its draft and ids go. */
  private settleAsks(): void {
    const taken = new Set(this.options.assistant.requests().map((r) => r.messageId));
    for (const ask of this.asks.filter((a) => taken.has(a.messageId))) {
      const composer = this.composers.get(ask.objectId);
      if (composer?.sending) continue;
      this.keepAsk(null, ask.objectId);
      if (!composer || composer.draft !== ask.text) continue;
      if (ask.element && sameElement(composer.element, ask.element)) this.setElement(ask.objectId, null);
      composer.draft = '';
      this.keepDraft(ask.objectId, '');
      composer.failure = null;
      composer.action = 'post';
      if (this.shown === ask.objectId) {
        if (this.draft.value === ask.text) this.draft.value = '';
        this.paintComposer();
      }
      this.forget(ask.objectId);
    }
  }

  private keepDraft(objectId: string, text: string): void {
    this.drafts = storeDraft(this.drafts, objectId, text);
    try {
      if (Object.keys(this.drafts).length) localStorage.setItem(this.options.draftKey, JSON.stringify(this.drafts));
      else localStorage.removeItem(this.options.draftKey);
    } catch {
      /* A draft that cannot be stored stays in the composer; only a reload loses it. */
    }
  }

  private keepAsk(attempt: AskAttempt | null, objectId: string): void {
    this.asks = attempt ? storeAsks(this.asks, attempt) : this.asks.filter((a) => a.objectId !== objectId);
    try {
      if (this.asks.length) localStorage.setItem(this.options.askKey, JSON.stringify(this.asks));
      else localStorage.removeItem(this.options.askKey);
    } catch {
      /* An attempt that cannot be stored still completes; only a reload in the middle loses its ids. */
    }
  }

  /**
   * Ask agent: posts the draft as an ordinary comment, then sends it to the chosen conversation with this object as
   * context and the comment as its origin. Every step carries ids made once per attempt, so a retry after a lost
   * answer posts no second comment, starts no second conversation and writes no second prompt.
   */
  async ask(): Promise<boolean> {
    const objectId = this.shown;
    if (!objectId) return false;
    const composer = this.composer(objectId);
    const text = this.draft.value;
    if (composer.sending || !text.trim()) return false;
    const fail = (message: string, retry: boolean): false => {
      composer.sending = false;
      composer.failure = { retry, message };
      if (this.shown === objectId) this.paintComposer();
      else if (this.shown === null) this.paintPicker();
      return false;
    };
    composer.action = 'ask';
    composer.draft = text;
    composer.failure = null;
    const refusal = promptRefusal(normalizePrompt(text));
    if (refusal) return fail(`Not asked: ${refusal}. Nothing was posted.`, false);
    if (typeof navigator !== 'undefined' && navigator.onLine === false)
      return fail('You are offline. Your comment is kept here; ask again when the connection is back.', true);
    const target = this.target.value || null;
    const fresh = target ? null : this.options.assistant.fresh();
    if (fresh && !fresh.ok) return fail('Not asked. Nothing was posted.', false);
    const object = this.options.objects().find((o) => o.id === objectId);
    if (object) composer.name = label(object);
    const element = composer.element;
    // The same text about another element is another comment: it gets ids of its own.
    const stored = this.asks.find((a) => a.objectId === objectId && sameElement(a.element, element));
    let attempt: AskAttempt = nextAsk(stored, objectId, text, target, () => uuid());
    if (element) attempt = { ...attempt, element };
    this.keepAsk(attempt, objectId);
    composer.sending = true;
    this.paintComposer();
    const post = async (path: string, body: unknown): Promise<{ status: number | null; body: unknown }> => {
      try {
        const response = await fetch(this.options.url(`/api/canvas/${this.options.workspace}${path}`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json().catch(() => null) };
      } catch {
        return { status: null, body: null };
      }
    };
    const commented = await post('/command', {
      tool: 'canvas_comment',
      requestId: attempt.commentRequestId,
      arguments: commentArguments({ objectId, text, commentId: attempt.commentId, element }),
    });
    if (commented.status === null || commented.status >= 400) {
      const failure = postFailure(commented.status, commented.body);
      if (!failure.retry) this.keepAsk(null, objectId);
      return fail(failure.message, failure.retry);
    }
    if (element && wasAnchored(commented.body)) this.options.elements.anchored(attempt.commentId, element);
    const origin = { kind: 'thread' as const, objectId, commentId: attempt.commentId };
    const posted = 'Your comment is posted. The agent was not asked:';
    if (!attempt.conversationId) {
      const made = await post('/conversations', {
        requestId: attempt.createRequestId,
        ...(fresh?.ok && fresh.cliId ? { cliId: fresh.cliId } : {}),
        ...(fresh?.ok && fresh.model ? { model: fresh.model } : {}),
        origin,
      });
      const id =
        typeof made.body === 'object' && made.body !== null && 'data' in made.body
          ? (made.body.data as { conversation?: { id?: unknown } } | null)?.conversation?.id
          : undefined;
      if (made.status === null) return fail(`${posted} could not reach the server.`, true);
      if (made.status >= 400 || typeof id !== 'string')
        return fail(`${posted} ${sendFailure(errorMessage(made.body), made.status).text}`, true);
      attempt = { ...attempt, conversationId: id };
      this.keepAsk(attempt, objectId);
    }
    const conversationId = attempt.conversationId;
    if (!conversationId) return fail(`${posted} no conversation was chosen.`, true);
    const sent = await this.send(conversationId, attempt.messageId, text, origin);
    if (!sent.ok) return fail(`${posted} ${sent.message}`, true);
    composer.sending = false;
    this.keepAsk(null, objectId);
    if (element && sameElement(composer.element, element)) this.setElement(objectId, null);
    if (composer.draft === text) {
      composer.draft = '';
      this.keepDraft(objectId, '');
    }
    if (this.shown === objectId && this.draft.value === text) {
      this.draft.value = '';
      this.list.scrollTop = this.list.scrollHeight;
    }
    this.forget(objectId);
    if (this.shown === objectId) this.paintComposer();
    else if (this.shown === null) this.paintPicker();
    return true;
  }
}
