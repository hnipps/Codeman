/**
 * @fileoverview Paint one container with the shipped Renderer. The screenshot page loads
 * this bundle and nothing from entry.ts, so it never fetches the canvas API. Images draw
 * from the stored bytes the server handed the page; links and embeds draw as inert cards,
 * and no remote page is ever loaded. A stored prototype is the one page that is framed:
 * its files come from the server's request handler, like the images.
 */
import { initialView } from './commands.js';
import type { ViewObject } from './model.js';
import { Renderer } from './render.js';

/** What an embed's card says here, where no live frame will replace it. */
export const SHOT_EMBED_NOTE = 'Live page, not drawn in screenshots';

type Framed = { frame: HTMLIFrameElement; stage: HTMLElement; loaded: Promise<true> };
let framed: Framed[] = [];

export function paint(payload: {
  objects: ViewObject[];
  transform: string;
  images: { objectId: string; src: string }[];
  /** Asset ids the server handed this page; the page fetches nothing else. */
  assets?: string[];
  /** Prototype embeds the server will answer for: a frame is mounted over each one's card. */
  prototypes?: { objectId: string; src: string }[];
}): void {
  const layer = document.getElementById('layer');
  const tree = document.getElementById('tree');
  if (!layer || !tree) return;
  const stored = new Set(payload.assets ?? []);
  const renderer = new Renderer(layer, tree, () => undefined, {
    assetUrl: (id) => (stored.has(id) ? `/asset/${encodeURIComponent(id)}` : null),
    embedNote: SHOT_EMBED_NOTE,
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
  framed = [];
  for (const prototype of payload.prototypes ?? []) {
    const stage = layer.querySelector<HTMLElement>(`[data-object-id="${CSS.escape(prototype.objectId)}"] .embed-stage`);
    if (!stage) continue;
    const frame = document.createElement('iframe');
    // No allow-modals: an alert() would hold the capture. The frame has an opaque origin either way.
    frame.setAttribute('sandbox', 'allow-scripts allow-forms');
    const loaded = new Promise<true>((resolve) => frame.addEventListener('load', () => resolve(true), { once: true }));
    frame.src = prototype.src;
    stage.append(frame);
    framed.push({ frame, stage, loaded });
  }
  document.documentElement.dataset.ready = '1';
}

/**
 * Wait for the framed prototypes to load, at most `timeoutMs`, then a short pause for their first
 * paint. A frame that has not loaded by then is removed, which leaves its card showing.
 */
export async function settle(timeoutMs: number): Promise<void> {
  if (!framed.length) return;
  const late = new Promise<false>((resolve) => setTimeout(() => resolve(false), Math.max(0, timeoutMs)));
  const outcomes = await Promise.all(framed.map((entry) => Promise.race([entry.loaded, late])));
  outcomes.forEach((ok, index) => {
    if (!ok) framed[index].frame.remove();
  });
  if (outcomes.some(Boolean)) await new Promise((resolve) => setTimeout(resolve, 300));
}
