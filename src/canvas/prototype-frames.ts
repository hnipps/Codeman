/**
 * @fileoverview Capabilities for the live frame of a prototype embed: in memory, never a file.
 *
 * A canvas frame is sandboxed into an opaque origin, so its requests carry no session cookie
 * (see `webview-capabilities.ts`). `/canvas-prototype/<cap>/...` authenticates on an unguessable
 * token instead. A token is minted only by the authenticated frame route, for one embed object
 * showing one version of one prototype, and grants GET of that version's files and nothing else.
 *
 * - 192 bits of `randomBytes`, base64url. A restart invalidates every token.
 * - Rolling TTL, revoked on logout, admin logout and user deletion (`revokeOwner`).
 * - Retired when the object is deleted, becomes a link or points elsewhere, when the prototype is
 *   removed, and by the serving route the moment the workspace lists no open view.
 */
import { randomBytes } from 'node:crypto';
import { StaleExpirationMap } from '../utils/index.js';
import { WEBVIEW_CAPABILITY_TTL_MS } from '../config/webview-limits.js';

/** URL prefix a prototype's files are served under. */
export const PROTOTYPE_FRAME_PREFIX = '/canvas-prototype';
/** Tokens held across all workspaces; past this the expired ones are swept before a new one is minted. */
export const MAX_PROTOTYPE_FRAMES = 512;

export interface PrototypeFrame {
  workspaceId: string;
  objectId: string;
  prototypeId: string;
  version: number;
  /** The workspace's owner (multi-user); undefined in single-user mode. */
  owner?: string;
}

export class PrototypeFrameStore {
  private readonly frames: StaleExpirationMap<string, PrototypeFrame>;
  /** One token per embed object, so asking again reuses it instead of leaking one per call. */
  private readonly byObject = new Map<string, string>();

  constructor(ttlMs: number = WEBVIEW_CAPABILITY_TTL_MS) {
    this.frames = new StaleExpirationMap<string, PrototypeFrame>({
      ttlMs,
      refreshOnGet: true,
      onExpire: (token, frame) => {
        if (this.byObject.get(objectKey(frame)) === token) this.byObject.delete(objectKey(frame));
      },
    });
  }

  /** Mint (or reuse) the token for one embed object showing one version. */
  mint(frame: PrototypeFrame): string {
    const key = objectKey(frame);
    const existing = this.byObject.get(key);
    if (existing) {
      const held = this.frames.get(existing);
      if (
        held &&
        held.prototypeId === frame.prototypeId &&
        held.version === frame.version &&
        held.owner === frame.owner
      )
        return existing;
      this.revoke(existing);
    }
    if (this.frames.size >= MAX_PROTOTYPE_FRAMES) this.frames.cleanup();
    const token = randomBytes(24).toString('base64url');
    this.frames.set(token, { ...frame });
    this.byObject.set(key, token);
    return token;
  }

  /** Resolve a token, refreshing its TTL. */
  resolve(token: string): PrototypeFrame | undefined {
    return token ? this.frames.get(token) : undefined;
  }

  revoke(token: string): void {
    const frame = this.frames.peek(token);
    if (!frame) return;
    this.frames.delete(token);
    if (this.byObject.get(objectKey(frame)) === token) this.byObject.delete(objectKey(frame));
  }

  /** Revoke every token whose frame matches. Returns how many. */
  retire(match: (frame: PrototypeFrame) => boolean): number {
    let retired = 0;
    for (const [key, token] of [...this.byObject]) {
      const frame = this.frames.peek(token);
      if (frame && !match(frame)) continue;
      if (frame) retired++;
      this.frames.delete(token);
      this.byObject.delete(key);
    }
    return retired;
  }

  revokeOwner(owner: string | undefined): number {
    return this.retire((frame) => frame.owner === owner);
  }

  get size(): number {
    return this.frames.size;
  }
}

const objectKey = (frame: Pick<PrototypeFrame, 'workspaceId' | 'objectId'>): string =>
  `${frame.workspaceId}\n${frame.objectId}`;

/** The token in a `/canvas-prototype/<cap>/...` path, or null. */
export function capabilityFromPrototypePath(pathname: string): string | null {
  const prefix = `${PROTOTYPE_FRAME_PREFIX}/`;
  if (typeof pathname !== 'string' || !pathname.startsWith(prefix)) return null;
  const cap = pathname.slice(prefix.length).split('/')[0];
  return /^[A-Za-z0-9_-]{16,128}$/.test(cap) ? cap : null;
}

/** Process-wide store, shared by the canvas routes and the auth middleware (see `webviewCapabilities`). */
export const prototypeFrames = new PrototypeFrameStore();
