/**
 * @fileoverview Capture core: freeze the screen as the person sees it (ambient capture,
 * intent/2026-11-19-ambient-capture.md, ticket 1). No UI here; later tickets build the
 * overlay, bundle and filing on top of `CodemanCapture.freeze()`.
 *
 * `freeze()` does its bookkeeping synchronously before its first await (I1: FreezeComesFirst):
 * it holds toast timers (`app.holdToasts()`, panels-ui.js), records the page facts and
 * snapshots every same-origin frame's box. It changes nothing on screen. It then rasterises
 * the top document and those frames concurrently with the vendored html-to-image (whose
 * password masking, I3, is patched in by scripts/prepare-capture-assets.mjs) and paints each
 * frame into the top picture at its content box, parents before children.
 *
 * Elements matching `[data-codeman-capture]` (the capture UI) and unrendered HTML elements are
 * left out of each document's raster. Every iframe rasterises as an empty box (the vendored
 * copy is patched so: stock 1.11.11 clones a same-origin frame's body without the caller's
 * options and appends its children twice), and frames are painted into those boxes here.
 * A frame whose document cannot be read (sandboxed, cross-origin) gets `captured: false`
 * and stays blank. Frames that are not rendered, have no size or lie outside the viewport
 * of the document that holds them get no record.
 *
 * Single-flight: a call while a freeze runs returns the same promise.
 *
 * @typedef {{ x: number, y: number, width: number, height: number }} CaptureBox
 * @typedef {{ title: string, box: CaptureBox, depth: number, captured: boolean }} CaptureFrame
 * @typedef {Object} FreezeResult
 * @property {Blob} blob PNG of the viewport
 * @property {number} width viewport width in CSS px
 * @property {number} height viewport height in CSS px
 * @property {number} pixelRatio min(devicePixelRatio, 2); the PNG is width*pixelRatio wide
 * @property {number} freezeMs from the call to the PNG blob
 * @property {CaptureFrame[]} frames box in CSS px of the top viewport, depth 1 or 2
 * @property {{ path: string, title: string, viewport: { width: number, height: number },
 *   devicePixelRatio: number, sessionId: string|null, capturedAt: string }} page
 *
 * @dependency vendor/html-to-image.js (global `htmlToImage`)
 * @dependency panels-ui.js (app.holdToasts, optional)
 * @loadorder 16.7 (after spreadsheet-preview.js; only defines a global, used on demand)
 */

(function initCapture(global) {
  'use strict';

  const CAPTURE_UI_SELECTOR = '[data-codeman-capture]';
  const MAX_FRAME_DEPTH = 2;
  const XHTML = 'http://www.w3.org/1999/xhtml';

  let inFlight = null;

  function backgroundOf(doc) {
    const view = doc.defaultView || global;
    for (const el of [doc.body, doc.documentElement]) {
      if (!el) continue;
      const bg = view.getComputedStyle(el).backgroundColor;
      if (bg && bg !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(bg)) return bg;
    }
    return undefined;
  }

  // Unrendered HTML (closed modals, hidden panels) is dropped too: cloning it made the dashboard's
  // SVG 56 MB and 11.6 s to build, and Chromium refused to load it. SVG nodes are kept whole,
  // since <defs>, <symbol> and gradients have no box of their own but are referenced by ones that do.
  function keepNode(node) {
    if (node.nodeType !== 1) return true;
    if (node.matches(CAPTURE_UI_SELECTOR)) return false;
    return node.namespaceURI !== XHTML || !node.checkVisibility || node.checkVisibility();
  }

  function rasterise(doc, width, height, pixelRatio) {
    return global.htmlToImage.toCanvas(doc.body, {
      width,
      height,
      pixelRatio,
      backgroundColor: backgroundOf(doc),
      filter: keepNode,
    });
  }

  function readableDocument(frame) {
    try {
      const doc = frame.contentDocument;
      return doc && doc.body ? doc : null;
    } catch {
      return null;
    }
  }

  /** Frames of `doc`, depth-first, each parent before its children. `clip` is `doc`'s viewport in top CSS px. */
  function collectFrames(doc, clip, depth, out) {
    for (const frame of doc.querySelectorAll('iframe')) {
      if (frame.closest(CAPTURE_UI_SELECTOR)) continue;
      if (frame.checkVisibility ? !frame.checkVisibility({ visibilityProperty: true }) : !frame.getClientRects().length)
        continue;
      const rect = frame.getBoundingClientRect();
      const box = {
        x: clip.x + rect.left + frame.clientLeft,
        y: clip.y + rect.top + frame.clientTop,
        width: frame.clientWidth,
        height: frame.clientHeight,
      };
      if (!box.width || !box.height) continue;
      if (
        box.x >= clip.x + clip.width ||
        box.y >= clip.y + clip.height ||
        box.x + box.width <= clip.x ||
        box.y + box.height <= clip.y
      )
        continue;
      const inner = readableDocument(frame);
      out.push({ title: frame.title || '', box, depth, captured: !!inner, doc: inner });
      if (inner && depth < MAX_FRAME_DEPTH) collectFrames(inner, box, depth + 1, out);
    }
    return out;
  }

  function toPngBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('capture: canvas.toBlob returned nothing'))),
        'image/png'
      );
    });
  }

  async function run() {
    const t0 = performance.now();
    const release = global.app?.holdToasts?.() ?? (() => {});
    try {
      const width = global.innerWidth;
      const height = global.innerHeight;
      const pixelRatio = Math.min(global.devicePixelRatio || 1, 2);
      const page = {
        path: global.location.pathname,
        title: document.title,
        viewport: { width, height },
        devicePixelRatio: global.devicePixelRatio || 1,
        sessionId: global.app?.activeSessionId ?? null,
        capturedAt: new Date().toISOString(),
      };
      const frames = collectFrames(document, { x: 0, y: 0, width, height }, 1, []);

      const [canvas, frameCanvases] = await Promise.all([
        rasterise(document, width, height, pixelRatio),
        Promise.all(
          frames.map((f) => (f.doc ? rasterise(f.doc, f.box.width, f.box.height, pixelRatio).catch(() => null) : null))
        ),
      ]);

      const ctx = canvas.getContext('2d');
      frames.forEach((f, i) => {
        const shot = frameCanvases[i];
        if (!shot) {
          f.captured = false;
          return;
        }
        ctx.drawImage(
          shot,
          f.box.x * pixelRatio,
          f.box.y * pixelRatio,
          f.box.width * pixelRatio,
          f.box.height * pixelRatio
        );
      });

      const blob = await toPngBlob(canvas);
      return {
        blob,
        width,
        height,
        pixelRatio,
        freezeMs: Math.round(performance.now() - t0),
        frames: frames.map(({ title, box, depth, captured }) => ({ title, box, depth, captured })),
        page,
      };
    } finally {
      release();
    }
  }

  /** @returns {Promise<FreezeResult>} */
  function freeze() {
    if (!inFlight)
      inFlight = run().finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  global.CodemanCapture = Object.freeze({ freeze, CAPTURE_UI_SELECTOR });
})(window);
