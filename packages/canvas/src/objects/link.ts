/** @fileoverview Link cards: title, host and an optional stored thumbnail, or the bare address when there is no preview. */
import type { ViewObject } from '../model.js';
import type { MediaContext } from './image.js';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function linkHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** Loopback addresses name the server's own machine: only the proxy can reach them, so they open as an embed. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host);
  } catch {
    return false;
  }
}

/** A plain web address in pasted or dropped text, or null when the text is anything else. */
export function pastedUrl(value: string): string | null {
  const candidate = value.trim();
  if (!candidate || /\s/.test(candidate) || candidate.length > 8192) return null;
  try {
    const url = new URL(candidate);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** Paints the card into `body`. `note` is a quiet status line such as Paused. Every string is textContent. */
export function paintLinkCard(body: HTMLElement, o: ViewObject, ctx: MediaContext, note = ''): void {
  const url = text(o.content.url);
  const title = text(o.content.label);
  const thumb = text(o.content.thumbnailAssetId);
  const pending = o.content.preview === 'pending';
  const key = JSON.stringify([url, title, thumb, pending, note]);
  if (body.dataset.cardKey === key) return;
  body.dataset.cardKey = key;
  body.dataset.mediaKind = 'link';
  body.replaceChildren();
  const card = document.createElement('div');
  card.className = 'link-card';
  card.classList.toggle('bare', !title);
  const src = thumb ? ctx.assetUrl(thumb) : null;
  if (src) {
    const img = document.createElement('img');
    img.className = 'link-thumb';
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';
    img.onerror = () => img.remove();
    img.src = src;
    card.append(img);
  }
  const words = document.createElement('div');
  words.className = 'link-words';
  const primary = document.createElement('span');
  primary.className = title ? 'link-title' : 'link-url';
  primary.textContent = title || url;
  words.append(primary);
  const meta = document.createElement('span');
  meta.className = 'link-host';
  meta.textContent = [title ? linkHost(url) : '', pending ? 'Fetching preview' : '', note].filter(Boolean).join(' · ');
  if (meta.textContent) words.append(meta);
  card.append(words);
  body.append(card);
}
