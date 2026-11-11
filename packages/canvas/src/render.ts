import { handles } from './resize.js';
import { editable, container, label, readable, searchText, type ViewObject } from './model.js';
import { localBounds, outline } from './tree.js';
import type { ViewState } from './commands.js';
export class Renderer {
  readonly elements = new Map<string, HTMLElement>();
  private lastSelection = '';
  private lastFocus = '';
  private rows = new Map<string, HTMLButtonElement>();
  constructor(
    private layer: HTMLElement,
    private tree: HTMLElement,
    private choose: (id: string, toggle: boolean, reveal: boolean) => void
  ) {}
  objects(objects: ViewObject[]): void {
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
    for (const { object: o, depth } of live) {
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
        for (let i = 0; i < 4; i++) {
          const corner = document.createElement('i');
          corner.className = 'corner';
          el.append(corner);
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
        row.onclick = (e) => this.choose(o.id, e.shiftKey, true);
        this.rows.set(o.id, row);
      }
      el.dataset.type = o.type;
      for (const handle of el.querySelectorAll<HTMLElement>(':scope > .resize-handle'))
        handle.hidden = !o.size || !editable(o);
      el.classList.toggle('container', container(o));
      el.setAttribute('aria-label', label(o));
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
      let bounds = el.querySelector<HTMLElement>(':scope > .group-bounds');
      if (!o.size) {
        if (!bounds) {
          bounds = document.createElement('div');
          bounds.className = 'group-bounds';
          for (let i = 0; i < 4; i++) {
            const corner = document.createElement('i');
            corner.className = 'corner';
            bounds.append(corner);
          }
          el.append(bounds);
        }
        bounds.style.cssText = `position:absolute;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;`;
      } else bounds?.remove();
      const parent = o.parentId ? this.elements.get(o.parentId) : this.layer;
      if (parent && el.parentElement !== parent) parent.append(el);
      const row = this.rows.get(o.id);
      if (row) {
        row.textContent = label(o);
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
