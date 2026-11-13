/**
 * @fileoverview The canvas view publisher's pacing against the real server registry: one page never earns a
 * 429 from its own publishes, however long a request waits before the server handles it.
 *
 * Port: N/A.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ViewRegistry } from '../src/canvas/view-registry.js';
import { MIN_PUBLISH_GAP_MS, PublishedViewSchema } from '../src/canvas/view-schema.js';
import { ViewSync, type ViewReport } from '../packages/canvas/src/view-sync.js';

const report = (selected: string[]): ViewReport => ({
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
});

/** A page publishing to the real registry. Each request waits `waits.shift()` ms before the server handles it. */
function page(waits: number[]) {
  const registry = new ViewRegistry(() => Date.now());
  const handled: { at: number; status: number }[] = [];
  let selected: string[] = [];
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => undefined });
  vi.stubGlobal('fetch', async (url: string, init: { body: string; signal: AbortSignal }) => {
    await new Promise((done, fail) => {
      setTimeout(done, waits.shift() ?? 0);
      init.signal.addEventListener('abort', () => fail(new Error('aborted')));
    });
    const [, workspace, viewId] = /canvas\/([^/]+)\/views\/([^/]+)$/.exec(url)!;
    const result = registry.publish(workspace, viewId, undefined, PublishedViewSchema.parse(JSON.parse(init.body)));
    const status = result.ok ? 200 : 429;
    handled.push({ at: Date.now(), status });
    return { ok: result.ok, status };
  });
  const sync = new ViewSync({ url: (path) => path, workspace: 'ws', read: () => report(selected), apply: () => {} });
  const change = (id: string) => {
    selected = [id];
    sync.notify();
  };
  return { sync, handled, change };
}

describe('canvas view publishing', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('is never rate limited when one publish waits longer than the next', async () => {
    const p = page([220, 0, 0]);
    p.change('row');
    await vi.advanceTimersByTimeAsync(320);
    p.change('edit');
    await vi.advanceTimersByTimeAsync(600);
    p.change('history');
    await vi.advanceTimersByTimeAsync(2000);
    p.sync.stop();
    expect(p.handled.map((h) => h.status)).toEqual([200, 200, 200]);
    for (let i = 1; i < p.handled.length; i++)
      expect(p.handled[i].at - p.handled[i - 1].at).toBeGreaterThanOrEqual(MIN_PUBLISH_GAP_MS);
  });

  it('publishes the latest view once after a burst of changes during a slow publish', async () => {
    const p = page([500, 0]);
    p.change('a');
    await vi.advanceTimersByTimeAsync(350);
    for (const id of ['b', 'c', 'd']) {
      p.change(id);
      await vi.advanceTimersByTimeAsync(40);
    }
    await vi.advanceTimersByTimeAsync(2000);
    p.sync.stop();
    expect(p.handled.map((h) => h.status)).toEqual([200, 200]);
  });

  it('publishes again after a publish that never answered', async () => {
    const p = page([60_000, 0]);
    p.change('a');
    await vi.advanceTimersByTimeAsync(400);
    p.change('b');
    await vi.advanceTimersByTimeAsync(15_000);
    p.sync.stop();
    expect(p.handled).toHaveLength(1);
    expect(p.handled[0].status).toBe(200);
    expect(p.handled[0].at).toBeLessThan(15_000);
  });
});
