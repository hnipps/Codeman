/**
 * @fileoverview The second script injected into every bridged frame (ambient capture ticket 2,
 * intent/2026-11-19-ambient-capture.md): html-to-image, so a sandboxed page can rasterise itself when
 * the capture in the top document asks it through the frame bridge (`codeman:capture`).
 *
 * The text is the vendored copy the dashboard loads (`scripts/prepare-capture-assets.mjs`, password
 * masking patched in), read once when this module loads: `vendor/html-to-image.js` in dev, its hashed
 * name after `npm run build`. It runs inside a function that gives the UMD build its own `module`, so
 * the page gains no `htmlToImage` global; the one thing it defines is a frozen, non-writable
 * `__codemanCapture(width)` that the bridge calls. Without the vendored file the script is empty and
 * every bridged frame shows as "Frame not captured".
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Dom = any;

/**
 * Runs in the frame, after html-to-image, with its exports as the one argument. Shipped as its own
 * source text, so it must stay self-contained like the bridge.
 * `__codemanCapture(width)` rasterises the frame's viewport to a PNG data URL `width` device pixels wide.
 */
export function frameRasteriser(h2i: Dom): void {
  const window: Dom = globalThis;
  const document: Dom = window.document;
  const XHTML = 'http://www.w3.org/1999/xhtml';
  // The bridge's pick layer and unrendered HTML stay out, as in the top document's raster.
  const keep = (node: Dom): boolean =>
    node.nodeType !== 1 ||
    (!node.hasAttribute('data-codeman-frame-bridge') &&
      (node.namespaceURI !== XHTML || typeof node.checkVisibility !== 'function' || node.checkVisibility()));
  // The clone loses the body's background unless it is passed in.
  const background = (): string | undefined => {
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      const bg = window.getComputedStyle(el).backgroundColor;
      if (bg && bg !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(bg)) return bg;
    }
    return undefined;
  };
  const capture = (width: number): Promise<string> => {
    const body = document.body;
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (!body || !(w > 0) || !(h > 0) || !(width > 0)) return Promise.reject(new Error('nothing to capture'));
    return h2i.toPng(body, {
      width: w,
      height: h,
      canvasWidth: w,
      canvasHeight: h,
      pixelRatio: width / w,
      backgroundColor: background(),
      filter: keep,
    });
  };
  Object.defineProperty(window, '__codemanCapture', { value: Object.freeze(capture) });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const VENDORED = /^html-to-image(?:\.[0-9a-f]{8})?\.js$/;

function vendoredRasteriser(): string | null {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'public', 'vendor');
  try {
    const name = readdirSync(dir)
      .filter((n) => VENDORED.test(n))
      .sort((a, b) => a.length - b.length)[0];
    return name ? readFileSync(join(dir, name), 'utf8') : null;
  } catch {
    return null;
  }
}

/** ASCII only, for the same reason as the bridge: the hash must match whatever charset the page is read in. */
function buildSource(vendored: string | null): string | null {
  if (!vendored || /<\/script|<!--/i.test(vendored)) return null;
  return `(function(){var __name=function(f){return f};var module={exports:{}},exports=module.exports,define;${vendored}\n;(${frameRasteriser.toString()})(module.exports)})()`.replace(
    /[\u0080-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

const vendored = vendoredRasteriser();
if (!vendored) console.warn('[capture] vendor/html-to-image.js not found: bridged frames will not be captured');

/** The script's text, or null when the vendored rasteriser is missing. */
export const CAPTURE_RASTERISER_SOURCE = buildSource(vendored);
export const CAPTURE_RASTERISER_SCRIPT = CAPTURE_RASTERISER_SOURCE
  ? `<script>${CAPTURE_RASTERISER_SOURCE}</script>`
  : '';
