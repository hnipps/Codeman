/**
 * @fileoverview The Reviews page (`/reviews`, `/reviews/<id>`): a queue of finished branches, the agent's
 * walkthrough, and a stage with the running preview and the changes. Design: intent/2026-11-16-reviews-page.md.
 *
 * Rules this file keeps:
 * - Every string from an agent or from git is written with `textContent`. The walkthrough is the one exception:
 *   it goes through `marked` and then `window.sanitizeMarkdownHtml`, the dashboard's sanitizer, and is shown as
 *   plain text when either is missing.
 * - A preview is a sandboxed frame without `allow-same-origin`, like a preview tab on the dashboard.
 * - Nothing is sent to a session without a press of Request changes.
 * - All addresses are relative, so the page works under a reverse-proxy base path through `<base href>`.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const ANCHOR_CONTEXT = 32;
  const MAX_QUOTE = 2000;
  const STATE_LABEL = {
    ready: 'Ready',
    'changes-requested': 'You asked for changes',
    updated: 'Updated since your notes',
    merged: 'Merged',
    deploying: 'Deploying',
    deployed: 'Deployed',
    'deploy-failed': 'Deploy failed',
  };
  const STATE_TONE = { ready: 'ok', updated: 'ok', deploying: 'warn', 'deploy-failed': 'bad' };

  const PINS_KEY = 'codeman-reviews-pins-hidden';
  function readPinsHidden() {
    try {
      return localStorage.getItem(PINS_KEY) === '1';
    } catch (_err) {
      return false;
    }
  }

  const state = {
    queue: { waiting: [], decided: [] },
    id: null,
    review: null,
    sessionLive: false,
    changes: null,
    changesError: '',
    file: null,
    diff: null,
    range: null,
    tab: 'changes',
    device: 'desktop',
    preview: null,
    previewPath: '/',
    /** The frame bridge in the previewed page has answered, so an element can be picked and found again. */
    bridge: false,
    picking: false,
    pinsHidden: readPinsHidden(),
    /** Where each open element note's element is now, in the frame's own pixels; null when it is not on this page. */
    pinRects: new Map(),
    locateId: '',
    locateNotes: [],
    flashPin: null,
    composing: null,
    loadSeq: 0,
  };

  // ---------------------------------------------------------------- network

  async function api(path, options) {
    const init = { credentials: 'same-origin', headers: {} };
    if (options && options.method) init.method = options.method;
    if (options && options.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch (_err) {
      throw new Error('Codeman did not answer. Check the connection and try again.');
    }
    let json = null;
    try {
      json = await res.json();
    } catch (_err) {
      json = null;
    }
    if (!res.ok || !json || json.success === false) {
      throw new Error((json && json.error) || `The request failed (${res.status})`);
    }
    return json.data;
  }

  let toastTimer = 0;
  function toast(message, tone) {
    const box = $('rvToast');
    box.textContent = message;
    box.dataset.tone = tone || '';
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (box.hidden = true), 6000);
  }

  // ---------------------------------------------------------------- time

  function ago(ms) {
    const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins} min`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} h`;
    return `${Math.round(hours / 24)} d`;
  }
  const agoText = (ms) => (ago(ms) === 'now' ? 'just now' : `${ago(ms)} ago`);
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // ---------------------------------------------------------------- queue

  function renderQueue() {
    const nav = $('rvQueue');
    nav.replaceChildren();
    const { waiting, decided } = state.queue;
    const group = (title, rows, decidedRow) => {
      nav.append(el('h2', 'rv-queue-head', `${title} · ${rows.length}`));
      for (const row of rows) {
        const a = el('a', 'rv-queue-item');
        a.href = `reviews/${row.id}`;
        if (row.id === state.id) a.setAttribute('aria-current', 'true');
        a.append(el('b', '', row.title));
        const line = el('span', 'rv-queue-line');
        const pill = el('span', 'rv-pill', STATE_LABEL[row.state] || row.state);
        pill.dataset.tone = STATE_TONE[row.state] || 'dim';
        line.append(
          pill,
          el('span', '', decidedRow ? clock(row.decidedAt) : `${row.sessionName || 'session'} · ${ago(row.createdAt)}`)
        );
        a.append(line);
        a.addEventListener('click', (event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          openReview(row.id, true);
        });
        nav.append(a);
      }
    };
    group('Waiting for you', waiting, false);
    if (decided.length) group('Decided today', decided, true);
    if (!waiting.length && !decided.length) {
      const empty = el('div', 'rv-queue-empty');
      empty.append(
        el('p', '', 'No finished work is waiting.'),
        el('p', '', 'An agent hands work over by running this in its session, on the branch it finished:')
      );
      empty.append(el('code', '', 'codeman agent review submit --title "…" --file walkthrough.md'));
      nav.append(empty);
    }
  }

  async function loadQueue() {
    try {
      state.queue = await api('api/reviews');
    } catch (err) {
      toast(err.message, 'bad');
    }
    renderQueue();
    if (!state.id && state.queue.waiting.length) openReview(state.queue.waiting[0].id, false);
    else if (!state.id) renderEmpty();
  }

  // ---------------------------------------------------------------- one review

  function renderEmpty() {
    $('rvTitle').textContent = 'Reviews';
    $('rvMeta').textContent = '';
    $('rvState').hidden = true;
    $('rvRequest').hidden = true;
    $('rvWalk').replaceChildren(el('p', 'rv-dim', 'Pick a review from the queue.'));
    $('rvNoteList').replaceChildren();
    $('rvFiles').replaceChildren();
    $('rvDiff').replaceChildren();
    $('rvNotes').hidden = true;
  }

  async function openReview(id, push) {
    const seq = ++state.loadSeq;
    if (push && id !== state.id) history.pushState({ id }, '', `reviews/${id}`);
    state.id = id;
    state.review = null;
    state.changes = null;
    state.changesError = '';
    state.file = null;
    state.diff = null;
    state.range = null;
    state.preview = null;
    state.previewPath = '/';
    state.bridge = false;
    state.picking = false;
    state.pinRects = new Map();
    state.flashPin = null;
    closeComposer();
    renderQueue();
    let data;
    try {
      data = await api(`api/reviews/${encodeURIComponent(id)}`);
    } catch (err) {
      if (seq !== state.loadSeq) return;
      state.id = null;
      renderEmpty();
      $('rvWalk').replaceChildren(el('p', 'rv-dim', err.message));
      return;
    }
    if (seq !== state.loadSeq) return;
    state.review = data.review;
    state.sessionLive = data.sessionLive;
    renderReview();
    setPane('doc');
    loadChanges(seq);
    loadPreview(seq);
  }

  /** Reads the open review again after a change elsewhere, keeping the reader's place. */
  async function refreshReview() {
    if (!state.id) return;
    const seq = state.loadSeq;
    const before = state.review;
    let data;
    try {
      data = await api(`api/reviews/${encodeURIComponent(state.id)}`);
    } catch (_err) {
      return;
    }
    if (seq !== state.loadSeq) return;
    state.review = data.review;
    state.sessionLive = data.sessionLive;
    if (before && before.revision !== data.review.revision) {
      renderReview();
      loadChanges(seq);
      toast('The agent submitted this review again. The walkthrough and the changes are updated.');
    } else {
      renderHeader();
      renderNotes();
    }
  }

  function renderHeader() {
    const r = state.review;
    document.title = `${r.title} · Reviews`;
    $('rvTitle').textContent = r.title;
    const c = state.changes;
    const size = c && !c.gone ? ` · ${c.files.length}${c.truncated ? '+' : ''} files · +${c.added} −${c.deleted}` : '';
    $('rvMeta').textContent = `${r.project} · ${r.branch} → ${r.base}${size}`;
    const pill = $('rvState');
    pill.hidden = false;
    pill.textContent = STATE_LABEL[r.state] || r.state;
    pill.dataset.tone = STATE_TONE[r.state] || 'dim';
    const open = !['merged', 'deployed', 'deploying'].includes(r.state);
    const request = $('rvRequest');
    request.hidden = !open;
    request.textContent = r.unsent
      ? `Request changes · ${r.unsent} ${r.unsent === 1 ? 'note' : 'notes'}`
      : 'Request changes';
    request.disabled = !r.unsent || !state.sessionLive;
    request.title = !state.sessionLive
      ? 'The session that wrote this review has ended, so there is nowhere to send notes.'
      : r.unsent
        ? 'Sends every unsent note to the session as one prompt.'
        : 'Add a note first.';
  }

  function renderNotice() {
    const box = $('rvNotice');
    const lines = [];
    if (state.changes && state.changes.gone)
      lines.push('The branch no longer exists. The walkthrough is kept as it was written.');
    else if (state.changes && state.changes.moved)
      lines.push(
        'The branch has new commits since this walkthrough was written. Its code links may point at lines that moved.'
      );
    if (state.review && !state.sessionLive)
      lines.push('The session that wrote this has ended. You can still read it and keep notes.');
    box.hidden = !lines.length;
    box.replaceChildren(...lines.map((line) => el('p', '', line)));
  }

  function renderReview() {
    renderHeader();
    renderWalkthrough();
    renderNotes();
    renderNotice();
    $('rvNotes').hidden = false;
  }

  // ---------------------------------------------------------------- walkthrough

  function renderWalkthrough() {
    const r = state.review;
    const walk = $('rvWalk');
    walk.replaceChildren();
    walk.append(
      el(
        'div',
        'rv-by',
        `Written by ${r.sessionName || 'a session'} · ${agoText(r.updatedAt)}${r.revision > 1 ? ` · revision ${r.revision}` : ''}`
      )
    );
    const body = el('div', 'rv-md');
    let html = null;
    try {
      if (window.marked && window.sanitizeMarkdownHtml)
        html = window.sanitizeMarkdownHtml(window.marked.parse(r.walkthrough));
    } catch (_err) {
      html = null;
    }
    if (typeof html === 'string') body.innerHTML = html;
    else body.textContent = r.walkthrough;
    for (const a of body.querySelectorAll('a[href]')) wireLink(a);
    walk.append(body);
    paintTextNotes();
  }

  /** `#code=path:10-24` and `#preview=/path` move the stage; every other link opens in a new tab. */
  function wireLink(a) {
    const href = a.getAttribute('href') || '';
    const code = /^#code=(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(href);
    const preview = /^#preview=(\/.*)$/.exec(href);
    if (code) {
      const path = decodeURIComponent(code[1]);
      const from = code[2] ? Number(code[2]) : null;
      const to = code[3] ? Number(code[3]) : from;
      a.className = 'rv-lk rv-lk-code';
      a.removeAttribute('target');
      a.addEventListener('click', (event) => {
        event.preventDefault();
        showCode(path, from, to);
      });
    } else if (preview) {
      const path = decodeURIComponent(preview[1]);
      a.className = 'rv-lk rv-lk-preview';
      a.removeAttribute('target');
      a.addEventListener('click', (event) => {
        event.preventDefault();
        showPreview(path);
      });
    } else if (href.startsWith('#')) {
      a.removeAttribute('href');
    } else {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
  }

  // ---------------------------------------------------------------- text anchors

  const walkText = () => $('rvWalk').querySelector('.rv-md');

  function locate(text, anchor) {
    const { quote, prefix, suffix } = anchor;
    let best = null;
    let bestScore = -1;
    for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) {
      const end = at + quote.length;
      let score = 0;
      for (let i = 1; i <= prefix.length && at - i >= 0 && text[at - i] === prefix[prefix.length - i]; i++) score++;
      for (let i = 0; i < suffix.length && end + i < text.length && text[end + i] === suffix[i]; i++) score++;
      if (score > bestScore) {
        bestScore = score;
        best = { start: at, end };
      }
    }
    return best;
  }

  function wrapRange(root, start, end, noteId) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const hits = [];
    let offset = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const len = node.nodeValue.length;
      if (offset + len > start && offset < end)
        hits.push({ node, from: Math.max(0, start - offset), to: Math.min(len, end - offset) });
      offset += len;
      if (offset >= end) break;
    }
    for (const hit of hits) {
      const range = document.createRange();
      range.setStart(hit.node, hit.from);
      range.setEnd(hit.node, hit.to);
      const mark = el('mark', 'rv-mark');
      mark.dataset.note = noteId;
      range.surroundContents(mark);
      mark.addEventListener('click', () => focusNote(noteId));
    }
  }

  function paintTextNotes() {
    const root = walkText();
    if (!root || !state.review) return;
    for (const note of state.review.notes) {
      if (note.at.kind !== 'text' || note.resolvedAt) continue;
      const found = locate(root.textContent, note.at.anchor);
      if (found) wrapRange(root, found.start, found.end, note.id);
    }
  }

  function selectionAnchor() {
    const root = walkText();
    const selection = window.getSelection();
    if (!root || !selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
    const before = document.createRange();
    before.selectNodeContents(root);
    before.setEnd(range.startContainer, range.startOffset);
    const text = root.textContent;
    let start = before.toString().length;
    let end = start + range.toString().length;
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (start >= end || end - start > MAX_QUOTE) return null;
    return {
      quote: text.slice(start, end),
      prefix: text.slice(Math.max(0, start - ANCHOR_CONTEXT), start),
      suffix: text.slice(end, end + ANCHOR_CONTEXT),
    };
  }

  function offerSelectionNote() {
    const button = $('rvSelectNote');
    const anchor = state.review && isOpenReview() ? selectionAnchor() : null;
    if (!anchor) {
      button.hidden = true;
      return;
    }
    const rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
    button.hidden = false;
    button.style.top = `${Math.max(8, rect.top - 40)}px`;
    button.style.left = `${Math.min(window.innerWidth - 110, Math.max(8, rect.left))}px`;
    button.onclick = () => {
      button.hidden = true;
      openComposer({ kind: 'text', anchor });
      window.getSelection().removeAllRanges();
    };
  }

  // ---------------------------------------------------------------- notes

  const isOpenReview = () => state.review && !['merged', 'deployed', 'deploying'].includes(state.review.state);

  function whereText(at) {
    if (at.kind === 'general') return 'General';
    if (at.kind === 'text')
      return `“${at.anchor.quote.length > 90 ? `${at.anchor.quote.slice(0, 90)}…` : at.anchor.quote}”`;
    if (at.kind === 'code') return `${at.path}:${at.line}${at.side === 'old' ? ' (removed)' : ''}`;
    if (!at.element) return `Preview ${at.path}`;
    const text = at.element.text.replace(/\s+/g, ' ').trim();
    return `Preview · ${at.element.tag}${text ? ` “${text.length > 50 ? `${text.slice(0, 50)}…` : text}”` : ''}`;
  }

  function openComposer(at) {
    state.composing = at;
    $('rvComposer').hidden = false;
    $('rvComposerAt').textContent = whereText(at);
    $('rvComposerText').value = '';
    if (window.matchMedia('(max-width: 600px)').matches) setPane('notes');
    $('rvComposerText').focus();
  }
  function closeComposer() {
    state.composing = null;
    $('rvComposer').hidden = true;
  }

  function focusNote(id) {
    if (window.matchMedia('(max-width: 600px)').matches) setPane('notes');
    const row = $('rvNoteList').querySelector(`[data-note="${CSS.escape(id)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'nearest' });
    row.classList.add('rv-note-flash');
    setTimeout(() => row.classList.remove('rv-note-flash'), 1200);
  }

  function goToNote(note) {
    if (note.at.kind === 'code') showCode(note.at.path, note.at.side === 'new' ? note.at.line : null, null);
    else if (note.at.kind === 'preview') {
      state.flashPin = note.id;
      if (note.at.element && state.pinsHidden) setPinsHidden(false);
      showPreview(note.at.path);
      renderPins();
    } else if (note.at.kind === 'text') {
      setPane('doc');
      const mark = $('rvWalk').querySelector(`mark[data-note="${CSS.escape(note.id)}"]`);
      if (mark) mark.scrollIntoView({ block: 'center' });
    }
  }

  async function noteCall(path, options, done) {
    try {
      const data = await api(`api/reviews/${encodeURIComponent(state.id)}/${path}`, options);
      state.review = data.review;
      if (done) done();
      renderHeader();
      renderWalkthrough();
      renderNotes();
      renderDiff();
      renderPreview();
      locatePins();
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  function renderNotes() {
    const r = state.review;
    const list = $('rvNoteList');
    list.replaceChildren();
    const open = r.notes.filter((n) => !n.resolvedAt);
    const resolved = r.notes.filter((n) => n.resolvedAt);
    $('rvNotesTitle').textContent = open.length ? `Notes · ${open.length}` : 'Notes';
    $('rvGeneral').hidden = !isOpenReview();
    if (!r.notes.length) {
      list.append(
        el('li', 'rv-dim', 'No notes yet. Select words in the walkthrough, or press a line in Changes, to anchor one.')
      );
      return;
    }
    for (const note of [...open, ...resolved]) {
      const row = el('li', 'rv-note');
      row.dataset.note = note.id;
      if (note.resolvedAt) row.classList.add('rv-note-resolved');
      const at = el('button', 'rv-note-at', whereText(note.at));
      at.type = 'button';
      at.addEventListener('click', () => goToNote(note));
      row.append(at, el('p', 'rv-note-text', note.text));
      const foot = el('div', 'rv-note-foot');
      foot.append(
        el(
          'span',
          'rv-dim',
          note.resolvedAt ? 'Resolved' : note.sentAt ? `Sent ${agoText(note.sentAt)}` : 'Not sent yet'
        )
      );
      const resolve = el('button', 'rv-btn rv-btn-sm', note.resolvedAt ? 'Reopen' : 'Resolve');
      resolve.type = 'button';
      resolve.addEventListener('click', () =>
        noteCall(`notes/${note.id}`, { method: 'PATCH', body: { resolved: !note.resolvedAt } })
      );
      foot.append(resolve);
      if (!note.sentAt) {
        const remove = el('button', 'rv-btn rv-btn-sm', 'Delete');
        remove.type = 'button';
        remove.addEventListener('click', () => noteCall(`notes/${note.id}`, { method: 'DELETE' }));
        foot.append(remove);
      }
      row.append(foot);
      list.append(row);
    }
  }

  async function requestChanges() {
    const button = $('rvRequest');
    button.disabled = true;
    button.textContent = 'Sending…';
    try {
      const data = await api(`api/reviews/${encodeURIComponent(state.id)}/request-changes`, {
        method: 'POST',
        body: {},
      });
      state.review = data.review;
      toast(
        data.confirmed
          ? `Sent ${data.sent.length} ${data.sent.length === 1 ? 'note' : 'notes'} to the session.`
          : 'The notes were written to the session, but it has not confirmed it started. Check the session.',
        data.confirmed ? 'ok' : 'warn'
      );
      loadQueue();
    } catch (err) {
      toast(err.message, 'bad');
    }
    renderHeader();
    renderNotes();
  }

  // ---------------------------------------------------------------- changes

  async function loadChanges(seq) {
    try {
      state.changes = await api(`api/reviews/${encodeURIComponent(state.id)}/changes`);
      state.changesError = '';
    } catch (err) {
      if (seq !== state.loadSeq) return;
      state.changes = null;
      state.changesError = err.message;
    }
    if (seq !== state.loadSeq) return;
    renderHeader();
    renderNotice();
    renderFiles();
    const first = state.changes && state.changes.files[0];
    if (first && !state.file) selectFile(first.path, null);
    else renderDiff();
  }

  function renderFiles() {
    const box = $('rvFiles');
    box.replaceChildren();
    const c = state.changes;
    if (!c) return;
    $('rvTabChanges').textContent = c.gone ? 'Changes' : `Changes · ${c.files.length}${c.truncated ? '+' : ''} files`;
    for (const file of c.files) {
      const row = el('button', 'rv-file');
      row.type = 'button';
      if (file.path === state.file) row.setAttribute('aria-current', 'true');
      row.append(el('span', 'rv-file-path', file.origPath ? `${file.origPath} → ${file.path}` : file.path));
      row.append(el('span', 'rv-file-count', file.binary ? 'binary' : `+${file.added} −${file.deleted}`));
      const notes = state.review.notes.filter(
        (n) => n.at.kind === 'code' && n.at.path === file.path && !n.resolvedAt
      ).length;
      if (notes) row.append(el('span', 'rv-file-notes', String(notes)));
      row.addEventListener('click', () => selectFile(file.path, null));
      box.append(row);
    }
    if (c.truncated) box.append(el('div', 'rv-dim rv-pad', 'More files changed than are listed here.'));
  }

  async function selectFile(path, range) {
    const seq = state.loadSeq;
    state.file = path;
    state.range = range;
    state.diff = { state: 'loading' };
    renderFiles();
    renderDiff();
    try {
      const data = await api(`api/reviews/${encodeURIComponent(state.id)}/diff?path=${encodeURIComponent(path)}`);
      if (seq !== state.loadSeq || state.file !== path) return;
      state.diff = { state: 'ready', ...data };
    } catch (err) {
      if (seq !== state.loadSeq || state.file !== path) return;
      state.diff = { state: 'error', error: err.message };
    }
    renderDiff();
  }

  function showCode(path, from, to) {
    setTab('changes');
    setPane('stage');
    if (!state.changes || !state.changes.files.some((f) => f.path === path)) {
      toast(`${path} is not among the files this branch changes.`, 'warn');
      return;
    }
    const range = from ? { from, to: to || from } : null;
    if (state.file === path && state.diff && state.diff.state === 'ready') {
      state.range = range;
      renderDiff();
    } else selectFile(path, range);
  }

  function renderDiff() {
    const box = $('rvDiff');
    box.replaceChildren();
    if (state.changesError) return void box.append(el('div', 'rv-dim rv-pad', state.changesError));
    const c = state.changes;
    if (!c) return void box.append(el('div', 'rv-dim rv-pad', 'Reading the changes…'));
    if (c.gone)
      return void box.append(el('div', 'rv-dim rv-pad', 'The branch is gone, so there is nothing to compare.'));
    if (!c.files.length)
      return void box.append(el('div', 'rv-dim rv-pad', 'This branch changes no files against its base.'));
    const d = state.diff;
    if (!d) return;
    box.append(el('div', 'rv-diff-file', state.file));
    if (d.state === 'loading') return void box.append(el('div', 'rv-dim rv-pad', 'Reading the diff…'));
    if (d.state === 'error') return void box.append(el('div', 'rv-dim rv-pad', d.error));
    if (d.binary) box.append(el('div', 'rv-dim rv-pad', 'This is a binary file; there is no text diff to show.'));
    if (!d.diff.trim()) return;

    const notes = state.review.notes.filter((n) => n.at.kind === 'code' && n.at.path === state.file && !n.resolvedAt);
    const table = el('div', 'rv-lines');
    let oldNo = 0;
    let newNo = 0;
    let target = null;
    let inHunk = false;
    for (const line of d.diff.replace(/\n$/, '').split('\n')) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        oldNo = Number(hunk[1]);
        newNo = Number(hunk[2]);
        inHunk = true;
        table.append(el('div', 'rv-line rv-line-hunk', line));
        continue;
      }
      if (!inHunk) continue;
      if (line.startsWith('\\')) continue;
      const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
      const side = kind === 'del' ? 'old' : 'new';
      const number = kind === 'del' ? oldNo : newNo;
      const row = el('div', `rv-line rv-line-${kind}`);
      row.append(
        el('span', 'rv-ln', kind === 'add' ? '' : String(oldNo)),
        el('span', 'rv-ln', kind === 'del' ? '' : String(newNo))
      );
      row.append(el('span', 'rv-code', line.slice(1) || ' '));
      if (kind !== 'del' && state.range && number >= state.range.from && number <= state.range.to) {
        row.classList.add('rv-line-target');
        if (!target) target = row;
      }
      const mine = notes.filter((n) => n.at.side === side && n.at.line === number);
      if (mine.length) {
        row.classList.add('rv-line-noted');
        row.title = mine.map((n) => n.text).join('\n\n');
      }
      if (isOpenReview()) {
        const text = line.slice(1);
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-label', `Add a note on line ${number}`);
        const add = () =>
          mine.length
            ? focusNote(mine[0].id)
            : openComposer({ kind: 'code', path: state.file, line: number, side, text: text.slice(0, 400) });
        row.addEventListener('click', () => {
          if (!String(window.getSelection()).trim()) add();
        });
        row.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            add();
          }
        });
      }
      table.append(row);
      if (kind !== 'add') oldNo++;
      if (kind !== 'del') newNo++;
    }
    box.append(table);
    if (d.truncated) box.append(el('div', 'rv-dim rv-pad', 'Diff cut short: it is larger than this view shows.'));
    if (target) target.scrollIntoView({ block: 'center' });
    else if (state.range) toast('Those lines are not in the diff any more. The branch may have moved.', 'warn');
  }

  // ---------------------------------------------------------------- preview

  async function loadPreview(seq) {
    const r = state.review;
    state.preview = { state: 'loading' };
    renderPreview();
    try {
      const data = await api(`api/sessions/${encodeURIComponent(r.sessionId)}/previews`);
      if (seq !== state.loadSeq) return;
      const running = (data.previews || []).filter((p) => p.state !== 'exited' && p.state !== 'stopped');
      if (!running.length) {
        state.preview = { state: 'none' };
      } else {
        const opened = await api(`api/reviews/${encodeURIComponent(r.id)}/preview`, {
          method: 'POST',
          body: { webviewId: running[0].webviewId },
        });
        if (seq !== state.loadSeq) return;
        state.preview =
          opened && opened.embedUrl
            ? { state: 'ready', name: running[0].name, embedUrl: opened.embedUrl }
            : { state: 'none' };
      }
    } catch (_err) {
      if (seq !== state.loadSeq) return;
      state.preview = { state: 'none' };
    }
    renderPreview();
    // A change with something to look at opens on it; one with nothing visible stays on Changes.
    if (state.preview.state === 'ready') setTab('preview');
  }

  function previewSrc() {
    // The embed address is root-absolute (`/webview/<cap>/`); drop the slash so `<base href>` carries a mount prefix.
    const root = state.preview.embedUrl.replace(/^\//, '').replace(/\/?$/, '/');
    return root + state.previewPath.replace(/^\//, '');
  }

  function renderPreview() {
    const box = $('rvPreview');
    const p = state.preview;
    const ready = p && p.state === 'ready';
    $('rvDevice').hidden = !ready || state.tab !== 'preview';
    const shown = ready && state.tab === 'preview';
    const noteButton = $('rvPreviewNote');
    noteButton.hidden = !shown || !isOpenReview();
    // Without the bridge (a page that is not HTML, or one too large to rewrite) a note can only name the page.
    noteButton.textContent = state.picking ? 'Cancel' : state.bridge ? 'Add note' : 'Note on this page';
    const pinned = elementNotes().length;
    const toggle = $('rvPinsToggle');
    toggle.hidden = !shown || !pinned;
    toggle.textContent = state.pinsHidden ? `Show notes · ${pinned}` : `Hide notes · ${pinned}`;
    toggle.setAttribute('aria-pressed', String(!state.pinsHidden));
    $('rvBarNote').textContent = !shown ? '' : state.picking ? 'Press an element in the preview' : state.previewPath;
    if (!ready) {
      box.replaceChildren(
        el(
          'div',
          'rv-dim rv-pad',
          !p || p.state === 'loading'
            ? 'Looking for a running preview…'
            : 'The session has no running preview. The agent starts one with `codeman agent preview add`; the code is under Changes.'
        )
      );
      return;
    }
    let frame = box.querySelector('iframe');
    const src = previewSrc();
    if (!frame) {
      box.replaceChildren();
      const shell = el('div', 'rv-frame');
      frame = document.createElement('iframe');
      frame.title = `Preview ${p.name}`;
      // No allow-same-origin: the preview is served from this origin, so granting it would let the page under
      // review read this document and call the Codeman API.
      frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-downloads allow-modals');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      const screen = el('div', 'rv-screen');
      const pins = el('div', 'rv-pins');
      pins.id = 'rvPins';
      screen.append(frame, pins);
      shell.append(screen);
      box.append(shell);
    }
    box.querySelector('.rv-frame').dataset.device = state.device;
    if (frame.dataset.src !== src) {
      frame.dataset.src = src;
      // The new page's bridge says so when it is ready; until then nothing can be picked or found.
      state.bridge = false;
      state.picking = false;
      state.pinRects = new Map();
      frame.src = src;
    }
    renderPins();
  }

  // ---------------------------------------------------------------- notes on the previewed page
  //
  // The frame is sandboxed with an opaque origin, so this page cannot look inside it. The frame bridge the proxy
  // injects is the only channel. The previewed page can post the same messages itself, so every one is checked,
  // bounded and shown with textContent; none of them can do more than propose an anchor for a note the person writes.

  const previewFrame = () => $('rvPreview').querySelector('iframe');
  const elementNotes = () =>
    state.review ? state.review.notes.filter((n) => !n.resolvedAt && n.at.kind === 'preview' && n.at.element) : [];

  function tellFrame(message) {
    const frame = previewFrame();
    if (frame && frame.contentWindow) frame.contentWindow.postMessage(message, '*');
  }

  const str = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

  /** The element a pick reported, cut down to what a note keeps; null when it is not one. */
  function pickedElement(raw) {
    if (!raw || typeof raw !== 'object' || !raw.rect || typeof raw.rect !== 'object') return null;
    const selector = str(raw.selector, 1024);
    const tag = str(raw.tag, 64);
    const x = num(raw.rect.x);
    const y = num(raw.rect.y);
    if (!selector || !tag || x === null || y === null) return null;
    const element = { selector, trail: str(raw.path, 2048), tag, text: str(raw.text, 400), x, y };
    const source = str(raw.source, 512);
    if (source) element.source = source;
    return element;
  }

  function setPicking(on) {
    state.picking = on && state.bridge;
    tellFrame({ type: state.picking ? 'codeman:pick-start' : 'codeman:pick-stop' });
    renderPreview();
  }

  function setPinsHidden(hidden) {
    state.pinsHidden = hidden;
    try {
      localStorage.setItem(PINS_KEY, hidden ? '1' : '0');
    } catch (_err) {
      /* The choice then lasts for this visit only. */
    }
    renderPreview();
  }

  /** Asks the frame where each open element note's element is now. */
  function locatePins() {
    const notes = elementNotes().slice(0, 64);
    if (!state.bridge || !notes.length) {
      state.pinRects = new Map();
      renderPins();
      return;
    }
    state.locateId = `rv${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    state.locateNotes = notes.map((n) => n.id);
    tellFrame({
      type: 'codeman:locate',
      requestId: state.locateId,
      selectors: notes.map((n) => n.at.element.selector),
      hints: notes.map((n) => ({
        tag: n.at.element.tag,
        text: n.at.element.text,
        x: n.at.element.x,
        y: n.at.element.y,
      })),
    });
  }

  function renderPins() {
    const layer = $('rvPins');
    if (!layer) return;
    layer.replaceChildren();
    layer.hidden = state.pinsHidden;
    if (state.pinsHidden) return;
    const width = layer.clientWidth;
    const height = layer.clientHeight;
    elementNotes().forEach((note, index) => {
      const rect = state.pinRects.get(note.id);
      if (!rect) return;
      // An element scrolled out of the frame's viewport has no pin until it is scrolled back.
      if (rect.x + rect.width < 0 || rect.y + rect.height < 0 || rect.x > width || rect.y > height) return;
      if (state.flashPin === note.id) {
        const box = el('div', 'rv-pin-box');
        box.style.left = `${rect.x}px`;
        box.style.top = `${rect.y}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
        layer.append(box);
      }
      const pin = el('button', 'rv-pin', String(index + 1));
      pin.type = 'button';
      pin.title = note.text.length > 120 ? `${note.text.slice(0, 120)}…` : note.text;
      pin.setAttribute('aria-label', `Note ${index + 1}: ${pin.title}`);
      pin.style.left = `${Math.max(2, Math.min(width - 26, rect.x + rect.width - 11))}px`;
      pin.style.top = `${Math.max(2, Math.min(height - 24, rect.y - 11))}px`;
      pin.addEventListener('click', () => {
        state.flashPin = note.id;
        renderPins();
        focusNote(note.id);
      });
      layer.append(pin);
    });
  }

  function onFrameMessage(event) {
    const frame = previewFrame();
    if (!frame || event.source !== frame.contentWindow) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
    if (data.type === 'codeman:frame-ready') {
      state.bridge = true;
      state.picking = false;
      renderPreview();
      locatePins();
    } else if (data.type === 'codeman:frame-rects-changed') {
      locatePins();
    } else if (data.type === 'codeman:frame-rects') {
      if (data.requestId !== state.locateId || !Array.isArray(data.rects)) return;
      const rects = new Map();
      state.locateNotes.forEach((id, index) => {
        const r = data.rects[index];
        if (!r || typeof r !== 'object') return;
        const rect = { x: num(r.x), y: num(r.y), width: num(r.width), height: num(r.height) };
        if (rect.x === null || rect.y === null || rect.width === null || rect.height === null) return;
        rects.set(id, rect);
      });
      state.pinRects = rects;
      renderPins();
    } else if (data.type === 'codeman:frame-picked') {
      const element = pickedElement(data.element);
      setPicking(false);
      if (element && isOpenReview()) openComposer({ kind: 'preview', path: state.previewPath, element });
    } else if (data.type === 'codeman:frame-pick-cancelled' || data.type === 'codeman:canvas-escape') {
      if (state.picking) setPicking(false);
    }
  }

  function showPreview(path) {
    setPane('stage');
    if (!state.preview || state.preview.state !== 'ready') {
      setTab('preview');
      toast('There is no running preview to show that in.', 'warn');
      return;
    }
    state.previewPath = path;
    setTab('preview');
  }

  // ---------------------------------------------------------------- layout

  function setTab(tab) {
    state.tab = tab;
    $('rvTabPreview').setAttribute('aria-selected', String(tab === 'preview'));
    $('rvTabChanges').setAttribute('aria-selected', String(tab === 'changes'));
    $('rvPreview').hidden = tab !== 'preview';
    $('rvChanges').hidden = tab !== 'changes';
    renderPreview();
  }

  /** On a phone one column shows at a time; on a desktop this only records which one a link last asked for. */
  function setPane(pane) {
    $('rvMain').dataset.pane = pane;
    for (const button of $('rvPanes').querySelectorAll('button'))
      button.toggleAttribute('aria-current', button.dataset.pane === pane);
  }

  // ---------------------------------------------------------------- start

  function idFromAddress() {
    const base = new URL('./', document.baseURI).pathname;
    const rest = location.pathname.startsWith(base) ? location.pathname.slice(base.length) : '';
    const match = /^reviews\/([a-z0-9]{8,40})\/?$/.exec(rest);
    return match ? match[1] : null;
  }

  function start() {
    $('rvRequest').addEventListener('click', requestChanges);
    $('rvGeneral').addEventListener('click', () => openComposer({ kind: 'general' }));
    $('rvComposerCancel').addEventListener('click', closeComposer);
    $('rvComposer').addEventListener('submit', (event) => {
      event.preventDefault();
      const text = $('rvComposerText').value.trim();
      if (!text || !state.composing) return;
      noteCall('notes', { method: 'POST', body: { at: state.composing, text } }, closeComposer);
    });
    $('rvComposerText').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) $('rvComposer').requestSubmit();
      if (event.key === 'Escape') closeComposer();
    });
    $('rvTabPreview').addEventListener('click', () => setTab('preview'));
    $('rvTabChanges').addEventListener('click', () => setTab('changes'));
    $('rvPreviewNote').addEventListener('click', () => {
      if (state.picking) setPicking(false);
      else if (state.bridge) setPicking(true);
      else openComposer({ kind: 'preview', path: state.previewPath });
    });
    $('rvPinsToggle').addEventListener('click', () => setPinsHidden(!state.pinsHidden));
    window.addEventListener('message', onFrameMessage);
    window.addEventListener('resize', renderPins);
    for (const button of $('rvDevice').querySelectorAll('button'))
      button.addEventListener('click', () => {
        state.device = button.dataset.device;
        for (const other of $('rvDevice').querySelectorAll('button'))
          other.setAttribute('aria-pressed', String(other === button));
        renderPreview();
      });
    for (const button of $('rvPanes').querySelectorAll('button'))
      button.addEventListener('click', () => setPane(button.dataset.pane));
    document.addEventListener('selectionchange', () => {
      clearTimeout(offerSelectionNote.timer);
      offerSelectionNote.timer = setTimeout(offerSelectionNote, 150);
    });
    window.addEventListener('popstate', () => {
      const id = idFromAddress();
      if (id) openReview(id, false);
    });

    const id = idFromAddress();
    if (id) openReview(id, false);
    loadQueue();

    // One event, no payload worth trusting: read again. A reader mid-note keeps their place.
    try {
      const events = new EventSource('api/events');
      events.addEventListener('review:changed', (event) => {
        let changed = null;
        try {
          changed = JSON.parse(event.data);
        } catch (_err) {
          changed = null;
        }
        loadQueue();
        if (changed && changed.id === state.id && !state.composing) refreshReview();
      });
    } catch (_err) {
      /* No live updates; the page still works on reload. */
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
