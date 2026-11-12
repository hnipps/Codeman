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

/** The thread view in the rail: ordinary comments only. Posting never starts agent work. */
export class CommentsView {
  private comments: ViewComment[] = [];
  private shown: string | null = null;
  private rendered = new Map<string, HTMLElement>();
  private drafts = new Map<string, string>();
  private pending: Pending | null = null;
  private failed = false;
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
      if (this.shown) this.drafts.set(this.shown, draft.value);
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
      this.failed = this.pending?.objectId === objectId && this.failed;
      this.draft.value = objectId ? (this.drafts.get(objectId) ?? '') : '';
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
    const posting = !!this.pending && !this.failed;
    const post = node('postComment');
    const empty = !this.draft.value.trim();
    post.setAttribute('aria-disabled', String(posting || empty));
    post.textContent = posting ? 'Posting…' : 'Post';
    this.draft.readOnly = posting;
    const status = node('commentStatus');
    status.textContent = this.failed
      ? 'Not posted. Your comment is kept here.'
      : posting || document.documentElement.hasAttribute('data-touch')
        ? ''
        : `${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter to post`;
    status.dataset.state = this.failed ? 'failed' : '';
    node('retryComment').hidden = !this.failed;
    post.hidden = this.failed;
  }

  /** Posts the draft once; a retry resends the same request id so it cannot duplicate. */
  async post(): Promise<boolean> {
    const objectId = this.shown;
    if (!objectId) return false;
    const text = this.draft.value;
    if (this.pending && !this.failed) return false;
    if (!text.trim()) return false;
    if (!this.pending || this.pending.text !== text || this.pending.objectId !== objectId)
      this.pending = { requestId: crypto.randomUUID(), commentId: crypto.randomUUID(), text, objectId };
    const pending = this.pending;
    this.failed = false;
    this.paintComposer();
    let ok = false;
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
    } catch {
      ok = false;
    }
    if (this.pending !== pending) return ok;
    if (ok) {
      this.pending = null;
      this.drafts.delete(pending.objectId);
      if (this.shown === pending.objectId) {
        this.draft.value = '';
        this.list.scrollTop = this.list.scrollHeight;
      }
    } else this.failed = true;
    this.paintComposer();
    return ok;
  }
}
