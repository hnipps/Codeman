import { splitPrompt } from '../../../src/canvas/conversation-schema.js';
import type { TranscriptRow } from './conversation.js';

/** Dictation fills the draft and never sends; a voice conversation turn is sent when the person ends it. */
export type VoiceMode = 'dictation' | 'conversation';
export type VoicePhase =
  | 'idle'
  | 'requesting-permission'
  | 'listening'
  | 'processing'
  | 'ready-to-send'
  | 'speaking'
  | 'muted'
  | 'denied'
  | 'unavailable'
  | 'error';

/** What this page and its server really have. Nothing here is assumed. */
export type VoiceEnv = {
  /** The server's Claude voice relay is switched on and has a usable login. */
  relay: boolean;
  /** `navigator.mediaDevices.getUserMedia` exists (a secure page). */
  microphone: boolean;
  /** An AudioContext with an AudioWorklet, which the relay's PCM capture needs. */
  worklet: boolean;
  socket: boolean;
  /** The browser's own SpeechRecognition. */
  recognition: boolean;
  synthesis: boolean;
};
export type VoiceCapability = { transcription: 'relay' | 'browser' | null; playback: boolean; reason: string };

/** The one capability decision the controls, the state lines and the tests read. */
export function voiceCapability(env: VoiceEnv): VoiceCapability {
  const playback = env.synthesis;
  if (env.relay && env.microphone && env.worklet && env.socket) return { transcription: 'relay', playback, reason: '' };
  if (env.recognition) return { transcription: 'browser', playback, reason: '' };
  return {
    transcription: null,
    playback,
    reason: env.relay
      ? 'Voice input is not available: this page cannot open a microphone. Type your message instead.'
      : 'Voice input is not available: Claude voice is off on this server and this browser has no speech recognition. Type your message instead.',
  };
}

export type VoiceState = {
  phase: VoicePhase;
  /** The control the current phase belongs to; null when neither has been used or the capability itself is missing. */
  mode: VoiceMode | null;
  capability: VoiceCapability;
  /** The draft as it was when capture began; spoken text is placed after it. */
  base: string;
  /** Utterances the transcriber has finished. */
  heard: string;
  /** The running transcript of the utterance in progress. Each frame replaces it. */
  interim: string;
  /** Whether the transcript, once final, becomes a turn to send. Only the person ending a conversation turn sets it. */
  sendOnEnd: boolean;
  /** `processing` covers finishing the transcript and, when this is set, the send itself. */
  sending: boolean;
  /** The text of the spoken turn handed to the send path, kept so a retry of the same text is still that turn. */
  turnText: string | null;
  /** The message whose reply will be read aloud. */
  awaiting: string | null;
  message: string;
  /** Counts captures, so a late callback from an earlier one is dropped. */
  capture: number;
};

export type CaptureEnd = 'finalized' | 'relay-closed' | 'device-lost' | 'network' | 'unavailable' | 'error';
export type VoiceEvent =
  | { type: 'capability'; capability: VoiceCapability }
  /** A key press or a tap on a control. `allowed` is false while typing, composing or outside the canvas. */
  | { type: 'toggle'; mode: VoiceMode; allowed: boolean; repeat: boolean; draft: string }
  | { type: 'permission-granted' }
  | { type: 'permission-denied' }
  | { type: 'no-device' }
  | { type: 'start-failed'; message: string }
  | { type: 'muted'; muted: boolean }
  | { type: 'transcript'; text: string; final: boolean }
  | { type: 'stop' }
  | { type: 'escape' }
  | { type: 'hidden' }
  | { type: 'blur' }
  | { type: 'composition' }
  | { type: 'edited' }
  | { type: 'offline' }
  | { type: 'capture-ended'; reason: CaptureEnd; message?: string }
  | { type: 'send-timer' }
  | { type: 'cancel' }
  | { type: 'sent'; messageId: string; text: string }
  | { type: 'send-failed' }
  | { type: 'reply'; text: string }
  | { type: 'reply-gone' }
  | { type: 'speech-end' }
  | { type: 'stop-speaking' };
export type VoiceEffect =
  | { kind: 'capture-start' }
  | { kind: 'capture-finalize' }
  | { kind: 'capture-abort' }
  | { kind: 'draft'; text: string }
  | { kind: 'send-timer' }
  | { kind: 'send-timer-clear' }
  | { kind: 'send' }
  | { kind: 'speak'; text: string }
  | { kind: 'speak-cancel' };
export type VoiceStep = { state: VoiceState; effects: VoiceEffect[] };

