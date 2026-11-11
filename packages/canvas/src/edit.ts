import { knownContentFields } from '../../../src/canvas/model.js';
import { copied, pasted, selectionBox, snapped, lockOwner } from './arrange.js';
import { worldBounds } from './tree.js';
import { worldOrigin } from './drag.js';
import { handles, resized } from './resize.js';
import { movedPosition } from './drag.js';
import { label, ViewObjectSchema } from './model.js';
import { targets, selectRegion } from './select.js';
import { type Point, union } from './viewport.js';
import { CanvasUndo } from './undo.js';
import { canvasStorageKeys, clipboardTooLarge, retireUnscopedKeys, type CanvasStorageKeys } from './storage-keys.js';
import { parseSnapshot } from './edit-queue.js';
import { lockedSentence, refusalCopy, requestVerb, type RefusalVerb } from './refusal.js';
import { z } from 'zod';
import {
  EditQueue,
  sendEdits,
  sendCommand,
  type CanvasRequest,
  type Edit,
  type QueueStatus,
  type Acknowledged,
} from './edit-queue.js';
import { editable, container, type Snapshot, type ViewObject } from './model.js';
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
const DraftSchema = z.object({
  base: z.string(),
  value: z.string(),
  revision: z.number(),
  conflict: z.boolean(),
  conflictAuthor: z.string().optional(),
});
/** `sent` is valid only while the queue still holds `sentOp`; `saveText` clears a marker that outlived it. */
type Draft = z.infer<typeof DraftSchema> & { sent?: string; sentOp?: string };
export class DesktopEditor {
  readonly queue: EditQueue;
  private history = new CanvasUndo();
  private clipboard: ViewObject[] = [];
  private pasteCount = 0;
  private compoundResize: {
    pointerId: number;
    start: Point;
    box: ReturnType<typeof selectionBox>;
    objects: ViewObject[];
    ids: string[];
    handle: string;
    result: ReturnType<typeof resized>;
  } | null = null;
  private guides: HTMLElement[] = [];
  private selectCreated = false;
  private commandFocus: string | null | undefined;
  private nextSelection: string[] | null = null;
  private submittedFocus = new Map<string, string | null>();
  private drafts = new Map<string, Draft>();
  private currentId: string | null = null;
  private authoritative: ViewObject[] = [];
  private status: QueueStatus = 'offline';
  private message = '';
  private readerRefusal = false;
  private refusalDetail: string | undefined;
  private selectionKey = '';
  private connected = false;
  private availability = '';
  private handlesDirty = true;
  private loaded = false;
  private sequence = 0;
  private composing = false;
  private actions = 0;
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
  private keys: CanvasStorageKeys;
  constructor(
    private options: {
      url: (path: string) => string;
      workspace: string;
      /** Who is editing: the signed-in user, or `@single` without multi-user mode. */
      viewer: string;
      mobile: MediaQueryList;
      view: () => ViewState;
      objects: () => ViewObject[];
      dispatch: (action: ViewCommand) => void;
      focusMode: (keyboard: boolean) => void;
      display: (objects: ViewObject[]) => void;
    }
  ) {
    const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    overlay.id = 'selectionGesture';
    overlay.setAttribute('aria-hidden', 'true');
    this.selectionPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
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
    this.keys = canvasStorageKeys(options.viewer, options.workspace);
    try {
      retireUnscopedKeys(localStorage, options.viewer, options.workspace);
    } catch {
      /* Without storage there is nothing to retire. */
    }
    try {
      const stored = z.record(z.string(), DraftSchema).parse(JSON.parse(localStorage.getItem(this.draftKey) ?? '{}'));
      this.drafts = new Map(Object.entries(stored));
    } catch {
      /* Unreadable drafts do not replace the server's content. */
    }
    this.queue = new EditQueue({
      storage: localStorage,
      key: this.keys.edits,
      send: (ops, since) => sendEdits(options.url, options.workspace, ops, since),
      sendCommand: (request, since) => sendCommand(options.url, options.workspace, request, since),
      display: (objects) => {
        if (this.loaded) {
          options.display(objects);
          this.handlesDirty = true;
        }
      },
      status: (status, message) => {
        this.status = status;
        this.message = message;
        this.paintStatus();
        this.paintAvailability();
        if (status === 'failed' || status === 'refused')
          this.say(status === 'refused' && this.readerRefusal ? '' : message, this.refusalDetail);
      },
      acknowledged: (ops) => this.acknowledge(ops),
      describe: (ops, request, error) => {
        const fallbackId = request ? undefined : ops[0]?.objectId;
        const copy = refusalCopy(
          this.authoritative.length ? this.authoritative : this.options.objects(),
          error.reasons.map((r) => ({ ...r, objectId: r.objectId ?? fallbackId })),
          requestVerb(request, ops),
          request,
          error.message
        );
        this.refusalDetail = copy.detail;
        return copy.text;
      },
      refused: (ops, _message, reasons) => {
        this.readerRefusal = ops.some((op) => op.kind === 'update' && !!op.patch.content);
        this.history.refused();
        this.selectCreated = false;
        this.nextSelection = null;
        const revision = reasons.some((r) => r.code === 'REVISION');
        for (const op of ops) {
          const draft = this.drafts.get(op.objectId);
          if (op.kind !== 'update' || !op.patch.content || !draft) continue;
          if (revision) draft.conflict = true;
          if (draft.sentOp === op.opId) {
            delete draft.sent;
            delete draft.sentOp;
          }
        }
        this.persistDrafts();
      },
    });
    btn('addTool').onclick = () => {
      if (!this.available()) return;
      this.showAddMenu(node('addMenu').hidden);
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
      if (this.refuseLocked(btn('editSelection'))) return;
      const id = options.view().selected[0];
      if (id) {
        options.dispatch({ kind: 'focus', id });
        options.dispatch({ kind: 'rail', view: 'reader' });
      }
    };
    btn('deleteSelection').onclick = () => {
      if (!this.refuseLocked(btn('deleteSelection'))) this.remove();
    };
    for (const id of ['positionX', 'positionY', 'sizeWidth', 'sizeHeight']) {
      const field = node(id);
      if (field instanceof HTMLInputElement) field.onchange = () => this.numericGeometry();
    }
    const rotation = node('rotationDegrees');
    if (rotation instanceof HTMLInputElement) rotation.onchange = () => this.numericRotation(rotation);
    this.installArrange();
    btn('moveTo').onclick = () => {
      if (this.refuseLocked(btn('moveTo'))) return;
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
    btn('retryEdit').onclick = () => {
      const refusedText = this.status === 'refused' && this.readerRefusal;
      this.queue.retry();
      // A refused text save is already out of the queue; Retry sends the kept draft again.
      if (refusedText) this.saveText();
    };
    btn('discardEdit').onclick = () => {
      this.queue.discard();
      this.history.refused();
      this.commandFocus = undefined;
      this.selectCreated = false;
      this.nextSelection = null;
      for (const draft of this.drafts.values())
        if (draft.sent !== undefined) {
          draft.value = draft.base;
          delete draft.sent;
          delete draft.sentOp;
        }
      this.persistDrafts();
      this.read(this.options.objects().find((o) => o.id === this.currentId));
      this.paintStatus();
    };
    btn('useServer').onclick = () => void this.resolve(false);
    btn('keepDraft').onclick = () => void this.resolve(true);
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
    document.addEventListener('compositionstart', () => {
      this.composing = true;
    });
    document.addEventListener('compositionend', () => {
      this.composing = false;
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => this.saveText(), 600);
    });
    document.addEventListener('keydown', (e) => this.key(e), true);
    options.mobile.addEventListener('change', () => {
      if (options.mobile.matches) {
        clearTimeout(this.debounce);
        this.cancelSelection();
        this.showAddMenu(false);
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
  adapter() {
    return {
      command: (request: CanvasRequest) => this.compound(request),
      apply: (operations: Edit[]) => this.submit(operations.map((op) => EditSchema.parse(op))),
      read: () =>
        structuredClone({
          objects: this.options.objects(),
          status: this.status,
          pending: this.queue.busy || this.actions > 0,
          drafts: Object.fromEntries(this.drafts),
          locks: this.options
            .objects()
            .map((o) => ({ id: o.id, local: o.lock, effective: lockOwner(this.options.objects(), o)?.id ?? null })),
          readOnlyIds: this.options
            .objects()
            .filter((o) => !editable(o))
            .map((o) => o.id),
        }),
      move: (args: { targetIds: string[]; delta: Point }) =>
        this.compound({
          tool: 'canvas_transform',
          arguments: {
            targetIds: args.targetIds,
            space: 'world',
            anchor: { x: 0, y: 0 },
            translation: args.delta,
            scale: { width: 1, height: 1 },
            rotation: 0,
          },
        }),
      reparent: (args: { targetIds: string[]; parentId: string | null }) =>
        this.reparent(args.parentId, args.targetIds),
      delete: (targetIds: string[]) =>
        this.compound({
          tool: 'canvas_delete',
          arguments: {
            operations: targets(this.options.objects(), targetIds).map((o) => ({
              kind: 'delete',
              opId: crypto.randomUUID(),
              objectId: o.id,
            })),
          },
        }),
      undo: () => this.undo('undo'),
      redo: () => this.undo('redo'),
      resize: (args: {
        objectId: string;
        handle: string;
        delta: Point;
        proportional: boolean;
        fromCenter: boolean;
      }) => {
        if (!this.available() || !handles.includes(args.handle)) return false;
        const object = this.options.objects().find((o) => o.id === args.objectId);
        if (!object?.size) return false;
        const geometry = resized(
          this.options.objects(),
          object,
          args.handle,
          args.delta,
          args.proportional,
          args.fromCenter
        );
        if (!geometry) return false;
        return this.setGeometry(object, geometry.position, geometry.size);
      },
      capabilities: {
        edits: ['create', 'update', 'move', 'reparent', 'delete', 'restore', 'revert'],
        selection: ['selection', 'toggle', 'select-all', 'region'],
        geometrySpace: 'parent-local',
        rectangleSelection: 'enclosed-bounds',
        polygonSelection: 'object-center',
        overlappingTargets: 'ancestor-only',
        resizeDeltaSpace: 'world',
        autoBoundedGroupResize: 'uniform-subtree',
        flip: 'Unsupported: the server accepts positive scales only',
        rotation: 'Every editable type, in degrees, about the selection centre',
        distributeSpacing: 'Command endpoint only (canvas_arrange distribute spacing)',
        backgroundLock: ['frame', 'section'],
      },
    };
  }
  private say(message: string, detail?: string): void {
    node('actionMessage').textContent = message;
    node('actionMessage').hidden = !message;
    if (detail && message) node('actionMessage').title = detail;
    else node('actionMessage').removeAttribute('title');
  }
  private refuseLocked(control: HTMLButtonElement): boolean {
    if (control.getAttribute('aria-disabled') !== 'true') return false;
    if (control.dataset.reason) this.say(control.dataset.reason);
    return true;
  }
  private compound(request: CanvasRequest): boolean {
    if (!this.available()) return false;
    if (this.queue.busy || this.actions) {
      this.say('Wait for pending edits to save before this action.');
      return false;
    }
    const requested = z
      .object({ targetIds: z.array(z.string()).optional() })
      .passthrough()
      .safeParse(request.arguments);
    if (
      requested.success &&
      requested.data.targetIds?.some((id) => this.options.objects().some((o) => o.id === id && !editable(o)))
    ) {
      this.say('Unsupported objects are read-only.');
      return false;
    }
    const accepted = this.queue.enqueueCommand(request);
    if (accepted) this.commandFocus = this.options.view().focusId;
    return accepted;
  }
  private showArrange(open: boolean): void {
    node('arrangeMenu').hidden = !open;
    btn('arrangeSelection').setAttribute('aria-expanded', String(open));
  }
  private ids(): string[] {
    return targets(this.options.objects(), this.options.view().selected).map((o) => o.id);
  }
  private installArrange(): void {
    btn('arrangeSelection').onclick = () => {
      if (this.refuseLocked(btn('arrangeSelection'))) return;
      this.say('');
      const open = node('arrangeMenu').hidden;
      this.showArrange(open);
      if (open) node('arrangeMenu').querySelector<HTMLButtonElement>('button:not([hidden])')?.focus();
    };
    btn('groupSelection').onclick = () => {
      if (this.refuseLocked(btn('groupSelection'))) return;
      const selected = targets(this.options.objects(), this.ids());
      this.group(selected.length === 1 && selected[0].type === 'group');
    };
    btn('duplicateSelection').onclick = () => this.duplicate();
    btn('lockSelection').onclick = () => {
      const selected = targets(this.options.objects(), this.ids());
      this.compound({
        tool: 'canvas_lock',
        arguments: {
          targetIds: selected.map((o) => o.id),
          mode: selected.some((o) => lockOwner(this.options.objects(), o)) ? 'unlock' : 'subtree',
        },
      });
    };
    btn('backgroundLock').onclick = () => {
      this.showArrange(false);
      this.compound({ tool: 'canvas_lock', arguments: { targetIds: this.ids(), mode: 'background' } });
    };
    btn('wrapFrame').onclick = () => this.group(false, 'frame');
    btn('wrapSection').onclick = () => this.group(false, 'section');
    btn('addPaste').onclick = () => {
      this.showAddMenu(false);
      this.paste();
    };
    for (const button of node('arrangeMenu').querySelectorAll<HTMLButtonElement>('[data-align]'))
      button.onclick = () => {
        if (button.getAttribute('aria-disabled') === 'true') return;
        const [axis, anchor] = (button.dataset.align ?? '').split('-');
        this.showArrange(false);
        this.compound({
          tool: 'canvas_arrange',
          arguments: {
            action: 'align',
            targetIds: this.ids(),
            axis: z.enum(['x', 'y']).parse(axis),
            anchor: z.enum(['start', 'center', 'end']).parse(anchor),
          },
        });
      };
    for (const button of node('arrangeMenu').querySelectorAll<HTMLButtonElement>('[data-distribute]'))
      button.onclick = () => {
        if (button.getAttribute('aria-disabled') === 'true') return;
        this.showArrange(false);
        this.compound({
          tool: 'canvas_arrange',
          arguments: {
            action: 'distribute',
            targetIds: this.ids(),
            axis: z.enum(['x', 'y']).parse(button.dataset.distribute),
          },
        });
      };
    for (const button of node('arrangeMenu').querySelectorAll<HTMLButtonElement>('[data-order]'))
      button.onclick = () => this.order(z.enum(['front', 'back', 'forward', 'backward']).parse(button.dataset.order));
  }
  private order(placement: 'front' | 'back' | 'forward' | 'backward'): void {
    const targetIds = this.ids();
    if (!targetIds.length) return;
    this.showArrange(false);
    this.compound({ tool: 'canvas_arrange', arguments: { action: 'order', targetIds, placement } });
  }
  private numericRotation(field: HTMLInputElement): void {
    const object = this.options.objects().find((o) => o.id === this.options.view().focusId);
    if (!object || !this.available()) return;
    if (!Number.isFinite(field.valueAsNumber)) {
      node('announcement').textContent = 'Enter a finite rotation in degrees.';
      return;
    }
    const rotation = field.valueAsNumber - object.rotation;
    if (!rotation) return;
    const box = selectionBox(this.options.objects(), [object.id]);
    this.compound({
      tool: 'canvas_transform',
      arguments: {
        targetIds: [object.id],
        space: 'world',
        anchor: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
        translation: { x: 0, y: 0 },
        scale: { width: 1, height: 1 },
        rotation,
      },
    });
  }
  private group(ungroup: boolean, containerType: 'group' | 'frame' | 'section' = 'group'): void {
    const targetIds = this.ids();
    if (!targetIds.length) return;
    this.showArrange(false);
    if (ungroup) {
      const children = this.options
        .objects()
        .filter((o) => targetIds.includes(o.parentId ?? ''))
        .map((o) => o.id);
      if (this.compound({ tool: 'canvas_arrange', arguments: { action: 'ungroup', targetIds } }))
        this.nextSelection = children;
    } else {
      const selected = targets(this.options.objects(), targetIds);
      const parentId = selected.every((o) => o.parentId === selected[0].parentId) ? selected[0].parentId : null;
      if (
        this.compound({
          tool: 'canvas_arrange',
          arguments: {
            action: 'group',
            targetIds,
            parentId,
            groupId: crypto.randomUUID(),
            label: `Untitled ${containerType}`,
            containerType,
          },
        })
      )
        this.selectCreated = true;
    }
  }
  private copy(cut: boolean): void {
    this.showArrange(false);
    const clipboard = copied(this.options.objects(), this.ids());
    if (!clipboard.length) return;
    const serialized = JSON.stringify(clipboard);
    if (clipboardTooLarge(serialized)) {
      this.say('This selection is too large to copy. Copy fewer objects or shorter text.');
      return;
    }
    this.clipboard = clipboard;
    try {
      localStorage.setItem(this.keys.clipboard, serialized);
    } catch {
      this.say('Clipboard storage is unavailable.');
      return;
    }
    this.pasteCount = 0;
    if (cut) {
      if (
        this.compound({
          tool: 'canvas_delete',
          arguments: {
            operations: this.ids().map((objectId) => ({ kind: 'delete', objectId, opId: crypto.randomUUID() })),
          },
        })
      )
        this.nextSelection = [];
    } else this.say(`Copied ${this.ids().length} selected.`);
  }
  private paste(): void {
    this.showArrange(false);
    try {
      const stored = localStorage.getItem(this.keys.clipboard) ?? '[]';
      if (clipboardTooLarge(stored)) throw new Error('Clipboard too large');
      this.clipboard = z.array(ViewObjectSchema).parse(JSON.parse(stored));
      if (!this.clipboard.length) {
        this.say('Copy a canvas selection before pasting.');
        return;
      }
      const offset = 24 * (this.pasteCount + 1);
      const operations = pasted(this.clipboard, { x: offset, y: offset });
      if (
        this.compound({
          tool: 'canvas_create',
          arguments: { operations: operations.filter((o) => o.kind === 'create') },
        })
      ) {
        this.selectCreated = true;
        this.pasteCount++;
      }
    } catch {
      this.say('This clipboard cannot be pasted as editable canvas content.');
    }
  }
  private duplicate(): void {
    this.showArrange(false);
    if (
      this.compound({
        tool: 'canvas_arrange',
        arguments: { action: 'duplicate', targetIds: this.ids(), offset: { x: 24, y: 24 } },
      })
    )
      this.selectCreated = true;
  }
  private get draftKey(): string {
    return this.keys.drafts;
  }
  private persistDrafts(): void {
    try {
      localStorage.setItem(
        this.draftKey,
        JSON.stringify(
          Object.fromEntries(
            [...this.drafts].map(([id, d]) => [
              id,
              {
                base: d.base,
                value: d.value,
                revision: d.revision,
                conflict: d.conflict,
                conflictAuthor: d.conflictAuthor,
              },
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
    if (snapshot.seq < this.sequence) return;
    this.loaded = true;
    this.sequence = snapshot.seq;
    for (const [id, draft] of this.drafts) {
      const object = snapshot.objects.find((o) => o.id === id);
      if (!object) {
        if (draft.value !== draft.base) draft.conflict = true;
        continue;
      }
      const text = this.field(object);
      if (text === null) continue;
      if (text === draft.value) {
        draft.base = text;
        draft.revision = this.revision(object);
        draft.conflict = false;
        delete draft.sent;
        delete draft.sentOp;
      } else if (text !== draft.base && text !== draft.sent && draft.value !== draft.base) {
        draft.conflict = true;
        const previous = this.authoritative.find((o) => o.id === id);
        if (!previous || this.field(previous) !== text || !draft.conflictAuthor)
          draft.conflictAuthor = snapshot.textAuthors?.[id];
      } else if (draft.value === draft.base && !draft.sent) {
        draft.base = text;
        draft.value = text;
        draft.revision = this.revision(object);
      }
    }
    this.authoritative = snapshot.objects;
    this.persistDrafts();
    this.queue.receive(snapshot);
  }
  online(online: boolean): void {
    this.connected = online;
    this.queue.online(online);
  }
  private available(): boolean {
    if (this.options.mobile.matches) return false;
    if (this.connected) {
      if (this.queue.blocked) {
        this.queue.discard();
        this.history.refused();
        this.commandFocus = undefined;
      }
      this.readerRefusal = false;
      this.say('');
      return true;
    }
    node('announcement').textContent = this.message || 'Offline. Reconnect before editing.';
    return false;
  }
  submit(operations: Edit[]): boolean {
    if (!this.available()) return false;
    if (
      operations.some((op) => {
        const object = this.options.objects().find((o) => o.id === op.objectId);
        return object && !editable(object);
      })
    ) {
      node('announcement').textContent = 'Unsupported objects are read-only.';
      return false;
    }
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
    this.showAddMenu(false);
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
    if (!selected.length) return;
    if (
      this.compound({
        tool: 'canvas_delete',
        arguments: { operations: selected.map((o) => ({ kind: 'delete', opId: crypto.randomUUID(), objectId: o.id })) },
      })
    )
      this.nextSelection = [];
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
    if (document.activeElement !== this.editor || this.editor.dataset.draftId !== o.id) this.editor.value = draft.value;
    this.editor.dataset.draftId = o.id;
    this.editor.setAttribute('aria-label', o.type === 'text' ? 'Text' : 'Name');
    node('editorLabel').textContent = o.type === 'text' ? 'Text' : 'Name';
    this.editor.rows = o.type === 'text' ? 9 : 2;
    this.editor.maxLength = o.type === 'text' ? 1_000_000 : 8192;
    this.paintStatus();
    this.paintAvailability();
  }
  private saveText(): void {
    clearTimeout(this.debounce);
    if (!this.currentId || this.composing || !this.available()) return;
    const draft = this.drafts.get(this.currentId),
      object = this.authoritative.find((o) => o.id === this.currentId);
    if (draft && draft.sent !== undefined && !(draft.sentOp && this.queue.holds(draft.sentOp))) {
      delete draft.sent;
      delete draft.sentOp;
    }
    if (!draft || !object || draft.conflict || draft.sent !== undefined || draft.value === draft.base) return;
    const content = { ...knownContentFields(object.content), [object.type === 'text' ? 'text' : 'label']: draft.value };
    const opId = crypto.randomUUID();
    draft.sent = draft.value;
    draft.sentOp = opId;
    if (
      !this.submit([
        this.parse({
          kind: 'update',
          opId,
          objectId: object.id,
          expectedRevision: this.revision(object),
          patch: { content },
        }),
      ])
    ) {
      delete draft.sent;
      delete draft.sentOp;
    }
  }
  private acknowledge(operations: Acknowledged[]): void {
    const created = this.selectCreated ? operations.filter((o) => o.kind === 'create').map((o) => o.objectId) : [];
    this.selectCreated = false;
    const focusId = this.history.acknowledge(
      operations,
      this.commandFocus !== undefined
        ? this.commandFocus
        : (this.submittedFocus.get(operations[0]?.opId ?? '') ?? operations[0]?.objectId ?? null)
    );
    this.commandFocus = undefined;
    for (const op of operations) this.submittedFocus.delete(op.opId);
    if (focusId) {
      this.options.focusMode(true);
      this.options.dispatch({ kind: 'focus', id: focusId });
      requestAnimationFrame(() => {
        const target = node('layer').querySelector<HTMLElement>(`[data-object-id="${focusId}"]`);
        (target ?? node('board')).focus({ preventScroll: true });
      });
    }
    const latest = new Map(this.authoritative.map((o) => [o.id, o]));
    for (const op of operations) {
      if (op.seq >= this.sequence) for (const change of op.prev) latest.set(change.objectId, change.after);
      this.sequence = Math.max(this.sequence, op.seq);
    }
    this.authoritative = [...latest.values()];
    for (const op of operations) {
      const draft = this.drafts.get(op.objectId);
      const after = op.prev.find((c) => c.objectId === op.objectId)?.after;
      if (
        draft &&
        after &&
        ((draft.sent !== undefined && this.field(after) === draft.sent) || this.field(after) === draft.value)
      ) {
        draft.base = this.field(after) ?? draft.base;
        draft.revision = this.revision(after);
        delete draft.sent;
        delete draft.sentOp;
        if (!draft.conflict && draft.value !== draft.base) this.debounce = setTimeout(() => this.saveText(), 50);
      }
    }
    if (created.length || this.nextSelection)
      this.options.display(this.authoritative.filter((o) => o.deletedAt === null));
    if (this.nextSelection) {
      this.options.dispatch({ kind: 'selection', ids: this.nextSelection });
      this.nextSelection = null;
    }
    if (created.length) {
      const createdSet = new Set(created);
      const roots = operations
        .flatMap((op) => op.prev.map((c) => c.after))
        .filter((o) => createdSet.has(o.id) && !createdSet.has(o.parentId ?? ''));
      this.options.dispatch({ kind: 'selection', ids: [...new Set(roots.map((o) => o.id))] });
      this.options.dispatch({ kind: 'focus', id: roots[0]?.id ?? null });
    }
    this.persistDrafts();
  }
  private async resolve(keep: boolean): Promise<void> {
    if (!this.connected || this.options.mobile.matches || this.actions) return;
    this.actions++;
    try {
      const response = await fetch(this.options.url(`/api/canvas/${this.options.workspace}/objects`));
      if (!response.ok) throw new Error('Latest text could not load.');
      this.receive(parseSnapshot(await response.json()));
      const draft = this.currentId ? this.drafts.get(this.currentId) : undefined;
      const object = this.authoritative.find((o) => o.id === this.currentId);
      if (!draft || !object) return;
      if (this.status === 'refused') {
        this.queue.discard();
        this.history.refused();
      }
      draft.base = this.field(object) ?? '';
      if (!keep) draft.value = draft.base;
      draft.conflict = false;
      delete draft.sent;
      delete draft.sentOp;
      this.editor.value = draft.value;
      this.persistDrafts();
      this.paintStatus();
      if (keep) this.saveText();
    } catch {
      node('editStatus').textContent = 'Latest text could not load. Reconnect and try again.';
    } finally {
      this.actions--;
    }
  }
  private paintStatus(): void {
    const draft = this.currentId ? this.drafts.get(this.currentId) : undefined;
    node('editStatus').textContent = draft?.conflict
      ? `${draft.conflictAuthor || 'Someone'} changed this text while you were editing. Your draft is kept.`
      : this.status === 'saved' && draft && draft.value !== draft.base
        ? 'Draft · waiting to save'
        : this.status === 'refused' && !this.readerRefusal
          ? ''
          : this.message;
    node('editStatus').dataset.state = draft?.conflict ? 'conflict' : this.status;
    node('conflictActions').hidden = !draft?.conflict;
    node('retryActions').hidden = this.status !== 'failed' && this.status !== 'refused';
    btn('retryEdit').hidden = !!draft?.conflict || (this.status === 'refused' && !this.readerRefusal);
  }
  private showAddMenu(open: boolean): void {
    node('addMenu').hidden = !open;
    btn('addTool').setAttribute('aria-expanded', String(open));
    btn('addTool').setAttribute('aria-pressed', String(open));
  }
  private paintAvailability(): void {
    const unavailable = !this.connected;
    for (const direction of ['undo', 'redo'] as const)
      btn(`${direction}Edit`).setAttribute(
        'aria-disabled',
        String(unavailable || this.queue.busy || this.actions > 0 || !this.history.available(direction))
      );
    const key = `${unavailable}:${this.connected}`;
    if (this.availability === key && !this.handlesDirty) return;
    this.availability = key;
    this.handlesDirty = false;
    for (const id of [
      'addTool',
      'addText',
      'addFrame',
      'addSection',
      'addSubcanvas',
      'deleteSelection',
      'duplicateSelection',
      'moveTo',
      'commitMoveTo',
      'arrangeSelection',
      'groupSelection',
      'lockSelection',
    ])
      btn(id).disabled = unavailable;
    for (const handle of node('layer').querySelectorAll<HTMLButtonElement>('[data-resize]'))
      handle.disabled = unavailable;
    this.editor.readOnly = unavailable;
    btn('keepDraft').disabled = !this.connected;
    btn('useServer').disabled = !this.connected;
  }
  paint(): void {
    const ids = this.options.view().selected;
    const selectionKey = ids.join(' ');
    // A refusal names the selection it was about; it must not outlive that selection.
    if (selectionKey !== this.selectionKey && this.status !== 'failed') this.say('');
    this.selectionKey = selectionKey;
    node('contextRow').hidden = this.options.mobile.matches || !ids.length;
    btn('editSelection').hidden = ids.length !== 1;
    node('selectionCount').textContent = `${ids.length} selected`;
    const objects = this.options.objects();
    const selected = targets(objects, ids);
    const ungroup = selected.length === 1 && selected[0].type === 'group';
    btn('groupSelection').hidden = !ungroup && selected.length < 2;
    btn('groupSelection').textContent = ungroup ? 'Ungroup' : 'Group';
    btn('groupSelection').title = ungroup ? 'Ungroup · Shift+Cmd/Ctrl+G' : 'Group · Cmd/Ctrl+G';
    const locked = selected.find((o) => lockOwner(objects, o));
    btn('lockSelection').textContent = locked ? 'Unlock' : 'Lock';
    btn('lockSelection').classList.toggle('primary', !!locked);
    const forbidden: [string, RefusalVerb][] = [
      ['moveTo', 'move'],
      ['arrangeSelection', 'move'],
      ['groupSelection', ungroup ? 'ungroup' : 'group'],
      ['editSelection', 'edit'],
      ['deleteSelection', 'delete'],
    ];
    for (const [id, verb] of forbidden) {
      const control = btn(id);
      const reason = locked ? lockedSentence(objects, locked, verb) : null;
      node(`${id}Reason`).textContent = reason ?? '';
      if (reason) {
        control.setAttribute('aria-disabled', 'true');
        control.dataset.reason = reason;
        control.setAttribute('aria-describedby', `${id}Reason`);
      } else {
        control.removeAttribute('aria-disabled');
        delete control.dataset.reason;
        control.removeAttribute('aria-describedby');
      }
    }
    btn('backgroundLock').hidden =
      !selected.length || !selected.every((o) => o.type === 'frame' || o.type === 'section');
    for (const control of node('arrangeMenu').querySelectorAll<HTMLButtonElement>('button'))
      control.disabled = !this.connected;
    for (const [selector, minimum, verb] of [
      ['[data-align]', 2, 'align'],
      ['[data-distribute]', 3, 'distribute'],
    ] as const)
      for (const control of node('arrangeMenu').querySelectorAll<HTMLButtonElement>(selector)) {
        const short = selected.length < minimum;
        control.setAttribute('aria-disabled', String(short));
        control.title = short
          ? `${control.getAttribute('aria-label')} · select ${minimum === 2 ? 'two' : 'three'} or more objects to ${verb}`
          : (control.getAttribute('aria-label') ?? '');
      }
    if (this.options.mobile.matches || !selected.length || locked) this.showArrange(false);
    this.read(objects.find((o) => o.id === this.options.view().focusId));
    this.paintAvailability();
    this.previewMove();
    this.previewResize();
    this.previewCombined();
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
    this.options.focusMode(false);
    const targetId =
      e.target instanceof Element ? e.target.closest<HTMLElement>('[data-object-id]')?.dataset.objectId : undefined;
    const handle =
      e.target instanceof Element ? e.target.closest<HTMLElement>('[data-resize]')?.dataset.resize : undefined;
    const combinedHandle =
      e.target instanceof Element
        ? e.target.closest<HTMLElement>('[data-combined-resize]')?.dataset.combinedResize
        : undefined;
    if (combinedHandle) {
      if (!this.available()) return;
      const ids = this.ids();
      if (!ids.length) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.compoundResize = {
        pointerId: e.pointerId,
        start: { x: e.clientX, y: e.clientY },
        box: selectionBox(this.options.objects(), ids),
        objects: this.options.objects(),
        ids,
        handle: combinedHandle,
        result: null,
      };
      node('board').setPointerCapture(e.pointerId);
      node('board').focus({ preventScroll: true });
      return;
    }
    if (targetId && handle) {
      const object = this.options.objects().find((o) => o.id === targetId);
      if (!object?.size || !editable(object) || !this.available()) return;
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
      const object = this.options.objects().find((o) => o.id === targetId);
      if (!object || !editable(object) || !this.available()) return;
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
    const combined = this.compoundResize;
    if (combined?.pointerId === e.pointerId) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const sample = combined.objects.find((o) => combined.ids.includes(o.id));
      if (!sample) return;
      const zoom = this.options.view().viewport.zoom;
      let delta = { x: (e.clientX - combined.start.x) / zoom, y: (e.clientY - combined.start.y) / zoom };
      delta = this.snapResize(combined.objects, combined.ids, combined.box, delta, combined.handle, e.ctrlKey);
      combined.result = resized(
        [],
        {
          ...sample,
          parentId: null,
          position: { x: combined.box.x, y: combined.box.y },
          size: { width: combined.box.width, height: combined.box.height },
          rotation: 0,
        },
        combined.handle,
        delta,
        e.shiftKey || combined.objects.some((o) => combined.ids.includes(o.id) && o.type === 'group'),
        e.altKey
      );
      this.previewCombined();
      return;
    }
    const resize = this.resizeGesture;
    if (resize?.pointerId === e.pointerId) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const zoom = this.options.view().viewport.zoom;
      resize.result = resized(
        resize.all,
        resize.object,
        resize.handle,
        this.snapResize(
          resize.all,
          [resize.object.id],
          worldBounds(resize.all, resize.object),
          { x: (e.clientX - resize.start.x) / zoom, y: (e.clientY - resize.start.y) / zoom },
          resize.handle,
          e.ctrlKey
        ),
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
    const combined = this.compoundResize;
    if (combined?.pointerId === e.pointerId) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (combined.result)
        this.compound({
          tool: 'canvas_transform',
          arguments: {
            targetIds: combined.ids,
            space: 'world',
            anchor: { x: combined.box.x, y: combined.box.y },
            translation: {
              x: combined.result.position.x - combined.box.x,
              y: combined.result.position.y - combined.box.y,
            },
            scale: {
              width: combined.result.size.width / combined.box.width,
              height: combined.result.size.height / combined.box.height,
            },
            rotation: 0,
          },
        });
      this.cancelSelection();
      return;
    }
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
    if (region && gesture.points.some((p) => Math.hypot(p.x - gesture.start.x, p.y - gesture.start.y) > 4))
      this.options.dispatch({ kind: 'region', region, parentId: gesture.parentId, toggle: gesture.toggle });
    else if (!gesture.toggle) this.options.dispatch({ kind: 'selection', ids: [] });
    this.cancelSelection();
  }
  private cancelSelection(): void {
    if (this.moveGesture || this.resizeGesture || this.compoundResize) {
      for (const object of this.options.objects()) {
        const el = node('layer').querySelector<HTMLElement>(`[data-object-id="${object.id}"]`);
        if (el) {
          el.style.scale = '';
          el.style.left = `${object.position.x}px`;
          el.style.top = `${object.position.y}px`;
          if (object.size) {
            el.style.width = `${object.size.width}px`;
            el.style.height = `${object.size.height}px`;
          }
        }
      }
    }
    node('selectionBounds').style.translate = '';
    if (this.compoundResize) {
      const box = selectionBox(this.options.objects(), this.options.view().selected),
        chrome = node('selectionBounds');
      chrome.style.left = `calc(${box.x}px - 6px / var(--zoom))`;
      chrome.style.top = `calc(${box.y}px - 6px / var(--zoom))`;
      chrome.style.width = `calc(${box.width}px * var(--zoom) + 12px)`;
      chrome.style.height = `calc(${box.height}px * var(--zoom) + 12px)`;
    }
    this.compoundResize = null;
    this.paintGuides([]);
    this.moveGesture = null;
    this.resizeGesture = null;
    for (const el of node('layer').querySelectorAll('.drop-target')) el.classList.remove('drop-target');
    node('dropName').hidden = true;
    node('moveHint').hidden = true;
    this.selectionGesture = null;
    this.selectionPath.removeAttribute('d');
    for (const el of node('layer').querySelectorAll('.selection-preview')) el.classList.remove('selection-preview');
  }
  private paintGuides(guides: { axis: 'x' | 'y'; value: number }[]): void {
    for (const el of this.guides) el.remove();
    const viewport = this.options.view().viewport;
    this.guides = guides.map(({ axis, value }) => {
      const el = document.createElement('div');
      el.className = 'alignment-guide';
      el.dataset.axis = axis;
      el.style[axis === 'x' ? 'left' : 'top'] = `${viewport[axis] + value * viewport.zoom}px`;
      node('board').append(el);
      return el;
    });
  }
  private snapResize(
    objects: ViewObject[],
    ids: string[],
    box: ReturnType<typeof selectionBox>,
    delta: Point,
    handle: string,
    disabled: boolean
  ): Point {
    const edge = {
      x: box.x + (handle.includes('e') ? box.width : 0),
      y: box.y + (handle.includes('s') ? box.height : 0),
      width: 0,
      height: 0,
    };
    const snap = snapped(objects, ids, edge, delta, this.options.view().viewport.zoom, disabled);
    const guides = snap.guides.filter((g) =>
      g.axis === 'x' ? handle.includes('e') || handle.includes('w') : handle.includes('n') || handle.includes('s')
    );
    this.paintGuides(guides);
    return {
      x: guides.some((g) => g.axis === 'x') ? snap.delta.x : delta.x,
      y: guides.some((g) => g.axis === 'y') ? snap.delta.y : delta.y,
    };
  }
  private previewCombined(): void {
    const gesture = this.compoundResize;
    if (!gesture?.result) return;
    const { box, result, objects, ids } = gesture;
    const sx = result.size.width / box.width,
      sy = result.size.height / box.height;
    for (const object of targets(objects, ids)) {
      const world = worldOrigin(objects, object);
      const delta = {
        x: result.position.x + (world.x - box.x) * sx - world.x,
        y: result.position.y + (world.y - box.y) * sy - world.y,
      };
      const position = movedPosition(objects, object, delta);
      const el = node('layer').querySelector<HTMLElement>(`[data-object-id="${object.id}"]`);
      if (!el) continue;
      el.style.left = `${position.x}px`;
      el.style.top = `${position.y}px`;
      if (object.type === 'group') el.style.scale = String(sx);
      else if (object.size) {
        el.style.width = `${object.size.width * sx}px`;
        el.style.height = `${object.size.height * sy}px`;
      }
    }
    const chrome = node('selectionBounds');
    chrome.style.left = `calc(${result.position.x}px - 6px / var(--zoom))`;
    chrome.style.top = `calc(${result.position.y}px - 6px / var(--zoom))`;
    chrome.style.width = `calc(${result.size.width}px * var(--zoom) + 12px)`;
    chrome.style.height = `calc(${result.size.height}px * var(--zoom) + 12px)`;
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
    node('geometryEdit').hidden = this.options.mobile.matches || !object || !editable(object);
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
      field.disabled = !this.connected || this.status === 'refused' || value === undefined;
      if (document.activeElement !== field)
        field.value = typeof value === 'number' ? String(Math.round(value * 100) / 100) : '';
    }
    const rotation = node('rotationDegrees');
    node('rotationField').hidden = !editable(object);
    if (rotation instanceof HTMLInputElement) {
      rotation.disabled = !this.connected || this.status === 'refused';
      if (document.activeElement !== rotation) rotation.value = String(Math.round(object.rotation * 100) / 100);
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
  private setGeometry(object: ViewObject, position: Point, size: ViewObject['size']): boolean {
    const operations: Edit[] = [];
    if (object.position.x !== position.x || object.position.y !== position.y)
      operations.push({ kind: 'move', opId: crypto.randomUUID(), objectId: object.id, patch: { position } });
    if (size && (size.width !== object.size?.width || size.height !== object.size?.height))
      operations.push({ kind: 'update', opId: crypto.randomUUID(), objectId: object.id, patch: { size } });
    return operations.length ? this.compound({ tool: 'canvas_update', arguments: { operations } }) : true;
  }
  private validDestination(id: string, targetIds?: string[]): boolean {
    const selected = targetIds
      ? targets(this.options.objects(), targetIds)
      : (this.moveGesture?.originals ?? targets(this.options.objects(), this.options.view().selected));
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
  private reparent(parentId: string | null, targetIds = this.options.view().selected): boolean {
    if (parentId && !this.validDestination(parentId, targetIds)) return false;
    return this.compound({ tool: 'canvas_arrange', arguments: { action: 'reparent', targetIds, parentId } });
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
    const snapping = snapped(
      gesture.all,
      gesture.originals.map((o) => o.id),
      selectionBox(
        gesture.all,
        gesture.originals.map((o) => o.id)
      ),
      gesture.delta,
      this.options.view().viewport.zoom,
      e.ctrlKey
    );
    gesture.delta = snapping.delta;
    this.paintGuides(snapping.guides);
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
    node('selectionBounds').style.translate = `${gesture.delta.x}px ${gesture.delta.y}px`;
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
    if (gesture.destination) {
      this.compound({
        tool: 'canvas_arrange',
        arguments: {
          action: 'reparent',
          targetIds: gesture.originals.map((o) => o.id),
          parentId: gesture.destination,
          translation: gesture.delta,
        },
      });
    } else
      this.compound({
        tool: 'canvas_transform',
        arguments: {
          targetIds: gesture.originals.map((o) => o.id),
          space: 'world',
          anchor: { x: 0, y: 0 },
          translation: gesture.delta,
          scale: { width: 1, height: 1 },
          rotation: 0,
        },
      });
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
    this.options.focusMode(true);
    node('moveHint').hidden = false;
    node('board').focus({ preventScroll: true });
  }
  private async undo(direction: 'undo' | 'redo'): Promise<void> {
    if (!this.available()) return;
    if (this.queue.busy || this.actions) {
      this.say('Wait for pending edits to save before changing history.');
      return;
    }
    if (!this.history.available(direction)) {
      node('announcement').textContent = direction === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.';
      return;
    }
    const request = this.history.prepare(direction);
    if (request && !this.compound(request)) this.history.refused();
  }
  private key(e: KeyboardEvent): void {
    if (this.composing || e.isComposing || e.keyCode === 229) return;
    if (
      e.key === 'Escape' &&
      (this.selectionGesture || this.moveGesture || this.resizeGesture || this.compoundResize)
    ) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.cancelSelection();
      return;
    }
    if (!node('arrangeMenu').hidden && e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.showArrange(false);
      btn('arrangeSelection').focus();
      return;
    }
    if (
      !node('arrangeMenu').hidden &&
      e.target instanceof HTMLButtonElement &&
      e.target.closest('#arrangeMenu') &&
      ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)
    ) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const items = [...node('arrangeMenu').querySelectorAll<HTMLButtonElement>('button')].filter(
        (item) => !item.hidden && !item.disabled
      );
      const index = items.findIndex((item) => item === document.activeElement);
      const next =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? items.length - 1
            : (index + (e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
      return;
    }
    if (e.key === 'Escape' && !node('addMenu').hidden) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.showAddMenu(false);
      btn('addTool').focus();
      return;
    }
    if (!node('addMenu').hidden && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const items = [...node('addMenu').querySelectorAll('button')];
      const index = items.findIndex((item) => item === document.activeElement);
      const next =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? items.length - 1
            : (index + (e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
      return;
    }
    const target = e.target;
    if (
      !(target instanceof Element) ||
      !target.closest('#board') ||
      target.closest('input,textarea,select,button,a,[contenteditable]') ||
      this.options.mobile.matches
    )
      return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat)
        this.order(e.code === 'BracketRight' ? (e.shiftKey ? 'front' : 'forward') : e.shiftKey ? 'back' : 'backward');
      return;
    }
    if (
      this.options.view().letters &&
      e.key.toLowerCase() === 'm' &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !this.moveGesture
    ) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) this.startKeyboardMove();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && ['g', 'c', 'x', 'v', 'd'].includes(e.key.toLowerCase())) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) {
        const key = e.key.toLowerCase();
        if (key === 'g') this.group(e.shiftKey);
        else if (key === 'd') this.duplicate();
        else if (key === 'v') this.paste();
        else this.copy(key === 'x');
      }
      return;
    }
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
