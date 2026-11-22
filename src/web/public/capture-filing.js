/**
 * @fileoverview Capture filing and outbox (ambient capture, intent/2026-11-19-ambient-capture.md, ticket 4).
 *
 * Registers the sender behind the capture panel's Send (`CodemanCaptureLayer.setSender()`). Send is the
 * only way a capture enters the outbox, and the outbox only finishes a send that already happened, so
 * nothing else files a capture (I4: OnlyAPersonFiles).
 *
 * Send:
 * 1. resolves the workspace (I7: TheWorkspaceIsTheOneOnScreen) in the order `page` (the canvas workspace
 *    this page shows), `session` (the shown session's case), `home` (Codeman's own case, from
 *    `GET /api/capture/home-case`). A case's workspace comes from `POST /api/canvas/workspaces`, which
 *    answers only for a case the person may use. A rule that refuses (4xx) is skipped; one that cannot
 *    be asked now (offline, 5xx, the other deploy colour) stops the walk and leaves it to the outbox.
 *    With no rule left, Send is refused in the panel and the capture stays there;
 * 2. re-encodes a picture over the Work file cap as WebP (JPEG where the browser has no WebP encoder) at
 *    quality 0.92, scaled by 0.75 until it fits, and lists that in `capture.json` under `encoded`;
 * 3. stores one outbox record keyed by a new `requestId` and closes the panel.
 *
 * The outbox files a record in two steps (I5: FilingIsRetrySafe): `POST .../work` with the record's
 * `requestId` and `status: "needs-refinement"` (I6), which returns the same item on every retry; then,
 * before each attachment, a read of the item, uploading a file only when no attachment has its name.
 * The record is deleted once the item reads back with every file, and a toast names the item.
 *
 * The outbox is IndexedDB `codeman-capture-outbox` (store `captures`), every access in try/catch, with
 * an in-memory fallback that is lost on reload (a toast says so when such a record cannot file at once).
 * It drains on Send, on SSE reconnect (`retry()`, from app.js `handleInit`), on `online` and on page
 * load, one tab at a time (Web Locks when present), with backoff from 2 s to 5 min. A refusal that a
 * retry cannot change (a 4xx other than 408, 409 and 429) parks the record as `blocked` and says why.
 * The pending count is published as the `codeman:capture-outbox` window event and on any
 * `[data-capture-button]` as `data-capture-pending`.
 *
 * Record: `{ requestId, workspaceId|null, rule|null, facts, key|null, title, description, json,
 * files: [{ name, blob }], attempts, nextAt, blocked|null, lastRefusal?, createdAt }`. `capture.json` is written from
 * `json` at upload, so `workspaceRule` is the rule that chose the workspace.
 *
 * @dependency capture-layer.js (CodemanCaptureLayer.setSender), constants.js (CodemanBase)
 * @loadorder 16.9 (after capture-layer.js)
 */

