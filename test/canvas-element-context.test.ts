/**
 * Elements picked inside live frames as pending chat context: the pure rules behind the chips, the view
 * commands, what a send carries and what a reload restores.
 */
import { describe, expect, it } from 'vitest';
import {
  changedPages,
  elementChips,
  elementsAdd,
  elementsPrune,
  elementsRemove,
} from '../packages/canvas/src/context.js';
import { command, initialView } from '../packages/canvas/src/commands.js';
import { elementsField, nextAttempt, parseAttempt, parseSent } from '../packages/canvas/src/outbox.js';
import { parseStoredElements } from '../packages/canvas/src/assistant.js';
import { MAX_ELEMENT_REFS, type ElementRef } from '../src/canvas/element-ref.js';
import type { ViewObject } from '../packages/canvas/src/model.js';

const object = (id: string, content: Record<string, unknown>, deletedAt: number | null = null): ViewObject => ({
  id,
  parentId: null,
  order: 0,
  type: String(content.type),
  position: { x: 0, y: 0 },
  size: { width: 400, height: 300 },
  rotation: 0,
  content,
  author: { kind: 'human', userId: 'u' },
  createdAt: 0,
  updatedAt: 0,
  deletedAt,
});
const embed = (id: string, url: string, deletedAt: number | null = null) =>
  object(id, { type: 'embed', url, label: `Page ${id}` }, deletedAt);
const ref = (objectId: string, selector: string, text = 'Go'): ElementRef => ({
  objectId,
  selector,
  path: `main > ${selector}`,
  tag: 'button',
  text,
  rect: { x: 1, y: 2, width: 30, height: 10 },
  attrs: {},
  styles: {},
});
const objects = [embed('a', 'http://one.test/'), embed('b', 'http://two.test/'), object('note', { type: 'text' })];

describe('pending elements', () => {
  it('adds once per embed and selector, keeps the place of a repeat, and stops at the cap', () => {
    const first = elementsAdd([], [ref('a', '#x'), ref('b', '#x'), ref('a', '#y')]);
    expect(first.map((r) => `${r.objectId}${r.selector}`)).toEqual(['a#x', 'b#x', 'a#y']);
    const again = elementsAdd(first, [ref('a', '#x', 'Renamed')]);
    expect(again).toHaveLength(3);
    expect(again[0].text).toBe('Renamed');
    const many = Array.from({ length: MAX_ELEMENT_REFS + 5 }, (_, i) => ref('a', `#n${i}`));
    expect(elementsAdd(first, many)).toHaveLength(MAX_ELEMENT_REFS);
    expect(elementsRemove(first, [{ objectId: 'a', selector: '#x' }]).map((r) => r.selector)).toEqual(['#x', '#y']);
  });
  it('keeps only elements of a live embed, and names the embeds whose page changed', () => {
    const refs = [ref('a', '#x'), ref('note', '#x'), ref('gone', '#x'), ref('missing', '#x')];
    const all = [...objects, embed('gone', 'http://three.test/', 9)];
    expect(elementsPrune(all, refs).map((r) => r.objectId)).toEqual(['a']);
    const after = [embed('a', 'http://one.test/?v=2'), object('b', { type: 'link', url: 'http://two.test/' })];
    expect(changedPages(objects, after)).toEqual(['a', 'b']);
    expect(changedPages(objects, objects)).toEqual([]);
    expect(changedPages(objects, [embed('a', 'http://one.test/')])).toEqual(['b']);
  });
  it('labels a chip with the element over its embed, and skips an element with no embed', () => {
    expect(elementChips(objects, [ref('a', '#x'), ref('missing', '#x')])).toEqual([
      { objectId: 'a', selector: '#x', label: 'button "Go"', page: 'Page a' },
    ]);
  });
});

