/**
 * Controlled stand-ins for everything voice touches in a browser, installed before the page's own scripts. No real
 * microphone is opened and no real audio is recognised or spoken: the "microphone" is an oscillator's stream, the
 * relay is a scripted socket, and speech recognition and synthesis are recorders.
 */
export type VoiceHarness = {
  /** What the next getUserMedia call does. */
  microphone: 'grant' | 'deny' | 'none';
  /** The next granted track reports itself muted from the start. */
  startMuted: boolean;
  /** The relay does not say `ready` until `sockets[n].ready()` is called. */
  holdReady: boolean;
  /** How the relay answers a finalize: at once, after 1.5 s, or never. */
  finalize: 'answer' | 'slow' | 'never';
  /** The relay accepts the socket and closes it with this code (4008: too many streams). */
  rejectWith: number | null;
  /** A recognizer's `stop()` is never followed by its end. */
  recognizerHangs: boolean;
  requests: number;
  tracks: MediaStreamTrack[];
  sockets: {
    url: string;
    binary: number;
    control: string[];
    closed: boolean;
    open(): void;
    ready(): void;
    frame(data: Record<string, unknown>): void;
    serverClose(code: number, reason?: string): void;
  }[];
  modules: string[];
  spoken: string[];
  cancels: number;
  finishSpeech(): void;
  /** The utterance in progress fails the way a browser with no usable voice fails it. */
  failSpeech(): void;
  /** Voices arrive late: the synthesis object gains one and says so. */
  loadVoices(): void;
  recognizers: {
    started: boolean;
    stopped: boolean;
    aborted: boolean;
    result(text: string, final: boolean): void;
    error(code: string): void;
    end(): void;
  }[];
};
declare global {
  interface Window {
    __voice: VoiceHarness;
  }
}

