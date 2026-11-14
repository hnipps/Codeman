/**
 * @fileoverview Capture a running web app as a clickable static prototype: drive it in headless
 * Chromium through the named states of a spec (`capture-spec.ts`), save each state as a static page
 * whose scripts are gone and whose stylesheets, fonts and images are local files, and join the pages
 * with hotspots and a state switcher (`capture-runtime.ts`).
 *
 * ⚠️ This runs on the AGENT's side only: the `codeman mcp` client (`canvas_prototype capture`) and
 * `codeman prototype capture`. The Codeman server never imports it, so the server gains no
 * fetch-any-address surface; the server only ever receives the finished folder through the ordinary
 * publish route and its limits. The browser comes from `launchHeadlessBrowser()`, the same launch (and
 * `mermaid-runtime.json` sandbox and library choices) the Mermaid renderer and prototype checks use.
 *
 * Output layout: `<viewport>/<state>.html` per state and viewport, `assets/<sha256>.<ext>` shared by
 * every page (stylesheets included, so a large stylesheet is stored once), `index.html` (every state),
 * and `capture.json` (the states, hotspots and warnings). The entry is the first state at the first
 * viewport.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Browser, HTTPResponse, Page } from 'puppeteer';
import { PROTOTYPE_MAX_FILE_BYTES, PROTOTYPE_MAX_FILES, PROTOTYPE_MAX_VERSION_BYTES } from '../config/canvas-limits.js';
import { launchHeadlessBrowser } from '../headless-browser.js';
import {
  CaptureSpecError,
  hotspotFor,
  parseCaptureSpec,
  stateAt,
  statePagePath,
  stepsToReach,
  type CaptureSpec,
  type CaptureStep,
  type CaptureViewport,
} from './capture-spec.js';
import { snapshotSource, tokenizeCss, type Snapshot } from './capture-page.js';
import { HOTSPOT_ATTR, captureRuntimeScript, type CaptureRuntimeData } from './capture-runtime.js';
import { PrototypeRefusedError, checkPrototypeFiles, type PrototypeFile } from './prototypes.js';

export class CaptureError extends Error {}

export const CAPTURE_STEP_TIMEOUT_MS = 15_000;
export const CAPTURE_TIMEOUT_MS = 5 * 60_000;
const INLINE_STYLE_MAX = 4096;
const CSS_IMPORT_DEPTH = 4;
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const megabytes = (bytes: number): string => `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;

/** File extension a captured asset is stored under, or null when a prototype cannot hold that type. */
export function assetExtension(contentType: string | null, url: string): string | null {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  const byType: Record<string, string> = {
    'text/css': 'css',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'font/woff': 'woff',
    'application/font-woff': 'woff',
    'application/x-font-woff': 'woff',
    'font/woff2': 'woff2',
    'application/font-woff2': 'woff2',
    'font/ttf': 'ttf',
    'application/x-font-ttf': 'ttf',
    'font/sfnt': 'ttf',
    // OpenType is a superset of the TrueType container; browsers sniff font data, not the name.
    'font/otf': 'ttf',
    'application/x-font-otf': 'ttf',
  };
  if (byType[type]) return byType[type];
  let path = '';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    path = '';
  }
  const ext = /\.([a-z0-9]+)$/.exec(path)?.[1] ?? '';
  const byName: Record<string, string> = {
    css: 'css',
    png: 'png',
    jpg: 'jpg',
    jpeg: 'jpg',
    gif: 'gif',
    webp: 'webp',
    svg: 'svg',
    woff: 'woff',
    woff2: 'woff2',
    ttf: 'ttf',
    otf: 'ttf',
  };
  return byName[ext] ?? null;
}

/** Replace a snapshot's tokens: addresses by number, canvas pictures by `c<number>`. */
export function replaceTokens(text: string, nonce: string, path: (key: string) => string | null): string {
  return text.replace(new RegExp(`__cca${nonce}_(c?\\d+)__`, 'g'), (_whole, key: string) => path(key) ?? 'data:,');
}

