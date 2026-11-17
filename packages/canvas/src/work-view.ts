/**
 * @fileoverview Work on the canvas page: the outline's Work section, the full view of seven lanes (Shift+W) and an
 * item's detail in the rail (rail view `work`). The pure part is `work-model.ts`; the server is
 * `routes/canvas-work-routes.ts`.
 *
 * This file builds its own markup and inserts it beside the outline's sections, over the board and in the rail, so
 * `canvas.html` carries only the stylesheet link. Every string from an item or a session is set with `textContent`.
 * Nothing here changes an item without a person's press: a move is a drag, Shift+Left/Right on a focused card or the
 * Status select; linked sessions are read for display only. The board, its camera and its selection are untouched.
 *
 * Seven lanes (W-48): on a desktop Done and Not doing share the last column (`.work-closed`), so six columns fit and
 * the rest scrolls sideways; a phone shows one lane behind wrapping tabs. Ready for work is in pickup order: a drag
 * within it, Shift+Up/Down on a card or Move up/down in the detail sets the item's `position`.
 */
import { uuid } from './ids.js';
import { STATE_GLYPHS, STATE_WORDS, parseSessions } from './sessions.js';
import type { ShellSessionRow } from '../../../src/canvas/shell-sessions.js';
import {
  isHttpsUrl,
  WORK_STATUSES,
  WORK_STATUS_NAMES,
  workClosed,
  workKey,
  type WorkStatus,
} from '../../../src/canvas/work.js';
import {
  assigneeLabel,
  authorLabel,
  itemState,
  laneItems,
  openCount,
  outlineItems,
  parseWork,
  readyStep,
  sessionLabel,
  stepStatus,
  workCounts,
  type WorkFilter,
  type WorkRow,
} from './work-model.js';
import { parseWaitingReviews, reviewWords, workReviewKey, type WaitingReviews } from './reviews.js';
import { RoutinesView } from './routines-view.js';

export type WorkHost = {
  url(path: string): string;
  workspace: string;
  phone(): boolean;
  online(): boolean;
  /** Shows the detail rail view, or closes it. */
  rail(open: boolean): void;
  railOpen(): boolean;
  /** Opens a session's conversation, or its terminal when it has none. */
  openSession(row: ShellSessionRow | undefined, sessionId: string, opener: HTMLElement): void;
  /** Hands the keyboard back to the board. */
  focusBoard(): void;
  say(message: string): void;
  /** Opens the Tasks list in the rail, where a routine's runs live. */
  showTasks(): void;
  /** Opens the outline; the view's own button shows only while it is closed (CSS). */
  openOutline(): void;
  /** Opens the assistant in the rail, beside the lanes. */
  openAssistant(): void;
};

const FILTERS: [WorkFilter, string][] = [
  ['all', 'All'],
  ['you', 'You'],
  ['agents', 'Agents'],
  ['none', 'Unassigned'],
];
const EMPTY: Record<WorkStatus, string> = {
  backlog: 'Ideas and later work land here',
  'needs-refinement': 'Nothing waiting for detail. New captures land here',
  'human-required': 'Nothing waiting on a person',
  'ready-for-work': 'Nothing ready. Refine an item and move it here',
  'in-progress': 'Nobody is working on anything',
  done: 'Finished work shows here',
  'not-doing': 'Decided against',
};
const OUTCOME_HEADS = {
  done: 'Done and verified',
  continue: 'Still working',
  split: 'Done, with new items filed',
} as const;
const DONE_SHOWN = 6;
const SESSIONS_EVERY_MS = 2000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  if (className) made.className = className;
  if (text) made.textContent = text;
  return made;
}
function btn(className: string, text: string, onclick: (e: MouseEvent) => void): HTMLButtonElement {
  const made = el('button', className, text);
  made.type = 'button';
  made.onclick = onclick;
  return made;
}
const clock = (at: number): string => {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const typing = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  !!target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])');

export class WorkView {
  private items: WorkRow[] = [];
  private sessions: ShellSessionRow[] = [];
  private loaded = false;
  private failed = '';
  private open: number | null = null;
  private full = false;
  private filter: WorkFilter = 'all';
  private query = '';
  private adding: WorkStatus | null = null;
  private menu = false;
  private phoneLane: WorkStatus = 'in-progress';
  private showAllDone = false;
  private lanesStale = false;
  private opener: HTMLElement | null = null;
  private asked = 0;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private sessionsAt = 0;
  /** The review each session has waiting on the Reviews page, by session id. Read with the sessions. */
  private reviews: WaitingReviews = { count: 0, bySession: new Map(), byWork: new Map() };
  private sessionsTimer: ReturnType<typeof setTimeout> | undefined;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private drag: {
    number: number;
    card: HTMLElement;
    x: number;
    y: number;
    on: boolean;
    over: HTMLElement | null;
    ghost?: HTMLElement;
  } | null = null;

  // Outline section
  private section = el('section');
  private counts = el('ul', 'work-counts');
  private active = el('ul', 'work-active');
  private note = el('p', 'shell-note');
  // Full view
  private view = el('section');
  private total = el('span', 'work-total');
  private search = el('input');
  private lanes = el('div', 'work-lanes');
  private tabs = el('nav', 'work-tabs');
  private toast = el('div', 'work-toast');
  private mode: 'items' | 'routines' = 'items';
  private modeSeg = el('div', 'work-seg work-mode');
  private itemsOnly: HTMLElement[] = [];
  private routines: RoutinesView;
  // Rail
  private detail = el('div', 'rail-body work-detail');

  constructor(private host: WorkHost) {
    this.routines = new RoutinesView({
      url: (path) => host.url(path),
      workspace: host.workspace,
      online: () => host.online(),
      showTasks: () => host.showTasks(),
      say: (message) => host.say(message),
    });
    this.buildSection();
    this.buildView();
    this.detail.id = 'workDetail';
    this.detail.tabIndex = -1;
    this.detail.hidden = true;
    const rail = document.getElementById('rail');
    rail?.append(this.detail);
    // Over the board, under the rail: the item detail opens beside the lanes.
    document.body.insertBefore(this.view, rail);
  }

  // ---- Building -------------------------------------------------------------

