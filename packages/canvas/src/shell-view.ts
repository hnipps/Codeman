/**
 * @fileoverview The canvas shell in the outline (PC13): the workspace list, the Sessions section, Go to and the
 * one notice line.
 *
 * Runs only on a shell page (`shellOn()`), never in a canvas that is a tab inside the dashboard. It reads
 * sessions and workspaces and starts a session through the route the dashboard's Run button uses. It sends no
 * input to a session and writes nothing to the canvas: a session row is not canvas content. Every name reaches
 * the page through `textContent`.
 */
import {
  GOTO_GROUPS,
  gotoResults,
  launchChoices,
  newlyNeeding,
  parseSessions,
  sessionRows,
  withStarted,
  type GotoResult,
  type SessionViewRow,
  type ShellSessionRow,
} from './sessions.js';
import {
  caseChoices,
  parseCases,
  parseWorkspaces,
  refusalText,
  succeeded,
  workspaceHref,
  workspaceRows,
  type WorkspaceEntry,
} from './workspaces.js';
import { createCaseWorkspace, workspaceOfCase, type Made } from './workspace-actions.js';
import { releaseUnseen, securityNoticeDue, seenNotices, shellLine } from './shell-notices.js';

export type ShellHost = {
  url(path: string): string;
  workspaceId: string;
  /** Objects of the open view, for Go to. */
  objects(): { id: string; label: string }[];
  focusObject(id: string): void;
  openOutline(): void;
  /** `row`: what Enter on the row does. `terminal`: the session's terminal, whatever its kind. */
  openSession(row: SessionViewRow, how: 'row' | 'terminal', opener: HTMLElement | null): void;
  navigate(href: string): void;
  /** The workspace list arrived: the page shows the current workspace's name. */
  named(name: string): void;
};

const REFRESH_DELAY_MS = 400;
const OFFLINE_REASON = 'Unavailable while Codeman cannot be reached';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  if (className) made.className = className;
  if (text) made.textContent = text;
  return made;
}
function byId<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`Missing canvas element: ${id}`);
  return found;
}
const node = (id: string): HTMLElement => byId(id, HTMLElement);
const button = (id: string): HTMLButtonElement => byId(id, HTMLButtonElement);

/** Arrow keys move among the focusable rows of a list; Home and End jump. */
function rove(container: HTMLElement, selector: string): void {
  container.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || e.altKey || e.metaKey || e.ctrlKey) return;
    if (e.target instanceof HTMLInputElement) return;
    const rows = [...container.querySelectorAll<HTMLElement>(selector)].filter((r) => !r.hidden && r.offsetParent);
    if (!rows.length) return;
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? rows.length - 1
          : Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
    e.preventDefault();
    e.stopPropagation();
    rows[next]?.focus();
  });
}

export class ShellView {
  private sessions: ShellSessionRow[] = [];
  private rows: SessionViewRow[] = [];
  private sessionsLoaded = false;
  private sessionsFailed = false;
  private workspaces: WorkspaceEntry[] | null = null;
  private workspacesFailed = false;
  private online = true;
  private fetching = false;
  private again = false;
  private timer = 0;
  private stopped = false;
  private starting = false;
  private making = false;
  private goto = false;
  private searchPlaceholder = '';