/** How long a transcribed turn stays on screen, cancellable, before it is sent. */
export const SEND_DELAY_MS = 3000;
/** A longer reply is cut here for speech; the whole of it is on screen. */
export const MAX_SPOKEN_CHARS = 600;

export const initialVoice = (capability: VoiceCapability): VoiceState => ({
  phase: capability.transcription ? 'idle' : 'unavailable',
  mode: null,
  capability,
  base: '',
  heard: '',
  interim: '',
  sendOnEnd: false,
  sending: false,
  turnText: null,
  awaiting: null,
  message: capability.transcription ? '' : capability.reason,
  capture: 0,
});

const words = (...parts: string[]): string =>
  parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(' ');
/** The draft a capture has produced so far: what was there, then what was heard. */
export function draftText(state: Pick<VoiceState, 'base' | 'heard' | 'interim'>): string {
  const spoken = words(state.heard, state.interim);
  if (!spoken) return state.base;
  return state.base && !/\s$/.test(state.base) ? `${state.base} ${spoken}` : `${state.base}${spoken}`;
}

/** The microphone is open, or being opened. */
export const capturing = (state: VoiceState): boolean =>
  state.phase === 'requesting-permission' || state.phase === 'listening' || state.phase === 'muted';
/** Escape has something of the voice controls to end before it closes a rail view. */
export const voiceBusy = (state: VoiceState): boolean =>
  capturing(state) ||
  state.phase === 'ready-to-send' ||
  state.phase === 'speaking' ||
  (state.phase === 'processing' && !state.sending);

const same = (state: VoiceState): VoiceStep => ({ state, effects: [] });
const settled = (state: VoiceState): VoiceState => ({
  ...state,
  heard: words(state.heard, state.interim),
  interim: '',
  sendOnEnd: false,
});
/** Ends a capture at once. Whatever was heard stays in the draft; nothing is sent. */
function halt(state: VoiceState, phase: VoicePhase, message: string): VoiceStep {
  return { state: { ...settled(state), phase, message }, effects: [{ kind: 'capture-abort' }] };
}
function interrupt(state: VoiceState, message: string, phase: VoicePhase = 'idle'): VoiceStep {
  if (capturing(state) || (state.phase === 'processing' && !state.sending)) return halt(state, phase, message);
  if (state.phase === 'ready-to-send')
    return {
      state: { ...state, phase, turnText: null, message: 'Not sent. Your message is in the box.' },
      effects: [{ kind: 'send-timer-clear' }],
    };
  return same(state);
}
const quiet = (state: VoiceState): VoiceStep => ({
  state: { ...state, phase: 'idle', message: 'Stopped speaking. The reply is on screen.' },
  effects: [{ kind: 'speak-cancel' }],
});
const stopped = (state: VoiceState): string =>
  state.mode === 'conversation' ? 'Stopped. Nothing was sent.' : 'Dictation stopped.';

