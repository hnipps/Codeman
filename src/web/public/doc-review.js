/** Document review for rendered Markdown previews. */

(function () {
  const LIMITS = Object.freeze({
    MAX_COMMENTS: 100,
    MAX_COMMENT_CHARS: 4000,
    MAX_QUOTE_CHARS: 2000,
    MAX_OVERALL_CHARS: 8000,
    MAX_HEADING_CHARS: 200,
    CONTEXT_CHARS: 32,
    PROMPT_PATH_CHARS: 300,
    PROMPT_MAX_CHARS: 1000,
  });
  const STORAGE_PREFIX = 'codeman:docReview:';
  // C0, DEL, C1 and the Unicode line separators: none may reach the prompt line.
  const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

  /** FNV-1a over UTF-16 code units, with the length: change detection, not security. */
  function hashContent(text) {
    const value = String(text ?? '');
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return `${(hash >>> 0).toString(16).padStart(8, '0')}-${value.length}`;
  }

  function emptyDraft(contentHash) {
    return { v: 1, contentHash: String(contentHash ?? ''), overall: '', comments: [] };
  }

  function anchorFromOffsets(text, start, end) {
    if (typeof text !== 'string' || !Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start < 0 || end > text.length || start >= end) return null;
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (start >= end) return null;
    return {
      quote: text.slice(start, end),
      prefix: text.slice(Math.max(0, start - LIMITS.CONTEXT_CHARS), start),
      suffix: text.slice(end, end + LIMITS.CONTEXT_CHARS),
    };
  }

  function locate(text, anchor) {
    const quote = anchor?.quote;
    if (typeof text !== 'string' || typeof quote !== 'string' || !quote) return null;
    const prefix = typeof anchor.prefix === 'string' ? anchor.prefix : '';
    const suffix = typeof anchor.suffix === 'string' ? anchor.suffix : '';
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
      if (score === prefix.length + suffix.length) break;
    }
    return best;
  }

  function commentRefusal(draft, { quote, body, isNew }) {
    if (isNew && draft.comments.length >= LIMITS.MAX_COMMENTS) {
      return `A review holds at most ${LIMITS.MAX_COMMENTS} comments`;
    }
    if (typeof quote !== 'string' || !quote) return 'Select some text first';
    if (quote.length > LIMITS.MAX_QUOTE_CHARS) {
      return `The selection is too long to quote (limit ${LIMITS.MAX_QUOTE_CHARS} characters)`;
    }
    if (typeof body !== 'string' || !body.trim()) return 'Write a comment first';
    if (body.length > LIMITS.MAX_COMMENT_CHARS) {
      return `The comment is too long (limit ${LIMITS.MAX_COMMENT_CHARS} characters)`;
    }
    return '';
  }

  const isBoundedString = (value, max) => typeof value === 'string' && value.length <= max;

  function parseDraft(raw) {
    let data = raw;
    if (typeof raw === 'string') {
      try {
        data = JSON.parse(raw);
      } catch {
        return null;
      }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.v !== 1) return null;
    if (!isBoundedString(data.contentHash, 64) || !isBoundedString(data.overall, LIMITS.MAX_OVERALL_CHARS)) return null;
    if (!Array.isArray(data.comments) || data.comments.length > LIMITS.MAX_COMMENTS) return null;
    const ids = new Set();
    const comments = [];
    for (const c of data.comments) {
      if (!c || typeof c !== 'object') return null;
      if (!isBoundedString(c.id, 64) || !c.id || ids.has(c.id)) return null;
      if (!isBoundedString(c.quote, LIMITS.MAX_QUOTE_CHARS) || !c.quote) return null;
      if (!isBoundedString(c.prefix, LIMITS.CONTEXT_CHARS) || !isBoundedString(c.suffix, LIMITS.CONTEXT_CHARS))
        return null;
      if (!isBoundedString(c.heading, LIMITS.MAX_HEADING_CHARS)) return null;
      if (!isBoundedString(c.body, LIMITS.MAX_COMMENT_CHARS) || !c.body.trim()) return null;
      ids.add(c.id);
      comments.push({ id: c.id, quote: c.quote, prefix: c.prefix, suffix: c.suffix, heading: c.heading, body: c.body });
    }
    return { v: 1, contentHash: data.contentHash, overall: data.overall, comments };
  }

  function storageKey(sessionId, filePath) {
    return `${STORAGE_PREFIX}${sessionId}:${filePath}`;
  }

  function storageKeySession(key) {
    if (typeof key !== 'string' || !key.startsWith(STORAGE_PREFIX)) return null;
    const rest = key.slice(STORAGE_PREFIX.length);
    const colon = rest.indexOf(':');
    return colon > 0 ? rest.slice(0, colon) : null;
  }

  const oneLine = (value) =>
    String(value ?? '')
      .replace(CONTROL_CHARS, ' ')
      .replace(/ {2,}/g, ' ')
      .trim();
  const blockQuote = (value) =>
    String(value)
      .split(/\r?\n/)
      .map((line) => (line ? `> ${line}` : '>'))
      .join('\n');

  function formatFeedback({ filePath, verdict, draft, staleIds }) {
    const stale = new Set(staleIds || []);
    const out = [`# Review of ${oneLine(filePath)}`, ''];
    out.push(`Verdict: ${verdict === 'approved' ? 'approved' : 'changes requested'}`, '');
    if (draft.overall.trim()) out.push('## Overall', '', draft.overall.trim(), '');
    if (draft.comments.length) {
      out.push('## Comments', '');
      out.push('Each comment quotes the text it is about, then says what the reviewer wants.', '');
      draft.comments.forEach((comment, i) => {
        const heading = oneLine(comment.heading);
        out.push(`### ${i + 1}.${heading ? ` Under "${heading}"` : ''}`, '');
        out.push(blockQuote(comment.quote), '');
        if (stale.has(comment.id))
          out.push('(The document changed after this comment was written: the quoted text is no longer in it.)', '');
        out.push(comment.body.trim(), '');
      });
    }
    return out.join('\n');
  }

  function promptPath(value) {
    const path = oneLine(value);
    return path.length > LIMITS.PROMPT_PATH_CHARS ? `...${path.slice(-(LIMITS.PROMPT_PATH_CHARS - 3))}` : path;
  }

  /**
   * The one line submitted to the agent. Printable text only, so with its
   * trailing `\r` it is a plain prompt (isPlainPromptInput, route-helpers.ts)
   * and takes the server's paste-then-Enter path.
   */
  function promptLine({ filePath, feedbackPath, verdict, count }) {
    const file = promptPath(filePath);
    const feedback = promptPath(feedbackPath);
    const n = Number.isInteger(count) && count > 0 ? count : 0;
    const line =
      verdict === 'approved'
        ? `I reviewed ${file} and I approve it. My notes are in ${feedback}`
        : `I reviewed ${file} and I want changes. My feedback (${n} comment${n === 1 ? '' : 's'}) is in ${feedback} - read that file and address every point in it.`;
    return oneLine(line).slice(0, LIMITS.PROMPT_MAX_CHARS);
  }

  window.CodemanDocReview = {
    LIMITS,
    hashContent,
    emptyDraft,
    anchorFromOffsets,
    locate,
    commentRefusal,
    parseDraft,
    storageKey,
    storageKeySession,
    formatFeedback,
    promptLine,
  };
})();

