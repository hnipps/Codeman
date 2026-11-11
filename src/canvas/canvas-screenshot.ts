/**
 * @fileoverview Server PNG of one canvas container or object.
 * The page is hostile content: no login, no cookies, and every network request is
 * refused except image bytes this process already decoded from a stored data URL.
 * One render runs at a time. The caller's 20 second budget includes the wait.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchHeadlessBrowser } from '../headless-browser.js';
import {
  HierarchyError,
  bounds,
  descendants,
  isContainer,
  worldTransform,
  type CanvasObject,
  type CanvasState,
  type Transform,
} from './model.js';

export const SCREENSHOT_MARGIN = 48;
export const SCREENSHOT_MAX_SIDE = 4096;
export const SCREENSHOT_TIMEOUT_MS = 20_000;
export const SCREENSHOT_TIMEOUT_MESSAGE = 'Canvas screenshot timed out after 20 seconds.';
export const DOCUMENT_URL = 'https://codeman-canvas.invalid/screenshot';
const DOCUMENT_ORIGIN = 'https://codeman-canvas.invalid';
const MAX_STORED_IMAGE_BYTES = 2 * 1024 * 1024;
const LAUNCH_TIMEOUT_MS = 15_000;

export class ScreenshotNotFound extends Error {
  constructor() {
    super('Canvas object not found');
    this.name = 'ScreenshotNotFound';
  }
}
export class ScreenshotTimeout extends Error {
  constructor() {
    super(SCREENSHOT_TIMEOUT_MESSAGE);
    this.name = 'ScreenshotTimeout';
  }
}
export class ScreenshotUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScreenshotUnavailable';
  }
}

export interface WorldBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ShotFit {
  clip: WorldBox;
  scale: number;
  width: number;
  height: number;
  scaled: boolean;
  transform: string;
}
export interface ShotMeta {
  scaled: boolean;
  scale: number;
  width: number;
  height: number;
  clip: WorldBox;
}
export interface StoredImage {
  mime: string;
  bytes: Buffer;
}
export interface ShotRequest {
  url(): string;
  resourceType(): string;
  isNavigationRequest(): boolean;
  respond(options: { status: number; contentType: string; body: string | Buffer }): Promise<void> | void;
  abort(): Promise<void> | void;
}
export interface HeadlessPage {
  setViewport(viewport: { width: number; height: number; deviceScaleFactor: number }): Promise<void>;
  setCacheEnabled?(enabled: boolean): Promise<void>;
  setRequestInterception(enabled: boolean): Promise<void>;
  on(event: 'request', handler: (request: ShotRequest) => void): void;
  goto(url: string, options: { waitUntil: 'domcontentloaded' }): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
  screenshot(options: {
    type: 'png';
    clip: { x: number; y: number; width: number; height: number };
  }): Promise<Uint8Array>;
}
export interface HeadlessBrowser {
  newPage(): Promise<HeadlessPage>;
  close(): Promise<void>;
  process(): { pid?: number } | null;
}

const livePids = new Set<number>();
export function liveScreenshotBrowserPids(): number[] {
  return [...livePids];
}

let tail: Promise<void> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export function clipFor(box: WorldBox, margin = SCREENSHOT_MARGIN): WorldBox {
  return {
    x: box.x - margin,
    y: box.y - margin,
    width: Math.max(1, box.width) + margin * 2,
    height: Math.max(1, box.height) + margin * 2,
  };
}

export function fitClip(clip: WorldBox, maxSide = SCREENSHOT_MAX_SIDE): ShotFit {
  const longSide = Math.max(clip.width, clip.height);
  const scale = longSide > maxSide ? maxSide / longSide : 1;
  const width = Math.max(1, Math.floor(clip.width * scale));
  const height = Math.max(1, Math.floor(clip.height * scale));
  return {
    clip,
    scale,
    width,
    height,
    scaled: scale !== 1,
    transform: `translate(${-clip.x * scale}px, ${-clip.y * scale}px) scale(${scale})`,
  };
}

export function classifyShotRequest(
  url: string,
  resourceType: string,
  assets: ReadonlySet<string>
): 'document' | 'asset' | 'refuse' {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'refuse';
  }
  if (parsed.origin !== DOCUMENT_ORIGIN) return 'refuse';
  if (parsed.pathname === '/screenshot' && resourceType === 'document') return 'document';
  if (resourceType === 'image' && parsed.pathname.startsWith('/asset/')) {
    const id = decodeURIComponent(parsed.pathname.slice('/asset/'.length));
    if (assets.has(id)) return 'asset';
  }
  return 'refuse';
}

export function assetUrl(id: string): string {
  return `${DOCUMENT_ORIGIN}/asset/${encodeURIComponent(id)}`;
}

export function decodeStoredImage(url: string): StoredImage | null {
  if (!url.startsWith('data:image/') || url.length > 8192) return null;
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  const match = /^data:image\/(png|jpeg|gif|webp);base64$/i.exec(url.slice(0, comma));
  if (!match) return null;
  const payload = url.slice(comma + 1).replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 !== 0) return null;
  const bytes = Buffer.from(payload, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_STORED_IMAGE_BYTES) return null;
  return { mime: `image/${match[1].toLowerCase()}`, bytes };
}

export function handleShotRequest(request: ShotRequest, html: string, assets: ReadonlyMap<string, StoredImage>): void {
  const resourceType = request.isNavigationRequest() ? 'document' : request.resourceType();
  const decision = classifyShotRequest(request.url(), resourceType, new Set(assets.keys()));
  if (decision === 'document') {
    void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    return;
  }
  if (decision === 'asset') {
    const id = decodeURIComponent(new URL(request.url()).pathname.slice('/asset/'.length));
    const asset = assets.get(id);
    if (asset) {
      void request.respond({ status: 200, contentType: asset.mime, body: asset.bytes });
      return;
    }
  }
  void request.abort();
}

function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export interface ShotObject {
  id: string;
  type: string;
  parentId: string | null;
  order: number;
  position: { x: number; y: number };
  size: { width: number; height: number } | null;
  rotation: number;
  content: CanvasObject['content'];
  author: CanvasObject['author'];
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

function kept(state: CanvasState, object: CanvasObject, rootId: string): boolean {
  const seen = new Set<string>();
  let current: CanvasObject | undefined = object;
  while (current) {
    if (seen.has(current.id)) return false;
    seen.add(current.id);
    if (current.deletedAt !== null) return false;
    if (current.id === rootId) return true;
    current = current.parentId ? state.objects[current.parentId] : undefined;
  }
  return false;
}

export function shotModel(
  state: CanvasState,
  objectId: string
): { objects: ShotObject[]; fit: ShotFit; assets: Map<string, StoredImage> } {
  const root = state.objects[objectId];
  if (!root || root.deletedAt !== null) throw new ScreenshotNotFound();
  let box: ReturnType<typeof bounds>;
  try {
    box = bounds(state, objectId);
  } catch (error) {
    if (error instanceof HierarchyError) throw new Error('Cyclic hierarchy cannot be screenshotted');
    throw error;
  }
  if ('hierarchy' in box) throw new Error('Cyclic hierarchy cannot be screenshotted');
  let world: Transform;
  try {
    world = worldTransform(state, objectId);
  } catch (error) {
    if (error instanceof HierarchyError) throw new Error('Cyclic hierarchy cannot be screenshotted');
    throw error;
  }
  let raw: CanvasObject[];
  try {
    raw = isContainer(root) ? descendants(state, objectId) : [root];
  } catch (error) {
    if (error instanceof HierarchyError) throw new Error(error.message);
    throw error;
  }
  const objects = raw
    .filter((object) => kept(state, object, objectId))
    .map((object) => ({
      id: object.id,
      type: object.type,
      parentId: object.id === objectId ? null : object.parentId,
      order: object.order,
      position: object.id === objectId ? { x: world.x, y: world.y } : object.position,
      size: object.size,
      rotation: object.id === objectId ? world.rotation : object.rotation,
      content: object.content,
      author: object.author,
      createdAt: object.createdAt,
      updatedAt: object.updatedAt,
      deletedAt: object.deletedAt,
    }));
  const assets = new Map<string, StoredImage>();
  for (const object of objects) {
    const url = 'url' in object.content ? object.content.url : undefined;
    if (object.content.type !== 'image' || typeof url !== 'string') continue;
    const image = decodeStoredImage(url);
    if (image) assets.set(object.id, image);
  }
  return { objects, fit: fitClip(clipFor(box)), assets };
}

export function buildShotDocument(
  model: { objects: ShotObject[]; fit: ShotFit },
  css: string,
  script: string,
  theme: 'dark' | 'light'
): string {
  const images: { objectId: string; src: string }[] = [];
  for (const object of model.objects) {
    const url = 'url' in object.content ? object.content.url : undefined;
    if (object.content.type === 'image' && typeof url === 'string' && decodeStoredImage(url)) {
      images.push({ objectId: object.id, src: assetUrl(object.id) });
    }
  }
  const payload = { objects: model.objects, transform: model.fit.transform, images };
  const themeAttr = theme === 'light' ? ` data-theme="light"` : '';
  const safeCss = css.replace(/<\/style/gi, '<\\/style');
  const safeScript = script.replace(/<\/script/gi, '<\\/script');
  return `<!doctype html>
<html data-canvas${themeAttr}>
<head>
<meta charset="utf-8">
<style>${safeCss}</style>
<style>
html,body{background:var(--canvas);width:${model.fit.width}px;height:${model.fit.height}px}
#tree{display:none!important}
.object-body img{width:100%;height:100%;object-fit:contain}
</style>
</head>
<body>
<div id="board"><div id="layer"></div></div>
<div id="tree" hidden></div>
<script>${safeScript}</script>
<script>CodemanCanvasShot.paint(${embedJson(payload)})</script>
</body>
</html>`;
}

async function readBundles(): Promise<{ css: string; script: string }> {
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), '../web/public');
  try {
    const [css, script] = await Promise.all([
      readFile(join(publicDir, 'canvas.css'), 'utf8'),
      readFile(join(publicDir, 'canvas-shot.js'), 'utf8'),
    ]);
    if (!script.trim()) throw new Error('empty');
    return { css, script };
  } catch {
    throw new ScreenshotUnavailable('Canvas bundle is missing. Run npm run build:canvas.');
  }
}

function mapLaunchError(error: unknown): Error {
  if (
    error instanceof ScreenshotTimeout ||
    error instanceof ScreenshotUnavailable ||
    error instanceof ScreenshotNotFound
  ) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (
    /could not find chrome|failed to launch|no usable sandbox|executable doesn't exist|cannot find browser|the browser is not installed/i.test(
      message
    )
  ) {
    return new ScreenshotUnavailable('No headless browser is available. Run codeman mermaid setup.');
  }
  return error instanceof Error ? error : new Error(message);
}

async function closeHeadlessBrowser(browser: HeadlessBrowser): Promise<void> {
  try {
    await browser.close();
  } catch {
    // The pid check below is what proves the process is gone.
  }
  const pid = browser.process()?.pid;
  if (typeof pid !== 'number' || pid <= 0 || pid === process.pid) return;
  try {
    process.kill(pid, 0);
  } catch {
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

function delay(ms: number): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ScreenshotTimeout()), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

async function capture(
  browser: HeadlessBrowser,
  html: string,
  assets: Map<string, StoredImage>,
  fit: ShotFit
): Promise<Buffer> {
  const page = await browser.newPage();
  await page.setViewport({ width: fit.width, height: fit.height, deviceScaleFactor: 1 });
  if (page.setCacheEnabled) await page.setCacheEnabled(false);
  await page.setRequestInterception(true);
  page.on('request', (request) => handleShotRequest(request, html, assets));
  await page.goto(DOCUMENT_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(`(async () => {
    const deadline = Date.now() + 5000;
    while (document.documentElement.dataset.ready !== '1') {
      if (Date.now() > deadline) throw new Error('Canvas screenshot page did not paint');
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    await Promise.all([...document.images].map((img) => (img.complete ? undefined : img.decode().catch(() => undefined))));
  })()`);
  const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: fit.width, height: fit.height } });
  return Buffer.from(png);
}

export interface RenderContainerOptions {
  theme?: 'dark' | 'light';
  timeoutMs?: number;
  launch?: (options: { noSandbox?: boolean; timeoutMs?: number }) => Promise<HeadlessBrowser>;
  readAssets?: () => Promise<{ css: string; script: string }>;
}

export async function renderContainer(
  state: CanvasState,
  objectId: string,
  options: RenderContainerOptions = {}
): Promise<{ png: Buffer; meta: ShotMeta }> {
  const theme = options.theme ?? 'dark';
  const model = shotModel(state, objectId);
  const bundles = await (options.readAssets ?? readBundles)();
  const html = buildShotDocument(model, bundles.css, bundles.script, theme);
  const launch = options.launch ?? ((launchOptions) => launchHeadlessBrowser(launchOptions));
  const timeoutMs = options.timeoutMs ?? SCREENSHOT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const meta: ShotMeta = {
    scaled: model.fit.scaled,
    scale: model.fit.scale,
    width: model.fit.width,
    height: model.fit.height,
    clip: model.fit.clip,
  };
  const job = enqueue(async () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ScreenshotTimeout();
    let browser: HeadlessBrowser | undefined;
    try {
      try {
        browser = await launch({ timeoutMs: Math.min(LAUNCH_TIMEOUT_MS, remaining) });
      } catch (error) {
        throw mapLaunchError(error);
      }
      const pid = browser.process()?.pid;
      if (typeof pid === 'number' && pid > 0) livePids.add(pid);
      const left = deadline - Date.now();
      if (left <= 0) throw new ScreenshotTimeout();
      const gate = delay(left);
      const painting = capture(browser, html, model.assets, model.fit);
      painting.catch(() => undefined);
      try {
        const png = await Promise.race([painting, gate.promise]);
        return { png, meta };
      } finally {
        gate.cancel();
      }
    } finally {
      if (browser) {
        const pid = browser.process()?.pid;
        await closeHeadlessBrowser(browser);
        if (typeof pid === 'number') livePids.delete(pid);
      }
    }
  });
  job.catch(() => undefined);
  const outer = delay(timeoutMs);
  try {
    return await Promise.race([job, outer.promise]);
  } finally {
    outer.cancel();
  }
}
