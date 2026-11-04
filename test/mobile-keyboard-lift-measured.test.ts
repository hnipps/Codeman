// Port: none (pure logic in a vm context — no browser, no server).
//
// The phone toolbar, keyboard accessory bar and docked prompt box are
// `position: fixed; bottom: …` and are lifted above the on-screen keyboard by
// translateY(layout-viewport bottom − visual-viewport bottom). The layout bottom
// used to be read off `window.innerHeight`, which assumes innerHeight keeps the
// keyboard-free height. On an iPhone (2026-11-04) it shrank with the keyboard,
// the lift came out 0 and all three bars sat behind the keyboard, leaving an
// empty band above it. The layout bottom is now MEASURED with an invisible
// fixed probe; innerHeight is only the fallback.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(resolve(import.meta.dirname, '../src/web/public/mobile-handlers.js'), 'utf8');

function loadHandler(opts: { innerHeight: number; visualHeight: number; probeTop: number | null }) {
  const el = () => ({ style: { transform: '', bottom: '', paddingBottom: '' } as Record<string, string> });
  const toolbar = el();
  const accessoryBar = el();
  const dock = el();
  const main = el();
  const appended: unknown[] = [];
  const document: Record<string, unknown> = {
    body: {
      classList: { add: () => {}, remove: () => {}, contains: () => false },
      appendChild: (node: { isConnected: boolean }) => {
        node.isConnected = true;
        appended.push(node);
      },
    },
    addEventListener: () => {},
    getElementById: () => null,
    querySelector: (sel: string) =>
      ({
        '.toolbar': toolbar,
        '.keyboard-accessory-bar': accessoryBar,
        '#composerDock.composer-dock-visible': dock,
        '.main': main,
      })[sel] ?? null,
  };
  if (opts.probeTop !== null) {
    document.createElement = () => ({
      isConnected: false,
      style: {} as Record<string, string>,
      setAttribute: () => {},
      getBoundingClientRect: () => ({ top: opts.probeTop }),
    });
  }
  const context = vm.createContext({
    console,
    navigator: { userAgent: 'Mozilla/5.0 (iPhone) Mobile', maxTouchPoints: 5 },
    window: {
      innerWidth: 390,
      innerHeight: opts.innerHeight,
      visualViewport: { height: opts.visualHeight, offsetTop: 0 },
      addEventListener: () => {},
      matchMedia: () => ({ matches: true }),
      scrollTo: () => {},
    },
    document,
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
  vm.runInContext(`${SOURCE}\nglobalThis.__KH = KeyboardHandler;`, context, { filename: 'mobile-handlers.js' });
  const handler = (context as { __KH: any }).__KH;
  handler.keyboardVisible = true;
  handler.initialViewportHeight = 844;
  return { handler, toolbar, accessoryBar, dock, main, appended };
}

describe('keyboard lift measures the layout viewport', () => {
  it('lifts every bar above the keyboard when innerHeight shrank with it (the iPhone case)', () => {
    // Keyboard up: visual viewport 500px, innerHeight ALSO 500px, but fixed
    // elements still anchor to the 844px layout bottom the probe reports.
    const { handler, toolbar, accessoryBar, dock, main } = loadHandler({
      innerHeight: 500,
      visualHeight: 500,
      probeTop: 844,
    });
    handler.updateLayoutForKeyboard();
    expect(toolbar.style.transform).toBe('translateY(-344px)');
    expect(accessoryBar.style.transform).toBe('translateY(-344px)');
    expect(dock.style.transform).toBe('translateY(-344px)');
    // Toolbar 40 + accessory bar 44 + one-line prompt box 48.
    expect(main.style.paddingBottom).toBe('132px');
  });

  it('creates the probe once and reuses it', () => {
    const { handler, appended } = loadHandler({ innerHeight: 500, visualHeight: 500, probeTop: 844 });
    handler.updateLayoutForKeyboard();
    handler.updateLayoutForKeyboard();
    expect(appended).toHaveLength(1);
  });

  it('falls back to innerHeight when the probe cannot be measured', () => {
    const { handler, toolbar } = loadHandler({ innerHeight: 844, visualHeight: 500, probeTop: null });
    handler.updateLayoutForKeyboard();
    expect(toolbar.style.transform).toBe('translateY(-344px)');
  });

  it('falls back to innerHeight when the probe reports nothing usable', () => {
    const { handler, toolbar } = loadHandler({ innerHeight: 844, visualHeight: 500, probeTop: 0 });
    handler.updateLayoutForKeyboard();
    expect(toolbar.style.transform).toBe('translateY(-344px)');
  });
});
