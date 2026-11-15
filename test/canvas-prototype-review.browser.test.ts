/**
 * Reviewing a stored prototype from a phone: the card's picture of the version its embed shows, Review from the
 * object sheet, Pick and comment inside the full-screen page, the pin following its element into a version that
 * renamed it, "not in v<n>" with a crop once a version drops it, the Desktop width, and a new version announced
 * rather than loaded.
 *
 * Everything is real: the server, the stored prototype, the frame bridge, the headless picture renderer. The phone
 * is a 390 px viewport with the touch branch forced (`window.__canvasTouch`), since headless Chromium has no touch.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright';
import puppeteer from 'puppeteer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { WebServer } from '../src/web/server.js';
import { dataPath } from '../src/config/instance.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';
import { stopScreenshotRenders } from '../src/canvas/canvas-screenshot.js';

const installed = vi.hoisted(() => ({ map: { claude: true } as Record<string, boolean> }));
vi.mock('../src/utils/cli-installed-probes.js', async (original) => ({
  ...(await original<typeof import('../src/utils/cli-installed-probes.js')>()),
  probeStockCliAvailability: async () => installed.map,
}));

const SHOTS = process.env.CANVAS_PROTOTYPE_REVIEW_SHOTS || resolve(tmpdir(), 'codeman-canvas-prototype-review');
const stamp = Date.now();

/** The Work page at three versions: v2 renames the button's id and class, v3 has no button at all. */
const work = (version: number) => `<!doctype html><html><head><meta name="viewport" content="width=device-width">
<title>Work</title><style>
  body{margin:0;font:15px system-ui;background:#f4f1ea;color:#222}
  header{padding:14px 16px;font-weight:600;background:#fff;border-bottom:1px solid #ccc}
  .list{padding:12px;display:grid;gap:8px}
  .card{padding:12px;background:#fff;border:1px solid #bbb;border-radius:6px}
  button{font:inherit;padding:8px 12px}
</style></head><body><header>Work · v${version}</header><main class="list">
  <article class="card"><p>Ship the phone review</p>
  ${version === 1 ? '<button id="start" class="go">Start task</button>' : ''}
  ${version === 2 ? '<p>Moved</p><button id="begin" class="primary">Start task</button>' : ''}
  </article>
  <article class="card"><p>Write the journal entry</p></article>
</main></body></html>`;

