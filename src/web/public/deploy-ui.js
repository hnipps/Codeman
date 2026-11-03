/**
 * @fileoverview "Deploys" section of the App Settings modal: the live build, the releases kept on
 * disk and the last deploys, with rollback buttons. Built only when GET /api/deploy/overview says
 * a deploy supervisor is configured, so an install without one never sees it.
 *
 * A rollback is confirmed in the page (no confirm()), then requested with POST /api/deploy/rollback.
 * The request outlives this page: when the old build stops, the existing build-change reload takes
 * over. Until then the overview is polled while the modal is open, so a failed rollback shows up as
 * the newest deploy row.
 *
 * @dependency settings-ui.js (App Settings modal, switchSettingsTab)
 * @loadorder after admin-ui.js
 */
(function () {
  'use strict';

  const POLL_MS = 3000;
  const SHA_PATTERN = /^[0-9a-f]{7,40}$/;
  const ICON =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 10 9 10"/></svg>';

  let overview = null;
  let confirming = null;
  let inFlight = false;
  let message = '';
  let messageIsError = false;

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const short = (sha) => (sha ? String(sha).slice(0, 7) : 'unknown');
  const when = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
  };

  async function fetchOverview() {
    const res = await window.fetch('/api/deploy/overview', { headers: { Accept: 'application/json' } });
    const body = await res.json();
    if (!res.ok || !body.success) throw new Error(body.error || 'Could not read deploys');
    return body.data;
  }

  async function postRollback(target) {
    let res;
    try {
      res = await window.fetch('/api/deploy/rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target }),
      });
    } catch {
      return { ok: false, body: { error: 'The server could not be reached.' } };
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* empty body */
    }
    return { ok: res.ok, body };
  }

  const section = () => document.getElementById('settings-deploys');
  const modalOpen = () => {
    const modal = document.getElementById('appSettingsModal');
    return !!modal && modal.classList.contains('active');
  };

  function rollbackButton(target, label, busy) {
    return `<button type="button" class="btn-toolbar btn-sm" data-act="ask" data-target="${esc(target)}"${busy ? ' disabled' : ''}>${esc(label)}</button>`;
  }

  function render() {
    const el = section();
    if (!el || !overview || !overview.configured) return;
    const busy = overview.busy || inFlight || confirming !== null;

    const live = overview.live
      ? `<span class="mono" data-i18n-skip>${esc(short(overview.live.sha))}</span> <span class="set-row-desc" data-i18n-skip>since ${esc(when(overview.live.since))}</span>`
      : '<span class="set-row-desc">Nothing is live</span>';

    const releases = overview.releases
      .map(
        (r) => `<div class="set-row">
          <div class="set-row-text"><span class="set-row-label mono" data-i18n-skip>${esc(short(r.sha))}${r.live ? ' (live)' : ''}</span>
            <span class="set-row-desc" data-i18n-skip>built ${esc(when(r.builtAt))}</span></div>
          ${r.live ? '' : `<div class="set-row-actions">${rollbackButton(r.sha, 'Roll back', busy)}</div>`}
        </div>`
      )
      .join('');

    const recent = overview.recent
      .map((d) => {
        const failed = d.outcome !== 'success';
        const detail = [d.outcome, d.failedStep ? `failed at ${d.failedStep}` : ''].filter(Boolean).join(', ');
        return `<div class="set-row">
          <div class="set-row-text"><span class="set-row-label" data-i18n-skip>${esc(d.action)} <span class="mono">${esc(short(d.sha))}</span></span>
            <span class="set-row-desc" data-i18n-skip>${esc(when(d.startedAt))}</span></div>
          <span class="set-static" data-i18n-skip style="${failed ? 'color:var(--red,#e5534b)' : ''}">${esc(detail)}</span>
        </div>`;
      })
      .join('');

    const status = overview.busy ? '<div class="set-note">A deploy is running.</div>' : '';
    const note = message
      ? `<div class="set-note" role="status" data-i18n-skip${messageIsError ? ' style="color:var(--red,#e5534b)"' : ''}>${esc(message)}</div>`
      : '';

    el.querySelector('#deployDynamic').innerHTML = `
      <div class="set-group"><div class="set-group-head"><h4>Live build</h4></div>
        <div class="set-group-body"><div class="set-row"><div class="set-row-text">${live}</div>
          <div class="set-row-actions">${rollbackButton('previous', 'Roll back to previous', busy)}</div></div></div></div>
      <div class="set-group"><div class="set-group-head"><h4>Kept releases</h4></div>
        <div class="set-group-body">${releases || '<p class="set-row-desc">No releases kept.</p>'}</div></div>
      ${status}${note}
      <div class="set-group"><div class="set-group-head"><h4>Recent deploys</h4></div>
        <div class="set-group-body">${recent || '<p class="set-row-desc">No deploys yet.</p>'}</div></div>`;

    const input = el.querySelector('#deployShaInput');
    const shaBtn = el.querySelector('[data-act="ask-sha"]');
    if (shaBtn) shaBtn.disabled = busy;
    if (input) input.disabled = busy;

    const box = el.querySelector('#deployConfirm');
    box.hidden = confirming === null;
    if (confirming) {
      box.innerHTML = `<div class="set-note" role="alertdialog" aria-label="Confirm rollback">
        <p>Roll back to <b class="mono" data-i18n-skip>${esc(confirming.label)}</b>? The app restarts on that build.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" class="btn-toolbar btn-sm btn-primary" data-act="confirm"${inFlight ? ' disabled' : ''}>Confirm</button>
          <button type="button" class="btn-toolbar btn-sm" data-act="cancel"${inFlight ? ' disabled' : ''}>Cancel</button>
        </div></div>`;
    }
  }

  async function refresh() {
    try {
      overview = await fetchOverview();
    } catch {
      return;
    }
    render();
  }

  function ask(target) {
    confirming = { target, label: target === 'previous' ? 'the previous release' : short(target) };
    message = '';
    render();
  }

  async function confirmRollback() {
    if (!confirming || inFlight) return;
    const { target } = confirming;
    inFlight = true;
    render();
    const result = await postRollback(target);
    inFlight = false;
    confirming = null;
    if (result.ok && result.body && result.body.data) {
      messageIsError = false;
      message = `Rollback requested (${result.body.data.requestId}). This page reloads when that build goes live.`;
    } else {
      messageIsError = true;
      message = (result.body && result.body.error) || 'The rollback could not be requested.';
    }
    render();
    refresh();
  }

  function onClick(e) {
    const btn = e.target.closest('button[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === 'ask') ask(btn.dataset.target);
    else if (act === 'ask-sha') {
      const input = section().querySelector('#deployShaInput');
      const sha = input.value.trim().toLowerCase();
      if (!SHA_PATTERN.test(sha)) {
        messageIsError = true;
        message = 'Enter 7 to 40 lowercase hex characters.';
        render();
        return;
      }
      ask(sha);
    } else if (act === 'confirm') confirmRollback();
    else if (act === 'cancel') {
      confirming = null;
      render();
    }
  }

  function inject() {
    const modal = document.getElementById('appSettingsModal');
    if (!modal || section()) return;
    const rail = modal.querySelector('.set-rail-items');
    const body = modal.querySelector('.set-doc');
    if (!rail || !body) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'set-rail-item';
    btn.dataset.section = 'settings-deploys';
    btn.innerHTML = `${ICON}<span>Deploys</span>`;
    rail.appendChild(btn);
    const content = document.createElement('section');
    content.className = 'set-section';
    content.id = 'settings-deploys';
    content.dataset.label = 'Deploys';
    content.innerHTML = `
      <div class="set-section-head">${ICON}<h2>Deploys</h2></div>
      <p class="set-section-blurb">Roll back to a release kept on disk, or to any earlier commit. A rollback restores code only.</p>
      <div id="deployDynamic"></div>
      <div id="deployConfirm" hidden></div>
      <div class="set-group"><div class="set-group-head"><h4>Roll back to a commit</h4></div>
        <div class="set-group-body">
          <div class="set-row">
            <div class="set-row-text">
              <label class="set-row-label" for="deployShaInput">Commit sha</label>
              <span class="set-row-desc">A commit that is not kept on disk is rebuilt from git and can take several minutes.</span>
            </div>
            <div class="set-row-actions" style="flex-wrap:wrap">
              <input type="text" class="set-input mono" id="deployShaInput" placeholder="abc1234" maxlength="40" autocomplete="off" spellcheck="false" data-i18n-skip>
              <button type="button" class="btn-toolbar btn-sm" data-act="ask-sha">Roll back to this commit</button>
            </div>
          </div>
        </div>
      </div>`;
    body.appendChild(content);
    content.addEventListener('click', onClick);
    btn.addEventListener('click', refresh);
    new MutationObserver(() => {
      if (modalOpen()) refresh();
    }).observe(modal, { attributes: true, attributeFilter: ['class'] });
    setInterval(() => {
      if (modalOpen()) refresh();
    }, POLL_MS);
  }

  async function boot() {
    let first;
    try {
      first = await fetchOverview();
    } catch {
      return;
    }
    if (!first.configured) return;
    overview = first;
    inject();
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