  private buildSection(): void {
    const s = this.section;
    s.id = 'work';
    s.setAttribute('aria-labelledby', 'workTitle');
    const head = el('div', 'section-head');
    const title = el('h2', '', 'Work');
    title.id = 'workTitle';
    const all = btn('work-all', 'All', (e) => this.openFull(null, e.currentTarget as HTMLElement));
    all.id = 'workOpen';
    all.title = 'All work · Shift+W';
    const hint = el('kbd', '', '⇧W');
    hint.setAttribute('aria-hidden', 'true');
    all.append(hint);
    head.append(title, all);
    this.counts.setAttribute('aria-label', 'Work by status');
    this.active.setAttribute('aria-label', 'In progress');
    this.note.hidden = true;
    this.note.setAttribute('role', 'status');
    s.append(head, this.counts, this.active, this.note);
    const outline = document.getElementById('outline');
    const before = document.getElementById('prototypes') ?? document.getElementById('tree');
    if (outline) outline.insertBefore(s, before && before.parentElement === outline ? before : null);
  }

  private buildView(): void {
    const v = this.view;
    v.id = 'workView';
    v.setAttribute('aria-labelledby', 'workViewTitle');
    v.hidden = true;
    const head = el('header', 'work-head');
    const h1 = el('h1');
    h1.id = 'workViewTitle';
    h1.append('Work ', this.total);
    const seg = el('div', 'work-seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Show');
    for (const [filter, label] of FILTERS) {
      const b = btn('', label, () => {
        this.filter = filter;
        this.paint();
      });
      b.dataset.workFilter = filter;
      seg.append(b);
    }
    this.search.type = 'search';
    this.search.className = 'work-search';
    this.search.placeholder = 'Filter by title or key';
    this.search.setAttribute('aria-label', 'Filter work items');
    this.search.autocomplete = 'off';
    this.search.oninput = () => {
      this.query = this.search.value;
      this.paintLanes();
    };
    const hint = el('span', 'work-hint', 'Drag cards, ⇧← ⇧→ to move, ⇧↑ ⇧↓ to reorder Ready for work');
    const add = btn('primary work-new', 'New item', () => this.startAdding('backlog'));
    add.title = 'New item · N';
    const close = btn('work-close', '', () => this.closeFull());
    close.setAttribute('aria-label', 'Close Work');
    close.title = 'Close · Esc';
    close.append(icon('M5 5l10 10M15 5L5 15'));
    const outline = btn('work-icon work-outline', '', () => this.host.openOutline());
    outline.setAttribute('aria-label', 'Open outline');
    outline.title = 'Open outline';
    outline.append(icon('M3 4h14v12H3zM7 4v12'));
    const assistant = btn('work-icon', '', () => this.host.openAssistant());
    assistant.setAttribute('aria-label', 'Assistant');
    assistant.title = 'Assistant';
    assistant.append(
      icon(
        'M10 3l1.8 4.2L16 9l-4.2 1.8L10 15l-1.8-4.2L4 9l4.2-1.8zM15 14l.7 1.3L17 16l-1.3.7L15 18l-.7-1.3L13 16l1.3-.7z'
      )
    );
    this.modeSeg.setAttribute('role', 'group');
    this.modeSeg.setAttribute('aria-label', 'Work or routines');
    for (const [mode, label] of [
      ['items', 'Items'],
      ['routines', 'Routines'],
    ] as const) {
      const b = btn('', label, () => this.setMode(mode));
      b.dataset.workMode = mode;
      this.modeSeg.append(b);
    }
    this.itemsOnly = [seg, this.search, hint, add, this.tabs, this.lanes];
    head.append(outline, h1, this.modeSeg, seg, this.search, el('span', 'work-grow'), hint, add, assistant, close);
    this.tabs.setAttribute('aria-label', 'Lanes');
    // Built once and relabelled on paint, so a tab keeps the keyboard and a press across a refresh.
    for (const status of WORK_STATUSES) {
      const b = btn('', WORK_STATUS_NAMES[status], () => {
        this.phoneLane = status;
        this.paintLanes();
      });
      b.dataset.laneTab = status;
      this.tabs.append(b);
    }
    this.toast.hidden = true;
    this.toast.setAttribute('role', 'status');
    v.append(head, this.tabs, this.lanes, this.routines.element, this.toast);
    v.addEventListener('keydown', (e) => this.viewKey(e));
  }

  // ---- Data -----------------------------------------------------------------

  async load(): Promise<void> {
    const asked = ++this.asked;
    try {
      const response = await fetch(this.host.url(`/api/canvas/${this.host.workspace}/work`));
      const body = await response.json().catch(() => null);
      if (asked !== this.asked) return;
      const parsed = response.ok ? parseWork(body) : null;
      if (!parsed) {
        this.failed =
          (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' && body.error) ||
          'Work items could not be read';
      } else {
        this.items = parsed.items;
        this.failed = '';
        this.loaded = true;
      }
    } catch {
      if (asked !== this.asked) return;
      // Offline: the items already shown stay.
    }
    this.paint();
    if (this.items.some((i) => i.sessions.length || i.pr)) this.refreshSessions();
  }
  /** `canvas:changed` from the stream: a commit that changed work items says so. */
  serverChanged(raw: unknown): void {
    let data: unknown = raw;
    if (typeof raw === 'string')
      try {
        data = JSON.parse(raw);
      } catch {
        return;
      }
    if (!data || typeof data !== 'object') return;
    if ('workspaceId' in data && data.workspaceId !== this.host.workspace) return;
    if ('routines' in data && data.routines === true) {
      if (this.full && this.mode === 'routines') void this.routines.load();
      return;
    }
    if (!('work' in data) || data.work !== true) return;
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => void this.load(), 150);
  }
  /** A session event: the linked sessions' states may have changed. */
  event(): void {
    if (this.items.some((i) => i.sessions.length || i.pr) || this.menu) this.refreshSessions();
  }
  private refreshSessions(): void {
    if (document.hidden || this.sessionsTimer) return;
    const wait = Math.max(0, this.sessionsAt + SESSIONS_EVERY_MS - Date.now());
    this.sessionsTimer = setTimeout(async () => {
      this.sessionsAt = Date.now();
      try {
        const response = await fetch(this.host.url(`/api/canvas/${this.host.workspace}/sessions`));
        const rows = response.ok ? parseSessions(await response.json()) : null;
        const reviews = await this.readReviews();
        if (reviews) this.reviews = reviews;
        if (rows) this.sessions = rows;
        if (rows || reviews) this.paint();
      } catch {
        // The states already shown stay until the next event.
      } finally {
        this.sessionsTimer = undefined;
      }
    }, wait);
  }

