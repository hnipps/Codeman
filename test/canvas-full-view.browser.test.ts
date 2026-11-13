/**
 * Canvas shell (PC13) in the browser, part 3: a session's terminal as a full view over the canvas, on a laptop.
 * Acceptance 12 to 15 of the brief. Under a reverse-proxy base path. Sessions are the server's test stand-ins
 * (a PTY that echoes what it is sent, no agent and no tmux), so "the pane" is read from the session's own
 * terminal capture on the server, never from an HTTP 200 of the input route.
 */
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright';
import puppeteer from 'puppeteer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebServer } from '../src/web/server.js';
import { dataPath } from '../src/config/instance.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';
import { CanvasStores } from '../src/canvas/canvas-store.js';
import { CommandSchema } from '../src/canvas/operations.js';

const installed = vi.hoisted(() => ({ map: { claude: true } as Record<string, boolean> }));
vi.mock('../src/utils/cli-installed-probes.js', async (original) => ({
  ...(await original<typeof import('../src/utils/cli-installed-probes.js')>()),
  probeStockCliAvailability: async () => installed.map,
}));

const note = (id: string, x: number, text: string) =>
  CommandSchema.parse({
    kind: 'create',
    opId: `create-${id}`,
    objectId: id,
    patch: {
      parentId: null,
      order: x / 1000,
      position: { x, y: 0 },
      size: { width: 180, height: 90 },
      content: { type: 'text', text },
    },
  });

