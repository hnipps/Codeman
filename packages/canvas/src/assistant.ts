import { uuid } from './ids.js';
import { MAX_MODEL_ID_LENGTH } from '../../../src/canvas/providers.js';
import { chips, type Chip } from './context.js';
import type { ViewCommand, ViewState } from './commands.js';
import type { ViewObject } from './model.js';
import type { ConversationMessage } from '../../../src/canvas/conversation-schema.js';
import type { ThreadRequest } from './ask.js';
import { label } from './model.js';
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
import {
  MAX_SENT_TASKS,
  RUN_INTERRUPTED,
  attemptPending,
  nextTaskAttempt,
  parseSentTasks,
  parseTaskAttempt,
  taskFailure,
  type SentTask,
  type TaskAttempt,
  type TaskRow,
} from './task.js';
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
  working?: boolean;
  requests?: Omit<ThreadRequest, 'conversationId' | 'working' | 'ended'>[];
  /** Present when the conversation is a background task: it is listed with the tasks, not in the picker. */
  task?: { name: string; state: string; isolation: string };
  /** An agent started it rather than the person. */
  startedBy?: { kind: 'agent'; sessionId: string };
};
/** Where a request from a comment thread goes when it starts a new conversation, or why it cannot. */
export type FreshTarget = { ok: true; cliId?: string; model?: string; label: string } | { ok: false; reason: string };
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
  /** Selects an object and opens its comment thread (a thread-origin prompt's backlink). */
  openThread: (objectId: string) => void;
  /** The conversation list was read again: thread request states may have changed. */
  listed: () => void;
  /** A message was accepted by the server, whichever control sent it. */
  sent?: (messageId: string, text: string, conversationId: string) => void;
  /** The bound conversation's transcript and state, each time the thread is worked out. */
  thread?: (
    rows: readonly TranscriptRow[],
    status: { working: boolean; waiting: boolean; ended: boolean },
    conversationId: string | null
  ) => void;
  /** The bound conversation's session reported the end of a turn (a stop hook or idle). */
  turnEnded?: (conversationId: string) => void;
  /** A background task was started from the draft. */
  taskStarted?: (task: TaskRow) => void;
  /** A spoken turn is counting down or being sent: a run would start the same text a second time. */
  voicePending?: () => boolean;
  /** A run is starting: a spoken turn that began counting down in the same moment is not sent. */
  runStarting?: () => void;
  /** Whether the server's Claude voice relay can transcribe, from the providers answer. */
  voiceRelay?: (available: boolean) => void;
};
/** `refusal` is set when the text was not sent at all and Retry does not apply. */
export type SendResult = { ok: boolean; refusal?: string };
/** `text` is what the person is told, wherever the run was asked from. */
export type RunResult = { ok: boolean; text: string };
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
  private taskAttempt: TaskAttempt | null;
  private sentTasks: SentTask[];
  private runningTask: Promise<RunResult> | null = null;
  /** The page is unloading: a request that fails now was cut off, not answered. */
  private leaving = false;
  private loaded: string | null = null;
  private transcriptTimer: ReturnType<typeof setTimeout> | undefined;
  private listTimer: ReturnType<typeof setTimeout> | undefined;
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
    this.taskAttempt = parseTaskAttempt(read(this.keys.taskOutbox));
    this.sentTasks = parseSentTasks(read(this.keys.taskSent));
    // A run a reload cut off is never left silent: the line stays until the task shows up in the list or the text changes.
    if (this.taskAttempt && attemptPending(read(this.keys.taskOutbox))) this.backgroundNote(RUN_INTERRUPTED);
    for (const name of ['pagehide', 'beforeunload']) window.addEventListener(name, () => (this.leaving = true));
    // A page restored from the back/forward cache is in use again.
    window.addEventListener('pageshow', () => (this.leaving = false));
    this.draft.addEventListener('input', () => {
      write(this.keys.assistantDraft, this.draft.value);
      this.say('');
      // A refusal is about the text as it was; the question about sharing the folder stays until it is answered.
      if (node('backgroundShareRow').hidden) this.backgroundNote('');
      this.syncRun();
    });
    const run = node('runBackground');
    // The press must not take focus from the composer or the board: after a run, focus is where it was.
    run.addEventListener('mousedown', (e) => e.preventDefault());
    run.addEventListener('click', () => void this.runInBackground());
    this.syncRun();
    this.draft.addEventListener('keydown', (e) => {
      // Enter sends; Shift+Enter is a line break. A key that ends an IME composition or repeats never sends.
      if (this.options.phone()) return;
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229 || e.repeat) return;
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey) {
        e.preventDefault();
        void this.runInBackground();
        return;
      }
      if (e.shiftKey) return;
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
      // A task that was being inspected leaves the picker with the choice that left it.
      this.paintPicker();
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
      this.options.voiceRelay?.((this.data(body).voice as { relay?: unknown } | undefined)?.relay === true);
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
  /** Dictated text replaces the draft the way typing does: kept across a reload, and it clears a stale status line. */
  setDraft(text: string): void {
    this.draft.value = text;
    write(this.keys.assistantDraft, text);
    this.say('');
    this.syncRun();
    this.draft.scrollTop = this.draft.scrollHeight;
  }
  /**
   * Run in background is offered only for a request that has text and while no run is travelling. While one travels
   * the draft is still in the composer, so Send is off too: the same text must not also go to the conversation.
   */
  private syncRun(): void {
    node('runBackground').toggleAttribute('disabled', !this.draft.value.trim() || this.runningTask !== null);
    node('assistantSend').toggleAttribute('disabled', this.sending || this.runningTask !== null);
  }
  /** The rail shows a background task (through Inspect) rather than a conversation. */
  showsTask(): boolean {
    return !!this.current?.task;
  }
  /**
   * The task list was read: a run a reload interrupted is settled once its task is listed (the text that was run
   * leaves the composer, as on a normal acknowledgement), and texts kept for tasks that are gone are dropped.
   */
  tasksListed(rows: readonly Pick<TaskRow, 'id' | 'requestId' | 'name'>[]): void {
    const attempt = this.taskAttempt;
    const started = attempt && !this.runningTask ? rows.find((r) => r.requestId === attempt.requestId) : undefined;
    if (attempt && started) {
      this.acknowledged(attempt, started);
      this.backgroundNote('');
      this.say(`Running in the background: ${started.name}`);
    }
    const kept = this.sentTasks.filter((t) => rows.some((r) => r.id === t.id));
    if (kept.length !== this.sentTasks.length) {
      this.sentTasks = kept;
      write(this.keys.taskSent, kept.length ? JSON.stringify(kept) : null);
    }
  }
  /** The server has the task: its request id has done its work, and only what was run leaves the composer. */
  private acknowledged(attempt: TaskAttempt, task: Pick<TaskRow, 'id'>): void {
    this.taskAttempt = null;
    write(this.keys.taskOutbox, null);
    this.sentTasks = [
      ...this.sentTasks.filter((t) => t.id !== task.id),
      { id: task.id, requestId: attempt.requestId, text: attempt.text, refIds: attempt.refIds },
    ].slice(-MAX_SENT_TASKS);
    write(this.keys.taskSent, JSON.stringify(this.sentTasks));
    const now = this.draft.value;
    if (now.startsWith(attempt.text)) this.draft.value = now.slice(attempt.text.length).replace(/^\s+/, '');
    write(this.keys.assistantDraft, this.draft.value || null);
    this.options.dispatch({ kind: 'context-clear-sent', ids: attempt.refIds });
    this.syncRun();
  }
  /** Whether this browser still holds the request of a task whose delivery failed, so it can be sent again. */
  canRetryTask(id: string): boolean {
    return this.sentTasks.some((t) => t.id === id);
  }
  /**
   * Sends a task's undelivered request again: the same request id and text, marked as a retry, through the route
   * that started it. Null when it went; otherwise what to tell the person. Reached only from the row's own Retry.
   */
  async retryTask(id: string): Promise<string | null> {
    const kept = this.sentTasks.find((t) => t.id === id);
    if (!kept) return 'This browser no longer holds that request. Run it again from the assistant.';
    try {
      const answer = await this.json(`/api/canvas/${this.options.workspace}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: kept.requestId, text: kept.text, refIds: kept.refIds, retry: true }),
      });
      if (answer.status >= 400) return taskFailure(errorMessage(answer.body), answer.status).text;
      return this.data(answer.body).retried === true ? null : 'This task can no longer be sent again.';
    } catch {
      return 'Could not reach the server. Try again.';
    }
  }
  private backgroundNote(text: string, share = false): void {
    const note = node('backgroundNote');
    note.textContent = text;
    note.hidden = !text;
    const row = node('backgroundShareRow');
    if (!share) (node('backgroundShared') as HTMLInputElement).checked = false;
    row.hidden = !share;
  }
  /**
   * Starts the draft and its context as a background task: its own agent session, apart from the conversation the
   * rail is on. Only a person's key or press reaches this. A run already travelling is joined, never doubled.
   */
  runInBackground(): Promise<RunResult> {
    if (this.runningTask) return this.runningTask;
    const origin = document.activeElement;
    const run = this.background().finally(() => {
      this.runningTask = null;
      this.syncRun();
      // A control that went away under the keyboard (the button disables on an empty draft) hands focus back.
      const active = document.activeElement;
      if (active === null || active === document.body || active === node('runBackground'))
        (origin instanceof HTMLElement && origin.isConnected && origin !== node('runBackground')
          ? origin
          : this.draft
        ).focus({ preventScroll: true });
    });
    this.runningTask = run;
    this.syncRun();
    this.options.runStarting?.();
    return run;
  }
  private async background(): Promise<RunResult> {
    const fail = (text: string, share = false): RunResult => {
      this.backgroundNote(text, share);
      return { ok: false, text };
    };
    if (this.sending || this.inflight) return fail('A message is being sent. Try again in a moment.');
    if (this.options.voicePending?.())
      return fail('A voice turn is about to be sent. Cancel it or wait, then run in the background.');
    const text = this.draft.value;
    const refusal = promptRefusal(text);
    if (refusal) return fail(refusal);
    const ids = chips(this.options.objects(), this.options.view().context).map((c) => c.id);
    if (typeof navigator !== 'undefined' && navigator.onLine === false)
      return fail('You are offline. Your message is kept; try again when the connection is back.');
    const choice = this.options.view().choice;
    const sel = selection(this.providers, choice);
    const model = choice?.model ?? '';
    if (this.providersLoaded && sel.row) {
      if (!sel.row.available)
        return fail(`${sel.row.reason ?? 'That provider cannot start a session.'} Pick another provider.`);
      const field = modelField(sel.row, model);
      if (field.invalid) return fail(field.reason);
    }
    const attempt = nextTaskAttempt(this.taskAttempt, text, ids, () => uuid());
    this.taskAttempt = attempt;
    // Marked as travelling until an answer is seen, so a reload in between is never silent.
    write(this.keys.taskOutbox, JSON.stringify({ ...attempt, pending: true }));
    const answered = (): void => {
      if (this.taskAttempt === attempt) write(this.keys.taskOutbox, JSON.stringify(attempt));
    };
    const shared = !node('backgroundShareRow').hidden && (node('backgroundShared') as HTMLInputElement).checked;
    const parent = this.current;
    this.backgroundNote('');
    this.say('Starting in the background…', 'sending');
    try {
      const answer = await this.json(`/api/canvas/${this.options.workspace}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: attempt.requestId,
          text,
          refIds: ids,
          ...(this.providersLoaded && sel.row ? { cliId: sel.row.id } : {}),
          ...(model ? { model } : {}),
          ...(shared ? { shared: true } : {}),
          ...(parent && !parent.task && /^[0-9a-fA-F-]{36}$/.test(parent.id)
            ? { parentConversationId: parent.id }
            : {}),
        }),
      });
      const task = this.data(answer.body).task as TaskRow | undefined;
      if (answer.status >= 400 || !task) {
        answered();
        const failure = taskFailure(errorMessage(answer.body), answer.status);
        if (failure.fresh) {
          this.taskAttempt = null;
          write(this.keys.taskOutbox, null);
        }
        this.say('');
        return fail(failure.text, failure.share);
      }
      this.acknowledged(attempt, task);
      const said = `Running in the background: ${task.name}`;
      this.say(said);
      this.options.taskStarted?.(task);
      return { ok: true, text: said };
    } catch {
      // A page that is going away fails its own request; that is the interruption the next load reports.
      if (!this.leaving) answered();
      this.say('');
      return fail('Could not reach the server. Your message is kept.');
    }
  }
  /** Sends the draft exactly as Send does. A send already travelling is joined, not refused. */
  send(): Promise<SendResult> {
    return this.submit();
  }
  /** The conversation a send would go to now; null when it would start a new one. */
  sendTarget(): string | null {
    const choice = this.options.view().choice;
    const fresh = newConversationNotice(this.current, choice, selection(this.providers, choice)) !== '';
    return fresh ? null : (this.current?.id ?? null);
  }
  /** The stored list has been handed back to the view; from here the view is what gets stored. */
  restoreDone(): void {
    this.restoring = false;
  }
  stop(): void {
    this.stopped = true;
    window.removeEventListener('focus', this.onFocus);
    clearTimeout(this.transcriptTimer);
    clearTimeout(this.listTimer);
  }
  /** Live conversations a thread request can go to, newest first, named as the picker names them. */
  targets(): { id: string; label: string }[] {
    const sorted = this.conversations.filter((c) => !c.task).sort((a, b) => b.createdAt - a.createdAt);
    return sorted.flatMap((c, index) =>
      c.session === 'ended' ? [] : [{ id: c.id, label: `Conversation ${sorted.length - index}` }]
    );
  }
  /** The conversation a thread request goes to unless the person picks another: the one the rail is on, if it is live. */
  preferredTarget(): string | null {
    const bound = this.current;
    return bound && !bound.task && bound.session !== 'ended' ? bound.id : null;
  }
  /** The provider and model a new conversation would start on, from the rail's current choice. */
  freshTarget(): FreshTarget {
    const choice = this.options.view().choice;
    const sel = selection(this.providers, choice);
    if (!this.providersLoaded || !sel.row) return { ok: true, label: 'New conversation' };
    if (!sel.row.available)
      return { ok: false, reason: `${sel.row.reason ?? `${sel.row.label} cannot start a conversation.`}` };
    const model = choice?.model ?? '';
    const field = modelField(sel.row, model);
    if (field.invalid) return { ok: false, reason: field.reason };
    return {
      ok: true,
      cliId: sel.row.id,
      ...(model ? { model } : {}),
      label: `New conversation · ${sel.row.label}${model ? ` ${model}` : ''}`,
    };
  }
  /** Every request this canvas's conversations took from comment threads. */
  requests(): ThreadRequest[] {
    return this.conversations.flatMap((c) =>
      (c.requests ?? []).map((r) => ({
        ...r,
        conversationId: c.id,
        working: c.working === true,
        ended: c.session === 'ended',
      }))
    );
  }
  /** A thread asked a conversation: keep the text so the rail can show the message before the transcript does. */
  noteAsked(message: SentMessage): void {
    this.sent = [...this.sent.filter((m) => m.messageId !== message.messageId), message].slice(-10);
    this.persistSent();
    void this.refreshList();
    // The turn starts a moment after the message is taken; read once more so the thread says Working without waiting for an event.
    clearTimeout(this.listTimer);
    this.listTimer = setTimeout(() => void this.refreshList(), 1_500);
  }
  /** Binds the rail to one conversation, as the picker does; the caller opens the rail. */
  showConversation(id: string): void {
    this.agentChose = false;
    this.options.dispatch({ kind: 'conversation', id });
    this.options.dispatch({ kind: 'assistant-choice', choice: null });
    this.paintPicker();
    void this.open();
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
      // A background task is reached from the task list, never by the rail landing on it.
      const newest = this.conversations.filter((c) => !c.task).sort((a, b) => b.createdAt - a.createdAt)[0];
      if (newest && !this.sending) this.options.dispatch({ kind: 'conversation', id: newest.id });
    }
    this.paintPicker();
    this.options.listed();
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
    const session = (data.session as { id?: unknown } | undefined)?.id;
    const id = data.id ?? data.sessionId ?? session;
    const conversation = this.current;
    // A request asked from a thread shows its state there, whichever conversation the rail is on.
    // The list is read for any of this canvas's sessions: a request can be newer than the list that would name it.
    if (name !== 'transcript:update' && this.conversations.some((c) => c.sessionId === id)) {
      clearTimeout(this.listTimer);
      this.listTimer = setTimeout(() => void this.refreshList(), TRANSCRIPT_DEBOUNCE_MS);
    }
    if (!conversation || id !== conversation.sessionId) return;
    switch (name) {
      case 'session:working':
      case 'hook:prompt_submitted':
        this.working = true;
        break;
      case 'session:idle':
      case 'hook:idle_prompt':
      case 'hook:stop':
        this.working = false;
        this.options.turnEnded?.(conversation.id);
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
  private refuse(text: string): SendResult {
    this.say(text, 'failed');
    return { ok: false, refusal: text };
  }
  private inflight: Promise<SendResult> | null = null;
  private submit(): Promise<SendResult> {
    if (this.inflight) return this.inflight;
    const run = this.deliver().finally(() => {
      this.inflight = null;
    });
    this.inflight = run;
    return run;
  }
  private async deliver(): Promise<SendResult> {
    if (this.sending) return { ok: false };
    // The draft is on its way to a background task: sent here too, the same request would run twice.
    if (this.runningTask) return { ok: false, refusal: 'A background run is starting with this text. Wait for it.' };
    // A cancelled task may still hold its request unsubmitted in its input; nothing more is sent into that session.
    if (this.current?.task?.state === 'cancelled') return this.refuse('This task was cancelled. Start a new one.');
    const text = this.draft.value;
    const refusal = promptRefusal(text);
    if (refusal) return this.refuse(refusal);
    const ids = chips(this.options.objects(), this.options.view().context).map((c) => c.id);
    if (typeof navigator !== 'undefined' && navigator.onLine === false)
      return this.refuse('You are offline. Your message is kept; retry when the connection is back.');
    const choice = this.options.view().choice;
    const sel = selection(this.providers, choice);
    // A choice that no longer matches the bound conversation starts a new one: the old conversation and its session are left as they are.
    const fresh = newConversationNotice(this.current, choice, sel) !== '';
    const target = fresh ? null : (this.current?.id ?? null);
    // With nothing listed (a probe that found none) the server starts its default exactly as it always did.
    if (target === null && this.providersLoaded && sel.row) {
      if (!sel.row.available)
        return this.refuse(`${sel.row.reason ?? 'That provider cannot start a conversation.'} Pick another provider.`);
      const field = modelField(sel.row, choice?.model ?? '');
      if (field.invalid) return this.refuse(field.reason);
    }
    // A failed attempt against the bound conversation is not carried into the new one the choice now asks for.
    const stored = fresh && this.attempt?.conversationId === (this.current?.id ?? null) ? null : this.attempt;
    const attempt = nextAttempt(stored, target, text, ids, () => uuid());
    this.attempt = attempt;
    write(this.keys.assistantOutbox, JSON.stringify(attempt));
    this.sending = true;
    this.syncRun();
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
      this.syncRun();
      this.options.sent?.(attempt.messageId, text, conversationId);
      void this.open();
      return { ok: true };
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
      return { ok: false };
    } finally {
      this.sending = false;
      this.draft.readOnly = false;
      this.syncRun();
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
    // Tasks stay out of the picker; the one being inspected is named so the picker says what the rail shows.
    const sorted = this.conversations.filter((c) => !c.task).sort((a, b) => b.createdAt - a.createdAt);
    const task = this.conversations.find((c) => c.id === bound && c.task);
    picker.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'New conversation';
    picker.append(none);
    sorted.forEach((c, index) => {
      const option = document.createElement('option');
      option.value = c.id;
      option.textContent = `Conversation ${sorted.length - index}${c.startedBy ? ' · started by an agent' : ''}${c.session === 'ended' ? ' (ended)' : ''}`;
      picker.append(option);
    });
    if (task?.task) {
      const option = document.createElement('option');
      option.value = task.id;
      option.textContent = `Task · ${task.task.name}`;
      picker.append(option);
    }
    picker.value = task || sorted.some((c) => c.id === bound) ? bound : '';
    node('conversationHead').hidden = !sorted.length && !task;
  }
  private paintThread(): void {
    const conversation = this.current;
    const turns = buildThread(this.rows, this.messages, this.keptMessages(), agentLabel(conversation));
    const status = threadStatus({
      ended: conversation?.session === 'ended',
      waiting: !!this.approval,
      working: this.working,
    });
    this.options.thread?.(
      this.rows,
      { working: this.working, waiting: !!this.approval, ended: conversation?.session === 'ended' },
      conversation?.id ?? null
    );
    const origins = turns.flatMap((t) => {
      const object = t.origin ? this.options.objects().find((o) => o.id === t.origin?.objectId) : undefined;
      return t.origin ? [object ? label(object) : null] : [];
    });
    const signature = JSON.stringify([turns, status, this.approval, conversation?.id ?? null, origins]);
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
      if (turn.origin) {
        const { objectId } = turn.origin;
        const object = this.options.objects().find((o) => o.id === objectId);
        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'quiet turn-origin';
        back.textContent = object ? `From a comment on ${label(object)}` : 'From a comment on a removed object';
        back.title = 'Open the comment thread';
        back.toggleAttribute('disabled', !object);
        back.addEventListener('click', () => this.options.openThread(objectId));
        item.append(back);
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
