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
export const SCREENSHOT_CLOSE_BUDGET_MS = 2_000;
export const SCREENSHOT_EXIT_WAIT_MS = 2_000;
export const SCREENSHOT_MISCONFIGURED_MESSAGE = 'Screenshot renderer is misconfigured on this server';
export const SCREENSHOT_FAILED_MESSAGE = 'Canvas screenshot failed';
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
export class ScreenshotMisconfigured extends Error {
  constructor() {
    super(SCREENSHOT_MISCONFIGURED_MESSAGE);
    this.name = 'ScreenshotMisconfigured';
  }
}
export class ScreenshotAborted extends Error {
  constructor() {
    super('Canvas screenshot aborted');
    this.name = 'ScreenshotAborted';
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
let activeRenders = new AbortController();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const previous = tail;
  let release = (): void => undefined;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = (): Promise<T> => {
    const job = fn();
    job.then(
      () => undefined,
      () => undefined
    );
    // The queue is released here. This finally must not await: a hung
    // browser.close() stays inside the job, which bounds that wait itself.
    return job.finally(() => {
      release();
    });
  };
  return previous.then(run, run);
}

/** Abort in-flight renders and wait until their bounded cleanup releases the queue. */
export async function stopScreenshotRenders(): Promise<void> {
  const stopping = activeRenders;
  activeRenders = new AbortController();
  stopping.abort();
  const pending = tail;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, SCREENSHOT_CLOSE_BUDGET_MS + SCREENSHOT_EXIT_WAIT_MS + 1_000);
    pending.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      }
    );
  });
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
  if (resourceType === 'image') {
    const key = shotKeyFromPath(parsed.pathname);
    if (key && assets.has(key)) return 'asset';
  }
  return 'refuse';
}

/**
 * Keys of the bytes one screenshot is handed. They are NAMESPACED, so a data-URL image object
 * (`object:<object id>`) can never stand in for a stored asset (`asset:<hash>`), even when an
 * object id happens to be the 64-hex hash of another asset.
 */
export const objectImageKey = (objectId: string): string => `object:${objectId}`;
export const storedAssetKey = (assetId: string): string => `asset:${assetId}`;

/** The document URL for one key: `/object/<id>` or `/asset/<hash>` (what the page itself asks for). */
export function assetUrl(key: string): string {
  const colon = key.indexOf(':');
  return `${DOCUMENT_ORIGIN}/${key.slice(0, colon)}/${encodeURIComponent(key.slice(colon + 1))}`;
}

function shotKeyFromPath(pathname: string): string | null {
  const match = /^\/(object|asset)\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  try {
    return `${match[1]}:${decodeURIComponent(match[2])}`;
  } catch {
    return null;
  }
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
    const key = shotKeyFromPath(new URL(request.url()).pathname);
    const asset = key ? assets.get(key) : undefined;
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

/** Stored asset bytes one screenshot may embed in total; images past it draw their unavailable note. */
export const MAX_SHOT_ASSET_BYTES = 48 * 1024 * 1024;
/** Asset ids an object draws from its stored bytes: an image's own, a link or embed card's thumbnail. */
export function objectAssetIds(content: { type: string } & Record<string, unknown>): string[] {
  return [content.assetId, content.thumbnailAssetId].filter(
    (id): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)
  );
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
    if (image) assets.set(objectImageKey(object.id), image);
  }
  return { objects, fit: fitClip(clipFor(box)), assets };
}

/**
 * Read the stored assets the model's objects draw, asynchronously and bounded: each read is
 * handed the bytes still left of `MAX_SHOT_ASSET_BYTES` and must refuse (null) anything larger,
 * so no read ever loads more than the screenshot may embed.
 */
