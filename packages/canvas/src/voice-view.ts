import type { TranscriptRow } from './conversation.js';
import {
  SEND_DELAY_MS,
  initialVoice,
  spokenReply,
  voice,
  voiceBusy,
  voiceCapability,
  voiceIndicator,
  voiceLines,
  type VoiceCapability,
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
  draft: { read: () => string; write: (text: string) => void; element: HTMLTextAreaElement };
  /** The composer's own send. A spoken turn has no other way out. */
  send: () => Promise<boolean>;
  /** Brings the composer into view when a capture starts. It must not move keyboard focus. */
  show: () => void;
};
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
  constructor(private options: Options) {
    this.state = initialVoice(this.capability());
    const press = (mode: VoiceMode) => (event: MouseEvent) => {
      if (event.isTrusted) this.toggle(mode, true, false);
    };
    node('voiceDictate').addEventListener('click', press('dictation'));
    node('voiceConversation').addEventListener('click', press('conversation'));
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
    window.addEventListener('blur', () => this.dispatch({ type: 'blur' }));
    window.addEventListener('offline', () => this.dispatch({ type: 'offline' }));
    this.paint();
  }
  private capability(): VoiceCapability {
    return voiceCapability({
      relay: this.relay,
      microphone: typeof navigator.mediaDevices?.getUserMedia === 'function',
      worklet: typeof AudioContext !== 'undefined' && typeof AudioWorkletNode !== 'undefined',
      socket: typeof WebSocket !== 'undefined',
      recognition: !!browserRecognition(),
      synthesis: !!this.speaker,
    });
  }
  /** Whether the server's relay can transcribe, as the providers answer reports it. */
  relayAvailable(available: boolean): void {
    if (available === this.relay) return;
    this.relay = available;
    this.dispatch({ type: 'capability', capability: this.capability() });
  }
  /** Escape ends capture, a pending send or playback before it does anything else; true when it did. */
  escape(): boolean {
    if (!voiceBusy(this.state)) return false;
    this.dispatch({ type: 'escape' });
    return true;
  }
  /** The composer sent a message, by any route. */
  sent(messageId: string, text: string): void {
    this.dispatch({ type: 'sent', messageId, text });
  }
  /** The bound conversation's transcript as the rail now shows it. */
  thread(rows: readonly TranscriptRow[], status: { working: boolean; waiting: boolean; ended: boolean }): void {
    const awaiting = this.state.awaiting;
    if (!awaiting) return;
    const reply = status.working || status.waiting ? null : spokenReply(rows, awaiting);
    if (reply) this.dispatch({ type: 'reply', text: reply.text });
    else if (status.ended) this.dispatch({ type: 'reply-gone' });
  }
  private toggle(mode: VoiceMode, allowed: boolean, repeat: boolean): void {
    const before = this.state.capture;
    this.dispatch({ type: 'toggle', mode, allowed, repeat, draft: this.options.draft.read() });
    if (this.state.capture !== before) this.options.show();
  }
  private dispatch(event: VoiceEvent): void {
    const step = voice(this.state, event);
    this.state = step.state;
    for (const effect of step.effects) {
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
          void this.options.send().then((ok) => {
            if (!ok) this.dispatch({ type: 'send-failed' });
          });
          break;
        case 'speak': {
          const turn = this.state.capture;
          this.speaker?.speak(effect.text, () => {
            if (this.state.capture === turn) this.dispatch({ type: 'speech-end' });
          });
          break;
        }
        case 'speak-cancel':
          this.speaker?.cancel();
          break;
      }
    }
    this.paint();
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
      line.textContent = lines[mode];
      line.hidden = !lines[mode];
      line.dataset.phase = state.mode === mode || state.mode === null ? state.phase : 'idle';
    }
    node('voiceCancel').hidden = state.phase !== 'ready-to-send';
    node('voiceStopSpeaking').hidden = state.phase !== 'speaking';
    node('voiceActions').hidden = state.phase !== 'ready-to-send' && state.phase !== 'speaking';
    const mark = node('micIndicator');
    mark.hidden = !indicator;
    if (indicator) {
      mark.dataset.kind = indicator.kind;
      mark.dataset.phase = state.phase;
      node('micIndicatorText').textContent = indicator.text;
      node('micStop').textContent = indicator.action;
    }
    document.documentElement.dataset.voice = state.phase;
  }
}
