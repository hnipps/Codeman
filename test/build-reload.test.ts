/**
 * Reload on a new build: the page remembers the build id of its first SSE init and
 * reloads itself when a later init (an SSE reconnect after a deploy) carries another one.
 *
 * Real code: constants.js (`CodemanBuildWatch`, the pure decision) and app.js
 * (`_checkBuildId`, `handleInit`) in a `vm` context with stubbed browser globals.
 * Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Decide = (input: {
  baseline?: string | null;
  incoming?: unknown;
  lastReloadAt?: number | null;
  now?: number;
}) => 'baseline' | 'reload' | 'ignore';

const storage = new Map<string, string>();
const reload = vi.fn();
const windowStub: Record<string, unknown> = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
const read = (f: string) => readFileSync(resolve(import.meta.dirname, `../src/web/public/${f}`), 'utf8');
const context = vm.createContext({
  console: { ...console, log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  performance: { now: () => 0 },
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  HTMLCanvasElement: class {},
  URLSearchParams,
  navigator: { onLine: true },
  location: { protocol: 'http:', host: 'codeman.test', pathname: '/', search: '', hash: '', reload },
  document: {
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: { dataset: {} },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  sessionStorage: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
  },
  window: windowStub,
  MobileDetection: { isTouchDevice: () => false, isHandheldDevice: () => false, getDeviceType: () => 'desktop' },
});
vm.runInContext(`${read('constants.js')}\n${read('app.js')}\nglobalThis.__CodemanApp = CodemanApp;`, context);
const CodemanApp = (context as unknown as { __CodemanApp: { prototype: object } }).__CodemanApp;
const { decide, MIN_GAP_MS } = windowStub.CodemanBuildWatch as { decide: Decide; MIN_GAP_MS: number };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type App = Record<string, any>;

function loadPage(): App {
  const app = Object.create(CodemanApp.prototype) as App;
  app._buildId = null;
  app._initGeneration = 0;
  return app;
}

beforeEach(() => {
  storage.clear();
  reload.mockClear();
});

describe('CodemanBuildWatch.decide', () => {
  const NOW = 1_000_000;

  it('takes the first id as the baseline', () => {
    expect(decide({ baseline: null, incoming: 'a', now: NOW })).toBe('baseline');
  });

  it('ignores an init with the same id', () => {
    expect(decide({ baseline: 'a', incoming: 'a', now: NOW })).toBe('ignore');
  });

  it('reloads on a different id', () => {
    expect(decide({ baseline: 'a', incoming: 'b', now: NOW })).toBe('reload');
  });

  it.each([undefined, null, '', 42, {}])('never reloads for an init without a usable id (%j)', (incoming) => {
    expect(decide({ baseline: 'a', incoming, now: NOW })).toBe('ignore');
    expect(decide({ baseline: null, incoming, now: NOW })).toBe('ignore');
  });

  it('holds off while the previous reload is recent, then allows one again', () => {
    expect(decide({ baseline: 'a', incoming: 'b', lastReloadAt: NOW - MIN_GAP_MS + 1, now: NOW })).toBe('ignore');
    expect(decide({ baseline: 'a', incoming: 'b', lastReloadAt: NOW - MIN_GAP_MS, now: NOW })).toBe('reload');
  });
});

describe('a page across a deploy', () => {
  it('reloads once when a reconnect reports a new build, and the reloaded page settles on it', () => {
    const before = loadPage();
    expect(before._checkBuildId('build-1')).toBe(false);
    expect(before._checkBuildId('build-1')).toBe(false);
    expect(reload).not.toHaveBeenCalled();

    expect(before._checkBuildId('build-2')).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    const after = loadPage();
    expect(after._checkBuildId('build-2')).toBe(false);
    expect(after._checkBuildId('build-2')).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('stops after one reload when the proxy keeps answering from alternating builds', () => {
    const builds = ['build-2', 'build-1', 'build-2', 'build-1'];
    let page = loadPage();
    page._checkBuildId('build-1');
    for (const incoming of builds) {
      if (page._checkBuildId(incoming)) page = loadPage();
    }
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('still protects the page when sessionStorage is unavailable', () => {
    const throwing = vm.createContext({ ...context });
    (throwing as Record<string, unknown>).sessionStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    vm.runInContext(`${read('constants.js')}\n${read('app.js')}\nglobalThis.__App2 = CodemanApp;`, throwing);
    const App2 = (throwing as unknown as { __App2: { prototype: object } }).__App2;
    const page = Object.create(App2.prototype) as App;
    page._buildId = null;
    expect(page._checkBuildId('build-1')).toBe(false);
    expect(page._checkBuildId('build-2')).toBe(true);
  });

  it('handleInit does nothing else once it has decided to reload', () => {
    const page = loadPage();
    page._buildId = 'build-1';
    page.handleInit({ buildId: 'build-2', sessions: [] });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(page._initGeneration).toBe(0);
  });
});