describe('view commands for elements', () => {
  const start = () => command(initialView(), { kind: 'context-elements-add', elements: [ref('a', '#x')] }, objects);
  it('adds, removes and drops by embed without touching object context', () => {
    let state = command(
      { ...start(), context: ['note'] },
      { kind: 'context-elements-add', elements: [ref('b', '#y')] },
      objects
    );
    expect(state.contextElements.map((r) => r.selector)).toEqual(['#x', '#y']);
    expect(state.context).toEqual(['note']);
    // An element of something that is not a live embed is never taken.
    state = command(state, { kind: 'context-elements-add', elements: [ref('note', '#z'), ref('nope', '#z')] }, objects);
    expect(state.contextElements).toHaveLength(2);
    state = command(state, { kind: 'context-elements-remove', elements: [{ objectId: 'a', selector: '#x' }] }, objects);
    expect(state.contextElements.map((r) => r.selector)).toEqual(['#y']);
    state = command(state, { kind: 'context-elements-drop', objectIds: ['b'] }, objects);
    expect(state.contextElements).toEqual([]);
    expect(state.context).toEqual(['note']);
  });
  it('clears what a send carried and keeps what was added while it travelled', () => {
    const state = command(
      { ...start(), context: ['note'] },
      { kind: 'context-elements-add', elements: [ref('b', '#late')] },
      objects
    );
    const sent = command(
      state,
      { kind: 'context-clear-sent', ids: ['note'], elements: [{ objectId: 'a', selector: '#x' }] },
      objects
    );
    expect(sent.context).toEqual([]);
    expect(sent.contextElements.map((r) => r.selector)).toEqual(['#late']);
    // A send from a page that names no elements leaves them; a clear that names nothing takes everything.
    expect(command(state, { kind: 'context-clear-sent', ids: ['note'] }, objects).contextElements).toHaveLength(2);
    const cleared = command(state, { kind: 'context-clear-sent' }, objects);
    expect([cleared.context, cleared.contextElements]).toEqual([[], []]);
  });
});

describe('elements on the wire and in storage', () => {
  it('leaves a plain message unchanged and carries elements only when there are some', () => {
    expect(elementsField([])).toEqual({});
    expect(elementsField(undefined)).toEqual({});
    expect(elementsField([ref('a', '#x')])).toEqual({ elements: [ref('a', '#x')] });
    let n = 0;
    const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    const plain = nextAttempt(null, 'c', 'hi', ['note'], id);
    expect('elements' in plain).toBe(false);
    const withElement = nextAttempt(plain, 'c', 'hi', ['note'], id, [ref('a', '#x')]);
    // Different context is a different message; the same context reuses the ids so the server writes once.
    expect(withElement.messageId).not.toBe(plain.messageId);
    expect(nextAttempt(withElement, 'c', 'hi', ['note'], id, [ref('a', '#x')])).toBe(withElement);
    expect(parseAttempt(JSON.stringify(withElement))).toEqual(withElement);
  });
  it('reads a stored attempt or sent record whose elements are malformed as one without elements', () => {
    const attempt = {
      conversationId: 'c',
      createRequestId: '00000000-0000-4000-8000-00000000000a',
      messageId: '00000000-0000-4000-8000-00000000000b',
      text: 'hi',
      refIds: [],
    };
    expect(parseAttempt(JSON.stringify({ ...attempt, elements: [{ objectId: 'a' }] }))).toEqual(attempt);
    expect(parseAttempt(JSON.stringify({ ...attempt, elements: 'x' }))).toEqual(attempt);
    const sent = [
      { messageId: '00000000-0000-4000-8000-0000000000aa', text: 'hi', refIds: [], elements: [ref('a', '#x')] },
      { messageId: '00000000-0000-4000-8000-0000000000bb', text: 'yo', refIds: [], elements: [{}] },
    ];
    expect(parseSent(JSON.stringify(sent))).toEqual([
      sent[0],
      { messageId: '00000000-0000-4000-8000-0000000000bb', text: 'yo', refIds: [] },
    ]);
  });
  it('restores pending elements only while their embed still shows the page they were picked in', () => {
    const pages = new Map([
      ['a', 'http://one.test/'],
      ['b', 'http://two.test/?v=2'],
    ]);
    const stored = JSON.stringify([
      { url: 'http://one.test/', ref: ref('a', '#x') },
      { url: 'http://two.test/', ref: ref('b', '#y') },
      { url: 'http://three.test/', ref: ref('gone', '#z') },
    ]);
    expect(parseStoredElements(stored, pages).map((r) => r.objectId)).toEqual(['a']);
    expect(parseStoredElements(null, pages)).toEqual([]);
    expect(parseStoredElements('not json', pages)).toEqual([]);
    expect(parseStoredElements(JSON.stringify([{ url: 'http://one.test/', ref: { objectId: 'a' } }]), pages)).toEqual(
      []
    );
  });
});
