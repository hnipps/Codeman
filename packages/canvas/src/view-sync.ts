import {
  MIN_PUBLISH_GAP_MS,
  PublishedViewSchema,
  ViewCommandEventSchema,
  type PublishedView,
  type ViewAction,
} from '../../../src/canvas/view-schema.js';

export type ViewReport = Omit<PublishedView, 'appliedCommands'>;
/** How long a publish must still wait so one view never sends more than four a second. */
export const publishDelay = (now: number, lastSentAt: number, gap = MIN_PUBLISH_GAP_MS): number =>
  Math.max(0, lastSentAt + gap - now);
/** A tab keeps a stable identity for its life; a reload in the same tab keeps it, a new tab does not. */
export function tabViewId(storage: Pick<Storage, 'getItem' | 'setItem'> = sessionStorage): string {
  const key = 'codeman:canvas:viewId';
  try {
    const stored = storage.getItem(key);
    if (stored && /^[0-9a-f-]{36}$/.test(stored)) return stored;
    const made = crypto.randomUUID();
    storage.setItem(key, made);
    return made;
  } catch {
    return crypto.randomUUID();
  }
}
const HEARTBEAT_MS = 20_000;
/**
 * Publishes this tab's view so agents can read it, and applies the commands they send. Publishing is
 * debounced and never faster than the server accepts; a command is acknowledged in the next publish.
 */
export class ViewSync {
  readonly viewId = tabViewId();
  private last = '';
  private lastSentAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private applied: string[] = [];
  private beat: ReturnType<typeof setInterval> | undefined;
  constructor(
    private options: {
      url: (path: string) => string;
      workspace: string;
      read: () => ViewReport;
      apply: (action: ViewAction) => void;
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
    if (this.applied.includes(event.commandId)) return;
    this.options.apply(event.command);
    this.applied = [...this.applied, event.commandId].slice(-20);
    this.schedule(true);
  }
  private schedule(force: boolean): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.send(force);
      },
      Math.max(publishDelay(Date.now(), this.lastSentAt, MIN_PUBLISH_GAP_MS + 50), 50)
    );
  }
  private async send(force: boolean): Promise<void> {
    const body = JSON.stringify({ ...this.options.read(), appliedCommands: this.applied });
    if (!force && body === this.last) return;
    if (!PublishedViewSchema.safeParse(JSON.parse(body)).success) return;
    this.lastSentAt = Date.now();
    try {
      const response = await fetch(this.options.url(`/api/canvas/${this.options.workspace}/views/${this.viewId}`), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body,
      });
      if (response.ok) this.last = body;
      else if (response.status === 429) this.schedule(force);
    } catch {
      /* The next change or heartbeat publishes again. */
    }
  }
  stop(): void {
    clearTimeout(this.timer);
    clearInterval(this.beat);
  }
}