  constructor(private host: ShellHost) {
    this.searchPlaceholder = this.search.placeholder;
    button('workspaceSwitch').onclick = () => this.toggleWorkspaces();
    button('newWorkspace').onclick = () => void this.toggleNewWorkspace();
    button('workspaceListRetry').onclick = () => void this.loadWorkspaces();
    button('createCase').onclick = () => void this.createCase();
    this.caseName.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      void this.createCase();
    });
    button('newSession').onclick = () => void this.toggleNewSession();
    button('sessionsRetry').onclick = () => void this.refresh();
    this.closeOnEscape(node('workspaceList'), () => this.closeWorkspaces(true));
    this.closeOnEscape(node('newSessionList'), () => this.closeNewSession(true));
    rove(node('workspaceList'), 'a.workspace-row, button');
    rove(node('newSessionList'), 'button');
    rove(node('sessionRows'), 'button.session-row');
    rove(node('gotoResults'), 'button, a');
    this.search.addEventListener('input', () => {
      if (this.goto) this.paintGoto();
    });
    this.search.addEventListener('keydown', (e) => this.searchKey(e));
    node('gotoResults').addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      this.search.focus();
    });
    node('outline').addEventListener('focusout', (e) => {
      const next = e.relatedTarget;
      if (!this.goto || (next instanceof Node && (next === this.search || node('gotoResults').contains(next)))) return;
      // Focus left Go to for something else on the page: the plain search is back.
      if (next instanceof Node) this.endGoto();
    });
    document.addEventListener('visibilitychange', this.visible);
  }

  private get search(): HTMLInputElement {
    return byId('search', HTMLInputElement);
  }
  private get caseName(): HTMLInputElement {
    return byId('newCaseName', HTMLInputElement);
  }
  private visible = (): void => {
    if (document.visibilityState === 'visible') this.event();
  };
  private closeOnEscape(container: HTMLElement, close: () => void): void {
    container.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    });
  }

  start(): void {
    void this.loadWorkspaces();
    void this.refresh();
    void this.loadLine();
  }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    document.removeEventListener('visibilitychange', this.visible);
  }

  /** A server event that can change a session's row. The list is fetched again, shortly, once. */
  event(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.refresh(), REFRESH_DELAY_MS);
  }
  setOnline(online: boolean): void {
    if (this.online === online) return;
    this.online = online;
    this.paintSessions();
    this.paintAvailability();
    if (online) this.event();
  }
  /** The rows as drawn, for Go to and for tests. */
  read(): SessionViewRow[] {
    return this.rows;
  }
  workspaceName(): string {
    return this.workspaces?.find((w) => w.id === this.host.workspaceId)?.caseName ?? '';
  }

  // ---- Sessions ----

  async refresh(): Promise<void> {
    if (this.stopped) return;
    if (this.fetching) {
      this.again = true;
      return;
    }
    this.fetching = true;
    try {
      const response = await fetch(this.host.url(`/api/canvas/${this.host.workspaceId}/sessions`));
      const rows = response.ok ? parseSessions(await response.json()) : null;
      if (rows) {
        const names = newlyNeeding(this.sessions, rows);
        if (this.sessionsLoaded && names.length)
          node('sessionsAnnounce').textContent =
            names.length === 1 ? `${names[0]} needs you` : `${names.length} sessions need you`;
        this.sessions = rows;
        this.sessionsLoaded = true;
        this.sessionsFailed = false;
      } else this.sessionsFailed = true;
    } catch {
      this.sessionsFailed = true;
    } finally {
      this.fetching = false;
    }
    if (this.stopped) return;
    this.paintSessions();
    if (this.goto) this.paintGoto();
    if (this.again) {
      this.again = false;
      void this.refresh();
    }
  }

  private paintSessions(): void {
    this.rows = sessionRows(this.sessions);
    const list = node('sessionRows');
    const focused =
      document.activeElement instanceof HTMLElement ? document.activeElement.dataset.sessionId : undefined;
    const focusedTerminal = document.activeElement?.classList.contains('session-terminal') === true;
    list.replaceChildren(
      ...this.rows.map((row) => {
        const item = el('li', 'session-item');
        const open = el('button', 'session-row');
        open.type = 'button';
        open.dataset.sessionId = row.id;
        open.dataset.state = row.state;
        open.dataset.kind = row.kind;
        open.setAttribute('aria-label', row.label);
        open.title = row.name;
        const glyph = el('span', 'session-glyph', row.glyph);
        glyph.setAttribute('aria-hidden', 'true');
        open.append(
          glyph,
          el('span', 'session-name', row.name),
          el('span', 'session-meta', `${row.kindWord} · ${row.stateWord}`)
        );
        open.onclick = () => {
          if (this.available(open)) this.host.openSession(row, 'row', open);
        };
        item.append(open);
        if (row.kind !== 'terminal') {
          const terminal = el('button', 'session-terminal quiet', 'Open terminal');
          terminal.type = 'button';
          terminal.dataset.sessionId = row.id;
          terminal.setAttribute('aria-label', `Open terminal of ${row.name}`);
          terminal.onclick = () => {
            if (this.available(terminal)) this.host.openSession(row, 'terminal', terminal);
          };
          item.append(terminal);
        }
        return item;
      })
    );
    if (focused) {
      const selector = focusedTerminal ? 'button.session-terminal' : 'button.session-row';
      [...list.querySelectorAll<HTMLElement>(selector)].find((b) => b.dataset.sessionId === focused)?.focus();
    }
    const state = node('sessionsState');
    const failed = this.sessionsFailed && this.online;
    const text = failed
      ? 'Sessions could not load'
      : !this.online
        ? this.sessionsLoaded
          ? 'Last known sessions. Codeman cannot be reached.'
          : 'Sessions are unavailable while Codeman cannot be reached.'
        : this.sessionsLoaded && !this.rows.length
          ? 'No sessions'
          : '';
    state.textContent = text;
    state.hidden = !text;
    button('sessionsRetry').hidden = !failed;
    node('sessions').toggleAttribute('data-stale', !this.online || this.sessionsFailed);
    this.paintAvailability();
  }

  /** Offline, the controls that need the server say why they are unavailable; they stay focusable. */
  private paintAvailability(): void {
    const off = !this.online;
    for (const control of [button('newSession'), button('newWorkspace')]) {
      control.setAttribute('aria-disabled', String(off));
      if (off) control.title = OFFLINE_REASON;
      else control.removeAttribute('title');
    }
    for (const control of node('sessionRows').querySelectorAll<HTMLButtonElement>('button')) {
      const terminal = control.classList.contains('session-terminal') || control.dataset.kind === 'terminal';
      control.setAttribute('aria-disabled', String(off && terminal));
      if (off && terminal) control.title = OFFLINE_REASON;
    }
    if (off) {
      this.closeNewSession(false);
      node('newWorkspaceForm').hidden = true;
      button('newWorkspace').setAttribute('aria-expanded', 'false');
    }
  }
  /** False when the control is unavailable; the reason is then announced where the control describes itself. */
  available(control: HTMLElement | null): boolean {
    return control?.getAttribute('aria-disabled') !== 'true';
  }

  focusSessions(): void {
    this.host.openOutline();
    requestAnimationFrame(() => {
      const first = node('sessionRows').querySelector<HTMLElement>('button.session-row') ?? button('newSession');
      first.focus();
    });
  }

  private async toggleNewSession(): Promise<void> {
    const opener = button('newSession');
    if (!this.available(opener)) {
      node('newSessionReason').textContent = OFFLINE_REASON;
      return;
    }
    if (!node('newSessionList').hidden) return this.closeNewSession(true);
    opener.setAttribute('aria-expanded', 'true');
    const list = node('newSessionList');
    list.hidden = false;
    list.replaceChildren(el('p', 'shell-note', 'Loading…'));
    node('newSessionReason').textContent = '';
    let providers: { id: string; label: string; available: boolean; reason?: string }[] = [];
    try {
      const response = await fetch(this.host.url('/api/canvas/assistant/providers'));
      const body = (await response.json()) as { data?: { providers?: unknown } };
      if (Array.isArray(body.data?.providers))
        providers = body.data.providers.flatMap((p) => {
          const row = p as { id?: unknown; label?: unknown; available?: unknown; reason?: unknown };
          return typeof row.id === 'string' && typeof row.label === 'string'
            ? [
                {
                  id: row.id,
                  label: row.label,
                  available: row.available === true,
                  ...(typeof row.reason === 'string' ? { reason: row.reason } : {}),
                },
              ]
            : [];
        });
    } catch {
      /* The shell is still offered; the agent list is what could not load. */
    }
    if (list.hidden) return;
    list.replaceChildren(
      ...launchChoices(providers).map((choice) => {
        const start = el('button', 'launch-row', choice.label);
        start.type = 'button';
        start.dataset.mode = choice.mode;
        if (!choice.available) {
          start.setAttribute('aria-disabled', 'true');
          start.title = choice.reason;
          start.append(el('span', 'session-meta', choice.reason));
        }
        start.onclick = () => void this.startSession(choice.mode, choice.label, start);
        return start;
      })
    );
    list.querySelector<HTMLElement>('button:not([aria-disabled="true"])')?.focus();
  }
  private closeNewSession(focus: boolean): void {
    node('newSessionList').hidden = true;
    button('newSession').setAttribute('aria-expanded', 'false');
    if (focus) button('newSession').focus();
  }

  /** Starts one session in this workspace's case. One request per choice, however often it is pressed. */
  private async startSession(mode: string, label: string, control: HTMLElement): Promise<void> {
    if (this.starting || !this.available(control)) return;
    const caseName = this.workspaceName();
    const reason = node('newSessionReason');
    if (!caseName) {
      reason.textContent = 'The workspace list has not loaded yet. Try again in a moment.';
      return;
    }
    this.starting = true;
    control.setAttribute('aria-busy', 'true');
    reason.textContent = `Starting ${label}…`;
    let status = 0,
      body: unknown = null,
      ok = false;
    try {
      const response = await fetch(this.host.url('/api/quick-start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName, mode }),
      });
      status = response.status;
      ok = response.ok;
      body = await response.json().catch(() => null);
    } catch {
      /* status 0 reads as unreachable */
    }
    this.starting = false;
    control.removeAttribute('aria-busy');
    const answer = body as { sessionId?: unknown; data?: { sessionId?: unknown } } | null;
    const id = typeof answer?.sessionId === 'string' ? answer.sessionId : answer?.data?.sessionId;
    if (!succeeded(ok, body) || typeof id !== 'string' || !id) {
      reason.textContent = refusalText(status, body);
      return;
    }
    reason.textContent = '';
    this.closeNewSession(false);
    // The answer and the server's own event can arrive in either order: the row is added once.
    this.sessions = withStarted(this.sessions, { id, name: `${label} session`, mode, at: Date.now() });
    this.sessionsLoaded = true;
    this.paintSessions();
    void this.refresh();
    const row = this.rows.find((r) => r.id === id);
    const opener = [...node('sessionRows').querySelectorAll<HTMLElement>('button.session-row')].find(
      (b) => b.dataset.sessionId === id
    );
    if (row) this.host.openSession(row, 'terminal', opener ?? button('newSession'));
  }

  // ---- Workspaces ----

  async loadWorkspaces(): Promise<void> {
    try {
      const response = await fetch(this.host.url('/api/canvas/workspaces'));
      const list = response.ok ? parseWorkspaces(await response.json()) : null;
      if (list) {
        this.workspaces = list;
        this.workspacesFailed = false;
        const name = this.workspaceName();
        if (name) {
          button('workspaceSwitch').textContent = name;
          this.host.named(name);
        }
      } else this.workspacesFailed = true;
    } catch {
      this.workspacesFailed = true;
    }
    if (this.stopped) return;
    this.paintWorkspaces();
    if (this.goto) this.paintGoto();
  }

  private paintWorkspaces(): void {
    const rows = workspaceRows(this.workspaces ?? [], this.host.workspaceId);
    node('workspaceRows').replaceChildren(
      ...rows.map((row) => {
        const item = el('li');
        const link = el('a', 'workspace-row');
        link.href = workspaceHref(row.id);
        link.dataset.workspaceId = row.id;
        link.setAttribute('aria-label', row.label);
        link.title = row.name;
        if (row.current) link.setAttribute('aria-current', 'page');
        link.append(el('span', 'workspace-name', row.name));
        if (row.needsYou) link.append(el('span', 'workspace-count', String(row.needsYou)));
        item.append(link);
        return item;
      })
    );
    const state = node('workspaceListState');
    state.textContent = this.workspacesFailed ? 'Workspaces could not load' : '';
    state.hidden = !this.workspacesFailed;
    button('workspaceListRetry').hidden = !this.workspacesFailed;
  }

  toggleWorkspaces(): void {
    if (!node('workspaceList').hidden) return this.closeWorkspaces(true);
    this.host.openOutline();
    node('workspaceList').hidden = false;
    button('workspaceSwitch').setAttribute('aria-expanded', 'true');
    // Counts move while the page is open: the list is read again each time it opens.
    void this.loadWorkspaces().then(() => {
      if (node('workspaceList').hidden) return;
      const rows = node('workspaceRows');
      (
        rows.querySelector<HTMLElement>('[aria-current="page"]') ??
        rows.querySelector<HTMLElement>('a') ??
        button('newWorkspace')
      ).focus();
    });
  }
  private closeWorkspaces(focus: boolean): void {
    node('workspaceList').hidden = true;
    node('newWorkspaceForm').hidden = true;
    button('newWorkspace').setAttribute('aria-expanded', 'false');
    button('workspaceSwitch').setAttribute('aria-expanded', 'false');
    if (focus) button('workspaceSwitch').focus();
  }

  private async toggleNewWorkspace(): Promise<void> {
    const opener = button('newWorkspace');
    const form = node('newWorkspaceForm');
    const reason = node('newCaseReason');
    if (!this.available(opener)) {
      reason.textContent = OFFLINE_REASON;
      return;
    }
    if (!form.hidden) {
      form.hidden = true;
      opener.setAttribute('aria-expanded', 'false');
      return;
    }
    form.hidden = false;
    opener.setAttribute('aria-expanded', 'true');
    reason.textContent = '';
    const list = node('caseRows');
    list.replaceChildren();
    node('caseRowsTitle').hidden = true;
    try {
      const response = await fetch(this.host.url('/api/cases'));
      const cases = response.ok ? parseCases(await response.json()) : null;
      if (!cases) throw new Error('unreadable');
      list.replaceChildren(
        ...caseChoices(cases, this.workspaces ?? []).map((name) => {
          const item = el('li');
          const open = el('button', 'case-row', name);
          open.type = 'button';
          open.dataset.caseName = name;
          open.setAttribute('aria-label', `Open canvas for ${name}`);
          open.onclick = () => void this.make(() => workspaceOfCase(this.host.url, name), open);
          item.append(open);
          return item;
        })
      );
      node('caseRowsTitle').hidden = !list.children.length;
    } catch {
      reason.textContent = 'The cases could not load. A new case can still be named below.';
    }
    if (!form.hidden) (list.querySelector<HTMLElement>('button') ?? this.caseName).focus();
  }
  private createCase(): Promise<void> {
    const name = this.caseName.value.trim();
    return this.make(() => createCaseWorkspace(this.host.url, name), button('createCase'));
  }
  /** One create at a time; a refusal shows the server's reason under the field and keeps the text. */
  private async make(run: () => Promise<Made>, control: HTMLElement): Promise<void> {
    if (this.making) return;
    const reason = node('newCaseReason');
    if (!this.online) {
      reason.textContent = OFFLINE_REASON;
      return;
    }
    this.making = true;
    control.setAttribute('aria-busy', 'true');
    reason.textContent = 'Creating…';
    const made = await run();
    this.making = false;
    control.removeAttribute('aria-busy');
    if (!made.ok) {
      reason.textContent = made.reason;
      return;
    }
    reason.textContent = '';
    this.host.navigate(workspaceHref(made.workspaceId));
  }

  // ---- Go to ----

  /** Opens the outline and puts the search field in Go to mode. Typing still filters the object tree. */
  openGoto(): void {
    this.host.openOutline();
    this.goto = true;
    this.search.placeholder = 'Go to…';
    this.search.setAttribute('aria-label', 'Go to a session, workspace or object');
    this.search.setAttribute('aria-controls', 'gotoResults');
    this.paintGoto();
    requestAnimationFrame(() => {
      this.search.focus();
      this.search.select();
    });
  }
  private endGoto(): void {
    if (!this.goto) return;
    this.goto = false;
    this.search.placeholder = this.searchPlaceholder;
    this.search.removeAttribute('aria-controls');
    this.search.removeAttribute('aria-label');
    node('gotoResults').hidden = true;
    node('gotoResults').replaceChildren();
  }
  private results(): GotoResult[] {
    return gotoResults(this.search.value, {
      sessions: this.rows,
      workspaces: workspaceRows(this.workspaces ?? [], this.host.workspaceId),
      objects: this.host.objects(),
    });
  }
  private paintGoto(): void {
    const box = node('gotoResults');
    const results = this.results();
    const children: HTMLElement[] = [];
    for (const { group, title } of GOTO_GROUPS) {
      const rows = results.filter((r) => r.group === group);
      if (!rows.length) continue;
      const section = el('div', 'goto-group');
      section.setAttribute('role', 'group');
      section.setAttribute('aria-label', title);
      section.append(el('p', 'goto-title', title));
      for (const result of rows) {
        const open = el('button', 'goto-row');
        open.type = 'button';
        open.dataset.group = result.group;
        open.dataset.id = result.id;
        open.title = result.label;
        open.append(el('span', 'goto-name', result.label), el('span', 'session-meta', result.detail));
        open.onclick = () => this.openResult(result, open);
        section.append(open);
      }
      children.push(section);
    }
    if (!results.length) children.push(el('p', 'shell-note', 'Nothing here matches'));
    const more = el('a', 'goto-more', 'Past sessions and search across all sessions are in the classic view');
    more.href = 'classic';
    children.push(more);
    box.replaceChildren(...children);
    box.hidden = false;
  }
  private openResult(result: GotoResult, opener: HTMLElement): void {
    if (result.group === 'sessions') {
      const row = this.rows.find((r) => r.id === result.id);
      this.endGoto();
      if (row) this.host.openSession(row, 'row', opener);
    } else if (result.group === 'workspaces') this.host.navigate(workspaceHref(result.id));
    else {
      this.endGoto();
      this.host.focusObject(result.id);
    }
  }
  private searchKey(e: KeyboardEvent): void {
    if (!this.goto || e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.endGoto();
      return;
    }
    const first = node('gotoResults').querySelector<HTMLElement>('button.goto-row');
    if (e.key === 'ArrowDown' && first) {
      e.preventDefault();
      first.focus();
    } else if (e.key === 'Enter' && first) {
      e.preventDefault();
      e.stopPropagation();
      first.click();
    }
  }

  // ---- The notice line ----

  /** Reads what the classic view would tell the person and shows at most one line that links there. Writes nothing. */
  private async loadLine(): Promise<void> {
    const json = async (path: string): Promise<unknown> => {
      try {
        const response = await fetch(this.host.url(path), { cache: 'no-cache' });
        return response.ok ? await response.json() : null;
      } catch {
        return null;
      }
    };
    const [reboot, notices, release, providers] = await Promise.all([
      json('/api/reboot-restore'),
      json('/security-notices.json'),
      json('/whats-new.json'),
      json('/api/canvas/assistant/providers'),
    ]);
    if (this.stopped) return;
    let seen: string[] = [],
      seenVersion: string | null = null;
    let storage = true;
    try {
      seen = seenNotices(localStorage.getItem('codeman-security-notices-seen'));
      seenVersion = localStorage.getItem('codeman-whats-new-seen');
    } catch {
      // The dashboard shows neither notice when it cannot remember a close; nor does this line.
      storage = false;
    }
    const available: Record<string, boolean> = {};
    const listed = (providers as { data?: { providers?: unknown } } | null)?.data?.providers;
    if (Array.isArray(listed))
      for (const p of listed) {
        const row = p as { id?: unknown; available?: unknown };
        if (typeof row.id === 'string') available[row.id] = row.available === true;
      }
    const offered = (reboot as { sessions?: unknown } | null)?.sessions;
    const line = shellLine({
      reboot: Array.isArray(offered) ? offered.length : 0,
      security:
        storage &&
        securityNoticeDue((notices as { notices?: unknown } | null)?.notices, { seen, now: Date.now(), available }),
      release: storage && releaseUnseen(seenVersion, (release as { version?: unknown } | null)?.version),
    });
    const box = node('shellLine');
    box.hidden = !line;
    if (!line) return;
    box.dataset.kind = line.kind;
    const link = byId('shellLineLink', HTMLAnchorElement);
    link.textContent = line.text;
    link.title = `${line.text}. Opens the classic view.`;
  }
}
