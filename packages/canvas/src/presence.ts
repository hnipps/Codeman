/**
 * @fileoverview Whether this tab is in front of a person. A canvas tab in the background keeps no live frame
 * and stops being an open view, so the server stops serving the workspace's prototypes for it.
 *
 * Hiding is not acted on at once: a quick switch to another tab and back must not reload every page, so the
 * tab is `leaving` for a grace period first. Showing the tab again is acted on at once.
 */
export const HIDDEN_GRACE_MS = 4000;

export type Presence = 'shown' | 'leaving' | 'away';
export type PresenceEvent = 'hidden' | 'visible' | 'grace-over';
export type PresenceEffect = 'start-grace' | 'cancel-grace' | 'suspend' | 'resume';

/** The next state and the one thing to do about it, or null when the event changes nothing. */
export function presenceStep(
  state: Presence,
  event: PresenceEvent
): { state: Presence; effect: PresenceEffect | null } {
  if (state === 'shown' && event === 'hidden') return { state: 'leaving', effect: 'start-grace' };
  if (state === 'leaving' && event === 'visible') return { state: 'shown', effect: 'cancel-grace' };
  if (state === 'leaving' && event === 'grace-over') return { state: 'away', effect: 'suspend' };
  if (state === 'away' && event === 'visible') return { state: 'shown', effect: 'resume' };
  return { state, effect: null };
}

/** Follows the document's visibility and calls `suspend` and `resume`. A tab that loads hidden starts leaving. */
export function watchPresence(
  hooks: { suspend: () => void; resume: () => void },
  doc: Pick<Document, 'visibilityState' | 'addEventListener'> = document,
  graceMs = HIDDEN_GRACE_MS
): () => Presence {
  let state: Presence = 'shown';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const on = (event: PresenceEvent): void => {
    const next = presenceStep(state, event);
    state = next.state;
    if (next.effect === 'start-grace') timer = setTimeout(() => on('grace-over'), graceMs);
    else if (next.effect === 'cancel-grace') clearTimeout(timer);
    else if (next.effect === 'suspend') hooks.suspend();
    else if (next.effect === 'resume') hooks.resume();
  };
  const read = (): void => on(doc.visibilityState === 'hidden' ? 'hidden' : 'visible');
  doc.addEventListener('visibilitychange', read);
  read();
  return () => state;
}
