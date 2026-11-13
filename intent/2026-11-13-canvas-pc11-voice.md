# Intent: Dictation and voice conversation in the canvas assistant (PC11)

**Status:** Draft

## Problem statement

The canvas assistant takes typed text only. Keys lists `B` (dictate) and Shift+B (voice conversation) as arriving later, and nothing handles them. A person cannot speak a message or hear a reply while working on the canvas.

## Proposed outcome

Two separate controls sit under the rail composer, each with its own binding and its own state line.

Dictation (`B` with the canvas focused, or its button) turns speech into editable text in the composer draft. It never sends. Stopping it leaves the text for the person to edit and send.

Voice conversation (Shift+B, or its button) is a mode of explicit spoken turns. Each turn is captured, transcribed, shown as the text that will be sent, and sent as an ordinary conversation message through the existing send path with the committed context chips of that moment. When the agent's reply for that turn arrives it is spoken, and a visible Stop speaking action (and Escape) interrupts playback. A turn can be cancelled before it is sent and retried after a failure without sending twice.

Capability is decided from what is really configured and present, never assumed:

- Transcription uses the server's existing Claude voice relay when `claudeVoiceEnabled` is on, otherwise the browser's own speech recognition when the browser has one. With neither, both controls say so in line and text entry stays available.
- Playback uses the browser's speech synthesis. Without it, voice conversation still takes spoken turns and says replies are shown as text only.
- A denied microphone permission, a missing device, a lost network or relay, and an interrupted capture each have their own truthful state. Nothing claims to be listening when it is not.

While the microphone is capturing, a small indicator with a Stop action stays visible on the canvas even when the rail is closed. Closing or switching the rail neither starts nor stops capture silently. Only a person's key press or tap can start capture; no agent command, view command or background task can.

The phone has both controls as tap targets, sized and placed by the phone assistant's rules.

Keys lists `B` and Shift+B as live bindings.

## Affected users and systems

People using the canvas assistant on desktop and phone. `packages/canvas/src/` (a new voice module, `assistant.ts`, `shortcuts.ts`, `entry.ts`, `mobile.ts`), `src/web/public/canvas.{html,css}`, a read of whether the Claude relay is enabled, and their tests. The server's voice relay and the dashboard's own voice input are used as they are and not changed in behaviour.

## Constraints

- A spoken turn is an ordinary message: same send route, same message id discipline, same rate limit, same refusals. No new write path to a pane and no new server route that accepts audio beyond the existing relay.
- The relay's rules hold: the token never reaches the page, credentials are read only, capture is linear16 at 16 kHz mono through the existing worklet, and transcript frames are cumulative (replace, never append).
- `B` and Shift+B act only with the canvas focused, never while typing in a text field, a terminal or an embed, and never during IME composition. Key repeat does not toggle twice. One key never means both toggle and hold-to-talk.
- Capture ends on Stop, Escape, page hide, and loss of the device or the relay. It is never left running without the indicator.
- Nothing is stored that the previous release cannot ignore. Audio is never stored.
- Everything stays behind `canvasEnabled`. Public repository: no hostnames, ports, users or paths.

## Open questions

- Which reply text is spoken: the agent's text rows for the turn, without tool output, cut at a bound so a long answer does not speak for minutes; the rest is on screen.
- Deepgram, the dashboard's third provider, needs a key held in server settings and is not offered on the canvas in this change.

## Decisions

Settled while building; none changes the outcome above.

- Whether the relay can be used reaches the page as one boolean, `voice.relay`, on the existing `GET /api/canvas/assistant/providers` answer. It is true only when `claudeVoiceEnabled` is on and the server has a usable Claude sign-in. Nothing else about voice is exposed.
- The capture worklet is the dashboard's file, loaded by URL and not copied. The canvas page carries a `<link rel="codeman-voice-worklet">` that fetches nothing; the server stamps it with the worklet's own modification time like every other asset reference, and the page loads the module from that URL, so an edited worklet is never served from an old cache entry.
- Without an AudioWorklet the relay path is not offered; there is no ScriptProcessor fallback. Deepgram is not offered. Nothing stops capture on silence.
- Voice text always lands in the composer's draft, after whatever was typed. A conversation turn sends the composer's content through the ordinary send, so typed text before the speech travels with it.
- A conversation turn is two presses of the same control: start, then end. Only that second press leads to a send, and the finished text is shown for three seconds with Cancel before it goes. Stop on the indicator finishes the transcript without sending. Escape, a hidden page, an edit to the draft, IME composition and going offline end capture without sending. The text is kept in every case.
- While one control captures, the other control's key or tap does nothing; a press while a transcript is finishing or a send is counting down does nothing.
- A window that loses focus keeps capturing with the indicator showing. A hidden page ends capture and playback.
- Muted means the microphone track reports itself muted (a hardware switch or the system). A missing device is its own state and the control can be tried again.
- The spoken reply is the agent's text rows after that prompt, up to the next prompt that was not queued, with no tool output, read once when the turn is no longer working or waiting. It is cut at about 600 characters at a sentence end and followed by "The rest of the reply is on screen." A reply that arrives while the microphone is capturing is left on screen and not spoken.
- Without speech synthesis the turn is still sent and the state line says replies are shown as text only.
- Any send of the turn's text counts as that turn (the countdown, Send, or Retry after a failure), so Retry reuses the same message id and the reply to it is still spoken.
- The indicator also shows while the microphone is being opened and while a reply is spoken (with Stop speaking). Starting from the board opens the assistant rail without moving focus.
- Only a trusted key press or click starts capture: a scripted click or a synthetic key event does nothing. The start function is private to the voice view, which registers its own listeners; it is not a view command, is not on `window`, and no assistant or agent path can call it.
- On a phone the controls are tap targets only; a hardware `B` does nothing there.

## Verification limits

Every check used controlled fixtures: an oscillator as the microphone stream, a scripted relay socket, and recorders in place of speech recognition and synthesis. No real microphone was opened and no real audio was transcribed or spoken.