/** First in every page's head: the charset, and an icon so the browser asks for no `/favicon.ico`. */
const HEAD_START = '<meta charset="utf-8"><link rel="icon" href="data:,">';

const attrValue = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/**
 * One state page from its snapshot: the sheet placeholders filled, a charset first in the head, and
 * the runtime last in the body. `sheets[i]` is the markup that replaces placeholder `i`.
 */
export function assembleStatePage(input: {
  html: string;
  nonce: string;
  sheets: string[];
  path: (key: string) => string | null;
  runtime: CaptureRuntimeData;
}): string {
  let html = input.html.replace(
    new RegExp(`<!--cca${input.nonce}-sheet-(\\d+)-->`, 'g'),
    (_whole, n: string) => input.sheets[Number(n)] ?? ''
  );
  html = replaceTokens(html, input.nonce, input.path);
  const head = /<head[^>]*>/i.exec(html);
  html = head
    ? html.slice(0, head.index + head[0].length) + HEAD_START + html.slice(head.index + head[0].length)
    : html.replace(/^<!doctype html>\n?/i, `<!doctype html>\n${HEAD_START}`);
  const script = captureRuntimeScript(input.runtime);
  const end = html.toLowerCase().lastIndexOf('</body>');
  return end >= 0 ? html.slice(0, end) + script + html.slice(end) : html + script;
}

export interface CaptureOptions {
  launch?: () => Promise<Browser>;
  noSandbox?: boolean;
  timeoutMs?: number;
  stepTimeoutMs?: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export interface CapturedPrototype {
  files: PrototypeFile[];
  entry: string;
  /** Things that did not come across (an image the page could not load, a hotspot not found). */
  warnings: string[];
  states: { name: string; label: string; pages: string[] }[];
  hotspots: { from: string; to: string; selector: string }[];
  bytes: number;
}

type Fetched = { bytes: Buffer; contentType: string | null } | null;

/** The assets every page shares: one file per distinct content, one fetch per address. */
class AssetStore {
  readonly files = new Map<string, Buffer>();
  private readonly byUrl = new Map<string, Promise<string | null>>();
  constructor(
    private readonly warnings: string[],
    private readonly nonce: string
  ) {}

  bytes(): number {
    let total = 0;
    for (const data of this.files.values()) total += data.length;
    return total;
  }

  /** Store bytes under their content hash; the file name, relative to `assets/`. */
  save(data: Buffer, ext: string, source: string): string {
    if (data.length > PROTOTYPE_MAX_FILE_BYTES)
      throw new CaptureError(
        `${source} is ${megabytes(data.length)}, over the ${megabytes(PROTOTYPE_MAX_FILE_BYTES)} limit for one prototype file`
      );
    const name = `${createHash('sha256').update(data).digest('hex').slice(0, 20)}.${ext}`;
    this.files.set(name, data);
    if (this.files.size > PROTOTYPE_MAX_FILES)
      throw new CaptureError(
        `The capture needs more than ${PROTOTYPE_MAX_FILES} files, the most a prototype holds. Capture fewer states or viewports.`
      );
    if (this.bytes() > PROTOTYPE_MAX_VERSION_BYTES)
      throw new CaptureError(
        `The capture's files pass ${megabytes(PROTOTYPE_MAX_VERSION_BYTES)}, the limit for one prototype version. Capture fewer states or viewports.`
      );
    return name;
  }

  /** The file name an address is stored under, fetching it the first time; null when it did not come across. */
  asset(url: string, fetch: (url: string) => Promise<Fetched>, depth = 0): Promise<string | null> {
    let known = this.byUrl.get(url);
    if (!known) {
      known = this.load(url, fetch, depth);
      this.byUrl.set(url, known);
    }
    return known;
  }

