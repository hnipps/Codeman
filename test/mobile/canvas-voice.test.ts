/**
 * Phone voice controls (PC11): Dictate and Voice as tap targets in the phone assistant, the composer and both controls
 * above the software keyboard, the microphone indicator over the full-viewport rail, and capture ending when the page
 * is hidden. Controlled fixtures only: no real microphone or audio.
 * Headless Chromium reports no touch even with touch emulation, so `window.__canvasTouch` forces the touch branch.
 */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import puppeteer from 'puppeteer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebServer } from '../../src/web/server.js';
import { dataPath } from '../../src/config/instance.js';
import { workspaceForCase } from '../../src/canvas/workspace-registry.js';
import { resolveCasesDir } from '../../src/web/route-helpers.js';
import { CanvasStores } from '../../src/canvas/canvas-store.js';
import { CommandSchema } from '../../src/canvas/operations.js';
import { installVoiceFixtures } from '../canvas-voice-fixtures.js';

const MEDIA = resolve('pr/media');
const stamp = Date.now();
const text = (id: string, y: number, body: string) =>
  CommandSchema.parse({
    kind: 'create',
    opId: `create-${id}`,
    objectId: id,
    patch: {
      parentId: null,
      order: y,
      position: { x: 0, y },
      size: { width: 300, height: 80 },
      content: { type: 'text', text: body },
    },
  });
