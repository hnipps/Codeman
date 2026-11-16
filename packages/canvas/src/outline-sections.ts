/**
 * @fileoverview The outline's sections (Sessions, Work, Prototypes, Objects): each collapses to its header, and the
 * boundary under an expanded section drags (or takes Up/Down on the focused handle) to set that section's height.
 *
 * Preferences are per device (localStorage, `OUTLINE_SECTIONS_KEY`): which sections are collapsed and the heights the
 * person set. A section with no stored height keeps its CSS size. The last expanded section takes the room left, every
 * expanded section keeps `MIN_SECTION`, and a stored height is clamped to the room on every layout, so a smaller
 * window never pushes a later section out of view. Phones collapse but draw no handles and no stored heights.
 */
import { OUTLINE_SECTIONS_KEY } from './storage-keys.js';

/** Each section, top to bottom, with the element its header's toggle shows and hides. */
export const OUTLINE_SECTIONS = [
  { id: 'sessions', controls: 'sessionRows' },
  { id: 'work', controls: 'workCounts' },
  { id: 'prototypes', controls: 'prototypeRows' },
  { id: 'objects', controls: 'tree' },
] as const;
export type SectionId = (typeof OUTLINE_SECTIONS)[number]['id'];
export type OutlineSectionsPref = { collapsed: SectionId[]; heights: Partial<Record<SectionId, number>> };

export const MIN_SECTION = 64;
const MAX_SECTION = 4000;
const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

const isSectionId = (value: unknown): value is SectionId => OUTLINE_SECTIONS.some((s) => s.id === value);

/** Reads a stored preference; unknown sections and anything but a finite height are dropped. */
export function parseOutlineSections(raw: string | null): OutlineSectionsPref {
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const collapsed = Array.isArray(record.collapsed) ? [...new Set(record.collapsed.filter(isSectionId))] : [];
  const heights: Partial<Record<SectionId, number>> = {};
  const stored =
    record.heights && typeof record.heights === 'object' ? (record.heights as Record<string, unknown>) : {};
  for (const [id, value] of Object.entries(stored)) {
    if (!isSectionId(id) || typeof value !== 'number' || !Number.isFinite(value)) continue;
    heights[id] = Math.round(Math.min(MAX_SECTION, Math.max(MIN_SECTION, value)));
  }
  return { collapsed, heights };
}

/**
 * The heights to draw for the expanded sections above the last one, top to bottom. `preferred` null keeps the
 * section's CSS size, which takes `natural` pixels. Each section is clamped so every expanded section below it,
 * the last one included, still gets `MIN_SECTION` of `available`. Null in, null out.
 */
export function fitSectionHeights(
  upper: { preferred: number | null; natural: number }[],
  available: number
): (number | null)[] {
  let used = 0;
  return upper.map(({ preferred, natural }, i) => {
    if (preferred === null) {
      used += natural;
      return null;
    }
    const room = available - used - MIN_SECTION * (upper.length - i);
    const height = Math.round(Math.max(MIN_SECTION, Math.min(preferred, room)));
    used += height;
    return height;
  });
}

