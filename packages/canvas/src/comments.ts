import { z } from 'zod';
import { label, type ViewObject } from './model.js';

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

type Pending = { requestId: string; commentId: string; text: string; objectId: string };
/** One object's composer: its draft, the post it is sending or retrying, and why the last one failed. */
type Composer = {
  draft: string;
  name: string;
  pending: Pending | null;
  sending: boolean;
  failure: PostFailure | null;
};
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
  if (status === 400)
    return { retry: false, message: 'Not posted: comments hold up to 100,000 characters. Shorten it and post again.' };
  return { retry: false, message: 'Not posted: the canvas refused this comment. Your comment is kept here.' };
}

/** The thread view in the rail: ordinary comments only. Posting never starts agent work. */
export class CommentsView {
  private comments: ViewComment[] = [];
  private shown: string | null = null;
  private rendered = new Map<string, HTMLElement>();
  private composers = new Map<string, Composer>();
  private clock: ReturnType<typeof setInterval> | undefined;
  private list = node('threadList');
  private draft: HTMLTextAreaElement;

  constructor(
    private options: {
      url: (path: string) => string;
      workspace: string;
      objects: () => ViewObject[];
      choose: (objectId: string) => void;
    }
  ) {
    const draft = node('commentDraft');
    if (!(draft instanceof HTMLTextAreaElement)) throw new Error('Expected comment draft');
    this.draft = draft;
    draft.addEventListener('input', () => {
      if (this.shown) {
        const composer = this.composer(this.shown);
        composer.draft = draft.value;
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
    node('retryComment').addEventListener('click', () => void this.post());
  }

  /** The composer for one object, kept most recent last; idle empty ones are dropped past the bound. */
  private composer(objectId: string): Composer {
    let composer = this.composers.get(objectId);
    if (composer) this.composers.delete(objectId);
    else {
      const object = this.options.objects().find((o) => o.id === objectId);
      composer = { draft: '', name: object ? label(object) : '', pending: null, sending: false, failure: null };
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
    if (composer && !composer.sending && !composer.draft && !composer.failure) this.composers.delete(objectId);
  }

  get all(): ViewComment[] {
    return this.comments;
  }

  update(comments: ViewComment[]): void {
    this.comments = comments;
    if (this.shown !== null) this.paintThread(false);
  }

  /** Quiet count marks on objects that have comments; no mark at zero. */
  mark(elements: Map<string, HTMLElement>): void {
    const counts = commentCounts(this.comments);
    for (const [id, el] of elements) {
      const count = counts.get(id) ?? 0;
      let mark = el.querySelector<HTMLElement>(':scope > .comment-mark');
      if (!count) {
        mark?.remove();
        continue;
      }
      if (!mark) {
        mark = document.createElement('span');
        mark.className = 'comment-mark';
        mark.setAttribute('aria-hidden', 'true');
        mark.append(bubble(), document.createElement('span'));
        el.append(mark);
      }
      const text = mark.lastElementChild;
      if (text && text.textContent !== String(count)) text.textContent = String(count);
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
      this.draft.value = objectId ? (this.composers.get(objectId)?.draft ?? '') : '';
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
    this.list.hidden = !items.length;
    node('threadEmpty').hidden = !!items.length;
    if (scrollToEnd || (added && atEnd)) this.list.scrollTop = this.list.scrollHeight;
    this.paintComposer();
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
    const body = document.createElement('p');
    body.className = 'comment-text';
    body.textContent = comment.text;
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
    post.setAttribute('aria-disabled', String(sending || empty));
    post.textContent = sending ? 'Posting…' : 'Post';
    this.draft.readOnly = sending;
    const status = node('commentStatus');
    status.textContent = failure
      ? failure.message
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
    if (!composer.pending || composer.pending.text !== text)
      composer.pending = { requestId: crypto.randomUUID(), commentId: crypto.randomUUID(), text, objectId };
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
          arguments: { objectId: pending.objectId, text: pending.text, commentId: pending.commentId },
        }),
      });
      ok = response.ok;
      if (!ok) failure = postFailure(response.status, await response.json().catch(() => null));
    } catch {
      failure = postFailure(null, null);
    }
    composer.sending = false;
    if (ok) {
      composer.pending = null;
      if (composer.draft === pending.text) composer.draft = '';
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
}
