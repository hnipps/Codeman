/** The background task list in the rail: one row per task with its state, result and links. Everything is `textContent`; a task is started from the assistant, never from here. */
import { label, type ViewObject } from './model.js';
import { canvasStorageKeys } from './storage-keys.js';
import { errorMessage } from './conversation.js';
import {
  KEPT_REASON,
  STATE_LABEL,
  parseSeen,
  seenAfterOpen,
  sortTasks,
  taskActionFailure,
  taskActive,
  taskCount,
  taskMeta,
  type TaskRow,
} from './task.js';

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
};
const node = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing canvas element: ${id}`);
  return el;
};
const REFRESH_MS = 400;
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
  private seen: Set<string>;
  private seenKey: string;
  private signature = '';
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
  /** Reads the list again; a failed read keeps what is shown. */
  async refresh(): Promise<void> {
    if (this.stopped) return;
    try {
      const response = await fetch(this.options.url(`/api/canvas/${this.options.workspace}/tasks`));
      const body: unknown = await response.json();
      const tasks =
        typeof body === 'object' && body !== null && 'data' in body
          ? (body.data as { tasks?: unknown } | null)?.tasks
          : undefined;
      if (!response.ok || !Array.isArray(tasks)) return;
      this.rows = tasks as TaskRow[];
    } catch {
      return;
    }
    this.paint();
  }
  private soon(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), REFRESH_MS);
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
    const id = data.id ?? data.sessionId ?? session;
    if (this.rows.some((r) => r.sessionId === id)) this.soon();
  }
  /** Called on every paint of the page: opening the list marks what has finished as seen. */
  sync(): void {
    const open = this.options.open();
    if (open && !this.wasOpen) {
      this.markSeen();
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
      this.confirming,
      [...this.busy],
      [...this.notes],
      rows.map((r) => [r.refs.map((ref) => name(ref.id) !== null), r.origin ? name(r.origin.objectId) : null]),
    ]);
    if (signature === this.signature) return;
    this.signature = signature;
    const list = node('taskList');
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.taskControl : null;
    list.replaceChildren(...rows.map((row) => this.row(row, name)));
    node('tasksEmpty').hidden = rows.length > 0;
    if (focused)
      list.querySelector<HTMLElement>(`[data-task-control="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }
  private row(row: TaskRow, name: (id: string) => string | null): HTMLElement {
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
    if (row.result) {
      const result = document.createElement('p');
      result.className = 'task-result';
      result.textContent = row.result.truncated ? `${row.result.text}…` : row.result.text;
      item.append(result);
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
    if (!row.kept) actions.append(control('Inspect', 'inspect', () => this.options.inspect(row.id)));
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
