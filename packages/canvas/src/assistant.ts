import { uuid } from './ids.js';
import { MAX_MODEL_ID_LENGTH } from '../../../src/canvas/providers.js';
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
import { nextAttempt, parseAttempt, parseSent, type Attempt } from './outbox.js';
import { promptRefusal, splitPrompt } from '../../../src/canvas/conversation-schema.js';
import {
  agentLabel,
  modelField,
  modelSuggestions,
  newConversationNotice,
  selection,
  type Choice,
  type ProviderRow,
} from './providers.js';

type Summary = {
  id: string;
  sessionId: string;
  createdAt: number;
  session: 'live' | 'ended';
  cliId: string;
  cliLabel?: string;
  model?: string;
};
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
  /** The phone has no hardware keys: Return is a line break there and Send submits. */
  phone: () => boolean;
  /** The phone's stand-in for Q and Cmd/Ctrl+Enter; false when nothing is selected. */
  addSelection: () => boolean;
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
/** The stored provider and model; anything that is not exactly that reads as no choice. */
export function parseChoice(raw: string | null): Choice | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return null;
    const { cliId, model } = v as Record<string, unknown>;
    if ((cliId !== null && typeof cliId !== 'string') || typeof model !== 'string' || model.length > 100) return null;
    return { cliId: typeof cliId === 'string' && cliId.length <= 64 ? cliId : null, model };
  } catch {
    return null;
  }
}
/** What the rail shows of a conversation: the session's own transcript, the chips each prompt carried, and one calm state line. */
export class AssistantView {
  private keys: CanvasStorageKeys;
  private signature = '';
  private storedContext = '';
  private restoring = true;
  private refocus: number | null = null;
  private restored: string[];
  private restoredChoiceValue: Choice | null;
  private storedChoice = '';
  private choiceSignature = '';
  /** The current choice came from an agent's view command; the person's next change or another conversation clears it. */
  private agentChose = false;
  private providers: ProviderRow[] = [];
  private providersLoaded = false;
  private onFocus = (): void => void this.loadProviders();
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
  /** The thread was at its end when it last changed, so a resize or new row keeps it there. */
  private stick = true;
  constructor(private options: Options) {
    this.keys = canvasStorageKeys(options.viewer, options.workspace);
    this.draft.value = read(this.keys.assistantDraft) ?? '';
    // Read once, before the first paint can overwrite the stored list with the empty starting state.
    this.restored = parseStoredContext(read(this.keys.assistantContext));
    this.restoredChoiceValue = parseChoice(read(this.keys.assistantChoice));
    this.attempt = parseAttempt(read(this.keys.assistantOutbox));
    this.sent = parseSent(read(this.keys.assistantSent));
    this.draft.addEventListener('input', () => {
      write(this.keys.assistantDraft, this.draft.value);
      this.say('');
    });
    this.draft.addEventListener('keydown', (e) => {
      // Enter sends; Shift+Enter is a line break. A key that ends an IME composition or repeats never sends.
      if (this.options.phone()) return;
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229 || e.repeat) return;
      e.preventDefault();
      void this.submit();
    });
    node('assistantForm').addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submit();
    });
    node('assistantRetry').addEventListener('click', () => void this.submit());
    const providerSelect = node('providerSelect') as HTMLSelectElement;
    const modelInput = node('modelInput') as HTMLInputElement;
    providerSelect.addEventListener('change', () => {
      this.agentChose = false;
      // Model ids belong to a provider, so a new provider starts on its own default.
      this.options.dispatch({ kind: 'assistant-choice', choice: { cliId: providerSelect.value || null, model: '' } });
    });
    modelInput.addEventListener('input', () => {
      this.agentChose = false;
      const sel = selection(this.providers, this.options.view().choice);
      this.options.dispatch({
        kind: 'assistant-choice',
        choice: {
          cliId: sel.row?.id ?? this.options.view().choice?.cliId ?? null,
          model: modelInput.value.trim().slice(0, MAX_MODEL_ID_LENGTH),
        },
      });
    });
    node('addSelection').addEventListener('click', () => {
      if (!this.options.addSelection()) this.say('Select an object on the canvas first, then add it here.');
    });
    window.addEventListener('focus', this.onFocus);
    void this.loadProviders();
    const fresh = (): void => {
      this.agentChose = false;
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
      this.agentChose = false;
      this.options.dispatch({ kind: 'conversation', id: id || null });
      // The selectors steer only the NEXT new conversation: opening an old one never carries a pending choice over to it.
      this.options.dispatch({ kind: 'assistant-choice', choice: null });
      void this.open();
    });
    const thread = node('thread');
    thread.addEventListener('scroll', () => {
      this.stick = thread.scrollHeight - thread.scrollTop - thread.clientHeight <= NEAR_END_PX;
    });
    // A composer that grows (a failure line, chips) shrinks the thread under it; at its end it stays at its end.
    if (typeof ResizeObserver !== 'undefined')
      new ResizeObserver(() => {
        if (this.stick) thread.scrollTop = thread.scrollHeight;
      }).observe(thread);
    void this.refreshList();
  }
  restoredContext(): string[] {
    return this.restored;
  }
  restoredChoice(): Choice | null {
    return this.restoredChoiceValue;
  }
  /** An agent's `assistant-choice` command changed the selectors: say so until the person changes them. */
  noteAgentChoice(): void {
    this.agentChose = true;
  }
  focusChoice(which: 'provider' | 'model'): void {
    const model = node('modelInput') as HTMLInputElement;
    ((which === 'model' && !model.disabled ? model : node('providerSelect')) as HTMLElement).focus({
      preventScroll: true,
    });
  }
  /** The providers a conversation can start on, from the server's registry as it is now. */
  private async loadProviders(): Promise<void> {
    try {
      const { status, body } = await this.json('/api/canvas/assistant/providers');
      const list = this.data(body).providers;
      if (status >= 400 || !Array.isArray(list)) return;
      this.providers = list as ProviderRow[];
      this.providersLoaded = true;
      this.choiceSignature = '';
      this.paintChoice();
    } catch {
      /* The selectors keep what they last showed; a send names no CLI and starts the default. */
    }
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
    window.removeEventListener('focus', this.onFocus);
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
    this.pruneSent();
    this.paintThread();
  }
  /** The text this page still holds for messages sent from it: accepted ones, and the one attempt a reload interrupted, so its row keeps Retry. */
  private keptMessages(): SentMessage[] {
    const attempt = this.attempt;
    if (!attempt || this.sent.some((m) => m.messageId === attempt.messageId)) return this.sent;
    return [...this.sent, { messageId: attempt.messageId, text: attempt.text, refIds: attempt.refIds }];
  }
  /** A message the transcript now shows no longer needs the text this page kept for it. */
  private pruneSent(): void {
    if (!this.sent.length) return;
    const shown = new Set(
      this.rows.flatMap((r) => (r.role === 'user' ? [splitPrompt(r.text).messageId?.toLowerCase() ?? ''] : []))
    );
    const kept = this.sent.filter((m) => !shown.has(m.messageId.toLowerCase()));
    if (kept.length !== this.sent.length) {
      this.sent = kept;
      this.persistSent();
    }
  }
  private persistSent(): void {
    write(this.keys.assistantSent, this.sent.length ? JSON.stringify(this.sent) : null);
  }
  private async loadRecord(c: Summary): Promise<void> {
    try {
      const { body } = await this.json(`/api/canvas/${this.options.workspace}/conversations/${c.id}`);
      const conversation = this.data(body).conversation as
        | { messages?: ConversationMessage[]; session?: string; working?: boolean }
        | undefined;
      if (this.current?.id !== c.id || !conversation) return;
      this.messages = conversation.messages ?? [];
      this.working = conversation.working === true;
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
      case 'hook:prompt_submitted':
        this.working = true;
        break;
      case 'session:idle':
      case 'hook:idle_prompt':
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
    const choice = this.options.view().choice;
    const sel = selection(this.providers, choice);
    // A choice that no longer matches the bound conversation starts a new one: the old conversation and its session are left as they are.
    const fresh = newConversationNotice(this.current, choice, sel) !== '';
    const target = fresh ? null : (this.current?.id ?? null);
    // With nothing listed (a probe that found none) the server starts its default exactly as it always did.
    if (target === null && this.providersLoaded && sel.row) {
      if (!sel.row.available)
        return this.say(
          `${sel.row.reason ?? 'That provider cannot start a conversation.'} Pick another provider.`,
          'failed'
        );
      const field = modelField(sel.row, choice?.model ?? '');
      if (field.invalid) return this.say(field.reason, 'failed');
    }
    // A failed attempt against the bound conversation is not carried into the new one the choice now asks for.
    const stored = fresh && this.attempt?.conversationId === (this.current?.id ?? null) ? null : this.attempt;
    const attempt = nextAttempt(stored, target, text, ids, () => uuid());
    this.attempt = attempt;
    write(this.keys.assistantOutbox, JSON.stringify(attempt));
    this.sending = true;
    node('assistantSend').toggleAttribute('disabled', true);
    this.say('Sending…', 'sending');
    try {
      let conversationId = target;
      if (!conversationId) {
        const model = choice?.model ?? '';
        const made = await this.json(`/api/canvas/${this.options.workspace}/conversations`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: attempt.createRequestId,
            ...(this.providersLoaded && sel.row ? { cliId: sel.row.id } : {}),
            ...(model ? { model } : {}),
          }),
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
      this.sent = [
        ...this.sent.filter((m) => m.messageId !== attempt.messageId),
        { messageId: attempt.messageId, text, refIds: ids },
      ].slice(-10);
      this.persistSent();
      this.attempt = null;
      write(this.keys.assistantOutbox, null);
      // Only what was sent goes. The field stays editable while the message travels, so whatever was typed after
      // it is kept as the next draft; a draft edited in the middle is left whole rather than guessed at.
      const now = this.draft.value;
      if (now.startsWith(text)) this.draft.value = now.slice(text.length).replace(/^\s+/, '');
      write(this.keys.assistantDraft, this.draft.value || null);
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
  /** Retry for a message the server accepted but could not deliver: same id, same text, so the server checks the composer first and never pastes twice. */
  private async retryMessage(messageId: string): Promise<void> {
    const kept = this.keptMessages().find((m) => m.messageId === messageId);
    const conversation = this.current;
    if (!kept || !conversation) return;
    try {
      const answer = await this.json(
        `/api/canvas/${this.options.workspace}/conversations/${conversation.id}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messageId, text: kept.text, refIds: kept.refIds }),
        }
      );
      if (answer.status >= 400) {
        const failure = sendFailure(errorMessage(answer.body), answer.status);
        this.say(failure.text, 'failed');
      }
    } catch {
      this.say('Could not reach the server. Try again.', 'failed');
    }
    void this.open();
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
    const turns = buildThread(this.rows, this.messages, this.keptMessages(), agentLabel(conversation));
    const status = threadStatus({
      ended: conversation?.session === 'ended',
      waiting: !!this.approval,
      working: this.working,
    });
    const signature = JSON.stringify([turns, status, this.approval, conversation?.id ?? null]);
    if (signature === this.threadSignature) return;
    this.threadSignature = signature;
    const list = node('thread');
    const atEnd = this.stick;
    list.replaceChildren();
    for (const turn of turns) {
      const item = document.createElement('li');
      item.className = 'turn';
      item.dataset.who = turn.who;
      const who = document.createElement('span');
      who.className = 'turn-who';
      who.textContent = turn.label;
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
      if (
        turn.pending === 'failed' &&
        turn.messageId &&
        this.keptMessages().some((m) => m.messageId === turn.messageId)
      ) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'quiet turn-retry';
        retry.textContent = 'Retry';
        const id = turn.messageId;
        retry.addEventListener('click', () => void this.retryMessage(id));
        item.append(retry);
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
    const choice = this.options.view().choice;
    const choiceKey = JSON.stringify(choice);
    if (!this.restoring && choiceKey !== this.storedChoice) {
      this.storedChoice = choiceKey;
      write(this.keys.assistantChoice, choice ? choiceKey : null);
    }
    this.paintChoice();
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
  /** The provider and model selectors, the reason a choice cannot be used, and the new-conversation notice above Send. */
  private paintChoice(): void {
    const view = this.options.view();
    const sel = selection(this.providers, view.choice);
    const model = view.choice?.model ?? '';
    const field = modelField(sel.row, model);
    const bound = this.current;
    const notice = newConversationNotice(bound, view.choice, sel);
    const signature = JSON.stringify([
      this.providers,
      this.providersLoaded,
      sel,
      model,
      field,
      bound?.id ?? null,
      notice,
      this.agentChose,
      this.conversations.map((c) => [c.cliId, c.model]),
    ]);
    if (signature === this.choiceSignature) return;
    this.choiceSignature = signature;
    const provider = node('providerSelect') as HTMLSelectElement;
    provider.replaceChildren();
    for (const row of this.providers) {
      const option = document.createElement('option');
      option.value = row.id;
      option.textContent = row.available ? row.label : `${row.label} (unavailable)`;
      provider.append(option);
    }
    if (!this.providers.length) {
      const none = document.createElement('option');
      none.value = '';
      none.textContent = this.providersLoaded ? 'No agent CLI installed' : 'Loading providers…';
      provider.append(none);
    }
    provider.value = sel.row?.id ?? '';
    provider.disabled = !this.providers.length;
    const input = node('modelInput') as HTMLInputElement;
    if (input.value !== model) input.value = model;
    input.disabled = field.disabled;
    input.setAttribute('aria-invalid', String(field.invalid));
    input.placeholder = field.disabled && sel.row ? 'No model choice' : 'Session default';
    const list = node('modelSuggestions');
    list.replaceChildren();
    for (const name of modelSuggestions(this.conversations, sel.row?.id)) {
      const option = document.createElement('option');
      option.value = name;
      list.append(option);
    }
    const reasons = [
      sel.stale
        ? `That provider is no longer available${sel.alternative ? `; ${sel.alternative.label} is selected instead` : ''}.`
        : '',
      sel.row && !sel.row.available ? (sel.row.reason ?? '') : '',
      field.reason,
      this.agentChose ? 'Set by an agent.' : '',
    ].filter(Boolean);
    const note = node('choiceNote');
    note.textContent = reasons.join(' ');
    note.hidden = !reasons.length;
    const banner = node('newConversationNotice');
    // A provider that cannot start says why in the note; promising a new conversation on it would contradict that.
    const promised =
      sel.row?.available === false ? '' : notice && this.agentChose ? `${notice} (set by an agent)` : notice;
    banner.textContent = promised;
    banner.hidden = !promised;
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
