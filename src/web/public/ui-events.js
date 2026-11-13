/**
 * @fileoverview Reports what a person did in the canvas and the classic tab strip to the
 * server's `ui-events.jsonl`, through `POST /api/client-errors` with `kind: "ui"`.
 *
 * One reporter for both pages (`index.html` and `canvas.html` load this file), exposed as
 * `window.CodemanUiEvents.record(surface, action, target)`. It carries tokens only: an
 * action name and an optional id or state word. A value with whitespace is dropped here
 * and refused by the route, so a session name, a prompt or object text cannot travel.
 *
 * Bounded four ways. Events wait in a batch of at most `MAX_BATCH` and one request leaves
 * every `FLUSH_MS`; the same event repeated in a row is one entry with a count; a page
 * load sends at most `MAX_PER_LOAD` entries; and an event recorded while the page is
 * hidden or the browser is offline is dropped. Nothing is retried and no failure surfaces.
 *
 * @loadorder before app.js on the dashboard, before canvas.js on the canvas pages
 */
(function (root) {
  'use strict';
  const MAX_BATCH = 25;
  const FLUSH_MS = 2000;
  const MAX_PER_LOAD = 1000;
  const SURFACES = ['canvas', 'tab-strip'];
  const ACTION = /^[a-z][a-z0-9._-]{0,39}$/;
  const TARGET = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

  function create(env) {
    let queue = [];
    let timer = null;
    let entries = 0;
    const live = () => env.visibility() !== 'hidden' && env.online() !== false;

    function flush() {
      if (timer !== null) env.clearTimer(timer);
      timer = null;
      if (!queue.length) return;
      const sent = env.now();
      const events = queue.map(({ at, ...event }) => ({ ...event, agoMs: Math.min(600000, Math.max(0, sent - at)) }));
      queue = [];
      try {
        env.post({ kind: 'ui', events });
      } catch {
        /* A reporter that throws would surface in the page it is observing. */
      }
    }

    function record(surface, action, target) {
      try {
        if (!SURFACES.includes(surface) || typeof action !== 'string' || !ACTION.test(action)) return false;
        const token = target === undefined || target === null ? null : String(target);
        if (token !== null && !TARGET.test(token)) return false;
        if (!live()) return false;
        const last = queue[queue.length - 1];
        if (last && last.surface === surface && last.action === action && (last.target ?? null) === token) {
          last.n = Math.min(10000, (last.n || 1) + 1);
          return true;
        }
        if (queue.length >= MAX_BATCH || entries >= MAX_PER_LOAD) return false;
        entries++;
        queue.push(
          token === null ? { surface, action, at: env.now() } : { surface, action, target: token, at: env.now() }
        );
        if (timer === null) timer = env.setTimer(flush, FLUSH_MS);
        return true;
      } catch {
        return false;
      }
    }

    // A click that leaves the page (the Canvas link, a full view on a phone) would lose its own event.
    env.onLeave(flush);
    return { record, flush };
  }

  const reporter = create({
    now: () => Date.now(),
    visibility: () => root.document.visibilityState,
    online: () => root.navigator.onLine,
    setTimer: (fn, ms) => root.setTimeout(fn, ms),
    clearTimer: (id) => root.clearTimeout(id),
    onLeave: (fn) => {
      root.addEventListener('pagehide', fn);
      root.document.addEventListener('visibilitychange', () => {
        if (root.document.visibilityState === 'hidden') fn();
      });
    },
    post: (body) => {
      const base = new URL(root.document.baseURI).pathname.replace(/\/$/, '');
      root
        .fetch(`${base}/api/client-errors`, {
          method: 'POST',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        .catch(() => {});
    },
  });
  root.CodemanUiEvents = { ...reporter, create, MAX_BATCH, FLUSH_MS, MAX_PER_LOAD };
})(window);
