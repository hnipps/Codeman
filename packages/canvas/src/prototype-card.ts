/**
 * @fileoverview A stored prototype's card on a phone, where no live frame runs: a picture of the version its embed
 * shows, and who published that version and when. The picture is drawn by the server from the stored version
 * (`GET .../prototypes/:id/versions/:version/picture`) and held here as an object URL, so a phone that goes
 * offline keeps showing the last one it had.
 *
 * States: the picture is on its way (one line under the title); the version is no longer stored (one line and
 * Reload); offline (the last picture and when it was taken); the picture could not be drawn (one line and Reload).
 * Every word is `textContent`. One picture is asked for at a time, since the server draws them one at a time.
 */
import { parsePrototypeAddress } from '../../../src/canvas/prototype-address.js';
import type { ViewObject } from './model.js';
import { relativeTime } from './comments.js';
import type { PrototypeVersions } from './prototype-versions.js';

type Picture =
  | { state: 'loading' }
  | { state: 'ready'; src: string; at: number }
  | { state: 'gone' }
  | { state: 'failed' };

export type CardHost = {
  url: (path: string) => string;
  workspace: string;
  /** Cards are drawn only on a phone; elsewhere a live frame or the link card takes the stage. */
  phone: () => boolean;
  online: () => boolean;
  versions: PrototypeVersions;
};

const theme = (): 'dark' | 'light' => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
const clock = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

/** The line under a card's picture, from what is known of the picture and the version. */
export function cardLine(input: {
  picture: Picture['state'];
  online: boolean;
  version: number;
  published: { createdAt: number; author: string } | null;
  pictureAt: number | null;
  now: number;
}): string {
  if (input.picture === 'gone') return `v${input.version} is no longer stored`;
  if (!input.online)
    return input.pictureAt !== null ? `Offline · picture from ${clock(input.pictureAt)}` : 'Offline · no picture yet';
  if (input.picture === 'failed') return 'The picture could not be drawn';
  const published = input.published
    ? `Published ${relativeTime(input.published.createdAt, input.now)} by ${input.published.author}`
    : '';
  if (input.picture === 'loading') return published ? `${published} · drawing a picture` : 'Drawing a picture';
  return published;
}

export class PrototypeCards {
  private pictures = new Map<string, Picture>();
  /** The newest picture held per prototype, whatever its version: what an offline card shows. */
  private latest = new Map<string, { src: string; at: number }>();
  private queue: string[] = [];
  private busy = false;
  private cards = new Map<string, { card: HTMLElement; object: ViewObject }>();

  constructor(private host: CardHost) {}

  /** Paints the card for a prototype embed on a phone. False leaves the stage to the ordinary card. */
  paint = (card: HTMLElement, o: ViewObject): boolean => {
    const address = typeof o.content.url === 'string' ? parsePrototypeAddress(o.content.url) : null;
    if (!this.host.phone() || !address) {
      if (this.cards.get(o.id)?.card === card) this.cards.delete(o.id);
      return false;
    }
    this.cards.set(o.id, { card, object: o });
    const key = `${address.id}/${address.version}/${theme()}`;
    let picture = this.pictures.get(key);
    if (!picture) {
      picture = { state: 'loading' };
      this.pictures.set(key, picture);
      if (this.host.online()) this.ask(key);
    } else if (picture.state === 'loading' && this.host.online() && !this.queue.includes(key)) this.ask(key);
    const shown = picture.state === 'ready' ? picture : this.host.online() ? null : this.latest.get(address.id);
    const line = cardLine({
      picture: picture.state,
      online: this.host.online(),
      version: address.version,
      published: this.host.versions.get(address.id, address.version),
      pictureAt: shown ? shown.at : null,
      now: Date.now(),
    });
    const retry = picture.state === 'gone' || picture.state === 'failed';
    const signature = JSON.stringify([key, shown?.src ?? '', line, retry]);
    if (card.dataset.cardKey === signature) return true;
    card.dataset.cardKey = signature;
    card.dataset.mediaKind = 'prototype';
    card.replaceChildren();
    const box = document.createElement('div');
    box.className = 'proto-card';
    box.classList.toggle('offline', !this.host.online());
    if (shown) {
      const img = document.createElement('img');
      img.className = 'proto-pic';
      img.alt = `Version ${address.version} of this prototype`;
      img.draggable = false;
      img.src = shown.src;
      box.append(img);
    } else {
      const blank = document.createElement('div');
      blank.className = 'proto-pic blank';
      box.append(blank);
    }
    const foot = document.createElement('div');
    foot.className = 'proto-foot';
    const words = document.createElement('span');
    words.textContent = line;
    words.dataset.i18nSkip = '';
    foot.append(words);
    if (retry) {
      const reload = document.createElement('button');
      reload.type = 'button';
      reload.className = 'quiet';
      reload.textContent = 'Reload';
      // The media editor stops a press on a media action reaching the board, so a tap here never selects.
      reload.dataset.mediaAction = 'card-reload';
      reload.dataset.objectRef = o.id;
      reload.addEventListener('click', () => this.reload(key));
      foot.append(reload);
    }
    box.append(foot);
    card.append(box);
    return true;
  };

  /** Repaints every card on the page: a picture arrived, the list of versions was read, or the network changed. */
  repaint(): void {
    for (const [id, { card, object }] of this.cards) {
      if (!card.isConnected) {
        this.cards.delete(id);
        continue;
      }
      this.paint(card, object);
    }
  }

  private reload(key: string): void {
    this.pictures.set(key, { state: 'loading' });
    this.ask(key);
    this.repaint();
  }

  private ask(key: string): void {
    if (!this.queue.includes(key)) this.queue.push(key);
    void this.next();
  }
  private async next(): Promise<void> {
    if (this.busy) return;
    const key = this.queue.shift();
    if (!key) return;
    this.busy = true;
    const [id, version, shade] = key.split('/');
    let picture: Picture = { state: 'loading' };
    try {
      const response = await fetch(
        this.host.url(
          `/api/canvas/${this.host.workspace}/prototypes/${encodeURIComponent(id)}/versions/${version}/picture?theme=${shade}`
        )
      );
      if (response.ok) {
        const src = URL.createObjectURL(await response.blob());
        const at = Date.now();
        picture = { state: 'ready', src, at };
        this.latest.set(id, { src, at });
      } else picture = response.status === 404 ? { state: 'gone' } : { state: 'failed' };
    } catch {
      // Offline: the card waits and asks again when it is painted online. Online, the request failed: Reload asks.
      picture = this.host.online() ? { state: 'failed' } : { state: 'loading' };
    }
    this.pictures.set(key, picture);
    this.busy = false;
    this.repaint();
    void this.next();
  }
}
