/**
 * @fileoverview A session's terminal as a full view over the canvas (PC13).
 *
 * The full view is Codeman's own single-session page (`session/<id>`), never terminal code of the canvas's
 * own. With a hardware keyboard the page opens in ONE same-origin frame that covers the canvas, which stays
 * loaded underneath. On a phone or any touch-first device the window navigates to the page and a one-use
 * return ticket brings the view back. The canvas sends the page nothing: it only hears two messages from
 * it, "ready" and "close", and only from the frame it opened, on its own origin.
 */
import type { RailView } from './commands.js';
import { RAIL_VIEWS } from '../../../src/canvas/view-schema.js';
import type { Viewport } from './viewport.js';

export const FULL_VIEW_TIMEOUT_MS = 10_000;
export const TICKET_MAX_AGE_MS = 12 * 60 * 60 * 1000;
/** What the session page uses in its terminal. A same-origin frame has these already; the list says so. */
export const FULL_VIEW_ALLOW = 'clipboard-read; clipboard-write; microphone';
const ID = /^[a-zA-Z0-9_-]{1,128}$/;

export type FullViewMode = 'frame' | 'navigate';
/** One rule: the canvas's own phone and touch test. A software keyboard is wrong inside a frame. */
export const fullViewMode = (env: { phone: boolean; touch: boolean }): FullViewMode =>
  env.phone || env.touch ? 'navigate' : 'frame';

/**
 * The session page's address, relative to the server root. Built from a listed id and this page's workspace only.
 * `passive` marks an agent's open: that page shows the session and starts nothing by itself.
 */
export const fullViewPath = (sessionId: string, workspaceId: string, passive = false): string =>
  `/session/${encodeURIComponent(sessionId)}?from=canvas&ws=${encodeURIComponent(workspaceId)}${passive ? '&passive=1' : ''}`;

/**
 * Why an agent's open changes nothing in this view, or null when it may open. An agent's command only steers
 * the view: it never takes the page a person is typing on, navigates their window or opens what has ended.
 */
export function agentOpenRefusal(view: {
  shell: boolean;
  /** The listed row's state, or undefined when this view does not list the session. */
  state: string | undefined;
  navigates: boolean;
  typing: boolean;
}): string | null {
  if (!view.shell) return 'This view is not a canvas shell page, so it has no full view.';
  if (view.state === undefined) return 'This view does not list that session.';
  if (view.state === 'done') return 'That session has ended. A person can start it again from its own page.';
  if (view.navigates) return 'This view is on a phone or touch device, where a full view would take the page away.';
  if (view.typing) return 'The person is typing on the canvas. Nothing was opened; try again later.';
  return null;
}
/** Why an agent's close leaves the full view open, or null when it may close. */
export const agentCloseRefusal = (typing: boolean): string | null =>
  typing ? 'The person is typing in that full view. It was left open; try again later.' : null;
/** True while keyboard focus is somewhere a person types text. A focused frame is the terminal of a full view. */
export function typingIn(active: Element | null): boolean {
  if (!(active instanceof HTMLElement)) return false;
  if (
    active.isContentEditable ||
    active instanceof HTMLTextAreaElement ||
    active instanceof HTMLSelectElement ||
    active instanceof HTMLIFrameElement
  )
    return true;
  return (
    active instanceof HTMLInputElement &&
    !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image'].includes(active.type)
  );
}

/** The session id of a `?session=<id>` address (a notification opened this page), or null. */
export function sessionFromSearch(search: string): string | null {
  const id = new URLSearchParams(search).get('session');
  return id && ID.test(id) ? id : null;
}
/** The session a service worker's `notification-click` message names, or null. */
export function sessionFromNotification(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const { type, sessionId } = data as { type?: unknown; sessionId?: unknown };
  return type === 'notification-click' && typeof sessionId === 'string' && ID.test(sessionId) ? sessionId : null;
}

