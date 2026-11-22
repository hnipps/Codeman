// @vitest-environment jsdom
/**
 * @fileoverview Ambient capture, ticket 3: the pure half of capture-layer.js (outline path, crop box,
 * sampling grid, `under` caps and the `capture.json` builder). The pixel half (I2) is in
 * test/capture-layer.browser.test.ts, since jsdom has no canvas.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

type Point = [number, number];
type Pure = {
  normalisePath(points: unknown): Point[];
  cropBox(path: Point[], width: number, height: number): { x: number; y: number; width: number; height: number };
  samplePoints(path: Point[], max?: number): Point[];
  thinPath(path: Point[], max: number): Point[];
  insidePolygon(x: number, y: number, polygon: Point[]): boolean;
  capUnder(entries: unknown[]): Record<string, unknown>[];
  buildCaptureJson(input: Record<string, unknown>): Record<string, unknown>;
  CROP_MARGIN: number;
  UNDER_LIMITS: { samples: number; entries: number; text: number };
};

let pure: Pure;

beforeAll(() => {
  new Function(readFileSync('src/web/public/capture-layer.js', 'utf8'))();
  pure = (window as unknown as { CodemanCaptureLayer: { pure: Pure } }).CodemanCaptureLayer.pure;
});

const square = (x: number, y: number, size: number): Point[] => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size],
];

const facts = { path: '/', title: 'Codeman', view: 'single', sessionId: 's1' };

describe('the outline path', () => {
  it('keeps finite points at 0.1 px and drops repeats, so the stored path is the drawn one', () => {
    expect(pure.normalisePath([[1.234, 2.256], [1.23, 2.26], [NaN, 3], 'x', [5, 6]])).toEqual([
      [1.2, 2.3],
      [5, 6],
    ]);
  });
});

describe('the marked crop', () => {
  it('is the bounding box plus 48 CSS px', () => {
    expect(pure.CROP_MARGIN).toBe(48);
    expect(pure.cropBox(square(200, 300, 100), 1280, 800)).toEqual({ x: 152, y: 252, width: 196, height: 196 });
  });
  it('is clamped to the picture', () => {
    expect(pure.cropBox(square(10, 700, 90), 1280, 800)).toEqual({ x: 0, y: 652, width: 148, height: 148 });
  });
  it('is the whole picture with no outline', () => {
    expect(pure.cropBox([], 1280, 800)).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
  });
});

describe('the under sampling grid', () => {
  it('never takes more than 400 samples, all inside the outline', () => {
    const big = square(0, 0, 1000);
    const points = pure.samplePoints(big);
    expect(pure.UNDER_LIMITS.samples).toBe(400);
    expect(points.length).toBeGreaterThan(300);
    expect(points.length).toBeLessThanOrEqual(400);
    const triangle: Point[] = [
      [0, 0],
      [600, 0],
      [0, 600],
    ];
    const inTriangle = pure.samplePoints(triangle);
    expect(inTriangle.length).toBeLessThanOrEqual(400);
    for (const [x, y] of inTriangle) expect(pure.insidePolygon(x, y, triangle)).toBe(true);
  });
  it('falls back to the outline itself when the loop is too thin to hold a cell', () => {
    const sliver: Point[] = [
      [0, 0],
      [300, 0.2],
      [600, 0],
    ];
    expect(pure.samplePoints(sliver).length).toBeGreaterThan(0);
  });
});

describe('the outline sent to a bridged frame', () => {
  it("is thinned to the bridge's 1024-point limit, keeping its first point", () => {
    const long = Array.from({ length: 5000 }, (_, i): Point => [i, i % 7]);
    const thin = pure.thinPath(long, 1024);
    expect(thin).toHaveLength(1024);
    expect(thin[0]).toEqual([0, 0]);
    expect(pure.thinPath(long.slice(0, 10), 1024)).toHaveLength(10);
  });
});

describe('under entries', () => {
  it('are deduplicated and capped at 24, with text at 2000 characters', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      kind: 'element',
      selector: `div.n${i}`,
      text: 'x'.repeat(3000),
    }));
    const capped = pure.capUnder([{ kind: 'object', id: 'a' }, { kind: 'object', id: 'a' }, ...many]);
    expect(capped).toHaveLength(24);
    expect(capped.filter((e) => e.kind === 'object')).toHaveLength(1);
    expect((capped[1].text as string).length).toBe(2000);
  });
});

describe('capture.json', () => {
  const base = {
    path: square(10, 10, 50),
    dpr: 2,
    crop: { x: 0, y: 0, width: 108, height: 108 },
    width: 1280,
    height: 800,
    facts,
    frames: [
      {
        title: 'Prototype',
        box: { x: 1, y: 2, width: 3, height: 4 },
        depth: 1,
        captured: true,
        selfReported: true,
        el: {},
      },
    ],
    under: [{ kind: 'terminal', sessionId: 's1' }],
    freezeMs: 120,
    capturedAt: '2026-11-22T00:00:00.000Z',
  };

  // Invariant I2: LayersStaySeparate
  it('stores the outline as a CSS-px path with the pixel ratio and scale used', () => {
    const json = pure.buildCaptureJson({ ...base, source: 'dom', picture: 'raster' });
    expect(json).toMatchObject({ version: 1, source: 'dom', path: base.path, dpr: 2, scale: 1, picture: 'raster' });
    expect(json.page).toEqual(facts);
    expect(json.under).toEqual([{ kind: 'terminal', sessionId: 's1' }]);
    expect(json.frames).toEqual([
      { title: 'Prototype', box: { x: 1, y: 2, width: 3, height: 4 }, depth: 1, captured: true, selfReported: true },
    ]);
    expect(json).toHaveProperty('workspaceRule', null);
    expect(json).toHaveProperty('capturedAt', base.capturedAt);
  });

  // Invariant I9: PhoneContextIsLabelled
  it('labels an image capture with openedFrom, never page, and has no under list', () => {
    const json = pure.buildCaptureJson({ ...base, source: 'image' });
    expect(json.source).toBe('image');
    expect(json.openedFrom).toEqual(facts);
    expect(json).not.toHaveProperty('page');
    expect(json).not.toHaveProperty('under');
    expect(json.frames).toEqual([]);
  });
});
