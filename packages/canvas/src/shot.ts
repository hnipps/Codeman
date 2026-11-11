/**
 * @fileoverview Paint one container with the shipped Renderer. The screenshot page loads
 * this bundle and nothing from entry.ts, so it never fetches the canvas API.
 */
import { initialView } from './commands.js';
import type { ViewObject } from './model.js';
import { Renderer } from './render.js';

export function paint(payload: {
  objects: ViewObject[];
  transform: string;
  images: { objectId: string; src: string }[];
}): void {
  const layer = document.getElementById('layer');
  const tree = document.getElementById('tree');
  if (!layer || !tree) return;
  const renderer = new Renderer(layer, tree, () => undefined);
  renderer.objects(payload.objects);
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