describe('phone voice', () => {
  let server: WebServer, browser: Browser, context: BrowserContext, page: Page, origin: string, workspace: string;
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  const shot = (slug: string) =>
    page.screenshot({ animations: 'disabled', path: resolve(MEDIA, `pc11-${stamp}-phone-${slug}.png`) });
  const waitPhase = (wanted: string) =>
    page.waitForFunction((p) => document.documentElement.dataset.voice === p, wanted, { timeout: 8000 });
  const frame = (spoken: string, final = false) =>
    page.evaluate(([t, f]) => window.__voice.sockets.at(-1)!.frame({ t: 'transcript', text: t, final: f }), [
      spoken,
      final,
    ] as const);
  /** The rail's own controls that are on screen, each checked at five points to be what a finger would hit. */
  async function uncovered(): Promise<string[]> {
    const seen: string[] = [];
    for (const id of ['closeRail', 'conversationPicker', 'newConversation']) {
      const target = page.locator(`#${id}`);
      if (!(await target.isVisible())) continue;
      seen.push(id);
      const box = (await target.boundingBox())!;
      for (const [fx, fy] of [
        [0.5, 0.5],
        [0.1, 0.5],
        [0.9, 0.5],
        [0.5, 0.15],
        [0.5, 0.85],
      ]) {
        const hit = await page.evaluate(
          ([x, y]) => document.elementFromPoint(x, y)?.closest('button, select')?.id ?? null,
          [box.x + box.width * fx, box.y + box.height * fy]
        );
        expect(hit, `${id} at ${fx},${fy}`).toBe(id);
      }
    }
    return seen;
  }
  const micLive = () => page.evaluate(() => window.__voice.tracks.some((t) => t.readyState === 'live'));
  beforeAll(async () => {
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-pc11-phone');
    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasEnabled: true, canvasShellEnabled: false }));
    mkdirSync(resolve(resolveCasesDir(), 'phone-voice'), { recursive: true });
    workspace = workspaceForCase('phone-voice').id;
    const stores = new CanvasStores();
    expect(
      stores
        .get(workspace)
        .append([text('brief', 0, 'Readers scan headings first')], { kind: 'human', userId: 'admin' }).ok
    ).toBe(true);
    stores.flush();
    server = new WebServer(0, false, true, undefined, undefined, undefined, '/x');
    await server.start();
    origin = `http://localhost:${server.boundPort}`;
    browser = await chromium.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
    });
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      hasTouch: true,
      isMobile: true,
    });
    await context.addInitScript(() => {
      window.__canvasTouch = true;
      if (!localStorage.getItem('codeman:skin')) localStorage.setItem('codeman:skin', 'og');
      // A controllable visual viewport stands in for the software keyboard; it follows the window the rest of the time.
      let covered = 0;
      const fake = new EventTarget();
      Object.defineProperties(fake, {
        width: { get: () => innerWidth },
        height: { get: () => innerHeight - covered },
        offsetTop: { value: 0 },
        offsetLeft: { value: 0 },
        scale: { value: 1 },
      });
      Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake });
      (window as unknown as { __keyboard: (h: number) => void }).__keyboard = (h: number) => {
        covered = h;
        fake.dispatchEvent(new Event('resize'));
      };
    });
    await context.addInitScript(installVoiceFixtures);
    page = await context.newPage();
    // The real providers answer with the relay switched on (the test home has no Claude login).
    await page.route('**/api/canvas/assistant/providers', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.data.voice = { relay: true };
      await route.fulfill({ response, json: body });
    });
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/conversations/.test(r.url()))
        posts.push({ url: r.url(), body: JSON.parse(r.postData() ?? '{}') });
    });
    mkdirSync(MEDIA, { recursive: true });
    await page.goto(`${origin}/x/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-object-id="brief"]');
    await page.waitForFunction(() => !!window.canvasView);
    await page.waitForTimeout(300);
    await page.locator('#assistantTool').tap();
    await page.waitForSelector('#assistantView:not([hidden])');
  }, 60000);
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    vi.unstubAllEnvs();
  }, 60000);

  it('has both controls in the assistant at touch size, inside the width, with a 16px message field', async () => {
    for (const id of ['voiceDictate', 'voiceConversation', 'assistantSend']) {
      const box = (await page.locator(`#${id}`).boundingBox())!;
      expect(box.height, id).toBeGreaterThanOrEqual(44);
      expect(box.width, id).toBeGreaterThanOrEqual(44);
      expect(box.x, id).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, id).toBeLessThanOrEqual(390);
    }
    expect(await page.locator('#voiceDictate').textContent()).toContain('Dictate');
    expect(await page.locator('#voiceConversation').textContent()).toContain('Voice');
    expect(await page.locator('#assistantDraft').evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await shot('controls');
  });

  it('a tap dictates into the draft, the indicator sits over the full-screen rail, and its Stop is a touch target', async () => {
    await page.locator('#voiceDictate').tap();
    await waitPhase('listening');
    await frame('spoken on a phone');
    expect(await page.locator('#assistantDraft').inputValue()).toBe('spoken on a phone');
    const stop = (await page.locator('#micStop').boundingBox())!;
    expect(stop.height).toBeGreaterThanOrEqual(44);
    const mark = (await page.locator('#micIndicator').boundingBox())!;
    expect(mark.x).toBeGreaterThanOrEqual(0);
    expect(mark.x + mark.width).toBeLessThanOrEqual(390);
    // Nothing of the rail covers it.
    const top = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.closest('#micIndicator')?.id ?? null,
      [stop.x + stop.width / 2, stop.y + stop.height / 2]
    );
    expect(top).toBe('micIndicator');
    await shot('dictating');
    expect(await uncovered()).toContain('closeRail');
    await page.locator('#micStop').tap();
    await waitPhase('idle');
    expect(await micLive()).toBe(false);
    expect(await page.locator('#micIndicator').isHidden()).toBe(true);
    expect(posts).toEqual([]);
  });

  it('keeps the composer and both controls above the software keyboard', async () => {
    await page.locator('#assistantDraft').tap();
    await page.evaluate(() => (window as unknown as { __keyboard: (h: number) => void }).__keyboard(320));
    await page.waitForTimeout(200);
    const limit = 844 - 320;
    for (const id of ['assistantDraft', 'voiceDictate', 'voiceConversation', 'assistantSend']) {
      const box = (await page.locator(`#${id}`).boundingBox())!;
      expect(box.y, id).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height, id).toBeLessThanOrEqual(limit + 1);
    }
    await shot('keyboard');
    await page.evaluate(() => (window as unknown as { __keyboard: (h: number) => void }).__keyboard(0));
    await page.locator('#assistantDraft').evaluate((el: HTMLTextAreaElement) => {
      el.blur();
      el.value = '';
    });
  });

  it('capture stops when the page is hidden', async () => {
    await page.locator('#voiceConversation').tap();
    await waitPhase('listening');
    await frame('left half said');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitPhase('idle');
    expect(await micLive()).toBe(false);
    expect(await page.locator('#micIndicator').isHidden()).toBe(true);
    expect(await page.locator('#conversationState').textContent()).toMatch(/page was hidden/);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    });
    await page.waitForTimeout(3300);
    expect(posts).toEqual([]);
  });

  it('a tapped voice turn is shown with Cancel at touch size, then sent once', async () => {
    await page.locator('#assistantDraft').evaluate((el: HTMLTextAreaElement) => {
      el.value = '';
    });
    await page.locator('#voiceConversation').tap();
    await waitPhase('listening');
    await frame('summarise the brief');
    await page.locator('#voiceConversation').tap();
    await waitPhase('ready-to-send');
    expect(await page.locator('#assistantDraft').inputValue()).toBe('summarise the brief');
    const cancel = (await page.locator('#voiceCancel').boundingBox())!;
    expect(cancel.height).toBeGreaterThanOrEqual(44);
    expect(cancel.y + cancel.height).toBeLessThanOrEqual(844);
    await shot('ready-to-send');
    await page.waitForFunction(() => (document.getElementById('assistantDraft') as HTMLTextAreaElement).value === '');
    await page.waitForTimeout(3300);
    const sent = posts.filter((p) => p.url.endsWith('/messages'));
    expect(sent).toHaveLength(1);
    expect(sent[0].body.text).toBe('summarise the brief');
    // With a conversation bound the picker and New are on screen; the mark covers neither, nor Close, at its widest.
    await page.locator('#voiceConversation').tap();
    await waitPhase('listening');
    await frame('and one more');
    await page.locator('#voiceConversation').tap();
    await waitPhase('ready-to-send');
    expect(await page.locator('#micStop').textContent()).toBe('Cancel send');
    expect(await uncovered()).toEqual(['closeRail', 'conversationPicker', 'newConversation']);
    await shot('countdown');
    await page.locator('#micStop').tap();
    await waitPhase('idle');
    await page.waitForTimeout(3300);
    expect(posts.filter((p) => p.url.endsWith('/messages'))).toHaveLength(1);
  });

  it('a hardware B on a phone does nothing', async () => {
    await page.evaluate(() => document.getElementById('board')!.focus());
    const before = await page.evaluate(() => window.__voice.requests);
    await page.keyboard.press('b');
    await page.keyboard.press('Shift+B');
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.__voice.requests)).toBe(before);
  });
});
