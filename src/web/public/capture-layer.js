/**
 * @fileoverview Capture highlight layer (ambient capture, intent/2026-11-19-ambient-capture.md, ticket 3).
 *
 * `CodemanCaptureLayer.open()` freezes the screen through `CodemanCapture.freeze()` FIRST and only then
 * builds the overlay (I1: nothing changes on screen before the clean picture exists). The overlay
 * (`[data-codeman-capture]`, so a later freeze leaves it out) shows the frozen picture; pointer events
 * draw one freehand outline, closed on release, and a note panel beside it holds the note, Send,
 * Redraw and Cancel. Escape cancels through `close()`, which the dashboard's global Escape handler
 * calls and which does nothing while the overlay is shut.
 *
 * Data shapes:
 * - an outline is `[[x, y], ...]` in CSS px of the frozen viewport, rounded to 0.1 px BEFORE anything
 *   draws it, so the path stored in `capture.json` redraws the marked pictures exactly (I2);
 * - an `under` entry is one of `{ kind: 'object', id }`, `{ kind: 'terminal', sessionId }` (never
 *   its buffer text), `{ kind: 'frame', title, objectId?, elements? }` or
 *   `{ kind: 'element', selector, text }`, at most UNDER_LIMITS.entries of them;
 * - the bundle is `{ files: [{ name, blob }], json }`: `clean.png` (the frozen blob itself, never
 *   drawn on), `marked-crop.png`, `marked-wide.png` and `capture.json` (version 1).
 *
 * A capture built from a picked or pasted image (`source: 'image'`, the phone flow of ticket 6)
 * records the page facts under `openedFrom`, never `page`, and has no `under` list (I9).
 *
 * Send hands the bundle to the sender registered with `setSender()` (filing, ticket 4) and closes only
 * when it resolves. With no sender, or when it throws, the panel says why and keeps the capture.
 *
 * @dependency capture.js (CodemanCapture.freeze, CAPTURE_UI_SELECTOR)
 * @loadorder 16.8 (after capture.js; defines a global, used on demand)
 */

