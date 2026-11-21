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
 * options and appends its children twice), and frames are painted into those boxes here,
 * clipped to the part of the box its ancestors show. Frames that are not rendered, have no
 * size or lie outside the viewport of the document that holds them get no record.
 *
 * A frame whose document cannot be read (sandboxed, cross-origin) is asked for its own
 * picture (ticket 2): `codeman:capture` with a random `requestId` and the box size in device
 * pixels, answered by the frame bridge with `codeman:frame-capture` and a PNG data URL. I8
 * (FramePicturesAreUntrusted): the answer is taken only from that frame's window, with the
 * opaque origin, the same `requestId` and within FRAME_CAPTURE_MS of the rest of the picture
 * settling (the top document and same-origin frames). The request goes out at once, but the
 * clock starts there: a bridged frame shares the page's main thread and cannot rasterise
 * while the top document does (measured: answers 15 ms after the frame starts, 583 ms after
 * the request on the canvas page). So a frame never delays the freeze by more than
 * FRAME_CAPTURE_MS, and a well-behaved one is never cut off by the top's own raster. It must be a PNG by its
 * signature, under the length cap and no larger than asked; and it is drawn only into the
 * frame's own box. Anything else, a frame without the bridge (Mermaid, html-view) included,
 * is painted as a hatched "Frame not captured" placeholder with `captured: false`. A picture
 * that passed is `selfReported: true`: the page drew it, so it can still lie inside its box.
 *
 * Exact-pixel mode (ticket 7, intent/2026-11-20-ambient-capture-tab-mode.md): with the
 * per-device setting `captureTabMode` on, on desktop Chromium, the picture is one video frame
 * of the browser's own capture of this tab (`getDisplayMedia` + `preferCurrentTab`) and
 * `source` is `'tab'`; otherwise `'raster'`. T1: only with the setting exactly true, not on a
 * phone, and with every API present; no prompt otherwise. T2: a stream is used only when its
 * track's capture handle equals the random handle this page load set; any other stream is
 * stopped. T3: one stream per page load, reused while its track is live; a decline is not
 * asked again; concurrent freezes share one prompt. T4: toasts stay held through the prompt,
 * and rendered capture UI, a stream that will not open, a frame that times out or whose
 * aspect ratio is off by more than 2 % all fall back to the rasteriser for that capture.
 * T5: same result shape, and every frame record is `captured: true` in tab mode.
 * `getDisplayMedia` needs transient user activation, so it is called before the first await.
 *
 * Single-flight: a call while a freeze runs returns the same promise.
 *
 * @typedef {{ x: number, y: number, width: number, height: number }} CaptureBox
 * @typedef {{ title: string, box: CaptureBox, depth: number, captured: boolean, selfReported: boolean }} CaptureFrame
 * @typedef {Object} FreezeResult
 * @property {Blob} blob PNG of the viewport
 * @property {number} width viewport width in CSS px
 * @property {number} height viewport height in CSS px
 * @property {number} pixelRatio min(devicePixelRatio, 2); the PNG is width*pixelRatio wide
 * @property {number} freezeMs from the call to the PNG blob
 * @property {CaptureFrame[]} frames box in CSS px of the top viewport, depth 1 or 2
 * @property {{ path: string, title: string, viewport: { width: number, height: number },
 *   devicePixelRatio: number, sessionId: string|null, capturedAt: string }} page
 * @property {'tab'|'raster'} source which path drew the picture
 *
 * @dependency vendor/html-to-image.js (global `htmlToImage`)
 * @dependency panels-ui.js (app.holdToasts, optional)
 * @dependency settings-ui.js (app.loadAppSettingsFromStorage, for captureTabMode)
 * @loadorder 16.7 (after spreadsheet-preview.js; only defines a global, used on demand)
 */

