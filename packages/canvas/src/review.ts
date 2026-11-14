/**
 * @fileoverview Brief review: a text object read as a document, its words selected and given typed notes
 * (Comment, Replace, Delete, Answer, a general note), and the notes sent to the session that wrote it.
 *
 * A note is an ordinary canvas comment posted through the comment command, then described to the server's side file
 * (`PUT .../review-notes/:commentId`). Sending is only ever a press: Post & send for one note, Send N for every unsent
 * note of the object in one prompt. The server decides what is unsent and stamps what it delivered.
 *
 * One view, three places: the reader rail (notes under their paragraph), the full layout (document centre, notes on
 * the right; F on desktop) and the phone (the full layout, actions in a bottom bar, notes in a bottom sheet).
 * Highlights use the CSS Custom Highlight API over text nodes, so neither the review document nor the board's object
 * is rebuilt around them. Every note, quote and session name is `textContent`.
 */
import { z } from 'zod';
import { uuid } from './ids.js';
import { label, type ViewObject } from './model.js';
import type { ViewComment } from './comments.js';
import { anchorFromOffsets, answerAnchor, locate, type Located } from '../../../src/canvas/review-anchor.js';
import type { ReviewAnchor, ReviewKind, ReviewNote } from '../../../src/canvas/review-schema.js';
import {
  alreadyApplied,
  applied,
  commentText,
  KIND_LABEL,
  lineOf,
  notesOf,
  parseNotes,
  postable,
  STATE_LABEL,
  unsentIds,
  type ViewNote,
} from './review-model.js';

export type ReviewMode = 'rail' | 'full';
/** The rail is drawn at least this wide while it holds a review. */
export const REVIEW_RAIL_WIDTH = 420;
type Composer = {
  kind: ReviewKind;
  anchor: ReviewAnchor | null;
  /** Ids kept across a retry, so a repeat posts the same comment once. */
  commentId: string;
  requestId: string;
  step: 'idle' | 'busy';
  failed: string | null;
};
const SessionsAnswer = z.object({
  data: z.object({
    sessions: z.array(z.object({ id: z.string(), name: z.string(), state: z.string() }).passthrough()),
  }),
});
const ErrorAnswer = z.object({ error: z.string() }).passthrough();
const SentAnswer = z.object({
  data: z.object({ sent: z.array(z.string()), sessionId: z.string(), confirmed: z.boolean() }).passthrough(),
});

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};
const btn = (text: string, className = 'quiet', title = ''): HTMLButtonElement => {
  const b = el('button', className, text);
  b.type = 'button';
  if (title) b.title = title;
  return b;
};
const errorOf = (body: unknown, fallback: string): string => {
  const parsed = ErrorAnswer.safeParse(body);
  return parsed.success ? parsed.data.error.replace(/^[A-Z_]+: /, '') : fallback;
};
const highlights = (): { set(name: string, h: unknown): void; delete(name: string): void } | null =>
  typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'
    ? (CSS as unknown as { highlights: { set(name: string, h: unknown): void; delete(name: string): void } }).highlights
    : null;

/** Where a text offset falls in a list of text nodes laid out one per line, `\n` between them. */
function point(nodes: readonly Text[], offset: number): [Text, number] | null {
  let at = 0;
  for (const node of nodes) {
    const length = node.data.length;
    if (offset <= at + length) return [node, offset - at];
    at += length + 1;
  }
  return null;
}
function rangeOf(nodes: readonly Text[], at: Located): Range | null {
  const start = point(nodes, at.start);
  const end = point(nodes, at.end);
  if (!start || !end) return null;
  const range = new Range();
  range.setStart(...start);
  range.setEnd(...end);
  return range;
}

