/**
 * Canvas shell (PC13) part 3: the pure half of a session's full view. Frame or navigate by device, the page
 * address, which messages count, the one-use return ticket, and the view command an agent may issue.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  FULL_VIEW_ALLOW,
  TICKET_MAX_AGE_MS,
  agentOpenRefusal,
  fullViewMode,
  fullViewPath,
  fullViewSignal,
  makeTicket,
  parseTicket,
  sessionFromNotification,
  sessionFromSearch,
  takeTicket,
} from '../packages/canvas/src/full-view.js';
import { command, initialView } from '../packages/canvas/src/commands.js';
import { canvasStorageKeys } from '../packages/canvas/src/storage-keys.js';
import { PublishedViewSchema, ViewActionSchema } from '../src/canvas/view-schema.js';
import { ViewToolSchema } from '../src/canvas/commands.js';

const ticket = {
  workspaceId: 'ws_1',
  sessionId: 'sess-1',
  viewport: { x: 12, y: -40, zoom: 0.8 },
  selected: ['n1', 'n2'],
  focusId: 'n1',
  rail: ['reader', 'assistant'] as ('reader' | 'assistant')[],
  outlineOpen: true,
  root: null,
};

describe('full view: frame or navigate', () => {
  it('frames only with a hardware keyboard: a phone or any touch-first device navigates', () => {
    expect(fullViewMode({ phone: false, touch: false })).toBe('frame');
    expect(fullViewMode({ phone: true, touch: false })).toBe('navigate');
    expect(fullViewMode({ phone: false, touch: true })).toBe('navigate');
    expect(fullViewMode({ phone: true, touch: true })).toBe('navigate');
  });
  it('builds the session page address from the id and the workspace alone, encoded', () => {
    expect(fullViewPath('abc-1', 'ws_1')).toBe('/session/abc-1?from=canvas&ws=ws_1');
    expect(fullViewPath('a/b?c', 'w&x')).toBe('/session/a%2Fb%3Fc?from=canvas&ws=w%26x');
    expect(fullViewPath('abc-1', 'ws_1', false)).toBe('/session/abc-1?from=canvas&ws=ws_1');
  });
  it("marks an agent's open in the address, so the session page starts nothing by itself", () => {
    expect(fullViewPath('abc-1', 'ws_1', true)).toBe('/session/abc-1?from=canvas&ws=ws_1&passive=1');
  });
  it("refuses an agent's open with a plain reason, and only then", () => {
    const ok = { shell: true, state: 'idle', navigates: false, typing: false };
    expect(agentOpenRefusal(ok)).toBeNull();
    for (const state of ['needs', 'error', 'waiting', 'working']) expect(agentOpenRefusal({ ...ok, state })).toBeNull();
    expect(agentOpenRefusal({ ...ok, shell: false })).toMatch(/not a canvas shell page/);
    expect(agentOpenRefusal({ ...ok, state: undefined })).toMatch(/does not list that session/);
    expect(agentOpenRefusal({ ...ok, state: 'done' })).toMatch(/has ended/);
    expect(agentOpenRefusal({ ...ok, navigates: true })).toMatch(/phone or touch/);
    expect(agentOpenRefusal({ ...ok, typing: true })).toMatch(/typing on the canvas/);
    // Every reason fits the field the view publishes it in.
    for (const view of [
      { ...ok, shell: false },
      { ...ok, state: undefined },
      { ...ok, state: 'done' },
      { ...ok, navigates: true },
      { ...ok, typing: true },
    ])
      expect(agentOpenRefusal(view)!.length).toBeLessThanOrEqual(200);
  });
  it('lists only what the terminal page uses in the frame permissions', () => {
    expect(FULL_VIEW_ALLOW.split(';').map((s) => s.trim())).toEqual([
      'clipboard-read',
      'clipboard-write',
      'microphone',
    ]);
  });
});

describe('full view: which messages count', () => {
  const frame = {};
  const expected = { origin: 'https://codeman.test', source: frame };
  it('hears ready and close from the opened frame on this origin', () => {
    expect(fullViewSignal({ ...expected, data: { type: 'codeman:full-view-ready' } }, expected)).toBe('ready');
    expect(fullViewSignal({ ...expected, data: { type: 'codeman:full-view-close' } }, expected)).toBe('close');
  });
  it('ignores another origin, another window, no frame, and an unknown or malformed message', () => {
    const close = { type: 'codeman:full-view-close' };
    expect(fullViewSignal({ origin: 'https://evil.test', source: frame, data: close }, expected)).toBeNull();
    expect(fullViewSignal({ origin: expected.origin, source: {}, data: close }, expected)).toBeNull();
    expect(
      fullViewSignal({ origin: expected.origin, source: null, data: close }, { ...expected, source: null })
    ).toBeNull();
    for (const data of [{ type: 'codeman:full-view-open' }, { type: 7 }, 'codeman:full-view-close', null, undefined])
      expect(fullViewSignal({ ...expected, data }, expected)).toBeNull();
  });
});

describe('full view: a notification names a session', () => {
  it('reads a well-formed id from the address and from the service worker message, and nothing else', () => {
    expect(sessionFromSearch('?session=abc-1&x=1')).toBe('abc-1');
    expect(sessionFromSearch('?session=a/b')).toBeNull();
    expect(sessionFromSearch('')).toBeNull();
    expect(sessionFromNotification({ type: 'notification-click', sessionId: 'abc-1', action: null })).toBe('abc-1');
    expect(sessionFromNotification({ type: 'other', sessionId: 'abc-1' })).toBeNull();
    expect(sessionFromNotification({ type: 'notification-click', sessionId: '<x>' })).toBeNull();
    expect(sessionFromNotification({ type: 'notification-click' })).toBeNull();
    expect(sessionFromNotification('notification-click')).toBeNull();
  });
});

describe('full view: the return ticket', () => {
  const now = 1_800_000_000_000;
  it('round-trips what the phone restores', () => {
    expect(parseTicket(makeTicket(ticket, now), 'ws_1', now + 60_000)).toEqual({ ...ticket, at: now });
  });
  it('is refused for another workspace, at twelve hours, from the future, and when malformed', () => {
    const raw = makeTicket(ticket, now);
    expect(parseTicket(raw, 'ws_2', now + 1)).toBeNull();
    expect(parseTicket(raw, 'ws_1', now + TICKET_MAX_AGE_MS - 1)).not.toBeNull();
    expect(parseTicket(raw, 'ws_1', now + TICKET_MAX_AGE_MS)).toBeNull();
    expect(parseTicket(raw, 'ws_1', now - 1)).toBeNull();
    expect(parseTicket(null, 'ws_1', now)).toBeNull();
    expect(parseTicket('{', 'ws_1', now)).toBeNull();
    expect(parseTicket('[]', 'ws_1', now)).toBeNull();
    expect(parseTicket(makeTicket({ ...ticket, viewport: { x: 0, y: 0, zoom: 9 } }, now), 'ws_1', now)).toBeNull();
    expect(parseTicket(makeTicket({ ...ticket, sessionId: 'a b' }, now), 'ws_1', now)).toBeNull();
  });
  it('drops ids and rail views it does not recognise and keeps the rest', () => {
    const raw = JSON.stringify({
      ...ticket,
      selected: ['n1', 7, '<img>'],
      focusId: '<x>',
      rail: ['reader', 'terminal'],
      root: 5,
      at: now,
    });
    expect(parseTicket(raw, 'ws_1', now)).toMatchObject({
      selected: ['n1'],
      focusId: null,
      rail: ['reader'],
      root: null,
    });
  });
  it('is read once: taking it removes it, whatever it held', () => {
    const key = canvasStorageKeys('@single', 'ws_1').returnTicket;
    const held = new Map([[key, makeTicket(ticket, now)]]);
    const storage = {
      getItem: (k: string) => held.get(k) ?? null,
      removeItem: (k: string) => void held.delete(k),
    };
    expect(takeTicket(storage, key, 'ws_1', now + 5)?.sessionId).toBe('sess-1');
    expect(held.size).toBe(0);
    expect(takeTicket(storage, key, 'ws_1', now + 5)).toBeNull();
    held.set(key, 'not json');
    expect(takeTicket(storage, key, 'ws_1', now)).toBeNull();
    expect(held.size).toBe(0);
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {},
    };
    expect(takeTicket(broken, key, 'ws_1', now)).toBeNull();
  });
  it('is keyed per viewer and workspace', () => {
    expect(canvasStorageKeys('ann', 'ws_1').returnTicket).not.toBe(canvasStorageKeys('bob', 'ws_1').returnTicket);
    expect(canvasStorageKeys('ann', 'ws_1').returnTicket).not.toBe(canvasStorageKeys('ann', 'ws_2').returnTicket);
  });
});

describe('full view: the view command', () => {
  it('opens and closes in the reducer and touches nothing else', () => {
    const start = initialView();
    const open = command(start, { kind: 'full-view', sessionId: 's1' }, []);
    expect(open).toEqual({ ...start, fullView: 's1' });
    expect(command(open, { kind: 'full-view', sessionId: null }, [])).toEqual(start);
  });
  it('is an action an agent may issue for a named view, with a well-formed id or null', () => {
    expect(ViewActionSchema.safeParse({ action: 'full-view', sessionId: 's-1' }).success).toBe(true);
    expect(ViewActionSchema.safeParse({ action: 'full-view', sessionId: null }).success).toBe(true);
    expect(ViewActionSchema.safeParse({ action: 'full-view', sessionId: '../x' }).success).toBe(false);
    expect(ViewActionSchema.safeParse({ action: 'full-view', sessionId: 's', url: 'https://x' }).success).toBe(false);
    const viewId = '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
    expect(ViewToolSchema.safeParse({ action: 'full-view', viewId, sessionId: 's-1' }).success).toBe(true);
    expect(ViewToolSchema.safeParse({ action: 'full-view', sessionId: 's-1' }).success).toBe(false);
  });
  it('is published as an optional field, so a page of the previous release still validates', () => {
    const base = {
      viewport: { x: 0, y: 0, zoom: 1 },
      selected: [],
      focusId: null,
      rail: [],
      context: [],
      conversationId: null,
      root: null,
      letters: true,
      draftBytes: 0,
      phone: false,
      appliedCommands: [],
    };
    expect(PublishedViewSchema.safeParse(base).success).toBe(true);
    expect(PublishedViewSchema.safeParse({ ...base, fullView: 's1' }).success).toBe(true);
    expect(PublishedViewSchema.safeParse({ ...base, fullView: null }).success).toBe(true);
    expect(PublishedViewSchema.safeParse({ ...base, fullView: 'a b' }).success).toBe(false);
    const commandId = '11111111-1111-4111-8111-111111111111';
    expect(
      PublishedViewSchema.safeParse({ ...base, refused: { commandId, reason: 'That session has ended.' } }).success
    ).toBe(true);
    expect(PublishedViewSchema.safeParse({ ...base, refused: { commandId, reason: '' } }).success).toBe(false);
    expect(PublishedViewSchema.safeParse({ ...base, refused: { commandId, reason: 'x'.repeat(201) } }).success).toBe(
      false
    );
    expect(PublishedViewSchema.safeParse({ ...base, refused: { commandId: 'c1', reason: 'no' } }).success).toBe(false);
  });
});

describe('full view: what the sources promise', () => {
  const canvas = readFileSync('packages/canvas/src/full-view.ts', 'utf8');
  const entry = readFileSync('packages/canvas/src/entry.ts', 'utf8');
  const app = readFileSync('src/web/public/app.js', 'utf8');
  it('never sandboxes the frame, never writes to a pane and holds no terminal code', () => {
    expect(canvas).not.toMatch(/\.sandbox\b|setAttribute\('sandbox'/);
    for (const source of [canvas, entry]) {
      expect(source).not.toMatch(/\/input\b|\/ws\/sessions|new WebSocket|xterm/);
      expect(source).not.toMatch(/contentWindow\??\.postMessage|contentDocument/);
    }
  });
  it('posts from the session page only to its own origin, and only on a page the canvas opened', () => {
    const posts = [...app.matchAll(/parent\.postMessage\(([^;]*);/g)].map((m) => m[1]);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('location.origin)');
    expect(app).toMatch(
      /_postToCanvas\(type\) \{\s*const parent = this\._canvasReturn \? this\._canvasParent\(\) : null;/
    );
  });
  it('lists the back chord only on a page the canvas opened, with Ctrl+Shift+Backspace as the default', () => {
    expect(app).toMatch(/id: 'back-to-canvas',[\s\S]{0,200}shellOnly: true,[\s\S]{0,120}key: 'Backspace'/);
    expect(app).toContain('this._canvasReturn ? DEFAULT_SHORTCUTS : DEFAULT_SHORTCUTS.filter((s) => !s.shellOnly)');
    expect(readFileSync('src/web/public/terminal-ui.js', 'utf8')).toContain(
      'if (this.shouldGoBackToCanvasFromShortcut?.(ev)) return false;'
    );
  });
  it('adds no header markup to the dashboard document', () => {
    const html = readFileSync('src/web/public/index.html', 'utf8');
    expect(html).not.toContain('soloCanvasBtn');
    expect(html).not.toContain('btn-solo-canvas');
  });
});
