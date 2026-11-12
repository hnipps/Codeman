/** @fileoverview Sub-canvas containers: a titled box with an Open affordance; opening sets the view root. */
import type { ViewObject } from '../model.js';

export function paintSubcanvas(body: HTMLElement, o: ViewObject, count: number): void {
  const key = String(count);
  if (body.dataset.subKey === key && body.dataset.mediaKind === 'subcanvas') return;
  body.dataset.subKey = key;
  body.dataset.mediaKind = 'subcanvas';
  body.replaceChildren();
  const open = document.createElement('button');
  open.className = 'subcanvas-open';
  open.dataset.mediaAction = 'open-subcanvas';
  open.dataset.objectRef = o.id;
  open.tabIndex = -1;
  open.textContent = 'Open';
  open.title = 'Open sub-canvas · double-click or Alt+↓';
  const summary = document.createElement('span');
  summary.className = 'subcanvas-count';
  summary.textContent = count ? `${count} ${count === 1 ? 'item' : 'items'}` : 'Empty';
  body.append(summary, open);
}
