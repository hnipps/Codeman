import type { TranscriptRow } from './conversation.js';
import {
  REPLY_SETTLE_MS,
  SEND_DELAY_MS,
  initialVoice,
  replyToSpeak,
  voice,
  voiceBusy,
  voiceCapability,
  voiceIndicator,
  voiceLines,
  type VoiceCapability,
  type VoiceEffect,
  type VoiceEvent,
  type VoiceMode,
  type VoiceState,
} from './voice.js';
import {
  browserCapture,
  browserRecognition,
  browserSpeaker,
  relayCapture,
  type Capture,
  type CaptureHandlers,
  type Speaker,
} from './voice-capture.js';

type Options = {
  url: (path: string) => string;
  phone: () => boolean;
  /** The canvas shortcut scope: false while typing, composing, on a control or outside the board. */
  allowed: (event: KeyboardEvent) => boolean;
  letters: () => boolean;
  /** The rail shows a background task: a spoken turn is not started for one. */
  taskShown?: () => boolean;
  draft: { read: () => string; write: (text: string) => void; element: HTMLTextAreaElement };
  /** The composer's own send. A spoken turn has no other way out. */
  send: () => Promise<{ ok: boolean; refusal?: string }>;
  /** The conversation that send would go to now; null when it would start a new one. */
  target: () => string | null;
  /** Reads the bound conversation's transcript again; `thread` is called with what comes back. */
  reread: () => Promise<void>;
  /** Brings the composer into view when a capture starts or a turn is about to be sent. It must not move keyboard focus. */
  show: () => void;
};
type Status = { working: boolean; waiting: boolean; ended: boolean };
/** How often a frame that gets no visibility event checks whether it is still drawn. */
const CONCEALED_POLL_MS = 500;
const node = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing canvas element: ${id}`);
  return el;
};

/**
 * Dictation and voice conversation for the assistant composer: the pure machine in `voice.ts`, the browser adapters
 * and the controls. Capture can begin only inside this class's own trusted key and click listeners. Nothing public
 * starts it, so a view command, an agent tool or a script on `window` cannot open the microphone.
 */
export class VoiceView {
  private state: VoiceState;
  private relay = false;
  private capture: Capture | null = null;
  private speaker: Speaker | null = browserSpeaker();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private painted = '';
  private escaped: Event | null = null;
  private watch: ReturnType<typeof setInterval> | undefined;
  private rows: readonly TranscriptRow[] = [];
  private status: Status = { working: false, waiting: false, ended: false };
  private shown: string | null = null;
  private candidate: string | null = null;
  private replyTimer: ReturnType<typeof setTimeout> | undefined;
  private rereading = false;
  constructor(private options: Options) {
    this.state = initialVoice(this.capability());
    const press = (mode: VoiceMode) => (event: MouseEvent) => {
      if (event.isTrusted) this.toggle(mode, true, false);
    };
    node('voiceDictate').addEventListener('click', press('dictation'));
    node('voiceConversation').addEventListener('click', press('conversation'));
    // A held Enter on a focused control clicks it again and again; only the first press counts.
    for (const id of ['voiceDictate', 'voiceConversation'])
      node(id).addEventListener('keydown', (event) => {
        if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
      });
    // Escape always ends capture, a pending spoken send or playback, whatever else on the page also acts on it:
    // this runs before every other handler and stops none of them.
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Escape' || !voiceBusy(this.state)) return;
        this.escaped = event;
        this.dispatch({ type: 'escape' });
      },
      true
    );
    document.addEventListener('keydown', (event) => {
      if (!event.isTrusted || event.key.toLowerCase() !== 'b' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (this.options.phone() || !this.options.letters()) return;
      const allowed = this.options.allowed(event);
      if (allowed) event.preventDefault();
      this.toggle(event.shiftKey ? 'conversation' : 'dictation', allowed, event.repeat);
    });
    node('micStop').addEventListener('click', () => this.dispatch({ type: 'stop' }));
    node('voiceCancel').addEventListener('click', () => this.dispatch({ type: 'cancel' }));
    node('voiceStopSpeaking').addEventListener('click', () => this.dispatch({ type: 'stop-speaking' }));
    // Setting the field's value from here fires no input event, so this is the person's own edit.
    options.draft.element.addEventListener('input', () => this.dispatch({ type: 'edited' }));
    document.addEventListener('compositionstart', () => this.dispatch({ type: 'composition' }));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.dispatch({ type: 'hidden' });
    });
    window.addEventListener('pagehide', () => this.dispatch({ type: 'hidden' }));
    // Inside the dashboard the canvas is a frame whose tab can be switched away with no visibility event at all.
    window.addEventListener('blur', () => this.dispatch({ type: this.concealed() ? 'hidden' : 'blur' }));
    window.addEventListener('offline', () => this.dispatch({ type: 'offline' }));
    // Voices can load after the page does.
    this.speaker?.changed(() => this.dispatch({ type: 'capability', capability: this.capability() }));
    this.paint();
  }
  private capability(): VoiceCapability {
    return voiceCapability({
      relay: this.relay,
      secure: window.isSecureContext,
      microphone: typeof navigator.mediaDevices?.getUserMedia === 'function',
      worklet: typeof AudioContext !== 'undefined' && typeof AudioWorkletNode !== 'undefined',
      socket: typeof WebSocket !== 'undefined',
      recognition: !!browserRecognition(),
      synthesis: !!this.speaker?.hasVoice(),
    });
  }
  /** Whether the server's relay can transcribe, as the providers answer reports it. */
  relayAvailable(available: boolean): void {
    if (available === this.relay) return;
    this.relay = available;
    this.dispatch({ type: 'capability', capability: this.capability() });
  }
  /** True when this Escape press ended capture, a pending send or playback, so it should not also close the rail. */
  /** A spoken turn is counting down or on its way: its text is still in the composer. */
  pending(): boolean {
    return this.state.phase === 'ready-to-send' || (this.state.phase === 'processing' && this.state.sending);
  }
  /** Something is about to cover the page (a session's full view): capture ends and nothing is sent, as when the page is hidden. */
  conceal(): void {
    this.dispatch({ type: 'hidden' });
  }
  /** Stops a countdown, exactly as its Cancel send does; the text stays in the composer. */
  cancelPending(): void {
    if (this.state.phase === 'ready-to-send') this.dispatch({ type: 'cancel' });
  }
  escape(event: Event): boolean {
    return this.escaped === event;
  }
  /** The composer sent a message, by any route. */
  sent(messageId: string, text: string, conversationId: string | null): void {
    this.dispatch({ type: 'sent', messageId, text, conversationId });
  }
  /** The bound conversation's session reported the end of a turn. */
  turnEnded(conversationId: string): void {
    this.dispatch({ type: 'turn-ended', conversationId });
    this.consider();
  }
  /** The bound conversation's transcript as the rail now shows it. */
  thread(rows: readonly TranscriptRow[], status: Status, conversationId: string | null): void {
    this.rows = rows;
    this.status = status;
    this.shown = conversationId;
    // Looking at another conversation says nothing about the turn's own.
    if (this.state.awaiting && status.ended && conversationId === this.state.conversation)
      this.dispatch({ type: 'turn-ended', conversationId });
    else this.dispatch({ type: 'target', id: this.options.target() });
    this.consider();
  }
  /** The page is hidden, or it is a frame its host is not drawing (a dashboard tab switched away). */
  private concealed(): boolean {
    if (document.visibilityState === 'hidden') return true;
    try {
      const frame = window.frameElement;
      return !!frame && frame.getClientRects().length === 0;
    } catch {
      // A cross-origin host cannot be read; the page's own visibility is all there is.
      return false;
    }
  }
  /**
   * Decides whether the awaited reply can be read aloud. The turn must have ended, and the text must read the same
   * again a moment later: the last row of a turn can arrive after the stop that ended it.
   */
  private consider(): void {
    if (this.rereading) return;
    const text = replyToSpeak(this.state, this.rows, this.status, this.shown);
    if (text === null) {
      clearTimeout(this.replyTimer);
      this.replyTimer = undefined;
      this.candidate = null;
      if (this.state.awaiting && this.status.ended && this.shown === this.state.conversation)
        this.dispatch({ type: 'reply-gone', conversationId: this.shown });
      return;
    }
    if (text === this.candidate && this.replyTimer !== undefined) return;
    this.candidate = text;
    clearTimeout(this.replyTimer);
    this.replyTimer = setTimeout(() => void this.confirm(text), REPLY_SETTLE_MS);
  }
  private async confirm(wanted: string): Promise<void> {
    this.replyTimer = undefined;
    this.rereading = true;
    try {
      await this.options.reread();
    } catch {
      /* What is already on screen is compared instead. */
    } finally {
      this.rereading = false;
    }
    const now = replyToSpeak(this.state, this.rows, this.status, this.shown);
    if (now !== wanted) {
      this.candidate = null;
      this.consider();
      return;
    }
    this.candidate = null;
    const conversationId = this.state.conversation;
    // Nothing is read aloud into a page nobody is looking at.
    if (this.concealed()) this.dispatch({ type: 'reply-gone', conversationId, hidden: true });
    else this.dispatch({ type: 'reply', text: wanted, conversationId });
  }
  private toggle(mode: VoiceMode, allowed: boolean, repeat: boolean): void {
    const before = this.state.capture;
    this.dispatch({
      type: 'toggle',
      mode,
      allowed,
      repeat,
      draft: this.options.draft.read(),
      taskShown: this.options.taskShown?.() === true,
    });
    if (this.state.capture !== before) this.options.show();
  }
  private dispatch(event: VoiceEvent): void {
    // The countdown is bound to the conversation it started against, so every step first learns where a send would go.
    const target = this.options.target();
    if (event.type !== 'target' && target !== this.state.target) this.dispatch({ type: 'target', id: target });
    const before = this.state.phase;
    const step = voice(this.state, event);
    this.state = step.state;
    this.run(step.effects);
    // The text about to be sent must be on screen, with its Cancel, before it goes.
    if (this.state.phase === 'ready-to-send' && before !== 'ready-to-send') this.options.show();
    this.paint();
    this.watchFrame();
  }
  /** While anything of voice is live, a frame the host stopped drawing is treated as a hidden page. */
  private watchFrame(): void {
    const state = this.state;
    const live = voiceBusy(state) || (state.phase === 'processing' && state.sending) || state.awaiting !== null;
    if (!live) {
      clearInterval(this.watch);
      this.watch = undefined;
    } else if (this.watch === undefined)
      this.watch = setInterval(() => {
        if (this.concealed()) this.dispatch({ type: 'hidden' });
      }, CONCEALED_POLL_MS);
  }
  private run(effects: VoiceEffect[]): void {
    for (const effect of effects) {
      switch (effect.kind) {
        case 'capture-start':
          this.start();
          break;
        case 'capture-finalize':
          this.capture?.finalize();
          break;
        case 'capture-abort':
          this.capture?.abort();
          this.capture = null;
          break;
        case 'draft':
          if (this.options.draft.read() !== effect.text) this.options.draft.write(effect.text);
          break;
        case 'send-timer':
          clearTimeout(this.timer);
          this.timer = setTimeout(() => this.dispatch({ type: 'send-timer' }), SEND_DELAY_MS);
          break;
        case 'send-timer-clear':
          clearTimeout(this.timer);
          break;
        case 'send':
          void this.options.send().then((result) => {
            if (!result.ok) this.dispatch({ type: 'send-failed', refusal: result.refusal });
          });
          break;
        case 'speak': {
          const turn = this.state.capture;
          this.speaker?.speak(effect.text, (spoken) => {
            if (this.state.capture === turn) this.dispatch({ type: spoken ? 'speech-end' : 'speech-failed' });
          });
          break;
        }
        case 'speak-cancel':
          this.speaker?.cancel();
          break;
      }
    }
  }
  private start(): void {
    this.capture?.abort();
    const id = this.state.capture;
    const mine =
      <A extends unknown[]>(run: (...args: A) => void) =>
      (...args: A): void => {
        if (this.state.capture === id) run(...args);
      };
    const handlers: CaptureHandlers = {
      listening: mine(() => this.dispatch({ type: 'permission-granted' })),
      denied: mine(() => this.dispatch({ type: 'permission-denied' })),
      noDevice: mine(() => this.dispatch({ type: 'no-device' })),
      failed: mine((message: string) => this.dispatch({ type: 'start-failed', message })),
      muted: mine((muted: boolean) => this.dispatch({ type: 'muted', muted })),
      transcript: mine((text: string, final: boolean) => this.dispatch({ type: 'transcript', text, final })),
      ended: mine((reason, message) => {
        this.capture = null;
        this.dispatch({ type: 'capture-ended', reason, message });
      }),
    };
    const language = navigator.language || 'en';
    if (this.state.capability.transcription === 'relay') {
      const socket = new URL(this.options.url('/ws/voice/stream'), location.href);
      socket.protocol = socket.protocol === 'https:' ? 'wss:' : 'ws:';
      this.capture = relayCapture({ socketUrl: socket.href, workletUrl: this.workletUrl(), language }, handlers);
    } else this.capture = browserCapture({ language }, handlers);
  }
  /**
   * The worklet is served immutable for a year and is loaded from script, where the server's cache busting cannot
   * see it. The page therefore names it in a link the server does rewrite, and the version is read from there.
   */
  private workletUrl(): string {
    const href = document.querySelector('link[rel="codeman-voice-worklet"]')?.getAttribute('href') ?? '';
    const query = href.indexOf('?');
    return this.options.url('/voice-pcm-worklet.js') + (query < 0 ? '' : href.slice(query));
  }
  private paint(): void {
    const state = this.state;
    const lines = voiceLines(state);
    const indicator = voiceIndicator(state);
    const signature = JSON.stringify([state.phase, state.mode, state.sending, lines, indicator]);
    if (signature === this.painted) return;
    this.painted = signature;
    const active = state.phase !== 'idle' && state.phase !== 'denied' && state.phase !== 'unavailable';
    const on = (mode: VoiceMode): boolean => active && state.phase !== 'error' && state.mode === mode;
    for (const [id, mode, lineId] of [
      ['voiceDictate', 'dictation', 'dictationState'],
      ['voiceConversation', 'conversation', 'conversationState'],
    ] as const) {
      const control = node(id);
      control.setAttribute('aria-pressed', String(on(mode)));
      control.setAttribute('aria-disabled', String(!state.capability.transcription));
      const line = node(lineId);
      // The line stays rendered when empty: a live region that was not there is not announced when it appears.
      line.textContent = lines[mode];
      line.dataset.phase = state.mode === mode || state.mode === null ? state.phase : 'idle';
    }
    node('voiceCancel').hidden = state.phase !== 'ready-to-send';
    node('voiceStopSpeaking').hidden = state.phase !== 'speaking';
    node('voiceActions').hidden = state.phase !== 'ready-to-send' && state.phase !== 'speaking';
    const mark = node('micIndicator');
    mark.hidden = !indicator;
    // Screen readers hear the indicator through a region that is always rendered and empty when there is nothing to say.
    node('voiceAnnounce').textContent = indicator?.text ?? '';
    if (indicator) {
      mark.dataset.kind = indicator.kind;
      mark.dataset.phase = state.phase;
      node('micIndicatorText').textContent = indicator.text;
      node('micStop').textContent = indicator.action;
      node('micStop').hidden = !indicator.action;
    }
    document.documentElement.dataset.voice = state.phase;
  }
}
