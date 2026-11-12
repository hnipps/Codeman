/**
 * Canvas embed frames live in a bounded in-memory registry: reused while unchanged, replaced
 * (old capability revoked) when the URL or owner changes, retired on demand, and the oldest
 * retired past the bound. Nothing here touches a file.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_CANVAS_FRAMES,
  canvasFrameCount,
  findCanvasFrame,
  openCanvasFrame,
  retireCanvasFrames,
} from '../src/canvas/canvas-frames.js';
import { webviewCapabilities } from '../src/webview-capabilities.js';

const open = (objectId: string, url = 'https://example.com/', owner?: string, workspaceId = 'ws') =>
  openCanvasFrame({ workspaceId, objectId, url, name: 'Page', owner });

afterEach(() => {
  retireCanvasFrames(() => true);
});

describe('canvas frames', () => {
  it('reuses a frame while its URL and owner hold, and replaces it (revoking the old capability) when either changes', () => {
    const first = open('e', 'https://example.com/', 'user-a');
    expect(first.origin).toEqual({ kind: 'canvas', workspaceId: 'ws', objectId: 'e' });
    expect(first.trusted).toBe(false);
    expect(open('e', 'https://example.com/', 'user-a').id).toBe(first.id);
    const cap = webviewCapabilities.mint(first.id, 'user-a');
    const moved = open('e', 'https://example.org/', 'user-a');
    expect(moved.id).not.toBe(first.id);
    expect(webviewCapabilities.resolve(cap)).toBeFalsy();
    expect(findCanvasFrame(first.id)).toBeUndefined();
    expect(open('e', 'https://example.org/', 'user-b').id).not.toBe(moved.id);
    expect(canvasFrameCount()).toBe(1);
  });
  it('retires only the frames that match, revoking their capabilities', () => {
    const keep = open('a', undefined, undefined, 'ws1');
    const gone = open('b', undefined, undefined, 'ws2');
    const cap = webviewCapabilities.mint(gone.id);
    expect(retireCanvasFrames((o) => o.workspaceId === 'ws2')).toEqual([gone.id]);
    expect(webviewCapabilities.resolve(cap)).toBeFalsy();
    expect(findCanvasFrame(keep.id)).toBeDefined();
  });
  it('holds at most MAX_CANVAS_FRAMES, retiring the least recently opened', () => {
    const oldest = open('o0');
    const cap = webviewCapabilities.mint(oldest.id);
    const second = open('o1');
    open('o0'); // looked at again, so o1 is now the oldest
    for (let n = 2; n < MAX_CANVAS_FRAMES + 1; n++) open(`o${n}`);
    expect(canvasFrameCount()).toBe(MAX_CANVAS_FRAMES);
    expect(findCanvasFrame(second.id)).toBeUndefined();
    expect(findCanvasFrame(oldest.id)).toBeDefined();
    expect(webviewCapabilities.resolve(cap)).toBeTruthy();
  });
});
