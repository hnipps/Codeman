/**
 * @fileoverview Embed objects: a slim header (title, host, Reload, Open, Back to link) over a
 * stage. The stage shows the link card with "Paused" until the editor puts a live frame in it;
 * the screenshot renderer never does, so it never loads a remote page.
 */
import type { ViewObject } from '../model.js';
import type { MediaContext } from './image.js';
import { linkHost, paintLinkCard } from './link.js';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** 20-unit icon paths, drawn with the dock's stroke (`svg` in canvas.css). */
const ICONS = {
  reload: 'M15.5 7.5A6 6 0 1 0 16 11M16 3.5v4h-4',
  open: 'M11 4h5v5M16 4l-7 7M14 12.5V16H4V6h3.5',
  'to-link': 'M8.5 11.5l3-3M7.5 9l-2 2a2.5 2.5 0 0 0 3.5 3.5l2-2M12.5 11l2-2A2.5 2.5 0 0 0 11 5.5l-2 2',
} as const;

/** An icon button: named by aria-label and title, shown on hover, selection or keyboard focus. */
function action(name: keyof typeof ICONS, label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'embed-action';
  button.type = 'button';
  button.dataset.mediaAction = name;
  button.setAttribute('aria-label', label);
  button.title = label;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  button.append(svg);
  return button;
}

/** The stage a live frame goes in, or null when this body is not an embed. */
export const embedStage = (body: HTMLElement): HTMLElement | null => body.querySelector(':scope > .embed-stage');

export function paintEmbed(body: HTMLElement, o: ViewObject, ctx: MediaContext): void {
  const url = text(o.content.url);
  const title = text(o.content.label) || linkHost(url) || url;
  if (body.dataset.mediaKind !== 'embed') {
    body.replaceChildren();
    body.dataset.mediaKind = 'embed';
    delete body.dataset.cardKey;
    const head = document.createElement('div');
    head.className = 'embed-head';
    const name = document.createElement('span');
    name.className = 'embed-title';
    const host = document.createElement('span');
    host.className = 'link-host';
    const actions = document.createElement('span');
    actions.className = 'embed-actions';
    actions.append(
      action('reload', 'Reload page'),
      action('open', 'Open in new tab'),
      action('to-link', 'Back to link')
    );
    head.append(name, host, actions);
    const stage = document.createElement('div');
    stage.className = 'embed-stage';
    body.append(head, stage);
  }
  const name = body.querySelector<HTMLElement>('.embed-title');
  const host = body.querySelector<HTMLElement>('.embed-head > .link-host');
  if (name && name.textContent !== title) name.textContent = title;
  if (host && host.textContent !== linkHost(url)) host.textContent = linkHost(url);
  for (const button of body.querySelectorAll<HTMLElement>('[data-media-action]')) button.dataset.objectRef = o.id;
  const stage = embedStage(body);
  if (stage && !stage.querySelector(':scope > iframe')) {
    const card = stage.querySelector<HTMLElement>(':scope > .embed-card') ?? document.createElement('div');
    card.className = 'embed-card';
    if (!card.parentElement) stage.append(card);
    paintLinkCard(
      card,
      { ...o, content: { ...o.content, type: 'link', preview: 'ready' } },
      ctx,
      stage.dataset.note ?? 'Paused'
    );
  }
}
