export type Point = { x: number; y: number };
export type Rect = Point & { width: number; height: number };
export type Viewport = Point & { zoom: number };
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;
export const screenToCanvas = (v: Viewport, p: Point): Point => ({ x: (p.x - v.x) / v.zoom, y: (p.y - v.y) / v.zoom });
export const canvasToScreen = (v: Viewport, p: Point): Point => ({ x: p.x * v.zoom + v.x, y: p.y * v.zoom + v.y });
export const pan = (v: Viewport, delta: Point): Viewport => ({ ...v, x: v.x + delta.x, y: v.y + delta.y });
export function zoomAt(v: Viewport, anchor: Point, factor: number): Viewport {
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.zoom * factor));
  const p = screenToCanvas(v, anchor);
  return { x: anchor.x - p.x * zoom, y: anchor.y - p.y * zoom, zoom };
}
export function pinch(v: Viewport, before: [Point, Point], after: [Point, Point]): Viewport {
  const center = (p: [Point, Point]): Point => ({ x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 });
  const distance = (p: [Point, Point]): number => Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y);
  const a = center(before),
    b = center(after);
  return pan(zoomAt(v, a, distance(after) / Math.max(1, distance(before))), { x: b.x - a.x, y: b.y - a.y });
}
export function fit(rect: Rect, area: Rect): Viewport {
  const zoom = Math.max(
    MIN_ZOOM,
    Math.min(1, (area.width - 64) / Math.max(1, rect.width), (area.height - 96) / Math.max(1, rect.height))
  );
  return {
    x: area.x + area.width / 2 - (rect.x + rect.width / 2) * zoom,
    y: area.y + area.height / 2 - (rect.y + rect.height / 2) * zoom,
    zoom,
  };
}
export const hit = (r: Rect, p: Point): boolean =>
  p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height;
export function union(rects: Rect[]): Rect {
  if (!rects.length) return { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.min(...rects.map((r) => r.x)),
    y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    width: Math.max(...rects.map((r) => r.x + r.width)) - x,
    height: Math.max(...rects.map((r) => r.y + r.height)) - y,
  };
}
export const wheelFactor = (deltaY: number, deltaMode: number, pageHeight = 800): number =>
  Math.exp(-deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? pageHeight : 1) * 0.0015);
/** What a wheel event asks of the board: trackpad scrolls pan, mouse wheels and modified scrolls zoom. */
export type WheelInput = {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  /** Chrome and Safari's legacy `wheelDeltaY`; absent in Firefox. */
  wheelDeltaY?: number;
};
export type WheelDevice = 'trackpad' | 'mouse';
/** Events closer together than this belong to one gesture, so momentum keeps its first reading. */
export const WHEEL_GESTURE_GAP_MS = 200;
/**
 * Guesses the device behind one wheel event. Browsers do not say, so this reads the
 * traces each leaves: a mouse notch is whole lines or a legacy delta of 120; a trackpad
 * scrolls in pixels, sideways, or by fractions.
 */
export function wheelDevice(e: WheelInput): WheelDevice {
  if (e.deltaMode !== 0) return 'mouse';
  // A notch is a multiple of 120 whatever it scrolls; a Mac trackpad's legacy delta is -3x its
  // pixel delta (checked first, since a 40px swipe is also 120), other touchpads scale it otherwise.
  if (e.wheelDeltaY) {
    if (Math.abs(e.wheelDeltaY + 3 * e.deltaY) < 3) return 'trackpad';
    return e.wheelDeltaY % 120 === 0 ? 'mouse' : 'trackpad';
  }
  if (e.deltaX !== 0 || !Number.isInteger(e.deltaY)) return 'trackpad';
  return Math.abs(e.deltaY) >= 50 ? 'mouse' : 'trackpad';
}
/** Zoom for a pinch (Ctrl), Cmd + scroll or a mouse wheel; pan for a plain trackpad scroll. */
export const wheelIntent = (e: WheelInput, device: WheelDevice): 'zoom' | 'pan' =>
  e.ctrlKey || e.metaKey || device === 'mouse' ? 'zoom' : 'pan';
/** The pixel distance a wheel event scrolls, for panning. */
export const wheelPan = (e: WheelInput, pageHeight = 800): Point => {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? pageHeight : 1;
  return { x: -e.deltaX * unit, y: -e.deltaY * unit };
};
