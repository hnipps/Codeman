/**
 * @fileoverview Embed objects: a slim header (title, host, Reload, Open, Back to link) over a
 * stage. The stage shows the link card with "Paused" until the editor puts a live frame in it;
 * the screenshot renderer never does, so it never loads a remote page.
 */
import type { ViewObject } from '../model.js';
import type { MediaContext } from './image.js';
import { linkHost, paintLinkCard } from './link.js';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function action(name: string, label: string, title: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'embed-action';
  button.dataset.mediaAction = name;
  button.tabIndex = -1;
  button.textContent = label;
  button.title = title;
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
      action('reload', 'Reload', 'Reload the page'),
      action('open', 'Open', 'Open in a new tab'),
      action('to-link', 'Back to link', 'Show as a link card')
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