(function initCapture(global) {
  'use strict';

  const CAPTURE_UI_SELECTOR = '[data-codeman-capture]';
  const MAX_FRAME_DEPTH = 2;
  const XHTML = 'http://www.w3.org/1999/xhtml';

  // I8; packages/canvas/src/frame-messages.ts holds the same numbers.
  const FRAME_CAPTURE_MS = 500;
  const MAX_FRAME_PICTURE_CHARS = 12 * 1024 * 1024;
  const FRAME_PICTURE_PREFIX = 'data:image/png;base64,';
  const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
  // The approved prototype's placeholder (docs/spikes/w-49-ambient-capture/prototype/proto.css).
  const PLACEHOLDER = { stripe: '#2a2b3a', gap: '#24253a', ink: '#7b81a6', label: 'Frame not captured' };

  const TAB_GRAB_TIMEOUT_MS = 1000;
  const TAB_ASPECT_TOLERANCE = 0.02;
  const DISPLAY_MEDIA_OPTIONS = {
    video: true,
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
    surfaceSwitching: 'exclude',
    monitorTypeSurfaces: 'exclude',
  };

  let inFlight = null;

  /** One tab stream per page load. state: 'idle' | 'asking' | 'live' | 'declined'. */
  const tab = { state: 'idle', stream: null, track: null, asking: null, handle: null };

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

  function intersect(a, b) {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
  }

  /**
   * Frames of `doc`, depth-first, each parent before its children. `view` is `doc`'s viewport in
   * top CSS px, `scale` how many top px one of its px covers (a canvas embed is scaled with the
   * board), `shown` the part of that viewport its ancestors leave visible.
   */
  function collectFrames(doc, view, scale, shown, depth, out) {
    for (const frame of doc.querySelectorAll('iframe')) {
      if (frame.closest(CAPTURE_UI_SELECTOR)) continue;
      if (frame.checkVisibility ? !frame.checkVisibility({ visibilityProperty: true }) : !frame.getClientRects().length)
        continue;
      const rect = frame.getBoundingClientRect();
      if (!frame.clientWidth || !frame.clientHeight || !frame.offsetWidth || !frame.offsetHeight) continue;
      const sx = rect.width / frame.offsetWidth;
      const sy = rect.height / frame.offsetHeight;
      const box = {
        x: view.x + (rect.left + frame.clientLeft * sx) * scale,
        y: view.y + (rect.top + frame.clientTop * sy) * scale,
        width: frame.clientWidth * sx * scale,
        height: frame.clientHeight * sy * scale,
      };
      const visible = intersect(box, shown);
      if (!visible) continue;
      const inner = readableDocument(frame);
      const record = {
        title: frame.title || '',
        box,
        depth,
        captured: !!inner,
        selfReported: false,
        el: frame,
        doc: inner,
        layout: { width: frame.clientWidth, height: frame.clientHeight },
        scale: scale * sx,
        visible,
      };
      out.push(record);
      if (inner && depth < MAX_FRAME_DEPTH) collectFrames(inner, box, record.scale, visible, depth + 1, out);
    }
    return out;
  }

  /**
   * Ask a frame for its own picture. Resolves to the data URL it answered with, or null when no answer
   * from that frame's window, with that `requestId`, came within FRAME_CAPTURE_MS of `clock` settling.
   * The bridge answers whichever window asked, so the reply comes here even for a frame nested in a
   * canvas page.
   */
  function askFrame(frame, width, height, clock) {
    const target = frame.contentWindow;
    if (!target || !global.crypto?.randomUUID) return Promise.resolve(null);
    const requestId = global.crypto.randomUUID();
    return new Promise((resolve) => {
      let timer = 0;
      const finish = (value) => {
        clearTimeout(timer);
        global.removeEventListener('message', heard);
        resolve(value);
      };
      function heard(e) {
        if (e.source !== target || e.origin !== 'null') return;
        const data = e.data;
        if (!data || data.type !== 'codeman:frame-capture' || data.requestId !== requestId) return;
        finish(typeof data.dataUrl === 'string' ? data.dataUrl : null);
      }
      clock.then(() => {
        timer = setTimeout(() => finish(null), FRAME_CAPTURE_MS);
      });
      global.addEventListener('message', heard);
      try {
        target.postMessage({ type: 'codeman:capture', requestId, width, height }, '*');
      } catch {
        finish(null);
      }
    });
  }

  /**
   * A frame's answer as a bitmap, or null unless it is a PNG data URL under the length cap whose
   * own header says it is no larger than the `width` by `height` device pixels asked for (one
   * pixel of rounding allowed). The bytes are checked before anything decodes them.
   */
  async function framePicture(dataUrl, width, height) {
    if (typeof dataUrl !== 'string' || dataUrl.length > MAX_FRAME_PICTURE_CHARS) return null;
    if (!dataUrl.startsWith(FRAME_PICTURE_PREFIX)) return null;
    let binary;
    try {
      binary = global.atob(dataUrl.slice(FRAME_PICTURE_PREFIX.length));
    } catch {
      return null;
    }
    if (binary.length < 24) return null;
    if (PNG_SIGNATURE.some((byte, i) => binary.charCodeAt(i) !== byte)) return null;
    if (binary.slice(12, 16) !== 'IHDR') return null;
    const u32 = (at) =>
      ((binary.charCodeAt(at) << 24) >>> 0) +
      (binary.charCodeAt(at + 1) << 16) +
      (binary.charCodeAt(at + 2) << 8) +
      binary.charCodeAt(at + 3);
    const w = u32(16);
    const h = u32(20);
    if (!w || !h || w > width + 1 || h > height + 1) return null;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    try {
      return await global.createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    } catch {
      return null;
    }
  }

  async function bridgedPicture(f, pixelRatio, clock) {
    const width = Math.max(1, Math.round(f.box.width * pixelRatio));
    const height = Math.max(1, Math.round(f.box.height * pixelRatio));
    return framePicture(await askFrame(f.el, width, height, clock), width, height);
  }

  function withClip(ctx, area, r, draw) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(area.x * r, area.y * r, area.width * r, area.height * r);
    ctx.clip();
    try {
      draw();
    } finally {
      ctx.restore();
    }
  }

  function paintPlaceholder(ctx, box, r) {
    const x = box.x * r;
    const y = box.y * r;
    const w = box.width * r;
    const h = box.height * r;
    ctx.fillStyle = PLACEHOLDER.gap;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = PLACEHOLDER.stripe;
    ctx.lineWidth = 8 * r;
    const step = 16 * Math.SQRT2 * r;
    ctx.beginPath();
    for (let c = -h; c < w + h; c += step) {
      ctx.moveTo(x + c, y + h);
      ctx.lineTo(x + c + h, y);
    }
    ctx.stroke();
    ctx.fillStyle = PLACEHOLDER.ink;
    ctx.font = `${12 * r}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(PLACEHOLDER.label, x + w / 2, y + h / 2);
  }

  function toPngBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('capture: canvas.toBlob returned nothing'))),
        'image/png'
      );
    });
  }

  function tabModeSupported() {
    const media = global.navigator?.mediaDevices;
    return (
      !global.MobileDetection?.isMobile?.() &&
      typeof media?.getDisplayMedia === 'function' &&
      typeof media.setCaptureHandleConfig === 'function' &&
      typeof global.MediaStreamTrack?.prototype?.getCaptureHandle === 'function' &&
      typeof global.ImageCapture === 'function'
    );
  }

  function tabModeEligible() {
    return global.app?.loadAppSettingsFromStorage?.()?.captureTabMode === true && tabModeSupported();
  }

  function captureUiShown() {
    for (const el of document.querySelectorAll(CAPTURE_UI_SELECTOR)) {
      if (el.checkVisibility ? el.checkVisibility() : el.getClientRects().length) return true;
    }
    return false;
  }

  function resetTab(next) {
    const stream = tab.stream;
    tab.state = next;
    tab.stream = null;
    tab.track = null;
    tab.asking = null;
    stream?.getTracks().forEach((t) => t.stop());
  }

  function stopTabCapture() {
    if (tab.state !== 'declined') resetTab('idle');
  }

  /**
   * Synchronous up to the getDisplayMedia call, so the caller's user activation still holds.
   * @returns {Promise<MediaStreamTrack|null>|null} null when no stream can be had for this capture
   */
  function tabTrack() {
    // track.stop() fires no 'ended', so a live state is only trusted with a live track.
    if (tab.state === 'live' && tab.track.readyState !== 'live') resetTab('idle');
    if (tab.state === 'live') return Promise.resolve(tab.track);
    if (tab.state === 'asking') return tab.asking;
    if (tab.state === 'declined') return null;

    const media = global.navigator.mediaDevices;
    let pending;
    try {
      if (!tab.handle) {
        const handle = global.crypto.randomUUID();
        media.setCaptureHandleConfig({ handle, permittedOrigins: [global.location.origin] });
        tab.handle = handle;
      }
      pending = media.getDisplayMedia(DISPLAY_MEDIA_OPTIONS);
    } catch {
      return null;
    }
    const asking = pending.then(
      (stream) => {
        const stopAll = () => stream.getTracks().forEach((t) => t.stop());
        if (tab.asking !== asking) {
          stopAll();
          return null;
        }
        const track = stream.getVideoTracks()[0];
        if (!track || track.getCaptureHandle?.()?.handle !== tab.handle) {
          stopAll();
          resetTab('idle');
          return null;
        }
        tab.state = 'live';
        tab.stream = stream;
        tab.track = track;
        tab.asking = null;
        track.addEventListener('ended', () => {
          if (tab.track === track) resetTab('idle');
        });
        return track;
      },
      (err) => {
        if (tab.asking === asking) resetTab(err?.name === 'NotAllowedError' ? 'declined' : 'idle');
        return null;
      }
    );
    tab.state = 'asking';
    tab.asking = asking;
    return asking;
  }

  function grabFrame(track) {
    return new Promise((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        reject(new Error('capture: grabFrame timed out'));
      }, TAB_GRAB_TIMEOUT_MS);
      new global.ImageCapture(track).grabFrame().then(
        (bitmap) => {
          clearTimeout(timer);
          if (timedOut) bitmap.close();
          else resolve(bitmap);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  /** @returns {Promise<Blob|null>} null when the frame does not match the viewport's shape */
  async function tabPicture(track, width, height, pixelRatio) {
    const bitmap = await grabFrame(track);
    try {
      if (Math.abs(bitmap.width / bitmap.height / (width / height) - 1) > TAB_ASPECT_TOLERANCE) return null;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return await toPngBlob(canvas);
    } finally {
      bitmap.close();
    }
  }

  async function run() {
    const t0 = performance.now();
    const release = global.app?.holdToasts?.() ?? (() => {});
    try {
      const pendingTrack = tabModeEligible() && tab.state !== 'declined' && !captureUiShown() ? tabTrack() : null;
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
      const viewport = { x: 0, y: 0, width, height };
      const frames = collectFrames(document, viewport, 1, viewport, 1, []);

      if (pendingTrack) {
        const track = await pendingTrack;
        const blob = track ? await tabPicture(track, width, height, pixelRatio).catch(() => null) : null;
        if (blob) {
          return {
            blob,
            width,
            height,
            pixelRatio,
            freezeMs: Math.round(performance.now() - t0),
            frames: frames.map(({ title, box, depth }) => ({ title, box, depth, captured: true, selfReported: false })),
            page,
            source: 'tab',
          };
        }
      }

      const top = rasterise(document, width, height, pixelRatio);
      const own = frames.map((f) =>
        f.doc ? rasterise(f.doc, f.layout.width, f.layout.height, pixelRatio * f.scale).catch(() => null) : null
      );
      const settled = Promise.allSettled([top, ...own]);
      const [canvas, frameShots] = await Promise.all([
        top,
        Promise.all(frames.map((f, i) => (f.doc ? own[i] : bridgedPicture(f, pixelRatio, settled).catch(() => null)))),
      ]);

      const ctx = canvas.getContext('2d');
      frames.forEach((f, i) => {
        const shot = frameShots[i];
        f.captured = !!shot;
        f.selfReported = !!shot && !f.doc;
        withClip(ctx, f.visible, pixelRatio, () => {
          if (!shot) {
            paintPlaceholder(ctx, f.box, pixelRatio);
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
        shot?.close?.();
      });

      const blob = await toPngBlob(canvas);
      return {
        blob,
        width,
        height,
        pixelRatio,
        freezeMs: Math.round(performance.now() - t0),
        frames: frames.map(({ title, box, depth, captured, selfReported }) => ({
          title,
          box,
          depth,
          captured,
          selfReported,
        })),
        page,
        source: 'raster',
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

  global.CodemanCapture = Object.freeze({ freeze, CAPTURE_UI_SELECTOR, tabModeSupported, stopTabCapture });
})(window);
