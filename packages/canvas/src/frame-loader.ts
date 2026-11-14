/**
 * @fileoverview Where a live frame's address comes from, for the board's frames and the page slots alike.
 *
 * The address of an embed's frame is a capability the server mints on request (`POST …/objects/:id/frame`).
 * This module asks for it, remembers it per object and address, and notices when it has gone stale:
 *
 * - A prototype is served only while its workspace lists an open view. A page's first paint can ask before
 *   its first view publish has landed, and the server answers 409. The loader publishes the view and asks
 *   once more instead of giving up.
 * - The server revokes a prototype's capability when it finds the workspace closed, and forgets every one on
 *   a restart. The frame's origin is opaque, so the canvas cannot read what the frame loaded. It does know
 *   that Codeman injects the frame bridge into every prototype page, and that the bridge reports
 *   `codeman:frame-ready` as soon as it runs. A prototype frame that stays silent is a stale address: the
 *   loader asks for a new one once, and after a second silence says the page is unavailable.
 */
import { z } from 'zod';
import { parsePrototypeAddress } from '../../../src/canvas/prototype-address.js';

/** A prototype frame that has loaded and still said nothing after this long holds a stale address. */
export const FRAME_READY_AFTER_LOAD_MS = 2500;
/** The same verdict for a frame whose load never finished. */
export const FRAME_READY_MS = 10_000;
/** How long a frame request waits for the view publish it asked for. */
const PUBLISH_WAIT_MS = 4000;

const FrameSchema = z.object({ success: z.literal(true), data: z.object({ embedUrl: z.string() }) });

/**
 * Whether a refused frame request is asked again after this view has been published. Only a prototype is
 * refused for want of an open view, the server says so with 409, and one retry is enough: the publish that
 * precedes it is awaited.
 */
export const retryAfterPublish = (request: { status: number; prototype: boolean; attempt: number }): boolean =>
  request.status === 409 && request.prototype && request.attempt === 0;

/** What a silent prototype frame gets: a new address the first time, the unavailable state after that. */
export const silentFrameVerdict = (earlierSilences: number): 'ask-again' | 'unavailable' =>
  earlierSilences === 0 ? 'ask-again' : 'unavailable';

export type FrameLoaderHost = {
  url: (path: string) => string;
  workspace: string;
  /** Publishes this tab's view now and resolves once the server has answered. */
  publishView: () => Promise<void>;
};

export class FrameLoader {
  private known = new Map<string, { address: string; embedUrl: string }>();
  private requests = new Map<string, Promise<string | null>>();
  /** How often a frame of this object and address stayed silent; cleared when one speaks or the person reloads. */
  private silences = new Map<string, number>();
  private watches = new WeakMap<HTMLIFrameElement, { key: string; stop: () => void }>();

  constructor(private host: FrameLoaderHost) {}

  private key = (id: string, address: string): string => `${id}\n${address}`;

  /** The frame address already held for this object and address, without asking. */
  held(id: string, address: string): string | null {
    const known = this.known.get(id);
    return known?.address === address ? known.embedUrl : null;
  }
  /** True once two frames in a row stayed silent: the page is shown as unavailable until a reload. */
  unavailable(id: string, address: string): boolean {
    return (this.silences.get(this.key(id, address)) ?? 0) > 1;
  }

  /** The frame address for an embed, asked for at most once at a time. Null when the server will not give one. */
  address(id: string, address: string): Promise<string | null> {
    const held = this.held(id, address);
    if (held) return Promise.resolve(held);
    const key = this.key(id, address);
    const pending = this.requests.get(key);
    if (pending) return pending;
    const request = this.ask(id, address, 0)
      .catch(() => null)
      .finally(() => this.requests.delete(key));
    this.requests.set(key, request);
    return request;
  }
  private async ask(id: string, address: string, attempt: number): Promise<string | null> {
    const response = await fetch(
      this.host.url(`/api/canvas/${this.host.workspace}/objects/${encodeURIComponent(id)}/frame`),
      { method: 'POST' }
    );
    if (retryAfterPublish({ status: response.status, prototype: !!parsePrototypeAddress(address), attempt })) {
      await Promise.race([this.host.publishView(), new Promise((done) => setTimeout(done, PUBLISH_WAIT_MS))]);
      return this.ask(id, address, attempt + 1);
    }
    const parsed = FrameSchema.safeParse(await response.json());
    if (!parsed.success) return null;
    const embedUrl = this.host.url(parsed.data.data.embedUrl);
    this.known.set(id, { address, embedUrl });
    return embedUrl;
  }

  /**
   * Watches a mounted frame for the bridge's first word. Only a prototype is watched: Codeman serves its
   * page, so the bridge is always in it. `silent` is told what to do with a frame that never spoke.
   */
  watch(
    frame: HTMLIFrameElement,
    id: string,
    address: string,
    silent: (verdict: 'ask-again' | 'unavailable') => void
  ): void {
    if (!parsePrototypeAddress(address)) return;
    const key = this.key(id, address);
    const expire = () => {
      this.watches.delete(frame);
      if (!frame.isConnected) return;
      const earlier = this.silences.get(key) ?? 0;
      this.silences.set(key, earlier + 1);
      this.known.delete(id);
      silent(silentFrameVerdict(earlier));
    };
    let timer = setTimeout(expire, FRAME_READY_MS);
    const loaded = () => {
      clearTimeout(timer);
      timer = setTimeout(expire, FRAME_READY_AFTER_LOAD_MS);
    };
    frame.addEventListener('load', loaded, { once: true });
    this.watches.set(frame, {
      key,
      stop: () => {
        clearTimeout(timer);
        frame.removeEventListener('load', loaded);
      },
    });
  }
  /** The bridge in this frame has spoken: its address is good. */
  spoke(frame: HTMLIFrameElement): void {
    const watch = this.watches.get(frame);
    if (!watch) return;
    watch.stop();
    this.watches.delete(frame);
    this.silences.delete(watch.key);
  }
  /** A frame leaving the page is no longer waited for. It was taken away, which is not a silence. */
  release(frame: HTMLIFrameElement): void {
    this.watches.get(frame)?.stop();
    this.watches.delete(frame);
  }

  /** The person asked for this page again: whatever was held or concluded about it is dropped. */
  reload(id: string): void {
    this.known.delete(id);
    for (const key of [...this.silences.keys()]) if (key.startsWith(`${id}\n`)) this.silences.delete(key);
  }
  /** Drops the addresses of objects that are no longer embeds: the server retired them. */
  keep(ids: Set<string>): void {
    for (const id of [...this.known.keys()]) if (!ids.has(id)) this.known.delete(id);
  }
  /** The tab is going to the background: the server stops serving it, so every held address is let go. */
  forgetAll(): void {
    this.known.clear();
  }
}