  private async load(url: string, fetch: (url: string) => Promise<Fetched>, depth: number): Promise<string | null> {
    const got = await fetch(url);
    if (!got) {
      this.warnings.push(`Not captured (could not be read): ${url.slice(0, 200)}`);
      return null;
    }
    const ext = assetExtension(got.contentType, url);
    if (!ext) {
      this.warnings.push(
        `Not captured (${got.contentType ?? 'unknown type'} is not a type a prototype holds): ${url.slice(0, 200)}`
      );
      return null;
    }
    if (ext === 'css') {
      if (depth >= CSS_IMPORT_DEPTH) {
        this.warnings.push(`Not captured (stylesheet imports nested too deep): ${url.slice(0, 200)}`);
        return null;
      }
      return this.save(Buffer.from(await this.css(got.bytes.toString('utf8'), url, fetch, depth + 1)), 'css', url);
    }
    return this.save(got.bytes, ext, url);
  }

  /** A stylesheet that will live in `assets/`, its addresses pointing at sibling files. */
  async css(text: string, base: string, fetch: (url: string) => Promise<Fetched>, depth = 0): Promise<string> {
    const found: string[] = [];
    const tokenized = tokenizeCss(text, base, (absolute) => {
      if (!/^(https?|blob):/i.test(absolute)) return null;
      found.push(absolute);
      return `__ccacss${this.nonce}_${found.length - 1}__`;
    });
    const names = await Promise.all(found.map((url) => this.asset(url, fetch, depth)));
    return tokenized.replace(
      new RegExp(`__ccacss${this.nonce}_(\\d+)__`, 'g'),
      (_w, n: string) => names[Number(n)] ?? 'data:,'
    );
  }
}

/** In-page fetch of one address, as base64, for what the response cache did not keep. */
const pageFetchSource = (url: string, max: number): string =>
  `(async function(){try{var r=await fetch(${JSON.stringify(url)},{credentials:'include'});if(!r.ok)return null;` +
  `var b=new Uint8Array(await r.arrayBuffer());if(b.length>${max})return {tooBig:b.length};var s='';` +
  `for(var i=0;i<b.length;i+=32768)s+=String.fromCharCode.apply(null,b.subarray(i,i+32768));` +
  `return {type:r.headers.get('content-type'),b64:btoa(s)}}catch(e){return null}})()`;

const seedSource = (origin: string, seed: Record<string, string>): string =>
  `(function(){try{if(location.origin!==${JSON.stringify(origin)})return;var s=${JSON.stringify(seed)};` +
  `for(var k in s)localStorage.setItem(k,s[k])}catch(e){}})()`;

function describeStep(step: CaptureStep): string {
  const [key, value] = Object.entries(step)[0];
  return `${key} ${JSON.stringify(value)}`.slice(0, 120);
}

async function runSteps(
  page: Page,
  steps: CaptureStep[],
  base: URL,
  timeout: number,
  afterFirstGoto: () => Promise<void>
): Promise<void> {
  let first = true;
  for (const step of steps) {
    if ('goto' in step) {
      await page.goto(new URL(step.goto, base).href, { waitUntil: 'load', timeout });
      if (first) await afterFirstGoto();
      first = false;
    } else if ('click' in step) {
      // The first VISIBLE match, so one selector can name a control that differs per viewport.
      const target = await page.waitForSelector(step.click, { visible: true, timeout });
      await target?.click();
      await target?.dispose();
    } else if ('type' in step) {
      const target = await page.waitForSelector(step.type, { visible: true, timeout });
      await target?.type(step.text);
      await target?.dispose();
    } else if ('press' in step) {
      await page.keyboard.press(step.press as Parameters<Page['keyboard']['press']>[0]);
    } else if ('waitFor' in step) {
      await page.waitForSelector(step.waitFor, { timeout });
    } else {
      await new Promise((resolve) => setTimeout(resolve, step.wait));
    }
  }
}

async function setUpPage(page: Page, viewport: CaptureViewport): Promise<void> {
  await page.setViewport({
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor,
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
  });
  const ua = viewport.userAgent ?? (viewport.mobile ? IPHONE_UA : undefined);
  if (ua) await page.setUserAgent(ua);
}

/**
 * Drive the app through every state at every viewport and return the prototype's files. Nothing is
 * written; `writeCapturedPrototype` puts them in a folder and `canvas_prototype` publishes them.
 */
export async function capturePrototype(input: unknown, options: CaptureOptions = {}): Promise<CapturedPrototype> {
  const spec: CaptureSpec = parseCaptureSpec(input);
  const base = new URL(spec.baseUrl);
  const nonce = randomBytes(6).toString('hex');
  const warnings: string[] = [];
  const store = new AssetStore(warnings, nonce);
  const log = options.log ?? (() => {});
  const stepTimeout = options.stepTimeoutMs ?? CAPTURE_STEP_TIMEOUT_MS;
  const deadline = Date.now() + (options.timeoutMs ?? CAPTURE_TIMEOUT_MS);
  const label = (name: string) => spec.states.find((s) => s.name === name)?.label ?? name;
  const hotspots = spec.states.map(hotspotFor).filter((h): h is NonNullable<typeof h> => h !== null);
  const pages = new Map<string, string>();

  const browser = await (options.launch ?? (() => launchHeadlessBrowser({ noSandbox: options.noSandbox })))();
  try {
    for (const viewport of spec.viewports) {
      for (const state of spec.states) {
        if (!stateAt(state, viewport.name)) continue;
        if (options.signal?.aborted) throw new CaptureError('Capture cancelled');
        if (Date.now() > deadline)
          throw new CaptureError(
            `Capture timed out after ${Math.round((options.timeoutMs ?? CAPTURE_TIMEOUT_MS) / 1000)} s`
          );
        const where = `state "${state.name}" at ${viewport.name}`;
        log(`capturing ${where}`);
        const context = await browser.createBrowserContext();
        try {
          const page = await context.newPage();
          await setUpPage(page, viewport);
          const responses = new Map<string, HTTPResponse>();
          page.on('response', (response) => {
            const status = response.status();
            if (response.request().method() === 'GET' && status >= 200 && status < 300)
              responses.set(response.url(), response);
          });
          const seeded = Object.keys(spec.localStorage).length
            ? await page.evaluateOnNewDocument(seedSource(base.origin, spec.localStorage))
            : null;
          const steps = stepsToReach(spec, state.name);
          let index = 0;
          try {
            await runSteps(page, steps, base, stepTimeout, async () => {
              if (seeded) await page.removeScriptToEvaluateOnNewDocument(seeded.identifier);
            });
            index = steps.length;
          } catch (error) {
            throw new CaptureError(
              `${where}: a step failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}` +
                (index < steps.length ? '' : ` (steps: ${steps.map(describeStep).join(', ')})`)
            );
          }
          // Mark the elements that lead to this state's children before the page is written out.
          const here = (name: string) => stateAt(spec.states.find((s) => s.name === name)!, viewport.name);
          for (const hotspot of hotspots.filter((h) => h.from === state.name && here(h.to))) {
            const handle =
              (await page.waitForSelector(hotspot.selector, { visible: true, timeout: 1000 }).catch(() => null)) ??
              (await page.$(hotspot.selector).catch(() => null));
            if (!handle) {
              warnings.push(`${where}: the hotspot to "${hotspot.to}" (${hotspot.selector}) is not on the page`);
              continue;
            }
            await handle.evaluate((el, attr, href) => el.setAttribute(attr, href), HOTSPOT_ATTR, `${hotspot.to}.html`);
            await handle.dispose();
          }
          await page.waitForNetworkIdle({ idleTime: 300, timeout: 2500 }).catch(() => undefined);
          await page.evaluate('document.fonts ? document.fonts.ready.then(function(){return true}) : true');
          if (spec.settleMs) await new Promise((resolve) => setTimeout(resolve, spec.settleMs));
          const snapshot = (await page.evaluate(
            snapshotSource({ nonce, inlineStyleMax: INLINE_STYLE_MAX })
          )) as Snapshot;

          const fetchAsset = async (url: string): Promise<Fetched> => {
            const cached = responses.get(url);
            if (cached) {
              try {
                const bytes = await cached.buffer();
                const declared = Number(cached.headers()['content-length'] ?? NaN);
                // The protocol can hand back an empty or cut body (a large image the page stopped
                // decoding): only a body whose length is believable is used, else the page is asked.
                const encoded = !!cached.headers()['content-encoding'];
                if (bytes.length && (encoded || !Number.isFinite(declared) || declared === bytes.length))
                  return { bytes: Buffer.from(bytes), contentType: cached.headers()['content-type'] ?? null };
              } catch {
                /* Evicted or a redirect: ask the page. */
              }
            }
            const got = (await page.evaluate(pageFetchSource(url, PROTOTYPE_MAX_FILE_BYTES)).catch(() => null)) as {
              type?: string | null;
              b64?: string;
              tooBig?: number;
            } | null;
            if (got?.tooBig)
              throw new CaptureError(
                `${url.slice(0, 200)} is ${megabytes(got.tooBig)}, over the ${megabytes(PROTOTYPE_MAX_FILE_BYTES)} limit for one prototype file`
              );
            return got?.b64 ? { bytes: Buffer.from(got.b64, 'base64'), contentType: got.type ?? null } : null;
          };

          const names = await Promise.all(snapshot.urls.map((url) => store.asset(url, fetchAsset)));
          const canvasNames = snapshot.canvases.map((data, n) =>
            store.save(Buffer.from(data.slice(data.indexOf(',') + 1), 'base64'), 'png', `canvas ${n + 1} of ${where}`)
          );
          const lookup =
            (prefix: string) =>
            (key: string): string | null => {
              const name = key.startsWith('c') ? canvasNames[Number(key.slice(1))] : names[Number(key)];
              return name ? `${prefix}${name}` : null;
            };
          const media = (value: string) => (value ? ` media="${attrValue(value)}"` : '');
          const sheets: string[] = [];
          for (const sheet of snapshot.sheets) {
            if (sheet.kind === 'style') {
              const text = sheet.text ?? '';
              if (sheet.inline) {
                sheets.push(
                  `<style${media(sheet.media)}>${replaceTokens(text, nonce, lookup('../assets/')).replace(/<\/style/gi, '<\\/style')}</style>`
                );
              } else {
                const file = store.save(
                  Buffer.from(replaceTokens(text, nonce, lookup(''))),
                  'css',
                  `a stylesheet of ${where}`
                );
                sheets.push(`<link rel="stylesheet" href="../assets/${file}"${media(sheet.media)}>`);
              }
              continue;
            }
            // A linked stylesheet: its original text (what every browser should read), else what this browser parsed.
            let file: string | null = null;
            if (sheet.href) {
              const got = await fetchAsset(sheet.href).catch((error) => {
                if (error instanceof CaptureError) throw error;
                return null;
              });
              if (got)
                file = store.save(
                  Buffer.from(await store.css(got.bytes.toString('utf8'), sheet.href, fetchAsset)),
                  'css',
                  sheet.href
                );
            }
            if (!file && sheet.text !== null)
              file = store.save(Buffer.from(replaceTokens(sheet.text, nonce, lookup(''))), 'css', sheet.href ?? where);
            if (!file) {
              warnings.push(`${where}: stylesheet not captured: ${(sheet.href ?? '').slice(0, 200)}`);
              sheets.push('');
              continue;
            }
            sheets.push(`<link rel="stylesheet" href="../assets/${file}"${media(sheet.media)}>`);
          }
          const runtime: CaptureRuntimeData = {
            state: state.name,
            viewport: viewport.name,
            states: spec.states
              .filter((s) => stateAt(s, viewport.name))
              .map((s) => ({ name: s.name, label: label(s.name), href: `${s.name}.html` })),
            viewports: spec.viewports
              .filter((v) => stateAt(state, v.name))
              .map((v) => ({ name: v.name, href: `../${statePagePath(v.name, state.name)}` })),
            index: '../index.html',
            switcher: spec.switcher,
          };
          const html = assembleStatePage({ html: snapshot.html, nonce, sheets, path: lookup('../assets/'), runtime });
          pages.set(statePagePath(viewport.name, state.name), html);
        } finally {
          await context.close().catch(() => undefined);
        }
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  const entry = statePagePath(spec.viewports[0].name, spec.states[0].name);
  const manifest = {
    format: 1,
    capturedAt: new Date().toISOString(),
    baseUrl: spec.baseUrl,
    entry,
    viewports: spec.viewports.map((v) => ({ name: v.name, width: v.width, height: v.height, mobile: v.mobile })),
    states: spec.states.map((s) => ({
      name: s.name,
      label: label(s.name),
      from: s.from ?? null,
      pages: spec.viewports.filter((v) => stateAt(s, v.name)).map((v) => statePagePath(v.name, s.name)),
    })),
    hotspots,
    warnings,
  };
  const files: PrototypeFile[] = [
    ...[...pages].map(([path, html]) => ({ path, data: Buffer.from(html) })),
    ...[...store.files].map(([name, data]) => ({ path: `assets/${name}`, data })),
    { path: 'index.html', data: Buffer.from(indexPage(spec, label)) },
    { path: 'capture.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
  ];
  try {
    checkPrototypeFiles(
      files.map((f) => ({ path: f.path, bytes: f.data.length })),
      entry
    );
  } catch (error) {
    if (error instanceof PrototypeRefusedError)
      throw new CaptureError(`${error.message}. Capture fewer states or viewports, or smaller pages.`);
    throw error;
  }
  return {
    files,
    entry,
    warnings,
    states: manifest.states.map(({ name, label: l, pages: p }) => ({ name, label: l, pages: p })),
    hotspots,
    bytes: files.reduce((sum, f) => sum + f.data.length, 0),
  };
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The gallery: every state at every viewport, as plain links. */
function indexPage(spec: CaptureSpec, label: (name: string) => string): string {
  const rows = spec.viewports
    .map(
      (v) =>
        `<section><h2>${escapeHtml(v.name)} <small>${v.width}×${v.height}</small></h2><ol>` +
        spec.states
          .filter((s) => stateAt(s, v.name))
          .map(
            (s) => `<li><a href="${escapeHtml(statePagePath(v.name, s.name))}">${escapeHtml(label(s.name))}</a></li>`
          )
          .join('') +
        '</ol></section>'
    )
    .join('');
  return (
    '<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>Prototype states</title>' +
    '<style>body{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#222;background:#fafafa}' +
    'h1{font-size:18px}h2{font-size:14px;margin:16px 0 4px}small{color:#777;font-weight:400}' +
    'a{color:#1a56db}@media (prefers-color-scheme:dark){body{background:#16181c;color:#e8eaed}a{color:#8ab4f8}}</style>' +
    `</head><body><h1>Prototype states</h1>${rows}</body></html>`
  );
}

/** Write a capture into a new or empty folder. Refuses a folder that already holds anything. */
export async function writeCapturedPrototype(dir: string, files: PrototypeFile[]): Promise<void> {
  const existing = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  if (existing.length) throw new CaptureError(`${dir} is not empty; give a new or empty folder`);
  for (const file of files) {
    const target = join(dir, ...file.path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.data, { flag: 'wx' });
  }
}

export { CaptureSpecError };
