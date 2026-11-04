import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const html = readFileSync('src/web/public/index.html', 'utf8');
const wrap = html.slice(html.indexOf('<div class="terminal-wrap"'), html.indexOf('<!-- Tile grid'));
const messages = Array.from({ length: 35 }, (_, turn) => ({
  role: turn % 2 ? 'assistant' : 'user',
  text: `Message ${turn}\n\nNative scrolling paragraph.\n\n\`\`\`js\nconst turn = ${turn};\n\`\`\``,
  turn,
  kind: 'response',
}));

describe('phone conversation workspace', () => {
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('http://chat.test/**', async (route) => {
      if (route.request().url().includes('/last-response?context=full')) {
        await route.fulfill({ json: { data: { messages } } });
      } else {
        await route.fulfill({
          contentType: 'text/html',
          body: `<html><body class="touch-device mobile-device"><main class="main" style="height:100dvh;margin:0;padding:0">${wrap}</main></body></html>`,
        });
      }
    });
    await page.goto('http://chat.test/', { waitUntil: 'domcontentloaded' });
    for (const file of ['styles.css', 'mobile.css']) {
      await page.addStyleTag({ content: readFileSync(`src/web/public/${file}`, 'utf8') });
    }
    for (const file of [
      'constants.js',
      'mobile-handlers.js',
      'keyboard-accessory.js',
      'vendor/marked.min.js',
      'vendor/dompurify.min.js',
      'sanitize-html.js',
      'app.js',
    ]) {
      await page.addScriptTag({ content: readFileSync(`src/web/public/${file}`, 'utf8') });
    }
    // The DOM has already loaded: use the real prototype without booting a
    // server-backed dashboard or attaching to any live Claude/tmux session.
    await page.evaluate(() => {
      new Function(`
        app = Object.create(CodemanApp.prototype);
        window.app = app;
        app.activeSessionId = 'claude-1';
        app.sessions = new Map([['claude-1', { mode: 'claude' }], ['codex-1', { mode: 'codex' }]]);
        app.loadAppSettingsFromStorage = () => ({});
        app.getDefaultSettings = () => ({});
        app.sent = [];
        app._sendInputAsync = (sessionId, text) => app.sent.push({ sessionId, text });
        app._terminalGestureAxis = null;
        MobileDetection.isTouchDevice = () => true;
        KeyboardHandler.updateLayoutForKeyboard = () => {};
        KeyboardAccessoryBar.initDock();
        KeyboardAccessoryBar.syncDock();
        SwipeHandler.init();
        window.swipe = SwipeHandler;
        window.dock = KeyboardAccessoryBar;
      `)();
    });
  });

  afterAll(async () => {
    await browser?.close();
  });

  beforeEach(async () => {
    await page.evaluate(() => {
      const app = (window as any).app;
      app.closeChatView();
      app.activeSessionId = 'claude-1';
      app.sent = [];
      (window as any).dock.syncDock();
    });
  });

  it('overlays without changing terminal geometry, keeps the dock above it, and natively scrolls', async () => {
    const terminal = page.locator('#terminalContainer');
    const before = await terminal.boundingBox();
    await page.locator('#chatViewToggle').click();
    await page.waitForSelector('#chatViewBody .rv-message:nth-child(35)');
    expect(await terminal.boundingBox()).toEqual(before);
    expect(await page.locator('.terminal-wrap').isVisible()).toBe(true);
    expect(await page.locator('#composerDock').isVisible()).toBe(true);
    const state = await page.evaluate(() => {
      const body = document.getElementById('chatViewBody')!;
      const overlay = document.getElementById('chatView')!;
      const dock = document.getElementById('composerDock')!;
      const rect = dock.getBoundingClientRect();
      return {
        touchAction: getComputedStyle(body).touchAction,
        overflow: getComputedStyle(body).overflowY,
        bottom: body.scrollHeight - body.scrollTop - body.clientHeight,
        dockAbove: Number(getComputedStyle(dock).zIndex) > Number(getComputedStyle(overlay).zIndex),
        dockHit: !!document.elementFromPoint(rect.left + 20, rect.top + 20)?.closest('#composerDock'),
      };
    });
    expect(state).toMatchObject({ touchAction: 'pan-y', overflow: 'auto', dockAbove: true, dockHit: true });
    expect(state.bottom).toBeLessThan(2);
    await page.locator('#chatViewBody').hover();
    await page.mouse.wheel(0, -400);
    await page.waitForFunction(() => {
      const body = document.getElementById('chatViewBody')!;
      return body.scrollHeight - body.scrollTop - body.clientHeight > 200;
    });
    expect(await page.locator('#chatViewBody .rv-copy-btn').count()).toBeGreaterThan(0);
  });

  it('excludes conversation/dock touches from session swipes and sends through the existing composer', async () => {
    await page.locator('#chatViewToggle').click();
    await page.waitForSelector('#chatViewBody .rv-message');
    const ignored = await page.evaluate(() => {
      const swipe = (window as any).swipe;
      return ['#chatViewBody .rv-text', '.composer-dock-textarea'].map((selector) => {
        swipe.onTouchStart({ target: document.querySelector(selector), touches: [{ clientX: 10, clientY: 10 }] });
        return swipe._ignoreGesture;
      });
    });
    expect(ignored).toEqual([true, true]);
    await page.locator('.composer-dock-textarea').fill('A native prompt\nwith another line');
    await page.locator('.composer-dock-send').click();
    await page.waitForFunction(() => (window as any).app.sent.length === 2);
    expect(await page.evaluate(() => (window as any).app.sent)).toEqual([
      { sessionId: 'claude-1', text: '\x1b[200~A native prompt\rwith another line\x1b[201~' },
      { sessionId: 'claude-1', text: '\r' },
    ]);
    expect(await page.locator('.composer-dock-textarea').inputValue()).toBe('');
    await page.locator('#chatView .chat-view-header button').first().click();
    expect(await page.locator('#chatView').isVisible()).toBe(false);
    expect(await page.locator('#chatViewToggle').getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on session changes and hides the toggle for non-Claude sessions', async () => {
    await page.locator('#chatViewToggle').click();
    await page.waitForSelector('#chatViewBody .rv-message');
    await page.evaluate(() => {
      (window as any).app.activeSessionId = 'codex-1';
      (window as any).dock.syncDock();
    });
    expect(await page.locator('#chatView').isVisible()).toBe(false);
    expect(await page.locator('#chatViewToggle').isVisible()).toBe(false);
    expect(errors).toEqual([]);
  });

  it('hides the chat toggle for remote and Docker Claude sessions without a host transcript', async () => {
    for (const field of ['remote', 'docker']) {
      await page.evaluate((name) => {
        const app = (window as any).app;
        app.sessions.set('claude-1', { mode: 'claude', [name]: {} });
        (window as any).dock.syncDock();
      }, field);
      expect(await page.locator('#chatViewToggle').isVisible()).toBe(false);
      await page.evaluate(() => {
        (window as any).app.sessions.set('claude-1', { mode: 'claude' });
        (window as any).dock.syncDock();
      });
    }
    expect(errors).toEqual([]);
  });
});
