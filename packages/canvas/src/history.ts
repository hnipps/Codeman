import { z } from 'zod';
import { authorLabel, exactTime, relativeTime, type ViewAuthor } from './comments.js';
import { label, type ViewObject } from './model.js';
import type { PhoneQuery } from './mobile.js';

const AuthorSchema = z.union([
  z.object({ kind: z.literal('human'), userId: z.string() }).passthrough(),
  z.object({ kind: z.literal('agent'), sessionId: z.string() }).passthrough(),
]);
const AuthorsSchema = z.object({
  data: z.object({
    data: z.array(z.object({ author: AuthorSchema, operations: z.number(), lastActivity: z.number() })),
  }),
});
const FieldsSchema = z.array(z.object({ objectId: z.string(), fields: z.array(z.string()) }));
export const RevertSummarySchema = z
  .object({
    removed: z.array(z.string()),
    restored: FieldsSchema,
    skipped: FieldsSchema,
    kept: z.array(z.string()),
    comments: z.number(),
    refused: z.array(z.object({ code: z.string(), objectId: z.string().optional() }).passthrough()).optional(),
  })
  .passthrough();
export type RevertSummary = z.infer<typeof RevertSummarySchema>;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const fieldCount = (entries: { fields: string[] }[]): number => entries.reduce((n, e) => n + e.fields.length, 0);
/** Later edits by others that stay: a kept object counts once, however many of its fields were also skipped. */
export function laterChanges(s: RevertSummary): number {
  const kept = new Set(s.kept);
  return kept.size + fieldCount(s.skipped.filter((e) => !kept.has(e.objectId)));
}

/** The confirm sentence: what goes, what is restored, and that later edits by others stay. */
export function previewSentence(s: RevertSummary, name: (id: string) => string): string {
  const parts: string[] = [];
  if (s.removed.length) parts.push(`removes ${plural(s.removed.length, 'object')}`);
  if (s.comments) parts.push(`removes ${plural(s.comments, 'comment')}`);
  if (s.restored.length)
    parts.push(`restores ${plural(fieldCount(s.restored), 'field')} on ${plural(s.restored.length, 'object')}`);
  if (!parts.length) return 'This session has nothing left to revert.';
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  const kept = laterChanges(s);
  const short = (id: string): string => {
    const text = name(id);
    return text.length > 40 ? `${text.slice(0, 39)}…` : text;
  };
  const where = [...new Set([...s.kept, ...s.skipped.map((e) => e.objectId)])]
    .slice(0, 2)
    .map((id) => `“${short(id)}”`);
  const later = kept
    ? ` Later edits by others stay: ${plural(kept, 'change')} on ${where.join(' and ')}.`
    : ' Later edits by others stay.';
  return `This ${list}.${later}`;
}

/** The result line after a revert, naming what was skipped. */
export function resultSentence(s: RevertSummary): string {
  const done: string[] = [];
  if (s.removed.length) done.push(`removed ${plural(s.removed.length, 'object')}`);
  if (s.restored.length) done.push(`restored ${plural(fieldCount(s.restored), 'field')}`);
  if (s.comments) done.push(`removed ${plural(s.comments, 'comment')}`);
  const skipped = laterChanges(s);
  const head = done.length ? `Reverted: ${done.join(', ')}.` : 'Nothing was reverted.';
  return skipped ? `${head} Skipped ${plural(skipped, 'change')} others made later.` : `${head} Nothing was skipped.`;
}

/** The shortest gap between two author re-reads while History is open. */
export const HISTORY_REFRESH_MS = 1000;

