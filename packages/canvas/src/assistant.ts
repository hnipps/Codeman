import { chips, type Chip } from './context.js';
import type { ViewState } from './commands.js';
import type { ViewObject } from './model.js';
import { canvasStorageKeys, type CanvasStorageKeys } from './storage-keys.js';

type Options = {
  workspace: string;
  viewer: string;
  objects: () => ViewObject[];
  view: () => ViewState;
  remove: (id: string) => void;
  choose: (id: string) => void;
};
const node = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing canvas element: ${id}`);
  return el;
};
const MAX_DRAFT_BYTES = 64 * 1024;
export const draftBytes = (text: string): number => new TextEncoder().encode(text).byteLength;
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null || value === '') localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* Storage that cannot be written keeps nothing; the rail still works for this load. */
  }
}
/** Context ids stored by this viewer for this workspace; anything that is not a list of strings reads as none. */
export function parseStoredContext(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string').slice(0, 200) : [];
  } catch {
    return [];
  }
}
/**
 * The assistant rail's shell: the pending-context chips and a durable draft. There is no conversation
 * yet, so Send says so and keeps everything. Chip and draft text always reach the DOM as text.
 */
export class AssistantView {
  private keys: CanvasStorageKeys;
  private signature = '';
  private storedContext = '';
  private refocus: number | null = null;
  private restored: string[];
  readonly draft = node('assistantDraft') as HTMLTextAreaElement;
  constructor(private options: Options) {
    this.keys = canvasStorageKeys(options.viewer, options.workspace);
    this.draft.value = read(this.keys.assistantDraft) ?? '';
    // Read once, before the first paint can overwrite the stored list with the empty starting state.
    this.restored = parseStoredContext(read(this.keys.assistantContext));
    this.draft.addEventListener('input', () => {
      write(this.keys.assistantDraft, this.draft.value);
      node('assistantStatus').textContent = '';
    });
    node('assistantForm').addEventListener('submit', (e) => {
      e.preventDefault();
      node('assistantStatus').textContent = 'Conversations arrive next. Your draft and context are kept.';
    });
  }
  restoredContext(): string[] {
    return this.restored;
  }
  draftBytes(): number {
    return Math.min(draftBytes(this.draft.value), MAX_DRAFT_BYTES * 4);
  }
  focusComposer(): void {
    this.draft.focus({ preventScroll: true });
  }
  paint(): void {
    const ids = this.options.view().context;
    const stored = JSON.stringify(ids);
    if (stored !== this.storedContext) {
      this.storedContext = stored;
      write(this.keys.assistantContext, ids.length ? stored : null);
    }
    const rows = chips(this.options.objects(), ids);
    const signature = JSON.stringify(rows);
    if (signature !== this.signature) {
      this.signature = signature;
      this.paintChips(rows);
    }
    node('contextEmpty').hidden = rows.length > 0;
    node('contextHeading').textContent = rows.length ? `Context · ${rows.length}` : 'Context';
    if (this.refocus !== null) {
      const removers = [...node('contextChips').querySelectorAll<HTMLElement>('.chip-remove')];
      (removers[Math.min(this.refocus, removers.length - 1)] ?? this.draft).focus({ preventScroll: true });
      this.refocus = null;
    }
  }
  private paintChips(rows: Chip[]): void {
    const list = node('contextChips');
    list.replaceChildren();
    rows.forEach((chip, index) => {
      const item = document.createElement('li');
      item.className = 'chip';
      item.dataset.contextId = chip.id;
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'chip-label';
      open.title = `Show ${chip.label} on the canvas`;
      const name = document.createElement('span');
      name.className = 'chip-name';
      name.textContent = chip.label;
      open.append(name);
      if (chip.descendants) {
        const inside = document.createElement('span');
        inside.className = 'chip-count';
        inside.textContent = `${chip.descendants} inside`;
        open.append(inside);
      }
      open.addEventListener('click', () => this.options.choose(chip.id));
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'chip-remove';
      close.setAttribute('aria-label', `Remove ${chip.label} from context`);
      close.title = 'Remove from context';
      close.textContent = '×';
      close.addEventListener('click', () => {
        this.refocus = index;
        this.options.remove(chip.id);
      });
      item.append(open, close);
      list.append(item);
    });
  }
}
