/**
 * The canvas side of the frame bridge: which messages from a frame are taken, the arithmetic between
 * the screen and a frame's own pixels, the rule for a loop drawn inside one frame, and pending elements.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clipToFrame,
  frameBox,
  framePolygon,
  FrameReplies,
  loopFrame,
  MAX_LOCATE_SELECTORS,
  MAX_POLYGON_POINTS,
  parseFrameMessage,
  toFramePoint,
  toScreenRect,
} from '../packages/canvas/src/frame-messages.js';
import {
  changedPages,
  elementChips,
  elementsAdd,
  elementsPrune,
  elementsRemove,
} from '../packages/canvas/src/context.js';
import { command, initialView } from '../packages/canvas/src/commands.js';
import { parseStoredElements } from '../packages/canvas/src/assistant.js';
import { elementsField, nextAttempt, parseAttempt, parseSent } from '../packages/canvas/src/outbox.js';
import { ElementRefSchema, MAX_ELEMENT_REFS, type ElementRef } from '../src/canvas/element-ref.js';
import type { ViewObject } from '../packages/canvas/src/model.js';

const wire = (over: Record<string, unknown> = {}) => ({
  selector: '#start',
  path: 'main > button#start',
  tag: 'button',
  text: 'Start task',
  rect: { x: 10, y: 20, width: 80, height: 30 },
  attrs: { id: 'start' },
  styles: { color: 'rgb(0, 0, 0)' },
  ...over,
});
const ref = (objectId: string, selector: string, text = 'Start task'): ElementRef =>
  ElementRefSchema.parse({ ...wire({ selector, text }), objectId });
const object = (id: string, type: string, url?: string, deletedAt: number | null = null): ViewObject => ({
  id,
  parentId: null,
  order: 0,
  type,
  position: { x: 0, y: 0 },
  size: { width: 400, height: 300 },
  rotation: 0,
  content: type === 'embed' || type === 'link' ? { type, url, label: `Page ${id}` } : { type, text: id },
  author: { kind: 'human', userId: 'u' },
  createdAt: 0,
  updatedAt: 0,
  deletedAt,
});

describe('messages from a frame', () => {
  it('takes each message of the protocol and stamps the object the frame belongs to', () => {
    expect(parseFrameMessage({ type: 'codeman:canvas-escape' }, 'e1')).toEqual({ type: 'escape' });
    expect(parseFrameMessage({ type: 'codeman:frame-ready' }, 'e1')).toEqual({ type: 'ready' });
    expect(parseFrameMessage({ type: 'codeman:frame-key', key: 'q', phase: 'down' }, 'e1')).toEqual({
      type: 'key',
      phase: 'down',
    });
    expect(parseFrameMessage({ type: 'codeman:frame-pick-cancelled' }, 'e1')).toEqual({ type: 'pick-cancelled' });
    expect(parseFrameMessage({ type: 'codeman:frame-rects-changed' }, 'e1')).toEqual({ type: 'rects-changed' });
    const picked = parseFrameMessage({ type: 'codeman:frame-picked', element: wire() }, 'e1');
    expect(picked).toEqual({ type: 'picked', element: { ...wire(), objectId: 'e1' } });
    expect(ElementRefSchema.safeParse(picked?.type === 'picked' ? picked.element : null).success).toBe(true);
    expect(
      parseFrameMessage({ type: 'codeman:frame-elements', requestId: 'r1', elements: [wire(), wire()] }, 'e2')
    ).toMatchObject({ type: 'elements', requestId: 'r1', elements: [{ objectId: 'e2' }, { objectId: 'e2' }] });
    expect(
      parseFrameMessage({ type: 'codeman:frame-rects', requestId: 'r2', rects: [null, wire().rect] }, 'e1')
    ).toEqual({ type: 'rects', requestId: 'r2', rects: [null, wire().rect] });
  });
  it('never lets a frame name its own object', () => {
    expect(parseFrameMessage({ type: 'codeman:frame-picked', element: { ...wire(), objectId: 'other' } }, 'e1')).toBe(
      null
    );
  });
  it('reports no key but bare Q', () => {
    for (const key of ['a', 'Q', 'Enter', 'Escape', ''])
      expect(parseFrameMessage({ type: 'codeman:frame-key', key, phase: 'down' }, 'e1')).toBe(null);
    expect(parseFrameMessage({ type: 'codeman:frame-key', key: 'q', phase: 'held' }, 'e1')).toBe(null);
    expect(parseFrameMessage({ type: 'codeman:frame-key', key: 'q', phase: 'down', text: 'secret' }, 'e1')).toBe(null);
  });
  it('drops anything malformed, oversized or unknown', () => {
    const bad: unknown[] = [
      null,
      'codeman:canvas-escape',
      42,
      [],
      {},
      { type: 'codeman:frame-admin' },
      { type: 'codeman:canvas-escape', extra: 1 },
      { type: 'codeman:frame-picked' },
      { type: 'codeman:frame-picked', element: wire({ selector: '' }) },
      { type: 'codeman:frame-picked', element: wire({ selector: 'a'.repeat(1025) }) },
      { type: 'codeman:frame-picked', element: wire({ text: 'x'.repeat(2001) }) },
      { type: 'codeman:frame-picked', element: wire({ rect: { x: 0, y: 0, width: -1, height: 1 } }) },
      { type: 'codeman:frame-picked', element: wire({ rect: { x: Infinity, y: 0, width: 1, height: 1 } }) },
      { type: 'codeman:frame-picked', element: wire({ html: '<img onerror=alert(1)>' }) },
      {
        type: 'codeman:frame-picked',
        element: wire({ attrs: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`a${i}`, 'v'])) }),
      },
      { type: 'codeman:frame-picked', element: wire({ styles: { color: 'x'.repeat(257) } }) },
      { type: 'codeman:frame-elements', requestId: 'r', elements: Array(MAX_ELEMENT_REFS + 1).fill(wire()) },
      { type: 'codeman:frame-elements', requestId: 'r', elements: [wire(), { tag: 'div' }] },
      { type: 'codeman:frame-elements', requestId: 'r'.repeat(65), elements: [] },
      { type: 'codeman:frame-elements', elements: [] },
      { type: 'codeman:frame-rects', requestId: 'r', rects: Array(MAX_LOCATE_SELECTORS + 1).fill(null) },
      { type: 'codeman:frame-rects', requestId: 'r', rects: [{ x: 0, y: 0 }] },
    ];
    for (const data of bad) expect(parseFrameMessage(data, 'e1'), JSON.stringify(data)?.slice(0, 80)).toBe(null);
  });
});

describe('frame coordinates', () => {
  it.each([0.5, 1, 2, 4])('maps between the screen and the frame at zoom %s', (zoom) => {
    // A stage 400 canvas units wide whose top-left corner sits at (300, 120) on screen.
    const box = frameBox('e1', { x: 300, y: 120, width: 400 * zoom, height: 300 * zoom }, 400, 0)!;
    expect(box.scale).toBe(zoom);
    expect(toFramePoint(box, { x: 300, y: 120 })).toEqual({ x: 0, y: 0 });
    expect(toFramePoint(box, { x: 300 + 100 * zoom, y: 120 + 50 * zoom })).toEqual({ x: 100, y: 50 });
    const onScreen = toScreenRect(box, { x: 100, y: 50, width: 80, height: 30 });
    expect(onScreen).toEqual({ x: 300 + 100 * zoom, y: 120 + 50 * zoom, width: 80 * zoom, height: 30 * zoom });
    expect(toFramePoint(box, { x: onScreen.x, y: onScreen.y })).toEqual({ x: 100, y: 50 });
  });
  it('has no box for a rotated or empty frame', () => {
    const rect = { x: 0, y: 0, width: 400, height: 300 };
    expect(frameBox('e1', rect, 400, 90)).toBe(null);
    expect(frameBox('e1', rect, 400, -15)).toBe(null);
    expect(frameBox('e1', rect, 400, 360)).not.toBe(null);
    expect(frameBox('e1', rect, 0, 0)).toBe(null);
    expect(frameBox('e1', { ...rect, width: 0 }, 400, 0)).toBe(null);
  });
  it('cuts a rectangle to the part of it the frame shows', () => {
    const box = frameBox('e1', { x: 100, y: 100, width: 200, height: 100 }, 200, 0)!;
    expect(clipToFrame(box, { x: 50, y: 150, width: 100, height: 100 })).toEqual({
      x: 100,
      y: 150,
      width: 50,
      height: 50,
    });
    expect(clipToFrame(box, { x: 400, y: 150, width: 10, height: 10 })).toBe(null);
  });
  it('thins a long loop to what one message carries', () => {
    const box = frameBox('e1', { x: 0, y: 0, width: 800, height: 600 }, 400, 0)!;
    const points = Array.from({ length: 3000 }, (_, i) => ({ x: i / 10, y: 10 }));
    const polygon = framePolygon(box, points);
    expect(polygon.length).toBeLessThanOrEqual(MAX_POLYGON_POINTS);
    expect(polygon[0]).toEqual([0, 5]);
    expect(framePolygon(box, points.slice(0, 4))).toHaveLength(4);
  });
});

describe('a loop drawn inside one frame', () => {
  const a = frameBox('a', { x: 100, y: 100, width: 400, height: 300 }, 400, 0)!;
  const b = frameBox('b', { x: 600, y: 100, width: 400, height: 300 }, 400, 0)!;
  const loop = (x: number, y: number, size = 50) => [
    { x, y },
    { x: x + size, y },
    { x: x + size, y: y + size },
    { x, y: y + size },
  ];
  it('belongs to the frame that holds every point', () => {
    expect(loopFrame(loop(150, 150), [a, b], [])?.id).toBe('a');
    expect(loopFrame(loop(700, 200), [a, b], [])?.id).toBe('b');
    expect(loopFrame(loop(100, 100, 300), [a, b], ['a'])?.id).toBe('a');
  });
  it('is a loop around objects once any point leaves the frame', () => {
    expect(loopFrame(loop(80, 150), [a, b], [])).toBe(null);
    expect(loopFrame([...loop(150, 150), { x: 501, y: 200 }], [a, b], [])).toBe(null);
    expect(loopFrame(loop(480, 150, 200), [a, b], [])).toBe(null);
    expect(loopFrame(loop(1200, 700), [a, b], [])).toBe(null);
  });
  it('is a loop around objects when it circles something else lying on the frame', () => {
    expect(loopFrame(loop(150, 150), [a, b], ['note'])).toBe(null);
    expect(loopFrame(loop(150, 150), [a, b], ['a', 'note'])).toBe(null);
  });
  it('needs three points and takes the front-most frame where two overlap', () => {
    expect(loopFrame(loop(150, 150).slice(0, 2), [a], [])).toBe(null);
    const over = frameBox('over', { x: 120, y: 120, width: 200, height: 200 }, 200, 0)!;
    expect(loopFrame(loop(150, 150), [over, a], [])?.id).toBe('over');
  });
});

describe('replies from a frame', () => {
  afterEach(() => vi.useRealTimers());
  it('settles on the answer with the same id from the same frame, and on nothing after the time limit', async () => {
    vi.useFakeTimers();
    let next = 0;
    const replies = new FrameReplies<number[]>(() => `r${++next}`, 500);
    const frameA = {},
      frameB = {};
    const sent: string[] = [];
    const first = replies.ask(frameA, (id) => sent.push(id));
    expect(replies.settle('r1', frameB, [9])).toBe(false);
    expect(replies.settle('nope', frameA, [9])).toBe(false);
    expect(replies.settle('r1', frameA, [1])).toBe(true);
    expect(await first).toEqual([1]);
    expect(replies.settle('r1', frameA, [2])).toBe(false);
    const late = replies.ask(frameA, (id) => sent.push(id));
    vi.advanceTimersByTime(501);
    expect(await late).toBe(null);
    const dropped = replies.ask(frameB, (id) => sent.push(id));
    replies.drop(frameB);
    expect(await dropped).toBe(null);
    expect(sent).toEqual(['r1', 'r2', 'r3']);
  });
});

describe('pending elements', () => {
  const objects = [
    object('e1', 'embed', 'https://a.example/'),
    object('e2', 'embed', 'https://b.example/'),
    object('n', 'text'),
  ];
  it('adds once per embed and selector, keeps order, takes the newer description, and is bounded', () => {
    const first = elementsAdd([], [ref('e1', '#a'), ref('e1', '#b'), ref('e2', '#a')]);
    expect(first.map((r) => `${r.objectId}${r.selector}`)).toEqual(['e1#a', 'e1#b', 'e2#a']);
    const again = elementsAdd(first, [ref('e1', '#b', 'Renamed'), ref('e1', '#c')]);
    expect(again.map((r) => r.selector)).toEqual(['#a', '#b', '#a', '#c']);
    expect(again[1].text).toBe('Renamed');
    const many = Array.from({ length: MAX_ELEMENT_REFS + 20 }, (_, i) => ref('e1', `#n${i}`));
    expect(elementsAdd(first, many)).toHaveLength(MAX_ELEMENT_REFS);
  });
  it('removes one, and prunes those whose embed is gone or is no longer an embed', () => {
    const three = [ref('e1', '#a'), ref('e1', '#b'), ref('e2', '#a')];
    expect(elementsRemove(three, [{ objectId: 'e1', selector: '#a' }]).map((r) => r.selector)).toEqual(['#b', '#a']);
    expect(elementsPrune([objects[0]], three).map((r) => r.objectId)).toEqual(['e1', 'e1']);
    expect(elementsPrune([object('e1', 'embed', 'https://a.example/', 5), objects[1]], three)).toHaveLength(1);
    expect(elementsPrune([object('e1', 'link', 'https://a.example/'), objects[1]], three)).toHaveLength(1);
  });
  it('names the embeds whose page changed or went away', () => {
    expect(changedPages(objects, objects)).toEqual([]);
    expect(changedPages(objects, [object('e1', 'embed', 'https://a.example/next'), objects[1]])).toEqual(['e1']);
    expect(changedPages(objects, [objects[0]])).toEqual(['e2']);
    expect(changedPages(objects, [object('e1', 'link', 'https://a.example/'), objects[1]])).toEqual(['e1']);
  });
  it('labels a chip with the element and the embed it is in', () => {
    expect(elementChips(objects, [ref('e1', '#a'), ref('gone', '#a')])).toEqual([
      { objectId: 'e1', selector: '#a', label: 'button "Start task"', page: 'Page e1' },
    ]);
  });
  it('goes through the view reducer beside object context', () => {
    const start = { ...initialView(), selected: ['n'], context: ['n'] };
    const added = command(
      start,
      { kind: 'context-elements-add', elements: [ref('e1', '#a'), ref('gone', '#x')] },
      objects
    );
    expect(added.contextElements.map((r) => r.selector)).toEqual(['#a']);
    expect({ ...added, contextElements: [] }).toEqual(start);
    const two = command(added, { kind: 'context-elements-add', elements: [ref('e2', '#b')] }, objects);
    expect(
      command(two, { kind: 'context-elements-remove', elements: [{ objectId: 'e1', selector: '#a' }] }, objects)
        .contextElements
    ).toHaveLength(1);
    expect(command(two, { kind: 'context-elements-drop', objectIds: ['e2'] }, objects).contextElements).toHaveLength(1);
    // A send clears what it carried and keeps what was added while it travelled.
    const sent = command(
      two,
      { kind: 'context-clear-sent', ids: ['n'], elements: [{ objectId: 'e1', selector: '#a' }] },
      objects
    );
    expect(sent.context).toEqual([]);
    expect(sent.contextElements.map((r) => r.objectId)).toEqual(['e2']);
    expect(command(two, { kind: 'context-clear-sent' }, objects).contextElements).toEqual([]);
    // A deleted embed takes its elements with it the next time the canvas is read.
    expect(command(two, { kind: 'context-add', ids: [] }, [objects[1]]).contextElements.map((r) => r.objectId)).toEqual(
      ['e2']
    );
  });
  it('restores stored elements only while their embed still shows the page they were picked in', () => {
    const stored = JSON.stringify([
      { url: 'https://a.example/', ref: ref('e1', '#a') },
      { url: 'https://old.example/', ref: ref('e2', '#a') },
      { url: 'https://a.example/', ref: { selector: '#broken' } },
    ]);
    const pages = new Map([
      ['e1', 'https://a.example/'],
      ['e2', 'https://b.example/'],
    ]);
    expect(parseStoredElements(stored, pages).map((r) => r.objectId)).toEqual([]);
    const good = JSON.stringify(JSON.parse(stored).slice(0, 2));
    expect(parseStoredElements(good, pages).map((r) => r.objectId)).toEqual(['e1']);
    expect(parseStoredElements('{bad', pages)).toEqual([]);
    expect(parseStoredElements(null, pages)).toEqual([]);
  });
  it('rides with a send attempt, and a plain message is unchanged on the wire', () => {
    let n = 0;
    const make = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    const plain = nextAttempt(null, null, 'hi', ['n'], make);
    expect('elements' in plain).toBe(false);
    expect(elementsField([])).toEqual({});
    const withElement = nextAttempt(plain, null, 'hi', ['n'], make, [ref('e1', '#a')]);
    expect(withElement.messageId).not.toBe(plain.messageId);
    expect(nextAttempt(withElement, null, 'hi', ['n'], make, [ref('e1', '#a')])).toBe(withElement);
    expect(nextAttempt(withElement, null, 'hi', ['n'], make, [ref('e1', '#b')]).messageId).not.toBe(
      withElement.messageId
    );
    expect(parseAttempt(JSON.stringify(withElement))).toEqual(withElement);
    expect(parseAttempt(JSON.stringify({ ...withElement, elements: [{ selector: 1 }] }))?.elements).toBeUndefined();
    const sent = parseSent(
      JSON.stringify([{ messageId: plain.messageId, text: 'hi', refIds: [], elements: [ref('e1', '#a')] }])
    );
    expect(sent[0].elements).toHaveLength(1);
  });
});