  /** Reviews that wait for a verdict, by the session that wrote each and by work item. Null when unreadable. */
  private async readReviews(): Promise<WaitingReviews | null> {
    try {
      const response = await fetch(this.host.url('/api/reviews'));
      return response.ok ? parseWaitingReviews(await response.json()) : null;
    } catch {
      return null;
    }
  }

  private async send(method: 'POST' | 'PATCH', path: string, body: unknown): Promise<WorkRow | null> {
    if (!this.host.online()) {
      this.host.say('Work items cannot change while Codeman cannot be reached');
      return null;
    }
    try {
      const response = await fetch(this.host.url(`/api/canvas/${this.host.workspace}/work${path}`), {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const answer = (await response.json().catch(() => null)) as {
        data?: { item?: WorkRow };
        error?: string;
      } | null;
      if (!response.ok || !answer?.data?.item) {
        const message = answer?.error?.replace(/^[A-Z_]+: /, '') ?? 'The change was not saved';
        this.host.say(response.status === 409 ? `${message}. Showing the latest.` : message);
        void this.load();
        return null;
      }
      return answer.data.item;
    } catch {
      this.host.say('The change was not saved. Check the connection and try again.');
      void this.load();
      return null;
    }
  }
  private replace(item: WorkRow): void {
    const at = this.items.findIndex((i) => i.number === item.number);
    if (at >= 0) this.items[at] = item;
    else this.items.push(item);
  }
  private async patch(item: WorkRow, body: Record<string, unknown>): Promise<WorkRow | null> {
    const saved = await this.send('PATCH', `/${item.key}`, { ...body, expectedRevision: item.revision });
    if (saved) {
      this.replace(saved);
      this.paint();
    }
    return saved;
  }

  // ---- Actions ----------------------------------------------------------------

  /** Moves an item to another lane. A person's move is undoable from the notice for a few seconds. */
  async move(item: WorkRow, to: WorkStatus, undoable = true, position?: number): Promise<void> {
    if (item.status === to) {
      if (position !== undefined) await this.reorder(item, position);
      return;
    }
    const from = item.status;
    // Shown at once; the server's answer replaces it, a refusal reloads.
    const shown = position !== undefined ? position - 0.5 : 1e9;
    this.replace({ ...item, status: to, ...(to === 'ready-for-work' ? { position: shown } : {}) });
    this.paint();
    const saved = await this.send('PATCH', `/${item.key}`, {
      status: to,
      ...(position !== undefined ? { position } : {}),
      expectedRevision: item.revision,
    });
    if (!saved) return;
    this.replace(saved);
    this.paint();
    // Entering or leaving Ready for work shifts the positions of the cards around it.
    if (to === 'ready-for-work' || from === 'ready-for-work') void this.load();
    if (undoable)
      this.notify(`${item.key} moved to ${WORK_STATUS_NAMES[to]}`, () => {
        const now = this.items.find((i) => i.number === item.number);
        if (now && now.status === to) void this.move(now, from, false);
      });
  }
  /**
   * Puts a Ready for work item at `position` (1 is the top). Other cards shift, so the lane is read again once the
   * server answers: their positions changed without a change of their own.
   */
  private async reorder(item: WorkRow, position: number): Promise<void> {
    if (item.status !== 'ready-for-work' || item.position === position) return;
    this.replace({ ...item, position: position < (item.position ?? 0) ? position - 0.5 : position + 0.5 });
    this.paint();
    const saved = await this.send('PATCH', `/${item.key}`, { position, expectedRevision: item.revision });
    if (!saved) return;
    this.replace(saved);
    await this.load();
    this.host.say(`${item.key} is number ${saved.position ?? position} in Ready for work`);
  }
  private async create(title: string, status: WorkStatus): Promise<void> {
    const made = await this.send('POST', '', { title, status, requestId: uuid() });
    if (made) {
      this.replace(made);
      this.paint();
      this.host.say(`${made.key} added to ${WORK_STATUS_NAMES[status]}`);
    }
  }
  private startAdding(status: WorkStatus): void {
    if (!this.full) this.openFull(status, null);
    this.adding = status;
    this.phoneLane = status;
    this.paint();
  }

  // ---- Opening and closing --------------------------------------------------

  isFull(): boolean {
    return this.full;
  }
  openFull(lane: WorkStatus | null, opener: HTMLElement | null): void {
    if (!this.full)
      this.opener = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    this.full = true;
    if (lane) this.phoneLane = lane;
    if (!this.loaded) void this.load();
    this.refreshSessions();
    this.paint();
    document.documentElement.toggleAttribute('data-work-open', true);
    requestAnimationFrame(() => {
      const target =
        (lane && this.lanes.querySelector<HTMLElement>(`[data-lane="${lane}"] .work-card`)) ||
        this.lanes.querySelector<HTMLElement>('.work-card') ||
        this.view.querySelector<HTMLElement>('.work-new');
      target?.focus({ preventScroll: false });
      if (lane) this.flashLane(lane);
    });
  }
  closeFull(): void {
    if (!this.full) return;
    this.full = false;
    this.adding = null;
    this.cancelDrag();
    document.documentElement.toggleAttribute('data-work-open', false);
    this.paint();
    const back = this.opener;
    this.opener = null;
    if (back?.isConnected && !back.closest('[hidden]')) back.focus({ preventScroll: true });
    else this.host.focusBoard();
  }
  toggleFull(opener: HTMLElement | null = null): void {
    if (this.full) this.closeFull();
    else this.openFull(null, opener);
  }
  /** Opens one item's detail in the rail. */
  openItem(number: number): void {
    this.open = number;
    this.menu = false;
    const item = this.items.find((i) => i.number === number);
    if (item) this.phoneLane = item.status;
    this.host.rail(true);
    this.paint();
    requestAnimationFrame(() => this.detail.focus({ preventScroll: true }));
  }
  /** The rail's title while it shows an item. */
  railTitle(): string {
    const item = this.items.find((i) => i.number === this.open);
    return item ? item.key : 'Work item';
  }
  /** From the page's paint: whether the rail shows the detail now. */
  sync(railShowsWork: boolean): void {
    const was = !this.detail.hidden;
    this.detail.hidden = !railShowsWork;
    if (was && !railShowsWork) {
      this.menu = false;
      // The card the detail was opened from takes the keyboard back.
      // The page's own Escape may already have handed focus to the board; with the lanes open it belongs here.
      const active = document.activeElement;
      const lost = !active || active === document.body || this.detail.contains(active) || !this.view.contains(active);
      this.paintLanes();
      const card = this.lanes.querySelector<HTMLElement>(`.work-card[data-number="${this.open}"]`);
      if (this.full && card && lost && !this.host.railOpen()) card.focus({ preventScroll: true });
    }
    if (!was && railShowsWork) this.paintDetail();
  }

  /** Shift+W anywhere outside a text field; Escape and N inside the full view. True when the key was taken. */
  key(e: KeyboardEvent): boolean {
    if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return false;
    if (e.shiftKey && e.key.toLowerCase() === 'w' && !typing(e.target) && !this.host.phone()) {
      e.preventDefault();
      this.toggleFull(e.target instanceof HTMLElement ? e.target : null);
      return true;
    }
    return false;
  }
  private viewKey(e: KeyboardEvent): void {
    if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape' && !this.host.railOpen()) {
      if (this.adding && typing(e.target)) return; // the input's own Escape ends adding
      e.preventDefault();
      e.stopPropagation();
      this.closeFull();
      return;
    }
    if (typing(e.target) || this.mode === 'routines') return;
    if (e.key.toLowerCase() === 'n' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      this.startAdding('backlog');
    } else if (e.key === '/') {
      e.preventDefault();
      e.stopPropagation();
      this.search.focus();
    }
  }

  setMode(mode: 'items' | 'routines'): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.paint();
    if (mode === 'routines') this.routines.show(true);
  }
  private paintMode(): void {
    const routines = this.mode === 'routines';
    for (const b of this.modeSeg.querySelectorAll<HTMLElement>('[data-work-mode]'))
      b.setAttribute('aria-pressed', String(b.dataset.workMode === this.mode));
    for (const part of this.itemsOnly) part.classList.toggle('work-mode-hidden', routines);
    if (this.routines.element.hidden === routines) this.routines.show(routines);
  }

