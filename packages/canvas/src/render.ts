import { lockOwner } from './arrange.js';
import { handles } from './resize.js';
import { editable, container, label, readable, searchText, type ViewObject } from './model.js';
import { union } from './viewport.js';
import { localBounds, worldBounds, outline } from './tree.js';
import type { ViewState } from './commands.js';
export class Renderer {
  readonly elements = new Map<string, HTMLElement>();
  private objectsState: ViewObject[] = [];
  private combined = document.createElement('div');
  private lastSelection = '';
  private lastFocus = '';
  private rows = new Map<string, HTMLButtonElement>();
  constructor(
    private layer: HTMLElement,
    private tree: HTMLElement,
    private choose: (id: string, toggle: boolean, reveal: boolean) => void
  ) {
    this.combined.id = 'selectionBounds';
    this.combined.hidden = true;
    for (const handle of handles) {
      const control = document.createElement('button');
      control.className = `resize-handle handle-${handle}`;
      control.dataset.combinedResize = handle;
      control.setAttribute('aria-label', `Resize selection ${handle}`);
      control.title = 'Resize selection · Shift proportional · Alt from center';
      control.tabIndex = -1;
      this.combined.append(control);
    }
    this.layer.append(this.combined);
  }
  objects(objects: ViewObject[]): void {
    this.objectsState = objects;
    this.lastFocus = '';
    this.lastSelection = '';
    const live = outline(objects),
      ids = new Set(live.map((r) => r.object.id));
    for (const [id, el] of this.elements)
      if (!ids.has(id)) {
        el.remove();
        this.elements.delete(id);
        this.rows.get(id)?.remove();
        this.rows.delete(id);
      }
    for (const [stack, { object: o, depth }] of live.entries()) {
      let el = this.elements.get(o.id);
      if (!el) {
        el = document.createElement('article');
        el.className = 'object';
        el.tabIndex = -1;
        el.dataset.objectId = o.id;
        const body = document.createElement('div');
        body.className = 'object-body';
        el.append(body);
        const title = document.createElement('button');
        title.className = 'object-title';
        title.tabIndex = -1;
        el.append(title);
        const selection = document.createElement('div');
        selection.className = 'selection-bounds';
        el.append(selection);
        for (let i = 0; i < 4; i++) {
          const corner = document.createElement('i');
          corner.className = 'corner';
          selection.append(corner);
        }
        for (const handle of handles) {
          const control = document.createElement('button');
          control.className = `resize-handle handle-${handle}`;
          control.dataset.resize = handle;
          control.setAttribute('aria-label', `Resize ${handle}`);
          control.title = 'Resize · Shift proportional · Alt from center';
          control.tabIndex = -1;
          el.append(control);
        }
        this.elements.set(o.id, el);
        const row = document.createElement('button');
        row.className = 'tree-row';
        row.dataset.rowId = o.id;
        row.onclick = (e) => this.choose(o.id, e.shiftKey, true);
        this.rows.set(o.id, row);
      }
      el.dataset.type = o.type;
      el.style.zIndex = String(stack);
      const locked = lockOwner(objects, o);
      const boundary = el.querySelector('.selection-bounds');
      boundary?.querySelector('.lock-mark')?.remove();
      if (locked && boundary) boundary.append(lockMark());
      el.classList.toggle('locked', !!locked);
      for (const handle of el.querySelectorAll<HTMLElement>(':scope > .resize-handle'))
        handle.hidden = !o.size || !editable(o);
      el.classList.toggle('container', container(o));
      el.setAttribute('aria-label', `${label(o)}${locked ? ' · Locked' : ''}`);
      el.style.left = `${o.position.x}px`;
      el.style.top = `${o.position.y}px`;
      el.style.transform = `rotate(${o.rotation}deg)`;
      const r = localBounds(objects, { ...o, position: { x: 0, y: 0 }, rotation: 0 });
      el.style.width = `${Math.max(1, r.width)}px`;
      el.style.height = `${Math.max(1, r.height)}px`;
      // A group's origin is independent of the minimum child coordinate.
      if (!o.size) {
        el.style.width = '0px';
        el.style.height = '0px';
        el.style.border = 'none';
      }
      const body = el.querySelector<HTMLElement>('.object-body'),
        title = el.querySelector<HTMLElement>('.object-title');
      if (body) {
        body.hidden = container(o) && o.content.type === o.type;
        if (body.textContent !== readable(o)) body.textContent = readable(o);
      }
      if (title) {
        title.hidden = !container(o);
        title.textContent = label(o);
        title.dataset.containerId = o.id;
        title.style.left = `${o.size ? 0 : r.x}px`;
        title.style.top = `${(o.size ? 0 : r.y) - 36}px`;
        title.style.maxWidth = `${Math.max(160, r.width)}px`;
      }
      const bounds = el.querySelector<HTMLElement>(':scope > .selection-bounds');
      if (bounds) {
        bounds.style.left = `calc(${o.size ? 0 : r.x}px - 6px / var(--zoom))`;
        bounds.style.top = `calc(${o.size ? 0 : r.y}px - 6px / var(--zoom))`;
        bounds.style.width = `calc(${o.size ? '100%' : `${r.width}px`} * var(--zoom) + 12px)`;
        bounds.style.height = `calc(${o.size ? '100%' : `${r.height}px`} * var(--zoom) + 12px)`;
      }
      let hitBounds = el.querySelector<HTMLElement>(':scope > .group-bounds');
      if (!o.size) {
        if (!hitBounds) {
          hitBounds = document.createElement('div');
          hitBounds.className = 'group-bounds';
          el.append(hitBounds);
        }
        hitBounds.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;`;
      } else hitBounds?.remove();
      const parent = o.parentId ? this.elements.get(o.parentId) : this.layer;
      if (parent && el.parentElement !== parent) parent.append(el);
      const row = this.rows.get(o.id);
      if (row) {
        row.textContent = label(o);
        if (locked) row.append(lockMark());
        row.classList.toggle('locked', !!locked);
        row.setAttribute('aria-label', `${label(o)}${locked ? ` · Locked by ${label(locked)}` : ''}`);
        if (container(o)) row.dataset.containerId = o.id;
        else delete row.dataset.containerId;
        row.dataset.searchText = searchText(o).toLowerCase();
        row.title = label(o);
        row.classList.toggle('root', depth === 0);
        row.style.paddingLeft = `${8 + depth * 12}px`;
        this.tree.append(row);
      }
    }
  }
  view(state: ViewState, keyboard: boolean): void {
    const v = state.viewport;
    this.layer.style.setProperty('--zoom', String(v.zoom));
    this.layer.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.zoom})`;
    const selected = JSON.stringify(state.selected),
      focus = `${keyboard}:${state.focusId}`;
    if (this.lastSelection === selected && this.lastFocus === focus) return;
    this.lastSelection = selected;
    this.lastFocus = focus;
    this.layer.classList.toggle('multi-selection', state.selected.length > 1);
    this.combined.hidden =
      state.selected.length < 2 && !this.objectsState.some((o) => state.selected.includes(o.id) && o.type === 'group');
    if (!this.combined.hidden) {
      const bounds = union(
        this.objectsState.filter((o) => state.selected.includes(o.id)).map((o) => worldBounds(this.objectsState, o))
      );
      this.combined.style.left = `calc(${bounds.x}px - 6px / var(--zoom))`;
      this.combined.style.top = `calc(${bounds.y}px - 6px / var(--zoom))`;
      this.combined.style.width = `calc(${bounds.width}px * var(--zoom) + 12px)`;
      this.combined.style.height = `calc(${bounds.height}px * var(--zoom) + 12px)`;
    }
    for (const [id, el] of this.elements) {
      el.classList.toggle('selected', state.selected.includes(id));
      el.classList.toggle('keyboard-focus', keyboard && state.focusId === id);
      this.rows.get(id)?.classList.toggle('keyboard-focus', keyboard && state.focusId === id);
      this.rows.get(id)?.setAttribute('aria-pressed', String(state.selected.includes(id)));
    }
  }
  filter(query: string): void {
    for (const row of this.rows.values()) row.hidden = !row.dataset.searchText?.includes(query.toLowerCase());
  }
}

function lockMark(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('lock-mark');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', 'M6.5 9V6.5a3.5 3.5 0 0 1 7 0V9M4.5 9h11v8h-11z');
  svg.append(path);
  return svg;
}
