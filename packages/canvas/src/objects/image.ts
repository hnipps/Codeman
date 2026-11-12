/** @fileoverview Image objects: stored bytes at their aspect ratio, with designed loading and failure states. */
import type { ViewObject } from '../model.js';

export type MediaContext = { assetUrl: (assetId: string) => string | null };
/** Decoded pixels above this are not drawn; the object keeps its place with a note. */
export const MAX_IMAGE_PIXELS = 64_000_000;
const notes = {
  loading: 'Loading image',
  failed: 'Image unavailable',
  large: 'Image too large to show',
} as const;
export type ImageState = keyof typeof notes | 'ready';

/** Where an image object's bytes come from: its stored asset, or a small data URL written by an earlier release. */
export function imageSource(o: ViewObject, ctx: MediaContext): string | null {
  const assetId = typeof o.content.assetId === 'string' ? o.content.assetId : '';
  if (assetId) return ctx.assetUrl(assetId);
  const url = typeof o.content.url === 'string' ? o.content.url : '';
  return /^data:image\/(png|jpeg|gif|webp);base64,/i.test(url) ? url : null;
}

/** The size a new image object takes: its own aspect ratio, the long side at most `longest` canvas units. */
export function imageCreateSize(width: number, height: number, longest = 480): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: longest, height: Math.round(longest * 0.75) };
  const scale = Math.min(1, longest / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function setState(body: HTMLElement, state: ImageState): void {
  body.dataset.mediaState = state;
  let note = body.querySelector<HTMLElement>(':scope > .media-note');
  if (state === 'ready') {
    note?.remove();
    return;
  }
  if (!note) {
    note = document.createElement('span');
    note.className = 'media-note';
    body.append(note);
  }
  note.textContent = notes[state];
}

export function paintImage(body: HTMLElement, o: ViewObject, ctx: MediaContext): void {
  const src = imageSource(o, ctx) ?? '';
  const alt = typeof o.content.alt === 'string' ? o.content.alt : '';
  if (body.dataset.mediaSrc === src && body.dataset.mediaKind === 'image') {
    const img = body.querySelector('img');
    if (img && img.alt !== alt) img.alt = alt;
    return;
  }
  body.dataset.mediaKind = 'image';
  body.dataset.mediaSrc = src;
  body.replaceChildren();
  if (!src) {
    setState(body, 'failed');
    return;
  }
  const img = document.createElement('img');
  img.className = 'media-image';
  img.alt = alt;
  img.draggable = false;
  img.decoding = 'async';
  img.onload = () => {
    if (body.dataset.mediaSrc !== src) return;
    const large = img.naturalWidth * img.naturalHeight > MAX_IMAGE_PIXELS;
    if (large) img.remove();
    setState(body, large ? 'large' : 'ready');
  };
  img.onerror = () => {
    if (body.dataset.mediaSrc !== src) return;
    img.remove();
    setState(body, 'failed');
  };
  setState(body, 'loading');
  body.prepend(img);
  img.src = src;
}
