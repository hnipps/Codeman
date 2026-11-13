import type { CaptureEnd } from './voice.js';

/** What a capture reports. After `ended`, or after `abort()`, it reports nothing more. */
export type CaptureHandlers = {
  listening(): void;
  denied(): void;
  noDevice(): void;
  failed(message: string): void;
  muted(muted: boolean): void;
  /** `text` is the whole utterance so far; `final` closes that utterance. */
  transcript(text: string, final: boolean): void;
  ended(reason: CaptureEnd, message?: string): void;
};
export type Capture = {
  /** Releases the microphone now and waits briefly for the last transcript. */
  finalize(): void;
  /** Releases everything now and goes silent. */
  abort(): void;
};

/** The relay answers a finalize within a few hundred milliseconds; this is the backstop for one that never does. */
const FINALIZE_TIMEOUT_MS = 5000;

const UNAVAILABLE: Record<string, string> = {
  disabled: 'Claude voice was switched off on this server. Type your message instead.',
  expired: 'The Claude login on this server has expired, so voice input is unavailable. Type your message instead.',
};

/**
 * Transcription through the server's Claude voice relay. The page sends 16 kHz mono PCM16 frames from the shared
 * worklet and receives text; the relay holds the credentials. Each transcript frame is the whole utterance so far.
 */
export function relayCapture(
  options: { socketUrl: string; workletUrl: string; language: string },
  handlers: CaptureHandlers
): Capture {
  let over = false;
  let finalizing = false;
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastError = '';
  const release = (): void => {
    void context?.close().catch(() => {});
    context = null;
    for (const track of stream?.getTracks() ?? []) {
      track.onended = track.onmute = track.onunmute = null;
      track.stop();
    }
    stream = null;
  };
  const closeSocket = (): void => {
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try {
      socket.close(1000);
    } catch {
      /* Already closed. */
    }
    socket = null;
  };
  const end = (reason: CaptureEnd, message?: string): void => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    release();
    closeSocket();
    handlers.ended(reason, message);
  };
  const pump = async (): Promise<void> => {
    if (!stream) return;
    const audio = new AudioContext({ sampleRate: 16000 });
    context = audio;
    if (audio.state === 'suspended') await audio.resume();
    await audio.audioWorklet.addModule(options.workletUrl);
    if (over || finalizing || context !== audio) return;
    const source = audio.createMediaStreamSource(stream);
    const frames = new AudioWorkletNode(audio, 'pcm-frame-processor');
    frames.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (over || finalizing || socket?.readyState !== WebSocket.OPEN) return;
      try {
        socket.send(event.data);
      } catch {
        /* The close handler reports a socket that died. */
      }
    };
    source.connect(frames);
    // A node with no destination is not pulled in some engines; a silent sink keeps it running without echo.
    const sink = audio.createGain();
    sink.gain.value = 0;
    frames.connect(sink).connect(audio.destination);
    handlers.listening();
  };
  const open = (): void => {
    const query = new URLSearchParams({ language: options.language });
    const ws = new WebSocket(`${options.socketUrl}?${query.toString()}`);
    socket = ws;
    ws.binaryType = 'arraybuffer';
    // Audio starts only once the socket is up: frames buffered before that would be the oldest speech.
    ws.onopen = () => void pump().catch(() => end('error', 'The microphone could not be read.'));
    ws.onmessage = (event) => {
      let frame: { t?: string; text?: string; final?: boolean; message?: string };
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (frame.t === 'transcript' && typeof frame.text === 'string' && frame.text)
        handlers.transcript(frame.text, frame.final === true);
      else if (frame.t === 'error' && typeof frame.message === 'string') lastError = frame.message;
    };
    ws.onclose = (event) => {
      if (event.code === 4004)
        end('unavailable', UNAVAILABLE[event.reason] ?? 'This server has no Claude login for voice input.');
      else if (event.code === 4008) end('error', 'Too many voice streams are running on this server. Try again soon.');
      else if (event.code === 4003) end('error', 'The server refused the voice stream from this address.');
      else if (finalizing) end('finalized');
      else end('relay-closed', lastError);
    };
  };
  void (async () => {
    if (!navigator.mediaDevices?.getUserMedia) return handlers.noDevice();
    let granted: MediaStream;
    try {
      granted = await navigator.mediaDevices.getUserMedia({
        audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true },
      });
    } catch (error) {
      if (over) return;
      over = true;
      const name = error instanceof Error ? error.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') handlers.denied();
      else if (name === 'NotFoundError' || name === 'OverconstrainedError') handlers.noDevice();
      else handlers.failed('The microphone could not be opened. It may be in use by another program.');
      return;
    }
    if (over) {
      for (const track of granted.getTracks()) track.stop();
      return;
    }
    stream = granted;
    for (const track of granted.getAudioTracks()) {
      track.onended = () => end('device-lost');
      track.onmute = () => handlers.muted(true);
      track.onunmute = () => handlers.muted(false);
    }
    try {
      open();
    } catch {
      end('relay-closed', 'The voice relay could not be reached.');
    }
  })();
  return {
    finalize() {
      if (over || finalizing) return;
      finalizing = true;
      release();
      if (socket?.readyState !== WebSocket.OPEN) return end('finalized');
      try {
        socket.send(JSON.stringify({ t: 'finalize' }));
      } catch {
        return end('finalized');
      }
      timer = setTimeout(() => end('finalized'), FINALIZE_TIMEOUT_MS);
    },
    abort() {
      if (over) return;
      over = true;
      clearTimeout(timer);
      release();
      closeSocket();
    },
  };
}

