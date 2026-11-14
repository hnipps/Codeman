/**
 * @fileoverview The outline's Prototypes section: the pages Codeman stores for this workspace, by name and
 * version. A row shows the prototype's embed on the board; its two controls open that embed's page in the
 * rail or the full view. The section is not drawn while the workspace stores none.
 *
 * Names come from whoever published the prototype: they are set with `textContent` only.
 */
import { z } from 'zod';
import type { PageSlot } from '../../../src/canvas/view-schema.js';

const ListSchema = z.object({
  success: z.literal(true),
  data: z.object({
    prototypes: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        latest: z.number(),
        objects: z.array(z.object({ objectId: z.string(), version: z.number() })),
      })
    ),
  }),
});
export type PrototypeRow = {
  id: string;
  name: string;
  /** The version its embed shows, or the newest stored one when no embed shows it. */
  version: number;
  /** The embed on the board that shows it, or null when none does. */
  objectId: string | null;
};

/** One row per stored prototype, by name. The embed is the first one this page holds. */
export function prototypeRows(data: unknown, held: (objectId: string) => boolean): PrototypeRow[] {
  const parsed = ListSchema.safeParse(data);
  if (!parsed.success) return [];
  return parsed.data.data.prototypes
    .map((p) => {
      const shown = p.objects.find((o) => held(o.objectId));
      return { id: p.id, name: p.name || p.id, version: shown?.version ?? p.latest, objectId: shown?.objectId ?? null };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

const REFRESH_MS = 400;
const ICONS: Record<PageSlot, string> = {
  rail: 'M3.5 4.5h13v11h-13zM12 4.5v11',
  full: 'M4 8V4h4M16 8V4h-4M4 12v4h4M16 12v4h-4',
};
const LABELS: Record<PageSlot, string> = { rail: 'Dock in rail', full: 'Open in full view' };

export type PrototypesHost = {
  url: (path: string) => string;
  workspace: string;
  held: (objectId: string) => boolean;
  /** Show the embed on the board: select it and bring it into view. */
  show: (objectId: string) => void;
  open: (objectId: string, slot: PageSlot, opener: HTMLElement) => void;
  /** The slots this page offers: none on a phone, no full view outside the shell. */
  slots: () => PageSlot[];
  say: (message: string) => void;
};

export class PrototypesView {
  private rows: PrototypeRow[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private asked = 0;
  private section = document.getElementById('prototypes');
  private list = document.getElementById('prototypeRows');

  constructor(private host: PrototypesHost) {}

  read(): PrototypeRow[] {
    return this.rows;
  }
  /** The canvas changed: a publish writes an operation, so the list is read again, once per burst. */
  changed(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.load(), REFRESH_MS);
  }
  async load(): Promise<void> {
    const asked = ++this.asked;
    let data: unknown;
    try {
      const response = await fetch(this.host.url(`/api/canvas/${this.host.workspace}/prototypes`));
      if (!response.ok) return;
      data = await response.json();
    } catch {
      return; // The rows already shown stay; the next change asks again.
    }
    if (asked !== this.asked) return;
    this.rows = prototypeRows(data, this.host.held);
    this.paint();
  }

  private paint(): void {
    if (!this.section || !this.list) return;
    this.section.hidden = !this.rows.length;
    const focused =
      document.activeElement instanceof HTMLElement && this.list.contains(document.activeElement)
        ? { id: document.activeElement.dataset.prototypeId, slot: document.activeElement.dataset.prototypeSlot }
        : null;
    const slots = this.host.slots();
    this.list.replaceChildren(
      ...this.rows.map((row) => {
        const item = document.createElement('li');
        item.className = 'prototype-item';
        const main = document.createElement('button');
        main.type = 'button';
        main.className = 'prototype-row';
        main.dataset.prototypeId = row.id;
        const name = document.createElement('span');
        name.className = 'prototype-name';
        name.textContent = row.name;
        const version = document.createElement('span');
        version.className = 'prototype-version';
        version.textContent = `v${row.version}`;
        main.append(name, version);
        main.title = row.objectId ? `Show ${row.name} on the board` : `${row.name} is not on the board`;
        if (!row.objectId) main.setAttribute('aria-disabled', 'true');
        main.onclick = () => {
          if (row.objectId) this.host.show(row.objectId);
          else this.host.say(`${row.name} is stored but not on the board. Publishing it again places it.`);
        };
        item.append(main);
        for (const slot of row.objectId ? slots : []) {
          const control = document.createElement('button');
          control.type = 'button';
          control.className = 'prototype-slot';
          control.dataset.prototypeId = row.id;
          control.dataset.prototypeSlot = slot;
          control.setAttribute('aria-label', `${LABELS[slot]}: ${row.name}`);
          control.title = LABELS[slot];
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('viewBox', '0 0 20 20');
          svg.setAttribute('aria-hidden', 'true');
          const path = document.createElementNS(svg.namespaceURI, 'path');
          path.setAttribute('d', ICONS[slot]);
          svg.append(path);
          control.append(svg);
          control.onclick = () => row.objectId && this.host.open(row.objectId, slot, control);
          item.append(control);
        }
        return item;
      })
    );
    // A repaint rebuilds the rows: the control that had the keyboard is found again by what it names.
    if (focused?.id)
      [...this.list.querySelectorAll<HTMLElement>('button')]
        .find((b) => b.dataset.prototypeId === focused.id && b.dataset.prototypeSlot === focused.slot)
        ?.focus({ preventScroll: true });
  }
  stop(): void {
    clearTimeout(this.timer);
  }
}
