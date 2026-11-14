/** The background task list in the rail: one row per task with its state, result and links. The agent's result renders as Markdown (markdown.ts); everything else is `textContent`. A task is started from the assistant, never from here. */
import { label, type ViewObject } from './model.js';
import { canvasStorageKeys } from './storage-keys.js';
import { errorMessage } from './conversation.js';
import { hydrateDiagrams, renderMarkdown } from './markdown.js';
import {
  KEPT_REASON,
  STATE_LABEL,
  parseSeen,
  seenAfterOpen,
  sortTasks,
  taskActionFailure,
  taskActive,
  taskAsides,
  taskCount,
  taskMeta,
  type TaskRow,
} from './task.js';
import type { LeftBehindRow } from '../../../src/canvas/tasks.js';

type Options = {
  url: (path: string) => string;
  workspace: string;
  viewer: string;
  objects: () => ViewObject[];
  /** Whether the list is the rail view on screen. */
  open: () => boolean;
  /** Selects the objects a task carried; the camera stays where it is. */
  select: (ids: string[]) => void;
  /** Selects an object and opens its comment thread. */
  openThread: (objectId: string) => void;
  /** Shows the task's own session in the assistant rail. */
  inspect: (conversationId: string) => void;
  /** The list was read: the assistant settles a run a reload interrupted. */
  listed?: (rows: readonly Pick<TaskRow, 'id' | 'requestId' | 'name'>[]) => void;
  /** Whether this browser still holds a task's request, and sending it again; both live in the assistant, which alone starts tasks. */
  canRetry?: (id: string) => boolean;
  retry?: (id: string) => Promise<string | null>;
};
const node = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing canvas element: ${id}`);
  return el;
};
const REFRESH_MS = 400;
/** With the list closed only the count is kept current, by one small request at most this often. */
const COUNT_REFRESH_MS = 2_000;
/** Session events that can change a task's state. */
const SESSION_EVENTS = new Set([
  'session:working',
  'session:idle',
  'session:exit',
  'session:deleted',
  'session:error',
  'session:updated',
  'hook:stop',
  'hook:idle_prompt',
  'hook:prompt_submitted',
  'approval:pending',
  'approval:updated',
  'approval:resolved',
]);

export class TasksView {
  private rows: TaskRow[] = [];
  private left: LeftBehindRow[] = [];
  private seen: Set<string>;
  private seenKey: string;
  private signature = '';
  /** A result rendered on an earlier paint, keyed by task and text, so its diagram is drawn once and not on every poll. */
  private rendered = new Map<string, HTMLElement>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private wasOpen = false;
  /** The row whose Remove asked for confirmation, and rows with a request travelling. */
  private confirming: string | null = null;
  private busy = new Set<string>();
  private notes = new Map<string, string>();
  constructor(private options: Options) {
    this.seenKey = canvasStorageKeys(options.viewer, options.workspace).tasksSeen;
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(this.seenKey);
    } catch {
      /* Without storage every finished task counts once per load. */
    }
    this.seen = new Set(parseSeen(stored));
    void this.refresh();
  }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }
  all(): readonly TaskRow[] {
    return this.rows;
  }
  /**
   * Reads the list again; a failed read keeps what is shown. `brief` asks only for each task's state, which is all
   * the count of a closed list needs: results, links and left-behind worktrees are read when the list is opened.
   */
  async refresh(brief = false): Promise<void> {
    if (this.stopped) return;
    try {
      const response = await fetch(
        this.options.url(`/api/canvas/${this.options.workspace}/tasks${brief ? '?brief=1' : ''}`)
      );
      const body: unknown = await response.json();
      const data =
        typeof body === 'object' && body !== null && 'data' in body
          ? (body.data as { tasks?: unknown; leftBehind?: unknown } | null)
          : null;
      const tasks = data?.tasks;
      if (!response.ok || !Array.isArray(tasks)) return;
      if (brief) {
        // Only the states move; a task not seen before is listed with what the brief answer carries until the list opens.
        const known = new Map(this.rows.map((r) => [r.id, r]));
        this.rows = (tasks as Pick<TaskRow, 'id' | 'requestId' | 'name' | 'createdAt' | 'state'>[]).map((t) => {
          const row = known.get(t.id);
          return row
            ? { ...row, state: t.state }
            : ({
                ...t,
                sessionId: '',
                cliId: '',
                cliLabel: '',
                isolation: { kind: 'shared', label: '' },
                refs: [],
              } as TaskRow);
        });
      } else {
        this.rows = tasks as TaskRow[];
        this.left = Array.isArray(data?.leftBehind) ? (data.leftBehind as LeftBehindRow[]) : [];
      }
    } catch {
      return;
    }
    this.options.listed?.(this.rows);
    this.paint();
  }
  /** An open list is read whole and soon; a closed one only has a count to keep, so its read is brief and debounced longer. */
  private soon(): void {
    const open = this.options.open();
    if (!open && this.timer !== undefined) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.refresh(!this.options.open());
      },
      open ? REFRESH_MS : COUNT_REFRESH_MS
    );
  }
  /** One server event. Nothing here moves the camera, the selection or focus. */
  event(name: string, raw: string): void {
    if (this.stopped) return;
    let data: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) data = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (name === 'canvas:conversation') {
      if (data.workspaceId === this.options.workspace) this.soon();
      return;
    }
    if (!SESSION_EVENTS.has(name)) return;
    const session = (data.session as { id?: unknown } | undefined)?.id;
    // An approval event's `id` is the approval's own; its session is named beside it.
    const ids = [data.sessionId, data.id, session];
    // A row from a brief read has no session id yet; then any session's event may be a task's.
    if (this.rows.some((r) => ids.includes(r.sessionId) || (!r.sessionId && taskActive(r.state)))) this.soon();
  }
  /** Called on every paint of the page: opening the list marks what has finished as seen. */
  sync(): void {
    const open = this.options.open();
    if (open && !this.wasOpen) {
      this.markSeen();
      clearTimeout(this.timer);
      this.timer = undefined;
      void this.refresh();
      this.signature = '';
    }
    this.wasOpen = open;
    this.paint();
  }
  private markSeen(): void {
    const next = seenAfterOpen(this.rows);
    this.seen = new Set(next);
    try {
      if (next.length) localStorage.setItem(this.seenKey, JSON.stringify(next));
      else localStorage.removeItem(this.seenKey);
    } catch {
      /* The count is right for this load either way. */
    }
  }
  private async act(row: TaskRow, method: 'POST' | 'DELETE', path: string): Promise<void> {
    if (this.busy.has(row.id)) return;
    this.busy.add(row.id);
    this.notes.delete(row.id);
    this.paint();
    try {
      const response = await fetch(this.options.url(`/api/canvas/${this.options.workspace}/tasks/${row.id}${path}`), {
        method,
        ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
      });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        /* Reported by status alone. */
      }
      if (!response.ok) this.notes.set(row.id, taskActionFailure(errorMessage(body), response.status));
      else if (method === 'DELETE') {
        const data = (body as { data?: { removed?: boolean; branchKept?: string } } | null)?.data;
        if (data?.removed && data.branchKept)
          node('tasksStatus').textContent = `Task removed. Its branch ${data.branchKept} holds commits and was kept.`;
        else if (data?.removed) node('tasksStatus').textContent = 'Task removed.';
      }
    } catch {
      this.notes.set(row.id, 'Could not reach the server. Try again.');
    }
    this.busy.delete(row.id);
    this.confirming = null;
    await this.refresh();
    this.paint();
  }
  private async retry(row: TaskRow): Promise<void> {
    if (this.busy.has(row.id) || !this.options.retry) return;
    this.busy.add(row.id);
    this.notes.delete(row.id);
    this.paint();
    const refusal = await this.options.retry(row.id);
    if (refusal) this.notes.set(row.id, refusal);
    this.busy.delete(row.id);
    await this.refresh();
    this.paint();
  }
  /** Removes a left-behind worktree with the same non-force rule as a task's; what git keeps is said in the status line. */
  private async removeLeft(row: LeftBehindRow): Promise<void> {
    const key = `left:${row.name}`;
    if (this.busy.has(key)) return;
    this.busy.add(key);
    this.paint();
    let said = 'Could not reach the server. Try again.';
    try {
      const response = await fetch(
        this.options.url(`/api/canvas/${this.options.workspace}/tasks/left-behind/${encodeURIComponent(row.name)}`),
        { method: 'DELETE' }
      );
      const body = (await response.json().catch(() => null)) as {
        data?: { removed?: boolean; branchKept?: string; kept?: { label: string; reason: keyof typeof KEPT_REASON } };
      } | null;
      const data = body?.data;
      if (!response.ok) said = taskActionFailure(errorMessage(body), response.status);
      else if (data?.removed)
        said = data.branchKept
          ? `Worktree removed. Its branch ${data.branchKept} holds commits and was kept.`
          : 'Worktree removed.';
      else if (data?.kept) said = `The worktree ${data.kept.label} ${KEPT_REASON[data.kept.reason] ?? 'was kept'}.`;
    } catch {
      /* Said below. */
    }
    node('tasksStatus').textContent = said;
    this.busy.delete(key);
    this.confirming = null;
    await this.refresh();
    this.paint();
  }

  /** The agent's result as rendered Markdown, or as plain text on a page without the renderer. */
  private result(id: string, result: NonNullable<TaskRow['result']>, used: Map<string, HTMLElement>): HTMLElement {
    const key = `${id}\0${result.text}`;
    const body = this.rendered.get(key) ?? renderMarkdown(result.text);
    if (body) {
      body.classList.add('task-result');
      used.set(key, body);
      return body;
    }
    const text = document.createElement('p');
    text.className = 'task-result';
    text.textContent = result.truncated ? `${result.text}…` : result.text;
    return text;
  }
  private leftRow(row: LeftBehindRow): HTMLElement {
    const key = `left:${row.name}`;
    const item = document.createElement('li');
    item.className = 'task-row';
    item.dataset.leftBehind = row.name;
    const title = document.createElement('p');
    title.className = 'task-name';
    title.textContent = 'Worktree left behind';
    const meta = document.createElement('p');
    meta.className = 'task-meta';
    meta.textContent = [row.label, row.branch ?? ''].filter(Boolean).join(' · ');
    const why = document.createElement('p');
    why.className = 'task-kept';
    why.textContent = 'No task names this worktree and no session is in it. It may hold work, so it was not removed.';
    const control = (text: string, kind: string, run: () => void, primary = false): HTMLButtonElement => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = primary ? 'primary' : 'quiet';
      button.textContent = text;
      button.dataset.taskControl = `${key}:${kind}`;
      button.toggleAttribute('disabled', this.busy.has(key));
      button.addEventListener('click', run);
      return button;
    };
    const focus = (kind: string): void =>
      node('taskList')
        .querySelector<HTMLElement>(`[data-task-control="${CSS.escape(`${key}:${kind}`)}"]`)
        ?.focus({ preventScroll: true });
    const actions = document.createElement('div');
    actions.className = 'task-actions';
    item.append(title, meta, why, actions);
    if (this.confirming !== key) {
      actions.append(
        control('Remove', 'remove', () => {
          this.confirming = key;
          this.paint();
          focus('keep');
        })
      );
      return item;
    }
    const confirm = document.createElement('div');
    confirm.className = 'revert-confirm';
    confirm.setAttribute('role', 'group');
    confirm.setAttribute('aria-label', `Remove ${row.label}`);
    const text = document.createElement('p');
    text.textContent = 'Remove this worktree? It is removed only if it has no changes.';
    const buttons = document.createElement('div');
    buttons.className = 'revert-actions';
    buttons.append(
      control('Keep', 'keep', () => {
        this.confirming = null;
        this.paint();
        focus('remove');
      }),
      control('Remove worktree', 'confirm', () => void this.removeLeft(row), true)
    );
    confirm.append(text, buttons);
    item.append(confirm);
    return item;
  }
  private paint(): void {
    const open = this.options.open();
    // A list that is open has been seen: what finishes while it is on screen never raises the count.
    if (open && seenAfterOpen(this.rows).some((id) => !this.seen.has(id))) this.markSeen();
    const count = open ? 0 : taskCount(this.rows, this.seen);
    for (const id of ['tasksCount', 'tasksOpenCount']) {
      const badge = node(id);
      badge.textContent = count ? String(count) : '';
      badge.hidden = !count;
    }
    const named = count ? `Background tasks, ${count} to look at` : 'Background tasks';
    node('tasksTool').setAttribute('aria-label', named);
    node('tasksOpen').setAttribute('aria-label', named);
    node('tasksOpen').hidden = !this.rows.length;
    if (!open) return;
    const objects = this.options.objects();
    const name = (id: string): string | null => {
      const object = objects.find((o) => o.id === id);
      return object ? label(object) : null;
    };
    const rows = sortTasks(this.rows);
    const signature = JSON.stringify([
      rows,
      this.left,
      rows.map((r) => this.options.canRetry?.(r.id) === true),
      this.confirming,
      [...this.busy],
      [...this.notes],
      rows.map((r) => [r.refs.map((ref) => name(ref.id) !== null), r.origin ? name(r.origin.objectId) : null]),
    ]);
    if (signature === this.signature) return;
    this.signature = signature;
    const list = node('taskList');
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.taskControl : null;
    const rendered = new Map<string, HTMLElement>();
    list.replaceChildren(
      ...rows.map((row) => this.row(row, name, rendered)),
      ...this.left.map((row) => this.leftRow(row))
    );
    this.rendered = rendered;
    hydrateDiagrams(list);
    node('tasksEmpty').hidden = rows.length + this.left.length > 0;
    if (focused)
      list.querySelector<HTMLElement>(`[data-task-control="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }
  private row(row: TaskRow, name: (id: string) => string | null, rendered: Map<string, HTMLElement>): HTMLElement {
    const item = document.createElement('li');
    item.className = 'task-row';
    item.dataset.taskId = row.id;
    item.dataset.state = row.state;
    const title = document.createElement('p');
    title.className = 'task-name';
    title.textContent = row.name;
    const state = document.createElement('p');
    state.className = 'task-state';
    state.dataset.state = row.state;
    state.textContent = STATE_LABEL[row.state] ?? row.state;
    const meta = document.createElement('p');
    meta.className = 'task-meta';
    meta.textContent = taskMeta(row);
    item.append(title, state, meta);
    for (const text of taskAsides(row)) {
      const aside = document.createElement('p');
      aside.className = 'task-kept';
      aside.textContent = text;
      item.append(aside);
    }
    if (row.result) {
      if (row.result.partial) {
        const lead = document.createElement('p');
        lead.className = 'task-meta';
        lead.textContent = 'The agent exited before its turn ended. What it had written:';
        item.append(lead);
      }
      item.append(this.result(row.id, row.result, rendered));
      if (row.result.truncated) {
        const more = document.createElement('p');
        more.className = 'task-meta';
        more.textContent = 'The rest of the result is in the task’s session. Use Inspect.';
        item.append(more);
      }
    }
    if (row.kept) {
      const kept = document.createElement('p');
      kept.className = 'task-kept';
      kept.textContent = `The worktree ${row.kept.label} ${KEPT_REASON[row.kept.reason] ?? 'was kept'}.`;
      item.append(kept);
    }
    const control = (text: string, kind: string, run: () => void, primary = false): HTMLButtonElement => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = primary ? 'primary' : 'quiet';
      button.textContent = text;
      button.dataset.taskControl = `${row.id}:${kind}`;
      button.toggleAttribute('disabled', this.busy.has(row.id));
      button.addEventListener('click', run);
      return button;
    };
    const links = document.createElement('div');
    links.className = 'task-links';
    if (row.refs.length) {
      const present = row.refs.filter((ref) => name(ref.id) !== null).map((ref) => ref.id);
      const refs = control(
        row.refs.length === 1 ? `Context: ${row.refs[0].label}` : `Context: ${row.refs.length} objects`,
        'refs',
        () => this.options.select(present)
      );
      refs.title = present.length ? 'Select these objects on the canvas' : 'These objects are no longer on the canvas';
      refs.toggleAttribute('disabled', !present.length);
      links.append(refs);
    }
    if (row.origin) {
      const { objectId } = row.origin;
      const on = name(objectId);
      const origin = control(on ? `From a comment on ${on}` : 'From a comment on a removed object', 'origin', () =>
        this.options.openThread(objectId)
      );
      origin.toggleAttribute('disabled', on === null);
      links.append(origin);
    }
    if (links.childElementCount) item.append(links);
    const actions = document.createElement('div');
    actions.className = 'task-actions';
    if (!row.kept && row.sessionId) actions.append(control('Inspect', 'inspect', () => this.options.inspect(row.id)));
    if (row.retryable && this.options.canRetry?.(row.id))
      actions.append(control('Retry', 'retry', () => void this.retry(row)));
    if (taskActive(row.state)) actions.append(control('Cancel', 'cancel', () => void this.act(row, 'POST', '/cancel')));
    else if (this.confirming !== row.id)
      actions.append(
        control('Remove', 'remove', () => {
          this.confirming = row.id;
          this.paint();
          node('taskList')
            .querySelector<HTMLElement>(`[data-task-control="${CSS.escape(`${row.id}:keep`)}"]`)
            ?.focus({ preventScroll: true });
        })
      );
    item.append(actions);
    if (this.confirming === row.id && !taskActive(row.state)) {
      const confirm = document.createElement('div');
      confirm.className = 'revert-confirm';
      confirm.setAttribute('role', 'group');
      confirm.setAttribute('aria-label', `Remove ${row.name}`);
      const text = document.createElement('p');
      text.textContent =
        row.isolation.kind === 'worktree'
          ? 'Remove this task? Its session ends. Its worktree is removed only if it has no changes.'
          : 'Remove this task? Its session ends. The case folder is left as it is.';
      const buttons = document.createElement('div');
      buttons.className = 'revert-actions';
      buttons.append(
        control('Keep', 'keep', () => {
          this.confirming = null;
          this.paint();
          node('taskList')
            .querySelector<HTMLElement>(`[data-task-control="${CSS.escape(`${row.id}:remove`)}"]`)
            ?.focus({ preventScroll: true });
        }),
        control('Remove task', 'confirm', () => void this.act(row, 'DELETE', ''), true)
      );
      confirm.append(text, buttons);
      item.append(confirm);
    }
    const note = this.notes.get(row.id);
    if (note) {
      const line = document.createElement('p');
      line.className = 'task-note';
      line.setAttribute('role', 'status');
      line.textContent = note;
      item.append(line);
    }
    return item;
  }
}
