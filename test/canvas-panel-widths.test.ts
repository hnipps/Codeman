import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PANEL_WIDTHS,
  MIN_BOARD,
  PANEL_BOUNDS,
  fitPanelWidths,
  keyedPanelWidth,
  parsePanelWidths,
} from '../packages/canvas/src/panel-widths.js';

const both = { outline: true, rail: true };

describe('canvas side panel widths', () => {
  it('falls back to the old fixed widths when nothing usable is stored', () => {
    expect(DEFAULT_PANEL_WIDTHS).toEqual({ outline: 192, rail: 320 });
    expect(parsePanelWidths(null)).toEqual(DEFAULT_PANEL_WIDTHS);
    expect(parsePanelWidths('not json')).toEqual(DEFAULT_PANEL_WIDTHS);
    expect(parsePanelWidths('{"outline":"wide","rail":null}')).toEqual(DEFAULT_PANEL_WIDTHS);
  });

  it('keeps a stored width inside the panel bounds', () => {
    expect(parsePanelWidths('{"outline":300,"rail":500}')).toEqual({ outline: 300, rail: 500 });
    expect(parsePanelWidths('{"outline":5,"rail":99999}')).toEqual({
      outline: PANEL_BOUNDS.outline.min,
      rail: PANEL_BOUNDS.rail.max,
    });
  });

  it('draws the preference when the viewport has room for it', () => {
    expect(fitPanelWidths({ outline: 300, rail: 600 }, 1600, both)).toEqual({ outline: 300, rail: 600 });
  });

  it('leaves the board its minimum between two wide panels', () => {
    const drawn = fitPanelWidths({ outline: 480, rail: 800 }, 1200, both);
    expect(drawn.outline + drawn.rail + MIN_BOARD).toBeLessThanOrEqual(1200);
    expect(drawn.rail).toBeGreaterThanOrEqual(PANEL_BOUNDS.rail.min);
  });

  it('lets a panel use the room a closed neighbour leaves', () => {
    expect(fitPanelWidths({ outline: 192, rail: 800 }, 1200, { outline: false, rail: true }).rail).toBe(800);
    expect(fitPanelWidths({ outline: 192, rail: 800 }, 1200, both).rail).toBe(1200 - MIN_BOARD - 192);
  });

  it('never draws a panel below its minimum on a narrow viewport', () => {
    expect(fitPanelWidths({ outline: 400, rail: 700 }, 700, both)).toEqual({
      outline: PANEL_BOUNDS.outline.min,
      rail: PANEL_BOUNDS.rail.min,
    });
  });

  it('moves each edge the way the arrow points', () => {
    expect(keyedPanelWidth('outline', 200, 'ArrowRight', false)).toBe(216);
    expect(keyedPanelWidth('outline', 200, 'ArrowLeft', true)).toBe(PANEL_BOUNDS.outline.min);
    expect(keyedPanelWidth('rail', 320, 'ArrowLeft', false)).toBe(336);
    expect(keyedPanelWidth('rail', 320, 'ArrowRight', true)).toBe(PANEL_BOUNDS.rail.min);
    expect(keyedPanelWidth('rail', 500, 'Enter', false)).toBe(320);
    expect(keyedPanelWidth('rail', 500, 'End', false)).toBe(PANEL_BOUNDS.rail.max);
    expect(keyedPanelWidth('rail', 500, 'a', false)).toBeNull();
  });
});
