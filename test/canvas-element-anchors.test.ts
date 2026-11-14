/**
 * Element comments, the part with no DOM: the anchors a page holds, how comments share pins, where a pin
 * sits, when a frame is asked again, and what is kept of an unposted comment's element.
 */
import { describe, expect, it } from 'vitest';
import {
  AnchorStore,
  groupOf,
  MAX_STORED_DRAFT_ELEMENTS,
  parseAnchors,
  parseDraftElements,
  PIN_NUDGE,
  pinGroups,
  pinPoint,
  Relocator,
  sameElement,
  storeDraftElement,
} from '../packages/canvas/src/element-anchors.js';
import { parseAsks } from '../packages/canvas/src/ask.js';
import type { ElementRef } from '../src/canvas/element-ref.js';

const element = (objectId: string, selector: string, text = 'Start'): ElementRef => ({
  objectId,
  selector,
  path: selector,
  tag: 'button',
  text,
  rect: { x: 0, y: 0, width: 10, height: 10 },
  attrs: {},
  styles: {},
});
const comment = (id: string, objectId: string, createdAt: number) => ({ id, objectId, createdAt });

describe('the anchors answer', () => {
  it('reads elements by comment id and leaves out an entry that is not one', () => {
    const anchors = parseAnchors({
      success: true,
      data: { anchors: { c1: element('board', '#start'), c2: { selector: 7 }, c3: 'text' } },
    });
    expect([...anchors!.keys()]).toEqual(['c1']);
    expect(anchors!.get('c1')?.selector).toBe('#start');
  });

  it('is null for anything that is not the answer, so what is held is kept', () => {
    expect(parseAnchors({ success: false, error: 'no' })).toBeNull();
    expect(parseAnchors({ success: true, data: {} })).toBeNull();
    expect(parseAnchors(null)).toBeNull();
  });
});

describe('the anchor store', () => {
  it('asks for a read when a comment appears and not when one only goes', () => {
    const store = new AnchorStore();
    expect(store.comments([])).toBe(false);
    expect(store.comments(['c1'])).toBe(true);
    expect(store.comments(['c1'])).toBe(false);
    expect(store.comments(['c1', 'c2'])).toBe(true);
    expect(store.comments(['c2'])).toBe(false);
  });

  it('drops the anchor of a comment that went away, and reads again when an undo brings it back', () => {
    const store = new AnchorStore();
    store.comments(['c1', 'c2']);
    store.replace(
      new Map([
        ['c1', element('board', '#start')],
        ['c2', element('board', '#stop')],
      ])
    );
    store.comments(['c2']);
    expect(store.get('c1')).toBeUndefined();
    expect(store.get('c2')?.selector).toBe('#stop');
    expect(store.comments(['c1', 'c2'])).toBe(true);
  });

  it('keeps an anchor that was read before its comment arrived', () => {
    const store = new AnchorStore();
    store.comments(['c1']);
    store.replace(new Map([['c9', element('board', '#late')]]));
    store.comments(['c1']);
    expect(store.get('c9')?.selector).toBe('#late');
    store.comments(['c1', 'c9']);
    expect(store.get('c9')?.selector).toBe('#late');
  });

  it('takes the server answer as the whole truth and holds what this page just posted until then', () => {
    const store = new AnchorStore();
    store.set('mine', element('board', '#start'));
    expect(store.get('mine')?.selector).toBe('#start');
    store.replace(new Map([['other', element('board', '#stop')]]));
    expect(store.get('mine')).toBeUndefined();
    expect(store.size).toBe(1);
  });
});

describe('pin groups', () => {
  const anchors = new Map<string, ElementRef>([
    ['c1', element('board', '#start')],
    ['c2', element('board', '#stop')],
    ['c3', element('board', '#start', 'Start again')],
    ['c5', element('other', '#start')],
    ['c6', element('board', '#wrong-object')],
  ]);
  const comments = [
    comment('c3', 'board', 30),
    comment('c1', 'board', 10),
    comment('c2', 'board', 20),
    comment('c4', 'board', 40),
    comment('c5', 'other', 5),
    comment('c6', 'other', 50),
  ];
  const groups = pinGroups(comments, (id) => anchors.get(id));

  it('numbers elements in the order they were first commented on, per embed', () => {
    expect(groups.get('board')!.map((g) => [g.number, g.selector, g.commentIds])).toEqual([
      [1, '#start', ['c1', 'c3']],
      [2, '#stop', ['c2']],
    ]);
    expect(groups.get('other')!.map((g) => [g.number, g.selector, g.commentIds])).toEqual([[1, '#start', ['c5']]]);
  });

  it('gives several comments on one selector one pin, labelled by the oldest', () => {
    expect(groups.get('board')![0].element.text).toBe('Start');
    expect(groupOf(groups, 'board', 'c3')?.number).toBe(1);
  });

  it('gives no pin to a comment with no anchor or one that names another object', () => {
    expect(groupOf(groups, 'board', 'c4')).toBeUndefined();
    expect(groupOf(groups, 'other', 'c6')).toBeUndefined();
  });

  it('orders comments made in the same millisecond by id, like the thread', () => {
    const tied = pinGroups([comment('b', 'board', 1), comment('a', 'board', 1)], (id) =>
      element('board', id === 'a' ? '#first' : '#second')
    );
    expect(tied.get('board')!.map((g) => g.selector)).toEqual(['#first', '#second']);
  });
});