// The pure core above loads alone in tests; the DOM half needs the app class.
if (typeof CodemanApp !== 'undefined') {
  // Viewer chrome inside the rendered document: copy buttons, Mermaid's status
  // line, summary and image. Their text comes and goes (Mermaid hydrates after
  // the render), so it is no part of the text an anchor is measured against.
  const DOC_REVIEW_SKIP = 'button, summary, .rv-code-actions, .rv-mermaid-status, .rv-mermaid-preview';
  const DOC_REVIEW_MARKDOWN_EXTS = new Set(['md', 'markdown']);

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  Object.assign(CodemanApp.prototype, {
    /**
     * Called at the end of `_updateFilePreviewToolbar` with the view it just
     * applied. Any toolbar update means the view changed under the review, so
     * an open review is torn down first; its draft is already in localStorage.
     */
    _syncDocReviewToolbar(view) {
      if (this._docReview) this._exitDocReview();
      const btn = this.$('filePreviewReviewBtn');
      if (!btn) return;
      const info = this.filePreviewText;
      // A bare attachment-card name has no path the agent could be pointed at.
      const reviewable =
        view === 'markdown' &&
        !!info &&
        DOC_REVIEW_MARKDOWN_EXTS.has(info.ext) &&
        !(info.attachmentId && !info.filePath.startsWith('/'));
      btn.hidden = !reviewable;
      btn.setAttribute('aria-pressed', 'false');
    },

    toggleDocReview() {
      if (this._docReview) this._exitDocReview();
      else this._enterDocReview();
    },

    _enterDocReview() {
      const core = window.CodemanDocReview;
      const info = this.filePreviewText;
      const bodyEl = this.$('filePreviewBody');
      const root = bodyEl?.querySelector(':scope > .file-preview-md');
      const host = bodyEl?.closest('.file-preview-window');
      if (!core || !info || !root || !host) return;
      const session = this.sessions?.get(info.sessionId);
      if (!session) {
        this.showToast(
          'This file belongs to a session that is no longer open, so there is no agent to send a review to',
          'error'
        );
        return;
      }
      if (session.remote) {
        this.showToast(
          'Review is not available for a remote session: the feedback file cannot be saved on the other machine',
          'error'
        );
        return;
      }

      const contentHash = core.hashContent(this.filePreviewContent || '');
      const key = core.storageKey(info.sessionId, info.filePath);
      this._pruneDocReviewDrafts();
      let stored = null;
      try {
        stored = core.parseDraft(localStorage.getItem(key));
      } catch {
        /* storage blocked: review still works for this page load */
      }
      const state = (this._docReview = {
        sessionId: info.sessionId,
        filePath: info.filePath,
        key,
        root,
        host,
        bodyEl,
        draft: stored || core.emptyDraft(contentHash),
        stale: new Set(),
        pending: null,
        composing: null,
        sending: false,
        uploaded: null,
        cleanup: [],
        selectionTimer: 0,
        floatPressedAt: 0,
      });
      const changed = !!stored && stored.contentHash !== contentHash;
      state.draft.contentHash = contentHash;

      this._buildDocReviewChrome(state);
      this._paintDocReviewMarks();
      this._renderDocReviewBar();
      host.classList.add('doc-review-on');
      this.$('filePreviewReviewBtn')?.setAttribute('aria-pressed', 'true');

      const listen = (target, type, handler, options) => {
        target.addEventListener(type, handler, options);
        state.cleanup.push(() => target.removeEventListener(type, handler, options));
      };
      // Touch selection never ends in a mouseup, so selectionchange is the one
      // signal both pointer kinds share; the timer waits out a handle drag.
      listen(document, 'selectionchange', () => {
        // A press on the Comment control may collapse a touch selection before
        // its click arrives; the control acts on the snapshot it already has.
        if (Date.now() - state.floatPressedAt < 800) return;
        clearTimeout(state.selectionTimer);
        state.selectionTimer = setTimeout(() => this._onDocReviewSelection(), 150);
      });
      listen(bodyEl, 'scroll', () => this._placeDocReviewFloat(), { passive: true });
      listen(window, 'resize', () => this._placeDocReviewFloat());
      // Capture, ahead of the Response Viewer delegate bound on the same body:
      // a tap on a highlight edits its comment and does nothing else.
      listen(
        bodyEl,
        'click',
        (event) => {
          const mark = event.target?.closest?.('mark.doc-review-mark');
          if (!mark || !state.root.contains(mark)) return;
          const selection = document.getSelection();
          if (selection && !selection.isCollapsed) return;
          event.preventDefault();
          event.stopPropagation();
          this._openDocReviewComposer({ id: mark.dataset.commentId });
        },
        true
      );
      // On window, so it runs before the document-level Escape handlers that
      // close the whole preview: Escape closes the composer first.
      listen(
        window,
        'keydown',
        (event) => {
          if (event.key !== 'Escape' || event.isComposing || !state.composing) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          this._closeDocReviewComposer();
        },
        true
      );

      if (state.stale.size) {
        const n = state.stale.size;
        this.showToast(
          `${changed ? 'The document changed since this draft. ' : ''}${n} comment${n === 1 ? '' : 's'} no longer match${n === 1 ? 'es' : ''} its text and will be sent marked "text changed"`,
          'info'
        );
      }
    },

    _exitDocReview() {
      const state = this._docReview;
      if (!state) return;
      this._docReview = null;
      clearTimeout(state.selectionTimer);
      for (const undo of state.cleanup) undo();
      state.float.remove();
      state.composer.remove();
      state.bar.remove();
      this._clearDocReviewMarks(state.root);
      state.host.classList.remove('doc-review-on', 'doc-review-composing');
      this.$('filePreviewReviewBtn')?.setAttribute('aria-pressed', 'false');
    },

    _buildDocReviewChrome(state) {
      const limits = window.CodemanDocReview.LIMITS;

      const float = el('button', 'doc-review-float', 'Comment');
      float.type = 'button';
      float.hidden = true;
      // Keep the selection (and, on a phone, its handles) through the press.
      float.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        clearTimeout(state.selectionTimer);
        state.floatPressedAt = Date.now();
      });
      float.addEventListener('mousedown', (event) => event.preventDefault());
      float.addEventListener('click', () => {
        if (state.pending)
          this._openDocReviewComposer({ anchor: state.pending.anchor, heading: state.pending.heading });
      });

      const composer = el('div', 'doc-review-composer');
      composer.hidden = true;
      const quote = el('div', 'doc-review-composer-quote');
      quote.setAttribute('data-i18n-skip', '');
      const input = el('textarea', 'doc-review-input');
      input.rows = 3;
      input.maxLength = limits.MAX_COMMENT_CHARS;
      input.placeholder = 'Your comment';
      input.setAttribute('aria-label', 'Comment');
      input.setAttribute('data-i18n-skip', '');
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          this._submitDocReviewComment();
        }
      });
      const composerActions = el('div', 'doc-review-actions');
      const deleteBtn = el('button', 'doc-review-btn doc-review-btn--danger', 'Delete');
      deleteBtn.type = 'button';
      deleteBtn.addEventListener('click', () => this._deleteDocReviewComment());
      const cancelBtn = el('button', 'doc-review-btn', 'Cancel');
      cancelBtn.type = 'button';
      cancelBtn.addEventListener('click', () => this._closeDocReviewComposer());
      const addBtn = el('button', 'doc-review-btn doc-review-btn--primary', 'Add');
      addBtn.type = 'button';
      addBtn.addEventListener('click', () => this._submitDocReviewComment());
      composerActions.append(deleteBtn, el('span', 'doc-review-spacer'), cancelBtn, addBtn);
      composer.append(quote, input, composerActions);

      const bar = el('div', 'doc-review-bar');
      const count = el('div', 'doc-review-count');
      const list = el('div', 'doc-review-list');
      const overall = el('textarea', 'doc-review-overall');
      overall.rows = 2;
      overall.maxLength = limits.MAX_OVERALL_CHARS;
      overall.placeholder = 'Overall note (optional)';
      overall.setAttribute('aria-label', 'Overall note');
      overall.setAttribute('data-i18n-skip', '');
      overall.value = state.draft.overall;
      overall.addEventListener('input', () => {
        state.draft.overall = overall.value;
        this._saveDocReviewDraft();
      });
      const barActions = el('div', 'doc-review-actions');
      const discardBtn = el('button', 'doc-review-btn', 'Discard');
      discardBtn.type = 'button';
      discardBtn.addEventListener('click', () => this._discardDocReview());
      const approveBtn = el('button', 'doc-review-btn', 'Approve');
      approveBtn.type = 'button';
      approveBtn.addEventListener('click', () => this._sendDocReview('approved'));
      const sendBtn = el('button', 'doc-review-btn doc-review-btn--primary', 'Send feedback');
      sendBtn.type = 'button';
      sendBtn.addEventListener('click', () => this._sendDocReview('changes'));
      barActions.append(discardBtn, el('span', 'doc-review-spacer'), approveBtn, sendBtn);
      bar.append(count, list, overall, barActions);

      state.bodyEl.after(composer, bar);
      state.host.appendChild(float);
      Object.assign(state, {
        float,
        composer,
        quote,
        input,
        deleteBtn,
        addBtn,
        bar,
        count,
        list,
        overall,
        approveBtn,
        sendBtn,
        discardBtn,
      });
    },

    _docReviewIndex(root) {
      const nodes = [];
      let text = '';
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement?.closest(DOC_REVIEW_SKIP)) continue;
        nodes.push({ node, start: text.length });
        text += node.data;
      }
      return { nodes, text };
    },

    _docReviewOffsets(range, index) {
      let start = -1;
      let end = -1;
      for (const { node, start: base } of index.nodes) {
        if (!range.intersectsNode(node)) continue;
        const from = node === range.startContainer ? range.startOffset : 0;
        const to = node === range.endContainer ? range.endOffset : node.length;
        if (start === -1) start = base + from;
        end = base + to;
      }
      return start === -1 || end <= start ? null : { start, end };
    },

    _docReviewHeading(root, range) {
      const max = window.CodemanDocReview.LIMITS.MAX_HEADING_CHARS;
      let found = '';
      for (const heading of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
        if (range.comparePoint(heading, 0) > 0) break;
        found = (heading.textContent || '').replace(/\s+/g, ' ').trim();
      }
      return found.slice(0, max);
    },

    _clearDocReviewMarks(root) {
      const marks = root.querySelectorAll('mark.doc-review-mark');
      if (!marks.length) return;
      for (const mark of marks) mark.replaceWith(...mark.childNodes);
      root.normalize();
    },

    /**
     * Wrap every comment's located text in `<mark>`s, one per text node it
     * crosses, and record the comments whose quote is gone. Splitting text
     * nodes leaves the review text unchanged, so each comment is located
     * against a fresh index of the same string.
     */
    _paintDocReviewMarks() {
      const state = this._docReview;
      if (!state) return;
      const core = window.CodemanDocReview;
      this._clearDocReviewMarks(state.root);
      state.stale = new Set();
      for (const comment of state.draft.comments) {
        const index = this._docReviewIndex(state.root);
        const hit = core.locate(index.text, comment);
        if (!hit) {
          state.stale.add(comment.id);
          continue;
        }
        for (let i = index.nodes.length - 1; i >= 0; i--) {
          const { node, start: base } = index.nodes[i];
          const from = Math.max(hit.start, base) - base;
          const to = Math.min(hit.end, base + node.length) - base;
          if (from >= to) continue;
          let target = node;
          if (to < target.length) target.splitText(to);
          if (from > 0) target = target.splitText(from);
          // Line breaks between blocks (list items, table rows): a <mark> there
          // would be an invalid child and has nothing to show.
          if (!target.data.trim() && target.data.includes('\n')) continue;
          const mark = document.createElement('mark');
          mark.className = 'doc-review-mark';
          mark.dataset.commentId = comment.id;
          target.parentNode.insertBefore(mark, target);
          mark.appendChild(target);
        }
      }
    },

    _onDocReviewSelection() {
      const state = this._docReview;
      if (!state) return;
      const selection = document.getSelection();
      const range = selection && selection.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0) : null;
      if (!range || !state.root.contains(range.commonAncestorContainer)) {
        state.pending = null;
        state.float.hidden = true;
        return;
      }
      const index = this._docReviewIndex(state.root);
      const offsets = this._docReviewOffsets(range, index);
      const anchor = offsets && window.CodemanDocReview.anchorFromOffsets(index.text, offsets.start, offsets.end);
      if (!anchor) {
        state.pending = null;
        state.float.hidden = true;
        return;
      }
      state.pending = { anchor, heading: this._docReviewHeading(state.root, range), range };
      state.float.hidden = false;
      this._placeDocReviewFloat();
    },

    /**
     * Put the Comment control just past the END of the selection, inside the
     * preview body. On a touch screen it sits further down, clear of the
     * selection handle; the platform's own callout opens above the selection.
     */
    _placeDocReviewFloat() {
      const state = this._docReview;
      if (!state || state.float.hidden || !state.pending) return;
      const rects = state.pending.range.getClientRects();
      const last = rects.length ? rects[rects.length - 1] : state.pending.range.getBoundingClientRect();
      const first = rects.length ? rects[0] : last;
      const body = state.bodyEl.getBoundingClientRect();
      const host = state.host.getBoundingClientRect();
      const width = state.float.offsetWidth;
      const height = state.float.offsetHeight;
      const gap = window.matchMedia?.('(pointer: coarse)').matches ? 28 : 6;
      let top = last.bottom + gap;
      if (top + height > body.bottom - 4) top = first.top - height - gap;
      top = Math.min(Math.max(top, body.top + 4), body.bottom - height - 4);
      const left = Math.min(Math.max(last.right - width / 2, body.left + 4), body.right - width - 4);
      state.float.style.top = `${Math.round(top - host.top)}px`;
      state.float.style.left = `${Math.round(left - host.left)}px`;
    },

    _openDocReviewComposer(target) {
      const state = this._docReview;
      if (!state || state.sending) return;
      const existing = target.id ? state.draft.comments.find((c) => c.id === target.id) : null;
      if (target.id && !existing) return;
      state.composing = existing ? { id: existing.id } : { anchor: target.anchor, heading: target.heading };
      const quote = existing ? existing.quote : target.anchor.quote;
      state.quote.textContent = quote.length > 240 ? `${quote.slice(0, 240)}...` : quote;
      state.input.value = existing ? existing.body : '';
      state.addBtn.textContent = existing ? 'Save' : 'Add';
      state.deleteBtn.hidden = !existing;
      state.composer.hidden = false;
      state.host.classList.add('doc-review-composing');
      state.pending = null;
      state.float.hidden = true;
      document.getSelection()?.removeAllRanges();
      state.input.focus();
    },

    _closeDocReviewComposer() {
      const state = this._docReview;
      if (!state) return;
      state.composing = null;
      state.composer.hidden = true;
      state.input.value = '';
      state.host.classList.remove('doc-review-composing');
    },

    _submitDocReviewComment() {
      const state = this._docReview;
      const composing = state?.composing;
      if (!composing) return;
      const core = window.CodemanDocReview;
      const body = state.input.value.trim();
      const existing = composing.id ? state.draft.comments.find((c) => c.id === composing.id) : null;
      const quote = existing ? existing.quote : composing.anchor.quote;
      const refusal = core.commentRefusal(state.draft, { quote, body, isNew: !existing });
      if (refusal) {
        this.showToast(refusal, 'error');
        return;
      }
      if (existing) existing.body = body;
      else {
        const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        state.draft.comments.push({ id, ...composing.anchor, heading: composing.heading || '', body });
      }
      this._commitDocReviewDraft();
      this._closeDocReviewComposer();
    },

    _deleteDocReviewComment() {
      const state = this._docReview;
      const id = state?.composing?.id;
      if (!id) return;
      state.draft.comments = state.draft.comments.filter((c) => c.id !== id);
      this._commitDocReviewDraft();
      this._closeDocReviewComposer();
    },

    _commitDocReviewDraft() {
      const state = this._docReview;
      if (!state) return;
      // In document order, so the list and the feedback file read top to bottom;
      // comments whose text is gone keep their place at the end.
      const text = this._docReviewIndex(state.root).text;
      const at = new Map(
        state.draft.comments.map((c) => [
          c.id,
          window.CodemanDocReview.locate(text, c)?.start ?? Number.MAX_SAFE_INTEGER,
        ])
      );
      state.draft.comments.sort((a, b) => at.get(a.id) - at.get(b.id));
      this._saveDocReviewDraft();
      this._paintDocReviewMarks();
      this._renderDocReviewBar();
    },

    _renderDocReviewBar() {
      const state = this._docReview;
      if (!state) return;
      const comments = state.draft.comments;
      state.count.textContent = comments.length
        ? `${comments.length} comment${comments.length === 1 ? '' : 's'}`
        : 'Select text in the document to comment on it';
      const rows = comments.map((comment) => {
        const row = el('button', 'doc-review-item');
        row.type = 'button';
        const quote = el(
          'span',
          'doc-review-item-quote',
          comment.quote.length > 120 ? `${comment.quote.slice(0, 120)}...` : comment.quote
        );
        quote.setAttribute('data-i18n-skip', '');
        const body = el('span', 'doc-review-item-body', comment.body);
        body.setAttribute('data-i18n-skip', '');
        row.append(quote, body);
        if (state.stale.has(comment.id)) row.append(el('span', 'doc-review-item-stale', 'text changed'));
        row.addEventListener('click', () => {
          [...state.root.querySelectorAll('mark.doc-review-mark')]
            .find((mark) => mark.dataset.commentId === comment.id)
            ?.scrollIntoView({ block: 'center' });
          this._openDocReviewComposer({ id: comment.id });
        });
        return row;
      });
      state.list.replaceChildren(...rows);
      state.list.hidden = !rows.length;
    },

    _saveDocReviewDraft() {
      const state = this._docReview;
      if (!state) return;
      // The feedback text changed, so a file uploaded by a failed send is stale.
      state.uploaded = null;
      try {
        if (state.draft.comments.length || state.draft.overall.trim()) {
          localStorage.setItem(state.key, JSON.stringify(state.draft));
        } else {
          localStorage.removeItem(state.key);
        }
      } catch {
        /* storage blocked or full: the draft lives for this page load only */
      }
    },

    _pruneDocReviewDrafts() {
      if (!this.sessions?.size) return;
      try {
        const dead = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          const sessionId = window.CodemanDocReview.storageKeySession(key);
          if (sessionId && !this.sessions.has(sessionId)) dead.push(key);
        }
        for (const key of dead) localStorage.removeItem(key);
      } catch {
        /* storage blocked */
      }
    },

    _discardDocReview() {
      const state = this._docReview;
      if (!state || state.sending) return;
      const hasContent = state.draft.comments.length || state.draft.overall.trim();
      if (hasContent && !confirm('Discard this review and its comments?')) return;
      try {
        localStorage.removeItem(state.key);
      } catch {
        /* storage blocked */
      }
      this._exitDocReview();
    },

    async _sendDocReview(verdict) {
      const state = this._docReview;
      if (!state || state.sending) return;
      const core = window.CodemanDocReview;
      const { draft } = state;
      if (verdict !== 'approved' && !draft.comments.length && !draft.overall.trim()) {
        this.showToast('Add a comment or an overall note first', 'info');
        return;
      }
      if (!this.sessions?.has(state.sessionId)) {
        this.showToast('That session is no longer open; the review was kept', 'error');
        return;
      }
      const sentDraft = JSON.stringify(draft);
      const count = draft.comments.length;
      state.sending = true;
      for (const btn of [state.sendBtn, state.approveBtn, state.discardBtn]) btn.disabled = true;
      try {
        const text = core.formatFeedback({ filePath: state.filePath, verdict, draft, staleIds: [...state.stale] });
        if (state.uploaded?.text !== text) {
          const base = (state.filePath.split('/').pop() || 'document').replace(/\.(md|markdown)$/i, '');
          const file = new File([text], `review-${base}.md`, { type: 'text/markdown' });
          state.uploaded = { text, path: await this._uploadPasteImage(state.sessionId, file) };
        }
        const line = core.promptLine({
          filePath: state.filePath,
          feedbackPath: state.uploaded.path,
          verdict,
          count,
        });
        await this._submitDocReviewPrompt(state.sessionId, `${line}\r`);
      } catch (err) {
        if (this._docReview === state) {
          state.sending = false;
          for (const btn of [state.sendBtn, state.approveBtn, state.discardBtn]) btn.disabled = false;
        }
        this.showToast(`Review not sent: ${err?.message || 'request failed'}. Your comments were kept.`, 'error');
        return;
      }
      try {
        if (localStorage.getItem(state.key) === sentDraft) localStorage.removeItem(state.key);
      } catch {
        /* storage blocked */
      }
      const current = this._docReview;
      const newerDraft = current?.key === state.key && JSON.stringify(current.draft) !== sentDraft;
      if (current === state) {
        state.sending = false;
        for (const btn of [state.sendBtn, state.approveBtn, state.discardBtn]) btn.disabled = false;
        if (!newerDraft) this._exitDocReview();
      }
      const message = verdict === 'approved' ? 'Approval sent to the agent' : 'Feedback sent to the agent';
      this.showToast(newerDraft ? `${message}. Your newer edits were kept as a draft.` : message, 'success');
    },

    /**
     * POST the prompt and wait for the answer. No `useMux`: for a plain prompt
     * the server then takes its awaited paste-then-Enter path and answers only
     * once Enter has gone out, where an explicit `useMux: true` answers before
     * the write and could not report a failure.
     */
    async _submitDocReviewPrompt(sessionId, input) {
      const res = await fetch(`/api/sessions/${sessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.success === false) throw new Error(data?.error || `HTTP ${res.status}`);
    },
  });
}
