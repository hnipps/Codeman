import { describe, expect, it } from 'vitest';
import {
  COMMAND_BURST,
  COMMANDS_PER_SECOND,
  MAX_REMEMBERED_REQUESTS,
  MAX_VIEWS_PER_WORKSPACE,
  ViewRegistry,
  VIEW_TTL_MS,
} from '../src/canvas/view-registry.js';
import {
  MIN_PUBLISH_GAP_MS,
  PublishedViewSchema,
  ViewActionSchema,
  ViewCommandEventSchema,
} from '../src/canvas/view-schema.js';
import { toolSchemas, QuerySchema } from '../src/canvas/commands.js';

const state = (selected: string[] = []) =>
  PublishedViewSchema.parse({
    viewport: { x: 0, y: 0, zoom: 1 },
    selected,
    focusId: null,
    rail: [],
    context: [],
    conversationId: null,
    root: null,
    letters: true,
    draftBytes: 0,
    phone: false,
    appliedCommands: [],
  });
const view = '11111111-1111-4111-8111-111111111111';
const anyone = () => true;
function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}
describe('view registry', () => {
  it('publishes and reads a view, and lists it by workspace', () => {
    const c = clock();
    const r = new ViewRegistry(c.now);
    expect(r.publish('ws', view, undefined, state(['a']))).toEqual({ ok: true });
    expect(r.read('ws', view, anyone)?.state.selected).toEqual(['a']);
    expect(r.list('ws', anyone)).toHaveLength(1);
    expect(r.list('other', anyone)).toHaveLength(0);
    expect(r.read('other', view, anyone)).toBeNull();
  });
  it('expires a view that stops publishing', () => {
    const c = clock();
    const r = new ViewRegistry(c.now);
    r.publish('ws', view, undefined, state());
    c.advance(VIEW_TTL_MS - 1);
    expect(r.read('ws', view, anyone)).not.toBeNull();
    c.advance(2);
    expect(r.read('ws', view, anyone)).toBeNull();
    expect(r.command('ws', view, anyone, { action: 'clear-selection' })).toEqual({ ok: false, code: 'VIEW_GONE' });
  });
  it('limits commands per view to a burst that refills, and never spends a token on a retry', () => {
    const c = clock();
    const r = new ViewRegistry(c.now);
    r.publish('ws', view, undefined, state());
    const act = { action: 'clear-selection' } as const;
    for (let i = 0; i < COMMAND_BURST; i++) expect(r.command('ws', view, anyone, act).ok).toBe(true);
    expect(r.command('ws', view, anyone, act)).toEqual({ ok: false, code: 'RATE_LIMITED' });
    c.advance(1000 / COMMANDS_PER_SECOND);
    const id = '22222222-2222-4222-8222-222222222222';
    const first = r.command('ws', view, anyone, act, id);
    expect(first.ok).toBe(true);
    // The bucket is empty again, but the same request id still answers its first result.
    expect(r.command('ws', view, anyone, act)).toEqual({ ok: false, code: 'RATE_LIMITED' });
    expect(r.command('ws', view, anyone, act, id)).toMatchObject({ ok: true, duplicate: true });
  });
  it('remembers a bounded number of request ids', () => {
    const c = clock();
    const r = new ViewRegistry(c.now);
    r.publish('ws', view, undefined, state());
    const act = { action: 'clear-selection' } as const;
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    for (let n = 0; n <= MAX_REMEMBERED_REQUESTS; n++) {
      c.advance(1000);
      expect(r.command('ws', view, anyone, act, uuid(n)).ok).toBe(true);
      if (n % 30 === 0) r.publish('ws', view, undefined, state());
    }
    expect((r as unknown as { requests: Map<string, unknown> }).requests.size).toBeLessThanOrEqual(
      MAX_REMEMBERED_REQUESTS
    );
  });
  it('scopes views to their owner', () => {
    const r = new ViewRegistry();
    r.publish('ws', view, 'alice', state());
    const bob = (owner: string | undefined) => owner === 'bob';
    expect(r.read('ws', view, bob)).toBeNull();
    expect(r.list('ws', bob)).toEqual([]);
    expect(r.command('ws', view, bob, { action: 'clear-selection' })).toEqual({ ok: false, code: 'VIEW_GONE' });
    expect(r.publish('ws', view, 'bob', state())).toEqual({ ok: false, code: 'FORBIDDEN' });
  });
  it('rate-limits one view to a publish per gap and caps views per workspace', () => {
    const c = clock();
    const r = new ViewRegistry(c.now);
    expect(r.publish('ws', view, undefined, state()).ok).toBe(true);
    c.advance(MIN_PUBLISH_GAP_MS - 1);
    expect(r.publish('ws', view, undefined, state())).toEqual({ ok: false, code: 'RATE_LIMITED' });
    c.advance(1);
    expect(r.publish('ws', view, undefined, state()).ok).toBe(true);
    for (let i = 0; i < MAX_VIEWS_PER_WORKSPACE; i++)
      r.publish('ws', `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, undefined, state());
    expect(r.publish('ws', '22222222-2222-4222-8222-222222222222', undefined, state())).toEqual({
      ok: false,
      code: 'TOO_MANY_VIEWS',
    });
  });
  it('dedupes a retried requestId and refuses its reuse for another command', () => {
    const r = new ViewRegistry();
    r.publish('ws', view, undefined, state());
    const id = '33333333-3333-4333-8333-333333333333';
    const first = r.command('ws', view, anyone, { action: 'select', targetIds: ['a'] }, id);
    const again = r.command('ws', view, anyone, { action: 'select', targetIds: ['a'] }, id);
    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(again).toMatchObject({ ok: true, duplicate: true });
    expect(again.ok && first.ok && again.commandId === first.commandId).toBe(true);
    expect(r.command('ws', view, anyone, { action: 'select', targetIds: ['b'] }, id)).toEqual({
      ok: false,
      code: 'REQUEST_REUSED',
    });
  });
});
describe('view schemas', () => {
  it('rejects unknown fields and out-of-range cameras', () => {
    expect(PublishedViewSchema.safeParse({ ...state(), extra: 1 }).success).toBe(false);
    expect(ViewActionSchema.safeParse({ action: 'set-viewport', viewport: { x: 0, y: 0, zoom: 9 } }).success).toBe(
      false
    );
    expect(ViewActionSchema.safeParse({ action: 'rail', view: 'assistant' })).toMatchObject({
      success: true,
      data: { open: true },
    });
    expect(
      ViewCommandEventSchema.safeParse({
        workspaceId: 'w',
        viewId: view,
        commandId: view,
        command: { action: 'clear-selection' },
      }).success
    ).toBe(true);
  });
  it('carries the pending elements of a view, bounded, and keeps a page that reports none valid', () => {
    const el = {
      objectId: 'page',
      selector: '#start',
      tag: 'button',
      rect: { x: 0, y: 0, width: 10, height: 10 },
    };
    expect(PublishedViewSchema.safeParse(state()).success).toBe(true);
    const parsed = PublishedViewSchema.safeParse({ ...state(), contextElements: [el] });
    expect(parsed.success && parsed.data.contextElements?.[0]).toMatchObject({
      selector: '#start',
      text: '',
      attrs: {},
    });
    expect(PublishedViewSchema.safeParse({ ...state(), contextElements: Array(51).fill(el) }).success).toBe(false);
    expect(PublishedViewSchema.safeParse({ ...state(), contextElements: [{ ...el, html: '<b>' }] }).success).toBe(
      false
    );
    // No view command changes it: the pending elements are a person's alone.
    expect(ViewActionSchema.safeParse({ action: 'context-add', targetIds: ['a'], elements: [el] }).success).toBe(false);
    const registry = new ViewRegistry();
    registry.publish('w', view, undefined, PublishedViewSchema.parse({ ...state(), contextElements: [el] }));
    expect(registry.read('w', view, anyone)?.state.contextElements).toHaveLength(1);
  });
  it('exposes strict canvas_view and canvas_context tool schemas', () => {
    expect(toolSchemas.canvas_view.safeParse({ action: 'list' }).success).toBe(true);
    expect(toolSchemas.canvas_view.safeParse({ action: 'select', viewId: view, targetIds: ['a'] }).success).toBe(true);
    expect(
      toolSchemas.canvas_view.safeParse({ action: 'select', viewId: view, targetIds: ['a'], workspaceId: 'x' }).success
    ).toBe(false);
    expect(toolSchemas.canvas_view.safeParse({ action: 'context-add', viewId: view, targetIds: ['a'] }).success).toBe(
      false
    );
    expect(
      toolSchemas.canvas_context.safeParse({ action: 'context-add', viewId: view, targetIds: ['a'] }).success
    ).toBe(false);
    expect(toolSchemas.canvas_context.safeParse({ action: 'add', viewId: view, targetIds: ['a'] }).success).toBe(true);
    expect(toolSchemas.canvas_context.safeParse({ action: 'read', viewId: view }).success).toBe(true);
    expect(
      QuerySchema.safeParse({
        shape: 'polygon',
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: 1 },
        ],
        semantics: 'center',
      }).success
    ).toBe(true);
  });
});