export type FullViewSignal = 'ready' | 'close';
/** A message counts only from the opened frame's own window, on this page's origin, with a known type. */
export function fullViewSignal(
  event: { origin: string; source: unknown; data: unknown },
  expected: { origin: string; source: unknown }
): FullViewSignal | null {
  if (!expected.source || event.source !== expected.source || event.origin !== expected.origin) return null;
  const type = typeof event.data === 'object' && event.data !== null ? (event.data as { type?: unknown }).type : null;
  if (type === 'codeman:full-view-ready') return 'ready';
  if (type === 'codeman:full-view-close') return 'close';
  return null;
}

/** What the canvas restores after the window went to a session page and came back. */
export type ReturnTicket = {
  workspaceId: string;
  sessionId: string;
  viewport: Viewport;
  selected: string[];
  focusId: string | null;
  rail: RailView[];
  outlineOpen: boolean;
  root: string | null;
  at: number;
};
export const makeTicket = (ticket: Omit<ReturnTicket, 'at'>, now: number): string =>
  JSON.stringify({ ...ticket, selected: ticket.selected.slice(0, 1000), at: now });

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const idOrNull = (v: unknown): string | null => (typeof v === 'string' && ID.test(v) ? v : null);
/** A stored ticket, or null when it is malformed, for another workspace, or older than twelve hours. */
export function parseTicket(raw: string | null, workspaceId: string, now: number): ReturnTicket | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const t = data as Record<string, unknown>;
  if (t.workspaceId !== workspaceId || !finite(t.at) || t.at > now || now - t.at >= TICKET_MAX_AGE_MS) return null;
  const v = t.viewport as Record<string, unknown> | null;
  if (typeof v !== 'object' || v === null || !finite(v.x) || !finite(v.y) || !finite(v.zoom)) return null;
  if (v.zoom < 0.1 || v.zoom > 4) return null;
  const sessionId = idOrNull(t.sessionId);
  if (!sessionId || !Array.isArray(t.selected) || !Array.isArray(t.rail)) return null;
  return {
    workspaceId,
    sessionId,
    viewport: { x: v.x, y: v.y, zoom: v.zoom },
    selected: t.selected.filter((id): id is string => idOrNull(id) !== null).slice(0, 1000),
    focusId: idOrNull(t.focusId),
    rail: t.rail.filter((r): r is RailView => (RAIL_VIEWS as readonly unknown[]).includes(r)).slice(0, 8),
    outlineOpen: t.outlineOpen !== false,
    root: idOrNull(t.root),
    at: t.at,
  };
}
/** Reads the ticket once: whatever it holds, it is gone afterwards. */
export function takeTicket(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  key: string,
  workspaceId: string,
  now: number
): ReturnTicket | null {
  try {
    const raw = storage.getItem(key);
    if (raw !== null) storage.removeItem(key);
    return parseTicket(raw, workspaceId, now);
  } catch {
    return null;
  }
}

function element<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`Missing canvas element: ${id}`);
  return el;
}

export type FullViewHost = {
  url(path: string): string;
  workspaceId: string;
  /** Ends a microphone capture and sends nothing, as hiding the page does. */
  conceal(): void;
  /** The full view closed by its own page, its error state or Escape. */
  closed(): void;
};

/** The frame, its error state and the inert canvas under it. At most one is open. */
export class FullView {
  private frame: HTMLIFrameElement | null = null;
  private sessionId: string | null = null;
  private name = '';
  private passive = false;
  private opener: HTMLElement | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inerted: HTMLElement[] = [];
  private host = element('fullView', HTMLElement);
  private slot = element('fullViewFrame', HTMLElement);
  private error = element('fullViewError', HTMLElement);

  constructor(private options: FullViewHost) {
    window.addEventListener('message', (event) => {
      const signal = fullViewSignal(event, { origin: location.origin, source: this.frame?.contentWindow ?? null });
      if (signal === 'ready') this.settle();
      else if (signal === 'close') this.dismiss();
    });
    // While a full view is open the canvas takes no keys. A key arrives here only when focus is on the canvas
    // page (inside the frame, the session page has them), and then Escape closes the view.
    window.addEventListener(
      'keydown',
      (event) => {
        if (this.sessionId === null) return;
        if (this.error.contains(event.target as Node) && event.key !== 'Escape') return;
        event.stopImmediatePropagation();
        if (event.key !== 'Escape') return;
        event.preventDefault();
        this.dismiss();
      },
      true
    );
    element('fullViewRetry', HTMLButtonElement).onclick = () => {
      if (this.sessionId !== null) this.mount(true);
    };
    element('fullViewBack', HTMLButtonElement).onclick = () => this.dismiss();
  }

