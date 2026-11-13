/**
 * @fileoverview What the canvas pages write to the UI event stream. The reporter itself is the dashboard's
 * `ui-events.js`, loaded ahead of the bundle; a page without it records nothing. Every value is a token: an
 * action name, and an id, a tool name or a state word. No label, draft, prompt or object text is passed.
 */
import type { ViewCommand } from './commands.js';

type Reporter = { record: (surface: 'canvas', action: string, target?: string | null) => boolean };

export function uiEvent(action: string, target: string | null = null, win: Window = window): void {
  (win as Window & { CodemanUiEvents?: Reporter }).CodemanUiEvents?.record('canvas', action, target);
}

/**
 * The event a view command leaves, or null. Camera, focus, selection and context commands are left out: they
 * run per frame or per key, and the view registry already holds their result. `top` is the rail view on top
 * before the command: Escape and the rail's close button pop it without naming it.
 */
export function viewEvent(action: ViewCommand, top?: string): [action: string, target: string | null] | null {
  switch (action.kind) {
    case 'tool':
      return ['tool', action.tool];
    case 'outline':
      return ['outline', action.open ? 'open' : 'closed'];
    case 'rail':
      return ['rail.open', action.view];
    case 'rail-close':
      return ['rail.close', action.view];
    case 'escape':
      return top ? ['rail.close', top] : null;
    case 'conversation':
      return ['conversation.show', action.id];
    case 'full-view':
      return action.sessionId ? ['full-view.open', action.sessionId] : ['full-view.close', null];
    case 'letters':
      return ['letters', action.enabled ? 'on' : 'off'];
    case 'enter':
      return ['subcanvas.enter', action.id];
    case 'leave':
      return ['subcanvas.leave', null];
    default:
      return null;
  }
}

/** A click on a link to the classic view leaves the page, so it is recorded by the link's own id. */
export function reportClassicLinks(win: Window = window): void {
  win.document.addEventListener(
    'click',
    (event) => {
      const link = (event.target as Element | null)?.closest?.('a[href^="classic"], a[href*="view=classic"]');
      if (link?.id) uiEvent('classic.open', link.id, win);
    },
    true
  );
}
