/**
 * @fileoverview Live frames of canvas embed objects: an in-memory registry, never a file.
 *
 * A canvas embed shows its page through the web-tab proxy (`/webview/<cap>/...`), so it
 * needs a record the proxy can resolve and a capability. Those records live HERE, keyed by
 * workspace + object id, and nowhere on disk:
 *
 * - `webviews.json` is read by the tab layout (`TabLayoutService`), `GET /api/webviews`, the
 *   per-owner tab cap and the previous release. A frame written there leaked into the owner's
 *   tab layout and, after a rollback, read as a permanent user web tab.
 * - A restart drops every frame; the page simply asks for its frame again
 *   (`POST /api/canvas/:ws/objects/:id/frame`), which re-checks that the object is a live embed.
 *
 * The capability itself is minted in the shared `webviewCapabilities` store, so logout
 * (`revokeOwner`) revokes it like any web tab's. A frame is retired (record dropped,
 * capability revoked) when its object is deleted, turned back into a link or pointed
 * elsewhere, and the registry is bounded: past `MAX_CANVAS_FRAMES` the least recently
 * opened frame is retired.
 */
import { randomUUID } from 'node:crypto';
import type { Webview } from '../types.js';
import { webviewCapabilities } from '../webview-capabilities.js';

/** Frames held across all workspaces and owners; the oldest past this is retired. */
export const MAX_CANVAS_FRAMES = 512;

export type CanvasFrame = Webview & { origin: { kind: 'canvas'; workspaceId: string; objectId: string } };

const frames = new Map<string, CanvasFrame>();
const byId = new Map<string, string>();
const key = (workspaceId: string, objectId: string) => `${workspaceId}\n${objectId}`;

function drop(k: string): CanvasFrame | undefined {
  const frame = frames.get(k);
  if (!frame) return undefined;
  frames.delete(k);
  byId.delete(frame.id);
  webviewCapabilities.revokeWebview(frame.id);
  return frame;
}

/**
 * The frame for one embed object, reused while its URL and owner are unchanged. A changed URL
 * or owner gets a new id, so the old capability can never reach the new page.
 */
export function openCanvasFrame(input: {
  workspaceId: string;
  objectId: string;
  url: string;
  name: string;
  owner?: string;
}): CanvasFrame {
  const k = key(input.workspaceId, input.objectId);
  const existing = frames.get(k);
  if (existing && existing.url === input.url && existing.owner === input.owner) {
    // Most recently opened last, so the bound retires the frame nobody has looked at longest.
    frames.delete(k);
    frames.set(k, existing);
    return existing;
  }
  if (existing) drop(k);
  while (frames.size >= MAX_CANVAS_FRAMES) {
    const oldest = frames.keys().next().value;
    if (oldest === undefined) break;
    drop(oldest);
  }
  const frame: CanvasFrame = {
    id: `canvas-frame-${randomUUID()}`,
    name: input.name.slice(0, 60) || 'Embedded page',
    url: input.url,
    embedMode: 'proxy',
    trusted: false,
    origin: { kind: 'canvas', workspaceId: input.workspaceId, objectId: input.objectId },
    owner: input.owner,
    createdAt: Date.now(),
  };
  frames.set(k, frame);
  byId.set(frame.id, k);
  return frame;
}

/** The frame a capability names, if it is still held. */
export function findCanvasFrame(id: string): CanvasFrame | undefined {
  const k = byId.get(id);
  return k === undefined ? undefined : frames.get(k);
}

/** Retire frames matching `match`: records dropped, capabilities revoked. Returns their ids. */
export function retireCanvasFrames(match: (origin: { workspaceId: string; objectId: string }) => boolean): string[] {
  const retired: string[] = [];
  for (const [k, frame] of [...frames])
    if (match(frame.origin)) {
      drop(k);
      retired.push(frame.id);
    }
  return retired;
}

/** Frames currently held (tests and diagnostics). */
export function canvasFrameCount(): number {
  return frames.size;
}