  // ---- Painting -------------------------------------------------------------

  paint(): void {
    this.paintSection();
    this.view.hidden = !this.full;
    if (this.full) this.paintMode();
    // A repaint during a drag would replace the card holding the pointer and lose the drop; it waits for the end.
    if (this.full && this.mode === 'items' && this.drag) this.lanesStale = true;
    else if (this.full && this.mode === 'items') this.paintLanes();
    if (!this.detail.hidden) this.paintDetail();
  }

  private paintSection(): void {
    const focusKey = this.section.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.workControl
      : undefined;
    this.note.hidden = !this.failed;
    this.note.textContent = this.failed;
    this.counts.replaceChildren(
      ...workCounts(this.items).map((c) => {
        const li = el('li');
        const row = btn('work-count', '', (e) => this.openFull(c.status, e.currentTarget as HTMLElement));
        row.dataset.workControl = `count-${c.status}`;
        row.dataset.status = c.status;
        row.append(el('span', 'work-count-name', WORK_STATUS_NAMES[c.status]));
        // The outline is narrow: the unassigned count is in the label here and on the lane's head.
        row.append(el('span', 'work-n', String(c.count)));
        row.setAttribute(
          'aria-label',
          `${WORK_STATUS_NAMES[c.status]}: ${c.count}${c.unassigned ? `, ${c.unassigned} unassigned` : ''}`
        );
        li.append(row);
        return li;
      })
    );
    const progress = outlineItems(this.items, this.sessions);
    this.active.hidden = !this.loaded;
    this.active.replaceChildren(
      ...(progress.length
        ? progress.map((item) => {
            const state = itemState(item, this.sessions);
            const li = el('li');
            const row = btn('work-active-row', '', () => this.openItem(item.number));
            row.dataset.workControl = `item-${item.number}`;
            if (state) row.dataset.state = state;
            const glyph = el('span', 'work-glyph', state ? STATE_GLYPHS[state] : '');
            glyph.setAttribute('aria-hidden', 'true');
            const title = el('span', 'work-active-title');
            title.append(el('span', 'work-key', item.key), ' ', item.title);
            row.append(
              glyph,
              title,
              el('span', 'work-active-meta', state ? STATE_WORDS[state] : WORK_STATUS_NAMES[item.status])
            );
            li.append(row);
            return li;
          })
        : [el('li', 'work-none', 'Nothing in progress or waiting on you')])
    );
    if (focusKey)
      this.section
        .querySelector<HTMLElement>(`[data-work-control="${CSS.escape(focusKey)}"]`)
        ?.focus({ preventScroll: true });
  }

  private paintLanes(): void {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusCard = active && this.lanes.contains(active) ? active.dataset.number : undefined;
    const focusAdd = active?.dataset.workAdd;
    this.total.textContent = `${openCount(this.items)} open`;
    for (const b of this.view.querySelectorAll<HTMLElement>('[data-work-filter]'))
      b.setAttribute('aria-pressed', String(b.dataset.workFilter === this.filter));
    for (const b of this.tabs.querySelectorAll<HTMLElement>('[data-lane-tab]')) {
      const status = b.dataset.laneTab as WorkStatus;
      b.textContent = `${WORK_STATUS_NAMES[status]} ${this.items.filter((i) => i.status === status).length}`;
      b.setAttribute('aria-pressed', String(this.phoneLane === status));
    }
    // Done and Not doing share one column on a desktop; a phone shows one lane at a time either way.
    const closed = el('div', 'work-closed');
    closed.append(this.lane('done'), this.lane('not-doing'));
    this.lanes.replaceChildren(...WORK_STATUSES.filter((s) => !workClosed(s)).map((s) => this.lane(s)), closed);
    if (focusCard)
      this.lanes.querySelector<HTMLElement>(`.work-card[data-number="${focusCard}"]`)?.focus({ preventScroll: true });
    else if (focusAdd) this.lanes.querySelector<HTMLElement>(`[data-work-add="${focusAdd}"]`)?.focus();
  }

