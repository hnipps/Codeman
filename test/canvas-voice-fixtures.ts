/**
 * Controlled stand-ins for everything voice touches in a browser, installed before the page's own scripts. No real
 * microphone is opened and no real audio is recognised or spoken: the "microphone" is an oscillator's stream, the
 * relay is a scripted socket, and speech recognition and synthesis are recorders.
 */
export type VoiceHarness = {
  /** What the next getUserMedia call does. */
  microphone: 'grant' | 'deny' | 'none';
  requests: number;
  tracks: MediaStreamTrack[];
  sockets: {
    url: string;
    binary: number;
    control: string[];
    closed: boolean;
    open(): void;
    frame(data: Record<string, unknown>): void;
    serverClose(code: number, reason?: string): void;
  }[];
  modules: string[];
  spoken: string[];
  cancels: number;
  finishSpeech(): void;
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
  let config: { recognition?: boolean; synthesis?: boolean } = {};
  try {
    config = JSON.parse(localStorage.getItem('test:voice') ?? '{}');
  } catch {
    /* Defaults. */
  }
  const harness: VoiceHarness = {
    microphone: 'grant',
    requests: 0,
    tracks: [],
    sockets: [],
    modules: [],
    spoken: [],
    cancels: 0,
    finishSpeech: () => {},
    recognizers: [],
  };
  window.__voice = harness;

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
        },
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
      if (JSON.parse(data).t === 'finalize')
        setTimeout(() => {
          if (this.pending) this.record.frame({ t: 'transcript', text: this.pending, final: true });
          this.record.frame({ t: 'closed' });
          this.record.serverClose(1000);
        }, 30);
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
      setTimeout(() => this.onend?.(), 20);
    }
    abort(): void {
      this.record.aborted = true;
    }
  }
  const define = (name: string, value: unknown) =>
    Object.defineProperty(window, name, { configurable: true, writable: true, value });
  define('SpeechRecognition', config.recognition ? Recognizer : undefined);
  define('webkitSpeechRecognition', undefined);

  let current: { onend: (() => void) | null } | null = null;
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
          speak(utterance: { text: string; onend: (() => void) | null }) {
            harness.spoken.push(utterance.text);
            current = utterance;
          },
          cancel() {
            harness.cancels++;
            current = null;
          },
        }
  );
  harness.finishSpeech = () => {
    const done = current;
    current = null;
    done?.onend?.();
  };
}
