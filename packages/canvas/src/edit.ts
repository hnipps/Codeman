import { resized } from './resize.js';
import { movedPosition } from './drag.js';
import { label } from './model.js';
import { targets, selectRegion } from './select.js';
import { type Point, union } from './viewport.js';
import { CanvasUndo } from './undo.js';
import { parseSnapshot } from './edit-queue.js';
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
  private history = new CanvasUndo();
  private submittedFocus = new Map<string, string | null>();
  private drafts = new Map<string, Draft>();
  private currentId: string | null = null;
  private authoritative: ViewObject[] = [];
  private status: QueueStatus = 'offline';
  private message = '';
  private connected = false;
  private selectionGesture: {
    pointerId: number;
    start: Point;
    points: Point[];
    lasso: boolean;
    toggle: boolean;
    parentId: string | null;
  } | null = null;
  private lastTap: { id: string; at: number } | null = null;
  private resizeGesture: {
    pointerId: number;
    start: Point;
    object: ViewObject;
    all: ViewObject[];
    handle: string;
    result: ReturnType<typeof resized>;
  } | null = null;
  private moveGesture: {
    pointerId: number | null;
    start: Point;
    delta: Point;
    originals: ViewObject[];
    all: ViewObject[];
    destination: string | null;
    moved: boolean;
    shift: boolean;
    target: string;
  } | null = null;
  private space = false;
  private selectionPath: SVGPathElement;
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
    const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    overlay.id = 'selectionGesture';
    overlay.setAttribute('aria-hidden', 'true');
    this.selectionPath = document.createElementNS(overlay.namespaceURI, 'path');
    overlay.append(this.selectionPath);
    node('board').append(overlay);
    node('board').addEventListener('pointerdown', (e) => this.selectionStart(e), true);
    node('board').addEventListener('pointermove', (e) => this.selectionMove(e), true);
    node('board').addEventListener('pointerup', (e) => this.selectionEnd(e), true);
    node('board').addEventListener('pointercancel', () => this.cancelSelection(), true);
    node('board').addEventListener('lostpointercapture', () => this.cancelSelection(), true);
    window.addEventListener('blur', () => {
      this.space = false;
      this.cancelSelection();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.cancelSelection();
    });
    document.addEventListener('keyup', (e) => {
      if (e.key === ' ') this.space = false;
    });
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
    for (const id of ['positionX', 'positionY', 'sizeWidth', 'sizeHeight']) {
      const field = node(id);
      if (field instanceof HTMLInputElement) field.onchange = () => this.numericGeometry();
    }
    btn('moveMode').onclick = () => this.startKeyboardMove();
    btn('moveTo').onclick = () => {
      this.refreshDestinations();
      node('moveToMenu').hidden = !node('moveToMenu').hidden;
    };
    btn('commitMoveTo').onclick = () => {
      const select = node('moveDestination');
      if (!(select instanceof HTMLSelectElement)) return;
      this.reparent(select.value || null);
      node('moveToMenu').hidden = true;
    };
    btn('undoEdit').onclick = () => void this.undo('undo');
    btn('redoEdit').onclick = () => void this.undo('redo');
    btn('retryEdit').onclick = () => this.queue.retry();
    btn('discardEdit').onclick = () => {
      this.queue.discard();
      this.history.refused();
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
    if (!this.available()) return false;
    const focusId = this.options.view().focusId;
    for (const op of operations) this.submittedFocus.set(op.opId, focusId);
    return this.queue.enqueue(operations);
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
    if (!this.submit([this.parse(operation)])) return;
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
    const selected = targets(this.options.objects(), ids);
    this.submit(selected.map((o) => ({ kind: 'delete', opId: crypto.randomUUID(), objectId: o.id })));
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
    const focusId = this.history.acknowledge(
      operations,
      this.submittedFocus.get(operations[0]?.opId ?? '') ?? operations[0]?.objectId ?? null
    );
    for (const op of operations) this.submittedFocus.delete(op.opId);
    if (focusId) {
      this.options.dispatch({ kind: 'focus', id: focusId });
      node('board').focus({ preventScroll: true });
    }
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
    this.previewMove();
    this.previewResize();
    this.paintGeometry();
  }
  private selectionStart(e: PointerEvent): void {
    if (
      this.options.mobile.matches ||
      e.button !== 0 ||
      e.pointerType === 'touch' ||
      this.options.view().tool !== 'select' ||
      this.space
    )
      return;
    const targetId =
      e.target instanceof Element ? e.target.closest<HTMLElement>('[data-object-id]')?.dataset.objectId : undefined;
    const handle =
      e.target instanceof Element ? e.target.closest<HTMLElement>('[data-resize]')?.dataset.resize : undefined;
    if (targetId && handle) {
      const object = this.options.objects().find((o) => o.id === targetId);
      if (!object?.size || !this.available()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.resizeGesture = {
        pointerId: e.pointerId,
        start: { x: e.clientX, y: e.clientY },
        object,
        all: this.options.objects(),
        handle,
        result: null,
      };
      node('board').setPointerCapture(e.pointerId);
      node('board').focus({ preventScroll: true });
      return;
    }
    if (targetId && !e.altKey) {
      if (!this.available()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const selected = this.options.view().selected.includes(targetId) ? this.options.view().selected : [targetId];
      this.moveGesture = {
        pointerId: e.pointerId,
        start: { x: e.clientX, y: e.clientY },
        delta: { x: 0, y: 0 },
        originals: targets(this.options.objects(), selected),
        all: this.options.objects(),
        destination: null,
        moved: false,
        shift: e.shiftKey,
        target: targetId,
      };
      node('board').setPointerCapture(e.pointerId);
      node('board').focus({ preventScroll: true });
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    const start = { x: e.clientX, y: e.clientY };
    const focused = this.options.objects().find((o) => o.id === this.options.view().focusId);
    this.selectionGesture = {
      pointerId: e.pointerId,
      start,
      points: [start],
      lasso: e.altKey,
      toggle: e.shiftKey,
      parentId: focused?.parentId ?? null,
    };
    node('board').setPointerCapture(e.pointerId);
    node('board').focus({ preventScroll: true });
  }
  private region() {
    const gesture = this.selectionGesture;
    if (!gesture) return null;
    const points = gesture.points.map((p) => screenToCanvas(this.options.view().viewport, p));
    return gesture.lasso
      ? { kind: 'polygon' as const, points }
      : { kind: 'rectangle' as const, rect: union(points.map((p) => ({ ...p, width: 0, height: 0 }))) };
  }
  private selectionMove(e: PointerEvent): void {
    const resize = this.resizeGesture;
    if (resize?.pointerId === e.pointerId) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const zoom = this.options.view().viewport.zoom;
      resize.result = resized(
        resize.all,
        resize.object,
        resize.handle,
        { x: (e.clientX - resize.start.x) / zoom, y: (e.clientY - resize.start.y) / zoom },
        e.shiftKey,
        e.altKey
      );
      this.previewResize();
      return;
    }
    if (this.moveGesture?.pointerId === e.pointerId) {
      this.movePointer(e);
      return;
    }
    const gesture = this.selectionGesture;
    if (!gesture || gesture.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const p = { x: e.clientX, y: e.clientY };
    if (gesture.lasso) gesture.points.push(p);
    else gesture.points = [gesture.start, p];
    const r = union(gesture.points.map((p) => ({ ...p, width: 0, height: 0 })));
    this.selectionPath.setAttribute(
      'd',
      gesture.lasso
        ? `${gesture.points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ')} Z`
        : `M${r.x},${r.y} h${r.width} v${r.height} h${-r.width} Z`
    );
    const region = this.region();
    const ids = region ? selectRegion(this.options.objects(), region, gesture.parentId) : [];
    for (const el of node('layer').querySelectorAll<HTMLElement>('[data-object-id]'))
      el.classList.toggle('selection-preview', ids.includes(el.dataset.objectId ?? ''));
  }
  private selectionEnd(e: PointerEvent): void {
    const resize = this.resizeGesture;
    if (resize?.pointerId === e.pointerId) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (resize.result) this.setGeometry(resize.object, resize.result.position, resize.result.size);
      this.cancelSelection();
      return;
    }
    if (this.moveGesture?.pointerId === e.pointerId) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const gesture = this.moveGesture;
      if (gesture.moved) this.commitMove();
      else {
        this.options.dispatch({ kind: 'focus', id: gesture.target });
        if (this.lastTap?.id === gesture.target && e.timeStamp - this.lastTap.at < 500) {
          this.options.dispatch({ kind: 'rail', view: 'reader' });
          this.lastTap = null;
        } else this.lastTap = { id: gesture.target, at: e.timeStamp };
        this.options.dispatch(
          gesture.shift ? { kind: 'toggle', id: gesture.target } : { kind: 'selection', ids: [gesture.target] }
        );
      }
      this.cancelSelection();
      return;
    }
    const gesture = this.selectionGesture;
    if (!gesture || gesture.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const region = this.region();
    if (region && Math.hypot(e.clientX - gesture.start.x, e.clientY - gesture.start.y) > 4)
      this.options.dispatch({ kind: 'region', region, parentId: gesture.parentId, toggle: gesture.toggle });
    else if (!gesture.toggle) this.options.dispatch({ kind: 'selection', ids: [] });
    this.cancelSelection();
  }
  private cancelSelection(): void {
    if (this.moveGesture || this.resizeGesture) {
      for (const object of this.options.objects()) {
        const el = node('layer').querySelector<HTMLElement>(`[data-object-id="${object.id}"]`);
        if (el) {
          el.style.left = `${object.position.x}px`;
          el.style.top = `${object.position.y}px`;
          if (object.size) {
            el.style.width = `${object.size.width}px`;
            el.style.height = `${object.size.height}px`;
          }
        }
      }
    }
    this.moveGesture = null;
    this.resizeGesture = null;
    for (const el of node('layer').querySelectorAll('.drop-target')) el.classList.remove('drop-target');
    node('dropName').hidden = true;
    node('moveHint').hidden = true;
    this.selectionGesture = null;
    this.selectionPath.removeAttribute('d');
    for (const el of node('layer').querySelectorAll('.selection-preview')) el.classList.remove('selection-preview');
  }
  private previewResize(): void {
    const resize = this.resizeGesture;
    if (!resize?.result) return;
    const el = node('layer').querySelector<HTMLElement>(`[data-object-id="${resize.object.id}"]`);
    if (!el) return;
    el.style.left = `${resize.result.position.x}px`;
    el.style.top = `${resize.result.position.y}px`;
    el.style.width = `${resize.result.size.width}px`;
    el.style.height = `${resize.result.size.height}px`;
  }
  private paintGeometry(): void {
    const object = this.options.objects().find((o) => o.id === this.options.view().focusId);
    node('geometryEdit').hidden = this.options.mobile.matches || !object;
    if (!object) return;
    node('geometrySpace').textContent = object.parentId ? 'Position in parent' : 'Position on canvas';
    for (const [id, value] of [
      ['positionX', object.position.x],
      ['positionY', object.position.y],
      ['sizeWidth', object.size?.width],
      ['sizeHeight', object.size?.height],
    ]) {
      if (typeof id !== 'string') continue;
      const field = node(id);
      if (!(field instanceof HTMLInputElement)) continue;
      field.disabled = !this.connected || value === undefined;
      if (document.activeElement !== field)
        field.value = typeof value === 'number' ? String(Math.round(value * 100) / 100) : '';
    }
  }
  private numericGeometry(): void {
    const object = this.options.objects().find((o) => o.id === this.options.view().focusId);
    if (!object || !this.available()) return;
    const value = (id: string): number => {
      const el = node(id);
      return el instanceof HTMLInputElement ? el.valueAsNumber : NaN;
    };
    const position = { x: value('positionX'), y: value('positionY') };
    const size = object.size ? { width: value('sizeWidth'), height: value('sizeHeight') } : null;
    if (
      ![position.x, position.y, ...(size ? [size.width, size.height] : [])].every(Number.isFinite) ||
      (size && (size.width <= 0 || size.height <= 0))
    ) {
      node('announcement').textContent = 'Enter finite coordinates and a positive size.';
      return;
    }
    this.setGeometry(object, position, size);
  }
  private setGeometry(object: ViewObject, position: Point, size: ViewObject['size']): void {
    const operations: Edit[] = [];
    if (object.position.x !== position.x || object.position.y !== position.y)
      operations.push({ kind: 'move', opId: crypto.randomUUID(), objectId: object.id, patch: { position } });
    if (size && (size.width !== object.size?.width || size.height !== object.size?.height))
      operations.push({ kind: 'update', opId: crypto.randomUUID(), objectId: object.id, patch: { size } });
    if (operations.length) this.submit(operations);
  }
  private validDestination(id: string): boolean {
    const selected = this.moveGesture?.originals ?? targets(this.options.objects(), this.options.view().selected);
    const ids = new Set(selected.map((o) => o.id));
    let parent: string | null = id;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      if (ids.has(parent)) return false;
      seen.add(parent);
      parent = this.options.objects().find((o) => o.id === parent)?.parentId ?? null;
    }
    return true;
  }
  private refreshDestinations(): void {
    const select = node('moveDestination');
    select.replaceChildren();
    for (const o of [null, ...this.options.objects().filter((o) => container(o) && this.validDestination(o.id))]) {
      const option = document.createElement('option');
      option.value = o?.id ?? '';
      option.textContent = o
        ? `${label(o)}${o.parentId ? ` · in ${label(this.options.objects().find((p) => p.id === o.parentId) ?? o)}` : ''}`
        : 'Canvas root';
      select.append(option);
    }
  }
  private reparent(parentId: string | null): void {
    const selected = targets(this.options.objects(), this.options.view().selected);
    if (parentId && !this.validDestination(parentId)) return;
    this.submit(
      selected.map((o) => ({
        kind: 'reparent',
        opId: crypto.randomUUID(),
        objectId: o.id,
        patch: { parentId, order: Date.now(), preserveWorld: true },
      }))
    );
  }
  private movePointer(e: PointerEvent): void {
    const gesture = this.moveGesture;
    if (!gesture) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    gesture.delta = {
      x: (e.clientX - gesture.start.x) / this.options.view().viewport.zoom,
      y: (e.clientY - gesture.start.y) / this.options.view().viewport.zoom,
    };
    if (Math.hypot(e.clientX - gesture.start.x, e.clientY - gesture.start.y) > 4) gesture.moved = true;
    if (!gesture.moved) return;
    this.options.dispatch({ kind: 'selection', ids: gesture.originals.map((o) => o.id) });
    const moving = gesture.originals.map((o) => node('layer').querySelector<HTMLElement>(`[data-object-id="${o.id}"]`));
    for (const el of moving) if (el) el.style.pointerEvents = 'none';
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-container-id]');
    for (const el of moving) if (el) el.style.pointerEvents = '';
    const id = target?.dataset.containerId;
    gesture.destination = id && this.validDestination(id) ? id : null;
    for (const el of node('layer').querySelectorAll('.drop-target')) el.classList.remove('drop-target');
    if (gesture.destination) {
      const el = node('layer').querySelector<HTMLElement>(`[data-object-id="${gesture.destination}"]`);
      el?.classList.add('drop-target');
      const destination = this.options.objects().find((o) => o.id === gesture.destination);
      node('dropName').textContent = destination ? `Move to ${label(destination)}` : '';
      node('dropName').style.left = `${Math.min(innerWidth - 240, e.clientX + 16)}px`;
      node('dropName').style.top = `${Math.max(8, e.clientY - 40)}px`;
    }
    node('dropName').hidden = !gesture.destination;
    this.previewMove();
  }
  private previewMove(): void {
    const gesture = this.moveGesture;
    if (!gesture?.moved) return;
    for (const object of gesture.originals) {
      const position = movedPosition(gesture.all, object, gesture.delta);
      const el = node('layer').querySelector<HTMLElement>(`[data-object-id="${object.id}"]`);
      if (el) {
        el.style.left = `${position.x}px`;
        el.style.top = `${position.y}px`;
      }
    }
  }
  private commitMove(): void {
    const gesture = this.moveGesture;
    if (!gesture) return;
    const operations: Edit[] = gesture.originals.map((o) => ({
      kind: 'move',
      opId: crypto.randomUUID(),
      objectId: o.id,
      patch: { position: movedPosition(gesture.all, o, gesture.delta) },
    }));
    if (gesture.destination)
      for (const o of gesture.originals)
        operations.push({
          kind: 'reparent',
          opId: crypto.randomUUID(),
          objectId: o.id,
          patch: { parentId: gesture.destination, order: Date.now(), preserveWorld: true },
        });
    this.submit(operations);
  }
  private startKeyboardMove(): void {
    if (!this.available()) return;
    const selected = targets(this.options.objects(), this.options.view().selected);
    if (!selected.length) return;
    this.moveGesture = {
      pointerId: null,
      start: { x: 0, y: 0 },
      delta: { x: 0, y: 0 },
      originals: selected,
      all: this.options.objects(),
      destination: null,
      moved: false,
      shift: false,
      target: selected[0].id,
    };
    node('moveHint').hidden = false;
    node('board').focus({ preventScroll: true });
  }
  private async undo(direction: 'undo' | 'redo'): Promise<void> {
    if (!this.available()) return;
    if (this.queue.busy) {
      node('announcement').textContent = 'Wait for pending edits to save before changing history.';
      return;
    }
    try {
      const response = await fetch(
        this.options.url(`/api/canvas/${this.options.workspace}/objects?includeDeleted=true`)
      );
      if (!response.ok) throw new Error('History could not load the latest objects.');
      const snapshot = parseSnapshot(await response.json());
      const action = this.history.prepare(direction, snapshot.objects);
      if (action && !this.submit(action.operations)) this.history.refused();
    } catch (error) {
      this.history.refused();
      node('announcement').textContent = error instanceof Error ? error.message : 'History could not be changed.';
    }
  }
  private key(e: KeyboardEvent): void {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape' && (this.selectionGesture || this.moveGesture || this.resizeGesture)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.cancelSelection();
      return;
    }
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
    if (this.moveGesture?.pointerId === null) {
      const gesture = this.moveGesture;
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (gesture.moved) this.commitMove();
        this.cancelSelection();
        return;
      }
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const step = e.shiftKey ? 1 : 10;
        gesture.delta.x += e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        gesture.delta.y += e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        gesture.moved = true;
        this.previewMove();
        return;
      }
    }
    if (e.key === ' ') this.space = true;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) void this.undo(e.shiftKey ? 'redo' : 'undo');
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.remove();
    }
  }
}
import { EditSchema } from './edit-queue.js';