describe('where a pin sits', () => {
  const frame = { x: 100, y: 100, width: 400, height: 300 };

  it('is just off the top-right corner of the part of the element that shows', () => {
    expect(pinPoint(frame, { x: 150, y: 160, width: 80, height: 30 })).toEqual({
      x: 230 + PIN_NUDGE,
      y: 160 - PIN_NUDGE,
    });
  });

  it('moves in so the whole pin stays inside the frame', () => {
    expect(pinPoint(frame, { x: 420, y: 100, width: 80, height: 30 })).toEqual({ x: 490, y: 110 });
    expect(pinPoint(frame, { x: 100, y: 395, width: 4, height: 5 })).toEqual({ x: 110, y: 390 });
  });

  it('is nowhere when none of the element shows or the frame is smaller than a pin', () => {
    expect(pinPoint(frame, null)).toBeNull();
    expect(pinPoint({ x: 0, y: 0, width: 12, height: 300 }, { x: 0, y: 0, width: 5, height: 5 })).toBeNull();
  });
});

describe('asking a frame again', () => {
  function harness() {
    const frames: (() => void)[] = [];
    const runs: string[] = [];
    const finish = new Map<string, () => void>();
    const relocator = new Relocator(
      (id) => {
        runs.push(id);
        return new Promise<void>((done) => finish.set(id, done));
      },
      (callback) => frames.push(callback)
    );
    const tick = async () => {
      for (const callback of frames.splice(0)) callback();
      await Promise.resolve();
      await Promise.resolve();
    };
    return { relocator, runs, finish, frames, tick };
  }

  it('asks each frame once per animation frame however often it is requested', async () => {
    const h = harness();
    for (let i = 0; i < 50; i++) h.relocator.request('a');
    h.relocator.request('b');
    expect(h.runs).toEqual([]);
    expect(h.frames).toHaveLength(1);
    await h.tick();
    expect(h.runs).toEqual(['a', 'b']);
  });

  it('never asks a frame while its last answer is out, and asks once more when it is in', async () => {
    const h = harness();
    h.relocator.request('a');
    await h.tick();
    h.relocator.request('a');
    h.relocator.request('a');
    await h.tick();
    await h.tick();
    expect(h.runs).toEqual(['a']);
    h.finish.get('a')!();
    await h.tick();
    await h.tick();
    expect(h.runs).toEqual(['a', 'a']);
    h.finish.get('a')!();
    await h.tick();
    await h.tick();
    expect(h.runs).toEqual(['a', 'a']);
  });

  it('keeps asking after a run that failed', async () => {
    const frames: (() => void)[] = [];
    let runs = 0;
    const relocator = new Relocator(
      () => {
        runs++;
        return Promise.reject(new Error('frame gone'));
      },
      (callback) => frames.push(callback)
    );
    relocator.request('a');
    frames.splice(0).forEach((f) => f());
    await Promise.resolve();
    await Promise.resolve();
    relocator.request('a');
    frames.splice(0).forEach((f) => f());
    expect(runs).toBe(2);
  });
});

describe("an unposted comment's element", () => {
  it('is kept per object and removed with null', () => {
    let kept = storeDraftElement({}, 'board', element('board', '#start'));
    kept = storeDraftElement(kept, 'other', element('other', '#stop'));
    expect(Object.keys(kept)).toEqual(['board', 'other']);
    kept = storeDraftElement(kept, 'board', null);
    expect(Object.keys(kept)).toEqual(['other']);
  });

  it('is bounded, oldest first', () => {
    let kept = {};
    for (let i = 0; i < MAX_STORED_DRAFT_ELEMENTS + 4; i++)
      kept = storeDraftElement(kept, `o${i}`, element(`o${i}`, '#x'));
    expect(Object.keys(kept)).toHaveLength(MAX_STORED_DRAFT_ELEMENTS);
    expect(Object.keys(kept)[0]).toBe('o4');
  });

  it('reads back only well-formed elements stored under their own object', () => {
    const raw = JSON.stringify({
      board: element('board', '#start'),
      other: element('board', '#moved'),
      bad: { selector: '' },
    });
    expect(Object.keys(parseDraftElements(raw))).toEqual(['board']);
    expect(parseDraftElements('not json')).toEqual({});
    expect(parseDraftElements('[1]')).toEqual({});
    expect(parseDraftElements(null)).toEqual({});
  });

  it('is the same element when the object and selector match, whatever else the page said', () => {
    expect(sameElement(element('board', '#start', 'A'), element('board', '#start', 'B'))).toBe(true);
    expect(sameElement(element('board', '#start'), element('board', '#stop'))).toBe(false);
    expect(sameElement(element('board', '#start'), null)).toBe(false);
    expect(sameElement(null, undefined)).toBe(true);
  });
});

describe('an Ask agent attempt kept across a reload', () => {
  const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  const attempt = {
    objectId: 'board',
    text: 'Why is this amber?',
    target: null,
    commentRequestId: id(1),
    commentId: id(2),
    createRequestId: id(3),
    messageId: id(4),
    conversationId: null,
  };

  it('keeps its element, so a retry posts the same anchor', () => {
    const [read] = parseAsks(JSON.stringify([{ ...attempt, element: element('board', '#start') }]));
    expect(read.element?.selector).toBe('#start');
    expect(read.commentId).toBe(id(2));
  });

  it('keeps the attempt and drops an element that is malformed or names another object', () => {
    const read = parseAsks(
      JSON.stringify([
        { ...attempt, element: { selector: 5 } },
        { ...attempt, objectId: 'other', element: element('board', '#start') },
      ])
    );
    expect(read).toHaveLength(2);
    expect(read.every((a) => a.element === undefined)).toBe(true);
  });
});
