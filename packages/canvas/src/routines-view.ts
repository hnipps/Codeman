/**
 * @fileoverview The Routines tab of the Work view (W-44): the canvas's routines as cards (title, triggers, next run,
 * an Enabled switch, Run now and the recent fires), and one edit form. The server is
 * `routes/canvas-routine-routes.ts`; the shapes are `src/canvas/routines.ts` (types only, imported for the page).
 *
 * Every string from a routine or a fire is set with `textContent`. Nothing here acts without a person's press: Enabled,
 * Run now, Save and Delete are the only writes, and a fire's task is opened in the Tasks list, never started here.
 * The form is built once when it opens and is never repainted under the person while they type.
 */
import { uuid } from './ids.js';
import type { RoutineFire, RoutineGate, RoutineRow, RoutineTrigger } from '../../../src/canvas/routines.js';
import { WORK_STATUSES, WORK_STATUS_NAMES } from '../../../src/canvas/work.js';

export type RoutinesHost = {
  url(path: string): string;
  workspace: string;
  online(): boolean;
  /** Opens the Tasks list in the rail, where a run's task lives. */
  showTasks(): void;
  say(message: string): void;
};

/** Mirrors the server's bounds so the form refuses early; the server checks again. */
const MIN_INTERVAL = 15;
const MAX_TRIGGERS = 4;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FIRES_SHOWN = 5;
const MAX_GATES = 4;
const ASSIGNEES: [RoutineGate['assignee'], string][] = [
  ['any', 'anyone or nobody'],
  ['none', 'unassigned'],
  ['routine', 'a routine run'],
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  if (className) made.className = className;
  if (text) made.textContent = text;
  return made;
}
function btn(className: string, text: string, onclick: () => void): HTMLButtonElement {
  const made = el('button', className, text);
  made.type = 'button';
  made.onclick = onclick;
  return made;
}
const when = (at: number): string =>
  new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function triggerLabel(trigger: RoutineTrigger): string {
  switch (trigger.kind) {
    case 'interval':
      return trigger.minutes % 60 === 0 ? `Every ${trigger.minutes / 60} h` : `Every ${trigger.minutes} min`;
    case 'daily':
      return `Daily at ${trigger.time}`;
    case 'weekly':
      return `${[...trigger.days]
        .sort()
        .map((d) => DAYS[d])
        .join(', ')} at ${trigger.time}`;
    case 'work-item':
      return `Each item entering ${WORK_STATUS_NAMES[trigger.status]}${trigger.unassignedOnly ? ', unassigned' : ''}${
        trigger.claim ? ', claimed' : ''
      }`;
  }
}
export function fireLabel(fire: RoutineFire): string {
  const how =
    fire.trigger === 'manual'
      ? 'Run now'
      : fire.trigger === 'work-item' && fire.work
        ? `W-${fire.work.number}`
        : 'Scheduled';
  switch (fire.outcome.kind) {
    case 'pending':
      return `${how} · starting`;
    case 'started':
      return `${how} · started${fire.outcome.claimed === false ? ', item not claimed' : ''}`;
    case 'skipped':
      return fire.outcome.reason === 'gate'
        ? `${how} · skipped: gate ${(fire.outcome.gate ?? 0) + 1}${
            fire.outcome.count === undefined ? ', items could not be counted' : ` (count ${fire.outcome.count})`
          }`
        : `${how} · skipped, the last run was still going`;
    case 'refused':
      return `${how} · refused (${fire.outcome.code})`;
    case 'failed':
      return `${how} · failed: ${fire.outcome.message}`;
  }
}
const known = (t: { kind: string }): t is RoutineTrigger =>
  ['interval', 'daily', 'weekly', 'work-item'].includes(t.kind);
const knownGate = (g: { kind: string }): g is RoutineGate => g.kind === 'work-count';

export function gateLabel(gate: RoutineGate): string {
  const who = ASSIGNEES.find(([value]) => value === gate.assignee)?.[1] ?? gate.assignee;
  const bounds = [
    gate.min !== undefined ? `at least ${gate.min}` : '',
    gate.max !== undefined ? `fewer than ${gate.max}` : '',
  ].filter(Boolean);
  return `${WORK_STATUS_NAMES[gate.status]}, ${who}: ${bounds.join(' and ')}`;
}

type Draft = {
  key: string | null;
  revision: number;
  title: string;
  description: string;
  prompt: string;
  triggers: RoutineTrigger[];
  /** The triggers as loaded, so a save that left them alone never sends them (a later release's kinds survive). */
  loaded: string;
  gates: RoutineGate[];
  loadedGates: string;
};