export class ReviewView {
  private objectId: string | null = null;
  private mode: ReviewMode | null = null;
  private notes = new Map<string, ReviewNote>();
  private selection: { start: number; end: number } | null = null;
  private composer: Composer | null = null;
  private sessions: { id: string; name: string; state: string }[] | null = null;
  private picked = '';
  private status = '';
  private sending = false;
  private notesOpen = false;
  private reading = false;
  private readAgain = false;
  private lines: Text[] = [];
  private root = el('div', 'review');
  private signature = '';
  private draft = { body: '', replacement: '' };

  constructor(
    private options: {
      url: (path: string) => string;
      workspace: string;
      objects: () => ViewObject[];
      comments: () => ViewComment[];
      phone: () => boolean;
      /** Edits the text through the ordinary update command; false when the editor refused (offline, phone, locked). */
      apply: (object: ViewObject, text: string) => boolean;
      openThread: (objectId: string, commentId: string) => void;
      /** The review opened, closed or changed place: the rail width and the reader follow. */
      changed: () => void;
    }
  ) {
    this.root.setAttribute('data-i18n-skip', '');
    this.root.tabIndex = -1;
    document.addEventListener('selectionchange', () => this.readSelection());
    this.root.addEventListener('keydown', (e) => this.key(e));
    // A press on an action keeps the words selected.
    this.root.addEventListener('mousedown', (e) => {
      if (e.target instanceof Element && e.target.closest('.review-act')) e.preventDefault();
    });
    void this.read();
  }

  /** The object under review and where, or null. */
  current(): { objectId: string; mode: ReviewMode } | null {
    return this.objectId && this.mode ? { objectId: this.objectId, mode: this.mode } : null;
  }

  open(objectId: string, mode: ReviewMode): void {
    const object = this.options.objects().find((o) => o.id === objectId);
    if (!object || object.type !== 'text') return;
    if (this.objectId !== objectId) {
      this.composer = null;
      this.selection = null;
      this.status = '';
      this.picked = '';
      this.notesOpen = false;
    }
    this.objectId = objectId;
    this.mode = mode;
    this.signature = '';
    const host = mode === 'rail' ? node('reviewRail') : node('reviewFullBody');
    host.replaceChildren(this.root);
    node('reviewRail').hidden = mode !== 'rail';
    node('reviewFull').hidden = mode !== 'full';
    this.root.classList.toggle('full', mode === 'full');
    this.root.classList.toggle('phone', this.options.phone());
    void this.loadSessions();
    void this.read();
    this.paint();
    this.options.changed();
    if (mode === 'full') requestAnimationFrame(() => node('reviewClose').focus({ preventScroll: true }));
  }

  close(): void {
    if (!this.mode) return;
    const wasFull = this.mode === 'full';
    this.objectId = null;
    this.mode = null;
    this.composer = null;
    this.root.remove();
    node('reviewRail').hidden = true;
    node('reviewFull').hidden = true;
    this.paintHighlights();
    this.options.changed();
    if (wasFull) document.getElementById('board')?.focus({ preventScroll: true });
  }

  /** Comments or objects changed: repaint what depends on them, keeping the composer and the selection. */
  changed(): void {
    if (this.objectId && !this.options.objects().some((o) => o.id === this.objectId && o.type === 'text')) this.close();
    else this.paint();
  }

  /** `canvas:changed` as the stream delivered it: a note's metadata may have changed. */
  serverChanged(data: string): void {
    try {
      const parsed = z
        .object({ reviewNotes: z.literal(true) })
        .passthrough()
        .safeParse(JSON.parse(data));
      if (parsed.success) void this.read();
    } catch {
      /* Not an event this page can read. */
    }
  }

  /** Comment ids that are review notes, so a thread can tell them apart. */
  isNote(commentId: string): boolean {
    return this.notes.has(commentId);
  }

  /** Highlights the located words of open notes on every text object on the board. */
  paintBoard(elements: ReadonlyMap<string, HTMLElement>): void {
    this.boardElements = elements;
    this.paintHighlights();
  }
  private boardElements: ReadonlyMap<string, HTMLElement> = new Map();

