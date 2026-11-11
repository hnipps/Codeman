import { z } from 'zod';
import { EditQueue, sendEdits, type Edit, type QueueStatus, type Acknowledged } from './edit-queue.js';
import { container, type Snapshot, type ViewObject } from './model.js';
import type { ViewState, ViewCommand } from './commands.js';
import { screenToCanvas } from './viewport.js';
const node = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing edit element: ${id}`);
  return el;
};
const btn = (id: string): HTMLButtonElement => {
  const el = node(id);
  if (!(el instanceof HTMLButtonElement)) throw new Error(`Expected button: ${id}`);
  return el;
};
const DraftSchema = z.object({ base: z.string(), value: z.string(), revision: z.number(), conflict: z.boolean() });
type Draft = z.infer<typeof DraftSchema> & { sent?: string };
export class DesktopEditor {
  readonly queue: EditQueue;
  private drafts = new Map<string, Draft>();
  private currentId: string | null = null;
  private authoritative: ViewObject[] = [];
  private status: QueueStatus = 'offline';
  private message = '';
  private connected = false;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private editor: HTMLTextAreaElement;
  constructor(
    private options: {
      url: (path: string) => string;
      workspace: string;
      mobile: MediaQueryList;
      view: () => ViewState;
      objects: () => ViewObject[];
      dispatch: (action: ViewCommand) => void;
      display: (objects: ViewObject[]) => void;
    }
  ) {
    const editor = node('textEditor');
    if (!(editor instanceof HTMLTextAreaElement)) throw new Error('Expected text editor');
    this.editor = editor;
    try {
      const stored = z.record(z.string(), DraftSchema).parse(JSON.parse(localStorage.getItem(this.draftKey) ?? '{}'));
      this.drafts = new Map(Object.entries(stored));
    } catch {
      /* Unreadable drafts do not replace the server's content. */
    }
    this.queue = new EditQueue({
      storage: localStorage,
      key: `codeman:canvas:${options.workspace}:edits`,
      send: (ops, since) => sendEdits(options.url, options.workspace, ops, since),
      display: options.display,
      status: (status, message) => {
        this.status = status;
        this.message = message;
        this.paintStatus();
        this.paintAvailability();
      },
      acknowledged: (ops) => this.acknowledge(ops),
    });
    btn('addTool').onclick = () => {
      if (!this.available()) return;
      node('addMenu').hidden = !node('addMenu').hidden;
      btn('addTool').setAttribute('aria-expanded', String(!node('addMenu').hidden));
      if (!node('addMenu').hidden) btn('addText').focus();
    };
    for (const [id, type] of [
      ['addText', 'text'],
      ['addFrame', 'frame'],
      ['addSection', 'section'],
      ['addSubcanvas', 'subcanvas'],
    ])
      btn(id).onclick = () => this.create(type);
    btn('editSelection').onclick = () => {
      const id = options.view().selected[0];
      if (id) {
        options.dispatch({ kind: 'focus', id });
        options.dispatch({ kind: 'rail', view: 'reader' });
      }
    };
    btn('deleteSelection').onclick = () => this.remove();
    btn('retryEdit').onclick = () => this.queue.retry();
    btn('discardEdit').onclick = () => {
      this.queue.discard();
      this.paintStatus();
    };
    btn('useServer').onclick = () => this.resolve(false);
    btn('keepDraft').onclick = () => this.resolve(true);
    this.editor.oninput = () => {
      const draft = this.currentId ? this.drafts.get(this.currentId) : undefined;
      if (!draft) return;
      draft.value = this.editor.value;
      this.persistDrafts();
      this.paintStatus();
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => this.saveText(), 600);
    };
    this.editor.onblur = () => this.saveText();
    document.addEventListener('keydown', (e) => this.key(e), true);
    options.mobile.addEventListener('change', () => {
      if (options.mobile.matches) {
        clearTimeout(this.debounce);
        node('addMenu').hidden = true;
      }
      this.paint();
    });
    window.addEventListener(
      'pagehide',
      () => {
        clearTimeout(this.debounce);
        this.queue.stop();
        this.persistDrafts();
      },
      { once: true }
    );
  }
  private get draftKey(): string {
    return `codeman:canvas:${this.options.workspace}:drafts`;
  }
  private persistDrafts(): void {
    try {
      localStorage.setItem(
        this.draftKey,
        JSON.stringify(
          Object.fromEntries(
            [...this.drafts].map(([id, d]) => [
              id,
              { base: d.base, value: d.value, revision: d.revision, conflict: d.conflict },
            ])
          )
        )
      );
    } catch {
      this.message = 'Draft storage is unavailable. Keep this page open until your edit saves.';
      this.status = 'failed';
    }
  }
  receive(snapshot: Snapshot): void {
    this.authoritative = snapshot.objects;
    for (const [id, draft] of this.drafts) {
      const object = snapshot.objects.find((o) => o.id === id);
      if (!object) {
        if (draft.value !== draft.base) draft.conflict = true;
        continue;
      }
      const text = this.field(object);
      if (text === null) continue;
      if (text !== draft.base && text !== draft.sent && draft.value !== draft.base) draft.conflict = true;
      else if (draft.value === draft.base && !draft.sent) {
        draft.base = text;
        draft.value = text;
        draft.revision = this.revision(object);
      }
    }
    this.persistDrafts();
    this.queue.receive(snapshot);
  }
  online(online: boolean): void {
    this.connected = online;
    this.queue.online(online);
  }
  private available(): boolean {
    if (this.options.mobile.matches) return false;
    if (this.connected && this.status !== 'refused') return true;
    node('announcement').textContent = this.message || 'Offline. Reconnect before editing.';
    return false;
  }
  submit(operations: Edit[]): boolean {
    return this.available() && this.queue.enqueue(operations);
  }
  private create(type: string): void {
    if (!this.available()) return;
    const id = crypto.randomUUID(),
      v = this.options.view().viewport;
    const p = screenToCanvas(v, { x: innerWidth / 2, y: innerHeight / 2 });
    const name = type === 'subcanvas' ? 'Sub-canvas' : type.charAt(0).toUpperCase() + type.slice(1);
    const content =
      type === 'text'
        ? { type: 'text', text: '' }
        : type === 'frame'
          ? { type: 'frame', label: 'Untitled frame' }
          : type === 'section'
            ? { type: 'section', label: 'Untitled section' }
            : { type: 'subcanvas', workspaceId: this.options.workspace, label: 'Untitled sub-canvas' };
    const operation = {
      kind: 'create',
      opId: crypto.randomUUID(),
      objectId: id,
      patch: {
        parentId: null,
        order: Date.now(),
        position: { x: p.x - 140, y: p.y - 90 },
        size: type === 'text' ? { width: 280, height: 180 } : { width: 520, height: 360 },
        rotation: 0,
        lock: null,
        content,
      },
    };
    if (!this.queue.enqueue([this.parse(operation)])) return;
    node('addMenu').hidden = true;
    btn('addTool').setAttribute('aria-expanded', 'false');
    this.options.dispatch({ kind: 'selection', ids: [id] });
    this.options.dispatch({ kind: 'focus', id });
    this.options.dispatch({ kind: 'rail', view: 'reader' });
    node('announcement').textContent = `${name} created`;
    requestAnimationFrame(() => this.editor.focus());
  }
  private parse(value: unknown): Edit {
    return EditSchema.parse(value);
  }
  private remove(): void {
    if (!this.available()) return;
    const ids = this.options.view().selected;
    const targets = this.options.objects().filter((o) => ids.includes(o.id));
    this.submit(targets.map((o) => ({ kind: 'delete', opId: crypto.randomUUID(), objectId: o.id })));
  }
  private field(o: ViewObject): string | null {
    if (o.content.type !== o.type) return null;
    const value = o.type === 'text' ? o.content.text : container(o) ? o.content.label : null;
    return typeof value === 'string' ? value : null;
  }
  private revision(o: ViewObject): number {
    return typeof o.revision === 'number' ? o.revision : 0;
  }
  read(o: ViewObject | undefined): void {
    const text = o ? this.field(o) : null;
    const editable = !this.options.mobile.matches && !!o && text !== null;
    node('textEdit').hidden = !editable;
    node('readerText').hidden = editable || !node('readerText').textContent;
    if (!editable || !o || text === null) return;
    let draft = this.drafts.get(o.id);
    if (!draft) {
      draft = { base: text, value: text, revision: this.revision(o), conflict: false };
      this.drafts.set(o.id, draft);
    }
    this.currentId = o.id;
    if (document.activeElement !== this.editor || this.editor.dataset.objectId !== o.id)
      this.editor.value = draft.value;
    this.editor.dataset.objectId = o.id;
    this.editor.setAttribute('aria-label', o.type === 'text' ? 'Text' : 'Name');
    node('editorLabel').textContent = o.type === 'text' ? 'Text' : 'Name';
    this.editor.rows = o.type === 'text' ? 9 : 2;
    this.editor.maxLength = o.type === 'text' ? 1_000_000 : 8192;
    this.paintStatus();
    this.paintAvailability();
  }
  private saveText(): void {
    clearTimeout(this.debounce);
    if (!this.currentId || !this.available()) return;
    const draft = this.drafts.get(this.currentId),
      object = this.authoritative.find((o) => o.id === this.currentId);
    if (!draft || !object || draft.conflict || draft.sent !== undefined || draft.value === draft.base) return;
    const content = { ...object.content, [object.type === 'text' ? 'text' : 'label']: draft.value };
    draft.sent = draft.value;
    if (
      !this.submit([
        this.parse({
          kind: 'update',
          opId: crypto.randomUUID(),
          objectId: object.id,
          expectedRevision: this.revision(object),
          patch: { content },
        }),
      ])
    )
      delete draft.sent;
  }
  private acknowledge(operations: Acknowledged[]): void {
    for (const op of operations) {
      const draft = this.drafts.get(op.objectId);
      const after = op.prev.find((c) => c.objectId === op.objectId)?.after;
      if (draft && after && draft.sent !== undefined && this.field(after) === draft.sent) {
        draft.base = draft.sent;
        draft.revision = this.revision(after);
        delete draft.sent;
        if (!draft.conflict && draft.value !== draft.base) this.debounce = setTimeout(() => this.saveText(), 50);
      }
    }
    this.persistDrafts();
  }
  private resolve(keep: boolean): void {
    const draft = this.currentId ? this.drafts.get(this.currentId) : undefined;
    const object = this.authoritative.find((o) => o.id === this.currentId);
    if (!draft || !object || !this.connected) return;
    if (this.status === 'refused') this.queue.discard();
    draft.base = this.field(object) ?? '';
    if (!keep) draft.value = draft.base;
    draft.conflict = false;
    delete draft.sent;
    this.editor.value = draft.value;
    this.persistDrafts();
    this.paintStatus();
    if (keep) this.saveText();
  }
  private paintStatus(): void {
    const draft = this.currentId ? this.drafts.get(this.currentId) : undefined;
    if (this.status === 'refused' && draft?.sent !== undefined) {
      draft.conflict = true;
      delete draft.sent;
    }
    node('editStatus').textContent = draft?.conflict
      ? 'Conflict: this field changed elsewhere. Your draft is preserved.'
      : this.status === 'saved' && draft && draft.value !== draft.base
        ? 'Draft · waiting to save'
        : this.message;
    node('editStatus').dataset.state = draft?.conflict ? 'conflict' : this.status;
    node('conflictActions').hidden = !draft?.conflict;
    node('retryActions').hidden = this.status !== 'failed' && this.status !== 'refused';
    btn('retryEdit').hidden = !!draft?.conflict;
  }
  private paintAvailability(): void {
    const unavailable = !this.connected || this.status === 'refused';
    for (const id of [
      'addTool',
      'addText',
      'addFrame',
      'addSection',
      'addSubcanvas',
      'deleteSelection',
      'keepDraft',
      'useServer',
    ])
      btn(id).disabled = unavailable;
    this.editor.readOnly = unavailable;
  }
  paint(): void {
    node('contextRow').hidden = this.options.mobile.matches || !this.options.view().selected.length;
    node('selectionCount').textContent = `${this.options.view().selected.length} selected`;
    this.read(this.options.objects().find((o) => o.id === this.options.view().focusId));
    this.paintAvailability();
  }
  private key(e: KeyboardEvent): void {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape' && !node('addMenu').hidden) {
      e.preventDefault();
      e.stopImmediatePropagation();
      node('addMenu').hidden = true;
      btn('addTool').focus();
      return;
    }
    const target = e.target;
    if (
      !(target instanceof Element) ||
      !target.closest('#board') ||
      target.closest('input,textarea,select,[contenteditable]') ||
      this.options.mobile.matches
    )
      return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.remove();
    }
  }
}
import { EditSchema } from './edit-queue.js';
