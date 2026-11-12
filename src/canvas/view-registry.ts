/** @fileoverview In-memory registry of the canvas views browsers publish, so agents can read and steer them. Nothing here is persisted: view state is ephemeral and must never steal a human's place after a reload. */
import { createHash, randomUUID } from 'node:crypto';
import { MIN_PUBLISH_GAP_MS, type PublishedView, type ViewAction } from './view-schema.js';

export const VIEW_TTL_MS = 60_000;
export const MAX_VIEWS_PER_WORKSPACE = 32;
const REQUEST_TTL_MS = 10 * 60_000;
type Entry = { state: PublishedView; owner: string | undefined; seenAt: number; lastPublishAt: number };
export type PublishResult = { ok: true } | { ok: false; code: 'RATE_LIMITED' | 'FORBIDDEN' | 'TOO_MANY_VIEWS' };
export type CommandResult =
  | { ok: true; commandId: string; duplicate: boolean; owner: string | undefined }
  | { ok: false; code: 'VIEW_GONE' | 'REQUEST_REUSED' };
export type ViewRecord = { viewId: string; ageMs: number; state: PublishedView };

export class ViewRegistry {
  private views = new Map<string, Entry>();
  private requests = new Map<string, { at: number; fingerprint: string; commandId: string }>();
  constructor(
    private now: () => number = Date.now,
    private ttlMs = VIEW_TTL_MS
  ) {}
  private key = (workspace: string, viewId: string): string => `${workspace}\u0000${viewId}`;
  private sweep(): void {
    const t = this.now();
    for (const [key, entry] of this.views) if (t - entry.seenAt > this.ttlMs) this.views.delete(key);
    for (const [key, entry] of this.requests) if (t - entry.at > REQUEST_TTL_MS) this.requests.delete(key);
  }
  publish(workspace: string, viewId: string, owner: string | undefined, state: PublishedView): PublishResult {
    this.sweep();
    const key = this.key(workspace, viewId);
    const entry = this.views.get(key);
    const t = this.now();
    if (entry && entry.owner !== owner) return { ok: false, code: 'FORBIDDEN' };
    if (entry && t - entry.lastPublishAt < MIN_PUBLISH_GAP_MS) return { ok: false, code: 'RATE_LIMITED' };
    if (
      !entry &&
      [...this.views.keys()].filter((k) => k.startsWith(workspace + '\u0000')).length >= MAX_VIEWS_PER_WORKSPACE
    )
      return { ok: false, code: 'TOO_MANY_VIEWS' };
    this.views.set(key, { state, owner, seenAt: t, lastPublishAt: t });
    return { ok: true };
  }
  read(workspace: string, viewId: string, canSee: (owner: string | undefined) => boolean): ViewRecord | null {
    this.sweep();
    const entry = this.views.get(this.key(workspace, viewId));
    if (!entry || !canSee(entry.owner)) return null;
    return { viewId, ageMs: this.now() - entry.seenAt, state: entry.state };
  }
  list(workspace: string, canSee: (owner: string | undefined) => boolean): ViewRecord[] {
    this.sweep();
    const prefix = workspace + '\u0000';
    return [...this.views.entries()]
      .filter(([key, entry]) => key.startsWith(prefix) && canSee(entry.owner))
      .map(([key, entry]) => ({
        viewId: key.slice(prefix.length),
        ageMs: this.now() - entry.seenAt,
        state: entry.state,
      }));
  }
  /** Records one command for a live view; a retry with the same `requestId` and action returns the same id. */
  command(
    workspace: string,
    viewId: string,
    canSee: (owner: string | undefined) => boolean,
    action: ViewAction,
    requestId?: string
  ): CommandResult {
    this.sweep();
    const entry = this.views.get(this.key(workspace, viewId));
    if (!entry || !canSee(entry.owner)) return { ok: false, code: 'VIEW_GONE' };
    if (!requestId) return { ok: true, commandId: randomUUID(), duplicate: false, owner: entry.owner };
    const key = `${this.key(workspace, viewId)}\u0000${requestId}`;
    const fingerprint = createHash('sha256').update(JSON.stringify(action)).digest('hex');
    const previous = this.requests.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return { ok: false, code: 'REQUEST_REUSED' };
      return { ok: true, commandId: previous.commandId, duplicate: true, owner: entry.owner };
    }
    const commandId = randomUUID();
    this.requests.set(key, { at: this.now(), fingerprint, commandId });
    return { ok: true, commandId, duplicate: false, owner: entry.owner };
  }
  clear(): void {
    this.views.clear();
    this.requests.clear();
  }
}