type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult:
    | ((event: {
        resultIndex: number;
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
      }) => void)
    | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type RecognitionWindow = { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
export const browserRecognition = (win: Window = window): (new () => Recognition) | undefined =>
  (win as unknown as RecognitionWindow).SpeechRecognition ??
  (win as unknown as RecognitionWindow).webkitSpeechRecognition;

/** Transcription by the browser's own speech recognition, reported in the relay's shape. */
export function browserCapture(options: { language: string }, handlers: CaptureHandlers): Capture {
  const Recognizer = browserRecognition();
  let over = false;
  let failure: [CaptureEnd, string?] | null = null;
  if (!Recognizer) {
    queueMicrotask(() => handlers.failed('This browser has no speech recognition.'));
    return { finalize() {}, abort() {} };
  }
  const recognition = new Recognizer();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = options.language;
  recognition.onstart = () => {
    if (!over) handlers.listening();
  };
  recognition.onresult = (event) => {
    if (over) return;
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0]?.transcript ?? '';
      if (result.isFinal) handlers.transcript(text.trim(), true);
      else interim += text;
    }
    if (interim.trim()) handlers.transcript(interim.trim(), false);
  };
  recognition.onerror = (event) => {
    if (over) return;
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      over = true;
      handlers.denied();
    } else if (event.error === 'audio-capture') {
      over = true;
      handlers.noDevice();
    } else if (event.error === 'network') failure = ['network'];
    else if (event.error !== 'no-speech' && event.error !== 'aborted') failure = ['error'];
  };
  recognition.onend = () => {
    if (over) return;
    over = true;
    handlers.ended(...(failure ?? ['finalized']));
  };
  try {
    recognition.start();
  } catch {
    over = true;
    queueMicrotask(() => handlers.failed('Speech recognition could not start.'));
  }
  return {
    finalize() {
      if (!over) recognition.stop();
    },
    abort() {
      if (over) return;
      over = true;
      recognition.abort();
    },
  };
}

export type Speaker = { speak(text: string, done: () => void): void; cancel(): void };
/** Reads a reply through the browser's speech synthesis; null when the browser has none. */
export function browserSpeaker(win: Window = window): Speaker | null {
  const synthesis = win.speechSynthesis;
  if (!synthesis || typeof SpeechSynthesisUtterance === 'undefined') return null;
  let current: SpeechSynthesisUtterance | null = null;
  return {
    speak(text, done) {
      synthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      current = utterance;
      const finish = (): void => {
        if (current !== utterance) return;
        current = null;
        done();
      };
      utterance.onend = finish;
      utterance.onerror = finish;
      synthesis.speak(utterance);
    },
    cancel() {
      current = null;
      synthesis.cancel();
    },
  };
}
