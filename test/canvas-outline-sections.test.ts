import { describe, expect, it } from 'vitest';
import {
  MIN_SECTION,
  fitSectionHeights,
  keyedSectionHeight,
  parseOutlineSections,
} from '../packages/canvas/src/outline-sections.js';

describe('canvas outline sections', () => {
  it('starts with every section expanded at its own size when nothing usable is stored', () => {
    const empty = { collapsed: [], heights: {} };
    expect(parseOutlineSections(null)).toEqual(empty);
    expect(parseOutlineSections('not json')).toEqual(empty);
    expect(parseOutlineSections('[1,2]')).toEqual(empty);
    expect(parseOutlineSections('{"collapsed":"work","heights":[]}')).toEqual(empty);
  });

  it('keeps known sections and finite heights, clamped to the minimum', () => {
    const raw = JSON.stringify({
      collapsed: ['work', 'nope', 'work', 'objects'],
      heights: { sessions: 10, prototypes: 180.4, tree: 200, work: 'tall', objects: null },
    });
    expect(parseOutlineSections(raw)).toEqual({
      collapsed: ['work', 'objects'],
      heights: { sessions: MIN_SECTION, prototypes: 180 },
    });
  });

  it('draws a stored height when there is room for it', () => {
    expect(fitSectionHeights([{ preferred: 200, natural: 90 }], 600)).toEqual([200]);
  });

  it('leaves every later expanded section its minimum', () => {
    const heights = fitSectionHeights(
      [
        { preferred: 500, natural: 0 },
        { preferred: 500, natural: 0 },
      ],
      600
    );
    expect(heights).toEqual([600 - 2 * MIN_SECTION, MIN_SECTION]);
  });

  it('counts a section left at its own size against the room', () => {
    expect(
      fitSectionHeights(
        [
          { preferred: null, natural: 300 },
          { preferred: 400, natural: 0 },
        ],
        600
      )
    ).toEqual([null, 600 - 300 - MIN_SECTION]);
  });

  it('never draws below the minimum, even with no room at all', () => {
    expect(fitSectionHeights([{ preferred: 300, natural: 0 }], 50)).toEqual([MIN_SECTION]);
  });

  it('moves the boundary the way the arrow points', () => {
    expect(keyedSectionHeight(200, 'ArrowDown', false)).toBe(216);
    expect(keyedSectionHeight(200, 'ArrowUp', true)).toBe(136);
    expect(keyedSectionHeight(MIN_SECTION, 'ArrowUp', false)).toBe(MIN_SECTION);
    expect(keyedSectionHeight(200, 'Home', false)).toBe(MIN_SECTION);
    expect(keyedSectionHeight(200, 'a', false)).toBeNull();
  });
});