/** The height after one key press on a section's handle, or null for a key the handle does not take. */
export function keyedSectionHeight(current: number, key: string, large: boolean): number | null {
  const step = large ? KEY_STEP_LARGE : KEY_STEP;
  if (key === 'ArrowDown') return Math.min(MAX_SECTION, current + step);
  if (key === 'ArrowUp') return Math.max(MIN_SECTION, current - step);
  if (key === 'Home') return MIN_SECTION;
  return null;
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Adds a toggle to each section's header and a handle under each section, then keeps the layout fitted. Call it
 * once every section is in the outline. `isPhone` is read on every layout, never latched.
 */
export function installOutlineSections(options: {
  outline: HTMLElement;
  isPhone: () => boolean;
  storage: Store | null;
}): { layout(): void } {
  const { outline, isPhone, storage } = options;
  let stored: string | null = null;
  try {
    stored = storage?.getItem(OUTLINE_SECTIONS_KEY) ?? null;
  } catch {
    stored = null;
  }
  let pref = parseOutlineSections(stored);
  const save = (): void => {
    try {
      storage?.setItem(OUTLINE_SECTIONS_KEY, JSON.stringify(pref));
    } catch {
      // A private window or blocked storage keeps the layout for this page only.
    }
  };

  type Part = { id: SectionId; section: HTMLElement; toggle: HTMLButtonElement; handle: HTMLElement };
  const parts: Part[] = [];
  for (const { id, controls } of OUTLINE_SECTIONS) {
    const section = document.getElementById(id);
    const title = section?.querySelector<HTMLElement>(':scope > .section-head h2');
    if (!section || !title) continue;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'section-toggle';
    toggle.setAttribute('aria-controls', controls);
    toggle.append(...title.childNodes);
    title.append(toggle);
    const handle = document.createElement('div');
    handle.className = 'section-resize';
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'horizontal');
    handle.setAttribute('aria-controls', id);
    handle.setAttribute('aria-label', `${toggle.textContent ?? id} height`);
    handle.setAttribute('aria-valuemin', String(MIN_SECTION));
    handle.title = 'Drag to resize · arrows · Enter resets · double-click resets';
    handle.tabIndex = 0;
    handle.hidden = true;
    section.after(handle);
    parts.push({ id, section, toggle, handle });
  }

  const drawn = new Map<SectionId, number>();
  const shown = (el: HTMLElement): boolean => !el.hidden && el.getClientRects().length > 0;

  const layout = (): void => {
    const collapsed = new Set(pref.collapsed);
    for (const { id, section, toggle } of parts) {
      const open = !collapsed.has(id);
      section.toggleAttribute('data-collapsed', !open);
      toggle.setAttribute('aria-expanded', String(open));
      section.style.removeProperty('flex');
      section.style.removeProperty('height');
      section.style.removeProperty('max-height');
    }
    const expanded = isPhone() || !shown(outline) ? [] : parts.filter((p) => !collapsed.has(p.id) && shown(p.section));
    const upper = expanded.slice(0, -1);
    // Set once, never hidden and shown again: hiding the focused handle would drop its keyboard focus.
    for (const p of parts) p.handle.hidden = !upper.includes(p);
    const last = expanded.at(-1);
    if (!last) return;
    last.section.style.flex = '1 1 0';
    last.section.style.maxHeight = 'none';
    // Sections are sized here; handles overlap their neighbours and take no room.
    const sized = new Set<Element>([...expanded.map((p) => p.section), ...parts.map((p) => p.handle)]);
    let chrome = 0;
    for (const child of outline.children) {
      if (!(child instanceof HTMLElement) || sized.has(child) || !shown(child)) continue;
      if (getComputedStyle(child).position !== 'absolute') chrome += child.getBoundingClientRect().height;
    }
    const heights = fitSectionHeights(
      upper.map((p) => ({ preferred: pref.heights[p.id] ?? null, natural: p.section.getBoundingClientRect().height })),
      Math.floor(outline.clientHeight - chrome)
    );
    upper.forEach((p, i) => {
      const height = heights[i];
      if (height !== null) {
        p.section.style.flex = '0 0 auto';
        p.section.style.height = `${height}px`;
        p.section.style.maxHeight = 'none';
      }
      drawn.set(p.id, height ?? p.section.offsetHeight);
      p.handle.setAttribute('aria-valuenow', String(drawn.get(p.id)));
    });
  };

  const setHeight = (id: SectionId, height: number | null): void => {
    const heights = { ...pref.heights };
    if (height === null) delete heights[id];
    else heights[id] = height;
    pref = { ...pref, heights };
    layout();
  };

  for (const { id, section, toggle, handle } of parts) {
    toggle.addEventListener('click', () => {
      const collapsed = pref.collapsed.includes(id);
      pref = { ...pref, collapsed: collapsed ? pref.collapsed.filter((c) => c !== id) : [...pref.collapsed, id] };
      save();
      layout();
    });
    let dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dragging');
      document.documentElement.classList.add('section-resizing');
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const top = section.getBoundingClientRect().top;
      setHeight(id, Math.round(Math.min(MAX_SECTION, Math.max(MIN_SECTION, e.clientY - top))));
    });
    const end = (): void => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      document.documentElement.classList.remove('section-resizing');
      // Keep what was drawn, so a drag past the room does not leave a taller preference behind it.
      const height = drawn.get(id);
      if (height !== undefined) pref = { ...pref, heights: { ...pref.heights, [id]: height } };
      save();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('lostpointercapture', end);
    const reset = (): void => {
      setHeight(id, null);
      save();
    };
    handle.addEventListener('dblclick', reset);
    handle.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const next = e.key === 'Enter' ? null : keyedSectionHeight(drawn.get(id) ?? MIN_SECTION, e.key, e.shiftKey);
      if (next === null && e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      if (next === null) {
        reset();
        return;
      }
      setHeight(id, next);
      save();
    });
  }

  // A section appears or goes (Prototypes with its first page, Sessions with the shell), the outline opens or the
  // window changes size: each re-fits. Layout only writes styles and data-collapsed, so neither observer loops.
  const sections = new MutationObserver(layout);
  for (const { section } of parts) sections.observe(section, { attributes: true, attributeFilter: ['hidden'] });
  sections.observe(outline, { attributes: true, attributeFilter: ['hidden'] });
  sections.observe(document.documentElement, { attributes: true, attributeFilter: ['data-shell', 'data-phone'] });
  new ResizeObserver(layout).observe(outline);
  layout();
  return { layout };
}
