/** @fileoverview Delivering one conversation prompt so that "delivered" means SUBMITTED, not pasted. Claude Code ignores Enter for 30 to 50 s after its composer paints, and a multi-line paste cannot be recognised by `SubmitVerifier`, so the paste waits for a ready composer and is then confirmed from evidence (the CLI's prompt-submitted hook, or an empty composer) with Enter alone re-sent while the composer still holds the text. The decisions are pure; the runner takes its pane, writes and clock as dependencies so tests drive it with a fake clock. */
import { composerIsEmpty, plainFrame } from '../session-submit-verifier.js';

/** How long a paste waits for a ready, empty composer before nothing is written. */
export const READY_MAX_MS = 60_000;
/** How long, after the paste, before a prompt that never left the composer is reported not delivered. */
export const CONFIRM_MAX_MS = 90_000;
export const POLL_MS = 1_000;
const FIRST_ENTER_MS = 2_000;
const ENTER_EVERY_MS = 5_000;
export const MAX_ENTERS = 10;

/** The composer has painted: the CLI's ready footer is on screen (no mark declared means no evidence is needed). */
export const composerReady = (styledScreen: string, mark: string): boolean =>
  !mark || plainFrame(styledScreen).includes(mark);

export type ConfirmStep = 'confirmed' | 'press-enter' | 'wait' | 'timeout';
export type ConfirmInput = {
  /** When the CLI last reported a submitted prompt (0 if never), and when this prompt was written. */
  hookAt: number;
  wroteAt: number;
  /** From `composerIsEmpty()`: undefined when the screen shows no composer to read. */
  composerEmpty: boolean | undefined;
  elapsedMs: number;
  enters: number;
  sinceEnterMs: number;
  /** A retry of text already in the composer may press Enter at once. */
  immediate?: boolean;
};
/**
 * What to do next for a prompt that was pasted: a submitted hook after the write, or an empty composer, is
 * confirmation; text still in the composer earns an Enter (never another paste) on a schedule; no readable
 * composer earns nothing but waiting, since a blind Enter could confirm a dialog nobody asked about.
 */
export function confirmStep(i: ConfirmInput): ConfirmStep {
  if (i.hookAt > i.wroteAt) return 'confirmed';
  if (i.composerEmpty === true) return 'confirmed';
  if (i.elapsedMs >= CONFIRM_MAX_MS || i.enters >= MAX_ENTERS) return 'timeout';
  if (i.composerEmpty === false) {
    if (i.enters === 0 ? i.immediate || i.elapsedMs >= FIRST_ENTER_MS : i.sinceEnterMs >= ENTER_EVERY_MS)
      return 'press-enter';
  }
  return 'wait';
}

export type RetryPlan = 'confirmed' | 'enter-only' | 'paste';
/** A retry first looks: a prompt submitted since it was sent is done, text in the composer needs Enter only, anything else is pasted again. */
export function retryPlan(styledScreen: string | null, glyph: string, hookAt: number, sentAt: number): RetryPlan {
  if (hookAt >= sentAt) return 'confirmed';
  if (styledScreen !== null && composerIsEmpty(styledScreen, glyph) === false) return 'enter-only';
  return 'paste';
}

export interface DeliveryDeps {
  /** The styled pane, or null when there is no pane to read. */
  snapshot(): string | null;
  paste(): Promise<boolean>;
  enter(): Promise<boolean>;
  hookAt(): number;
  glyph: string;
  readyMark: string;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** The message is no longer wanted (its task was cancelled): stop waiting for a composer and write nothing. */
  abandoned?(): boolean;
}
/** `unverified`: written, but no pane exists to confirm from (a direct PTY); `not-ready`: nothing was written. */
export type DeliveryResult = 'confirmed' | 'unverified' | 'not-written' | 'not-ready' | 'timeout';

export async function deliver(
  deps: DeliveryDeps,
  mode: 'paste' | 'enter-only',
  sentAt: number
): Promise<DeliveryResult> {
  const began = deps.now();
  let wroteAt = sentAt;
  if (mode === 'paste') {
    if (deps.snapshot() === null) return (await deps.paste()) ? 'unverified' : 'not-written';
    for (;;) {
      const screen = deps.snapshot();
      if (screen !== null && composerReady(screen, deps.readyMark) && composerIsEmpty(screen, deps.glyph) !== false)
        break;
      if (deps.abandoned?.()) return 'not-written';
      if (deps.now() - began >= READY_MAX_MS) return 'not-ready';
      await deps.sleep(POLL_MS);
    }
    wroteAt = deps.now();
    if (!(await deps.paste())) return 'not-written';
  }
  const from = deps.now();
  let enters = 0;
  let lastEnter = from;
  for (;;) {
    await deps.sleep(mode === 'enter-only' && enters === 0 ? 0 : POLL_MS);
    const screen = deps.snapshot();
    const step = confirmStep({
      hookAt: deps.hookAt(),
      wroteAt,
      composerEmpty: screen === null ? undefined : composerIsEmpty(screen, deps.glyph),
      elapsedMs: deps.now() - from,
      enters,
      sinceEnterMs: deps.now() - lastEnter,
      immediate: mode === 'enter-only',
    });
    if (step === 'confirmed') return 'confirmed';
    if (step === 'timeout') return 'timeout';
    if (step === 'press-enter') {
      enters++;
      lastEnter = deps.now();
      await deps.enter().catch(() => false);
    }
  }
}
