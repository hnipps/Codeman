// @vitest-environment jsdom
/**
 * The capture rasteriser injected after the frame bridge (ambient capture ticket 2): the vendored
 * html-to-image text, run so the page gains only a frozen `__codemanCapture`, and the numbers the
 * dashboard's capture.js shares with the bridge and the canvas parser (I8).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CAPTURE_RASTERISER_SCRIPT, CAPTURE_RASTERISER_SOURCE } from '../src/canvas/capture-rasteriser.js';
import { FRAME_LIMITS } from '../src/canvas/frame-bridge.js';
import {
  FRAME_CAPTURE_MS,
  FRAME_PICTURE_PREFIX,
  MAX_FRAME_PICTURE_CHARS,
} from '../packages/canvas/src/frame-messages.js';

const capture = readFileSync('src/web/public/capture.js', 'utf8');

describe('the capture rasteriser script', () => {
  it('is the vendored html-to-image in one inline script that cannot close itself', () => {
    const source = CAPTURE_RASTERISER_SOURCE as string;
    expect(source).toContain(readFileSync('src/web/public/vendor/html-to-image.js', 'utf8').slice(0, 200));
    expect(CAPTURE_RASTERISER_SCRIPT).toBe(`<script>${source}</script>`);
    expect(source).not.toMatch(/<\/script|<!--/i);
    expect(source).toMatch(/^[\x00-\x7f]+$/);
  });
  it('defines a frozen, fixed __codemanCapture and nothing else on the page', () => {
    const before = new Set(Object.getOwnPropertyNames(window));
    new Function(CAPTURE_RASTERISER_SOURCE as string)();
    const added = Object.getOwnPropertyNames(window).filter((name) => !before.has(name));
    expect(added).toEqual(['__codemanCapture']);
    const descriptor = Object.getOwnPropertyDescriptor(window, '__codemanCapture')!;
    expect(descriptor).toMatchObject({ writable: false, configurable: false, enumerable: false });
    expect(Object.isFrozen(descriptor.value)).toBe(true);
    expect('htmlToImage' in window).toBe(false);
  });
});

describe('capture.js holds the same I8 numbers as the bridge and the canvas parser', () => {
  it('waits FRAME_CAPTURE_MS and caps a picture at MAX_FRAME_PICTURE_CHARS', () => {
    expect(FRAME_CAPTURE_MS).toBe(500);
    expect(capture).toContain(`const FRAME_CAPTURE_MS = ${FRAME_CAPTURE_MS};`);
    expect(capture).toContain('const MAX_FRAME_PICTURE_CHARS = 12 * 1024 * 1024;');
    expect(12 * 1024 * 1024).toBe(MAX_FRAME_PICTURE_CHARS);
    expect(FRAME_LIMITS.picture).toBe(MAX_FRAME_PICTURE_CHARS);
    expect(capture).toContain(`const FRAME_PICTURE_PREFIX = '${FRAME_PICTURE_PREFIX}';`);
  });
});