  private lane(status: WorkStatus): HTMLElement {
    const all = this.items.filter((i) => i.status === status);
    let cards = laneItems(this.items, status, this.sessions, this.filter, this.query);
    const lane = el('section', 'work-lane');
    lane.dataset.lane = status;
    lane.classList.toggle('on', this.phoneLane === status);
    lane.setAttribute('aria-label', WORK_STATUS_NAMES[status]);
    const head = el('div', 'work-lane-head');
    head.append(el('h2', '', WORK_STATUS_NAMES[status]), el('span', 'work-n', String(all.length)));
    const unassigned = status === 'ready-for-work' ? all.filter((i) => i.assignee === null).length : 0;
    if (unassigned) head.append(el('span', 'work-flag', `${unassigned} unassigned`));
    if (status === 'ready-for-work' && all.length) head.append(el('span', 'work-lane-note', 'Top first'));
    const body = el('div', 'work-lane-body');
    let hidden = 0;
    if (status === 'done' && !this.showAllDone && cards.length > DONE_SHOWN + 2) {
      hidden = cards.length - DONE_SHOWN;
      cards = cards.slice(0, DONE_SHOWN);
    }
    if (!this.loaded && !this.failed) body.append(el('p', 'work-empty', 'Loading…'));
    else if (!cards.length)
      body.append(el('p', 'work-empty', all.length ? 'Nothing matches the filter' : EMPTY[status]));
    body.append(...cards.map((item) => this.card(item)));
    if (hidden)
      body.append(
        btn('work-add', `Show ${hidden} more`, () => {
          this.showAllDone = true;
          this.paintLanes();
        })
      );
    if (status === 'backlog' || status === 'needs-refinement') body.append(this.adder(status));
    lane.append(head, body);
    return lane;
  }