export class RoutinesView {
  readonly element = el('div', 'routines');
  private rows: RoutineRow[] = [];
  private failed = '';
  private asked = 0;
  private list = el('ul', 'routine-list');
  private note = el('p', 'routine-note');
  private form: HTMLFormElement | null = null;
  private draft: Draft | null = null;
  private confirmDelete = false;

  constructor(private host: RoutinesHost) {
    this.element.id = 'routinesPanel';
    this.element.hidden = true;
    const head = el('div', 'routine-head');
    const intro = el(
      'p',
      'routine-intro',
      'A routine starts a background task with its prompt on a schedule, under the same limits as an agent. A person switches it on.'
    );
    const add = btn('primary', 'New routine', () => this.edit(null));
    add.dataset.routineControl = 'new';
    head.append(intro, add);
    this.note.setAttribute('role', 'status');
    this.note.hidden = true;
    this.list.setAttribute('aria-label', 'Routines');
    this.element.append(head, this.note, this.list);
  }

  async load(): Promise<void> {
    const asked = ++this.asked;
    try {
      const response = await fetch(this.host.url(`/api/canvas/${this.host.workspace}/routines`));
      const body = (await response.json().catch(() => null)) as { data?: { routines?: RoutineRow[] }; error?: string };
      if (asked !== this.asked) return;
      if (response.ok && Array.isArray(body?.data?.routines)) {
        this.rows = body.data.routines;
        this.failed = '';
      } else this.failed = body?.error ?? 'Routines could not be read';
    } catch {
      // Offline: keep the rows already shown.
    }
    this.paint();
  }

  paint(): void {
    if (this.element.hidden) return;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focus = active && this.list.contains(active) ? active.dataset.routineControl : undefined;
    this.note.hidden = !this.failed && this.rows.length > 0;
    this.note.textContent = this.failed || 'No routines yet.';
    this.list.replaceChildren(...this.rows.map((row) => this.card(row)));
    if (focus) this.list.querySelector<HTMLElement>(`[data-routine-control="${focus}"]`)?.focus();
  }

  show(on: boolean): void {
    this.element.hidden = !on;
    if (on) void this.load();
  }

  private card(row: RoutineRow): HTMLElement {
    const li = el('li', 'routine-card');
    li.dataset.routine = row.key;
    const top = el('div', 'routine-top');
    const key = el('span', 'routine-key', row.key);
    const title = el('h3', 'routine-title', row.title);
    const switchLabel = el('label', 'routine-switch');
    const toggle = el('input');
    toggle.type = 'checkbox';
    toggle.checked = row.enabled;
    toggle.dataset.routineControl = `enabled-${row.key}`;
    toggle.onchange = () => void this.patch(row, { enabled: toggle.checked });
    switchLabel.append(toggle, ' Enabled');
    top.append(key, title, switchLabel);
    const when_ = el(
      'p',
      'routine-when',
      `${row.triggers.filter(known).map(triggerLabel).join(' · ') || 'No trigger'}${
        row.nextRunAt ? ` · next ${when(row.nextRunAt)}` : row.enabled ? '' : ' · off'
      }`
    );
    li.append(top, when_);
    const gates = row.gates ?? [];
    if (gates.length)
      li.append(
        el(
          'p',
          'routine-when',
          `Gates: ${gates.map((g, i) => `${i + 1}. ${knownGate(g) ? gateLabel(g) : 'not understood, holds every run'}`).join(' · ')}`
        )
      );
    if (row.description) li.append(el('p', 'routine-desc', row.description));
    const actions = el('div', 'routine-actions');
    const run = btn('', 'Run now', () => void this.run(row));
    run.dataset.routineControl = `run-${row.key}`;
    const edit = btn('', 'Edit', () => this.edit(row));
    edit.dataset.routineControl = `edit-${row.key}`;
    actions.append(run, edit);
    li.append(actions);
    if (row.fires.length) {
      const fires = el('ul', 'routine-fires');
      fires.setAttribute('aria-label', `Recent runs of ${row.key}`);
      for (const fire of row.fires.slice(0, FIRES_SHOWN)) {
        const item = el('li', `routine-fire ${fire.outcome.kind}`);
        item.append(el('span', 'routine-fire-at', when(fire.at)), ' ', el('span', '', fireLabel(fire)));
        if (fire.outcome.kind === 'started') {
          const open = btn('routine-fire-task', 'Task', () => this.host.showTasks());
          open.setAttribute('aria-label', `Open the task of the run at ${when(fire.at)}`);
          item.append(' ', open);
        }
        fires.append(item);
      }
      li.append(fires);
    }
    if (this.draft?.key === row.key && this.form) li.append(this.form);
    return li;
  }

