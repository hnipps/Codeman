import { uuid } from './ids.js';
import {
  MIN_PUBLISH_GAP_MS,
  PublishedViewSchema,
  ViewCommandEventSchema,
  type PublishedView,
  type ViewAction,
} from '../../../src/canvas/view-schema.js';

export type ViewReport = Omit<PublishedView, 'appliedCommands'>;
/**
 * How long a publish must still wait so one view never sends more than four a second. The gap runs from when
 * the previous publish was answered, not from when it was sent: the server counts from when it handled that
 * one, which is later than the send by however long the request waited, and never later than its answer.
 */
export const publishDelay = (now: number, lastAnsweredAt: number, gap = MIN_PUBLISH_GAP_MS): number =>
  Math.max(0, lastAnsweredAt + gap - now);
/** A tab keeps a stable identity for its life; a reload in the same tab keeps it, a new tab does not. */
export function tabViewId(storage: Pick<Storage, 'getItem' | 'setItem'> = sessionStorage): string {
  const key = 'codeman:canvas:viewId';
  try {
    const stored = storage.getItem(key);
    if (stored && /^[0-9a-f-]{36}$/.test(stored)) return stored;
    const made = uuid();
    storage.setItem(key, made);
    return made;
  } catch {
    return uuid();
  }
}
const HEARTBEAT_MS = 20_000;
/** A publish with no answer after this long is given up, so a stalled request cannot stop the view publishing. */
const PUBLISH_TIMEOUT_MS = 10_000;
/**
 * Publishes this tab's view so agents can read it, and applies the commands they send. Publishing is
 * debounced and never faster than the server accepts; a command is acknowledged in the next publish.
 */
export class ViewSync {
  readonly viewId = tabViewId();
  private last = '';
  /** Starts at load time: a reloaded tab waits out the gap its previous page may still be inside. */
  private lastAnsweredAt = Date.now();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = false;
  /** A publish asked for while one was in flight: its `force`, or undefined when none was. */
  private queued: boolean | undefined;
  private applied: string[] = [];
  private seen: string[] = [];
  private refused: { commandId: string; reason: string } | null = null;
  private beat: ReturnType<typeof setInterval> | undefined;
  constructor(
    private options: {
      url: (path: string) => string;
      workspace: string;
      read: () => ViewReport;
      /** Returns a plain reason when the view refused the command and changed nothing. */
      apply: (action: ViewAction) => string | void;
    }
  ) {
    this.beat = setInterval(() => this.schedule(true), HEARTBEAT_MS);
  }
  notify(): void {
    this.schedule(false);
  }
  /** Handles one `canvas:viewCommand` event; events for other views or workspaces are ignored. */
  receive(raw: string): void {
    let event;
    try {
      event = ViewCommandEventSchema.parse(JSON.parse(raw));
    } catch {
      return;
    }
    if (event.viewId !== this.viewId || event.workspaceId !== this.options.workspace) return;
    if (this.seen.includes(event.commandId)) return;
    this.seen = [...this.seen, event.commandId].slice(-40);
    // Only the latest command's refusal is reported: the next command replaces or clears it. A refused command
    // is never listed as applied.
    const reason = this.options.apply(event.command);
    this.refused = reason ? { commandId: event.commandId, reason } : null;
    if (!reason) this.applied = [...this.applied, event.commandId].slice(-20);
    this.schedule(true);
  }
  private schedule(force: boolean): void {
    if (this.inFlight) {
      this.queued = this.queued || force;
      return;
    }
    if (this.timer !== undefined) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.send(force);
      },
      Math.max(publishDelay(Date.now(), this.lastAnsweredAt, MIN_PUBLISH_GAP_MS + 50), 50)
    );
  }
  private async send(force: boolean): Promise<void> {
    const body = JSON.stringify({
      ...this.options.read(),
      appliedCommands: this.applied,
      ...(this.refused ? { refused: this.refused } : {}),
    });
    if (!force && body === this.last) return;
    if (!PublishedViewSchema.safeParse(JSON.parse(body)).success) return;
    this.inFlight = true;
    let limited = false;
    const abort = new AbortController();
    const giveUp = setTimeout(() => abort.abort(), PUBLISH_TIMEOUT_MS);
    try {
      const response = await fetch(this.options.url(`/api/canvas/${this.options.workspace}/views/${this.viewId}`), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body,
        signal: abort.signal,
      });
      if (response.ok) this.last = body;
      else limited = response.status === 429;
    } catch {
      /* The next change or heartbeat publishes again. */
    }
    clearTimeout(giveUp);
    this.lastAnsweredAt = Date.now();
    this.inFlight = false;
    const queued = this.queued;
    this.queued = undefined;
    if (limited || queued !== undefined) this.schedule((limited && force) || queued === true);
  }
  stop(): void {
    clearTimeout(this.timer);
    clearInterval(this.beat);
  }
}