describe('reviewing a prototype from a phone', () => {
  let server: WebServer, browser: Browser, context: BrowserContext, page: Page, origin: string, workspace: string;

  beforeAll(async () => {
    vi.stubEnv('CODEMAN_INSTANCE', 'lane-canvas-prototype-review');
    writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasEnabled: true, canvasShellEnabled: false }));
    // The picture renderer's sandbox flag is this test host's business, as in the prototype check's own test.
    writeFileSync(dataPath('mermaid-runtime.json'), JSON.stringify({ noSandbox: true }));
    server = new WebServer(0, false, true, undefined, undefined, undefined, '/x');
    await server.start();
    origin = `http://localhost:${server.boundPort}`;
    browser = await chromium.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: ['--no-sandbox'],
    });
    mkdirSync(SHOTS, { recursive: true });
    const name = 'Canvas prototype review';
    mkdirSync(resolve(resolveCasesDir(), name), { recursive: true });
    workspace = workspaceForCase(name).id;
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    await context.addInitScript(() => {
      (window as unknown as { __canvasTouch: boolean }).__canvasTouch = true;
    });
    page = await context.newPage();
  }, 60000);
  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await stopScreenshotRenders();
    await server?.stop();
    vi.unstubAllEnvs();
  }, 60000);

  const api = (path: string) => `${origin}/x/api/canvas/${workspace}${path}`;
  const shot = (name: string) =>
    page.screenshot({ animations: 'disabled', path: resolve(SHOTS, `prototype-review-${stamp}-${name}.png`) });
  async function publish(version: number, objectId?: string): Promise<string> {
    const response = await page.request.post(api('/prototypes'), {
      data: {
        id: 'work',
        name: 'Work',
        files: [{ path: 'index.html', base64: Buffer.from(work(version)).toString('base64') }],
        ...(objectId ? { objectId } : { position: { x: 20, y: 20 }, size: { width: 340, height: 520 } }),
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
    const body = (await response.json()) as { data: { objectId: string; version: number } };
    expect(body.data.version).toBe(version);
    return body.data.objectId;
  }
  const reviewFrame = async (): Promise<Frame> =>
    (await (await page.waitForSelector('#protoReviewStage > iframe')).contentFrame())!;
  /** The review's page is up and its bridge has spoken (Pick turns on then). */
  async function reviewLive(): Promise<Frame> {
    const frame = await reviewFrame();
    await frame.waitForLoadState('domcontentloaded');
    await page.waitForSelector('#protoReviewPick:not([disabled])', { timeout: 15000 });
    return frame;
  }
  /** An element of the review's page, in the canvas page's own pixels. */
  async function inReview(selector: string) {
    const frameBox = (await page.locator('#protoReviewStage > iframe').boundingBox())!;
    const scale =
      frameBox.width /
      (await page.locator('#protoReviewStage > iframe').evaluate((f) => (f as HTMLElement).offsetWidth));
    const r = await (await reviewFrame()).locator(selector).evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    });
    return {
      x: frameBox.x + r.x * scale,
      y: frameBox.y + r.y * scale,
      width: r.width * scale,
      height: r.height * scale,
    };
  }

  let objectId = '';

  it('shows a picture of the version on the phone card, and Review in the object sheet', async () => {
    objectId = await publish(1);
    await page.goto(`${origin}/x/canvas/${workspace}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.canvasEdit?.read().status === 'saved');
    const card = page.locator(`[data-object-id="${objectId}"] .proto-card`);
    await expect.poll(() => card.count(), { timeout: 15000 }).toBe(1);
    // The phone runs no live frame on the board: the card is a picture the server drew of v1.
    expect(await page.locator(`[data-object-id="${objectId}"] iframe`).count()).toBe(0);
    await expect
      .poll(
        () =>
          card
            .locator('img.proto-pic')
            .evaluate((img) => (img as HTMLImageElement).naturalWidth)
            .catch(() => 0),
        {
          timeout: 60000,
        }
      )
      .toBe(390);
    await expect
      .poll(() => card.locator('.proto-foot').textContent(), { timeout: 10000 })
      .toMatch(/^Published .+ by .+/);
    await shot('card');

    await page.evaluate((id) => {
      window.canvasView.dispatch({ kind: 'focus', id });
      window.canvasView.dispatch({ kind: 'selection', ids: [id] });
    }, objectId);
    await page.waitForSelector('#sheet:not([hidden])');
    expect(await page.locator('#sheetPrototypeReview').isVisible()).toBe(true);
    expect(await page.locator('#sheetPrototypeReview').getAttribute('class')).toContain('primary');
    await shot('sheet');
  }, 120000);

  it('opens the live page full screen, picks an element and posts a comment about it, on v1', async () => {
    await page.locator('#sheetPrototypeReview').click();
    await page.waitForSelector('#protoReview:not([hidden])');
    expect(await page.locator('#sheet').isHidden()).toBe(true);
    const frame = await reviewLive();
    expect(await frame.locator('header').textContent()).toBe('Work · v1');
    expect(await page.locator('#protoReviewTitle').textContent()).toBe('Work');
    expect(await page.locator('#protoReviewMeta').textContent()).toMatch(/^v1 · .+/);
    // Every touch goes to the page: nothing lies over the frame.
    const button = await inReview('#start');
    const top = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.tagName,
      [button.x + button.width / 2, button.y + button.height / 2]
    );
    expect(top).toBe('IFRAME');
    await shot('review');

    await page.locator('#protoReviewPick').click();
    await page.waitForFunction((id) => window.canvasFrames.picking() === id, objectId);
    expect(await page.locator('#protoReviewHint').isVisible()).toBe(true);
    await frame.waitForSelector('[data-codeman-frame-bridge]', { state: 'attached' });
    // The hint lies over the width row: the page did not move when Pick started.
    expect(await inReview('#start')).toEqual(button);
    await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
    // The thread opens over the review as a sheet, the element attached to the draft.
    await page.waitForSelector('#threadView:not([hidden])');
    expect(await page.locator('#protoReviewHint').isHidden()).toBe(true);
    await page.locator('#commentDraft').fill('Make this the primary action');
    await shot('compose');
    await page.locator('#postComment').click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#threadList .comment-text')].some(
        (p) => p.textContent === 'Make this the primary action'
      )
    );
    const comment = page.locator('#threadList .comment').last();
    await expect.poll(() => comment.locator('.comment-version').textContent(), { timeout: 10000 }).toBe('on v1');
    await expect.poll(() => comment.locator('.element-where').textContent()).toBe('#start');
    expect(await comment.locator('.comment-element').getAttribute('data-state')).toBe('found');
    await shot('thread');
    // Closing the thread leaves the review, with a numbered pin on the element.
    await page.locator('#closeRail').click();
    await page.waitForSelector('#rail', { state: 'hidden' });
    expect(await page.locator('#protoReview').isVisible()).toBe(true);
    await expect.poll(() => page.locator('#elementPins .element-pin').count(), { timeout: 10000 }).toBe(1);
    expect(await page.locator('#protoReviewCount').textContent()).toBe('1');
    await shot('pin');
  }, 120000);

  it('announces a new version without loading it, then follows the element into it after Reload', async () => {
    await publish(2, objectId);
    await page.waitForSelector('#protoReviewNew:not([hidden])', { timeout: 15000 });
    expect(await page.locator('#protoReviewNewText').textContent()).toBe('v2 is ready');
    // Nothing reloaded by itself.
    expect(await (await reviewFrame()).locator('header').textContent()).toBe('Work · v1');
    await shot('new-version');
    await page.locator('#protoReviewNewReload').click();
    const frame = await reviewLive();
    await expect.poll(() => frame.locator('header').textContent()).toBe('Work · v2');
    expect(await page.locator('#protoReviewNew').isHidden()).toBe(true);
    await expect.poll(() => page.locator('#protoReviewMeta').textContent()).toMatch(/^v2 · /);
    // The selector #start finds nothing in v2; the pin follows the button by its tag and text.
    await expect.poll(() => page.locator('#elementPins .element-pin').count(), { timeout: 10000 }).toBe(1);
    const pin = (await page.locator('#elementPins .element-pin').boundingBox())!;
    const begin = await inReview('#begin');
    expect(Math.abs(pin.y + pin.height / 2 - begin.y)).toBeLessThan(24);
  }, 120000);

  it('shows the page at desktop width scaled to fit, and still usable', async () => {
    await page.locator('#protoReviewDesktop').click();
    const frame = page.locator('#protoReviewStage > iframe');
    await expect.poll(() => frame.evaluate((f) => (f as HTMLElement).style.width)).toBe('1280px');
    expect(await frame.evaluate((f) => (f as HTMLElement).style.transform)).toMatch(/^scale\(0\.\d+\)$/);
    expect((await frame.boundingBox())!.width).toBeLessThanOrEqual(391);
    expect(await page.locator('#protoReviewWidthNote').textContent()).toMatch(/^1280 px at \d+%$/);
    await shot('desktop');
    await page.locator('#protoReviewPhone').click();
    await expect.poll(() => frame.evaluate((f) => (f as HTMLElement).style.transform)).toBe('');
  }, 60000);

  it('says the element is not in a version that dropped it, and shows where it was in v1', async () => {
    await publish(3, objectId);
    await page.waitForSelector('#protoReviewNew:not([hidden])', { timeout: 15000 });
    await page.locator('#protoReviewNewReload').click();
    const frame = await reviewLive();
    await expect.poll(() => frame.locator('header').textContent()).toBe('Work · v3');
    await expect.poll(() => page.locator('#elementPins .element-pin').count(), { timeout: 10000 }).toBe(0);
    await page.locator('#protoReviewComments').click();
    await page.waitForSelector('#threadView:not([hidden])');
    const comment = page.locator('#threadList .comment').last();
    await expect.poll(() => comment.locator('.element-where').textContent(), { timeout: 10000 }).toBe('Not in v3');
    expect(await comment.locator('.comment-version').textContent()).toBe('on v1');
    await expect
      .poll(
        () =>
          comment
            .locator('.comment-crop img')
            .evaluate((img) => (img as HTMLImageElement).naturalWidth)
            .catch(() => 0),
        {
          timeout: 60000,
        }
      )
      .toBeGreaterThan(0);
    expect(await comment.locator('.comment-crop figcaption').textContent()).toBe('Where it was in v1');
    await shot('not-in');
    await page.locator('#closeRail').click();
  }, 120000);

  it('Back closes the review and removes its frame', async () => {
    await page.locator('#protoReviewBack').click();
    await page.waitForSelector('#protoReview', { state: 'hidden' });
    expect(await page.locator('#protoReviewStage iframe').count()).toBe(0);
    expect(await page.evaluate(() => 'review' in document.documentElement.dataset)).toBe(false);
    // The card now shows v3's picture.
    const card = page.locator(`[data-object-id="${objectId}"] .proto-card`);
    await expect
      .poll(
        () =>
          card
            .locator('img.proto-pic')
            .evaluate((img) => (img as HTMLImageElement).naturalWidth)
            .catch(() => 0),
        {
          timeout: 60000,
        }
      )
      .toBe(390);
    await shot('back');
  }, 90000);
});
