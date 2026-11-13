/**
 * @fileoverview A person's export of the open canvas or of the one selected object.
 *
 * It adds no renderer and no serializer. The image is the answer of the screenshot route and the
 * objects file is the answer of the `canvas_read` command, the two requests an agent makes through
 * `canvas_screenshot` and `canvas_read`, so both get the same bytes for the same target.
 */
import { label, type ViewObject } from './model.js';

export type ExportFormat = 'png' | 'json';
export type ExportScope = 'selection' | 'canvas';
/** `id` null is the top level of the workspace. */
export type ExportTarget = { id: string | null; name: string };
export type ExportChoice = { target: ExportTarget } | { reason: string };

/** What a scope means for this view: the one selected object, or the canvas that is open. */
export function exportChoice(
  scope: ExportScope,
  view: { root: string | null; selected: string[] },
  objects: ViewObject[],
  workspaceName: string
): ExportChoice {
  const named = (id: string): ExportTarget | null => {
    const object = objects.find((o) => o.id === id);
    return object ? { id, name: label(object) } : null;
  };
  if (scope === 'canvas') {
    if (view.root === null) return { target: { id: null, name: workspaceName } };
    const open = named(view.root);
    return open ? { target: open } : { reason: 'This sub-canvas is no longer on the canvas.' };
  }
  if (view.selected.length === 0) return { reason: 'Select one object first.' };
  if (view.selected.length > 1) return { reason: 'Select one object, or group the selection first.' };
  const selected = named(view.selected[0]);
  return selected ? { target: selected } : { reason: 'Select one object first.' };
}

/** The request an agent's tool makes for the same target and format. */
export function exportRequest(
  workspace: string,
  target: ExportTarget,
  format: ExportFormat,
  theme: 'dark' | 'light'
): { method: 'GET' | 'POST'; path: string; body?: unknown } {
  if (format === 'json')
    return {
      method: 'POST',
      path: `/api/canvas/${workspace}/command`,
      body: { tool: 'canvas_read', arguments: target.id === null ? {} : { root: target.id } },
    };
  const object = target.id === null ? '' : `/objects/${encodeURIComponent(target.id)}`;
  return { method: 'GET', path: `/api/canvas/${workspace}${object}/screenshot?theme=${theme}` };
}

/** A file name any system accepts: the target's name, then the local time to the second. */
export function exportFileName(name: string, format: ExportFormat, now: Date): string {
  const slug =
    name
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .toLowerCase() || 'canvas';
  const two = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return `${slug}-${stamp}.${format}`;
}

async function refusal(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  const error = body && typeof body === 'object' && 'error' in body ? body.error : null;
  return typeof error === 'string' && error ? error : `Codeman answered ${response.status}.`;
}

export type ExportOptions = {
  url: (path: string) => string;
  workspace: string;
  workspaceName: () => string;
  view: () => { root: string | null; selected: string[] };
  objects: () => ViewObject[];
  /** Where the keyboard goes when the menu closes with no opener to return to. */
  rest: () => void;
};

