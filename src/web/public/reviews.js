/**
 * @fileoverview The Reviews page (`/reviews`, `/reviews/<id>`): a queue of finished branches, the agent's
 * walkthrough, and a stage with the running preview and the changes. Design: intent/2026-11-16-reviews-page.md.
 *
 * Rules this file keeps:
 * - Every string from an agent or from git is written with `textContent`. The walkthrough is the one exception:
 *   it goes through `marked` and then `window.sanitizeWalkthroughHtml` (the dashboard's sanitizer plus
 *   details/summary), and is shown as plain text when either is missing.
 * - A preview is a sandboxed frame without `allow-same-origin`, like a preview tab on the dashboard.
 * - Nothing is sent to a session without a press of Request changes (once the author session has ended, that press
 *   starts a new session and hands it the review).
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
    closed: 'Closed',
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
    /** A hand-over to a new session is in flight. */
    sending: false,
    /** The work item this review is of (`{ key, prUrl, wanted }`), null when its item is gone, undefined for a session. */
    work: undefined,
    /** What Approve will do for this review: `{ deploys }`. */
    approve: null,
    /** The review's live preview as the server describes it, or null when it has none. */
    live: null,
    liveBusy: false,
    approving: false,
    changes: null,
    changesError: '',
    file: null,
    diff: null,
    range: null,
    /** A Markdown file in Changes is read rendered or as its diff; the reader's choice holds across files. */
    docView: 'rendered',
    /** The open Markdown file's text at the branch tip: `{ path, state, text?, error? }`. */
    doc: null,
    /** A doc note to bring into view once the rendered file is painted. */
    docFocus: null,
    tab: 'changes',
    device: 'desktop',
    preview: null,
    previewPath: '/',
    /** The still the Captures tab shows, by name. */
    capture: null,
    /** Shown at its own size, scrolling, instead of shrunk to the stage's width. */
    stillActual: false,
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
  /** An address a pull request link may carry: https only, so no link built from server data can run script. */
  const httpsHref = (url) => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' ? parsed.href : null;
    } catch (_err) {
      return null;
    }
  };
  /** The work item a review is of, as the server sends it; undefined for a session's review. */
  const workOf = () => state.work || null;
  const isWork = () => state.work !== undefined;

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
        const by = row.work ? row.work.key : row.sessionName || 'session';
        line.append(
          pill,
          el('span', '', decidedRow ? `${by} · ${clock(row.decidedAt)}` : `${by} · ${ago(row.createdAt)}`)
        );
        a.append(line);
        a.addEventListener('click', (event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          openReview(row.id, true);
        });
        const href = row.work && httpsHref(row.work.prUrl);
        if (!href) {
          nav.append(a);
          continue;
        }
        // A link cannot sit inside the row's own link, so a work row is the row plus its pull request beside it.
        const wrap = el('div', 'rv-queue-row');
        const pr = el('a', 'rv-queue-pr', 'PR ↗');
        pr.href = href;
        pr.target = '_blank';
        pr.rel = 'noopener noreferrer';
        pr.setAttribute('aria-label', `Pull request of ${row.work.key}`);
        wrap.append(a, pr);
        nav.append(wrap);
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
    $('rvPr').hidden = true;
    $('rvState').hidden = true;
    $('rvRequest').hidden = true;
    $('rvWalk').replaceChildren(el('p', 'rv-dim', 'Pick a review from the queue.'));
    $('rvNoteList').replaceChildren();
    $('rvFiles').replaceChildren();
    $('rvDiff').replaceChildren();
    $('rvNotes').hidden = true;
    renderWorkItem();
  }

  async function openReview(id, push) {
    liveSay('close');
    liveLast = '';
    const seq = ++state.loadSeq;
    setLive(null);
    if (push && id !== state.id) history.pushState({ id }, '', `reviews/${id}`);
    state.id = id;
    state.review = null;
    state.work = undefined;
    state.changes = null;
    state.changesError = '';
    state.file = null;
    state.diff = null;
    state.range = null;
    state.doc = null;
    state.docFocus = null;
    state.preview = null;
    state.previewPath = '/';
    state.capture = null;
    state.bridge = false;
    state.picking = false;
    state.pinRects = new Map();
    state.flashPin = null;
    closeComposer();
    renderWorkItem();
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
    state.work = data.work;
    state.approve = data.approve || null;
    setLive(data.live);
    renderReview();
    liveSay('open');
    // Stills are the thing to look at when there are any; a running preview, found below, takes the tab from them.
    setTab(captures().length ? 'captures' : 'changes');
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
    state.work = data.work;
    state.approve = data.approve || null;
    setLive(data.live);
    if (before && before.state === 'deploying' && data.review.state === 'deployed')
      toast('Deployed. The new build is live.', 'ok');
    if (before && before.revision !== data.review.revision) {
      renderReview();
      loadChanges(seq);
      toast(
        isWork()
          ? 'The pull request has new commits. The walkthrough and the changes are updated.'
          : 'The agent submitted this review again. The walkthrough and the changes are updated.'
      );
    } else {
      renderHeader();
      // A sync can replace the item's text, and the agent can write its walkthrough, with no new revision.
      if (
        before &&
        (before.walkthrough !== data.review.walkthrough ||
          JSON.stringify(before.authored) !== JSON.stringify(data.review.authored))
      ) {
        renderWalkthrough();
        renderNotice();
      }
      renderNotes();
      renderCaptures();
    }
  }

  function renderHeader() {
    const r = state.review;
    document.title = `${r.title} · Reviews`;
    $('rvTitle').textContent = r.title;
    const c = state.changes;
    const size = c && !c.gone ? ` · ${c.files.length}${c.truncated ? '+' : ''} files · +${c.added} −${c.deleted}` : '';
    const work = workOf();
    $('rvMeta').textContent = `${work ? `${work.key} · ` : ''}${r.project} · ${r.branch} → ${r.base}${size}`;
    const pr = $('rvPr');
    const href = work && httpsHref(work.prUrl);
    pr.hidden = !href;
    if (href) {
      pr.href = href;
      pr.setAttribute('aria-label', `Pull request of ${work.key}`);
    } else pr.removeAttribute('href');
    const pill = $('rvState');
    pill.hidden = false;
    pill.textContent = STATE_LABEL[r.state] || r.state;
    pill.dataset.tone = STATE_TONE[r.state] || 'dim';
    const open = !['merged', 'deployed', 'deploying', 'closed'].includes(r.state);
    const close = $('rvClose');
    close.hidden = !!r.decision;
    close.disabled = !!state.closing || !!state.approving;
    close.title = 'Closes this review without merging. The branch stays on origin.';
    const reopen = $('rvReopen');
    reopen.hidden = r.state !== 'closed';
    reopen.disabled = !!state.closing;
    reopen.title = 'Puts this review back in the queue, with its notes.';
    const request = $('rvRequest');
    request.hidden = !open;
    const notes = r.unsent ? ` · ${r.unsent} ${r.unsent === 1 ? 'note' : 'notes'}` : '';
    if (isWork()) {
      // A work review's notes go to its item, which keeps them for whichever run picks it up next.
      const key = work ? work.key : r.sessionName;
      request.textContent = `Send to ${key}${notes}`;
      request.disabled = !r.unsent;
      request.title = r.unsent
        ? `Puts every unsent note on ${key} and moves it to the top of Ready for work.`
        : 'Add a note first.';
    } else {
      // One button whether or not the author session still runs: once it has ended, the notes go to a new session
      // that is given the whole review, and the reviewer need not know the difference.
      request.textContent = `Request changes${notes}`;
      request.disabled = !r.unsent || state.sending;
      request.title = r.unsent ? 'Sends every unsent note to the agent as one prompt.' : 'Add a note first.';
    }
    renderApprove();
    renderNotice();
    watchDeploy();
  }

  // ---------------------------------------------------------------- approve

  const shortSha = (sha) => (typeof sha === 'string' ? sha.slice(0, 7) : '');

  function renderApprove() {
    const r = state.review;
    const button = $('rvApprove');
    const c = state.changes;
    const retry = r.state === 'deploy-failed' && !(state.approve && state.approve.shipsWithBase);
    button.hidden = !(retry || !r.decision);
    if (button.hidden) return;
    const deploys = !!(state.approve && state.approve.deploys);
    const stacked = !!(state.approve && state.approve.shipsWithBase);
    button.textContent = state.approving ? 'Working…' : retry ? 'Deploy again' : 'Approve';
    const ready = retry || (c && !c.gone && c.headSha);
    button.disabled = state.approving || !ready;
    button.title = retry
      ? 'Asks for the deploy of the merged commit again. Nothing is merged twice.'
      : !ready
        ? 'The changes have not loaded, or the branch is gone.'
        : `Merges ${r.branch} into ${r.base}${deploys ? ' and deploys it' : ''}${
            workOf() ? ` and marks ${workOf().key} done` : ''
          }.${stacked ? ` Nothing deploys now. It goes live when ${r.base} is merged and deployed.` : ''}`;
  }

  function askApprove() {
    const r = state.review;
    const c = state.changes;
    if (r.state === 'deploy-failed') return approveCall('deploy', {});
    if (!c || c.gone || !c.headSha) return undefined;
    const deploys = !!(state.approve && state.approve.deploys);
    const work = workOf();
    const commits = `${c.commits} ${c.commits === 1 ? 'commit' : 'commits'}`;
    $('rvConfirmTitle').textContent = deploys ? 'Merge and deploy?' : 'Merge?';
    const steps = [`Merges ${commits} from ${r.branch} into ${r.base}`];
    if (deploys) steps.push('deploys Codeman');
    if (work) steps.push(`marks ${work.key} done`);
    const lead =
      steps.length === 1 ? `${steps[0]}.` : `${steps.slice(0, -1).join(', ')} and ${steps[steps.length - 1]}.`;
    const body = [el('p', '', lead)];
    if (state.approve && state.approve.shipsWithBase)
      body.push(
        el(
          'p',
          '',
          `Nothing deploys now. ${r.base} is not the default branch, so this goes live when ${r.base} is merged and deployed.`
        )
      );
    if (c.moved)
      body.push(el('p', 'rv-confirm-warn', 'The branch has new commits since the walkthrough. They merge too.'));
    if (r.unsent)
      body.push(
        el(
          'p',
          'rv-confirm-warn',
          `${r.unsent} ${r.unsent === 1 ? 'note has' : 'notes have'} not been sent and will not be.`
        )
      );
    const more = [
      `What merges is what Changes shows: ${c.files.length}${c.truncated ? '+' : ''} ${
        c.files.length === 1 ? 'file' : 'files'
      }, +${c.added} −${c.deleted}, at ${shortSha(c.headSha)}.`,
    ];
    if (deploys)
      more.push(
        'Deploying builds and tests the merge, then switches Codeman to it. Your sessions keep running, and this page reloads when the new version is live.'
      );
    if (work) more.push('GitHub sees the branch merged and marks the pull request merged by itself.');
    more.push('A merge cannot be undone from this page.');
    const details = el('details', 'rv-confirm-more');
    details.append(el('summary', '', 'What is this?'), ...more.map((line) => el('p', '', line)));
    body.push(details);
    $('rvConfirmBody').replaceChildren(...body);
    $('rvConfirmGo').textContent = deploys ? 'Merge and deploy' : 'Merge';
    state.confirming = 'approve';
    $('rvConfirm').showModal();
    $('rvConfirmCancel').focus();
    return undefined;
  }

  // ---------------------------------------------------------------- close

  /** Close without merging: a duplicate, or work nobody wants. Asked first, like Approve, because it cannot be undone. */
  function askClose() {
    const r = state.review;
    if (!r || r.decision) return;
    const work = workOf();
    $('rvConfirmTitle').textContent = 'Close this review?';
    const body = [
      el('p', '', 'It leaves the queue without merging. Nothing is deleted: the branch stays on origin.'),
      el(
        'p',
        '',
        work
          ? `${work.key} stays where it is on the board.`
          : 'If the agent submits this work again, a new review opens.'
      ),
    ];
    if (r.unsent)
      body.push(
        el(
          'p',
          'rv-confirm-warn',
          `${r.unsent} ${r.unsent === 1 ? 'note has' : 'notes have'} not been sent and will not be.`
        )
      );
    $('rvConfirmBody').replaceChildren(...body);
    $('rvConfirmGo').textContent = 'Close review';
    state.confirming = 'close';
    $('rvConfirm').showModal();
    $('rvConfirmCancel').focus();
  }

  async function closeCall() {
    state.closing = true;
    renderHeader();
    try {
      const data = await api(`api/reviews/${encodeURIComponent(state.id)}/close`, { method: 'POST', body: {} });
      state.review = data.review;
      toast('Closed. Nothing was merged.', 'ok');
      loadQueue();
    } catch (err) {
      toast(err.message, 'bad');
    }
    state.closing = false;
    renderHeader();
    renderNotes();
    renderPreview();
  }

  async function reopenCall() {
    state.closing = true;
    renderHeader();
    try {
      const data = await api(`api/reviews/${encodeURIComponent(state.id)}/reopen`, { method: 'POST', body: {} });
      state.review = data.review;
      toast('Reopened. It is waiting for you again.', 'ok');
      loadQueue();
    } catch (err) {
      toast(err.message, 'bad');
    }
    state.closing = false;
    renderHeader();
    renderNotes();
    renderPreview();
  }

  async function approveCall(path, body) {
    state.approving = true;
    renderApprove();
    try {
      const data = await api(`api/reviews/${encodeURIComponent(state.id)}/${path}`, { method: 'POST', body });
      state.review = data.review;
      const d = data.review.decision || {};
      const where = data.merge && data.merge.pushed ? ' on origin' : '';
      const parts = [
        d.kind === 'deploying'
          ? `Merged as ${shortSha(d.mergedSha)}. The deploy is queued.`
          : d.kind === 'deploy-failed'
            ? `Merged as ${shortSha(d.mergedSha)}, but the deploy could not be requested: ${d.error || 'no reason given'}`
            : `Merged into ${data.review.base}${where} as ${shortSha(d.mergedSha)}.`,
      ];
      const others = (data.closedOthers || []).length;
      if (others)
        parts.push(
          `Closed ${others} other ${others === 1 ? 'review' : 'reviews'} of ${data.review.branch}: the merge holds their commits.`
        );
      const linked = data.linkedWork || { closed: [], failed: [] };
      if (linked.closed.length) parts.push(`Moved ${linked.closed.join(', ')} to Done.`);
      if (linked.failed.length)
        parts.push(
          `${linked.failed.map((f) => f.key).join(', ')} could not move to Done: move ${linked.failed.length === 1 ? 'it' : 'them'} on the canvas.`
        );
      toast(parts.join(' '), d.kind === 'deploy-failed' || linked.failed.length ? 'bad' : 'ok');
      loadQueue();
    } catch (err) {
      toast(err.message, 'bad');
    }
    state.approving = false;
    renderHeader();
    renderNotes();
    renderPreview();
  }

  /** While a deploy runs the colour serving this page is replaced, so no event can be relied on: ask. */
  function watchDeploy() {
    const deploying = state.review && state.review.state === 'deploying';
    if (deploying && !watchDeploy.timer) watchDeploy.timer = setInterval(refreshReview, 5000);
    if (!deploying && watchDeploy.timer) {
      clearInterval(watchDeploy.timer);
      watchDeploy.timer = null;
    }
  }

  /** The agent wrote its walkthrough for an earlier tip of the branch than the one the review now shows. */
  const authoredMoved = () =>
    !!(state.review && isWork() && state.review.authored && state.review.authored.headSha !== state.review.headSha);

  function renderNotice() {
    const box = $('rvNotice');
    const lines = [];
    if (state.changes && state.changes.gone)
      lines.push('The branch no longer exists. The walkthrough is kept as it was written.');
    else if ((state.changes && state.changes.moved) || authoredMoved())
      lines.push(
        'The branch has new commits since this walkthrough was written. Its code links may point at lines that moved.'
      );
    const d = state.review && state.review.decision;
    if (d && d.kind === 'merged' && state.approve && state.approve.shipsWithBase)
      lines.push(
        `Merged into ${state.review.base} as ${shortSha(d.mergedSha)}. It goes live when ${state.review.base} is merged and deployed; this page follows it.`
      );
    else if (d && d.kind === 'merged') lines.push(`Merged into ${state.review.base} as ${shortSha(d.mergedSha)}.`);
    else if (d && d.kind === 'deploying')
      lines.push(`Merged as ${shortSha(d.mergedSha)}. The deploy is running; this page follows it.`);
    else if (d && d.kind === 'deployed') lines.push(`Merged as ${shortSha(d.mergedSha)} and deployed.`);
    else if (d && d.kind === 'closed' && d.closedBy) {
      // A link, built from an id the server checked: the review whose Approve made this one a duplicate.
      const p = el('p', '', 'Closed when ');
      const a = el('a', '', 'another review of this branch');
      a.href = `reviews/${encodeURIComponent(d.closedBy)}`;
      p.append(a, ' was approved. Its merge holds every commit here.');
      lines.push(p);
    } else if (d && d.kind === 'closed') lines.push('Closed without merging. The branch is still on origin.');
    else if (d && d.kind === 'deploy-failed')
      lines.push(
        `Merged as ${shortSha(d.mergedSha)}, but the deploy did not go through: ${d.error || 'no reason given'}. The live build is unchanged.`
      );
    if (state.review && isWork() && !d && !(workOf() && workOf().wanted))
      lines.push(
        'The work item no longer asks for this review: it is closed, or its pull request changed. You can still read it.'
      );
    box.hidden = !lines.length;
    box.replaceChildren(...lines.map((line) => (typeof line === 'string' ? el('p', '', line) : line)));
  }

  function renderReview() {
    renderHeader();
    renderWalkthrough();
    renderNotes();
    renderNotice();
    renderCaptures();
    $('rvNotes').hidden = false;
  }

  // ---------------------------------------------------------------- walkthrough

  /** Agent or tracker Markdown, through the one sanitizer, as plain text when either piece is missing. */
  function markdownBody(text) {
    const body = el('div', 'rv-md');
    let html = null;
    try {
      const sanitize = window.sanitizeWalkthroughHtml || window.sanitizeMarkdownHtml;
      if (window.marked && sanitize) html = sanitize(window.marked.parse(text));
    } catch (_err) {
      html = null;
    }
    if (typeof html === 'string') body.innerHTML = html;
    else body.textContent = text;
    for (const a of body.querySelectorAll('a[href]')) wireLink(a);
    return body;
  }

  /**
   * The column holds the agent's words and nothing else. On a work review `walkthrough` is the item's text, owned by
   * the tracker; it lives on the Work item tab, and the column shows `authored`, the walkthrough the agent wrote.
   */
  function renderWalkthrough() {
    const r = state.review;
    const walk = $('rvWalk');
    walk.replaceChildren();
    renderWorkItem();
    const authored = isWork() ? r.authored || null : null;
    if (isWork() && !authored) {
      const open = el('button', 'rv-btn rv-btn-sm', 'Open the work item');
      open.type = 'button';
      open.id = 'rvOpenWorkItem';
      open.addEventListener('click', () => {
        setTab('work');
        setPane('stage');
      });
      walk.append(el('p', 'rv-dim rv-walk-none', 'No walkthrough from the agent yet.'), open);
      return;
    }
    const revision = r.revision > 1 ? ` · revision ${r.revision}` : '';
    walk.append(
      el(
        'div',
        'rv-by',
        authored
          ? `Walkthrough by ${authored.sessionName || 'a session'} · ${agoText(authored.at)}${revision}`
          : `Written by ${r.sessionName || 'a session'} · ${agoText(r.updatedAt)}${revision}`
      )
    );
    walk.append(markdownBody(authored ? authored.walkthrough : r.walkthrough));
    markStaleLinks();
    paintTextNotes();
  }

  /**
   * A work review's Work item tab: the item's text as the tracker has it (its open question first, then its
   * description and pull request). It is never the tab a review opens on, and notes are not anchored in it, since the
   * text is replaced at every sync; a general note covers it.
   */
  function renderWorkItem() {
    const r = state.review;
    const tab = $('rvTabWork');
    const box = $('rvWorkItem');
    const shown = !!r && isWork();
    tab.hidden = !shown;
    if (!shown) {
      box.replaceChildren();
      if (state.tab === 'work') setTab('changes');
      return;
    }
    const work = workOf();
    tab.textContent = `Work item ${work ? work.key : r.sessionName}`;
    box.replaceChildren(
      el('div', 'rv-by', 'The item as the tracker has it now. It changes when the item does.'),
      markdownBody(r.walkthrough)
    );
  }

  /**
   * A code link whose file the branch no longer changes is struck through. Only when the whole file list is known:
   * a list that failed to load or was cut short says nothing about a file it does not name.
   */
  function markStaleLinks() {
    const c = state.changes;
    // A branch that was merged changes nothing against its base, and that says nothing about the walkthrough.
    const open = state.review && !state.review.decision;
    const known = open && c && !c.gone && !c.truncated && c.files.length ? new Set(c.files.map((f) => f.path)) : null;
    for (const a of $('rvWalk').querySelectorAll('a.rv-lk-code')) {
      const stale = known !== null && !known.has(a.dataset.path);
      a.classList.toggle('rv-lk-stale', stale);
      if (stale) a.title = 'This file is no longer among the changes';
      else a.removeAttribute('title');
    }
  }

  /** `#code=path:10-24` and `#preview=/path` move the stage; every other link opens in a new tab. */
  function wireLink(a) {
    const href = a.getAttribute('href') || '';
    const code = /^#code=(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(href);
    const preview = /^#preview=(\/.*)$/.exec(href);
    const capture = /^#capture=([a-z0-9][a-z0-9-]{0,39})$/.exec(href);
    if (capture) {
      a.className = 'rv-lk rv-lk-preview';
      a.removeAttribute('target');
      a.addEventListener('click', (event) => {
        event.preventDefault();
        showCapture(capture[1]);
      });
    } else if (code) {
      const path = decodeURIComponent(code[1]);
      const from = code[2] ? Number(code[2]) : null;
      const to = code[3] ? Number(code[3]) : from;
      a.className = 'rv-lk rv-lk-code';
      a.dataset.path = path;
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

  /** Where the reader's selection sits, as a note anchor: the walkthrough, or the Markdown file read rendered. */
  function selectionTarget() {
    const walk = walkText();
    const anchor = walk && selectionAnchor(walk);
    if (anchor) return { kind: 'text', anchor };
    const doc = docText();
    const inDoc = doc && state.file && selectionAnchor(doc);
    return inDoc ? { kind: 'doc', path: state.file, anchor: inDoc } : null;
  }

  function selectionAnchor(root) {
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
    const at = state.review && isOpenReview() ? selectionTarget() : null;
    if (!at) {
      button.hidden = true;
      return;
    }
    const rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
    button.hidden = false;
    button.style.top = `${Math.max(8, rect.top - 40)}px`;
    button.style.left = `${Math.min(window.innerWidth - 110, Math.max(8, rect.left))}px`;
    button.onclick = () => {
      button.hidden = true;
      openComposer(at);
      window.getSelection().removeAllRanges();
    };
  }

  // ---------------------------------------------------------------- notes

  const isOpenReview = () =>
    state.review && !['merged', 'deployed', 'deploying', 'closed'].includes(state.review.state);

  function whereText(at) {
    if (at.kind === 'general') return 'General';
    if (at.kind === 'text')
      return `“${at.anchor.quote.length > 90 ? `${at.anchor.quote.slice(0, 90)}…` : at.anchor.quote}”`;
    if (at.kind === 'code') return `${at.path}:${at.line}${at.side === 'old' ? ' (removed)' : ''}`;
    if (at.kind === 'doc')
      return `${at.path} · “${at.anchor.quote.length > 70 ? `${at.anchor.quote.slice(0, 70)}…` : at.anchor.quote}”`;
    if (at.kind === 'capture') {
      const still = captures().find((c) => c.name === at.name);
      return `Capture · ${(still && still.label) || at.name}`;
    }
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
    const onStill = state.composing && state.composing.kind === 'capture';
    state.composing = null;
    $('rvComposer').hidden = true;
    if (onStill) renderCaptures();
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
    if (note.at.kind === 'code') showCode(note.at.path, note.at.side === 'new' ? note.at.line : null, null, 'diff');
    else if (note.at.kind === 'doc') showDocNote(note);
    else if (note.at.kind === 'capture') {
      state.flashPin = note.id;
      if (note.at.x !== undefined && state.pinsHidden) setPinsHidden(false);
      showCapture(note.at.name);
    } else if (note.at.kind === 'preview') {
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
      renderFiles();
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
        el(
          'li',
          'rv-dim',
          captures().length
            ? 'No notes yet. Select words in the walkthrough or a rendered document, press a line in Changes, or press a capture, to anchor one.'
            : 'No notes yet. Select words in the walkthrough or a rendered document, or press a line in Changes, to anchor one.'
        )
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
    if (!isWork() && !state.sessionLive) return sendToNewSession();
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
        data.work
          ? `Sent to ${data.work.key}. It is first in Ready for work.`
          : data.confirmed
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

  /** The author session has ended: a new session is started on the branch and handed the review with its notes. */
  async function sendToNewSession() {
    const id = state.id;
    const button = $('rvRequest');
    state.sending = true;
    button.disabled = true;
    // Claude Code takes up to a minute before it accepts a first prompt, so this can take a while.
    button.textContent = 'Sending…';
    try {
      const data = await api(`api/reviews/${encodeURIComponent(id)}/new-session`, { method: 'POST', body: {} });
      if (state.id === id) {
        state.review = data.review;
        state.sessionLive = true;
      }
      toast(
        data.confirmed
          ? `Sent ${data.sent.length} ${data.sent.length === 1 ? 'note' : 'notes'} to the agent.`
          : 'The notes were written to the agent, but it has not confirmed it started. Check the session.',
        data.confirmed ? 'ok' : 'warn'
      );
      loadQueue();
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      state.sending = false;
    }
    if (state.id !== id) return;
    renderHeader();
    renderNotes();
    renderNotice();
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
    markStaleLinks();
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
        (n) => (n.at.kind === 'code' || n.at.kind === 'doc') && n.at.path === file.path && !n.resolvedAt
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
    state.doc = isDocFile(path) ? { path, state: 'loading' } : null;
    if (state.doc) loadDoc(seq, path);
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

  /** `view` forces how a Markdown file is read; without it the reader's own choice stands. */
  function showCode(path, from, to, view) {
    if (view && isDocFile(path)) state.docView = view;
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
    const keep = box.dataset.file === state.file && box.dataset.view === docViewOf(state.file) ? box.scrollTop : 0;
    box.dataset.file = state.file || '';
    box.dataset.view = docViewOf(state.file);
    box.replaceChildren();
    box.scrollTop = 0;
    requestAnimationFrame(() => {
      if (keep && !state.range && !state.docFocus) box.scrollTop = keep;
    });
    if (state.changesError) return void box.append(el('div', 'rv-dim rv-pad', state.changesError));
    const c = state.changes;
    if (!c) return void box.append(el('div', 'rv-dim rv-pad', 'Reading the changes…'));
    if (c.gone)
      return void box.append(el('div', 'rv-dim rv-pad', 'The branch is gone, so there is nothing to compare.'));
    if (!c.files.length)
      return void box.append(el('div', 'rv-dim rv-pad', 'This branch changes no files against its base.'));
    const d = state.diff;
    if (!d) return;
    if (isDocFile(state.file)) {
      box.append(docHead());
      if (state.docView === 'rendered') return void renderDoc(box);
    } else box.append(el('div', 'rv-diff-file', state.file));
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

  // ---------------------------------------------------------------- rendered documents

  const DOC_PATH = /\.(md|markdown)$/i;
  const docText = () => $('rvDiff').querySelector('.rv-doc-md');
  function isDocFile(path) {
    if (!path || !DOC_PATH.test(path) || !state.changes) return false;
    const file = state.changes.files.find((f) => f.path === path);
    return !!file && !file.binary;
  }
  const docViewOf = (path) => (isDocFile(path) ? state.docView : 'diff');

  async function loadDoc(seq, path) {
    let next;
    try {
      const data = await api(`api/reviews/${encodeURIComponent(state.id)}/file?path=${encodeURIComponent(path)}`);
      next = { path, state: 'ready', text: data.text };
    } catch (err) {
      next = { path, state: 'error', error: err.message };
    }
    if (seq !== state.loadSeq || state.file !== path) return;
    state.doc = next;
    if (state.docView === 'rendered') renderDiff();
  }

  /** The file's sticky header with the Rendered / Diff switch. */
  function docHead() {
    const head = el('div', 'rv-diff-file rv-doc-head');
    head.append(el('span', 'rv-doc-path', state.file));
    if (state.docView === 'rendered' && newLines() && !newLines().whole)
      head.append(el('span', 'rv-doc-key', 'Changed on this branch'));
    const seg = el('div', 'rv-seg rv-seg-sm');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Read the file as');
    for (const [view, label] of [
      ['rendered', 'Rendered'],
      ['diff', 'Diff'],
    ]) {
      const b = el('button', '', label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(state.docView === view));
      b.addEventListener('click', () => {
        if (state.docView === view) return;
        state.docView = view;
        renderDiff();
      });
      seg.append(b);
    }
    head.append(seg);
    return head;
  }

  /**
   * The new-side lines this branch touched: added lines, and the line after a removal. `whole` when the branch adds
   * the file, so the bar would only say "everything".
   */
  function newLines() {
    const d = state.diff;
    if (!d || d.state !== 'ready' || !d.diff) return null;
    if (/^--- \/dev\/null$/m.test(d.diff)) return { whole: true, lines: new Set() };
    const lines = new Set();
    let newNo = 0;
    let inHunk = false;
    for (const line of d.diff.split('\n')) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        newNo = Number(hunk[1]);
        inHunk = true;
      } else if (!inHunk || line.startsWith('\\')) continue;
      else if (line.startsWith('+')) lines.add(newNo++);
      else if (line.startsWith('-')) lines.add(newNo);
      else newNo++;
    }
    return { whole: false, lines };
  }

  /** Repository Markdown links point into the repository, not at this page: only web addresses stay live. */
  function quietDocLinks(root) {
    for (const a of root.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      if (/^(https?:|mailto:)/i.test(href)) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      } else {
        a.removeAttribute('href');
        a.classList.add('rv-doc-link');
        a.title = href;
      }
    }
    for (const img of root.querySelectorAll('img')) {
      if (/^https:/i.test(img.getAttribute('src') || '')) continue;
      const alt = img.getAttribute('alt') || '';
      img.replaceWith(el('span', 'rv-doc-img', alt ? `[image: ${alt}]` : '[image]'));
    }
  }

  /** The file as blocks, each knowing its source lines, so a changed block and a code link's range can be marked. */
  function docBody(text) {
    const root = el('div', 'rv-md rv-doc-md');
    let tokens = null;
    try {
      if (window.marked && window.sanitizeMarkdownHtml) tokens = window.marked.lexer(text);
    } catch (_err) {
      tokens = null;
    }
    if (!tokens) {
      root.append(el('pre', 'rv-doc-plain', text));
      return root;
    }
    const touched = newLines();
    let line = 1;
    for (const token of tokens) {
      const raw = typeof token.raw === 'string' ? token.raw : '';
      const breaks = (raw.match(/\n/g) || []).length;
      const from = line;
      const to = line + Math.max(0, breaks - (raw.endsWith('\n') ? 1 : 0));
      line += breaks;
      if (token.type === 'space' || token.type === 'def') continue;
      const block = el('div', 'rv-blk');
      const one = [token];
      one.links = tokens.links;
      try {
        block.innerHTML = window.sanitizeMarkdownHtml(window.marked.parser(one));
      } catch (_err) {
        block.textContent = raw;
      }
      block.dataset.from = String(from);
      block.dataset.to = String(to);
      if (touched && !touched.whole) {
        for (let n = from; n <= to; n++)
          if (touched.lines.has(n)) {
            block.classList.add('rv-blk-changed');
            break;
          }
      }
      root.append(block);
    }
    quietDocLinks(root);
    return root;
  }

  function renderDoc(box) {
    const doc = state.doc;
    if (!doc || doc.path !== state.file || doc.state === 'loading')
      return void box.append(el('div', 'rv-dim rv-pad', 'Reading the file…'));
    if (doc.state === 'error') {
      const wrap = el('div', 'rv-pad');
      wrap.append(el('p', 'rv-dim', doc.error));
      const diff = el('button', 'rv-btn rv-btn-sm', 'Show the diff');
      diff.type = 'button';
      diff.addEventListener('click', () => {
        state.docView = 'diff';
        renderDiff();
      });
      wrap.append(diff);
      return void box.append(wrap);
    }
    const page = el('div', 'rv-docview');
    const body = docBody(doc.text);
    page.append(body);
    box.append(page);
    paintDocNotes(body);
    let target = null;
    if (state.range) {
      for (const block of body.querySelectorAll('.rv-blk')) {
        if (Number(block.dataset.to) < state.range.from || Number(block.dataset.from) > state.range.to) continue;
        block.classList.add('rv-blk-target');
        if (!target) target = block;
      }
      if (!target) toast('Those lines are not in the file any more. The branch may have moved.', 'warn');
    }
    if (state.docFocus) {
      const mark = body.querySelector(`mark[data-note="${CSS.escape(state.docFocus)}"]`);
      if (mark) {
        target = mark;
        mark.classList.add('rv-mark-flash');
        setTimeout(() => mark.classList.remove('rv-mark-flash'), 1400);
      } else toast('Those words are no longer in the file. The branch may have changed them.', 'warn');
      state.docFocus = null;
    }
    if (target) requestAnimationFrame(() => target.scrollIntoView({ block: 'center' }));
  }

  function paintDocNotes(root) {
    for (const note of state.review.notes) {
      if (note.at.kind !== 'doc' || note.at.path !== state.file || note.resolvedAt) continue;
      const found = locate(root.textContent, note.at.anchor);
      if (found) wrapRange(root, found.start, found.end, note.id);
    }
  }

  function showDocNote(note) {
    state.docFocus = note.id;
    state.docView = 'rendered';
    setTab('changes');
    setPane('stage');
    if (!state.changes || !state.changes.files.some((f) => f.path === note.at.path)) {
      state.docFocus = null;
      toast(`${note.at.path} is not among the files this branch changes.`, 'warn');
      return;
    }
    if (state.file === note.at.path && state.doc && state.doc.state === 'ready') {
      state.range = null;
      renderDiff();
    } else selectFile(note.at.path, null);
  }

  // ---------------------------------------------------------------- preview

  async function loadPreview(seq) {
    const r = state.review;
    // A work review has no author session, so no session preview: the empty state says what is there instead.
    if (isWork()) {
      state.preview = { state: 'none' };
      renderPreview();
      return;
    }
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
    const onStill = state.tab === 'captures' && currentCapture() !== null;
    if (onStill) {
      noteButton.hidden = !isOpenReview();
      noteButton.textContent = 'Add note';
    }
    const pinned = onStill ? stillNotes().length : elementNotes().length;
    const toggle = $('rvPinsToggle');
    toggle.hidden = !(shown || onStill) || !pinned;
    toggle.textContent = state.pinsHidden ? `Show notes · ${pinned}` : `Hide notes · ${pinned}`;
    toggle.setAttribute('aria-pressed', String(!state.pinsHidden));
    $('rvBarNote').textContent =
      onStill || !shown ? '' : state.picking ? 'Press an element in the preview' : state.previewPath;
    if (!ready) {
      box.replaceChildren(
        el(
          'div',
          'rv-dim rv-pad',
          !p || p.state === 'loading'
            ? 'Looking for a running preview…'
            : isWork()
              ? 'A pull request has no running preview here. Its code is under Changes.'
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
    renderCaptures();
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

  // ---------------------------------------------------------------- captures
  //
  // Stills the agent took of the running branch, for work whose preview cannot be framed here. Each is an image
  // this server stores and serves by the name in the review's own record. A note sits on a point of a still, kept
  // as fractions of its size so the pin lands in the same place at any width.

  const captures = () => (state.review && state.review.captures) || [];
  const currentCapture = () => captures().find((c) => c.name === state.capture) || captures()[0] || null;
  const stillNotes = () => {
    const still = currentCapture();
    return still
      ? state.review.notes.filter(
          (n) => !n.resolvedAt && n.at.kind === 'capture' && n.at.name === still.name && n.at.x !== undefined
        )
      : [];
  };

  function stillPin(text, x, y, title) {
    const pin = el('button', 'rv-pin', text);
    pin.type = 'button';
    pin.title = title;
    pin.style.left = `calc(${x * 100}% - 11px)`;
    pin.style.top = `calc(${y * 100}% - 22px)`;
    return pin;
  }

  function renderCaptures() {
    const all = captures();
    const tab = $('rvTabCaptures');
    tab.hidden = !all.length;
    tab.textContent = `Captures · ${all.length}`;
    const list = $('rvCaptureList');
    const box = $('rvStill');
    list.replaceChildren();
    if (!all.length) {
      box.replaceChildren();
      if (state.tab === 'captures') setTab('changes');
      return;
    }
    const still = currentCapture();
    for (const c of all) {
      const row = el('button', 'rv-chip');
      row.type = 'button';
      if (c.name === still.name) row.setAttribute('aria-current', 'true');
      row.append(el('span', '', c.label || c.name), el('span', 'rv-chip-dim', `${c.width}×${c.height}`));
      row.addEventListener('click', () => showCapture(c.name));
      list.append(row);
    }
    const src = `api/reviews/${encodeURIComponent(state.review.id)}/captures/${encodeURIComponent(still.name)}?v=${still.at}`;
    let frame = box.querySelector('.rv-still-box');
    let img = frame && frame.querySelector('img');
    if (!img || img.dataset.src !== src) {
      frame = el('div', 'rv-still-box');
      img = document.createElement('img');
      img.dataset.src = src;
      img.src = src;
      img.width = still.width;
      img.height = still.height;
      img.alt = still.label || `Capture ${still.name}`;
      img.draggable = false;
      if (isOpenReview()) img.title = 'Press a spot to put a note there';
      img.addEventListener('click', (event) => {
        if (!isOpenReview()) return;
        const rect = img.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const part = (value) => Math.round(Math.min(1, Math.max(0, value)) * 10000) / 10000;
        openComposer({
          kind: 'capture',
          name: still.name,
          x: part((event.clientX - rect.left) / rect.width),
          y: part((event.clientY - rect.top) / rect.height),
        });
        renderCaptures();
      });
      const pins = el('div', 'rv-pins');
      frame.append(img, pins);
      box.replaceChildren(frame);
    }
    frame.classList.toggle('rv-still-open', Boolean(isOpenReview()));
    frame.classList.toggle('rv-still-actual', state.stillActual);
    $('rvStillSize').setAttribute('aria-pressed', String(state.stillActual));
    const layer = frame.querySelector('.rv-pins');
    layer.replaceChildren();
    layer.hidden = state.pinsHidden;
    stillNotes().forEach((note, index) => {
      const title = note.text.length > 120 ? `${note.text.slice(0, 120)}…` : note.text;
      const pin = stillPin(String(index + 1), note.at.x, note.at.y, title);
      pin.setAttribute('aria-label', `Note ${index + 1}: ${title}`);
      if (state.flashPin === note.id) pin.classList.add('rv-pin-flash');
      pin.addEventListener('click', () => {
        state.flashPin = note.id;
        renderCaptures();
        focusNote(note.id);
      });
      layer.append(pin);
    });
    // Where the note being written will sit. It shows even with the others hidden, or the press would seem lost.
    const draft = state.composing;
    if (draft && draft.kind === 'capture' && draft.name === still.name && draft.x !== undefined) {
      layer.hidden = false;
      const pin = stillPin('+', draft.x, draft.y, 'The note you are writing');
      pin.classList.add('rv-pin-draft');
      pin.tabIndex = -1;
      layer.append(pin);
    }
    renderPreview();
  }

  function showCapture(name) {
    setPane('stage');
    if (!captures().some((c) => c.name === name)) {
      toast(`This review has no capture named ${name}.`, 'warn');
      return;
    }
    state.capture = name;
    if (state.tab === 'captures') renderCaptures();
    else setTab('captures');
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

  // ── Open live: a branch of Codeman itself, running on its own address ──────────────────────────────

  const LIVE_READY = ['stopped', 'starting', 'running'];
  const LIVE_POLL_MS = 5000;
  const LIVE_USE_EVERY_MS = 60000;
  let livePoll = 0;
  let liveUsedAt = 0;
  /** The last word sent, so leaving a tab that is closing does not say `close` twice. */
  let liveLast = '';

  function liveReady() {
    return !!(state.live && state.live.available && LIVE_READY.includes(state.live.state));
  }

  /** Takes the server's word on the review's live preview and draws the button. Polls while a build runs. */
  function setLive(live) {
    state.live = live && live.available ? live : null;
    const button = $('rvOpenLive');
    clearTimeout(livePoll);
    button.hidden = !state.live;
    if (!state.live) return;
    const kind = state.live.state;
    const busy = kind === 'building' || state.liveBusy;
    const label = $('rvOpenLiveLabel');
    button.disabled = busy;
    // aria-busy also shows the spinner (reviews.css), so the wait reads as work, not as a dead button.
    button.setAttribute('aria-busy', String(busy));
    button.title = '';
    if (kind === 'none') label.textContent = state.liveBusy ? 'Starting the build…' : 'Build live preview';
    else if (kind === 'building') {
      label.textContent = 'Building live preview…';
      button.title = 'A build takes about two minutes. This page notices when it is done.';
    } else if (kind === 'build-failed') {
      label.textContent = state.liveBusy ? 'Starting the build…' : 'Live build failed. Build again';
      button.title = state.liveBusy ? '' : state.live.error || '';
    } else {
      label.textContent = state.liveBusy ? 'Waking the preview…' : 'Open live';
      button.title = 'Opens this branch running on its own address, in a new tab';
    }
    if (kind === 'building') livePoll = setTimeout(pollLive, LIVE_POLL_MS);
  }

  async function pollLive() {
    const id = state.id;
    if (!id || document.hidden) return;
    try {
      const data = await api(`api/reviews/${encodeURIComponent(id)}`);
      if (id !== state.id) return;
      const wasBuilding = state.live && state.live.state === 'building';
      setLive(data.live);
      if (wasBuilding && liveReady()) {
        toast('The live preview is built.', 'ok');
        liveSay('open');
      }
    } catch (_err) {
      if (id === state.id) livePoll = setTimeout(pollLive, LIVE_POLL_MS);
    }
  }

  /**
   * Tells the preview service a person is looking at this review (`open`) or has left it (`close`). The service
   * runs the preview only while a review is in use, so this is sent on opening a review, on returning to the tab,
   * at most once a minute while the page is being used, and on the way out.
   */
  function liveSay(action) {
    if (!state.id || !liveReady() || (action === 'close' && liveLast !== 'open')) return;
    liveLast = action;
    if (action === 'open') liveUsedAt = Date.now();
    fetch(`api/reviews/${encodeURIComponent(state.id)}/live`, {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    }).catch(() => {});
  }

  function liveTouched(event) {
    // The button says `open` itself.
    if (event.target instanceof Element && event.target.closest('#rvOpenLive')) return;
    if (!document.hidden && Date.now() - liveUsedAt > LIVE_USE_EVERY_MS) liveSay('open');
  }

  async function liveClick() {
    if (!state.live || state.liveBusy) return;
    const id = state.id;
    const ready = liveReady();
    // The tab is opened inside the click, before the wait, or the browser blocks it as a pop-up.
    const tab = ready ? window.open('', '_blank') : null;
    if (tab) {
      tab.opener = null;
      tab.document.title = 'Waking the preview…';
      tab.document.body.textContent = 'Waking the preview. This takes a few seconds.';
    }
    state.liveBusy = true;
    setLive(state.live);
    try {
      const data = await api(`api/reviews/${encodeURIComponent(id)}/live`, {
        method: 'POST',
        body: { action: ready ? 'open' : 'build' },
      });
      state.liveBusy = false;
      if (id !== state.id) {
        if (tab) tab.close();
        return;
      }
      liveUsedAt = Date.now();
      if (ready) liveLast = 'open';
      setLive(data.live);
      if (tab && data.live && data.live.url && /^https:\/\//.test(data.live.url)) tab.location.replace(data.live.url);
      else if (tab) tab.close();
      if (!ready) toast('The live preview is being built. It takes about two minutes.');
    } catch (err) {
      state.liveBusy = false;
      if (tab) tab.close();
      if (id === state.id) setLive(state.live);
      toast(err.message, 'bad');
    }
  }

  function setTab(tab) {
    state.tab = tab;
    $('rvTabPreview').setAttribute('aria-selected', String(tab === 'preview'));
    $('rvTabChanges').setAttribute('aria-selected', String(tab === 'changes'));
    $('rvTabCaptures').setAttribute('aria-selected', String(tab === 'captures'));
    $('rvTabWork').setAttribute('aria-selected', String(tab === 'work'));
    $('rvPreview').hidden = tab !== 'preview';
    $('rvChanges').hidden = tab !== 'changes';
    $('rvCaptures').hidden = tab !== 'captures';
    $('rvWorkItem').hidden = tab !== 'work';
    if (tab === 'captures') renderCaptures();
    else renderPreview();
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
    $('rvApprove').addEventListener('click', askApprove);
    $('rvConfirmCancel').addEventListener('click', () => $('rvConfirm').close());
    $('rvClose').addEventListener('click', askClose);
    $('rvReopen').addEventListener('click', reopenCall);
    $('rvConfirmGo').addEventListener('click', () => {
      $('rvConfirm').close();
      if (state.confirming === 'close') closeCall();
      else approveCall('approve', { headSha: state.changes.headSha });
      state.confirming = null;
    });
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
    $('rvTabCaptures').addEventListener('click', () => setTab('captures'));
    $('rvTabWork').addEventListener('click', () => setTab('work'));
    $('rvStillSize').addEventListener('click', () => {
      state.stillActual = !state.stillActual;
      renderCaptures();
    });
    $('rvPreviewNote').addEventListener('click', () => {
      if (state.tab === 'captures') {
        const still = currentCapture();
        if (still) openComposer({ kind: 'capture', name: still.name });
      } else if (state.picking) setPicking(false);
      else if (state.bridge) setPicking(true);
      else openComposer({ kind: 'preview', path: state.previewPath });
    });
    $('rvPinsToggle').addEventListener('click', () => setPinsHidden(!state.pinsHidden));
    $('rvOpenLive').addEventListener('click', liveClick);
    document.addEventListener('pointerdown', liveTouched, true);
    document.addEventListener('keydown', liveTouched, true);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) liveSay('close');
      else {
        liveSay('open');
        if (state.live && state.live.state === 'building') pollLive();
      }
    });
    window.addEventListener('pagehide', () => liveSay('close'));
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
