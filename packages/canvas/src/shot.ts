/**
 * @fileoverview Paint one container with the shipped Renderer. The screenshot page loads
 * this bundle and nothing from entry.ts, so it never fetches the canvas API. Images draw
 * from the stored bytes the server handed the page; links and embeds draw as inert cards,
 * and no remote page is ever loaded.
 */
import { initialView } from './commands.js';
import type { ViewObject } from './model.js';
import { Renderer } from './render.js';

export function paint(payload: {
  objects: ViewObject[];
  transform: string;
  images: { objectId: string; src: string }[];
  /** Asset ids the server handed this page; the page fetches nothing else. */
  assets?: string[];
}): void {
  const layer = document.getElementById('layer');
  const tree = document.getElementById('tree');
  if (!layer || !tree) return;
  const stored = new Set(payload.assets ?? []);
  const renderer = new Renderer(layer, tree, () => undefined, {
    assetUrl: (id) => (stored.has(id) ? `/asset/${encodeURIComponent(id)}` : null),
  });
  renderer.objects(payload.objects);
  // A screenshot of a sub-canvas shows what is inside it, as if it were open.
  const top = payload.objects.find((o) => o.parentId === null);
  renderer.root(top?.type === 'subcanvas' ? top.id : null);
  renderer.view({ ...initialView(), outlineOpen: false, selected: [], focusId: null, rail: [] }, false);
  layer.style.transformOrigin = '0 0';
  layer.style.transform = payload.transform;
  for (const image of payload.images) {
    const body = layer.querySelector<HTMLElement>(`[data-object-id="${CSS.escape(image.objectId)}"] .object-body`);
    if (!body) continue;
    body.hidden = false;
    body.replaceChildren();
    const img = document.createElement('img');
    img.alt = '';
    img.src = image.src;
    body.append(img);
  }
  document.documentElement.dataset.ready = '1';
}