describe('canvas shell: the session full view', () => {
  let server: WebServer, browser: Browser, context: BrowserContext, page: Page, origin: string, alpha: string;
  const api = (path: string) => `${origin}/x/api${path}`;
  const started: string[] = [];
  async function start(sessionName: string): Promise<string> {
    const response = await page.request.post(api('/quick-start'), {
      data: { caseName: 'alpha', mode: 'shell', sessionName },
    });
    const body = await response.json();
    const id = (body.sessionId ?? body.data?.sessionId) as string;
    expect(id, JSON.stringify(body)).toBeTruthy();
    started.push(id);
    return id;
  }
  const view = () => page.evaluate(() => window.canvasView.read());
  const seq = async () => (await (await page.request.get(api(`/canvas/${alpha}/objects`))).json()).data.seq as number;
  const pane = async (id: string) =>
    JSON.stringify(await (await page.request.get(api(`/sessions/${id}/terminal`))).json());
  const frames = () => page.locator('#fullViewFrame iframe');
  const row = (id: string) => page.locator(`#sessionRows button.session-row[data-session-id="${id}"]`);
  async function open() {
    await page.goto(`${origin}/x/canvas/${alpha}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-object-id="n1"]');
    await page.waitForFunction(() => document.querySelector('#workspaceSwitch')?.textContent?.trim() !== 'Canvas');
  }
  /** The session page inside the full view, once its terminal is up and it has shown the Canvas button. */
  async function sessionPage(id: string): Promise<Frame> {
    await frames().waitFor();
    const handle = await frames().elementHandle();
    const frame = (await handle!.contentFrame())!;
    await frame.waitForSelector('#soloCanvasBtn');
    await frame.waitForFunction(
      (sid) => (window as unknown as { app?: { activeSessionId?: string } }).app?.activeSessionId === sid,
      id
    );
    await frame.waitForSelector('.xterm-helper-textarea', { state: 'attached' });
    return frame;
  }

  beforeAll(async () => {
    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasEnabled: true, canvasShellEnabled: true }));
    mkdirSync(resolve(resolveCasesDir(), 'alpha'), { recursive: true });
    alpha = workspaceForCase('alpha').id;
    const stores = new CanvasStores();
    expect(
      stores.get(alpha).append([note('n1', 0, 'Alpha plan'), note('n2', 300, 'Budget')], { kind: 'human', userId: 'a' })
        .ok
    ).toBe(true);
    stores.flush();
    server = new WebServer(0, false, true, undefined, undefined, undefined, '/x');
    await server.start();
    origin = `http://localhost:${server.boundPort}`;
    browser = await chromium.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: ['--no-sandbox'],
    });
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
    });
    await context.addInitScript(() => {
      if (!localStorage.getItem('codeman:skin')) localStorage.setItem('codeman:skin', 'og');
    });
    page = await context.newPage();
  }, 60000);
  afterEach(async () => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    for (const id of started.splice(0)) await page.request.delete(api(`/sessions/${id}`)).catch(() => {});
  });
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
  }, 60000);

  it('opens a terminal over the canvas, types into the pane, and closes back to exactly the same view', async () => {
    const id = await start('alpha-shell');
    // Every socket the canvas document itself opens, counted in that document (frames are not instrumented).
    await page.addInitScript(() => {
      if (window !== window.top) return;
      const opened: string[] = ((window as unknown as { __canvasSockets: string[] }).__canvasSockets = []);
      const Real = window.WebSocket;
      window.WebSocket = class extends Real {
        constructor(url: string | URL, protocols?: string | string[]) {
          opened.push(String(url));
          super(url, protocols);
        }
      };
    });
    await open();
    await row(id).waitFor();
    // A view worth preserving: a selection, a focused object, the assistant open with a draft, a moved camera.
    await page.evaluate(() => {
      window.canvasView.dispatch({ kind: 'selection', ids: ['n1', 'n2'] });
      window.canvasView.dispatch({ kind: 'focus', id: 'n2' });
      window.canvasView.dispatch({ kind: 'rail', view: 'assistant' });
      window.canvasView.dispatch({ kind: 'viewport', viewport: { x: 37, y: -12, zoom: 0.75 } });
    });
    await page.locator('#assistantDraft').fill('a draft that must survive');
    const before = await view();
    const seqBefore = await seq();
    // What the canvas page itself asks of the server while a full view is open (acceptance 15).
    const canvasRequests: string[] = [];
    const pageSockets: string[] = [];
    page.on('request', (r) => {
      if (r.frame() === page.mainFrame()) canvasRequests.push(`${r.method()} ${new URL(r.url()).pathname}`);
    });
    page.on('websocket', (ws) => pageSockets.push(ws.url()));

    await row(id).focus();
    await page.keyboard.press('Enter');
    const frame = await sessionPage(id);
    expect(await frames().count()).toBe(1);
    const attrs = await frames().evaluate((f: HTMLIFrameElement) => ({
      sandbox: f.getAttribute('sandbox'),
      title: f.title,
      allow: f.allow,
      src: f.getAttribute('src'),
    }));
    expect(attrs).toEqual({
      sandbox: null,
      title: 'Terminal of alpha-shell',
      allow: 'clipboard-read; clipboard-write; microphone',
      src: `/x/session/${id}?from=canvas&ws=${alpha}`,
    });
    expect((await view()).fullView).toBe(id);
    // The canvas underneath is inert, and the page under the frame is the same document.
    expect(
      await page.evaluate(() =>
        [...document.body.children].filter((c) => c.id !== 'fullView').every((c) => (c as HTMLElement).inert)
      )
    ).toBe(true);
    // The session page: Canvas in place of re-dock, and it joined the popped-out window protocol.
    expect(await frame.locator('#soloCanvasBtn').textContent()).toBe('Canvas');
    expect(await frame.locator('#soloRedockBtn').isVisible()).toBe(false);
    expect(await frame.evaluate(() => document.body.classList.contains('solo-mode'))).toBe(true);

    // Typed input, through the session page's own terminal.
    await frame.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('echo PC13-MARKER-7391');
    await page.keyboard.press('Enter');
    await vi.waitFor(async () => expect(await pane(id)).toContain('PC13-MARKER-7391'), { timeout: 10000 });

    // Acceptance 13: with focus on the canvas page, its shortcut keys change nothing while the view is open.
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      window.focus();
    });
    for (const key of ['c', 'g', 'Delete', 'h', '?']) await page.keyboard.press(key);
    await page.mouse.click(700, 450);
    expect({ ...(await view()), fullView: null }).toEqual(before);

    // The back chord, from inside the terminal: no byte of it reaches the pane.
    const paneBefore = await pane(id);
    await frame.locator('.xterm-helper-textarea').focus();
    await page.keyboard.press('Control+Shift+Backspace');
    await frames().waitFor({ state: 'detached' });
    expect(await page.locator('#fullView').isHidden()).toBe(true);
    expect(await view()).toEqual(before);
    expect(await page.locator('#assistantDraft').inputValue()).toBe('a draft that must survive');
    expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.sessionId)).toBe(id);
    expect(await page.evaluate(() => [...document.body.children].some((c) => (c as HTMLElement).inert))).toBe(false);
    expect(await pane(id)).toBe(paneBefore);
    // Acceptance 14 and 15.
    expect(await seq()).toBe(seqBefore);
    // The page-wide event cannot tell frames apart; the top document's own constructor count can.
    expect(await page.evaluate(() => (window as unknown as { __canvasSockets: string[] }).__canvasSockets)).toEqual([]);
    expect(pageSockets.filter((u) => u.includes(`/ws/sessions/${id}/terminal`))).toHaveLength(1);
    expect(canvasRequests.filter((r) => /\/input\b|\/ws\//.test(r))).toEqual([]);
    expect(
      canvasRequests.filter((r) => /^(POST|PUT|DELETE|PATCH) /.test(r) && !/\/api\/canvas\/[^/]+\/views\//.test(r))
    ).toEqual([]);
  }, 60000);

  it('closes from the Canvas button and from Escape on the canvas page, and never holds two frames', async () => {
    const first = await start('one');
    const second = await start('two');
    await open();
    await row(first).click();
    let frame = await sessionPage(first);
    await frame.locator('#soloCanvasBtn').click();
    await frames().waitFor({ state: 'detached' });
    expect((await view()).fullView).toBeNull();

    // Opening another replaces the open one (a typed view command; an agent's takes the same path).
    await row(first).click();
    await sessionPage(first);
    await page.evaluate((sid) => window.canvasView.dispatch({ kind: 'full-view', sessionId: sid }), second);
    frame = await sessionPage(second);
    expect(await frames().count()).toBe(1);
    expect((await view()).fullView).toBe(second);
    // A session this view does not list never opens.
    await page.evaluate(() => window.canvasView.dispatch({ kind: 'full-view', sessionId: 'not-a-session' }));
    expect((await view()).fullView).toBe(second);
    expect(await frames().getAttribute('src')).toContain(`/session/${second}?`);

    // A message that is not from the frame's own window is ignored.
    await page.evaluate(() => window.postMessage({ type: 'codeman:full-view-close' }, location.origin));
    await page.waitForTimeout(200);
    expect(await frames().count()).toBe(1);

    // Escape inside the terminal belongs to the terminal.
    await frame.locator('.xterm-helper-textarea').focus();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    expect(await frames().count()).toBe(1);
    // Escape with focus on the canvas page closes.
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      window.focus();
    });
    await page.keyboard.press('Escape');
    await frames().waitFor({ state: 'detached' });
    expect((await view()).fullView).toBeNull();
  }, 60000);

  it('says so in place of the frame when the session page does not answer within ten seconds', async () => {
    const id = await start('slow');
    await open();
    await row(id).waitFor();
    // The page arrives but never says it is ready.
    await page.route(/\/x\/session\//, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stuck</title>' })
    );
    await row(id).click();
    await frames().waitFor();
    expect(await page.locator('#fullViewError').isHidden()).toBe(true);
    await page.locator('#fullViewError').waitFor({ state: 'visible', timeout: 15000 });
    expect(await frames().count()).toBe(0);
    expect(await page.locator('#fullViewError h1').textContent()).toBe('The session page did not open');
    expect(await page.locator('#fullViewClassic').getAttribute('href')).toBe(`/x/classic#session=${id}`);
    expect((await view()).fullView).toBe(id);
    // Try again mounts a fresh frame; this time the real page answers.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.locator('#fullViewRetry').click();
    await sessionPage(id);
    expect(await page.locator('#fullViewError').isHidden()).toBe(true);
    await page.waitForTimeout(500);
    // Back to canvas, from the error state of a second failure.
    await page.evaluate(() => window.canvasView.dispatch({ kind: 'full-view', sessionId: null }));
    await frames().waitFor({ state: 'detached' });
    expect(await page.locator('#fullView').isHidden()).toBe(true);
  }, 60000);

  it('opens the session a notification named, cleans the address, and shows an ended session as unavailable', async () => {
    const id = await start('notified');
    await page.goto(`${origin}/x/canvas/${alpha}?session=${id}`, { waitUntil: 'domcontentloaded' });
    const frame = await sessionPage(id);
    expect(new URL(page.url()).search).toBe('');
    expect((await view()).fullView).toBe(id);
    // The session ends while its full view is open: the session page says so and offers the way back.
    await page.request.delete(api(`/sessions/${id}`));
    await frame.waitForSelector('#soloGoneCanvasBtn');
    await frame.locator('#soloGoneCanvasBtn').click();
    await frames().waitFor({ state: 'detached' });
    // A session of another workspace is one the canvas cannot frame here: the classic view shows it.
    mkdirSync(resolve(resolveCasesDir(), 'elsewhere'), { recursive: true });
    const other = await (
      await page.request.post(api('/quick-start'), { data: { caseName: 'elsewhere', mode: 'shell' } })
    ).json();
    const otherId = (other.sessionId ?? other.data?.sessionId) as string;
    started.push(otherId);
    await page.goto(`${origin}/x/canvas/${alpha}?session=${otherId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL((u) => u.pathname === '/x/classic');
    await page.waitForFunction(
      (sid) => (window as unknown as { app?: { activeSessionId?: string } }).app?.activeSessionId === sid,
      otherId
    );
    // An id the server does not know opens nothing.
    await page.goto(`${origin}/x/canvas/${alpha}?session=nope`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#sessionsState')?.textContent === 'No sessions');
    expect(new URL(page.url()).search).toBe('');
    expect(await frames().count()).toBe(0);
  }, 60000);

  it('lets an agent open and close a full view for a named view without moving keyboard focus', async () => {
    const id = await start('agent-shown');
    await open();
    await row(id).waitFor();
    const call = async (args: Record<string, unknown>) =>
      (
        await page.request.post(api(`/canvas/${alpha}/command`), { data: { tool: 'canvas_view', arguments: args } })
      ).json();
    await vi.waitFor(async () => expect((await call({ action: 'list' })).data.views).toHaveLength(1), {
      timeout: 10000,
    });
    const viewId: string = (await call({ action: 'list' })).data.views[0].viewId;
    await page.locator('#board').focus();
    expect((await call({ action: 'full-view', viewId, sessionId: id })).success).toBe(true);
    await frames().waitFor();
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('IFRAME');
    expect(await frames().getAttribute('src')).toMatch(/[?&]passive=1$/);
    await vi.waitFor(async () => expect((await call({ action: 'read', viewId })).data.state.fullView).toBe(id), {
      timeout: 10000,
    });
    // The framed page has loaded and drawn its terminal by now: it must not have taken focus by itself either.
    await (await sessionPage(id)).waitForSelector('.xterm-helper-textarea');
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('IFRAME');
    // Keys pressed now go nowhere near the pane.
    await page.keyboard.type('zqx-not-for-the-pane');
    await page.waitForTimeout(500);
    expect(await pane(id)).not.toContain('zqx');
    expect((await call({ action: 'full-view', viewId, sessionId: null })).success).toBe(true);
    await frames().waitFor({ state: 'detached' });
    expect((await call({ action: 'full-view', viewId, sessionId: '../etc' })).success).toBe(false);
  }, 60000);

  /** A session that exists and has no process: what a restart leaves, and what the session page would reattach. */
  async function stopped(name: string): Promise<string> {
    const body = await (
      await page.request.post(api('/sessions'), {
        data: { workingDir: resolve(resolveCasesDir(), 'alpha'), mode: 'shell', name },
      })
    ).json();
    const id = (body.session?.id ?? body.data?.session?.id ?? body.data?.id) as string;
    expect(id, JSON.stringify(body)).toBeTruthy();
    started.push(id);
    return id;
  }
  const pid = async (id: string) => {
    const body = await (await page.request.get(api(`/sessions/${id}`))).json();
    return (body.data ?? body).pid;
  };
  async function agent() {
    const call = async (args: Record<string, unknown>) =>
      (
        await page.request.post(api(`/canvas/${alpha}/command`), { data: { tool: 'canvas_view', arguments: args } })
      ).json();
    await vi.waitFor(async () => expect((await call({ action: 'list' })).data.views).toHaveLength(1), {
      timeout: 10000,
    });
    const viewId: string = (await call({ action: 'list' })).data.views[0].viewId;
    return { call, viewId };
  }
  /** Every request that would start a CLI, and every dialog, from the page and its frames. */
  function watch() {
    const starts: string[] = [];
    const dialogs: string[] = [];
    const onRequest = (request: { method(): string; url(): string }) => {
      if (
        request.method() === 'POST' &&
        /\/api\/sessions\/[^/]+\/(interactive|shell|interactive-respawn)$/.test(request.url())
      )
        starts.push(new URL(request.url()).pathname);
    };
    const onDialog = (dialog: { message(): string; dismiss(): Promise<void> }) => {
      dialogs.push(dialog.message());
      void dialog.dismiss().catch(() => {});
    };
    page.on('request', onRequest);
    page.on('dialog', onDialog);
    return {
      starts,
      dialogs,
      stop: () => {
        page.off('request', onRequest);
        page.off('dialog', onDialog);
      },
    };
  }

  it("shows a stopped session an agent opened without starting it or asking anything; the person's own click starts it", async () => {
    const id = await stopped('agent-stopped');
    const tripped = await stopped('agent-tripped');
    // The PTY-exit breaker tripped for this one: the session page's automatic path would ask before a restart.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).sessions.get(tripped)._respawnBlocked = true;
    await open();
    await row(id).waitFor();
    await row(tripped).waitFor();
    const { call, viewId } = await agent();
    await page.locator('#board').focus();
    const seen = watch();
    try {
      for (const sessionId of [id, tripped]) {
        expect((await call({ action: 'full-view', viewId, sessionId })).success).toBe(true);
        await page.waitForFunction(
          (sid) => document.querySelector('#fullViewFrame iframe')?.getAttribute('src')?.includes(`/session/${sid}?`),
          sessionId
        );
        const frame = await sessionPage(sessionId);
        await frame.waitForSelector('#soloStoppedNotice');
        expect(await frame.locator('#soloStoppedNotice').innerText()).toContain('This session is stopped.');
        // Long enough for the page's own reattach, which runs inside selecting the session, to have gone out.
        await page.waitForTimeout(1500);
        expect(seen.starts).toEqual([]);
        expect(seen.dialogs).toEqual([]);
        expect(await pid(sessionId)).toBeNull();
      }
      // The person starts it, with their own click on the session page.
      expect((await call({ action: 'full-view', viewId, sessionId: id })).success).toBe(true);
      await page.waitForFunction(
        (sid) => document.querySelector('#fullViewFrame iframe')?.getAttribute('src')?.includes(`/session/${sid}?`),
        id
      );
      const frame = await sessionPage(id);
      // Until the person takes the terminal, the frame is held: nothing in it can be focused or clicked.
      expect(await frames().evaluate((f: HTMLIFrameElement) => f.inert)).toBe(true);
      await page.locator('.full-view-take').click();
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME');
      await frame.locator('#soloStartBtn').click();
      await vi.waitFor(() => expect(seen.starts).toEqual([`/x/api/sessions/${id}/shell`]), { timeout: 10000 });
      await frame.waitForSelector('#soloStoppedNotice', { state: 'detached' });
      await vi.waitFor(async () => expect(await pid(id)).not.toBeNull(), { timeout: 10000 });
      expect(seen.dialogs).toEqual([]);
    } finally {
      seen.stop();
    }
  }, 90000);

  it('still reattaches a stopped session the person opened themselves, and reads the marker strictly', async () => {
    const id = await stopped('person-stopped');
    await open();
    await row(id).waitFor();
    const seen = watch();
    try {
      await row(id).click();
      await sessionPage(id);
      expect(await frames().getAttribute('src')).not.toContain('passive');
      await vi.waitFor(() => expect(seen.starts).toEqual([`/x/api/sessions/${id}/shell`]), { timeout: 10000 });
      expect(await frames().locator('#soloStoppedNotice').count()).toBe(0);
      await page.keyboard.press('Control+Shift+Backspace');
      await frames().waitFor({ state: 'detached' });
      // Only `passive=1` on a page the canvas opened is the marker: anything else is a person's page.
      const other = await stopped('marker');
      for (const query of [`from=canvas&ws=${alpha}&passive=true`, 'passive=1']) {
        seen.starts.length = 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (server as any).sessions
          .get(other)
          ?.stop?.()
          .catch(() => {});
        await page.goto(`${origin}/x/session/${other}?${query}`, { waitUntil: 'domcontentloaded' });
        await vi.waitFor(() => expect(seen.starts).toEqual([`/x/api/sessions/${other}/shell`]), { timeout: 10000 });
        expect(await page.locator('#soloStoppedNotice').count()).toBe(0);
      }
    } finally {
      seen.stop();
    }
  }, 90000);

  it("refuses an agent's open while the person is typing on the canvas, with every keystroke landing", async () => {
    const id = await start('typing');
    await open();
    await row(id).waitFor();
    const { call, viewId } = await agent();
    const refusal = async (commandId: string) => {
      let reason = '';
      await vi.waitFor(
        async () => {
          const state = (await call({ action: 'read', viewId })).data.state;
          expect(state.refused?.commandId).toBe(commandId);
          reason = state.refused.reason;
        },
        { timeout: 10000 }
      );
      return reason;
    };
    for (const field of ['#search', '#assistantDraft']) {
      if (field === '#assistantDraft')
        await page.evaluate(() => window.canvasView.dispatch({ kind: 'rail', view: 'assistant' }));
      await page.locator(field).fill('');
      await page.locator(field).click();
      await page.keyboard.type('hello ');
      const sent = await call({ action: 'full-view', viewId, sessionId: id });
      expect(sent.success).toBe(true);
      // Keys typed while the command arrives and after the view answered it.
      await page.keyboard.type('wide ');
      expect(await refusal(sent.data.commandId)).toMatch(/typing on the canvas/);
      await page.keyboard.type('world');
      expect(await page.locator(field).inputValue()).toBe('hello wide world');
      expect(await frames().count()).toBe(0);
      expect((await view()).fullView ?? null).toBeNull();
      expect(await page.evaluate((sel) => document.activeElement === document.querySelector(sel), field)).toBe(true);
      await page.locator(field).fill('');
    }
    // An ended session is refused with its own reason, and the next applied command clears the report.
    await page.locator('#board').focus();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).sessions.get(id)._paneExit = { status: 0, at: Date.now() };
    await page.locator('#sessionsRetry').evaluate((b: HTMLButtonElement) => b.click());
    await page.waitForSelector(`#sessionRows button.session-row[data-session-id="${id}"][data-state="done"]`);
    const ended = await call({ action: 'full-view', viewId, sessionId: id });
    expect(await refusal(ended.data.commandId)).toMatch(/has ended/);
    expect(await frames().count()).toBe(0);
    expect((await call({ action: 'clear-selection', viewId })).success).toBe(true);
    await vi.waitFor(async () => expect((await call({ action: 'read', viewId })).data.state.refused).toBeUndefined(), {
      timeout: 10000,
    });
  }, 90000);

  it("leaves a full view the person is typing in alone: an agent's open and close are both refused", async () => {
    const first = await start('held');
    const second = await start('other');
    await open();
    await row(first).waitFor();
    await row(second).waitFor();
    const { call, viewId } = await agent();
    await row(first).click();
    const frame = await sessionPage(first);
    await frame.locator('.xterm-helper-textarea').focus();
    for (const sessionId of [second, null]) {
      const sent = await call({ action: 'full-view', viewId, sessionId });
      expect(sent.success).toBe(true);
      await vi.waitFor(
        async () => {
          const state = (await call({ action: 'read', viewId })).data.state;
          expect(state.refused?.commandId).toBe(sent.data.commandId);
          expect(state.refused.reason).toMatch(/typing/);
        },
        { timeout: 10000 }
      );
      expect(await frames().count()).toBe(1);
      expect(await frames().getAttribute('src')).toContain(`/session/${first}?`);
      expect((await view()).fullView).toBe(first);
    }
  }, 60000);

  it('is one more client of the session: the classic view marks it shown elsewhere, and the page draws its own surfaces', async () => {
    const id = await start('shared');
    const classic = await context.newPage();
    try {
      await classic.goto(`${origin}/x/classic`, { waitUntil: 'domcontentloaded' });
      const detached = () =>
        classic.evaluate(
          (sid) => (window as unknown as { app: { detachedSessions: Set<string> } }).app.detachedSessions.has(sid),
          id
        );
      await classic.waitForFunction(
        (sid) => (window as unknown as { app?: { sessions?: Map<string, unknown> } }).app?.sessions?.has(sid),
        id
      );
      expect(await detached()).toBe(false);
      await open();
      await row(id).click();
      const frame = await sessionPage(id);
      // The popped-out window protocol: the dashboard stops competing for the terminal's size.
      await vi.waitFor(async () => expect(await detached()).toBe(true), { timeout: 10000 });
      // The inventory's "Full view" rows are surfaces this page draws by itself.
      const drawn = await frame.evaluate(() => {
        const shown = (selector: string) => {
          const el = document.querySelector<HTMLElement>(selector);
          return !!el && el.getClientRects().length > 0;
        };
        const app = (window as unknown as { app: Record<string, unknown> }).app;
        return {
          terminal: shown('#terminalContainer .xterm'),
          voice: shown('#voiceInputBtn'),
          fileViewerButton: shown('.btn-file-viewer'),
          filePreviewOverlay: !!document.getElementById('filePreviewOverlay'),
          pasteUpload: typeof app._handleImagePaste === 'function',
          shortcutOverlay: !!document.getElementById('shortcutOverlayModal'),
          tabStrip: shown('#sessionTabs'),
          backKeyListed: (app.getShortcutRegistry as () => { id: string }[])().some((s) => s.id === 'back-to-canvas'),
        };
      });
      expect(drawn).toEqual({
        terminal: true,
        voice: true,
        fileViewerButton: true,
        filePreviewOverlay: true,
        pasteUpload: true,
        shortcutOverlay: true,
        tabStrip: false,
        backKeyListed: true,
      });
      await frame.locator('#soloCanvasBtn').click();
      await frames().waitFor({ state: 'detached' });
      // Closing the full view hands the session back to the dashboard.
      await vi.waitFor(async () => expect(await detached()).toBe(false), { timeout: 20000 });
    } finally {
      await classic.close();
    }
  }, 60000);

  it('leaves the session page alone when it was not opened by the canvas', async () => {
    const id = await start('plain');
    await page.goto(`${origin}/x/session/${id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('solo-mode'));
    await page.waitForFunction(
      () => (document.getElementById('soloRedockBtn') as HTMLElement | null)?.style.display === ''
    );
    expect(await page.locator('#soloCanvasBtn').count()).toBe(0);
    expect(
      await page.evaluate(() =>
        (window as unknown as { app: { getShortcutRegistry(): { id: string }[] } }).app
          .getShortcutRegistry()
          .some((s) => s.id === 'back-to-canvas')
      )
    ).toBe(false);
    // Opened from the canvas at the top level (what a phone does): Canvas navigates back to the workspace.
    await page.goto(`${origin}/x/session/${id}?from=canvas&ws=${alpha}`, { waitUntil: 'domcontentloaded' });
    await page.locator('#soloCanvasBtn').click();
    await page.waitForURL(new RegExp(`/x/canvas/${alpha}$`));
    // A malformed workspace goes to `/`, never to an address built from the query.
    await page.goto(`${origin}/x/session/${id}?from=canvas&ws=..%2F..%2Fevil`, { waitUntil: 'domcontentloaded' });
    await page.locator('#soloCanvasBtn').click();
    await page.waitForURL((url) => url.pathname.startsWith('/x/canvas/') || url.pathname === '/x/');
    expect(page.url()).not.toContain('evil');
  }, 60000);
});
