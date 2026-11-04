/**
 * @fileoverview CI-visible coverage for the docked prompt box (#composerDock).
 *
 * The dock is a permanent native textarea under the terminal on touch devices,
 * so iOS autocorrect and text selection work while composing a prompt. These
 * tests drive the real keyboard-accessory.js module in JSDOM: when it shows,
 * per-session drafts shared with the Compose dialog, delivery (bracketed paste
 * then a delayed Enter), and that accessory keys leave focus in the dock.
 * The Playwright mobile suite is excluded from CI, hence this file.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const accessorySource = readFileSync(resolve('src/web/public/keyboard-accessory.js'), 'utf8');
const indexHtml = readFileSync(resolve('src/web/public/index.html'), 'utf8');
const dockMarkup = indexHtml.match(/<div id="composerDock"[\s\S]*?<\/button>\s*<\/div>/)?.[0] ?? '';

type Timer = { callback: () => void; delay: number };

function loadDock(options: { touch?: boolean; settings?: Record<string, unknown> } = {}) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${dockMarkup}</body></html>`, { url: 'https://localhost/' });
  const window = dom.window;
  const timers: Timer[] = [];
  const localEcho = {
    pendingText: '',
    clear: vi.fn(() => {
      localEcho.pendingText = '';
    }),
    suppressBufferDetection: vi.fn(),
  };
  const app = {
    activeSessionId: 'session-1' as string | null,
    sessions: new Map<string, { mode: string }>([
      ['session-1', { mode: 'claude' }],
      ['session-2', { mode: 'codex' }],
      ['shell-1', { mode: 'shell' }],
    ]),
    terminal: { focus: vi.fn(), paste: vi.fn(), modes: { bracketedPasteMode: true } },
    _localEchoEnabled: true,
    _localEchoOverlay: localEcho,
    _flushedOffsets: new Map<string, number>(),
    _flushedTexts: new Map<string, string>(),
    _echoPassthroughSessions: new Set<string>(),
    _predictiveEcho: { clearPredictions: vi.fn() },
    _sendInputAsync: vi.fn(),
    showToast: vi.fn(),
    loadAppSettingsFromStorage: () => options.settings ?? {},
    getDefaultSettings: () => ({}),
  };
  const keyboardHandler = { updateLayoutForKeyboard: vi.fn() };
  const schedule = (callback: () => void, delay = 0) => {
    timers.push({ callback, delay });
    return timers.length;
  };
  const factory = new Function(
    'window',
    'document',
    'Event',
    'app',
    'MobileDetection',
    'KeyboardHandler',
    'setTimeout',
    'clearTimeout',
    'requestAnimationFrame',
    `${accessorySource}\nreturn KeyboardAccessoryBar;`
  );
  const bar = factory(
    window,
    window.document,
    window.Event,
    app,
    { isTouchDevice: () => options.touch ?? true },
    keyboardHandler,
    schedule,
    vi.fn(),
    (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }
  );
  bar.initDock();
  const document = window.document;
  const dock = document.getElementById('composerDock') as HTMLElement;
  const textarea = dock.querySelector('.composer-dock-textarea') as HTMLTextAreaElement;
  const send = dock.querySelector('.composer-dock-send') as HTMLButtonElement;
  const type = (text: string) => {
    textarea.value = text;
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  return {
    app,
    bar,
    document,
    dock,
    textarea,
    send,
    type,
    timers,
    localEcho,
    keyboardHandler,
    runTimers() {
      for (const timer of timers.splice(0)) timer.callback();
    },
  };
}

describe('docked prompt box', () => {
  it('ships a native textarea with autocorrect, spellcheck and sentence capitalization', () => {
    expect(dockMarkup).not.toBe('');
    const { textarea } = loadDock();
    expect(textarea.getAttribute('autocorrect')).toBe('on');
    expect(textarea.getAttribute('spellcheck')).toBe('true');
    expect(textarea.getAttribute('autocapitalize')).toBe('sentences');
  });

  it('shows for an agent session on a touch device and hides for a shell', () => {
    const { app, bar, dock, document, keyboardHandler } = loadDock();
    bar.syncDock();
    expect(dock.classList.contains('composer-dock-visible')).toBe(true);
    expect(document.body.classList.contains('composer-dock-visible')).toBe(true);
    expect(keyboardHandler.updateLayoutForKeyboard).toHaveBeenCalledTimes(1);

    app.activeSessionId = 'shell-1';
    bar.syncDock();
    expect(dock.classList.contains('composer-dock-visible')).toBe(false);
    expect(document.body.classList.contains('composer-dock-visible')).toBe(false);
  });

  it('stays hidden on the home screen, on non-touch devices, when disabled, and while CJK input shows', () => {
    const home = loadDock();
    home.app.activeSessionId = null;
    home.bar.syncDock();
    expect(home.dock.classList.contains('composer-dock-visible')).toBe(false);

    const desktop = loadDock({ touch: false });
    desktop.bar.syncDock();
    expect(desktop.dock.classList.contains('composer-dock-visible')).toBe(false);

    const off = loadDock({ settings: { composerDockEnabled: false } });
    off.bar.syncDock();
    expect(off.dock.classList.contains('composer-dock-visible')).toBe(false);

    const cjk = loadDock();
    cjk.document.body.classList.add('cjk-input-visible');
    cjk.bar.syncDock();
    expect(cjk.dock.classList.contains('composer-dock-visible')).toBe(false);
  });

  it('enables Send only for non-blank text and keeps Return as a newline', () => {
    const { bar, send, type, textarea, app, document } = loadDock();
    bar.syncDock();
    expect(send.disabled).toBe(true);
    type('   \n ');
    expect(send.disabled).toBe(true);
    type('fix the bug\nthen run tests');
    expect(send.disabled).toBe(false);
    textarea.dispatchEvent(new document.defaultView!.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(app._sendInputAsync).not.toHaveBeenCalled();
  });

  it('sends one bracketed paste, then Enter after a delay, and clears the box and draft', () => {
    const { bar, send, type, textarea, app, timers, runTimers } = loadDock();
    bar.syncDock();
    type('first line\nsecond line');
    expect(bar._composerDrafts.get('session-1')).toBe('first line\nsecond line');

    send.click();
    expect(app._sendInputAsync).toHaveBeenCalledOnce();
    expect(app._sendInputAsync).toHaveBeenCalledWith('session-1', '\x1b[200~first line\rsecond line\x1b[201~');
    expect(timers).toContainEqual(expect.objectContaining({ delay: 120 }));
    runTimers();
    expect(app._sendInputAsync).toHaveBeenLastCalledWith('session-1', '\r', { useMux: true });
    expect(textarea.value).toBe('');
    expect(bar._composerDrafts.has('session-1')).toBe(false);
    expect(send.disabled).toBe(true);
  });

  it('sends with Cmd/Ctrl+Enter from a hardware keyboard', () => {
    const { bar, type, textarea, app, document } = loadDock();
    bar.syncDock();
    type('hello');
    textarea.dispatchEvent(
      new document.defaultView!.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })
    );
    expect(app._sendInputAsync).toHaveBeenCalledWith('session-1', '\x1b[200~hello\x1b[201~');
  });

  it('keeps a separate draft per session across tab switches', () => {
    const { app, bar, type, textarea } = loadDock();
    bar.syncDock();
    type('draft for claude');

    app.activeSessionId = 'session-2';
    bar.syncDock();
    expect(textarea.value).toBe('');
    type('draft for codex');

    app.activeSessionId = 'session-1';
    bar.syncDock();
    expect(textarea.value).toBe('draft for claude');
    expect(bar._composerDrafts.get('session-2')).toBe('draft for codex');
  });

  it('picks up what the Compose dialog changed when it closes', () => {
    const { bar, type, textarea } = loadDock();
    bar.syncDock();
    type('started in the dock');
    bar.composePrompt();
    const dialog = bar._composerOverlay.querySelector('.prompt-composer-textarea') as HTMLTextAreaElement;
    expect(dialog.value).toBe('started in the dock');
    dialog.value = 'finished in the dialog';
    dialog.dispatchEvent(new dialog.ownerDocument.defaultView!.Event('input', { bubbles: true }));
    bar._composerOverlay._closeComposer();
    expect(textarea.value).toBe('finished in the dialog');
  });

  it('clears the box when its session draft is discarded', () => {
    const { bar, type, textarea } = loadDock();
    bar.syncDock();
    type('about to be deleted');
    bar.discardComposerDraft('session-1');
    expect(textarea.value).toBe('');
  });

  it('adopts text typed on the terminal prompt when focused, and leaves the overlay alone otherwise', () => {
    const { bar, textarea, localEcho } = loadDock();
    bar.syncDock();
    textarea.dispatchEvent(new textarea.ownerDocument.defaultView!.FocusEvent('focus'));
    expect(localEcho.clear).not.toHaveBeenCalled();

    localEcho.pendingText = 'typed in terminal';
    textarea.dispatchEvent(new textarea.ownerDocument.defaultView!.FocusEvent('focus'));
    expect(textarea.value).toBe('typed in terminal');
    expect(localEcho.clear).toHaveBeenCalledOnce();
    expect(bar._composerDrafts.get('session-1')).toBe('typed in terminal');
  });

  it('inserts an attached or picked path into the dock only while it shows for that session', () => {
    const { app, bar, textarea, type } = loadDock();
    bar.syncDock();
    type('look at');
    expect(bar.insertIntoDock('session-1', '/tmp/shot.png')).toBe(true);
    expect(textarea.value).toBe('look at /tmp/shot.png');
    expect(bar.insertIntoDock('session-2', '/tmp/other.png')).toBe(false);

    app.activeSessionId = 'shell-1';
    bar.syncDock();
    expect(bar.insertIntoDock('shell-1', '/tmp/x')).toBe(false);
  });

  it('does not move focus to the terminal when an accessory key is tapped while typing in the dock', () => {
    const { app, bar, document, textarea } = loadDock();
    bar.syncDock();
    // Mount the bar the way init() does, minus the parts the dock test does not need.
    bar.element = document.createElement('div');
    bar.element.className = 'keyboard-accessory-bar';
    bar.element.innerHTML = bar._simpleButtons;
    document.body.appendChild(bar.element);
    const sendKey = vi.spyOn(bar, 'sendKey').mockImplementation(() => {});
    const clickHandler = (e: Event) => {
      const btn = (e.target as HTMLElement).closest('.accessory-btn') as HTMLElement | null;
      if (!btn) return;
      bar.handleAction(btn.dataset.action, btn);
      if (!bar.isDockFocused()) app.terminal.focus();
    };
    bar.element.addEventListener('click', clickHandler);

    textarea.focus();
    expect(bar.isDockFocused()).toBe(true);
    (bar.element.querySelector('[data-action="esc"]') as HTMLButtonElement).click();
    expect(sendKey).toHaveBeenCalledWith('\x1b');
    expect(app.terminal.focus).not.toHaveBeenCalled();
    // The shipped click handler carries the same guard.
    expect(accessorySource).toMatch(
      /&& !this\.isDockFocused\(\)\) \{\s*if \(typeof app !== 'undefined' && app\.terminal\)/
    );
  });
});