(function initCaptureLayer(global) {
  'use strict';

  const CAPTURE_UI = 'data-codeman-capture';
  /** Marked crop margin around the outline's bounding box, CSS px. */
  const CROP_MARGIN = 48;
  /** The outline as drawn into the marked pictures, in CSS px: a dark halo under a red line. */
  const INK = { color: '#ff3b5c', width: 3, halo: 'rgba(0, 0, 0, 0.55)', haloWidth: 6 };
  /** What the `under` reader keeps, as the frame bridge bounds its own answers (spec: 24 and 2000). */
  const UNDER_LIMITS = { samples: 400, entries: 24, text: 2000, selector: 1024, frameDepth: 2 };
  const FRAME_QUERY_MS = 500;
  const MIN_PATH_POINTS = 3;

  // ───────────── pure helpers (no DOM) ─────────────

  const round1 = (n) => Math.round(n * 10) / 10;

  /** The path as stored and drawn: finite points, 0.1 px precision, consecutive duplicates dropped. */
  function normalisePath(points) {
    const out = [];
    for (const p of points || []) {
      if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
      const q = [round1(p[0]), round1(p[1])];
      const last = out[out.length - 1];
      if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
    }
    return out;
  }

  function boundsOf(path) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [x, y] of path) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  /** The marked crop in CSS px: the outline's bounding box plus CROP_MARGIN, clamped to the picture. */
  function cropBox(path, width, height) {
    if (path.length === 0) return { x: 0, y: 0, width, height };
    const b = boundsOf(path);
    const x = Math.max(0, Math.floor(b.x - CROP_MARGIN));
    const y = Math.max(0, Math.floor(b.y - CROP_MARGIN));
    const right = Math.min(width, Math.ceil(b.x + b.width + CROP_MARGIN));
    const bottom = Math.min(height, Math.ceil(b.y + b.height + CROP_MARGIN));
    return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
  }

  function insidePolygon(x, y, polygon) {
    let hit = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, yi] = polygon[i];
      const [xj, yj] = polygon[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  }

  /**
   * Points to sample inside the closed outline: a square grid over its bounding box sized so the box
   * holds at most `max` cells, keeping the cell centres inside the loop. A loop too thin to hold one
   * centre is sampled along its own points instead. Never more than `max` points.
   */
  function samplePoints(path, max = UNDER_LIMITS.samples) {
    if (path.length < MIN_PATH_POINTS) return [];
    const b = boundsOf(path);
    const step = Math.max(1, Math.sqrt((Math.max(b.width, 1) * Math.max(b.height, 1)) / max));
    const out = [];
    for (let y = b.y + step / 2; y < b.y + b.height; y += step) {
      for (let x = b.x + step / 2; x < b.x + b.width; x += step) {
        if (insidePolygon(x, y, path)) out.push([x, y]);
        if (out.length >= max) return out;
      }
    }
    if (out.length) return out;
    const every = Math.max(1, Math.ceil(path.length / max));
    return path.filter((_, i) => i % every === 0).slice(0, max);
  }

  const clip = (value, max) => {
    const s = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
    return s.length > max ? s.slice(0, max) : s;
  };

  /** Deduplicate `under` entries by what they name and cap their count and strings. */
  function capUnder(entries) {
    const seen = new Set();
    const out = [];
    for (const e of entries) {
      if (!e || typeof e !== 'object') continue;
      const key =
        e.kind === 'object'
          ? `o:${e.id}`
          : e.kind === 'terminal'
            ? `t:${e.sessionId}`
            : e.kind === 'frame'
              ? `f:${e.objectId || ''}:${e.title}:${e.depth || 1}`
              : `e:${e.selector}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const kept = { ...e };
      if (kept.kind === 'element') {
        kept.selector = clip(kept.selector, UNDER_LIMITS.selector);
        kept.text = clip(kept.text, UNDER_LIMITS.text);
      }
      if (kept.kind === 'frame') kept.title = clip(kept.title, UNDER_LIMITS.text);
      out.push(kept);
      if (out.length >= UNDER_LIMITS.entries) break;
    }
    return out;
  }

  /**
   * `capture.json`, version 1. `facts` is the page the capture was made on (`dom`) or opened from
   * (`image`, I9: under `openedFrom`, with no `under` list).
   */
  function buildCaptureJson(input) {
    const image = input.source === 'image';
    const json = {
      version: 1,
      source: image ? 'image' : 'dom',
      path: input.path,
      dpr: input.dpr,
      scale: input.scale ?? 1,
      crop: input.crop,
      size: { width: input.width, height: input.height },
    };
    if (!image) {
      json.picture = input.picture || 'raster';
      json.under = capUnder(input.under || []);
      json.page = input.facts;
    } else {
      json.openedFrom = input.facts;
    }
    json.frames = image
      ? []
      : (input.frames || []).map((f) => ({
          title: f.title,
          box: f.box,
          depth: f.depth,
          captured: !!f.captured,
          selfReported: !!f.selfReported,
        }));
    json.workspaceRule = input.workspaceRule ?? null;
    json.freezeMs = input.freezeMs ?? null;
    json.capturedAt = input.capturedAt;
    return json;
  }

  // ───────────── drawing (shared by the overlay preview and the marked pictures) ─────────────

  function tracePath(ctx, path) {
    ctx.beginPath();
    path.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  }

  /**
   * The outline as it appears in `marked-crop` and `marked-wide`: `path` in CSS px, drawn at `ratio`
   * device px per CSS px, shifted by `offset` CSS px (the crop's origin). The ONE draw function both
   * marked pictures use, so redrawing the stored path onto `clean.png` reproduces them (I2).
   */
  function drawOutline(ctx, path, ratio, offset = { x: 0, y: 0 }, closed = true) {
    if (path.length < 2) return;
    ctx.save();
    ctx.setTransform(ratio, 0, 0, ratio, -offset.x * ratio, -offset.y * ratio);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    tracePath(ctx, path);
    if (closed) ctx.closePath();
    ctx.strokeStyle = INK.halo;
    ctx.lineWidth = INK.haloWidth;
    ctx.stroke();
    ctx.strokeStyle = INK.color;
    ctx.lineWidth = INK.width;
    ctx.stroke();
    ctx.restore();
  }

  function toPng(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('capture: toBlob returned nothing'))),
        'image/png'
      );
    });
  }

  /**
   * A marked picture from the clean bitmap and the stored path: the whole picture (`crop` absent) or
   * the crop box, both in CSS px; `ratio` is the picture's device px per CSS px.
   */
  async function renderMarked(bitmap, path, ratio, crop) {
    const box = crop || { x: 0, y: 0, width: bitmap.width / ratio, height: bitmap.height / ratio };
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(box.width * ratio));
    canvas.height = Math.max(1, Math.round(box.height * ratio));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, -Math.round(box.x * ratio), -Math.round(box.y * ratio));
    drawOutline(ctx, path, ratio, box);
    return toPng(canvas);
  }

  /** The bundle the sender files: four files and the `capture.json` object. */
  async function buildBundle({ frozen, bitmap, path, under, facts }) {
    const ratio = frozen.pixelRatio;
    const crop = cropBox(path, frozen.width, frozen.height);
    const [markedCrop, markedWide] = await Promise.all([
      renderMarked(bitmap, path, ratio, crop),
      renderMarked(bitmap, path, ratio, null),
    ]);
    const json = buildCaptureJson({
      source: frozen.source === 'image' ? 'image' : 'dom',
      picture: frozen.source,
      path,
      dpr: ratio,
      scale: 1,
      crop,
      width: frozen.width,
      height: frozen.height,
      under,
      facts,
      frames: frozen.frames,
      freezeMs: frozen.freezeMs,
      capturedAt: frozen.page?.capturedAt || new Date().toISOString(),
    });
    return {
      json,
      files: [
        { name: 'clean.png', blob: frozen.blob },
        { name: 'marked-crop.png', blob: markedCrop },
        { name: 'marked-wide.png', blob: markedWide },
        { name: 'capture.json', blob: new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' }) },
      ],
    };
  }

  // ───────────── page facts and the `under` reader ─────────────

  function pageFacts(frozen) {
    const app = global.app;
    const page = frozen.page || {};
    const sessionId = page.sessionId ?? null;
    let caseName = null;
    try {
      const session = sessionId ? app?.sessions?.get(sessionId) : null;
      if (session) caseName = app._tabClusterIdentity?.(session, sessionId)?.label || null;
    } catch {
      caseName = null;
    }
    const view = app?._tileGrid ? 'tiles' : app?._splitPane ? 'split' : 'single';
    return {
      path: page.path ?? global.location.pathname,
      title: page.title ?? document.title,
      view,
      theme: document.documentElement.dataset.skin || null,
      viewport: page.viewport ?? { width: frozen.width, height: frozen.height },
      devicePixelRatio: page.devicePixelRatio ?? global.devicePixelRatio ?? 1,
      build: app?._buildId ?? null,
      sessionId,
      case: caseName,
    };
  }

  function selectorOf(el) {
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && parts.length < 4; node = node.parentElement) {
      const tag = node.localName;
      if (tag === 'html' || tag === 'body') break;
      if (node.id) {
        parts.unshift(`${tag}#${CSS.escape(node.id)}`);
        break;
      }
      const classes = Array.from(node.classList)
        .slice(0, 3)
        .map((c) => `.${CSS.escape(c)}`)
        .join('');
      parts.unshift(tag + classes);
    }
    return parts.join(' > ');
  }

  function textOf(el) {
    if (el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return '';
    return clip(el.innerText ?? el.textContent ?? '', UNDER_LIMITS.text);
  }

  function readableDocument(frame) {
    try {
      const doc = frame.contentDocument;
      return doc && doc.body ? doc : null;
    } catch {
      return null;
    }
  }

  function terminalSession(el) {
    const host = el.closest('[data-session-id]');
    if (host?.dataset.sessionId) return host.dataset.sessionId;
    const app = el.ownerDocument.defaultView?.app;
    if (!app) return null;
    if (app._splitPane?.mountEl?.contains(el)) return app._splitPane.sessionId ?? null;
    if (el.closest('#terminalContainer')) return app.activeSessionId ?? null;
    return null;
  }

  /** One `under` entry for the top-most element at a point, or null for nothing worth naming. */
  function describe(el) {
    if (el.matches('input[type="password"]')) return null;
    const object = el.closest('[data-object-id]');
    if (object) return { kind: 'object', id: object.dataset.objectId };
    if (el.closest('.xterm')) {
      const sessionId = terminalSession(el);
      return sessionId ? { kind: 'terminal', sessionId } : null;
    }
    const selector = selectorOf(el);
    return selector ? { kind: 'element', selector, text: textOf(el) } : null;
  }

  /** Ask a bridged frame which of its elements the outline covers; resolves to its answer or []. */
  function queryFrame(frame, polygon) {
    const target = frame.contentWindow;
    if (!target || !global.crypto?.randomUUID) return Promise.resolve([]);
    const requestId = global.crypto.randomUUID();
    return new Promise((resolve) => {
      const finish = (value) => {
        clearTimeout(timer);
        global.removeEventListener('message', heard);
        resolve(value);
      };
      function heard(e) {
        if (e.source !== target || e.origin !== 'null') return;
        const data = e.data;
        if (!data || data.type !== 'codeman:frame-elements' || data.requestId !== requestId) return;
        finish(Array.isArray(data.elements) ? data.elements.slice(0, UNDER_LIMITS.entries) : []);
      }
      const timer = setTimeout(() => finish([]), FRAME_QUERY_MS);
      global.addEventListener('message', heard);
      try {
        target.postMessage({ type: 'codeman:query-polygon', requestId, points: polygon }, '*');
      } catch {
        finish([]);
      }
    });
  }

  /** A frame's answer, kept to plain strings (every one of them is the page's own text). */
  function frameElements(answer) {
    return answer
      .filter((e) => e && typeof e === 'object')
      .map((e) => ({
        selector: clip(e.selector, UNDER_LIMITS.selector),
        text: clip(e.text, UNDER_LIMITS.text),
      }))
      .filter((e) => e.selector);
  }

  /**
   * What lies under the outline: `elementsFromPoint` at up to UNDER_LIMITS.samples points inside it,
   * skipping the capture UI. A same-origin frame is read through its own document (depth at most 2);
   * a bridged frame directly in this document is asked with `codeman:query-polygon`.
   */
  async function readUnder(path) {
    const points = samplePoints(path);
    const entries = [];
    const frames = new Map();

    const visit = (doc, x, y, origin, scale, depth) => {
      const stack = doc.elementsFromPoint(x, y);
      const top = stack.find((el) => !el.closest(`[${CAPTURE_UI}]`) && el !== doc.documentElement && el !== doc.body);
      if (!top) return;
      if (top.localName === 'iframe') {
        const rect = top.getBoundingClientRect();
        let frame = frames.get(top);
        if (!frame) {
          frame = {
            el: top,
            depth,
            origin: {
              x: origin.x + (rect.left + top.clientLeft) * scale,
              y: origin.y + (rect.top + top.clientTop) * scale,
            },
            scale,
            entry: {
              kind: 'frame',
              title: top.title || '',
              objectId: top.closest('[data-object-id]')?.dataset.objectId,
              depth,
            },
          };
          if (!frame.entry.objectId) delete frame.entry.objectId;
          frames.set(top, frame);
          entries.push(frame.entry);
        }
        const inner = readableDocument(top);
        if (inner && depth < UNDER_LIMITS.frameDepth)
          visit(inner, x - rect.left - top.clientLeft, y - rect.top - top.clientTop, frame.origin, scale, depth + 1);
        return;
      }
      const entry = describe(top);
      if (entry) entries.push(entry);
    };

    for (const [x, y] of points) visit(document, x, y, { x: 0, y: 0 }, 1, 1);

    const asks = [];
    for (const frame of frames.values()) {
      if (frame.depth !== 1 || readableDocument(frame.el)) continue;
      const rect = frame.el.getBoundingClientRect();
      const local = path.map(([x, y]) => [x - rect.left - frame.el.clientLeft, y - rect.top - frame.el.clientTop]);
      asks.push(
        queryFrame(frame.el, local).then((answer) => {
          const elements = frameElements(answer);
          if (elements.length) frame.entry.elements = elements;
        })
      );
    }
    await Promise.all(asks);
    return capUnder(entries);
  }

  // ───────────── the overlay ─────────────

  let state = null;
  let sender = null;

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'text') node.textContent = v;
      else if (k === 'class') node.className = v;
      else node.setAttribute(k, v);
    }
    for (const child of children) node.appendChild(child);
    return node;
  }

  function sizeCanvas(canvas, width, height) {
    const r = global.devicePixelRatio || 1;
    canvas.width = Math.round(width * r);
    canvas.height = Math.round(height * r);
    return r;
  }

  /** The live preview: dim outside the loop, then the same outline the marked pictures carry. */
  function paintInk(s) {
    const ctx = s.ink.getContext('2d');
    const r = s.inkRatio;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, s.ink.width, s.ink.height);
    const path = s.path;
    if (path.length < 2) return;
    if (!s.drawing) {
      ctx.setTransform(r, 0, 0, r, 0, 0);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.fillRect(0, 0, s.frozen.width, s.frozen.height);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = '#000';
      tracePath(ctx, path);
      ctx.closePath();
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
    drawOutline(ctx, path, r, { x: 0, y: 0 }, !s.drawing);
  }

  function setStatus(s, message) {
    s.status.textContent = message || '';
    s.status.hidden = !message;
  }

  function placePanel(s) {
    const panel = s.panel;
    panel.hidden = false;
    const gap = 16;
    const { width, height } = panel.getBoundingClientRect();
    const vw = global.innerWidth;
    const vh = global.innerHeight;
    let left;
    let top;
    if (s.path.length >= MIN_PATH_POINTS) {
      // Beside the outline (right, then left), else below or above it, so the panel never covers it
      // while there is room anywhere.
      const b = boundsOf(s.path);
      const right = b.x + b.width + gap;
      const leftSide = b.x - gap - width;
      const below = b.y + b.height + gap;
      const above = b.y - gap - height;
      if (right + width <= vw - 8) [left, top] = [right, b.y];
      else if (leftSide >= 8) [left, top] = [leftSide, b.y];
      else if (below + height <= vh - 8) [left, top] = [b.x, below];
      else if (above >= 8) [left, top] = [b.x, above];
      else [left, top] = [right, b.y];
    } else {
      left = (vw - width) / 2;
      top = (vh - height) / 2;
    }
    panel.style.left = `${Math.round(Math.max(8, Math.min(left, vw - width - 8)))}px`;
    panel.style.top = `${Math.round(Math.max(8, Math.min(top, vh - height - 8)))}px`;
  }

  function showPanel(s) {
    s.hint.hidden = true;
    setStatus(s, '');
    placePanel(s);
    s.note.focus({ preventScroll: true });
  }

  function redraw() {
    const s = state;
    if (!s || s.sending) return;
    s.path = [];
    s.under = null;
    s.underRead = null;
    s.panel.hidden = true;
    s.hint.hidden = false;
    paintInk(s);
    s.root.focus({ preventScroll: true });
  }

  /** Close the overlay. Safe to call at any time: it does nothing while the overlay is shut. */
  function close() {
    const s = state;
    if (!s) return false;
    state = null;
    s.bitmap.close?.();
    s.root.remove();
    if (s.returnFocus?.isConnected) s.returnFocus.focus?.({ preventScroll: true });
    return true;
  }

  async function send() {
    const s = state;
    if (!s || s.sending) return;
    if (!sender) {
      setStatus(s, 'Filing is not available yet. Your capture is kept here.');
      return;
    }
    s.sending = true;
    s.sendBtn.disabled = true;
    setStatus(s, 'Sending…');
    try {
      const under = s.source === 'image' ? [] : await (s.underRead || readUnder(s.path));
      const bundle = await buildBundle({ frozen: s.frozen, bitmap: s.bitmap, path: s.path, under, facts: s.facts });
      await sender({ bundle, note: s.note.value, facts: s.facts });
      if (state === s) close();
    } catch (err) {
      if (state !== s) return;
      setStatus(s, err?.message ? `Not sent: ${err.message}` : 'Not sent. Your capture is kept here.');
    } finally {
      s.sending = false;
      s.sendBtn.disabled = false;
    }
  }

  function build(frozen, bitmap) {
    const root = el('div', {
      class: 'capture-layer',
      [CAPTURE_UI]: '',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Capture',
      tabindex: '-1',
      'data-i18n-skip': '',
    });
    const picture = el('canvas', { class: 'capture-picture', 'aria-hidden': 'true' });
    const ink = el('canvas', { class: 'capture-ink', 'aria-hidden': 'true' });
    const hint = el('div', {
      class: 'capture-hint',
      role: 'status',
      text: 'Draw around what bothers you · Enter to skip · Esc to cancel',
    });
    const note = el('textarea', {
      class: 'capture-note',
      rows: '4',
      maxlength: '4000',
      'aria-label': 'Note',
      placeholder: 'What is wrong here?',
    });
    const status = el('div', { class: 'capture-status', role: 'status' });
    status.hidden = true;
    const redrawBtn = el('button', { type: 'button', class: 'capture-btn', text: 'Redraw' });
    const cancelBtn = el('button', { type: 'button', class: 'capture-btn', text: 'Cancel' });
    const sendBtn = el('button', { type: 'submit', class: 'capture-btn capture-btn--primary', text: 'Send' });
    const heading = el('h2', { class: 'capture-title', id: 'captureTitle', text: 'New Work item' });
    const panel = el('form', { class: 'capture-panel', 'aria-labelledby': 'captureTitle' }, [
      el('div', { class: 'capture-head' }, [heading, el('span', { class: 'capture-chip', text: 'Needs refinement' })]),
      note,
      el('p', {
        class: 'capture-facts',
        text: 'Attaches the clean picture, a marked crop, the marked screen and capture.json.',
      }),
      status,
      el('div', { class: 'capture-actions' }, [redrawBtn, cancelBtn, sendBtn]),
    ]);
    panel.hidden = true;
    root.append(picture, ink, hint, panel);

    picture.width = bitmap.width;
    picture.height = bitmap.height;
    picture.getContext('2d').drawImage(bitmap, 0, 0);

    const s = {
      frozen,
      bitmap,
      source: frozen.source === 'image' ? 'image' : 'dom',
      root,
      ink,
      inkRatio: sizeCanvas(ink, frozen.width, frozen.height),
      hint,
      panel,
      note,
      status,
      sendBtn,
      path: [],
      drawing: false,
      sending: false,
      under: null,
      underRead: null,
      facts: pageFacts(frozen),
      returnFocus: document.activeElement,
    };

    root.addEventListener('pointerdown', (e) => {
      if (panel.contains(e.target) || e.button !== 0 || s.sending) return;
      e.preventDefault();
      s.drawing = true;
      s.path = normalisePath([[e.clientX, e.clientY]]);
      panel.hidden = true;
      hint.hidden = true;
      root.setPointerCapture?.(e.pointerId);
      paintInk(s);
    });
    root.addEventListener('pointermove', (e) => {
      if (!s.drawing) return;
      const events = e.getCoalescedEvents?.() || [e];
      s.path = normalisePath(s.path.concat(events.map((ev) => [ev.clientX, ev.clientY])));
      paintInk(s);
    });
    const release = () => {
      if (!s.drawing) return;
      s.drawing = false;
      if (s.path.length < MIN_PATH_POINTS) {
        redraw();
        return;
      }
      paintInk(s);
      if (s.source !== 'image') s.underRead = readUnder(s.path);
      showPanel(s);
    };
    root.addEventListener('pointerup', release);
    root.addEventListener('pointercancel', release);
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !panel.contains(e.target) && panel.hidden && !s.drawing) {
        e.preventDefault();
        showPanel(s);
      }
      if (e.key === 'Tab') {
        const focusable = panel.hidden ? [] : Array.from(panel.querySelectorAll('textarea, button:not(:disabled)'));
        if (!focusable.length) {
          e.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });
    note.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        send();
      }
    });
    redrawBtn.addEventListener('click', redraw);
    cancelBtn.addEventListener('click', close);
    panel.addEventListener('submit', (e) => {
      e.preventDefault();
      send();
    });
    return s;
  }

  /**
   * Freeze, then show the overlay. Resolves when the overlay is up (or immediately when one already is).
   * `frozen` is for callers that already hold a picture (the phone's pasted image, `source: 'image'`).
   */
  async function open(frozen) {
    if (state) return true;
    const picture = frozen || (await global.CodemanCapture.freeze());
    if (state) return true;
    const bitmap = await global.createImageBitmap(picture.blob);
    if (state) {
      bitmap.close?.();
      return true;
    }
    state = build(picture, bitmap);
    document.body.appendChild(state.root);
    state.root.focus({ preventScroll: true });
    return true;
  }

  global.CodemanCaptureLayer = Object.freeze({
    open,
    close,
    isOpen: () => !!state,
    setSender: (fn) => {
      sender = typeof fn === 'function' ? fn : null;
    },
    /** Test hook: draw an outline as a pointer would, then release it. */
    drawForTest(points) {
      const s = state;
      if (!s) return false;
      s.path = normalisePath(points);
      paintInk(s);
      if (s.path.length < MIN_PATH_POINTS) return false;
      if (s.source !== 'image') s.underRead = readUnder(s.path);
      showPanel(s);
      return true;
    },
    buildBundle,
    renderMarked,
    readUnder,
    pure: Object.freeze({
      normalisePath,
      cropBox,
      samplePoints,
      insidePolygon,
      capUnder,
      buildCaptureJson,
      CROP_MARGIN,
      UNDER_LIMITS,
    }),
  });
})(window);
