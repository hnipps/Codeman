import { describe, expect, it } from 'vitest';
import { phoneFirstView, READABLE_ZOOM } from '../packages/canvas/src/mobile.js';
import { fit } from '../packages/canvas/src/viewport.js';

const area = { x: 0, y: 47, width: 390, height: 700 };

describe('phone first view', () => {
  it('fits everything when body text stays at 12 px or more', () => {
    const all = { x: 0, y: 0, width: 300, height: 400 };
    const view = phoneFirstView(all, { x: 0, y: 0, width: 300, height: 200 }, area);
    expect(view).toEqual(fit(all, area));
    expect(view.zoom).toBeGreaterThanOrEqual(READABLE_ZOOM);
  });

  it('fits the first container width at the readable floor when fit-all would shrink text', () => {
    const all = { x: 0, y: 0, width: 920, height: 640 };
    const first = { x: 0, y: 0, width: 920, height: 640 };
    const view = phoneFirstView(all, first, area);
    expect(fit(all, area).zoom).toBeLessThan(READABLE_ZOOM);
    expect(view.zoom).toBe(READABLE_ZOOM);
    expect(view.x).toBe(16);
    expect(view.y).toBeCloseTo(47 + 16 + 36 * READABLE_ZOOM);
  });

  it('fits a narrower first container exactly to the width, never above 1', () => {
    const all = { x: 0, y: 0, width: 2000, height: 1200 };
    const narrow = phoneFirstView(all, { x: 100, y: 50, width: 400, height: 300 }, area);
    expect(narrow.zoom).toBeCloseTo((390 - 32) / 400);
    expect(narrow.x + 100 * narrow.zoom).toBeCloseTo(16);
    expect(narrow.y + (50 - 36) * narrow.zoom).toBeCloseTo(47 + 16);
    expect(phoneFirstView(all, { x: 0, y: 0, width: 100, height: 100 }, area).zoom).toBe(1);
  });

  it('falls back to fit-all when there is nothing to anchor on', () => {
    const all = { x: 0, y: 0, width: 4000, height: 4000 };
    expect(phoneFirstView(all, null, area)).toEqual(fit(all, area));
  });
});