export class ExportView {
  private menu: HTMLElement;
  private status: HTMLElement;
  private opener: HTMLElement | null = null;
  private busy = false;
  constructor(private options: ExportOptions) {
    const menu = document.getElementById('exportMenu'),
      status = document.getElementById('exportStatus');
    if (!menu || !status) throw new Error('Export menu is missing from the page');
    this.menu = menu;
    this.status = status;
    for (const row of this.rows()) {
      row.onclick = () => {
        const scope = row.dataset.exportScope === 'selection' ? 'selection' : 'canvas';
        void this.run(scope, row.dataset.exportFormat === 'json' ? 'json' : 'png');
      };
    }
    menu.addEventListener('keydown', (e) => this.key(e));
    // A menu left open while the keyboard works elsewhere would show a target the view no longer has.
    // Focus that goes nowhere (the browser's own download prompt) leaves it open.
    menu.addEventListener('focusout', (e) => {
      const next = e.relatedTarget;
      if (this.busy || !(next instanceof Element)) return;
      if (!next.closest('#exportMenu') && !next.closest('[data-export-open]')) this.close(false);
    });
    // In the capture phase: the board keeps its own pointer events from bubbling.
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (this.menu.hidden || this.busy || !(e.target instanceof Element)) return;
        if (!e.target.closest('#exportMenu') && !e.target.closest('[data-export-open]')) this.close(false);
      },
      true
    );
    for (const opener of document.querySelectorAll<HTMLElement>('[data-export-open]')) {
      opener.setAttribute('aria-haspopup', 'menu');
      opener.setAttribute('aria-controls', 'exportMenu');
      opener.setAttribute('aria-expanded', 'false');
      opener.onclick = () => this.toggle(opener);
    }
  }
  get open(): boolean {
    return !this.menu.hidden;
  }
  private rows(): HTMLButtonElement[] {
    return [...this.menu.querySelectorAll<HTMLButtonElement>('button[data-export-scope]')];
  }
  toggle(opener: HTMLElement | null = null): void {
    if (this.open) this.close(true);
    else this.show(opener);
  }
  private show(opener: HTMLElement | null): void {
    this.opener = opener;
    this.status.textContent = '';
    const view = this.options.view(),
      objects = this.options.objects();
    for (const scope of ['selection', 'canvas'] as const) {
      const choice = exportChoice(scope, view, objects, this.options.workspaceName());
      const heading = this.menu.querySelector<HTMLElement>(`[data-export-heading="${scope}"]`);
      if (heading) heading.textContent = 'target' in choice ? choice.target.name : choice.reason;
      for (const row of this.rows().filter((r) => r.dataset.exportScope === scope)) {
        // A refused row stays focusable so a keyboard or screen reader user can reach its reason.
        row.setAttribute('aria-disabled', String(!('target' in choice)));
      }
    }
    this.menu.hidden = false;
    for (const o of document.querySelectorAll('[data-export-open]')) o.setAttribute('aria-expanded', 'true');
    (this.rows().find((row) => row.getAttribute('aria-disabled') !== 'true') ?? this.rows()[0])?.focus();
  }
  private close(restore: boolean): void {
    this.menu.hidden = true;
    for (const o of document.querySelectorAll('[data-export-open]')) o.setAttribute('aria-expanded', 'false');
    if (!restore) return;
    if (this.opener?.isConnected && this.opener.offsetParent !== null) this.opener.focus({ preventScroll: true });
    else this.options.rest();
  }
  private key(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (!this.busy) this.close(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const rows = this.rows(),
      index = rows.findIndex((row) => row === document.activeElement);
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? rows.length - 1
          : (index + (e.key === 'ArrowUp' ? -1 : 1) + rows.length) % rows.length;
    rows[next]?.focus();
  }
  /** Fetch the target the way an agent's tool does and hand the answer to the browser as a file. */
  async run(scope: ExportScope, format: ExportFormat): Promise<void> {
    if (this.busy) return;
    const choice = exportChoice(scope, this.options.view(), this.options.objects(), this.options.workspaceName());
    if (!('target' in choice)) {
      this.status.textContent = choice.reason;
      return;
    }
    const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    const request = exportRequest(this.options.workspace, choice.target, format, theme);
    this.busy = true;
    this.menu.setAttribute('aria-busy', 'true');
    this.status.textContent = format === 'png' ? 'Rendering the image…' : 'Reading the objects…';
    try {
      const response = await fetch(this.options.url(request.path), {
        method: request.method,
        ...(request.body === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.body) }),
      });
      if (!response.ok) {
        this.status.textContent = `Not exported. ${await refusal(response)}`;
        return;
      }
      let blob: Blob;
      let note = '';
      if (format === 'png') blob = await response.blob();
      else {
        const body: unknown = await response.json();
        const data = body && typeof body === 'object' && 'data' in body ? body.data : null;
        if (!data || typeof data !== 'object') {
          this.status.textContent = 'Not exported. Codeman answered in a form this page cannot read.';
          return;
        }
        if ('truncated' in data && data.truncated === true)
          note = ' The canvas is larger than one read, so the file is cut short.';
        blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
      }
      const name = exportFileName(choice.target.name, format, new Date());
      save(blob, name);
      // The menu stays open: its status line is the visible confirmation, and the other format is one key away.
      this.status.textContent = `Exported ${name}.${note}`;
    } catch {
      this.status.textContent = 'Not exported. Codeman could not be reached.';
    } finally {
      this.busy = false;
      this.menu.removeAttribute('aria-busy');
    }
  }
}

/** Hands a blob to the browser's own download, so the page never navigates. */
function save(blob: Blob, name: string): void {
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}