const key = (a: ViewAuthor): string => (a.kind === 'human' ? `h:${a.userId}` : `a:${a.sessionId}`);
const node = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing history element: ${id}`);
  return el;
};

/** Who changed this canvas, with an inline, confirmed author revert for agent sessions. */
export class HistoryView {
  private open = false;
  private confirm: { key: string; requestId: string; summary: RevertSummary | null } | null = null;
  private results = new Map<string, string>();
  private loading = 0;
  private lastRefresh = 0;
  private trailing: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private options: {
      url: (path: string) => string;
      workspace: string;
      phone: PhoneQuery;
      objects: () => ViewObject[];
    }
  ) {}

  private name(id: string): string {
    const o = this.options.objects().find((o) => o.id === id);
    return o ? label(o) : 'a removed object';
  }

  private async command(args: unknown): Promise<unknown> {
    const response = await fetch(this.options.url(`/api/canvas/${this.options.workspace}/command`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'canvas_history', arguments: args }),
    });
    if (!response.ok) throw new Error('History request failed');
    return response.json();
  }

  show(): void {
    this.open = true;
    void this.refresh();
  }

  hide(): void {
    this.open = false;
    this.confirm = null;
    if (this.trailing) clearTimeout(this.trailing);
    this.trailing = null;
  }

  /** The canvas changed: re-read authors at most once a second, and once more after a burst. */
  changed(now = Date.now()): void {
    if (!this.open || this.trailing) return;
    const wait = HISTORY_REFRESH_MS - (now - this.lastRefresh);
    if (wait <= 0) {
      void this.refresh();
      return;
    }
    this.trailing = setTimeout(() => {
      this.trailing = null;
      void this.refresh();
    }, wait);
  }

  async refresh(): Promise<void> {
    if (!this.open) return;
    this.lastRefresh = Date.now();
    const ticket = ++this.loading;
    const status = node('historyStatus');
    try {
      const authors = AuthorsSchema.parse(await this.command({ action: 'authors' })).data.data;
      if (ticket !== this.loading || !this.open) return;
      status.textContent = authors.length ? '' : 'No changes yet.';
      this.paint(authors);
    } catch {
      if (ticket === this.loading) status.textContent = 'History could not load. Close and reopen to try again.';
    }
  }

  private paint(authors: z.infer<typeof AuthorsSchema>['data']['data']): void {
    const list = node('historyList');
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.historyFocus : '';
    list.replaceChildren();
    for (const entry of authors) {
      const id = key(entry.author);
      const li = document.createElement('li');
      li.className = 'history-row';
      li.dataset.author = id;
      const head = document.createElement('div');
      head.className = 'history-head';
      head.append(authorLabel(entry.author));
      const meta = document.createElement('p');
      meta.className = 'history-meta';
      const time = document.createElement('time');
      time.dateTime = new Date(entry.lastActivity).toISOString();
      time.title = exactTime(entry.lastActivity);
      time.textContent = relativeTime(entry.lastActivity, Date.now());
      meta.append(`${plural(entry.operations, 'operation')} · last active `, time);
      li.append(head, meta);
      if (entry.author.kind === 'agent' && !this.options.phone.matches) {
        const revert = document.createElement('button');
        revert.className = 'quiet history-revert';
        revert.textContent = 'Revert this session';
        revert.dataset.historyFocus = `revert:${id}`;
        revert.setAttribute('aria-expanded', String(this.confirm?.key === id));
        revert.onclick = () => void this.ask(entry.author);
        li.append(revert);
        if (this.confirm?.key === id) li.append(this.confirmBlock(entry.author));
      }
      const result = this.results.get(id);
      if (result) {
        const line = document.createElement('p');
        line.className = 'history-result';
        line.setAttribute('role', 'status');
        line.textContent = result;
        li.append(line);
      }
      list.append(li);
    }
    if (focused) list.querySelector<HTMLElement>(`[data-history-focus="${CSS.escape(focused)}"]`)?.focus();
  }

  private confirmBlock(author: ViewAuthor): HTMLElement {
    const box = document.createElement('div');
    box.className = 'revert-confirm';
    const id = key(author);
    const summary = this.confirm?.summary;
    const text = document.createElement('p');
    if (!summary) text.textContent = 'Checking what this would change…';
    else if (summary.refused?.length) {
      const locked = summary.refused.filter((r) => r.code === 'LOCKED');
      text.textContent = locked.length
        ? `“${this.name(locked[0].objectId ?? '')}” is locked. Unlock it first; nothing is reverted while a target is locked.`
        : 'This revert cannot apply to the current canvas. Nothing was changed.';
    } else text.textContent = previewSentence(summary, (objectId) => this.name(objectId));
    box.append(text);
    const actions = document.createElement('div');
    actions.className = 'revert-actions';
    const go = document.createElement('button');
    go.className = 'primary';
    go.textContent = 'Revert';
    go.dataset.historyFocus = `confirm:${id}`;
    const blocked =
      !summary ||
      !!summary.refused?.length ||
      (!summary.removed.length && !summary.restored.length && !summary.comments);
    go.setAttribute('aria-disabled', String(blocked));
    go.onclick = () => {
      if (!blocked) void this.revert(author);
    };
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.dataset.historyFocus = `cancel:${id}`;
    cancel.onclick = () => this.cancel(id);
    actions.append(go, cancel);
    box.append(actions);
    box.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      this.cancel(id);
    });
    return box;
  }

  private cancel(id: string): void {
    this.confirm = null;
    void this.refresh().then(() =>
      node('historyList')
        .querySelector<HTMLElement>(`[data-history-focus="${CSS.escape(`revert:${id}`)}"]`)
        ?.focus()
    );
  }

  private async ask(author: ViewAuthor): Promise<void> {
    const id = key(author);
    if (this.confirm?.key === id) return this.cancel(id);
    this.results.delete(id);
    this.confirm = { key: id, requestId: crypto.randomUUID(), summary: null };
    await this.refresh();
    try {
      const preview = z
        .object({ data: z.object({ data: RevertSummarySchema }) })
        .parse(await this.command({ action: 'preview', author })).data.data;
      if (this.confirm?.key !== id) return;
      this.confirm.summary = preview;
    } catch {
      if (this.confirm?.key !== id) return;
      this.confirm = null;
      this.results.set(id, 'Could not check this revert. Try again.');
    }
    await this.refresh();
    node('historyList')
      .querySelector<HTMLElement>(`[data-history-focus="${CSS.escape(`confirm:${id}`)}"]`)
      ?.focus();
  }

  private async revert(author: ViewAuthor): Promise<void> {
    const id = key(author);
    const confirm = this.confirm;
    if (!confirm || confirm.key !== id || !confirm.summary) return;
    const preview = confirm.summary;
    try {
      const response = await fetch(this.options.url(`/api/canvas/${this.options.workspace}/revert`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author, requestId: confirm.requestId }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const locked = z
          .object({ reasons: z.array(z.object({ code: z.string(), objectId: z.string() }).passthrough()) })
          .safeParse(payload);
        const reason = locked.success ? locked.data.reasons[0] : undefined;
        this.results.set(
          id,
          reason?.code === 'LOCKED'
            ? `Not reverted: “${this.name(reason.objectId)}” is locked. Unlock it and try again.`
            : reason?.code === 'REVISION'
              ? 'Not reverted: the canvas changed meanwhile. Open the revert again to see the new result.'
              : 'Not reverted. Nothing was changed.'
        );
      } else {
        const summary = z
          .object({ data: z.object({ summary: z.object({ data: RevertSummarySchema }).optional() }) })
          .safeParse(payload);
        this.results.set(
          id,
          resultSentence(summary.success && summary.data.data.summary ? summary.data.data.summary.data : preview)
        );
      }
      this.confirm = null;
    } catch {
      // Keep the confirm and its request id: Revert again cannot apply twice.
      this.results.set(
        id,
        'The connection dropped before the answer. Choose Revert again to finish; it cannot apply twice.'
      );
    }
    await this.refresh();
    node('historyList')
      .querySelector<HTMLElement>(`[data-history-focus="${CSS.escape(`revert:${id}`)}"]`)
      ?.focus();
  }
}