(function initCaptureFiling(global) {
  'use strict';

  /** The Work file cap: `MAX_WORK_FILE_BYTES` in src/canvas/work-files.ts (pinned by test/capture-filing.test.ts). */
  const MAX_FILE_BYTES = 8 * 1024 * 1024;
  const MAX_TITLE = 200;
  const ENCODE = { quality: 0.92, step: 0.75, tries: 12 };
  const BACKOFF = { firstMs: 2_000, maxMs: 5 * 60_000 };
  const DB = { name: 'codeman-capture-outbox', store: 'captures', version: 1 };
  const STATUS = 'needs-refinement';
  const RULES = ['page', 'session', 'home'];
  const WORKSPACE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
  const JSON_NAME = 'capture.json';

  // ───────────── pure helpers ─────────────

  /** Thrown for an answer a retry can change (offline, 5xx, 408, 409, 429). */
  class Transient extends Error {}
  /** Thrown for a refusal a retry cannot change. */
  class Refused extends Error {}

  const transientStatus = (status) => status >= 500 || status === 408 || status === 409 || status === 429;

  /**
   * The workspace a capture files into (I7). `facts` holds what the page knows: `page` (a workspace id)
   * and `session` (a case name). `lookup(rule, value)` answers `{ workspaceId }`, `{ skip: true }` (the
   * rule does not apply or the person may not write it) or throws Transient. Resolves to
   * `{ rule, workspaceId }` or `null` when no rule applies.
   */
  async function resolveWorkspace(facts, lookup) {
    for (const rule of RULES) {
      const value = rule === 'home' ? null : facts[rule];
      if (rule !== 'home' && !value) continue;
      const answer = await lookup(rule, value);
      if (answer && typeof answer.workspaceId === 'string' && WORKSPACE_ID.test(answer.workspaceId))
        return { rule, workspaceId: answer.workspaceId };
    }
    return null;
  }

  /** The item's title and description, from the note and the page facts (I9 for a picked image). */
  function describeCapture({ note, facts, source }) {
    const text = typeof note === 'string' ? note.replace(/\r\n?/g, '\n').trim() : '';
    const firstLine = text.split('\n').find((l) => l.trim()) || '';
    const pageTitle = (facts && typeof facts.title === 'string' && facts.title.trim()) || 'Codeman';
    const title = (firstLine.trim() || `Capture: ${pageTitle}`).replace(/\s+/g, ' ').slice(0, MAX_TITLE);
    const path = (facts && typeof facts.path === 'string' && facts.path) || '/';
    const build = facts && typeof facts.build === 'string' && facts.build ? facts.build.slice(0, 12) : null;
    const where =
      source === 'image'
        ? `Where capture was opened: ${path}`
        : `Captured on ${path}${build ? `, build ${build}` : ''}`;
    return { title, description: text ? `${text}\n\n${where}` : where };
  }

  /** The create body (I5, I6). Status is always sent: the route's default is Backlog. */
  function createBody(record) {
    return { requestId: record.requestId, status: STATUS, title: record.title, description: record.description };
  }

  /** Names of the record's files that the item does not carry yet. */
  function missingFiles(item, names) {
    const have = new Set(((item && item.attachments) || []).filter((a) => a && a.kind !== 'object').map((a) => a.name));
    return names.filter((n) => !have.has(n));
  }

  /** Delay before attempt `attempts + 1`: 2 s, doubling, at most 5 min. */
  function backoffMs(attempts) {
    return Math.min(BACKOFF.maxMs, BACKOFF.firstMs * 2 ** Math.max(0, attempts - 1));
  }

  /** The page's canvas workspace: the canvas page's meta tag, else a `/canvas/<id>` address. */
  function pageWorkspace(doc = global.document, path = global.location?.pathname || '') {
    const meta = doc?.querySelector?.('meta[name="codeman-canvas-workspace"]')?.content || '';
    if (WORKSPACE_ID.test(meta)) return meta;
    const parts = path.split('/').filter(Boolean);
    const at = parts.lastIndexOf('canvas');
    return at >= 0 && at === parts.length - 2 && WORKSPACE_ID.test(parts[at + 1]) ? parts[at + 1] : null;
  }

  /** The shown session's case name, matched by folder against the case list (never a folder's own name). */
  function sessionCase(sessionId, app = global.app) {
    try {
      const session = sessionId ? app?.sessions?.get(sessionId) : null;
      const dir = (session?.workingDir || '').replace(/\/+$/, '');
      if (!dir || typeof app?._mobileOverviewCaseFor !== 'function') return null;
      return app._mobileOverviewCaseFor(dir, app.cases)?.name || null;
    } catch {
      return null;
    }
  }

  // ───────────── pictures over the cap ─────────────

  async function encode(bitmap, scale, type) {
    const canvas = global.document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob(resolve, type, ENCODE.quality));
  }

  /**
   * Files at or under the cap. A picture over it becomes WebP (or JPEG), scaled until it fits; the json
   * gains `encoded: [{ name, from, type, scale, quality }]`.
   */
  async function fitFiles(files, json, cap = MAX_FILE_BYTES) {
    const out = [];
    for (const file of files) {
      if (file.blob.size <= cap || !/\.png$/.test(file.name)) {
        out.push(file);
        continue;
      }
      const bitmap = await global.createImageBitmap(file.blob);
      try {
        let type = 'image/webp';
        let scale = 1;
        let blob = await encode(bitmap, scale, type);
        if (!blob || blob.type !== 'image/webp') {
          type = 'image/jpeg';
          blob = await encode(bitmap, scale, type);
        }
        for (let i = 0; blob && blob.size > cap && i < ENCODE.tries; i++) {
          scale = Math.round(scale * ENCODE.step * 1000) / 1000;
          blob = await encode(bitmap, scale, type);
        }
        if (!blob || blob.size > cap) throw new Refused(`${file.name} is too large to attach`);
        const name = file.name.replace(/\.png$/, type === 'image/webp' ? '.webp' : '.jpg');
        out.push({ name, blob });
        (json.encoded ||= []).push({ name, from: file.name, type, scale, quality: ENCODE.quality });
      } finally {
        bitmap.close?.();
      }
    }
    return out;
  }

  // ───────────── the outbox store ─────────────

  function memoryStore() {
    const map = new Map();
    return {
      durable: false,
      all: async () => [...map.values()],
      put: async (r) => void map.set(r.requestId, r),
      remove: async (id) => void map.delete(id),
    };
  }

  function idbRequest(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /** IndexedDB when it opens, else memory. Every access is guarded; a failed write falls back to memory. */
  async function openStore(idb = global.indexedDB) {
    const fallback = memoryStore();
    if (!idb) return fallback;
    let db;
    try {
      const open = idb.open(DB.name, DB.version);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains(DB.store))
          open.result.createObjectStore(DB.store, { keyPath: 'requestId' });
      };
      db = await idbRequest(open);
    } catch {
      return fallback;
    }
    const tx = (mode) => db.transaction(DB.store, mode).objectStore(DB.store);
    return {
      durable: true,
      async all() {
        try {
          return [...(await idbRequest(tx('readonly').getAll())), ...(await fallback.all())];
        } catch {
          return fallback.all();
        }
      },
      async put(record) {
        try {
          await idbRequest(tx('readwrite').put(record));
        } catch {
          await fallback.put(record);
          this.durable = false;
        }
      },
      async remove(id) {
        try {
          await idbRequest(tx('readwrite').delete(id));
        } catch {
          // Gone from the database already, or it cannot be reached: the memory copy goes either way.
        }
        await fallback.remove(id);
      },
    };
  }

  // ───────────── filing ─────────────

  /**
   * One filing service. Every outside effect is a dependency so a test can drive it against a real
   * server: `fetch(path, init)`, `store` (or `openStore`), `now()`, `setTimer(fn, ms)`, `notify(event)`
   * for toasts, `publish(pending)` for the button count, `lock(fn)` for one-tab-at-a-time, and `facts()`
   * returning `{ page, session }` for the resolver.
   */
  function create(deps) {
    const now = deps.now || Date.now;
    const setTimer = deps.setTimer || ((fn, ms) => global.setTimeout(fn, ms));
    const notify = deps.notify || (() => {});
    const publish = deps.publish || (() => {});
    const lock = deps.lock || ((fn) => fn());
    const storeReady = deps.store ? Promise.resolve(deps.store) : (deps.openStore || openStore)();
    let draining = null;
    let again = false;
    let timer = null;
    const warnedVolatile = new Set();

    async function call(path, init) {
      let res;
      try {
        res = await deps.fetch(path, { credentials: 'same-origin', ...init });
      } catch {
        throw new Transient('The server cannot be reached');
      }
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { status: res.status, ok: res.ok && body?.success !== false, body };
    }

    const json = (method, body) => ({
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    function failure(answer, what) {
      const message = (answer.body && answer.body.error) || `${what} failed (${answer.status})`;
      return transientStatus(answer.status) ? new Transient(message) : new Refused(message);
    }

    async function caseWorkspace(caseName) {
      const answer = await call('/api/canvas/workspaces', json('POST', { caseName }));
      if (answer.ok) return { workspaceId: answer.body.data?.workspace?.id };
      if (transientStatus(answer.status)) throw failure(answer, 'Opening the case workspace');
      return { skip: true };
    }

    async function lookup(rule, value) {
      if (rule === 'page') {
        const answer = await call('/api/canvas/workspaces', { method: 'GET' });
        if (!answer.ok) {
          if (transientStatus(answer.status)) throw failure(answer, 'Reading workspaces');
          return { skip: true };
        }
        const mine = (answer.body.data?.workspaces || []).some((w) => w && w.id === value);
        return mine ? { workspaceId: value } : { skip: true };
      }
      if (rule === 'session') return caseWorkspace(value);
      const answer = await call('/api/capture/home-case', { method: 'GET' });
      if (answer.ok && answer.body.data?.caseName) return caseWorkspace(answer.body.data.caseName);
      if (!answer.ok && transientStatus(answer.status)) throw failure(answer, "Finding Codeman's own case");
      return { skip: true };
    }

    async function readItem(record) {
      const answer = await call(`/api/canvas/${record.workspaceId}/work/${record.key}`, { method: 'GET' });
      if (!answer.ok) throw failure(answer, `Reading ${record.key}`);
      return answer.body.data.item;
    }

    function uploadBlob(record, file) {
      return file.name === JSON_NAME
        ? new Blob([JSON.stringify({ ...record.json, workspaceRule: record.rule }, null, 2)], {
            type: 'application/json',
          })
        : file.blob;
    }

    /** One record, start to finish. Resolves true when it is filed and deleted. */
    async function fileOne(store, record) {
      if (!record.workspaceId) {
        const target = await resolveWorkspace(record.facts, lookup);
        if (!target) throw new Refused('No canvas workspace you can write to was found for this capture');
        record.workspaceId = target.workspaceId;
        record.rule = target.rule;
        await store.put(record);
      }
      if (!record.key) {
        const answer = await call(`/api/canvas/${record.workspaceId}/work`, json('POST', createBody(record)));
        if (!answer.ok) throw failure(answer, 'Filing the capture');
        record.key = answer.body.data.item.key;
        await store.put(record);
      }
      const names = record.files.map((f) => f.name);
      for (const file of record.files) {
        if (!missingFiles(await readItem(record), [file.name]).length) continue;
        const path = `/api/canvas/${record.workspaceId}/work/${record.key}/attachments?name=${encodeURIComponent(file.name)}`;
        const answer = await call(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: uploadBlob(record, file),
        });
        if (!answer.ok) throw failure(answer, `Attaching ${file.name}`);
      }
      if (missingFiles(await readItem(record), names).length) throw new Transient('Some files did not attach');
      await store.remove(record.requestId);
      notify({ kind: 'filed', key: record.key, workspaceId: record.workspaceId });
      return true;
    }

    async function pending(store) {
      const records = await store.all();
      publish(records.length);
      return records;
    }

    function schedule(records) {
      const waiting = records.filter((r) => !r.blocked).map((r) => r.nextAt || 0);
      if (!waiting.length) return;
      const delay = Math.max(0, Math.min(...waiting) - now());
      if (timer) global.clearTimeout?.(timer);
      timer = setTimer(() => {
        timer = null;
        void drain();
      }, delay);
    }

    async function drainOnce() {
      const store = await storeReady;
      const records = (await pending(store)).filter((r) => !r.blocked && (r.nextAt || 0) <= now());
      for (const record of records) {
        try {
          await fileOne(store, record);
        } catch (err) {
          if (err instanceof Refused) {
            if (record.lastRefusal !== err.message)
              notify({ kind: 'blocked', message: err.message, requestId: record.requestId });
            record.blocked = err.message;
            record.lastRefusal = err.message;
          } else {
            record.attempts = (record.attempts || 0) + 1;
            record.nextAt = now() + backoffMs(record.attempts);
            if (!store.durable && !warnedVolatile.has(record.requestId)) {
              warnedVolatile.add(record.requestId);
              notify({ kind: 'volatile', requestId: record.requestId });
            } else if (record.attempts === 1) notify({ kind: 'queued', requestId: record.requestId });
          }
          await store.put(record);
        }
      }
      schedule(await pending(store));
    }

    /** Files every record that is due. Single-flight; a call during a drain runs one more pass after it. */
    function drain() {
      if (draining) {
        again = true;
        return draining;
      }
      draining = (async () => {
        do {
          again = false;
          await lock(drainOnce);
        } while (again);
      })().finally(() => {
        draining = null;
      });
      return draining;
    }

    /**
     * Retry everything now (an SSE reconnect or the network coming back). A parked record is tried again
     * too: the deploy colour, the person's access or the workspace may have changed. Its refusal is not
     * announced twice.
     */
    async function retry() {
      const store = await storeReady;
      for (const r of await store.all()) {
        r.nextAt = 0;
        r.blocked = null;
        await store.put(r);
      }
      return drain();
    }

    /**
     * The panel's Send. Resolves once the capture is in the outbox (the panel then closes) and throws,
     * keeping the capture in the panel, when no workspace rule applies (I7).
     */
    async function send({ bundle, note, facts }) {
      const source = bundle.json?.source === 'image' ? 'image' : 'dom';
      const where = deps.facts(facts);
      const json = { ...bundle.json };
      const files = await fitFiles(
        bundle.files.filter((f) => f.name !== JSON_NAME),
        json
      );
      files.push({ name: JSON_NAME, blob: null });
      let target = null;
      try {
        target = await resolveWorkspace(where, lookup);
        if (!target)
          throw new Error('No canvas workspace you can write to: open a case or its canvas, then Send again.');
      } catch (err) {
        if (!(err instanceof Transient)) throw err;
      }
      const record = {
        requestId: deps.uuid ? deps.uuid() : global.crypto.randomUUID(),
        workspaceId: target?.workspaceId ?? null,
        rule: target?.rule ?? null,
        facts: where,
        key: null,
        ...describeCapture({ note, facts, source }),
        json,
        files,
        attempts: 0,
        nextAt: 0,
        blocked: null,
        createdAt: now(),
      };
      const store = await storeReady;
      await store.put(record);
      void drain();
      return record.requestId;
    }

    return { send, drain, retry, pending: async () => (await pending(await storeReady)).length };
  }

  // ───────────── wiring on the dashboard ─────────────

  function workUrl(workspaceId, key) {
    const base = global.CodemanBase?.url ? global.CodemanBase.url('/') : '/';
    return `${base.replace(/\/$/, '')}/canvas/${encodeURIComponent(workspaceId)}?work=${encodeURIComponent(key)}`;
  }

  function toast(event) {
    const app = global.app;
    if (!app?.showToast) return;
    if (event.kind === 'filed')
      app.showToast(`Filed ${event.key}`, 'success', {
        duration: 8000,
        action: {
          label: 'Open',
          onClick: () => global.open(workUrl(event.workspaceId, event.key), '_blank', 'noopener'),
        },
      });
    else if (event.kind === 'queued') app.showToast('Capture saved. It will be filed when the server answers.', 'info');
    else if (event.kind === 'volatile')
      app.showToast('Capture saved in this tab only. It is lost if you reload before it is filed.', 'warning');
    else if (event.kind === 'blocked') app.showToast(`Capture not filed: ${event.message}`, 'error');
  }

  function publishPending(count) {
    for (const btn of global.document.querySelectorAll('[data-capture-button]'))
      if (count > 0) btn.dataset.capturePending = String(count);
      else delete btn.dataset.capturePending;
    global.dispatchEvent(new CustomEvent('codeman:capture-outbox', { detail: { pending: count } }));
  }

  const fetchApi = (path, init) => global.fetch(global.CodemanBase?.url ? global.CodemanBase.url(path) : path, init);

  let service = null;
  function start() {
    if (service || !global.CodemanCaptureLayer) return service;
    service = create({
      fetch: fetchApi,
      notify: toast,
      publish: publishPending,
      lock: (fn) => (global.navigator?.locks?.request ? global.navigator.locks.request(DB.name, fn) : fn()),
      facts: (facts) => ({
        page: pageWorkspace(),
        session: facts?.sessionId ? sessionCase(facts.sessionId) : null,
      }),
    });
    global.CodemanCaptureLayer.setSender((payload) => service.send(payload));
    global.addEventListener('online', () => void service.retry());
    void service.drain();
    return service;
  }

  global.CodemanCaptureFiling = Object.freeze({
    create,
    start,
    retry: () => (service ? service.retry() : Promise.resolve()),
    openStore,
    pure: Object.freeze({
      resolveWorkspace,
      describeCapture,
      createBody,
      missingFiles,
      backoffMs,
      pageWorkspace,
      MAX_FILE_BYTES,
      STATUS,
      DB,
    }),
  });

  if (global.document?.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', start);
  else start();
})(window);