/** Passed to `addInitScript`, so it must stand alone. `localStorage['test:voice']` picks which browser features exist. */
export function installVoiceFixtures(): void {
  let config: { recognition?: boolean; synthesis?: boolean; insecure?: boolean; voices?: boolean } = {};
  try {
    config = JSON.parse(localStorage.getItem('test:voice') ?? '{}');
  } catch {
    /* Defaults. */
  }
  const harness: VoiceHarness = {
    microphone: 'grant',
    startMuted: false,
    holdReady: false,
    finalize: 'answer',
    rejectWith: null,
    recognizerHangs: false,
    requests: 0,
    tracks: [],
    sockets: [],
    modules: [],
    spoken: [],
    cancels: 0,
    finishSpeech: () => {},
    failSpeech: () => {},
    loadVoices: () => {},
    recognizers: [],
  };
  window.__voice = harness;
  // A plain http page that is not localhost: the browser calls it insecure and gives it no microphone.
  if (config.insecure) {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, get: () => false });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, get: () => undefined });
  }

  if (navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async () => {
      harness.requests++;
      if (harness.microphone === 'deny') throw new DOMException('Permission denied', 'NotAllowedError');
      if (harness.microphone === 'none') throw new DOMException('Requested device not found', 'NotFoundError');
      const audio = new AudioContext();
      const tone = audio.createOscillator();
      const out = audio.createMediaStreamDestination();
      tone.connect(out);
      tone.start();
      if (harness.startMuted)
        for (const track of out.stream.getAudioTracks())
          Object.defineProperty(track, 'muted', { configurable: true, get: () => true });
      harness.tracks.push(...out.stream.getAudioTracks());
      return out.stream;
    };
  const addModule = AudioWorklet.prototype.addModule;
  AudioWorklet.prototype.addModule = function (url: string | URL, options?: WorkletOptions) {
    harness.modules.push(String(url));
    return addModule.call(this, url, options);
  };

  const RealSocket = window.WebSocket;
  class RelaySocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 0;
    binaryType = 'blob';
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onclose: ((e: CloseEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    record: VoiceHarness['sockets'][number];
    private pending = '';
    constructor(url: string) {
      super();
      this.record = {
        url,
        binary: 0,
        control: [],
        closed: false,
        open: () => {
          if (this.readyState !== 0) return;
          this.readyState = 1;
          this.onopen?.(new Event('open'));
          if (harness.rejectWith !== null) this.record.serverClose(harness.rejectWith, 'Too many voice streams');
          else if (!harness.holdReady) this.record.ready();
        },
        ready: () => this.record.frame({ t: 'ready' }),
        frame: (data) => {
          if (data.t === 'transcript') this.pending = data.final ? '' : String(data.text ?? '');
          this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
        },
        serverClose: (code, reason = '') => {
          if (this.readyState === 3) return;
          this.readyState = 3;
          this.record.closed = true;
          this.onclose?.(new CloseEvent('close', { code, reason }));
        },
      };
      harness.sockets.push(this.record);
      setTimeout(() => this.record.open(), 0);
    }
    send(data: string | ArrayBuffer): void {
      if (typeof data !== 'string') {
        this.record.binary++;
        return;
      }
      this.record.control.push(data);
      // The relay answers a finalize with the pending utterance as final, then closes cleanly.
      if (JSON.parse(data).t === 'finalize' && harness.finalize !== 'never')
        setTimeout(
          () => {
            if (this.readyState === 3) return;
            if (this.pending) this.record.frame({ t: 'transcript', text: this.pending, final: true });
            this.record.frame({ t: 'closed' });
            this.record.serverClose(1000);
          },
          harness.finalize === 'slow' ? 1500 : 30
        );
    }
    close(): void {
      this.readyState = 3;
      this.record.closed = true;
    }
  }
  const Socket = function (url: string | URL, protocols?: string | string[]) {
    return String(url).includes('/ws/voice/stream') ? new RelaySocket(String(url)) : new RealSocket(url, protocols);
  } as unknown as typeof WebSocket;
  Object.assign(Socket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Socket;

  class Recognizer {
    continuous = false;
    interimResults = false;
    lang = '';
    onstart: (() => void) | null = null;
    onresult: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    record: VoiceHarness['recognizers'][number];
    private results: { 0: { transcript: string }; length: 1; isFinal: boolean }[] = [];
    constructor() {
      this.record = {
        started: false,
        stopped: false,
        aborted: false,
        result: (text, final) => {
          const last = this.results.at(-1);
          const entry = { 0: { transcript: text }, length: 1 as const, isFinal: final };
          if (last && !last.isFinal) this.results[this.results.length - 1] = entry;
          else this.results.push(entry);
          this.onresult?.({ resultIndex: this.results.length - 1, results: this.results });
        },
        error: (code) => this.onerror?.({ error: code }),
        end: () => this.onend?.(),
      };
      harness.recognizers.push(this.record);
    }
    start(): void {
      this.record.started = true;
      setTimeout(() => this.onstart?.(), 0);
    }
    stop(): void {
      this.record.stopped = true;
      if (!harness.recognizerHangs) setTimeout(() => this.onend?.(), 20);
    }
    abort(): void {
      this.record.aborted = true;
    }
  }
  const define = (name: string, value: unknown) =>
    Object.defineProperty(window, name, { configurable: true, writable: true, value });
  define('SpeechRecognition', config.recognition ? Recognizer : undefined);
  define('webkitSpeechRecognition', undefined);

  let current: { onend: (() => void) | null; onerror: ((e: unknown) => void) | null } | null = null;
  let voices = config.voices !== false;
  const voiceListeners: (() => void)[] = [];
  define(
    'SpeechSynthesisUtterance',
    class {
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public text: string) {}
    }
  );
  define(
    'speechSynthesis',
    config.synthesis === false
      ? undefined
      : {
          getVoices: () => (voices ? [{ name: 'fixture' }] : []),
          addEventListener(type: string, listener: () => void) {
            if (type === 'voiceschanged') voiceListeners.push(listener);
          },
          speak(utterance: { text: string; onend: (() => void) | null; onerror: ((e: unknown) => void) | null }) {
            harness.spoken.push(utterance.text);
            current = utterance;
          },
          cancel() {
            harness.cancels++;
            current = null;
          },
        }
  );
  harness.failSpeech = () => {
    const failed = current;
    current = null;
    failed?.onerror?.({ error: 'synthesis-failed' });
  };
  harness.loadVoices = () => {
    voices = true;
    for (const listener of voiceListeners) listener();
  };
  harness.finishSpeech = () => {
    const done = current;
    current = null;
    done?.onend?.();
  };
}