  private async read(): Promise<void> {
    if (this.reading) {
      this.readAgain = true;
      return;
    }
    this.reading = true;
    try {
      const response = await fetch(this.options.url(`/api/canvas/${this.options.workspace}/review-notes`));
      if (response.ok) {
        this.notes = parseNotes(await response.json());
        this.signature = '';
        this.paint();
      }
    } catch {
      /* Offline: the notes already shown stay. */
    } finally {
      this.reading = false;
      if (this.readAgain) {
        this.readAgain = false;
        void this.read();
      }
    }
  }

  private async loadSessions(): Promise<void> {
    try {
      const response = await fetch(this.options.url(`/api/canvas/${this.options.workspace}/sessions`));
      const parsed = SessionsAnswer.safeParse(await response.json());
      this.sessions = parsed.success ? parsed.data.data.sessions.filter((s) => s.state !== 'done') : [];
    } catch {
      this.sessions = [];
    }
    this.signature = '';
    this.paint();
  }

  private object(): ViewObject | undefined {
    return this.options.objects().find((o) => o.id === this.objectId);
  }
  private text(object: ViewObject | undefined): string {
    return object && typeof object.content.text === 'string' ? object.content.text : '';
  }
  private viewNotes(object: ViewObject | undefined): ViewNote[] {
    return object ? notesOf(this.text(object), object.id, this.options.comments(), this.notes) : [];
  }

  /** The writer while it runs; otherwise the session the person picked, or none yet. */
  private recipient(object: ViewObject): { writer: string | null; live: boolean; target: string | null } {
    const writer = object.author.kind === 'agent' ? object.author.sessionId : null;
    const live = !!writer && !!this.sessions?.some((s) => s.id === writer);
    return { writer, live, target: live ? writer : this.picked || null };
  }

  private readSelection(): void {
    if (!this.mode) return;
    const selection = document.getSelection();
    const doc = this.root.querySelector('.review-doc');
    if (!selection || !doc || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!doc.contains(range.startContainer) || !doc.contains(range.endContainer)) return;
    const offset = (container: Node, local: number): number | null => {
      const index = container instanceof Text ? this.lines.indexOf(container) : -1;
      if (index === -1) return null;
      let at = 0;
      for (let i = 0; i < index; i++) at += this.lines[i]!.data.length + 1;
      return at + local;
    };
    const start = offset(range.startContainer, range.startOffset);
    const end = offset(range.endContainer, range.endOffset);
    const next = start !== null && end !== null && end > start ? { start, end } : null;
    if (JSON.stringify(next) === JSON.stringify(this.selection)) return;
    this.selection = next;
    this.paintActions();
  }

