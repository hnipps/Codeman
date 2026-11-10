/** Document review behavior using the real module in JSDOM. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/doc-review.js'), 'utf8');

type Anchor = { quote: string; prefix: string; suffix: string };
type Comment = Anchor & { id: string; heading: string; body: string };
type Draft = { v: 1; contentHash: string; overall: string; comments: Comment[] };
type Core = {
  LIMITS: Record<string, number>;
  hashContent: (text: string) => string;
  emptyDraft: (hash: string) => Draft;
  anchorFromOffsets: (text: string, start: number, end: number) => Anchor | null;
  locate: (text: string, anchor: Anchor) => { start: number; end: number } | null;
  commentRefusal: (draft: Draft, c: { quote: string; body: string; isNew: boolean }) => string;
  parseDraft: (raw: unknown) => Draft | null;
  storageKey: (sessionId: string, filePath: string) => string;
  formatFeedback: (o: { filePath: string; verdict: string; draft: Draft; staleIds?: string[] }) => string;
  promptLine: (o: { filePath: string; feedbackPath: string; verdict: string; count: number }) => string;
};

function loadCore(): Core {
  const context = vm.createContext({ window: {} });
  vm.runInContext(source, context, { filename: 'doc-review.js' });
  return (context.window as { CodemanDocReview: Core }).CodemanDocReview;
}

const comment = (over: Partial<Comment> = {}): Comment => ({
  id: 'c1',
  quote: 'the cache',
  prefix: 'Flush ',
  suffix: ' first',
  heading: 'Plan',
  body: 'Which cache?',
  ...over,
});

describe('CodemanDocReview (pure)', () => {
  const core = loadCore();

  it('locates the text an anchor was made from', () => {
    const text = 'Intro paragraph.\nStep one: flush the cache first, then restart.';
    const start = text.indexOf('flush the cache');
    const anchor = core.anchorFromOffsets(text, start, start + 'flush the cache'.length)!;
    expect(anchor.quote).toBe('flush the cache');
    expect(anchor.prefix.length).toBeLessThanOrEqual(core.LIMITS.CONTEXT_CHARS);
    expect(anchor.suffix.length).toBeLessThanOrEqual(core.LIMITS.CONTEXT_CHARS);
    expect(core.locate(text, anchor)).toEqual({ start, end: start + 'flush the cache'.length });
  });

  it('trims surrounding whitespace off the quote and refuses an empty range', () => {
    const text = 'alpha   beta\n\ngamma';
    expect(core.anchorFromOffsets(text, 5, 14)!.quote).toBe('beta');
    expect(core.anchorFromOffsets(text, 5, 8)).toBeNull();
    expect(core.anchorFromOffsets(text, 3, 3)).toBeNull();
    expect(core.anchorFromOffsets(text, -1, 4)).toBeNull();
    expect(core.anchorFromOffsets(text, 0, text.length + 1)).toBeNull();
  });

  it('picks the occurrence whose surrounding text agrees', () => {
    const text = 'First: restart the server now. Later: restart the server again.';
    const second = text.lastIndexOf('restart the server');
    const anchor = core.anchorFromOffsets(text, second, second + 'restart the server'.length)!;
    expect(core.locate(text, anchor)!.start).toBe(second);
    // The document gained a paragraph above: offsets moved, the context did not.
    const moved = `A new opening paragraph. ${text}`;
    expect(core.locate(moved, anchor)!.start).toBe(moved.lastIndexOf('restart the server'));
    const first = core.anchorFromOffsets(text, 7, 7 + 'restart the server'.length)!;
    expect(core.locate(moved, first)!.start).toBe(moved.indexOf('restart the server'));
  });

  it('locates nowhere once the quote is gone', () => {
    expect(core.locate('The plan now says something else.', comment())).toBeNull();
    expect(core.locate('anything', { quote: '', prefix: '', suffix: '' })).toBeNull();
  });

  it('refuses past the limits instead of shortening', () => {
    const draft = core.emptyDraft('h');
    expect(core.commentRefusal(draft, { quote: 'q', body: 'b', isNew: true })).toBe('');
    expect(core.commentRefusal(draft, { quote: 'q', body: '   ', isNew: true })).not.toBe('');
    expect(
      core.commentRefusal(draft, { quote: 'q', body: 'x'.repeat(core.LIMITS.MAX_COMMENT_CHARS + 1), isNew: true })
    ).toContain(String(core.LIMITS.MAX_COMMENT_CHARS));
    expect(
      core.commentRefusal(draft, { quote: 'x'.repeat(core.LIMITS.MAX_QUOTE_CHARS + 1), body: 'b', isNew: true })
    ).toContain(String(core.LIMITS.MAX_QUOTE_CHARS));
    draft.comments = Array.from({ length: core.LIMITS.MAX_COMMENTS }, (_, i) => comment({ id: `c${i}` }));
    expect(core.commentRefusal(draft, { quote: 'q', body: 'b', isNew: true })).toContain(
      String(core.LIMITS.MAX_COMMENTS)
    );
    // Editing a comment of a full review is still allowed.
    expect(core.commentRefusal(draft, { quote: 'q', body: 'b', isNew: false })).toBe('');
  });

  it('parses a stored draft and rejects anything malformed', () => {
    const draft: Draft = { v: 1, contentHash: 'abc-3', overall: 'Looks close.', comments: [comment()] };
    expect(core.parseDraft(JSON.stringify(draft))).toEqual(draft);
    // Unknown fields do not ride along.
    const extra = { ...draft, comments: [{ ...comment(), onclick: 'x' }], extra: 1 };
    expect(core.parseDraft(JSON.stringify(extra))).toEqual(draft);

    const bad: unknown[] = [
      null,
      undefined,
      '',
      '{not json',
      '[]',
      JSON.stringify({ ...draft, v: 2 }),
      JSON.stringify({ ...draft, overall: 5 }),
      JSON.stringify({ ...draft, contentHash: null }),
      JSON.stringify({ ...draft, comments: 'none' }),
      JSON.stringify({ ...draft, comments: [null] }),
      JSON.stringify({ ...draft, comments: [comment({ quote: '' })] }),
      JSON.stringify({ ...draft, comments: [comment({ body: '  ' })] }),
      JSON.stringify({ ...draft, comments: [{ ...comment(), prefix: undefined }] }),
      JSON.stringify({ ...draft, comments: [comment(), comment()] }),
      JSON.stringify({ ...draft, comments: [comment({ prefix: 'x'.repeat(core.LIMITS.CONTEXT_CHARS + 1) })] }),
      JSON.stringify({ ...draft, comments: [comment({ body: 'x'.repeat(core.LIMITS.MAX_COMMENT_CHARS + 1) })] }),
      JSON.stringify({
        ...draft,
        comments: Array.from({ length: core.LIMITS.MAX_COMMENTS + 1 }, (_, i) => comment({ id: `c${i}` })),
      }),
    ];
    for (const raw of bad) expect(core.parseDraft(raw), String(raw).slice(0, 60)).toBeNull();
  });

  it('keys a draft by session and file, and notices changed content', () => {
    expect(core.storageKey('s1', 'docs/plan.md')).not.toBe(core.storageKey('s2', 'docs/plan.md'));
    expect(core.storageKey('s1', 'docs/plan.md')).not.toBe(core.storageKey('s1', 'docs/other.md'));
    expect(core.hashContent('# Plan\n')).toBe(core.hashContent('# Plan\n'));
    expect(core.hashContent('# Plan\n')).not.toBe(core.hashContent('# Plan B\n'));
  });

  it('writes the feedback file: verdict, overall note, each quote with its comment', () => {
    const draft: Draft = {
      v: 1,
      contentHash: 'h',
      overall: '  Close, two things to fix.  ',
      comments: [
        comment(),
        comment({ id: 'c2', quote: 'line one\nline two', heading: '', body: 'Split this up.' }),
        comment({ id: 'c3', quote: 'old wording', heading: 'Rollout', body: 'Still relevant?' }),
      ],
    };
    const text = core.formatFeedback({ filePath: 'docs/plan.md', verdict: 'changes', draft, staleIds: ['c3'] });
    expect(text).toContain('# Review of docs/plan.md');
    expect(text).toContain('Verdict: changes requested');
    expect(text).toContain('## Overall\n\nClose, two things to fix.\n');
    expect(text).toContain('### 1. Under "Plan"\n\n> the cache\n\nWhich cache?');
    expect(text).toContain('### 2.\n\n> line one\n> line two\n\nSplit this up.');
    const third = text.slice(text.indexOf('### 3.'));
    expect(third).toContain('> old wording');
    expect(third).toContain('no longer in it');
    expect(third).toContain('Still relevant?');
    expect(text.slice(0, text.indexOf('### 3.'))).not.toContain('no longer in it');

    const approved = core.formatFeedback({
      filePath: 'docs/plan.md',
      verdict: 'approved',
      draft: core.emptyDraft('h'),
    });
    expect(approved).toContain('Verdict: approved');
    expect(approved).not.toContain('## Comments');
    expect(approved).not.toContain('## Overall');
  });

  it('builds one line of printable text for the prompt', () => {
    const line = core.promptLine({
      filePath: 'docs/plan.md',
      feedbackPath: '/work/app/.codeman-uploads/review-plan.md',
      verdict: 'changes',
      count: 3,
    });
    expect(line).toContain('docs/plan.md');
    expect(line).toContain('/work/app/.codeman-uploads/review-plan.md');
    expect(line).toContain('3 comments');
    expect(core.promptLine({ filePath: 'a.md', feedbackPath: '/u/r.md', verdict: 'changes', count: 1 })).toContain(
      '1 comment)'
    );
    expect(core.promptLine({ filePath: 'a.md', feedbackPath: '/u/r.md', verdict: 'approved', count: 0 })).toContain(
      'approve'
    );

    const hostile = core.promptLine({
      filePath: 'docs/pl\r\nan\x1b[201~\x00\u0085\u2028.md',
      feedbackPath: '/u/\x03review\t.md\x7f',
      verdict: 'changes',
      count: 2,
    });
    // The server's own test for a plain prompt (isPlainPromptInput), minus the `\r`.
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    expect(hostile).toMatch(/^[^\x00-\x1f\x7f-\x9f\u2028\u2029]+$/);

    const long = core.promptLine({
      filePath: `${'deep/'.repeat(2000)}plan.md`,
      feedbackPath: `/u/${'x'.repeat(5000)}.md`,
      verdict: 'changes',
      count: 1,
    });
    expect(long.length).toBeLessThanOrEqual(core.LIMITS.PROMPT_MAX_CHARS);
    // A clipped path keeps its tail, which is the part that names the file.
    expect(long).toContain('plan.md');
  });
});

describe('doc-review.js (static)', () => {
  it('never assigns markup built from text', () => {
    expect(source).not.toMatch(/\.(innerHTML|outerHTML)\s*[+]?=/);
    expect(source).not.toMatch(/insertAdjacentHTML|document\.write/);
  });
});

const DOC_HTML =
  '<h1>Plan</h1><p>Flush the cache first, then <strong>restart</strong> the server.</p>' +
  '<div class="rv-code-wrap"><div class="rv-code-actions"><button class="rv-copy-btn">Copy</button></div>' +
  '<pre><code>npm run build</code></pre></div>' +
  '<h2>Rollout</h2><ul>\n<li>Ship to staging</li>\n<li>Ship to production</li>\n</ul>';

function mount(opts: { stored?: Draft; remote?: boolean; filePath?: string; attachmentId?: string } = {}) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><div class="file-preview-window">
       <button id="filePreviewReviewBtn" hidden></button>
       <div id="filePreviewBody"><div class="rv-text file-preview-md" data-i18n-skip>${DOC_HTML}</div></div>
       <div id="filePreviewFooter"></div></div></body></html>`,
    { url: 'http://localhost/' }
  );
  const { window } = dom;
  const { document } = window;
  // jsdom has no layout: nothing scrolls, and a Range has no rects to place the control by.
  window.Element.prototype.scrollIntoView = () => {};
  window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  window.Range.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0 }) as DOMRect;

  const CodemanApp = function CodemanApp(this: unknown) {} as unknown as new () => Record<string, any>;
  const fetchMock = vi.fn(async (_url: string, _init?: { body?: string }) => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  }));
  const context = vm.createContext({
    CodemanApp,
    window,
    document,
    localStorage: window.localStorage,
    NodeFilter: window.NodeFilter,
    // Node's File: jsdom's has no text() to read the upload back with.
    File,
    setTimeout,
    clearTimeout,
    confirm: () => true,
    fetch: fetchMock,
  });
  vm.runInContext(source, context, { filename: 'doc-review.js' });
  const core = (window as unknown as { CodemanDocReview: Core }).CodemanDocReview;

  const filePath = opts.filePath ?? 'docs/plan.md';
  const app = new CodemanApp();
  app.$ = (id: string) => document.getElementById(id);
  app.showToast = vi.fn();
  app.sessions = new Map([['sess-preview', opts.remote ? { remote: { host: 'h' } } : {}]]);
  app.activeSessionId = 'sess-active';
  app.filePreviewContent = '# Plan\n';
  app.filePreviewText = { ext: 'md', sessionId: 'sess-preview', filePath, attachmentId: opts.attachmentId };
  app._uploadPasteImage = vi.fn(async () => '/work/app/.codeman-uploads/review-plan.md');
  const key = core.storageKey('sess-preview', filePath);
  if (opts.stored) window.localStorage.setItem(key, JSON.stringify(opts.stored));

  const root = document.querySelector('.file-preview-md') as HTMLElement;
  const q = (selector: string) => document.querySelector(selector) as HTMLElement | null;
  return { app, core, window, document, root, key, fetchMock, q };
}

function selectText(m: ReturnType<typeof mount>, needle: string) {
  const walker = m.document.createTreeWalker(m.root, m.window.NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = (node as Text).data.indexOf(needle);
    if (at === -1) continue;
    const range = m.document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + needle.length);
    const selection = m.document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    m.app._onDocReviewSelection();
    return;
  }
  throw new Error(`"${needle}" is not inside one text node`);
}

function addComment(m: ReturnType<typeof mount>, needle: string, body: string) {
  selectText(m, needle);
  m.q('.doc-review-float')!.click();
  (m.q('.doc-review-input') as HTMLTextAreaElement).value = body;
  (m.document.querySelector('.doc-review-composer .doc-review-btn--primary') as HTMLElement).click();
}

describe('document review in the file preview', () => {
  it('offers Review on a rendered document with a path, and nowhere else', () => {
    const m = mount();
    const btn = m.q('#filePreviewReviewBtn')!;
    m.app._syncDocReviewToolbar('markdown');
    expect(btn.hidden).toBe(false);
    for (const view of ['text', 'none', 'page']) {
      m.app._syncDocReviewToolbar(view);
      expect(btn.hidden, view).toBe(true);
    }
    // An attachment card's bare name has no path to point the agent at.
    const bare = mount({ filePath: 'plan.md', attachmentId: 'att-1' });
    bare.app._syncDocReviewToolbar('markdown');
    expect(bare.q('#filePreviewReviewBtn')!.hidden).toBe(true);
    const absolute = mount({ filePath: '/srv/notes/plan.md', attachmentId: 'att-1' });
    absolute.app._syncDocReviewToolbar('markdown');
    expect(absolute.q('#filePreviewReviewBtn')!.hidden).toBe(false);
  });

  it('refuses a remote session with a message', () => {
    const m = mount({ remote: true });
    m.app.toggleDocReview();
    expect(m.q('.doc-review-bar')).toBeNull();
    expect(m.app.showToast).toHaveBeenCalledWith(expect.stringContaining('remote'), 'error');
  });

  it('adds a comment on selected text, highlights it and stores the draft', () => {
    const m = mount();
    const before = m.root.textContent;
    m.app.toggleDocReview();
    expect(m.q('#filePreviewReviewBtn')!.getAttribute('aria-pressed')).toBe('true');
    expect(m.q('.doc-review-float')!.hidden).toBe(true);

    selectText(m, 'the cache');
    expect(m.q('.doc-review-float')!.hidden).toBe(false);
    m.q('.doc-review-float')!.click();
    expect(m.q('.doc-review-composer')!.hidden).toBe(false);
    expect(m.q('.doc-review-composer-quote')!.textContent).toBe('the cache');
    (m.q('.doc-review-input') as HTMLTextAreaElement).value = 'Which <b>cache</b>?';
    (m.document.querySelector('.doc-review-composer .doc-review-btn--primary') as HTMLElement).click();

    const marks = m.root.querySelectorAll('mark.doc-review-mark');
    expect([...marks].map((mark) => mark.textContent)).toEqual(['the cache']);
    expect(m.root.textContent).toBe(before);
    expect(m.q('.doc-review-composer')!.hidden).toBe(true);
    expect(m.q('.doc-review-count')!.textContent).toBe('1 comment');
    // The comment reads as text, markup included, and is kept from the translator.
    const body = m.q('.doc-review-item-body')!;
    expect(body.textContent).toBe('Which <b>cache</b>?');
    expect(body.children.length).toBe(0);
    expect(body.hasAttribute('data-i18n-skip')).toBe(true);
    expect(m.q('.doc-review-item-quote')!.hasAttribute('data-i18n-skip')).toBe(true);

    const stored = m.core.parseDraft(m.window.localStorage.getItem(m.key))!;
    expect(stored.comments).toHaveLength(1);
    expect(stored.comments[0]).toMatchObject({ quote: 'the cache', heading: 'Plan', body: 'Which <b>cache</b>?' });
  });

  it('highlights across elements and blocks one text node at a time, leaving chrome alone', () => {
    const m = mount();
    const before = m.root.innerHTML;
    const text = m.root.textContent!;
    m.app.toggleDocReview();
    const index = m.app._docReviewIndex(m.root);
    // Viewer chrome (the code block's Copy button) is no part of the review text.
    expect(index.text).not.toContain('Copy');
    const start = index.text.indexOf('then ');
    const end = index.text.indexOf('Ship to production') + 'Ship to'.length;
    const anchor = m.core.anchorFromOffsets(index.text, start, end)!;
    m.app._openDocReviewComposer({ anchor, heading: 'Plan' });
    (m.q('.doc-review-input') as HTMLTextAreaElement).value = 'Too much in one step';
    (m.document.querySelector('.doc-review-composer .doc-review-btn--primary') as HTMLElement).click();

    const marks = [...m.root.querySelectorAll('mark.doc-review-mark')];
    expect(marks.length).toBeGreaterThan(3);
    expect(marks.map((mark) => mark.textContent).join('')).toBe(anchor.quote.replace(/\n/g, ''));
    expect(m.root.querySelector('button mark, ul > mark')).toBeNull();
    expect(m.root.querySelector('.rv-copy-btn')!.textContent).toBe('Copy');
    expect(m.root.textContent).toBe(text);

    // Leaving Review puts the document back exactly as it was rendered.
    m.app.toggleDocReview();
    expect(m.root.innerHTML).toBe(before);
    expect(m.q('.doc-review-bar')).toBeNull();
    expect(m.q('.doc-review-float')).toBeNull();
    expect(m.q('#filePreviewReviewBtn')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('edits and deletes a comment from its highlight', () => {
    const m = mount();
    m.app.toggleDocReview();
    addComment(m, 'the cache', 'first');
    (m.root.querySelector('mark.doc-review-mark') as HTMLElement).click();
    const input = m.q('.doc-review-input') as HTMLTextAreaElement;
    expect(input.value).toBe('first');
    input.value = 'second';
    (m.document.querySelector('.doc-review-composer .doc-review-btn--primary') as HTMLElement).click();
    expect(m.q('.doc-review-item-body')!.textContent).toBe('second');

    m.q('.doc-review-item')!.click();
    (m.document.querySelector('.doc-review-composer .doc-review-btn--danger') as HTMLElement).click();
    expect(m.root.querySelector('mark.doc-review-mark')).toBeNull();
    expect(m.q('.doc-review-item')).toBeNull();
    expect(m.window.localStorage.getItem(m.key)).toBeNull();
  });

  it('closes the composer on Escape before anything else sees the key', () => {
    const m = mount();
    m.app.toggleDocReview();
    selectText(m, 'the cache');
    m.q('.doc-review-float')!.click();
    const later = vi.fn();
    m.document.addEventListener('keydown', later, true);
    m.document.body.dispatchEvent(new m.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(m.q('.doc-review-composer')!.hidden).toBe(true);
    expect(later).not.toHaveBeenCalled();
    // With no composer open the key is not this module's to take.
    m.document.body.dispatchEvent(new m.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('restores a draft, and keeps a comment whose text is gone as "text changed"', () => {
    const stored: Draft = {
      v: 1,
      contentHash: 'older',
      overall: 'Nearly there',
      comments: [
        comment({ id: 'kept', prefix: 'Flush ', suffix: ' first' }),
        comment({ id: 'gone', quote: 'old wording' }),
      ],
    };
    const m = mount({ stored });
    m.app.toggleDocReview();
    expect((m.q('.doc-review-overall') as HTMLTextAreaElement).value).toBe('Nearly there');
    expect(m.root.querySelectorAll('mark.doc-review-mark')).toHaveLength(1);
    const rows = [...m.document.querySelectorAll('.doc-review-item')];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.doc-review-item-stale')).toBeNull();
    expect(rows[1].querySelector('.doc-review-item-stale')!.textContent).toBe('text changed');
    expect(m.app.showToast).toHaveBeenCalledWith(expect.stringContaining('text changed'), 'info');
  });

  it('opens restored comments whose ids contain selector characters', () => {
    const m = mount({
      stored: { v: 1, contentHash: 'h', overall: '', comments: [comment({ id: 'quote"[id]' })] },
    });
    m.app.toggleDocReview();
    m.q('.doc-review-item')!.click();
    expect((m.q('.doc-review-input') as HTMLTextAreaElement).value).toBe('Which cache?');
    expect(m.q('.doc-review-composer')!.hidden).toBe(false);
  });

  it('tears down when the view changes and keeps the draft', () => {
    const m = mount();
    m.app.toggleDocReview();
    addComment(m, 'the cache', 'note');
    const removed = vi.spyOn(m.document, 'removeEventListener');
    m.app._syncDocReviewToolbar('text');
    expect(m.app._docReview).toBeNull();
    expect(m.q('.doc-review-bar')).toBeNull();
    expect(m.q('.doc-review-composer')).toBeNull();
    expect(m.q('.doc-review-float')).toBeNull();
    expect(m.root.querySelector('mark')).toBeNull();
    expect(removed).toHaveBeenCalledWith('selectionchange', expect.any(Function), undefined);
    expect(m.core.parseDraft(m.window.localStorage.getItem(m.key))!.comments).toHaveLength(1);
  });

  it("sends the feedback file and one plain prompt to the preview's session, then clears the draft", async () => {
    const m = mount();
    m.app.toggleDocReview();
    addComment(m, 'the cache', 'Which cache?');
    const overall = m.q('.doc-review-overall') as HTMLTextAreaElement;
    overall.value = 'Close.';
    overall.dispatchEvent(new m.window.Event('input'));
    expect(m.fetchMock).not.toHaveBeenCalled();

    await m.app._sendDocReview('changes');

    expect(m.app._uploadPasteImage).toHaveBeenCalledTimes(1);
    const [sessionId, file] = m.app._uploadPasteImage.mock.calls[0];
    expect(sessionId).toBe('sess-preview');
    expect(file.name).toBe('review-plan.md');
    const text = await file.text();
    expect(text).toContain('Verdict: changes requested');
    expect(text).toContain('> the cache');
    expect(text).toContain('Which cache?');
    expect(text).toContain('Close.');

    expect(m.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = m.fetchMock.mock.calls[0];
    expect(url).toBe('/api/sessions/sess-preview/input');
    const sent = JSON.parse(init!.body!);
    expect(Object.keys(sent)).toEqual(['input']);
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    expect(sent.input).toMatch(/^[^\x00-\x1f\x7f-\x9f]+\r$/);
    expect(sent.input).toContain('docs/plan.md');
    expect(sent.input).toContain('/work/app/.codeman-uploads/review-plan.md');

    expect(m.window.localStorage.getItem(m.key)).toBeNull();
    expect(m.app._docReview).toBeNull();
    expect(m.root.querySelector('mark')).toBeNull();
    expect(m.app.showToast).toHaveBeenLastCalledWith(expect.stringContaining('sent'), 'success');
  });

  it('keeps edits made while feedback uploads and sends the original snapshot', async () => {
    const m = mount();
    m.app.toggleDocReview();
    addComment(m, 'the cache', 'Which cache?');
    const upload = Promise.withResolvers<string>();
    m.app._uploadPasteImage.mockReturnValueOnce(upload.promise);
    const sending = m.app._sendDocReview('changes');
    const overall = m.q('.doc-review-overall') as HTMLTextAreaElement;
    overall.value = 'One more point after Send.';
    overall.dispatchEvent(new m.window.Event('input'));
    upload.resolve('/work/app/.codeman-uploads/review-plan.md');
    await sending;

    const uploaded = await m.app._uploadPasteImage.mock.calls[0][1].text();
    expect(uploaded).not.toContain('One more point after Send.');
    expect(m.core.parseDraft(m.window.localStorage.getItem(m.key))!.overall).toBe('One more point after Send.');
    expect(m.q('.doc-review-bar')).not.toBeNull();
    expect((m.document.querySelector('.doc-review-bar .doc-review-btn--primary') as HTMLButtonElement).disabled).toBe(
      false
    );
    expect(m.app.showToast).toHaveBeenLastCalledWith(expect.stringContaining('newer edits were kept'), 'success');

    await m.app._sendDocReview('changes');
    expect(m.app._uploadPasteImage).toHaveBeenCalledTimes(2);
    expect(await m.app._uploadPasteImage.mock.calls[1][1].text()).toContain('One more point after Send.');
    expect(m.window.localStorage.getItem(m.key)).toBeNull();
  });

  it('keeps a reopened draft changed while the previous prompt is pending', async () => {
    const m = mount();
    m.app.toggleDocReview();
    addComment(m, 'the cache', 'Which cache?');
    const response = Promise.withResolvers<Awaited<ReturnType<typeof m.fetchMock>>>();
    m.fetchMock.mockReturnValueOnce(response.promise);
    const sending = m.app._sendDocReview('changes');
    await vi.waitFor(() => expect(m.fetchMock).toHaveBeenCalledTimes(1));
    m.app.toggleDocReview();
    m.app.toggleDocReview();
    addComment(m, 'restart', 'Can this wait?');
    response.resolve({ ok: true, status: 200, json: async () => ({}) });
    await sending;

    const uploaded = await m.app._uploadPasteImage.mock.calls[0][1].text();
    expect(uploaded).not.toContain('Can this wait?');
    const stored = m.core.parseDraft(m.window.localStorage.getItem(m.key))!;
    expect(stored.comments.map((entry) => entry.body)).toEqual(['Which cache?', 'Can this wait?']);
    expect(m.document.querySelectorAll('.doc-review-item')).toHaveLength(2);
  });

  it('keeps the draft when the prompt fails, and a retry does not upload again', async () => {
    const m = mount();
    m.app.toggleDocReview();
    addComment(m, 'the cache', 'Which cache?');
    m.fetchMock.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'busy' }) });

    await m.app._sendDocReview('changes');
    expect(m.app.showToast).toHaveBeenLastCalledWith(expect.stringContaining('busy'), 'error');
    expect(m.app._docReview).not.toBeNull();
    expect(m.core.parseDraft(m.window.localStorage.getItem(m.key))!.comments).toHaveLength(1);
    expect((m.document.querySelector('.doc-review-bar .doc-review-btn--primary') as HTMLButtonElement).disabled).toBe(
      false
    );

    await m.app._sendDocReview('changes');
    expect(m.app._uploadPasteImage).toHaveBeenCalledTimes(1);
    expect(m.fetchMock).toHaveBeenCalledTimes(2);
    expect(m.window.localStorage.getItem(m.key)).toBeNull();
  });

  it('keeps the draft when the upload fails and sends no prompt', async () => {
    const m = mount();
    m.app.toggleDocReview();
    addComment(m, 'the cache', 'Which cache?');
    m.app._uploadPasteImage.mockRejectedValueOnce(new Error('HTTP 413'));
    await m.app._sendDocReview('changes');
    expect(m.fetchMock).not.toHaveBeenCalled();
    expect(m.app._docReview).not.toBeNull();
    expect(m.window.localStorage.getItem(m.key)).not.toBeNull();
  });

  it('approves with no comments, and asks for something before requesting changes', async () => {
    const m = mount();
    m.app.toggleDocReview();
    await m.app._sendDocReview('changes');
    expect(m.app._uploadPasteImage).not.toHaveBeenCalled();
    await m.app._sendDocReview('approved');
    const text = await m.app._uploadPasteImage.mock.calls[0][1].text();
    expect(text).toContain('Verdict: approved');
    expect(JSON.parse(m.fetchMock.mock.calls[0][1]!.body!).input).toContain('approve');
  });
});