  private async request(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
    if (!this.host.online()) {
      this.host.say('Routines cannot change while Codeman cannot be reached');
      return null;
    }
    try {
      const response = await fetch(this.host.url(`/api/canvas/${this.host.workspace}/routines${path}`), {
        method,
        ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      const answer = (await response.json().catch(() => null)) as { data?: unknown; error?: string } | null;
      if (!response.ok) {
        this.host.say(answer?.error?.replace(/^[A-Z_]+: /, '') ?? 'The change was not saved');
        void this.load();
        return null;
      }
      return answer?.data ?? null;
    } catch {
      this.host.say('The change was not saved. Check the connection and try again.');
      return null;
    }
  }
  private async patch(row: RoutineRow, fields: Record<string, unknown>): Promise<void> {
    await this.request('PATCH', `/${row.key}`, { expectedRevision: row.revision, ...fields });
    await this.load();
  }
  private async run(row: RoutineRow): Promise<void> {
    const data = (await this.request('POST', `/${row.key}/run`, { requestId: uuid() })) as {
      fire?: RoutineFire;
    } | null;
    if (data?.fire) this.host.say(`${row.key}: ${fireLabel(data.fire)}`);
    await this.load();
  }

  private edit(row: RoutineRow | null): void {
    this.draft = {
      key: row?.key ?? null,
      revision: row?.revision ?? 0,
      title: row?.title ?? '',
      description: row?.description ?? '',
      prompt: row?.prompt ?? '',
      triggers: row ? structuredClone(row.triggers.filter(known)) : [{ kind: 'interval', minutes: 60 }],
      loaded: row ? JSON.stringify(row.triggers) : '',
      gates: row ? structuredClone((row.gates ?? []).filter(knownGate)) : [],
      loadedGates: JSON.stringify(row?.gates ?? []),
    };
    this.confirmDelete = false;
    this.form = this.buildForm();
    if (row) this.paint();
    else {
      this.list.prepend(el('li', 'routine-card routine-new'));
      this.list.firstElementChild!.append(this.form);
    }
    this.form.querySelector<HTMLInputElement>('input')?.focus();
  }
  private closeForm(focusKey?: string): void {
    this.form = null;
    this.draft = null;
    this.paint();
    if (focusKey) this.list.querySelector<HTMLElement>(`[data-routine-control="${focusKey}"]`)?.focus();
    else this.element.querySelector<HTMLElement>('[data-routine-control="new"]')?.focus();
  }

  private buildForm(): HTMLFormElement {
    const draft = this.draft!;
    const form = el('form', 'routine-form');
    form.setAttribute('aria-label', draft.key ? `Edit ${draft.key}` : 'New routine');
    const field = (label: string, control: HTMLElement) => {
      const wrap = el('label', 'routine-field');
      wrap.append(el('span', 'routine-field-name', label), control);
      return wrap;
    };
    const title = el('input');
    title.value = draft.title;
    title.maxLength = 200;
    title.required = true;
    title.oninput = () => (draft.title = title.value);
    const description = el('textarea');
    description.rows = 2;
    description.value = draft.description;
    description.oninput = () => (draft.description = description.value);
    const prompt = el('textarea');
    prompt.rows = 6;
    prompt.value = draft.prompt;
    prompt.required = true;
    prompt.maxLength = 8000;
    prompt.oninput = () => (draft.prompt = prompt.value);
    const triggers = el('fieldset', 'routine-triggers');
    triggers.append(el('legend', '', 'Triggers'));
    const rows = el('div');
    const paintTriggers = () => {
      rows.replaceChildren(...draft.triggers.map((t, i) => this.triggerRow(draft, i, t, paintTriggers)));
      addTrigger.disabled = draft.triggers.length >= MAX_TRIGGERS;
    };
    const addTrigger = btn('', 'Add trigger', () => {
      draft.triggers.push({ kind: 'daily', time: '07:00' });
      paintTriggers();
    });
    triggers.append(rows, addTrigger);
    paintTriggers();
    const gates = el('fieldset', 'routine-triggers routine-gates');
    gates.append(
      el('legend', '', 'Gates'),
      el(
        'p',
        'routine-hint',
        'Checked by the server before each run. A run is skipped, and no agent woken, when one says no.'
      )
    );
    const gateRows = el('div');
    const paintGates = () => {
      gateRows.replaceChildren(...draft.gates.map((g, i) => this.gateRow(draft, i, g, paintGates)));
      addGate.disabled = draft.gates.length >= MAX_GATES;
    };
    const addGate = btn('', 'Add gate', () => {
      draft.gates.push({ kind: 'work-count', status: 'ready-for-work', assignee: 'none', min: 1 });
      paintGates();
      gateRows.querySelectorAll<HTMLSelectElement>('select')[(draft.gates.length - 1) * 2]?.focus();
    });
    gates.append(gateRows, addGate);
    paintGates();
    const error = el('p', 'routine-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const actions = el('div', 'routine-actions');
    const save = el('button', 'primary', draft.key ? 'Save' : 'Create');
    save.type = 'submit';
    const cancel = btn('', 'Cancel', () => this.closeForm(draft.key ? `edit-${draft.key}` : undefined));
    actions.append(save, cancel);
    if (draft.key) {
      const remove = btn('routine-delete', 'Delete', async () => {
        if (!this.confirmDelete) {
          this.confirmDelete = true;
          remove.textContent = 'Delete, its past runs stay as tasks';
          return;
        }
        if (await this.request('DELETE', `/${draft.key}`)) {
          this.closeForm();
          await this.load();
        }
      });
      actions.append(remove);
    }
    form.append(
      field('Title', title),
      field('Description', description),
      field('Prompt', prompt),
      triggers,
      gates,
      ...(draft.key
        ? []
        : [el('p', 'routine-hint', 'A new routine starts switched off; tick Enabled on its card to run it.')]),
      error,
      actions
    );
    form.onsubmit = async (e) => {
      e.preventDefault();
      const problem = !draft.title.trim()
        ? 'A title is needed'
        : !draft.prompt.trim()
          ? 'A prompt is needed'
          : draft.triggers.length === 0
            ? 'Add a trigger'
            : draft.triggers.some((t) => t.kind === 'interval' && !(t.minutes >= MIN_INTERVAL))
              ? `An interval is at least ${MIN_INTERVAL} minutes`
              : draft.gates.some((g) => g.min === undefined && g.max === undefined)
                ? 'A gate needs at least or fewer than'
                : '';
      error.hidden = !problem;
      error.textContent = problem;
      if (problem) return;
      const fields = {
        title: draft.title,
        description: draft.description,
        prompt: draft.prompt,
        ...(JSON.stringify(draft.triggers) !== draft.loaded ? { triggers: draft.triggers } : {}),
        ...(JSON.stringify(draft.gates) !== draft.loadedGates ? { gates: draft.gates } : {}),
      };
      const saved = draft.key
        ? await this.request('PATCH', `/${draft.key}`, { expectedRevision: draft.revision, ...fields })
        : await this.request('POST', '', { requestId: uuid(), ...fields });
      const key = (saved as { routine?: RoutineRow } | null)?.routine?.key;
      if (!key) return;
      this.form = null;
      this.draft = null;
      await this.load();
      this.list.querySelector<HTMLElement>(`[data-routine-control="edit-${key}"]`)?.focus();
    };
    form.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      this.closeForm(draft.key ? `edit-${draft.key}` : undefined);
    });
    return form;
  }

  private gateRow(draft: Draft, index: number, gate: RoutineGate, repaint: () => void): HTMLElement {
    const row = el('div', 'routine-trigger routine-gate');
    row.append(el('span', '', 'Count items in'));
    const status = el('select');
    status.setAttribute('aria-label', `Gate ${index + 1} status`);
    for (const value of WORK_STATUSES) {
      const option = el('option', '', WORK_STATUS_NAMES[value]);
      option.value = value;
      option.selected = gate.status === value;
      status.append(option);
    }
    status.onchange = () => (gate.status = status.value as RoutineGate['status']);
    const who = el('select');
    who.setAttribute('aria-label', `Gate ${index + 1} assigned to`);
    for (const [value, label] of ASSIGNEES) {
      const option = el('option', '', label);
      option.value = value;
      option.selected = gate.assignee === value;
      who.append(option);
    }
    who.onchange = () => (gate.assignee = who.value as RoutineGate['assignee']);
    const bound = (label: string, value: number | undefined, set: (v: number | undefined) => void) => {
      const input = el('input');
      input.type = 'number';
      input.min = '0';
      input.step = '1';
      input.value = value === undefined ? '' : String(value);
      input.placeholder = 'any';
      input.setAttribute('aria-label', `Gate ${index + 1} ${label}`);
      input.oninput = () => set(input.value === '' ? undefined : Math.max(0, Math.floor(Number(input.value))));
      return input;
    };
    const set = (key: 'min' | 'max') => (v: number | undefined) => {
      if (v === undefined) delete gate[key];
      else gate[key] = v;
    };
    row.append(
      status,
      el('span', '', 'assigned to'),
      who,
      el('span', '', 'run when at least'),
      bound('at least', gate.min, set('min')),
      el('span', '', 'and fewer than'),
      bound('fewer than', gate.max, set('max'))
    );
    const remove = btn('routine-trigger-remove', 'Remove', () => {
      draft.gates.splice(index, 1);
      repaint();
    });
    remove.setAttribute('aria-label', `Remove gate ${index + 1}`);
    row.append(remove);
    return row;
  }

  private triggerRow(draft: Draft, index: number, trigger: RoutineTrigger, repaint: () => void): HTMLElement {
    const row = el('div', 'routine-trigger');
    const kind = el('select');
    kind.setAttribute('aria-label', `Trigger ${index + 1}`);
    for (const [value, label] of [
      ['interval', 'Every'],
      ['daily', 'Daily at'],
      ['weekly', 'Weekly on'],
      ['work-item', 'Each Work item entering'],
    ] as const) {
      const option = el('option', '', label);
      option.value = value;
      option.selected = trigger.kind === value;
      kind.append(option);
    }
    kind.onchange = () => {
      draft.triggers[index] =
        kind.value === 'interval'
          ? { kind: 'interval', minutes: 60 }
          : kind.value === 'daily'
            ? { kind: 'daily', time: '07:00' }
            : kind.value === 'work-item'
              ? { kind: 'work-item', status: WORK_STATUSES.find((s) => s !== 'backlog') ?? WORK_STATUSES[0] }
              : { kind: 'weekly', days: [1], time: '07:00' };
      repaint();
      this.form?.querySelectorAll<HTMLSelectElement>('.routine-trigger select')[index]?.focus();
    };
    row.append(kind);
    const time = (value: string, set: (v: string) => void) => {
      const input = el('input');
      input.type = 'time';
      input.value = value;
      input.setAttribute('aria-label', 'Time');
      input.onchange = () => set(input.value);
      return input;
    };
    if (trigger.kind === 'interval') {
      const minutes = el('input');
      minutes.type = 'number';
      minutes.min = String(MIN_INTERVAL);
      minutes.step = '5';
      minutes.value = String(trigger.minutes);
      minutes.setAttribute('aria-label', 'Minutes');
      minutes.oninput = () => (trigger.minutes = Number(minutes.value));
      row.append(minutes, el('span', '', 'minutes'));
    } else if (trigger.kind === 'daily') {
      row.append(time(trigger.time, (v) => (trigger.time = v)));
    } else if (trigger.kind === 'work-item') {
      const status = el('select');
      status.setAttribute('aria-label', `Trigger ${index + 1} status`);
      for (const value of WORK_STATUSES) {
        const option = el('option', '', WORK_STATUS_NAMES[value]);
        option.value = value;
        option.selected = trigger.status === value;
        status.append(option);
      }
      status.onchange = () => (trigger.status = status.value as typeof trigger.status);
      const flag = (label: string, key: 'unassignedOnly' | 'claim', hint: string) => {
        const wrap = el('label');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = trigger[key] === true;
        box.title = hint;
        box.onchange = () => {
          if (box.checked) trigger[key] = true;
          else delete trigger[key];
        };
        wrap.append(box, label);
        return wrap;
      };
      row.append(
        status,
        flag('unassigned only', 'unassignedOnly', 'Skip items someone is assigned to'),
        flag('claim it', 'claim', 'Assign the item to the run and move it to In progress when the run starts')
      );
    } else {
      const days = el('span', 'routine-days');
      DAYS.forEach((name, day) => {
        const label = el('label');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = trigger.days.includes(day);
        box.onchange = () => {
          trigger.days = box.checked ? [...trigger.days, day] : trigger.days.filter((d) => d !== day);
        };
        label.append(box, name);
        days.append(label);
      });
      row.append(
        days,
        el('span', '', 'at'),
        time(trigger.time, (v) => (trigger.time = v))
      );
    }
    const remove = btn('routine-trigger-remove', 'Remove', () => {
      draft.triggers.splice(index, 1);
      repaint();
    });
    remove.setAttribute('aria-label', `Remove trigger ${index + 1}`);
    row.append(remove);
    return row;
  }
}