  current(): string | null {
    return this.sessionId;
  }

  /** Opens `sessionId`'s page over the canvas, replacing any open one. `focus: false` is an agent's open. */
  open(sessionId: string, name: string, opener: HTMLElement | null, focus: boolean): void {
    this.options.conceal();
    if (this.sessionId === null) {
      this.opener = opener;
      for (const child of document.body.children) {
        if (!(child instanceof HTMLElement) || child === this.host || child.inert) continue;
        child.inert = true;
        this.inerted.push(child);
      }
    }
    this.sessionId = sessionId;
    this.name = name;
    this.passive = !focus;
    this.host.hidden = false;
    this.mount(focus);
  }

  private mount(focus: boolean): void {
    clearTimeout(this.timer);
    this.frame?.remove();
    this.error.hidden = true;
    const frame = document.createElement('iframe');
    // No `sandbox`: this is Codeman's own page from a fixed prefix and a listed session id, and it needs the
    // sign-in cookie. Nothing from an object or from agent text reaches this address.
    frame.title = `Terminal of ${this.name}`;
    frame.allow = FULL_VIEW_ALLOW;
    frame.src = this.options.url(fullViewPath(this.sessionId ?? '', this.options.workspaceId, this.passive));
    this.frame = frame;
    this.slot.replaceChildren(frame);
    if (this.passive) this.hold(frame);
    else if (focus) frame.focus({ preventScroll: true });
    this.timer = setTimeout(() => this.failed(), FULL_VIEW_TIMEOUT_MS);
  }

  /**
   * An agent's open is shown, not handed over. The `passive` page takes no focus by itself until this frame is
   * focused; the frame is inert and covered so no click or Tab reaches it before the person takes it.
   */
  private hold(frame: HTMLIFrameElement): void {
    frame.inert = true;
    const take = document.createElement('button');
    take.type = 'button';
    take.className = 'full-view-take';
    take.textContent = 'An agent opened this terminal. Click to use it, or press Escape to close.';
    take.onclick = () => {
      take.remove();
      frame.inert = false;
      frame.focus({ preventScroll: true });
    };
    this.slot.append(take);
  }

  private settle(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** The page did not say it was ready: the frame goes and the canvas says so in its place. */
  private failed(): void {
    this.timer = undefined;
    const hadFocus = document.activeElement === this.frame;
    this.slot.replaceChildren();
    this.frame = null;
    const classic = element('fullViewClassic', HTMLAnchorElement);
    classic.href = `${this.options.url('/classic')}#session=${encodeURIComponent(this.sessionId ?? '')}`;
    this.error.hidden = false;
    if (hadFocus || document.activeElement === document.body)
      element('fullViewRetry', HTMLButtonElement).focus({ preventScroll: true });
  }

  private dismiss(): void {
    if (this.sessionId === null) return;
    this.close(true);
    this.options.closed();
  }

  /** Removes the frame (never hides it: a hidden terminal would keep holding a size) and gives the canvas back. */
  close(focus: boolean): void {
    if (this.sessionId === null) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.slot.replaceChildren();
    this.frame = null;
    this.sessionId = null;
    this.error.hidden = true;
    this.host.hidden = true;
    for (const child of this.inerted) child.inert = false;
    this.inerted = [];
    const opener = this.opener;
    this.opener = null;
    if (!focus) return;
    // The row may have been redrawn while the view was open: the same session's row stands in.
    const again =
      opener && !opener.isConnected && opener.dataset.sessionId
        ? [
            ...document.querySelectorAll<HTMLElement>(`#sessionRows button.${opener.classList[0] ?? 'session-row'}`),
          ].find((b) => b.dataset.sessionId === opener.dataset.sessionId)
        : opener;
    (again?.isConnected ? again : element('board', HTMLElement)).focus({ preventScroll: true });
  }
}