export async function loadShotAssets(
  model: { objects: ShotObject[]; assets: Map<string, StoredImage> },
  readAsset: (assetId: string, maxBytes: number) => Promise<StoredImage | null>,
  signal?: AbortSignal
): Promise<void> {
  let budget = MAX_SHOT_ASSET_BYTES;
  for (const object of model.objects) {
    for (const assetId of objectAssetIds(object.content)) {
      const key = storedAssetKey(assetId);
      if (model.assets.has(key) || budget <= 0) continue;
      if (signal?.aborted) throw new ScreenshotAborted();
      const image = await readAsset(assetId, budget);
      if (!image || image.bytes.length > budget) continue;
      budget -= image.bytes.length;
      model.assets.set(key, image);
    }
  }
}

export function buildShotDocument(
  model: { objects: ShotObject[]; fit: ShotFit; assets?: ReadonlyMap<string, StoredImage> },
  css: string,
  script: string,
  theme: 'dark' | 'light'
): string {
  const images: { objectId: string; src: string }[] = [];
  for (const object of model.objects) {
    const url = 'url' in object.content ? object.content.url : undefined;
    if (object.content.type === 'image' && typeof url === 'string' && decodeStoredImage(url)) {
      images.push({ objectId: object.id, src: assetUrl(objectImageKey(object.id)) });
    }
  }
  const stored = [...(model.assets?.keys() ?? [])]
    .filter((key) => key.startsWith('asset:'))
    .map((key) => key.slice('asset:'.length));
  const payload = { objects: model.objects, transform: model.fit.transform, images, assets: stored };
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

const BROWSER_MISSING =
  /could not find chrome|failed to launch|no usable sandbox|executable doesn't exist|cannot find browser|the browser is not installed/i;
const ABSOLUTE_PATH = /(?:^|[\s"'`(:=])\/(?:[\w.+@~-]+\/)+[\w.+@~-]*/;

export function messageHasAbsolutePath(text: string): boolean {
  return ABSOLUTE_PATH.test(text) || /[A-Za-z]:\\[\w .+@~-]+\\/.test(text);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logScreenshotError(error: unknown): void {
  console.error(`[canvas-screenshot] ${errorMessage(error)}`);
}

function isRuntimeConfigFailure(error: unknown): boolean {
  if (errorMessage(error).startsWith('Invalid Mermaid runtime configuration')) return true;
  const path = (error as { path?: unknown } | null)?.path;
  return typeof path === 'string' && path.endsWith('mermaid-runtime.json');
}

function isScreenshotError(error: unknown): boolean {
  return (
    error instanceof ScreenshotTimeout ||
    error instanceof ScreenshotUnavailable ||
    error instanceof ScreenshotNotFound ||
    error instanceof ScreenshotMisconfigured ||
    error instanceof ScreenshotAborted
  );
}

export function classifyScreenshotError(error: unknown): Error {
  if (isScreenshotError(error)) return error as Error;
  if (isRuntimeConfigFailure(error)) {
    logScreenshotError(error);
    return new ScreenshotMisconfigured();
  }
  const message = errorMessage(error);
  if (BROWSER_MISSING.test(message)) {
    if (messageHasAbsolutePath(message)) logScreenshotError(error);
    return new ScreenshotUnavailable('No headless browser is available. Run codeman mermaid setup.');
  }
  if (messageHasAbsolutePath(message)) {
    logScreenshotError(error);
    return new Error(SCREENSHOT_FAILED_MESSAGE);
  }
  return error instanceof Error ? error : new Error(message);
}

export function screenshotFailure(error: unknown): { status: number; message: string } {
  const mapped = classifyScreenshotError(error);
  if (mapped instanceof ScreenshotNotFound) return { status: 404, message: mapped.message };
  if (
    mapped instanceof ScreenshotTimeout ||
    mapped instanceof ScreenshotUnavailable ||
    mapped instanceof ScreenshotAborted
  ) {
    return { status: 503, message: mapped.message };
  }
  if (mapped instanceof ScreenshotMisconfigured) return { status: 500, message: mapped.message };
  return { status: 500, message: mapped.message };
}

async function killBrowserPid(pid: number | undefined): Promise<void> {
  if (typeof pid !== 'number' || pid <= 1 || pid === process.pid) return;
  try {
    process.kill(pid, 0);
  } catch {
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return;
  }
  // Drop the pid as soon as it is killed. The exit wait below can outlive the
  // caller's view of the signal, and a killed browser is not still rendering.
  livePids.delete(pid);
  await new Promise<void>((resolve) => {
    const started = Date.now();
    const tick = (): void => {
      try {
        process.kill(pid, 0);
      } catch {
        resolve();
        return;
      }
      if (Date.now() - started >= SCREENSHOT_EXIT_WAIT_MS) {
        resolve();
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

async function closeHeadlessBrowser(browser: HeadlessBrowser): Promise<void> {
  const pid = browser.process()?.pid;
  const closing = browser.close().then(
    () => undefined,
    () => undefined
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    closing,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SCREENSHOT_CLOSE_BUDGET_MS);
    }),
  ]);
  clearTimeout(timer);
  await killBrowserPid(pid);
}

function whenAborted(signal: AbortSignal): { promise: Promise<never>; cancel: () => void } {
  let onAbort = (): void => undefined;
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => reject(new ScreenshotAborted());
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  return { promise, cancel: () => signal.removeEventListener('abort', onAbort) };
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
  signal?: AbortSignal;
  launch?: (options: { noSandbox?: boolean; timeoutMs?: number }) => Promise<HeadlessBrowser>;
  readAssets?: () => Promise<{ css: string; script: string }>;
  /**
   * Stored image bytes by asset id, read asynchronously; null for anything over `maxBytes`. The
   * page is handed them and never fetches anything else.
   */
  readAsset?: (assetId: string, maxBytes: number) => Promise<StoredImage | null>;
}

export async function renderContainer(
  state: CanvasState,
  objectId: string,
  options: RenderContainerOptions = {}
): Promise<{ png: Buffer; meta: ShotMeta }> {
  const theme = options.theme ?? 'dark';
  const launch = options.launch ?? ((launchOptions) => launchHeadlessBrowser(launchOptions));
  const timeoutMs = options.timeoutMs ?? SCREENSHOT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const signal = options.signal ? AbortSignal.any([activeRenders.signal, options.signal]) : activeRenders.signal;
  const job = enqueue(async () => {
    if (signal.aborted) throw new ScreenshotAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ScreenshotTimeout();
    const model = shotModel(state, objectId);
    if (options.readAsset) await loadShotAssets(model, options.readAsset, signal);
    const bundles = await (options.readAssets ?? readBundles)();
    const html = buildShotDocument(model, bundles.css, bundles.script, theme);
    const meta: ShotMeta = {
      scaled: model.fit.scaled,
      scale: model.fit.scale,
      width: model.fit.width,
      height: model.fit.height,
      clip: model.fit.clip,
    };
    let browser: HeadlessBrowser | undefined;
    try {
      try {
        browser = await launch({ timeoutMs: Math.min(LAUNCH_TIMEOUT_MS, remaining) });
      } catch (error) {
        throw classifyScreenshotError(error);
      }
      if (signal.aborted) throw new ScreenshotAborted();
      const pid = browser.process()?.pid;
      if (typeof pid === 'number' && pid > 0) livePids.add(pid);
      const left = deadline - Date.now();
      if (left <= 0) throw new ScreenshotTimeout();
      const gate = delay(left);
      const painting = capture(browser, html, model.assets, model.fit);
      painting.catch(() => undefined);
      const aborted = whenAborted(signal);
      try {
        const png = await Promise.race([painting, gate.promise, aborted.promise]);
        return { png, meta };
      } finally {
        gate.cancel();
        aborted.cancel();
      }
    } finally {
      if (browser) {
        const pid = browser.process()?.pid;
        try {
          await closeHeadlessBrowser(browser);
        } finally {
          if (typeof pid === 'number') livePids.delete(pid);
        }
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