  private adder(status: WorkStatus): HTMLElement {
    if (this.adding !== status) {
      const add = btn('work-add', '+ Add item', () => this.startAdding(status));
      add.dataset.workAdd = status;
      return add;
    }
    const input = el('input', 'work-add-input');
    input.placeholder = 'Title, then Enter';
    input.maxLength = 200;
    input.setAttribute('aria-label', `New ${WORK_STATUS_NAMES[status]} item`);
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter' && input.value.trim()) {
        e.preventDefault();
        const title = input.value.trim();
        input.value = '';
        void this.create(title, status).then(() => {
          // Adding stays open for the next title.
          this.lanes.querySelector<HTMLInputElement>('.work-add-input')?.focus();
        });
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.adding = null;
        this.paintLanes();
        this.lanes.querySelector<HTMLElement>(`[data-work-add="${status}"]`)?.focus();
      }
    });
    // Tabbing or clicking to another control of the view with nothing typed ends adding. A repaint that replaces
    // this input also blurs it; the new input has the keyboard then, so that blur changes nothing.
    input.addEventListener('blur', () => {
      setTimeout(() => {
        const now = document.activeElement;
        if (!input.isConnected || this.adding !== status || input.value.trim()) return;
        if (now === input || now?.classList.contains('work-add-input') || !this.view.contains(now)) return;
        this.adding = null;
        this.paintLanes();
      });
    });
    queueMicrotask(() => input.isConnected && input.focus());
    const row = el('div', 'work-add-row');
    row.append(input);
    return row;
  }

  private who(item: WorkRow): HTMLElement {
    const who = el('span', item.assignee ? 'work-who' : 'work-who none');
    if (item.assignee) {
      const mark = el(
        'span',
        item.assignee.kind === 'person' ? 'work-av' : 'work-av agent',
        item.assignee.kind === 'person' ? 'Y' : 'A'
      );
      mark.setAttribute('aria-hidden', 'true');
      who.append(mark);
    }
    who.append(assigneeLabel(item, this.sessions));
    return who;
  }
  private stateTag(state: ReturnType<typeof itemState>): HTMLElement | null {
    if (!state) return null;
    const tag = el('span', 'work-state');
    tag.dataset.state = state;
    const glyph = el('span', 'work-glyph', STATE_GLYPHS[state]);
    glyph.setAttribute('aria-hidden', 'true');
    tag.append(glyph, STATE_WORDS[state]);
    return tag;
  }

  private card(item: WorkRow): HTMLElement {
    const state = itemState(item, this.sessions);
    const quiet = workClosed(item.status);
    const card = el('div', `work-card${quiet ? ' quiet' : ''}${state === 'needs' ? ' needs' : ''}`);
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.dataset.number = String(item.number);
    card.setAttribute('aria-selected', String(this.open === item.number && !this.detail.hidden));
    card.setAttribute(
      'aria-label',
      `${item.position !== undefined && item.status === 'ready-for-work' ? `Number ${item.position}. ` : ''}${item.key} ${item.title}. ${assigneeLabel(item, this.sessions)}${state ? `, ${STATE_WORDS[state]}` : ''}`
    );
    const top = el('div', 'work-card-top');
    top.append(el('span', 'work-key', item.key), el('span', 'work-card-title', item.title));
    if (item.position !== undefined && item.status === 'ready-for-work') {
      const rank = el('span', 'work-rank', String(item.position));
      rank.title = `Number ${item.position} in Ready for work`;
      top.prepend(rank);
    }
    card.append(top);
    if (!quiet) {
      const meta = el('div', 'work-card-meta');
      meta.append(this.who(item));
      const tag = this.stateTag(state);
      if (tag) meta.append(tag);
      card.append(meta);
      if (item.needs) {
        const call = el('div', 'work-call');
        call.append(el('b', '', 'Agent asks: '), item.needs.question);
        card.append(call);
      } else if (item.outcome?.kind === 'continue') {
        const call = el('div', 'work-call');
        call.append(el('b', '', 'Still working: '), item.outcome.text);
        card.append(call);
      }
      if (item.createdFrom !== undefined || item.pr) {
        const from = el('div', 'work-from', item.createdFrom !== undefined ? `From ${workKey(item.createdFrom)}` : '');
        if (item.pr) {
          const chip = el('span', 'work-pr-chip', 'PR');
          chip.title = item.pr.url;
          from.append(chip);
        }
        card.append(from);
      }
    }
    card.addEventListener('pointerdown', (e) => this.startDrag(e, item.number, card));
    card.addEventListener('keydown', (e) => this.cardKey(e, item));
    return card;
  }

  private cardKey(e: KeyboardEvent, item: WorkRow): void {
    if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    const card = e.currentTarget as HTMLElement;
    const laneEl = card.closest<HTMLElement>('.work-lane');
    if (!laneEl) return;
    const lanes = [...this.lanes.querySelectorAll<HTMLElement>('.work-lane')].filter((l) => l.offsetParent);
    const cards = (l: HTMLElement) => [...l.querySelectorAll<HTMLElement>('.work-card')];
    const list = cards(laneEl);
    const at = list.indexOf(card);
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if ((e.key === 'Enter' || e.key === ' ') && !e.shiftKey) {
      stop();
      this.openItem(item.number);
    } else if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      stop();
      if (e.repeat) return;
      const to = stepStatus(item.status, e.key === 'ArrowRight' ? 1 : -1);
      if (!to) return;
      this.phoneLane = to;
      void this.move(item, to);
      requestAnimationFrame(() =>
        this.lanes
          .querySelector<HTMLElement>(`.work-card[data-number="${item.number}"]`)
          ?.focus({ preventScroll: false })
      );
    } else if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      // Ready for work only: priority is position.
      stop();
      if (e.repeat) return;
      const to = readyStep(this.items, item, e.key === 'ArrowDown' ? 1 : -1);
      if (to === null) return;
      void this.reorder(item, to);
      requestAnimationFrame(() =>
        this.lanes.querySelector<HTMLElement>(`.work-card[data-number="${item.number}"]`)?.focus()
      );
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      stop();
      list[at + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      stop();
      let li = lanes.indexOf(laneEl);
      do li += e.key === 'ArrowRight' ? 1 : -1;
      while (lanes[li] && !cards(lanes[li]!).length);
      const next = lanes[li] ? cards(lanes[li]!) : [];
      next[Math.min(at, next.length - 1)]?.focus();
    }
  }

  private flashLane(status: WorkStatus): void {
    const lane = this.lanes.querySelector<HTMLElement>(`[data-lane="${status}"]`);
    if (!lane) return;
    lane.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    lane.classList.add('flash');
    setTimeout(() => lane.classList.remove('flash'), 600);
  }

  private notify(text: string, undo?: () => void): void {
    this.host.say(text);
    if (!this.full) return;
    this.toast.replaceChildren(text);
    if (undo)
      this.toast.append(
        btn('work-undo', 'Undo', () => {
          this.toast.hidden = true;
          undo();
        })
      );
    this.toast.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toast.hidden = true), 5000);
  }

  // ---- Drag -------------------------------------------------------------------

  private startDrag(e: PointerEvent, number: number, card: HTMLElement): void {
    if (e.button !== 0) return;
    this.drag = { number, card, x: e.clientX, y: e.clientY, on: false, over: null };
    card.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => this.dragMove(ev);
    const end = () => {
      card.removeEventListener('pointermove', move);
      const d = this.drag;
      this.cancelDrag();
      if (!d) return;
      if (!d.on) return this.openItem(d.number);
      const item = this.items.find((i) => i.number === d.number);
      const to = d.over?.dataset.lane as WorkStatus | undefined;
      if (!item || !to) return;
      // Into or within Ready for work, the drop point is the position; elsewhere the lane is enough.
      const position = to === 'ready-for-work' && d.over ? this.dropPosition(d.over, d.y, item.number) : undefined;
      void this.move(item, to, true, position);
    };
    card.addEventListener('pointermove', move);
    card.addEventListener('pointerup', end, { once: true });
    card.addEventListener('pointercancel', () => this.cancelDrag(), { once: true });
  }
  private dragMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    if (!d.on) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
      d.on = true;
      d.card.classList.add('dragging');
      const ghost = d.card.cloneNode(true) as HTMLElement;
      ghost.removeAttribute('tabindex');
      ghost.classList.remove('dragging');
      ghost.classList.add('work-ghost');
      ghost.setAttribute('aria-hidden', 'true');
      this.view.append(ghost);
      d.ghost = ghost;
    }
    d.y = e.clientY;
    d.ghost!.style.left = `${e.clientX - 20}px`;
    d.ghost!.style.top = `${e.clientY - 16}px`;
    const lane =
      document
        .elementsFromPoint(e.clientX, e.clientY)
        .find((n): n is HTMLElement => n instanceof HTMLElement && n.classList.contains('work-lane')) ?? null;
    if (d.over !== lane) {
      d.over?.classList.remove('over');
      lane?.classList.add('over');
      d.over = lane;
    }
  }
  /** The position a drop at `y` means in a Ready for work lane: before the first card whose middle is below it. */
  private dropPosition(lane: HTMLElement, y: number, dragged: number): number {
    const cards = [...lane.querySelectorAll<HTMLElement>('.work-card')].filter(
      (c) => c.dataset.number !== String(dragged)
    );
    const before = cards.findIndex((c) => {
      const box = c.getBoundingClientRect();
      return y < box.top + box.height / 2;
    });
    const anchor = before === -1 ? null : this.items.find((i) => String(i.number) === cards[before]!.dataset.number);
    if (!anchor?.position) return cards.length + 1;
    const own = this.items.find((i) => i.number === dragged);
    // Dragged from above the anchor inside the lane: the anchor moves up one when the card leaves.
    return own?.status === 'ready-for-work' && own.position !== undefined && own.position < anchor.position
      ? anchor.position - 1
      : anchor.position;
  }
  private cancelDrag(): void {
    const d = this.drag;
    if (!d) return;
    d.card.classList.remove('dragging');
    d.over?.classList.remove('over');
    d.ghost?.remove();
    this.drag = null;
    if (this.lanesStale) {
      this.lanesStale = false;
      if (this.full) this.paintLanes();
    }
  }

  // ---- Detail -----------------------------------------------------------------

  private paintDetail(): void {
    const item = this.items.find((i) => i.number === this.open);
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const keep = active && this.detail.contains(active) ? active.dataset.workDetail : undefined;
    // A field the person is typing in is never rebuilt under them.
    if (
      active &&
      this.detail.contains(active) &&
      (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement)
    )
      return;
    if (!item) {
      this.detail.replaceChildren(
        el('p', 'thread-empty', this.loaded ? 'Pick a work item to see it here.' : 'Loading work items…')
      );
      return;
    }
    const sessions = this.sessions;
    const parts: HTMLElement[] = [];
    const agent = item.assignee?.kind === 'session' ? item.assignee.sessionId : null;

    const title = el('textarea', 'work-title');
    title.rows = 2;
    title.maxLength = 200;
    title.value = item.title;
    title.dataset.workDetail = 'title';
    title.setAttribute('aria-label', 'Title');
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        title.blur();
      }
    });
    title.addEventListener('change', () => {
      const value = title.value.replace(/\s+/g, ' ').trim();
      if (value && value !== item.title) void this.patch(item, { title: value });
      else title.value = item.title;
    });
    parts.push(title);

    const status = el('select');
    status.dataset.workDetail = 'status';
    for (const s of WORK_STATUSES) {
      const option = el('option', '', WORK_STATUS_NAMES[s]);
      option.value = s;
      option.selected = s === item.status;
      status.append(option);
    }
    status.onchange = () => void this.move(item, status.value as WorkStatus);
    parts.push(this.field('Status', status));
    if (item.status === 'ready-for-work' && item.position !== undefined) {
      const size = this.items.filter((i) => i.status === 'ready-for-work').length;
      const place = el('div', 'work-place');
      place.append(el('span', 'work-place-n', `${item.position} of ${size}, top is picked up first`));
      const up = btn('line', 'Move up', () => void this.reorder(item, item.position! - 1));
      up.dataset.workDetail = 'up';
      up.disabled = readyStep(this.items, item, -1) === null;
      const down = btn('line', 'Move down', () => void this.reorder(item, item.position! + 1));
      down.dataset.workDetail = 'down';
      down.disabled = readyStep(this.items, item, 1) === null;
      place.append(up, down);
      parts.push(this.field('Position', place));
    }

    const pick = el('button', 'work-pick');
    pick.type = 'button';
    pick.dataset.workDetail = 'assignee';
    pick.setAttribute('aria-expanded', String(this.menu));
    pick.append(this.who(item));
    pick.onclick = () => {
      this.menu = !this.menu;
      if (this.menu) this.refreshSessions();
      this.paintDetail();
    };
    const assign = this.field('Assignee', pick);
    if (this.menu) assign.append(this.assigneeMenu(item));
    parts.push(assign);

    if (item.needs) {
      const box = el('div', 'work-box needs');
      box.setAttribute('role', 'group');
      box.setAttribute('aria-label', 'Needs you');
      const hd = el('div', 'work-box-head');
      const glyph = el('span', 'work-glyph', '!');
      glyph.setAttribute('aria-hidden', 'true');
      hd.append(glyph, 'Needs you');
      const asker = item.needs.sessionId;
      const actions = el('div', 'work-actions');
      if (asker) {
        const go = btn('primary', 'Open conversation', (e) =>
          this.host.openSession(
            sessions.find((s) => s.id === asker),
            asker,
            e.currentTarget as HTMLElement
          )
        );
        go.dataset.workDetail = 'answer';
        actions.append(go);
      }
      // Answered, a Human required item goes back to Needs refinement so its readiness is checked again.
      const answered = btn('line', 'Mark answered', () => void this.patch(item, { needs: null }));
      if (item.status === 'human-required') answered.title = 'Moves it to Needs refinement';
      answered.dataset.workDetail = 'answered';
      actions.append(answered);
      box.append(
        hd,
        el('p', 'work-question', item.needs.question),
        el(
          'p',
          'work-box-why',
          asker ? `Asked by ${sessionLabel(asker, sessions)}. Answer in its conversation.` : 'Asked by an agent.'
        ),
        actions
      );
      parts.push(box);
    } else if (item.outcome) {
      const box = el('div', 'work-box');
      box.append(
        el('div', 'work-box-head', OUTCOME_HEADS[item.outcome.kind]),
        el('p', 'work-box-why', item.outcome.text)
      );
      if (item.outcome.sessionId)
        box.append(
          el('p', 'work-box-by', `${sessionLabel(item.outcome.sessionId, sessions)} · ${clock(item.outcome.at)}`)
        );
      parts.push(box);
    }

    if (item.pr) {
      const prSec = el('div', 'work-sec');
      prSec.append(el('h3', '', 'Pull request'));
      const link = el('a', 'work-pr-link', item.pr.url);
      if (isHttpsUrl(item.pr.url)) {
        link.href = item.pr.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
      link.dataset.workDetail = 'pr';
      prSec.append(link);
      if (item.pr.branch) prSec.append(el('p', 'work-pr-branch', item.pr.branch));
      const review = this.reviews.byWork.get(workReviewKey(this.host.workspace, workKey(item.number)));
      if (review) {
        const open = el('a', 'work-link-review', reviewWords(review.state));
        open.href = this.host.url(`/reviews/${review.id}`);
        open.dataset.workDetail = 'pr-review';
        prSec.append(open);
      }
      parts.push(prSec);
    }

    const links = el('div', 'work-sec');
    links.append(el('h3', '', 'Linked sessions'));
    if (!item.sessions.length) links.append(el('p', 'work-empty', 'No sessions yet'));
    for (const id of item.sessions) {
      const row = sessions.find((s) => s.id === id);
      const state = row?.state ?? 'done';
      const link = el('div', 'work-link');
      link.dataset.state = state;
      const name = btn('work-link-name', sessionLabel(id, sessions), (e) =>
        this.host.openSession(row, id, e.currentTarget as HTMLElement)
      );
      name.title = row?.kind === 'conversation' ? 'Open its conversation' : 'Open its terminal';
      name.dataset.workDetail = `session-${id}`;
      const meta = el('span', 'work-link-meta');
      const glyph = el('span', 'work-glyph', STATE_GLYPHS[state]);
      glyph.setAttribute('aria-hidden', 'true');
      meta.append(glyph, STATE_WORDS[state], id === agent ? ' · assignee' : '');
      const unlink = btn('work-unlink', 'Unlink', () => void this.patch(item, { unlinkSessions: [id] }));
      unlink.dataset.workDetail = `unlink-${id}`;
      unlink.setAttribute('aria-label', `Unlink ${sessionLabel(id, sessions)}`);
      link.append(name, unlink, meta);
      const review = this.reviews.bySession.get(id);
      if (review) {
        // The session handed its work in: the walkthrough, the changes and the verdict are on the Reviews page.
        const open = el('a', 'work-link-review', reviewWords(review.state));
        open.href = this.host.url(`/reviews/${review.id}`);
        open.dataset.workDetail = `review-${id}`;
        link.append(open);
      }
      links.append(link);
    }
    const linkable = sessions.filter((s) => s.state !== 'done' && !item.sessions.includes(s.id));
    if (linkable.length) {
      const select = el('select', 'work-link-add');
      select.dataset.workDetail = 'link';
      select.setAttribute('aria-label', 'Link a session');
      const first = el('option', '', 'Link a session…');
      first.value = '';
      select.append(first);
      for (const s of linkable) {
        const option = el('option', '', `${STATE_GLYPHS[s.state]} ${s.name}`);
        option.value = s.id;
        select.append(option);
      }
      select.onchange = () => select.value && void this.patch(item, { linkSessions: [select.value] });
      links.append(select);
    }
    parts.push(links);

    const desc = el('textarea', 'work-desc');
    desc.rows = 4;
    desc.maxLength = 8000;
    desc.placeholder = 'What done looks like';
    desc.value = item.description;
    desc.dataset.workDetail = 'description';
    desc.setAttribute('aria-labelledby', 'workDescTitle');
    desc.addEventListener('change', () => {
      if (desc.value.trim() !== item.description) void this.patch(item, { description: desc.value });
    });
    const descSec = el('div', 'work-sec');
    const descTitle = el('h3', '', 'Description');
    descTitle.id = 'workDescTitle';
    descSec.append(descTitle, desc);
    parts.push(descSec);

    const parent = item.createdFrom !== undefined ? this.items.find((i) => i.number === item.createdFrom) : undefined;
    const children = this.items.filter((i) => i.createdFrom === item.number);
    if (parent || children.length) {
      const rel = el('div', 'work-sec');
      rel.append(el('h3', '', 'Related items'));
      const row = (other: WorkRow) => {
        const li = el('li');
        const b = btn('work-rel', '', () => this.openItem(other.number));
        b.dataset.workDetail = `rel-${other.number}`;
        b.append(
          el('span', 'work-key', other.key),
          el('span', 'work-rel-title', other.title),
          el('span', 'work-rel-status', WORK_STATUS_NAMES[other.status])
        );
        li.append(b);
        return li;
      };
      if (parent) {
        const list = el('ul', 'work-rel-list');
        list.setAttribute('aria-label', `Created from ${parent.key}`);
        list.append(row(parent));
        rel.append(el('p', 'work-rel-label', `Created from ${parent.key}`), list);
      }
      if (children.length) {
        const list = el('ul', 'work-rel-list');
        list.setAttribute('aria-label', 'Items created from this');
        list.append(...children.map(row));
        rel.append(el('p', 'work-rel-label', `Items created from this · ${children.length}`), list);
      }
      parts.push(rel);
    }

    const hist = el('ol', 'work-hist');
    hist.setAttribute('aria-label', 'History');
    for (const event of item.history.slice(0, 12)) {
      const li = el('li');
      const time = el('time', '', clock(event.at));
      time.dateTime = new Date(event.at).toISOString();
      li.append(time, `${authorLabel(event.author, sessions)} · ${event.text}`);
      hist.append(li);
    }
    const histSec = el('div', 'work-sec');
    histSec.append(el('h3', '', 'History'), hist);
    parts.push(histSec);

    this.detail.replaceChildren(...parts);
    if (keep)
      this.detail
        .querySelector<HTMLElement>(`[data-work-detail="${CSS.escape(keep)}"]`)
        ?.focus({ preventScroll: true });
  }

  private field(label: string, control: HTMLElement): HTMLElement {
    const row = el('div', 'work-field');
    const name = el('span', 'work-field-name', label);
    const id = `workField${label}`;
    name.id = id;
    control.setAttribute('aria-labelledby', id);
    row.append(name, control);
    return row;
  }

  private assigneeMenu(item: WorkRow): HTMLElement {
    const menu = el('div', 'work-menu');
    menu.setAttribute('role', 'group');
    menu.setAttribute('aria-label', 'Assign to');
    const choose = (assignee: WorkRow['assignee']) => {
      this.menu = false;
      void this.patch(item, { assignee });
    };
    const option = (label: string, mark: string, onclick: () => void, kind = '') => {
      const b = btn('', '', onclick);
      const av = el('span', `work-av${kind}`, mark);
      av.setAttribute('aria-hidden', 'true');
      b.append(av, label);
      return b;
    };
    menu.append(
      option('You', 'Y', () => choose({ kind: 'person' })),
      option('Nobody', '–', () => choose(null))
    );
    const live = this.sessions.filter((s) => s.state !== 'done');
    if (live.length) menu.append(el('p', 'work-menu-group', 'Agent sessions'));
    for (const s of live) {
      const b = btn('', '', () => choose({ kind: 'session', sessionId: s.id }));
      const glyph = el('span', 'work-glyph', STATE_GLYPHS[s.state]);
      glyph.setAttribute('aria-hidden', 'true');
      b.append(glyph, s.name);
      b.setAttribute('aria-label', `${s.name}, ${STATE_WORDS[s.state]}`);
      menu.append(b);
    }
    if (!live.length) menu.append(el('p', 'work-menu-group', 'No running sessions in this case'));
    menu.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.menu = false;
        this.paintDetail();
        this.detail.querySelector<HTMLElement>('[data-work-detail="assignee"]')?.focus();
      }
    });
    queueMicrotask(() => menu.querySelector<HTMLElement>('button')?.focus());
    return menu;
  }

  stop(): void {
    clearTimeout(this.reloadTimer);
    clearTimeout(this.sessionsTimer);
    clearTimeout(this.toastTimer);
  }
}

function icon(d: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}
