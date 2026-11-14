/**
 * @fileoverview Widths of the canvas's two side panels, the outline (left) and the rail (right).
 *
 * The person drags a panel's inner edge, or focuses it and uses the arrow keys, to widen or narrow it. The preferred
 * width is per device (localStorage); the width drawn is that preference clamped to the panel's bounds and to the
 * viewport, so the board always keeps `MIN_BOARD` pixels between the panels. Phones draw both panels full screen and
 * show no handle.
 */

export type Panel = 'outline' | 'rail';
export type PanelWidths = Record<Panel, number>;

export const PANEL_BOUNDS: Record<Panel, { min: number; default: number; max: number }> = {
  outline: { min: 160, default: 192, max: 480 },
  rail: { min: 280, default: 320, max: 800 },
};
export const MIN_BOARD = 320;
export const PANEL_WIDTHS_KEY = 'codeman:canvas:panel-widths';
const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

export const DEFAULT_PANEL_WIDTHS: PanelWidths = {
  outline: PANEL_BOUNDS.outline.default,
  rail: PANEL_BOUNDS.rail.default,
};

/** Reads a stored preference; anything but a finite number for a panel falls back to its default. */
export function parsePanelWidths(raw: string | null): PanelWidths {
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const pick = (panel: Panel): number => {
    const value = record[panel];
    if (typeof value !== 'number' || !Number.isFinite(value)) return PANEL_BOUNDS[panel].default;
    return Math.round(Math.min(PANEL_BOUNDS[panel].max, Math.max(PANEL_BOUNDS[panel].min, value)));
  };
  return { outline: pick('outline'), rail: pick('rail') };
}

/**
 * The widths to draw. The outline is fitted first, leaving room for the rail's minimum when the rail is open; the
 * rail then takes what is left. A panel never goes below its minimum, even on a viewport too narrow for both.
 */
export function fitPanelWidths(preferred: PanelWidths, viewport: number, open: Record<Panel, boolean>): PanelWidths {
  const fit = (panel: Panel, room: number): number => {
    const bounds = PANEL_BOUNDS[panel];
    return Math.round(Math.max(bounds.min, Math.min(bounds.max, room, preferred[panel])));
  };
  const outline = fit('outline', viewport - MIN_BOARD - (open.rail ? PANEL_BOUNDS.rail.min : 0));
  const rail = fit('rail', viewport - MIN_BOARD - (open.outline ? outline : 0));
  return { outline, rail };
}

/** The preferred width after one key press on a panel's handle, or null for a key the handle does not take. */
export function keyedPanelWidth(panel: Panel, current: number, key: string, large: boolean): number | null {
  const bounds = PANEL_BOUNDS[panel];
  const step = large ? KEY_STEP_LARGE : KEY_STEP;
  // The outline grows rightwards and the rail leftwards: an arrow always moves the edge the way it points.
  const grow = panel === 'outline' ? 'ArrowRight' : 'ArrowLeft';
  const shrink = panel === 'outline' ? 'ArrowLeft' : 'ArrowRight';
  if (key === grow) return Math.min(bounds.max, current + step);
  if (key === shrink) return Math.max(bounds.min, current - step);
  if (key === 'Home') return bounds.min;
  if (key === 'End') return bounds.max;
  if (key === 'Enter') return bounds.default;
  return null;
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;

export type PanelResize = {
  /** Re-fits and redraws both widths; call after a panel opens or closes, or the viewport changes. */
  layout(): void;
  /** A panel's drawn width. */
  width(panel: Panel): number;
};

/**
 * Wires the two handles. `isOpen` and `isPhone` are read on every layout, never latched.
 */
export function installPanelResize(options: {
  root: HTMLElement;
  handles: Record<Panel, HTMLElement>;
  isOpen: (panel: Panel) => boolean;
  isPhone: () => boolean;
  storage: Store | null;
}): PanelResize {
  const { root, handles, isOpen, isPhone, storage } = options;
  let stored: string | null = null;
  try {
    stored = storage?.getItem(PANEL_WIDTHS_KEY) ?? null;
  } catch {
    stored = null;
  }
  let preferred = parsePanelWidths(stored);
  let drawn = { ...preferred };

  const save = (): void => {
    try {
      storage?.setItem(PANEL_WIDTHS_KEY, JSON.stringify(preferred));
    } catch {
      // A private window or blocked storage keeps the width for this page only.
    }
  };

  const layout = (): void => {
    const open = { outline: isOpen('outline'), rail: isOpen('rail') };
    drawn = fitPanelWidths(preferred, window.innerWidth, open);
    root.style.setProperty('--outline-width', `${drawn.outline}px`);
    root.style.setProperty('--rail-width', `${drawn.rail}px`);
    root.style.setProperty('--outline-space', open.outline && !isPhone() ? `${drawn.outline}px` : '0px');
    for (const panel of ['outline', 'rail'] as const) {
      const handle = handles[panel];
      handle.hidden = isPhone() || !open[panel];
      handle.setAttribute('aria-valuenow', String(drawn[panel]));
      handle.setAttribute('aria-valuemin', String(PANEL_BOUNDS[panel].min));
      handle.setAttribute('aria-valuemax', String(PANEL_BOUNDS[panel].max));
    }
  };

  const set = (panel: Panel, width: number): void => {
    preferred = { ...preferred, [panel]: width };
    layout();
  };

  for (const panel of ['outline', 'rail'] as const) {
    const handle = handles[panel];
    let dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dragging');
      root.classList.add('panel-resizing');
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const edge = panel === 'outline' ? e.clientX : window.innerWidth - e.clientX;
      const bounds = PANEL_BOUNDS[panel];
      set(panel, Math.round(Math.max(bounds.min, Math.min(bounds.max, edge))));
    });
    const end = (): void => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      root.classList.remove('panel-resizing');
      // Keep what was drawn, so a drag past the viewport's room does not leave a wider preference behind it.
      preferred = { ...preferred, [panel]: drawn[panel] };
      save();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('lostpointercapture', end);
    handle.addEventListener('dblclick', () => {
      set(panel, PANEL_BOUNDS[panel].default);
      save();
    });
    handle.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const next = keyedPanelWidth(panel, drawn[panel], e.key, e.shiftKey);
      if (next === null) return;
      e.preventDefault();
      e.stopPropagation();
      set(panel, next);
      save();
    });
  }
  window.addEventListener('resize', layout);
  layout();
  return { layout, width: (panel) => drawn[panel] };
}