export function voice(state: VoiceState, event: VoiceEvent): VoiceStep {
  switch (event.type) {
    case 'capability': {
      const next = { ...state, capability: event.capability };
      if (!event.capability.transcription && (state.phase === 'idle' || state.phase === 'unavailable'))
        return same({ ...next, phase: 'unavailable', mode: null, message: event.capability.reason });
      if (event.capability.transcription && state.phase === 'unavailable' && state.mode === null)
        return same({ ...next, phase: 'idle', message: '' });
      return same(next);
    }
    case 'toggle': {
      // A held key repeats, and a key typed into a field or during composition is text: neither is a press of the control.
      if (!event.allowed || event.repeat) return same(state);
      if (!state.capability.transcription)
        return same({ ...state, phase: 'unavailable', mode: null, message: state.capability.reason });
      if (capturing(state)) {
        // The other control's key does nothing while this one holds the microphone: a key never changes meaning mid-capture.
        if (state.mode !== event.mode) return same(state);
        if (state.phase === 'requesting-permission') return halt(state, 'idle', stopped(state));
        return {
          state: { ...state, phase: 'processing', sendOnEnd: state.mode === 'conversation', message: '' },
          effects: [{ kind: 'capture-finalize' }],
        };
      }
      if (state.phase === 'processing' || state.phase === 'ready-to-send') return same(state);
      return {
        state: {
          ...state,
          phase: 'requesting-permission',
          mode: event.mode,
          base: event.draft,
          heard: '',
          interim: '',
          sendOnEnd: false,
          sending: false,
          turnText: null,
          awaiting: null,
          message: '',
          capture: state.capture + 1,
        },
        // Starting to speak interrupts a reply that is being read aloud.
        effects: [
          ...(state.phase === 'speaking' ? [{ kind: 'speak-cancel' } as const] : []),
          { kind: 'capture-start' },
        ],
      };
    }
    case 'permission-granted':
      return same(state.phase === 'requesting-permission' ? { ...state, phase: 'listening' } : state);
    case 'permission-denied':
      // A recognizer can report the refusal after it reported starting.
      return capturing(state)
        ? halt(
            state,
            'denied',
            'Microphone access was denied. Allow it in the browser site settings, or type your message.'
          )
        : same(state);
    case 'no-device':
      return capturing(state)
        ? halt(state, 'unavailable', 'No microphone was found. Connect one, or type your message.')
        : same(state);
    case 'start-failed':
      return state.phase === 'requesting-permission' ? halt(state, 'error', event.message) : same(state);
    case 'muted':
      if (state.phase === 'listening' && event.muted) return same({ ...state, phase: 'muted' });
      if (state.phase === 'muted' && !event.muted) return same({ ...state, phase: 'listening' });
      return same(state);
    case 'transcript': {
      if (state.phase !== 'listening' && state.phase !== 'muted' && (state.phase !== 'processing' || state.sending))
        return same(state);
      // A frame is the whole utterance so far, so it replaces the last one; only a finished utterance is added.
      const next = event.final
        ? { ...state, heard: words(state.heard, event.text), interim: '' }
        : { ...state, interim: event.text };
      return { state: next, effects: [{ kind: 'draft', text: draftText(next) }] };
    }
    case 'stop':
      if (state.phase === 'speaking') return quiet(state);
      if (state.phase === 'listening' || state.phase === 'muted')
        return {
          state: { ...state, phase: 'processing', sendOnEnd: false, message: '' },
          effects: [{ kind: 'capture-finalize' }],
        };
      return interrupt(state, stopped(state));
    case 'escape':
      return state.phase === 'speaking' ? quiet(state) : interrupt(state, stopped(state));
    case 'hidden':
      if (state.phase === 'speaking') return quiet(state);
      return interrupt(state, 'Stopped because the page was hidden. Nothing was sent.');
    case 'blur':
      // The window is still on screen with its indicator, so capture goes on; a hidden page ends it.
      return same(state);
    case 'composition':
    case 'edited':
      return interrupt(state, 'Stopped while you type. Nothing was sent.');
    case 'offline':
      return interrupt(state, 'The connection was lost. What was heard is in the message box.', 'error');
    case 'capture-ended': {
      const live = capturing(state) || (state.phase === 'processing' && !state.sending);
      if (!live) return same(state);
      if (event.reason !== 'finalized') {
        const fallback: Record<Exclude<CaptureEnd, 'finalized'>, string> = {
          'relay-closed': 'The voice relay closed. What was heard is in the message box.',
          'device-lost': 'The microphone was disconnected. What was heard is in the message box.',
          network: 'Speech recognition lost its connection. What was heard is in the message box.',
          unavailable: 'Voice input is not available on this server right now. Type your message instead.',
          error: 'Voice input stopped with an error. What was heard is in the message box.',
        };
        return halt(state, 'error', event.message || fallback[event.reason]);
      }
      const done = settled(state);
      const text = draftText(done);
      if (state.phase === 'processing' && state.sendOnEnd && done.heard)
        return {
          state: { ...done, phase: 'ready-to-send', turnText: text, message: '' },
          effects: [{ kind: 'draft', text }, { kind: 'send-timer' }],
        };
      const message =
        state.phase !== 'processing'
          ? 'Listening ended. Nothing was sent.'
          : state.sendOnEnd
            ? 'Nothing was heard. Nothing was sent.'
            : '';
      return { state: { ...done, phase: 'idle', message }, effects: [{ kind: 'draft', text }] };
    }
    case 'send-timer':
      return state.phase === 'ready-to-send'
        ? { state: { ...state, phase: 'processing', sending: true }, effects: [{ kind: 'send' }] }
        : same(state);
    case 'cancel':
      return state.phase === 'ready-to-send' ? interrupt(state, '') : same(state);
    case 'sent': {
      // Any send of this turn's text is this turn: the timer's, Enter in the composer, or Retry after a failure.
      if (state.turnText === null || event.text !== state.turnText) return same(state);
      if (capturing(state) || state.phase === 'speaking') return same({ ...state, turnText: null });
      return {
        state: {
          ...state,
          phase: 'idle',
          mode: 'conversation',
          sending: false,
          turnText: null,
          awaiting: state.capability.playback ? event.messageId : null,
          message: state.capability.playback
            ? 'Sent. The reply will be read aloud.'
            : 'Sent. The reply will be shown as text: this browser has no speech synthesis.',
        },
        effects: state.phase === 'ready-to-send' ? [{ kind: 'send-timer-clear' }] : [],
      };
    }
    case 'send-failed':
      return state.phase === 'processing' && state.sending
        ? same({ ...state, phase: 'error', sending: false, message: 'Not sent. Your message is kept; use Retry.' })
        : same(state);
    case 'reply':
      if (!state.awaiting) return same(state);
      // A reply that lands while the person is speaking or about to send is left on screen.
      if (capturing(state) || state.phase === 'processing' || state.phase === 'ready-to-send')
        return same({ ...state, awaiting: null });
      return {
        state: { ...state, phase: 'speaking', mode: 'conversation', awaiting: null, message: '' },
        effects: [{ kind: 'speak', text: event.text }],
      };
    case 'reply-gone':
      return same(state.awaiting ? { ...state, awaiting: null, message: '' } : state);
    case 'speech-end':
      return same(state.phase === 'speaking' ? { ...state, phase: 'idle', message: '' } : state);
    case 'stop-speaking':
      return state.phase === 'speaking' ? quiet(state) : same(state);
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/** One truthful line per control. A missing capability is said on both; everything else on the control it belongs to. */
export function voiceLines(state: VoiceState): Record<VoiceMode, string> {
  const active = (mode: VoiceMode): string => {
    switch (state.phase) {
      case 'requesting-permission':
        return 'Waiting for the microphone…';
      case 'listening':
        return mode === 'dictation'
          ? 'Listening. Your words go into the message; nothing is sent.'
          : 'Listening. Press Voice again to send this turn, or Stop to keep it as text.';
      case 'muted':
        return 'The microphone is muted. Nothing is being heard.';
      case 'processing':
        return state.sending ? 'Sending…' : 'Finishing the transcript…';
      case 'ready-to-send':
        return `Sending the message above in ${Math.round(SEND_DELAY_MS / 1000)} seconds.`;
      case 'speaking':
        return 'Reading the reply aloud.';
      default:
        return state.message;
    }
  };
  const line = (mode: VoiceMode): string => {
    if (state.mode === null) return state.phase === 'unavailable' ? state.message : '';
    if (state.mode === mode) return active(mode);
    return '';
  };
  const conversation = line('conversation');
  return {
    dictation: line('dictation'),
    conversation:
      conversation ||
      (state.capability.transcription && !state.capability.playback && !capturing(state)
        ? 'Replies are shown as text only: this browser has no speech synthesis.'
        : ''),
  };
}

export type VoiceIndicator = { kind: 'microphone' | 'speaking'; text: string; action: string };
/** The fixed mark on the canvas: present whenever the microphone is open or a reply is being read, rail open or not. */
export function voiceIndicator(state: VoiceState): VoiceIndicator | null {
  const what = state.mode === 'conversation' ? 'voice turn' : 'dictation';
  switch (state.phase) {
    case 'requesting-permission':
      return { kind: 'microphone', text: 'Opening the microphone', action: 'Stop' };
    case 'listening':
      return { kind: 'microphone', text: `Microphone on · ${what}`, action: 'Stop' };
    case 'muted':
      return { kind: 'microphone', text: 'Microphone muted', action: 'Stop' };
    case 'speaking':
      return { kind: 'speaking', text: 'Reading the reply', action: 'Stop speaking' };
    default:
      return null;
  }
}

/**
 * The agent's text for one prompt: the reply rows between that prompt and the next, without tool output (the
 * transcript reader keeps only text). A reply longer than the bound is cut at a sentence and says the rest is on screen.
 */
export function spokenReply(
  rows: readonly TranscriptRow[],
  messageId: string,
  max = MAX_SPOKEN_CHARS
): { text: string; truncated: boolean } | null {
  const wanted = messageId.toLowerCase();
  const at = rows.findIndex((r) => r.role === 'user' && splitPrompt(r.text).messageId?.toLowerCase() === wanted);
  if (at < 0) return null;
  const parts: string[] = [];
  for (const row of rows.slice(at + 1)) {
    if (row.role === 'user') {
      // A prompt queued in the middle of the turn does not end the reply.
      if (row.queued) continue;
      break;
    }
    if (row.text.trim()) parts.push(row.text.trim());
  }
  const whole = parts.join('\n').replace(/\s+/g, ' ').trim();
  if (!whole) return null;
  if (whole.length <= max) return { text: whole, truncated: false };
  const head = whole.slice(0, max);
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '));
  const cut = sentence > max / 2 ? head.slice(0, sentence + 1) : head.slice(0, Math.max(head.lastIndexOf(' '), 1));
  return { text: `${cut.trim()} The rest of the reply is on screen.`, truncated: true };
}
