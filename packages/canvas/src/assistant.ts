import { chips, type Chip } from './context.js';
import type { ViewCommand, ViewState } from './commands.js';
import type { ViewObject } from './model.js';
import type { ConversationMessage } from '../../../src/canvas/conversation-schema.js';
import { canvasStorageKeys, type CanvasStorageKeys } from './storage-keys.js';
import {
  buildThread,
  errorMessage,
  sendFailure,
  threadStatus,
  type SentMessage,
  type TranscriptRow,
} from './conversation.js';
import { nextAttempt, parseAttempt, type Attempt } from './outbox.js';
import { promptRefusal } from '../../../src/canvas/conversation-schema.js';

type Summary = { id: string; sessionId: string; createdAt: number; session: 'live' | 'ended' };
type Approval = {
  id: string;
  sessionId: string;
  kind: string;
  message?: string;
  toolSummary?: string;
  toolName?: string;
  answerInTerminal?: boolean;
  options?: { n: number; label: string }[];
};
type Options = {
  url: (path: string) => string;
  /** Applies a view command (conversation binding, clearing sent context). */
  dispatch: (action: ViewCommand) => void;
  workspace: string;
  viewer: string;
  objects: () => ViewObject[];
  view: () => ViewState;
  remove: (id: string) => void;
  choose: (id: string) => void;
};
const node = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing canvas element: ${id}`);
  return el;
};
const MAX_DRAFT_BYTES = 64 * 1024;
export const draftBytes = (text: string): number => new TextEncoder().encode(text).byteLength;
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null || value === '') localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* Storage that cannot be written keeps nothing; the rail still works for this load. */
  }
}
/** Context ids stored by this viewer for this workspace; anything that is not a list of strings reads as none. */
export function parseStoredContext(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string').slice(0, 200) : [];
  } catch {
    return [];
  }
}
const NEAR_END_PX = 24;
const TRANSCRIPT_DEBOUNCE_MS = 400;
/** What the rail shows of a conversation: the session's own transcript, the chips each prompt carried, and one calm state line. */
export class AssistantView {
  private keys: CanvasStorageKeys;
  private signature = '';
  private storedContext = '';
  private restoring = true;
  private refocus: number | null = null;
  private restored: string[];
  readonly draft = node('assistantDraft') as HTMLTextAreaElement;
  private conversations: Summary[] = [];
  private messages: ConversationMessage[] = [];
  private rows: TranscriptRow[] = [];
  private sent: SentMessage[] = [];
  private approval: Approval | null = null;
  private working = false;
  private sending = false;
  private attempt: Attempt | null;
  private loaded: string | null = null;
  private transcriptTimer: ReturnType<typeof setTimeout> | undefined;
  private threadSignature = '';
  private stopped = false;
  constructor(private options: Options) {
    this.keys = canvasStorageKeys(options.viewer, options.workspace);
    this.draft.value = read(this.keys.assistantDraft) ?? '';
    // Read once, before the first paint can overwrite the stored list with the empty starting state.
    this.restored = parseStoredContext(read(this.keys.assistantContext));
    this.attempt = parseAttempt(read(this.keys.assistantOutbox));
    this.draft.addEventListener('input', () => {
      write(this.keys.assistantDraft, this.draft.value);
      this.say('');
    });
    this.draft.addEventListener('keydown', (e) => {
      // Enter sends; Shift+Enter is a line break. A key that ends an IME composition or repeats never sends.
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229 || e.repeat) return;
      e.preventDefault();
      void this.submit();
    });
    node('assistantForm').addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submit();
    });
    node('assistantRetry').addEventListener('click', () => void this.submit());
    const fresh = (): void => {
      this.options.dispatch({ kind: 'conversation', id: null });
      this.say('The next message starts a new conversation.');
      this.threadSignature = '';
      this.paintPicker();
      this.paintThread();
      this.draft.focus({ preventScroll: true });
    };
    node('newConversation').addEventListener('click', fresh);
    node('endedNew').addEventListener('click', fresh);
    (node('conversationPicker') as HTMLSelectElement).addEventListener('change', (e) => {
      const id = (e.target as HTMLSelectElement).value;
      this.options.dispatch({ kind: 'conversation', id: id || null });
      void this.open();
    });
    void this.refreshList();
  }
  restoredContext(): string[] {
    return this.restored;
  }
  draftBytes(): number {
    return Math.min(draftBytes(this.draft.value), MAX_DRAFT_BYTES * 4);
  }
  focusComposer(): void {
    this.draft.focus({ preventScroll: true });
  }
  /** The stored list has been handed back to the view; from here the view is what gets stored. */
  restoreDone(): void {
    this.restoring = false;
  }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.transcriptTimer);
  }
  private say(text: string, state: 'failed' | 'sending' | '' = ''): void {
    const status = node('assistantStatus');
    status.textContent = text;
    status.dataset.state = state;
    node('assistantRetry').hidden = state !== 'failed';
  }
  private get current(): Summary | undefined {
    const id = this.options.view().conversationId;
    return this.conversations.find((c) => c.id === id);
  }
  private json = async (path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> => {
    const response = await fetch(this.options.url(path), init);
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      /* A body that is not JSON is reported by its status alone. */
    }
    return { status: response.status, body };
  };
  private data(body: unknown): Record<string, unknown> {
    return typeof body === 'object' && body !== null && 'data' in body && typeof body.data === 'object' && body.data
      ? (body.data as Record<string, unknown>)
      : {};
  }
  /** The conversations of this canvas; the view keeps the one it was on, else the newest. */
  async refreshList(): Promise<void> {
    try {
      const { body } = await this.json(`/api/canvas/${this.options.workspace}/conversations`);
      const list = this.data(body).conversations;
      this.conversations = Array.isArray(list) ? (list as Summary[]) : [];
    } catch {
      return;
    }
    const bound = this.options.view().conversationId;
    if (!this.conversations.some((c) => c.id === bound) && bound === null && !this.attempt?.conversationId) {
      const newest = [...this.conversations].sort((a, b) => b.createdAt - a.createdAt)[0];
      if (newest && !this.sending) this.options.dispatch({ kind: 'conversation', id: newest.id });
    }
    this.paintPicker();
    await this.open();
  }
  /** Loads the bound conversation's record, transcript and pending question; the view never moves for it. */
  async open(): Promise<void> {
    const conversation = this.current;
    if (!conversation) {
      this.messages = [];
      this.rows = [];
      this.approval = null;
      this.loaded = null;
      this.paintThread();
      return;
    }
    if (this.loaded !== conversation.id) {
      this.loaded = conversation.id;
      this.rows = [];
      this.messages = [];
      this.working = false;
      this.threadSignature = '';
    }
    await Promise.all([
      this.loadRecord(conversation),
      this.loadTranscript(conversation),
      this.loadApproval(conversation),
    ]);
    this.paintThread();
  }
  private async loadRecord(c: Summary): Promise<void> {
    try {
      const { body } = await this.json(`/api/canvas/${this.options.workspace}/conversations/${c.id}`);
      const conversation = this.data(body).conversation as
        | { messages?: ConversationMessage[]; session?: string }
        | undefined;
      if (this.current?.id !== c.id || !conversation) return;
      this.messages = conversation.messages ?? [];
      if (conversation.session) c.session = conversation.session as Summary['session'];
    } catch {
      /* The thread still shows the transcript without its chips. */
    }
  }
  private async loadTranscript(c: Summary): Promise<void> {
    try {
      const { body } = await this.json(`/api/sessions/${encodeURIComponent(c.sessionId)}/last-response?context=full`);
      const data = this.data(body);
      const messages = data.messages;
      if (this.current?.id !== c.id || !Array.isArray(messages)) return;
      this.rows = messages
        .filter((m): m is { role: 'user' | 'assistant'; text: string; queued?: boolean } => typeof m?.text === 'string')
        .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', text: m.text, queued: m.queued }));
    } catch {
      /* A failed read keeps the thread as it was. */
    }
  }
  private async loadApproval(c: Summary): Promise<void> {
    try {
      const { body } = await this.json('/api/approvals');
      const list = this.data(body).approvals;
      if (this.current?.id !== c.id) return;
      this.approval =
        (Array.isArray(list) ? (list as Approval[]) : []).find(
          (a) => a.sessionId === c.sessionId && a.kind !== 'idle'
        ) ?? null;
    } catch {
      /* The send route refuses while a question is pending, so a missed card is never a wrong answer. */
    }
  }
  /** One server event. Only this conversation's session or this canvas's conversations matter; nothing here moves the camera, selection or focus. */
  event(name: string, raw: string): void {
    if (this.stopped) return;
    let data: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) data = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (name === 'canvas:conversation') {
      if (data.workspaceId === this.options.workspace) void this.refreshList();
      return;
    }
    const conversation = this.current;
    if (!conversation) return;
    const session = (data.session as { id?: unknown } | undefined)?.id;
    const id = data.id ?? data.sessionId ?? session;
    if (id !== conversation.sessionId) return;
    switch (name) {
      case 'session:working':
        this.working = true;
        break;
      case 'session:idle':
      case 'hook:stop':
        this.working = false;
        break;
      case 'session:exit':
      case 'session:deleted':
      case 'session:error':
        this.working = false;
        conversation.session = 'ended';
        break;
    }
    clearTimeout(this.transcriptTimer);
    this.transcriptTimer = setTimeout(() => void this.open(), TRANSCRIPT_DEBOUNCE_MS);
    this.paintThread();
  }
  private async submit(): Promise<void> {
    if (this.sending) return;
    const text = this.draft.value;
    const refusal = promptRefusal(text);
    if (refusal) return this.say(refusal, 'failed');
    const ids = chips(this.options.objects(), this.options.view().context).map((c) => c.id);
    if (typeof navigator !== 'undefined' && navigator.onLine === false)
      return this.say('You are offline. Your message is kept; retry when the connection is back.', 'failed');
    const attempt = nextAttempt(this.attempt, this.current?.id ?? null, text, ids, () => crypto.randomUUID());
    this.attempt = attempt;
    write(this.keys.assistantOutbox, JSON.stringify(attempt));
    this.sending = true;
    this.draft.readOnly = true;
    node('assistantSend').toggleAttribute('disabled', true);
    this.say('Sending…', 'sending');
    try {
      let conversationId = this.current?.id ?? null;
      if (!conversationId) {
        const made = await this.json(`/api/canvas/${this.options.workspace}/conversations`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: attempt.createRequestId }),
        });
        const conversation = this.data(made.body).conversation as Summary | undefined;
        if (made.status >= 400 || !conversation) throw new SendError(errorMessage(made.body), made.status);
        this.conversations = [...this.conversations.filter((c) => c.id !== conversation.id), conversation];
        conversationId = conversation.id;
        this.attempt = { ...attempt, conversationId };
        write(this.keys.assistantOutbox, JSON.stringify(this.attempt));
        this.options.dispatch({ kind: 'conversation', id: conversationId });
        this.paintPicker();
      }
      const answer = await this.json(`/api/canvas/${this.options.workspace}/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: attempt.messageId, text, refIds: ids }),
      });
      if (answer.status >= 400) throw new SendError(errorMessage(answer.body), answer.status);
      this.sent = [...this.sent, { messageId: attempt.messageId, text, refIds: ids }].slice(-20);
      this.attempt = null;
      write(this.keys.assistantOutbox, null);
      // Only what was sent goes: text typed while it travelled would have made the field read-only, so nothing is lost.
      this.draft.value = '';
      write(this.keys.assistantDraft, null);
      this.options.dispatch({ kind: 'context-clear-sent', ids });
      this.say('');
      void this.open();
    } catch (error) {
      const failure = error instanceof SendError ? sendFailure(error.message, error.status) : sendFailure('', 0);
      if (failure.fresh) {
        this.attempt = null;
        write(this.keys.assistantOutbox, null);
      }
      if (failure.ended) {
        const c = this.current;
        if (c) c.session = 'ended';
        this.paintThread();
      }
      this.say(
        error instanceof SendError ? failure.text : 'Could not reach the server. Your message is kept.',
        'failed'
      );
    } finally {
      this.sending = false;
      this.draft.readOnly = false;
      node('assistantSend').toggleAttribute('disabled', false);
    }
  }
  private paintPicker(): void {
    const picker = node('conversationPicker') as HTMLSelectElement;
    const bound = this.options.view().conversationId ?? '';
    const sorted = [...this.conversations].sort((a, b) => b.createdAt - a.createdAt);
    picker.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'New conversation';
    picker.append(none);
    sorted.forEach((c, index) => {
      const option = document.createElement('option');
      option.value = c.id;
      option.textContent = `Conversation ${sorted.length - index}${c.session === 'ended' ? ' (ended)' : ''}`;
      picker.append(option);
    });
    picker.value = sorted.some((c) => c.id === bound) ? bound : '';
    node('conversationHead').hidden = !sorted.length;
  }
  private paintThread(): void {
    const conversation = this.current;
    const turns = buildThread(this.rows, this.messages, this.sent);
    const status = threadStatus({
      ended: conversation?.session === 'ended',
      waiting: !!this.approval,
      working: this.working,
    });
    const signature = JSON.stringify([turns, status, this.approval, conversation?.id ?? null]);
    if (signature === this.threadSignature) return;
    this.threadSignature = signature;
    const list = node('thread');
    const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight <= NEAR_END_PX;
    list.replaceChildren();
    for (const turn of turns) {
      const item = document.createElement('li');
      item.className = 'turn';
      item.dataset.who = turn.who;
      const who = document.createElement('span');
      who.className = 'turn-who';
      who.textContent = turn.who === 'you' ? (turn.queued ? 'You · queued' : 'You') : 'Claude';
      const text = document.createElement('p');
      text.className = 'turn-text';
      text.textContent = turn.text;
      item.append(who, text);
      if (turn.refs.length) {
        const refs = document.createElement('p');
        refs.className = 'turn-refs';
        refs.textContent = turn.refs.join(' · ');
        refs.setAttribute('aria-label', 'Context sent with this message');
        item.append(refs);
      }
      list.append(item);
    }
    node('assistantEmpty').hidden = turns.length > 0 || !!conversation;
    const line = node('threadState');
    line.textContent = status.text;
    line.dataset.state = status.kind;
    node('threadEnded').hidden = status.kind !== 'ended';
    this.paintApproval();
    if (atEnd) list.scrollTop = list.scrollHeight;
  }
  private paintApproval(): void {
    const card = node('approvalCard');
    const item = this.approval;
    card.hidden = !item;
    card.replaceChildren();
    if (!item) return;
    const text = document.createElement('p');
    text.textContent = item.message || item.toolSummary || item.toolName || 'The agent is asking for permission.';
    card.append(text);
    if (item.answerInTerminal) {
      const note = document.createElement('p');
      note.className = 'secondary';
      note.textContent = 'Answer in the terminal.';
      card.append(note);
      return;
    }
    const row = document.createElement('div');
    row.className = 'approval-actions';
    const answer = async (body: Record<string, unknown>): Promise<void> => {
      row.querySelectorAll('button').forEach((b) => b.toggleAttribute('disabled', true));
      try {
        const { status } = await this.json(`/api/approvals/${encodeURIComponent(item.id)}/answer`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (status >= 400) this.say('That question is no longer on screen.', 'failed');
      } catch {
        this.say('Could not answer. Try again.', 'failed');
      }
      void this.open();
    };
    const add = (label: string, body: Record<string, unknown>): void => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'quiet';
      button.textContent = label;
      button.addEventListener('click', () => void answer(body));
      row.append(button);
    };
    if (item.options?.length) for (const o of item.options) add(o.label, { action: 'option', option: o.n });
    else {
      add('Approve', { action: 'approve' });
      add('Deny', { action: 'deny' });
    }
    card.append(row);
  }

  paint(): void {
    const ids = this.options.view().context;
    const stored = JSON.stringify(ids);
    if (!this.restoring && stored !== this.storedContext) {
      this.storedContext = stored;
      write(this.keys.assistantContext, ids.length ? stored : null);
    }
    const rows = chips(this.options.objects(), ids);
    const signature = JSON.stringify(rows);
    if (signature !== this.signature) {
      this.signature = signature;
      this.paintChips(rows);
    }
    node('contextEmpty').hidden = rows.length > 0;
    node('contextHeading').textContent = rows.length ? `Context · ${rows.length}` : 'Context';
    if (this.refocus !== null) {
      const removers = [...node('contextChips').querySelectorAll<HTMLElement>('.chip-remove')];
      (removers[Math.min(this.refocus, removers.length - 1)] ?? this.draft).focus({ preventScroll: true });
      this.refocus = null;
    }
  }
  private paintChips(rows: Chip[]): void {
    const list = node('contextChips');
    list.replaceChildren();
    rows.forEach((chip, index) => {
      const item = document.createElement('li');
      item.className = 'chip';
      item.dataset.contextId = chip.id;
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'chip-label';
      open.title = `Show ${chip.label} on the canvas`;
      const name = document.createElement('span');
      name.className = 'chip-name';
      name.textContent = chip.label;
      open.append(name);
      if (chip.descendants) {
        const inside = document.createElement('span');
        inside.className = 'chip-count';
        inside.textContent = `${chip.descendants} inside`;
        open.append(inside);
      }
      open.addEventListener('click', () => this.options.choose(chip.id));
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'chip-remove';
      close.setAttribute('aria-label', `Remove ${chip.label} from context`);
      close.title = 'Remove from context';
      close.textContent = '×';
      close.addEventListener('click', () => {
        this.refocus = index;
        this.options.remove(chip.id);
      });
      item.append(open, close);
      list.append(item);
    });
  }
}

class SendError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}