  private key(e: KeyboardEvent): void {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (this.composer) {
        this.composer = null;
        this.paint();
      } else if (this.notesOpen) {
        this.notesOpen = false;
        this.paint();
      } else if (this.mode === 'full') this.close();
      return;
    }
    const typing = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
    if (typing || e.metaKey || e.ctrlKey || e.altKey || e.repeat) {
      if (typing && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void this.post(false);
      }
      e.stopPropagation();
      return;
    }
    if (e.key.toLowerCase() === 'f' && this.mode === 'rail' && this.objectId && !this.options.phone()) {
      e.preventDefault();
      e.stopPropagation();
      this.open(this.objectId, 'full');
      return;
    }
    const kind = ({ c: 'comment', r: 'replace', d: 'delete', a: 'answer' } as const)[e.key.toLowerCase()];
    if (kind && this.startFromSelection(kind)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  private startFromSelection(kind: ReviewKind): boolean {
    const text = this.text(this.object());
    if (!this.selection) return false;
    const anchor =
      kind === 'answer'
        ? answerAnchor(text, this.selection.start, this.selection.end)
        : anchorFromOffsets(text, this.selection.start, this.selection.end);
    if (!anchor) return false;
    this.start(kind, anchor);
    return true;
  }

  private start(kind: ReviewKind, anchor: ReviewAnchor | null): void {
    this.composer = { kind, anchor, commentId: uuid(), requestId: uuid(), step: 'idle', failed: null };
    this.draft = { body: '', replacement: kind === 'replace' && anchor ? anchor.quote : '' };
    this.notesOpen = this.options.phone();
    this.paint();
    requestAnimationFrame(() =>
      this.root
        .querySelector<HTMLElement>(kind === 'replace' ? '.review-replacement' : '.review-body')
        ?.focus({ preventScroll: false })
    );
  }

  private async call(path: string, method: string, body: unknown): Promise<{ status: number | null; body: unknown }> {
    try {
      const response = await fetch(this.options.url(`/api/canvas/${this.options.workspace}${path}`), {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    } catch {
      return { status: null, body: null };
    }
  }

  /** Post: the comment, then its note. Post & send: then the send of that note alone. Each step is safe to repeat. */
  private async post(send: boolean): Promise<void> {
    const composer = this.composer;
    const object = this.object();
    if (!composer || !object || composer.step === 'busy') return;
    const { kind, anchor } = composer;
    if (!postable(kind, this.draft.body)) {
      composer.failed = 'Write the note first.';
      this.paint();
      return;
    }
    composer.step = 'busy';
    composer.failed = null;
    this.paint();
    const commented = await this.call('/command', 'POST', {
      tool: 'canvas_comment',
      requestId: composer.requestId,
      arguments: {
        objectId: object.id,
        text: commentText(kind, anchor, this.draft.body, this.draft.replacement),
        commentId: composer.commentId,
      },
    });
    // A repeat of a comment the server already took answers 200 again; a 409 here means it holds this id already.
    if (commented.status === null || (commented.status >= 400 && commented.status !== 409)) {
      composer.step = 'idle';
      composer.failed =
        commented.status === null
          ? 'Not posted: no connection. Your note is kept here.'
          : `Not posted: ${errorOf(commented.body, 'the canvas refused it')}.`;
      this.paint();
      return;
    }
    const note =
      kind === 'general'
        ? { kind }
        : kind === 'replace'
          ? { kind, anchor, replacement: this.draft.replacement }
          : { kind, anchor };
    const described = await this.call(`/review-notes/${composer.commentId}`, 'PUT', { note });
    if (described.status !== 200) {
      composer.step = 'idle';
      composer.failed = `The comment is posted, but not yet as a ${KIND_LABEL[kind].toLowerCase()} note. Retry finishes it.`;
      this.paint();
      return;
    }
    const id = composer.commentId;
    this.composer = null;
    this.selection = null;
    document.getSelection()?.removeAllRanges();
    await this.read();
    if (send) await this.send([id]);
    else this.paint();
  }

  private async send(ids: string[]): Promise<void> {
    const object = this.object();
    if (!object || this.sending || !ids.length) return;
    const { target, live } = this.recipient(object);
    if (!target) {
      this.status = 'Pick a session to send to first. The session that wrote this has ended.';
      this.paint();
      return;
    }
    this.sending = true;
    this.status = ids.length === 1 ? 'Sending the note…' : `Sending ${ids.length} notes in one prompt…`;
    this.paint();
    const answer = await this.call(`/review/${object.id}/send`, 'POST', {
      commentIds: ids,
      ...(live ? {} : { sessionId: target }),
    });
    this.sending = false;
    const sent = SentAnswer.safeParse(answer.body);
    if (answer.status === 200 && sent.success) {
      const n = sent.data.data.sent.length;
      this.status = `${n === 1 ? 'Sent one note' : `Sent ${n} notes`} to ${this.sessionName(sent.data.data.sessionId)}.${
        sent.data.data.confirmed ? '' : ' The session has not confirmed it yet.'
      }`;
    } else {
      this.status =
        answer.status === null
          ? 'Not sent: no connection. Nothing was sent.'
          : `Not sent: ${errorOf(answer.body, 'the server refused it')}. Nothing was sent.`;
      if (answer.status === 409 && /ended|pick/i.test(errorOf(answer.body, ''))) void this.loadSessions();
    }
    await this.read();
    this.paint();
  }

  private sessionName(id: string): string {
    const row = this.sessions?.find((s) => s.id === id);
    return row?.name || `Agent ${id.slice(0, 8)}`;
  }

  private async resolve(note: ViewNote, resolved: boolean): Promise<void> {
    const body =
      note.note.kind === 'general'
        ? { kind: 'general' }
        : note.note.kind === 'replace'
          ? { kind: 'replace', anchor: note.note.anchor, replacement: note.note.replacement }
          : { kind: note.note.kind, anchor: note.note.anchor };
    const answer = await this.call(`/review-notes/${note.comment.id}`, 'PUT', { note: body, resolved });
    if (answer.status !== 200) this.status = `Not changed: ${errorOf(answer.body, 'no connection')}.`;
    await this.read();
  }

  private apply(note: ViewNote): void {
    const object = this.object();
    if (!object || !note.at) return;
    const next = applied(this.text(object), note.note, note.at);
    if (next === null) return;
    this.status = this.options.apply(object, next)
      ? `${KIND_LABEL[note.note.kind]} applied. Undo puts it back.`
      : 'Not applied: the text cannot be edited here right now.';
    this.paint();
  }

  /** Rebuilds the document and the notes when what they show changed; the composer is kept as it is. */
  paint(): void {
    if (!this.mode) {
      this.paintHighlights();
      return;
    }
    const object = this.object();
    if (!object) return this.close();
    const notes = this.viewNotes(object);
    const signature = JSON.stringify([
      this.text(object),
      notes.map((n) => [n.comment.id, n.comment.text, n.state, n.at]),
      this.composer && [this.composer.kind, this.composer.commentId, this.composer.step, this.composer.failed],
      this.status,
      this.sending,
      this.notesOpen,
      this.sessions,
      this.picked,
      this.mode,
      this.options.phone(),
    ]);
    if (signature !== this.signature) {
      const focused = document.activeElement instanceof HTMLElement && this.root.contains(document.activeElement);
      const focusKey = focused ? (document.activeElement as HTMLElement).dataset.reviewKey : undefined;
      this.signature = signature;
      this.build(object, notes);
      // A control that is gone after the rebuild (Apply, once applied) hands focus to the review itself, so its keys
      // and Escape still reach it.
      if (focused)
        ((focusKey && this.root.querySelector<HTMLElement>(`[data-review-key="${focusKey}"]`)) || this.root).focus({
          preventScroll: true,
        });
    }
    this.paintActions();
    this.paintHighlights();
  }

  private build(object: ViewObject, notes: ViewNote[]): void {
    const text = this.text(object);
    const phone = this.options.phone();
    const full = this.mode === 'full';
    this.root.classList.toggle('phone', phone);
    node('reviewFullTitle').textContent = label(object);
    const open = notes.filter((n) => n.state !== 'resolved');
    const head = el('div', 'review-head');
    const title = el(
      'p',
      'review-count',
      `${open.length ? `${open.length} open` : 'No open'} ${open.length === 1 ? 'note' : 'notes'}`
    );
    head.append(title);
    if (!full) {
      const fullButton = btn('Full screen', 'quiet', 'Document in the centre, notes on the right · F');
      fullButton.dataset.reviewKey = 'full';
      fullButton.onclick = () => this.open(object.id, 'full');
      const done = btn('Done', 'quiet', 'Back to the reader');
      done.dataset.reviewKey = 'done';
      done.onclick = () => this.close();
      head.append(fullButton, done);
    }
    const general = btn('General note', 'quiet review-act', 'A note about the whole text');
    general.dataset.reviewKey = 'general';
    general.onclick = () => this.start('general', null);
    head.append(general);

    const doc = el('div', 'review-doc');
    doc.setAttribute('aria-label', 'Text under review. Select words, then choose Comment, Replace or Delete.');
    this.lines = [];
    const byLine = new Map<number, ViewNote[]>();
    for (const n of notes) {
      if (!n.at) continue;
      const line = lineOf(text, n.at.end);
      byLine.set(line, [...(byLine.get(line) ?? []), n]);
    }
    const composerAt = this.composer?.anchor ? locate(text, this.composer.anchor) : null;
    const composerLine = composerAt ? lineOf(text, composerAt.end) : -1;
    let offset = 0;
    text.split('\n').forEach((line, index) => {
      const p = el('p', line.trim() ? 'review-line' : 'review-line blank');
      const node = document.createTextNode(line);
      this.lines.push(node);
      p.append(node);
      doc.append(p);
      if (/^\s*\d+[.)]\s+\S.*\?\s*$/.test(line) && !phone) {
        const answer = btn('Answer', 'quiet review-act review-answer', 'Answer this question');
        answer.dataset.reviewKey = `answer-${index}`;
        const start = offset;
        answer.onclick = () => {
          const anchor = answerAnchor(text, start, start + line.length);
          if (anchor) this.start('answer', anchor);
        };
        doc.append(answer);
      }
      if (!full && !phone) {
        const under = byLine.get(index);
        if (under?.length) doc.append(this.list(under));
        if (composerLine === index) doc.append(this.composerForm());
      }
      offset += line.length + 1;
    });

    const side = el('div', 'review-notes');
    side.setAttribute('aria-label', 'Notes');
    const elsewhere = full || phone ? notes : notes.filter((n) => !n.at);
    if (elsewhere.length) side.append(this.list(elsewhere));
    if (this.composer && (full || phone || composerLine === -1)) side.prepend(this.composerForm());
    if (!notes.length && !this.composer)
      side.append(el('p', 'secondary review-empty', 'No notes yet. Select words to leave one.'));

    const bar = this.bar(object, notes);
    if (phone) {
      const toggle = btn(`Notes · ${notes.length}`, 'quiet', 'Show the notes');
      toggle.dataset.reviewKey = 'notes';
      toggle.setAttribute('aria-expanded', String(this.notesOpen));
      toggle.onclick = () => {
        this.notesOpen = !this.notesOpen;
        this.paint();
      };
      bar.prepend(toggle);
      side.classList.add('review-sheet');
      side.hidden = !this.notesOpen;
      const sheetHead = el('div', 'review-sheet-head');
      const closeSheet = btn('Close', 'quiet', 'Back to the text');
      closeSheet.dataset.reviewKey = 'close-notes';
      closeSheet.onclick = () => {
        this.notesOpen = false;
        this.composer = null;
        this.paint();
      };
      sheetHead.append(el('span', 'review-kind', 'Notes'), closeSheet);
      side.prepend(sheetHead);
    }
    const body = el('div', 'review-body-wrap');
    body.append(doc, side);
    this.root.replaceChildren(head, body, bar);
  }

  private list(notes: ViewNote[]): HTMLOListElement {
    const list = el('ol', 'review-list');
    for (const n of notes) list.append(this.card(n));
    return list;
  }

  private card(n: ViewNote): HTMLLIElement {
    const li = el('li', 'review-note');
    li.dataset.kind = n.note.kind;
    li.dataset.state = n.state;
    li.dataset.noteId = n.comment.id;
    const top = el('p', 'review-note-head');
    top.append(el('span', 'review-kind', KIND_LABEL[n.note.kind]), el('span', 'review-state', STATE_LABEL[n.state]));
    if (n.changed) top.append(el('span', 'review-changed', 'text changed'));
    li.append(top);
    if (n.note.kind !== 'general') li.append(el('blockquote', 'review-quote', n.note.anchor.quote));
    li.append(el('p', 'review-text', n.comment.text));
    const actions = el('div', 'review-note-actions');
    const key = (b: HTMLButtonElement, name: string): HTMLButtonElement => {
      b.dataset.reviewKey = `${name}-${n.comment.id}`;
      return b;
    };
    if (n.state === 'unsent') {
      const send = key(btn('Send', 'quiet'), 'send');
      send.disabled = this.sending;
      send.onclick = () => void this.send([n.comment.id]);
      actions.append(send);
    }
    const done = alreadyApplied(this.text(this.object()), n.note);
    if (done) actions.append(el('span', 'review-applied', 'Applied'));
    if (
      (n.note.kind === 'replace' || n.note.kind === 'delete') &&
      n.at &&
      !done &&
      n.state !== 'resolved' &&
      !this.options.phone()
    ) {
      const apply = key(btn('Apply', 'quiet', 'Make this edit to the text; undo puts it back'), 'apply');
      apply.onclick = () => this.apply(n);
      actions.append(apply);
    }
    const resolve = key(btn(n.state === 'resolved' ? 'Reopen' : 'Resolve', 'quiet'), 'resolve');
    resolve.onclick = () => void this.resolve(n, n.state !== 'resolved');
    const thread = key(btn('Thread', 'quiet', 'Open this note in the comment thread'), 'thread');
    thread.onclick = () => {
      if (this.mode === 'full') this.close();
      this.options.openThread(n.comment.objectId, n.comment.id);
    };
    actions.append(resolve, thread);
    li.append(actions);
    return li;
  }

  private composerForm(): HTMLFormElement {
    const composer = this.composer!;
    const form = el('form', 'review-composer');
    form.dataset.kind = composer.kind;
    const heading = el('p', 'review-composer-head');
    heading.append(el('span', 'review-kind', KIND_LABEL[composer.kind]));
    form.append(heading);
    if (composer.anchor) form.append(el('blockquote', 'review-quote', composer.anchor.quote));
    if (composer.kind === 'replace') {
      const label = el('label', 'review-field', 'Replace with');
      const input = el('textarea', 'review-replacement');
      input.rows = 2;
      input.value = this.draft.replacement;
      input.dataset.reviewKey = 'replacement';
      input.oninput = () => (this.draft.replacement = input.value);
      label.append(input);
      form.append(label);
    }
    const bodyLabel = el(
      'label',
      'review-field',
      composer.kind === 'answer'
        ? 'Your answer'
        : composer.kind === 'replace' || composer.kind === 'delete'
          ? 'Note (optional)'
          : 'Note'
    );
    const body = el('textarea', 'review-body');
    body.rows = 3;
    body.value = this.draft.body;
    body.dataset.reviewKey = 'body';
    body.oninput = () => (this.draft.body = body.value);
    bodyLabel.append(body);
    form.append(bodyLabel);
    if (composer.failed) {
      const failed = el('p', 'review-failed', composer.failed);
      failed.setAttribute('role', 'status');
      form.append(failed);
    }
    const row = el('div', 'composer-row');
    const cancel = btn('Cancel', 'quiet');
    cancel.dataset.reviewKey = 'cancel';
    cancel.onclick = () => {
      this.composer = null;
      this.paint();
    };
    const post = btn(composer.failed ? 'Retry' : 'Post', 'quiet', 'Save the note on the canvas · Cmd/Ctrl+Enter');
    post.dataset.reviewKey = 'post';
    post.onclick = () => void this.post(false);
    const postSend = btn('Post & send', 'primary', 'Save the note and deliver it to the agent');
    postSend.dataset.reviewKey = 'post-send';
    postSend.onclick = () => void this.post(true);
    post.disabled = postSend.disabled = composer.step === 'busy';
    row.append(cancel, post, postSend);
    form.append(row);
    form.onsubmit = (e) => {
      e.preventDefault();
      void this.post(false);
    };
    return form;
  }

  private bar(object: ViewObject, notes: ViewNote[]): HTMLElement {
    const bar = el('div', 'review-bar');
    const acts = el('div', 'review-acts');
    for (const [kind, key] of [
      ['comment', 'C'],
      ['replace', 'R'],
      ['delete', 'D'],
      ['answer', 'A'],
    ] as const) {
      const b = btn(
        KIND_LABEL[kind],
        `quiet review-act review-${kind}-act`,
        `${KIND_LABEL[kind]} on the selected words · ${key}`
      );
      b.dataset.act = kind;
      b.onclick = () => {
        if (!this.startFromSelection(kind))
          this.flash(kind === 'answer' ? 'Select words in a numbered question to answer it.' : 'Select words first.');
      };
      acts.append(b);
    }
    bar.append(acts);
    const { writer, live, target } = this.recipient(object);
    const to = el('div', 'review-to');
    if (live || this.sessions === null)
      to.append(el('span', 'secondary', writer ? `To ${this.sessionName(writer)}` : ''));
    else {
      const select = el('select');
      select.setAttribute('aria-label', 'Send to');
      select.dataset.reviewKey = 'to';
      select.append(new Option(this.sessions.length ? 'Send to…' : 'No running session', ''));
      for (const s of this.sessions)
        select.append(new Option(s.name || s.id.slice(0, 8), s.id, false, s.id === this.picked));
      select.onchange = () => {
        this.picked = select.value;
        this.paint();
      };
      to.append(
        el('span', 'secondary', writer ? 'The session that wrote this has ended.' : 'Written by a person.'),
        select
      );
    }
    bar.append(to);
    const unsent = unsentIds(notes);
    const send = btn(
      unsent.length ? `Send ${unsent.length}` : 'Send',
      'primary',
      'Deliver every note not sent yet, in one prompt'
    );
    send.dataset.reviewKey = 'send-all';
    send.disabled = !unsent.length || this.sending || !target;
    send.onclick = () => void this.send(unsent);
    bar.append(send);
    const status = el('p', 'review-status secondary', this.status);
    status.setAttribute('role', 'status');
    bar.append(status);
    return bar;
  }

  private flash(message: string): void {
    this.status = message;
    this.paint();
  }

  /** Enables the action buttons for the current selection; Answer only inside a numbered question. */
  private paintActions(): void {
    const text = this.text(this.object());
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-act]')) {
      const sel = this.selection;
      const ok =
        !!sel &&
        (b.dataset.act === 'answer'
          ? answerAnchor(text, sel.start, sel.end) !== null
          : anchorFromOffsets(text, sel.start, sel.end) !== null);
      b.setAttribute('aria-disabled', String(!ok));
      if (b.dataset.act === 'answer') b.hidden = !ok;
    }
  }

  /** One pair of highlights for the whole page: the review document and every text object on the board. */
  private paintHighlights(): void {
    const registry = highlights();
    if (!registry) return;
    const unsent: Range[] = [];
    const sent: Range[] = [];
    const add = (nodes: readonly Text[], n: ViewNote): void => {
      if (!n.at || n.state === 'resolved') return;
      const range = rangeOf(nodes, n.at);
      if (range) (n.state === 'unsent' ? unsent : sent).push(range);
    };
    const objects = this.options.objects();
    for (const [id, element] of this.boardElements) {
      const object = objects.find((o) => o.id === id);
      if (!object || object.type !== 'text') continue;
      const textNode = element.querySelector('.object-body')?.firstChild;
      if (!(textNode instanceof Text) || textNode.data !== this.text(object)) continue;
      for (const n of this.viewNotes(object)) add([textNode], n);
    }
    if (this.mode) for (const n of this.viewNotes(this.object())) add(this.lines, n);
    const H = (globalThis as unknown as { Highlight: new (...ranges: Range[]) => unknown }).Highlight;
    registry.set('review-unsent', new H(...unsent));
    registry.set('review-sent', new H(...sent));
  }
}

function node(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing review element: ${id}`);
  return found;
}
