import { fit, type Rect, type Viewport } from './viewport.js';

declare global {
  interface Window {
    /** Test hook: headless Chromium reports no touch even with touch emulation. */
    __canvasTouch?: boolean;
  }
}

/** The narrowest width that still gets the desktop canvas. */
export const PHONE_MAX_WIDTH = 600;

/** One rule for phone mode: a narrow window, or a touch handset whose short side is narrow (landscape). */
export function isPhone(env: { touch: boolean; width: number; height: number }): boolean {
  return env.width <= PHONE_MAX_WIDTH || (env.touch && Math.min(env.width, env.height) <= PHONE_MAX_WIDTH);
}

export type PhoneQuery = {
  readonly matches: boolean;
  readonly touch: boolean;
  addEventListener(type: 'change', listener: () => void): void;
};

/** The single phone-mode decision for the canvas page; it also marks the root for CSS. */
export function phoneMode(win: Window = window): PhoneQuery {
  const listeners = new Set<() => void>();
  const coarse = win.matchMedia('(pointer: coarse)');
  const read = () => {
    const touch = win.__canvasTouch === true || coarse.matches;
    return { touch, phone: isPhone({ touch, width: win.innerWidth, height: win.innerHeight }) };
  };
  let current = read();
  const mark = () => {
    win.document.documentElement.toggleAttribute('data-phone', current.phone);
    win.document.documentElement.toggleAttribute('data-touch', current.touch);
  };
  mark();
  const update = () => {
    const next = read();
    if (next.phone === current.phone && next.touch === current.touch) return;
    current = next;
    mark();
    for (const listener of listeners) listener();
  };
  win.addEventListener('resize', update);
  coarse.addEventListener('change', update);
  return {
    get matches() {
      return current.phone;
    },
    get touch() {
      return current.touch;
    },
    addEventListener: (_type, listener) => listeners.add(listener),
  };
}

/** Height the software keyboard covers at the bottom of the layout viewport. */
export function keyboardInset(
  layoutHeight: number,
  viewport: { height: number; offsetTop: number } | null | undefined
): number {
  if (!viewport) return 0;
  return Math.max(0, Math.round(layoutHeight - viewport.height - viewport.offsetTop));
}

/** The board rectangle a reader can see: inside safe areas, above the dock and any sheet. */
export function visibleRect(
  view: { width: number; height: number },
  insets: { top: number; left: number; right: number; bottom: number },
  covers: (Rect | null)[]
): Rect {
  const top = insets.top;
  let bottom = view.height - insets.bottom;
  for (const cover of covers) if (cover && cover.height > 0 && cover.width > 0) bottom = Math.min(bottom, cover.y);
  return {
    x: insets.left,
    y: top,
    width: Math.max(1, view.width - insets.left - insets.right),
    height: Math.max(1, bottom - top),
  };
}

/** Pan needed to bring a screen rectangle wholly inside `area` with `margin`; tall targets align to the top. */
export function revealDelta(target: Rect, area: Rect, margin = 16): { x: number; y: number } {
  const axis = (start: number, size: number, areaStart: number, areaSize: number): number => {
    const min = areaStart + margin,
      max = areaStart + areaSize - margin;
    if (size > max - min) return min - start;
    if (start < min) return min - start;
    if (start + size > max) return max - (start + size);
    return 0;
  };
  return { x: axis(target.x, target.width, area.x, area.width), y: axis(target.y, target.height, area.y, area.height) };
}

/** Keeps a phone composer above the software keyboard by tracking the visual viewport. */
export function trackKeyboard(win: Window = window): void {
  const apply = () => {
    const vv = win.visualViewport;
    win.document.documentElement.style.setProperty('--keyboard-inset', `${keyboardInset(win.innerHeight, vv)}px`);
    win.document.documentElement.style.setProperty('--viewport-top', `${Math.round(vv?.offsetTop ?? 0)}px`);
  };
  win.visualViewport?.addEventListener('resize', apply);
  win.visualViewport?.addEventListener('scroll', apply);
  win.addEventListener('resize', apply);
  apply();
}

/** Zoom at which 14 px body text still reads at 12 CSS px. */
export const READABLE_ZOOM = 12 / 14;
/** A container's title sits this far above its bounds, in canvas units. */
const TITLE_SPACE = 36;

/**
 * The phone's first view: everything, if that keeps body text readable; otherwise the
 * width of the first top-level item at no less than the readable zoom, its title and
 * top-left corner in view. The rest is reached by pan, pinch, Fit and Sections.
 */
export function phoneFirstView(all: Rect, first: Rect | null, area: Rect, padding = 16): Viewport {
  const whole = fit(all, area);
  if (whole.zoom >= READABLE_ZOOM || !first) return whole;
  const zoom = Math.max(READABLE_ZOOM, Math.min(1, (area.width - padding * 2) / Math.max(1, first.width)));
  return {
    x: area.x + padding - first.x * zoom,
    y: area.y + padding + (TITLE_SPACE - first.y) * zoom,
    zoom,
  };
}
