/**
 * @fileoverview Page slots and the browser side of the prototype lifecycle, in their pure parts: the view
 * reducer's rail page and full view, what an agent's open and close are refused for, the hidden-tab steps,
 * and when a frame address is asked for again.
 *
 * Port: N/A.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { command, initialView, slotsPrune, type ViewState } from '../packages/canvas/src/commands.js';
import { FrameLoader, retryAfterPublish, silentFrameVerdict } from '../packages/canvas/src/frame-loader.js';
import type { ViewObject } from '../packages/canvas/src/model.js';
import { HIDDEN_GRACE_MS, presenceStep, watchPresence } from '../packages/canvas/src/presence.js';
import { prototypeRows } from '../packages/canvas/src/prototypes-view.js';
import { agentPageCloseRefusal, agentPageOpenRefusal } from '../packages/canvas/src/slots.js';
import { ViewSync, type ViewReport } from '../packages/canvas/src/view-sync.js';
import { ViewRegistry } from '../src/canvas/view-registry.js';
import { PublishedViewSchema } from '../src/canvas/view-schema.js';

const object = (id: string, type: string, url = 'https://example.com/'): ViewObject =>
  ({
    id,
    type,
    parentId: null,
    order: 0,
    position: { x: 0, y: 0 },
    size: { width: 100, height: 100 },
    rotation: 0,
    lock: null,
    revision: 1,
    content: { type, url, label: id },
  }) as unknown as ViewObject;
const objects = [object('page', 'embed'), object('other', 'embed'), object('card', 'link')];
const PROTOTYPE = 'https://prototype.invalid/demo/2/index.html';

describe('the rail page slot in the view reducer', () => {
  const docked = (state: ViewState = initialView()) => command(state, { kind: 'page', objectId: 'page' }, objects);

  it('docks one embed and puts the Page view on top of the rail', () => {
    const state = docked(command(initialView(), { kind: 'rail', view: 'keys' }, objects));
    expect(state.page).toBe('page');
    expect(state.rail).toEqual(['keys', 'page']);
    // A second embed replaces the first: the slot holds one page.
    const replaced = command(state, { kind: 'page', objectId: 'other' }, objects);
    expect(replaced.page).toBe('other');
    expect(replaced.rail).toEqual(['keys', 'page']);
  });
  it('docks nothing that is not an embed this view holds', () => {
    expect(command(initialView(), { kind: 'page', objectId: 'card' }, objects)).toEqual(initialView());
    expect(command(initialView(), { kind: 'page', objectId: 'gone' }, objects)).toEqual(initialView());
  });
  it('lets go of the page whenever the Page view leaves the rail', () => {
    expect(command(docked(), { kind: 'escape' }, objects)).toEqual(initialView());
    expect(command(docked(), { kind: 'rail-close', view: 'page' }, objects)).toEqual(initialView());
    expect(command(docked(), { kind: 'page', objectId: null }, objects)).toEqual(initialView());
    // Another view over it keeps the page; closing that view shows it again.
    const under = command(docked(), { kind: 'rail', view: 'keys' }, objects);
    expect(under.page).toBe('page');
    expect(command(under, { kind: 'escape' }, objects).rail).toEqual(['page']);
  });
  it('never opens an empty Page view', () => {
    expect(command(initialView(), { kind: 'rail', view: 'page' }, objects).rail).toEqual([]);
  });
  it('leaves the camera, the selection and the focus where they were', () => {
    const before = { ...initialView(), viewport: { x: 12, y: -7, zoom: 0.5 }, selected: ['card'], focusId: 'card' };
    const after = command(docked(before), { kind: 'escape' }, objects);
    expect(after).toEqual(before);
  });
});

describe('what the full view holds', () => {
  it('is a session or an embed, never both', () => {
    const session = command(
      initialView(),
      { kind: 'full-view', content: { kind: 'session', sessionId: 's1' } },
      objects
    );
    const embed = command(session, { kind: 'full-view', content: { kind: 'embed', objectId: 'page' } }, objects);
    expect(embed.fullView).toEqual({ kind: 'embed', objectId: 'page' });
    expect(command(embed, { kind: 'full-view', content: null }, objects).fullView).toBeNull();
  });
  it('holds no object that is not an embed', () => {
    const state = command(initialView(), { kind: 'full-view', content: { kind: 'embed', objectId: 'card' } }, objects);
    expect(state.fullView).toBeNull();
  });
  it('lets go of slots whose embed was deleted or turned back into a link', () => {
    let state = command(initialView(), { kind: 'page', objectId: 'page' }, objects);
    state = command(state, { kind: 'full-view', content: { kind: 'embed', objectId: 'other' } }, objects);
    expect(slotsPrune(state, objects)).toBe(state);
    const pruned = slotsPrune(state, [object('page', 'link'), object('card', 'link')]);
    expect(pruned).toMatchObject({ page: null, fullView: null, rail: [] });
    // A session's full view is not an embed's to lose.
    const session = { ...initialView(), fullView: { kind: 'session' as const, sessionId: 's1' } };
    expect(slotsPrune(session, [])).toBe(session);
  });
});

describe('what an agent is refused', () => {
  const view = { slot: 'rail' as const, shell: true, embed: true, touch: false, typing: false };

  it('opens a held embed on a laptop while nobody is typing', () => {
    expect(agentPageOpenRefusal(view)).toBeNull();
    expect(agentPageOpenRefusal({ ...view, slot: 'full' })).toBeNull();
  });
  it('never opens on a phone or touch view, which shows no live pages', () => {
    expect(agentPageOpenRefusal({ ...view, touch: true })).toMatch(/phone or touch/);
  });
  it('never opens what the view does not hold', () => {
    expect(agentPageOpenRefusal({ ...view, embed: false })).toMatch(/does not hold/);
  });
  it('has a full view only on a shell page, and a rail everywhere', () => {
    expect(agentPageOpenRefusal({ ...view, slot: 'full', shell: false })).toMatch(/no full view/);
    expect(agentPageOpenRefusal({ ...view, shell: false })).toBeNull();
  });
  it('never takes over while the person is typing', () => {
    expect(agentPageOpenRefusal({ ...view, typing: true })).toMatch(/typing/);
    expect(agentPageOpenRefusal({ ...view, slot: 'full', typing: true })).toMatch(/typing/);
  });
  it('closes a page only while the person is not using it', () => {
    expect(agentPageCloseRefusal(false)).toBeNull();
    expect(agentPageCloseRefusal(true)).toMatch(/using that page/);
  });
});

describe('a tab going to the background', () => {
  it('waits out a grace period before it suspends, and resumes at once', () => {
    expect(presenceStep('shown', 'hidden')).toEqual({ state: 'leaving', effect: 'start-grace' });
    expect(presenceStep('leaving', 'visible')).toEqual({ state: 'shown', effect: 'cancel-grace' });
    expect(presenceStep('leaving', 'grace-over')).toEqual({ state: 'away', effect: 'suspend' });
    expect(presenceStep('away', 'visible')).toEqual({ state: 'shown', effect: 'resume' });
  });
  it('ignores what does not change it', () => {
    expect(presenceStep('shown', 'visible')).toEqual({ state: 'shown', effect: null });
    expect(presenceStep('shown', 'grace-over')).toEqual({ state: 'shown', effect: null });
    expect(presenceStep('away', 'hidden')).toEqual({ state: 'away', effect: null });
    expect(presenceStep('leaving', 'hidden')).toEqual({ state: 'leaving', effect: null });
  });

  describe('driven by the document', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    function tab(visibilityState: DocumentVisibilityState = 'visible') {
      const doc = {
        visibilityState,
        listener: () => {},
        addEventListener(_: string, listener: () => void) {
          this.listener = listener;
        },
      };
      const calls: string[] = [];
      const presence = watchPresence(
        { suspend: () => calls.push('suspend'), resume: () => calls.push('resume') },
        doc as unknown as Document
      );
      const set = (state: DocumentVisibilityState) => {
        doc.visibilityState = state;
        doc.listener();
      };
      return { calls, presence, set };
    }

    it('does not suspend for a quick switch to another tab and back', () => {
      const t = tab();
      t.set('hidden');
      vi.advanceTimersByTime(HIDDEN_GRACE_MS - 1);
      t.set('visible');
      vi.advanceTimersByTime(HIDDEN_GRACE_MS * 2);
      expect(t.calls).toEqual([]);
      expect(t.presence()).toBe('shown');
    });
    it('suspends once after the grace period and resumes when shown', () => {
      const t = tab();
      t.set('hidden');
      vi.advanceTimersByTime(HIDDEN_GRACE_MS);
      expect(t.calls).toEqual(['suspend']);
      vi.advanceTimersByTime(HIDDEN_GRACE_MS * 3);
      t.set('visible');
      expect(t.calls).toEqual(['suspend', 'resume']);
    });
    it('treats a tab that loads in the background as hidden', () => {
      const t = tab('hidden');
      vi.advanceTimersByTime(HIDDEN_GRACE_MS);
      expect(t.calls).toEqual(['suspend']);
    });
  });
});

describe('asking for a frame address again', () => {
  it('retries once, for a prototype refused with 409', () => {
    expect(retryAfterPublish({ status: 409, prototype: true, attempt: 0 })).toBe(true);
    expect(retryAfterPublish({ status: 409, prototype: true, attempt: 1 })).toBe(false);
    expect(retryAfterPublish({ status: 409, prototype: false, attempt: 0 })).toBe(false);
    expect(retryAfterPublish({ status: 404, prototype: true, attempt: 0 })).toBe(false);
    expect(retryAfterPublish({ status: 200, prototype: true, attempt: 0 })).toBe(false);
  });
  it('asks once more for a silent prototype frame, then says unavailable', () => {
    expect(silentFrameVerdict(0)).toBe('ask-again');
    expect(silentFrameVerdict(1)).toBe('unavailable');
    expect(silentFrameVerdict(5)).toBe('unavailable');
  });

  describe('through the loader', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });
    const answer = (status: number, body: unknown) => ({ status, json: async () => body });
    const ok = (cap: string) =>
      answer(200, { success: true, data: { embedUrl: `/canvas-prototype/${cap}/index.html` } });
    function loader(answers: ReturnType<typeof answer>[]) {
      const asked: string[] = [];
      const published: number[] = [];
      vi.stubGlobal('fetch', async (url: string) => {
        asked.push(url);
        return answers.shift() ?? answer(500, {});
      });
      const made = new FrameLoader({
        url: (path) => path,
        workspace: 'ws',
        publishView: async () => void published.push(asked.length),
      });
      return { made, asked, published };
    }
    const frame = () => {
      const listeners: (() => void)[] = [];
      return {
        isConnected: true,
        addEventListener: (_: string, listener: () => void) => listeners.push(listener),
        removeEventListener: () => {},
        load: () => listeners.forEach((listener) => listener()),
      };
    };
    const asFrame = (f: ReturnType<typeof frame>) => f as unknown as HTMLIFrameElement;

    it('publishes the view and asks again when the first paint beat the first heartbeat', async () => {
      const l = loader([answer(409, { success: false }), ok('cap1')]);
      expect(await l.made.address('page', PROTOTYPE)).toBe('/canvas-prototype/cap1/index.html');
      expect(l.asked).toHaveLength(2);
      // The publish ran between the two requests.
      expect(l.published).toEqual([1]);
      // The address is held: showing the same page again asks nothing.
      expect(await l.made.address('page', PROTOTYPE)).toBe('/canvas-prototype/cap1/index.html');
      expect(l.asked).toHaveLength(2);
    });
    it('gives up after one retry', async () => {
      const l = loader([answer(409, { success: false }), answer(409, { success: false }), ok('late')]);
      expect(await l.made.address('page', PROTOTYPE)).toBeNull();
      expect(l.asked).toHaveLength(2);
    });
    it('does not retry a page that is not a prototype', async () => {
      const l = loader([answer(409, { success: false }), ok('never')]);
      expect(await l.made.address('page', 'https://example.com/')).toBeNull();
      expect(l.published).toEqual([]);
    });
    it('asks once for two callers at the same time', async () => {
      const l = loader([ok('cap1')]);
      const [a, b] = await Promise.all([l.made.address('page', PROTOTYPE), l.made.address('page', PROTOTYPE)]);
      expect(a).toBe(b);
      expect(l.asked).toHaveLength(1);
    });
    it('forgets a frame address when its prototype frame never reports the bridge', async () => {
      vi.useFakeTimers();
      const l = loader([ok('cap1'), ok('cap2'), ok('cap3')]);
      await l.made.address('page', PROTOTYPE);
      const verdicts: string[] = [];
      const first = frame();
      l.made.watch(asFrame(first), 'page', PROTOTYPE, (verdict) => verdicts.push(verdict));
      first.load();
      await vi.advanceTimersByTimeAsync(3000);
      expect(verdicts).toEqual(['ask-again']);
      expect(l.made.held('page', PROTOTYPE)).toBeNull();
      expect(await l.made.address('page', PROTOTYPE)).toBe('/canvas-prototype/cap2/index.html');
      // The second frame is silent too: the page is unavailable until the person reloads it.
      l.made.watch(asFrame(frame()), 'page', PROTOTYPE, (verdict) => verdicts.push(verdict));
      await vi.advanceTimersByTimeAsync(11_000);
      expect(verdicts).toEqual(['ask-again', 'unavailable']);
      expect(l.made.unavailable('page', PROTOTYPE)).toBe(true);
      l.made.reload('page');
      expect(l.made.unavailable('page', PROTOTYPE)).toBe(false);
    });
    it('keeps the address of a frame whose bridge spoke, and of one that was taken away', async () => {
      vi.useFakeTimers();
      const l = loader([ok('cap1')]);
      await l.made.address('page', PROTOTYPE);
      const verdicts: string[] = [];
      const spoke = frame();
      l.made.watch(asFrame(spoke), 'page', PROTOTYPE, (verdict) => verdicts.push(verdict));
      l.made.spoke(asFrame(spoke));
      const removed = frame();
      l.made.watch(asFrame(removed), 'page', PROTOTYPE, (verdict) => verdicts.push(verdict));
      l.made.release(asFrame(removed));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(verdicts).toEqual([]);
      expect(l.made.held('page', PROTOTYPE)).toBe('/canvas-prototype/cap1/index.html');
    });
    it('does not watch a proxied page, whose own policy may block the bridge', async () => {
      vi.useFakeTimers();
      const l = loader([]);
      const verdicts: string[] = [];
      l.made.watch(asFrame(frame()), 'page', 'https://example.com/', (verdict) => verdicts.push(verdict));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(verdicts).toEqual([]);
    });
    it('lets go of every address when the tab goes to the background', async () => {
      const l = loader([ok('cap1'), ok('cap2')]);
      await l.made.address('page', PROTOTYPE);
      l.made.forgetAll();
      expect(await l.made.address('page', PROTOTYPE)).toBe('/canvas-prototype/cap2/index.html');
    });
  });
});

describe('the view publisher while the tab is in the background', () => {
  const report = (): ViewReport => ({
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
  });
  function page() {
    const registry = new ViewRegistry(() => Date.now());
    const calls: string[] = [];
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal('fetch', async (url: string, init: { method: string; body?: string }) => {
      const [, workspace, viewId] = /canvas\/([^/]+)\/views\/([^/]+)$/.exec(url)!;
      calls.push(init.method);
      if (init.method === 'DELETE') registry.remove(workspace, viewId, undefined);
      else registry.publish(workspace, viewId, undefined, PublishedViewSchema.parse(JSON.parse(init.body!)));
      return { ok: true, status: 200 };
    });
    const sync = new ViewSync({ url: (path) => path, workspace: 'ws', read: report, apply: () => {} });
    return { sync, calls, listed: () => registry.list('ws', () => true).length };
  }
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('stops being an open view at once, and stays one no longer', async () => {
    const p = page();
    p.sync.notify();
    await vi.advanceTimersByTimeAsync(1000);
    expect(p.listed()).toBe(1);
    p.sync.pause();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.listed()).toBe(0);
    // No heartbeat and no change publishes while it is hidden.
    p.sync.notify();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(p.listed()).toBe(0);
    expect(p.calls).toEqual(['PUT', 'DELETE']);
    p.sync.stop();
  });
  it('is listed again by the time resume resolves, and beats again', async () => {
    const p = page();
    p.sync.notify();
    await vi.advanceTimersByTimeAsync(1000);
    p.sync.pause();
    await vi.advanceTimersByTimeAsync(5000);
    let resumed = false;
    void p.sync.resume().then(() => (resumed = true));
    await vi.advanceTimersByTimeAsync(1000);
    expect(resumed).toBe(true);
    expect(p.listed()).toBe(1);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(p.calls.filter((method) => method === 'PUT').length).toBeGreaterThanOrEqual(4);
    p.sync.stop();
  });
  it('answers a flush with a real publish even when nothing changed', async () => {
    const p = page();
    p.sync.notify();
    await vi.advanceTimersByTimeAsync(1000);
    let flushed = false;
    void p.sync.flush().then(() => (flushed = true));
    await vi.advanceTimersByTimeAsync(1000);
    expect(flushed).toBe(true);
    expect(p.calls).toEqual(['PUT', 'PUT']);
    p.sync.stop();
  });
});

describe('the outline rows for stored prototypes', () => {
  const data = {
    success: true,
    data: {
      prototypes: [
        { id: 'rail-view', name: 'Rail view', latest: 3, objects: [{ objectId: 'page', version: 2 }] },
        { id: 'alone', name: '', latest: 1, objects: [] },
        { id: 'elsewhere', name: 'Elsewhere', latest: 4, objects: [{ objectId: 'not-here', version: 4 }] },
      ],
    },
  };
  it('names each prototype with the version its embed shows, by name', () => {
    expect(prototypeRows(data, (id) => id === 'page')).toEqual([
      { id: 'alone', name: 'alone', version: 1, objectId: null },
      { id: 'elsewhere', name: 'Elsewhere', version: 4, objectId: null },
      { id: 'rail-view', name: 'Rail view', version: 2, objectId: 'page' },
    ]);
  });
  it('lists nothing for an answer it does not understand', () => {
    expect(prototypeRows({ success: false }, () => true)).toEqual([]);
    expect(prototypeRows(null, () => true)).toEqual([]);
  });
});
