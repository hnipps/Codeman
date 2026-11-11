/**
 * @fileoverview File telemetry for supervised (blue-green) deploys.
 *
 * With `CODEMAN_LOG_DIR` set, the server appends four JSONL streams there so an agent
 * or a supervisor can read what the app did without a log shipper: `server.jsonl` (every
 * console line), `requests.jsonl` (one line per HTTP request), `client-errors.jsonl`
 * (browser errors posted to `/api/client-errors`) and `ui-events.jsonl` (canvas and
 * tab-strip events posted to that same route with `kind: "ui"`). With it unset nothing
 * is written and nothing else changes.
 *
 * Every line is passed through `redactLogLine` before it joins the queue, so a crash
 * flush cannot write a secret the async flush would have masked. The hook secret is
 * read from disk with a capped read and never created here. A miss is not
 * remembered, so a secret created a moment later is visible to the next line.
 * Once a usable secret is known, later lines do not read the file again.
 *
 * Writes never throw into a caller and never block: lines queue in memory (bounded) and
 * one async append per stream flushes them. Rotation is by size, checked against the file
 * itself before each append, so two processes sharing a directory (the two colours of a
 * blue-green deploy) cannot rotate each other's fresh file away on a stale in-memory count.
 *
 * Also owns the build id (`CODEMAN_BUILD_ID`), which every line and the health endpoints
 * carry so a reader can tell which build produced what.
 *
 * @module telemetry
 */

import { accessSync, appendFileSync, closeSync, constants, lstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { appendFile, rename, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { format } from 'node:util';
import { dataPath } from './config/instance.js';
import { redactLogLine } from './telemetry-redact.js';

const require = createRequire(import.meta.url);
export const { version: PACKAGE_VERSION } = require('../package.json') as { version: string };

const BUILD_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const FLUSH_DELAY_MS = 200;
/** Per-stream cap on lines waiting for a flush; a stuck disk drops lines instead of growing the heap. */
const MAX_QUEUED_CHARS = 4 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 8 * 1024;
const MAX_PATH_CHARS = 512;

type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';
const CONSOLE_LEVELS: readonly ConsoleLevel[] = ['log', 'info', 'warn', 'error', 'debug'];

interface ServerLogLine {
  level: ConsoleLevel;
  buildId: string;
  pid: number;
  msg: string;
}

interface RequestLogLine {
  reqId: string;
  method: string;
  path: string;
  status: number;
  ms: number;
}

interface ClientErrorLogLine {
  buildId: string;
  ua: string;
  message: string;
  source?: string | null;
  line?: number | null;
  col?: number | null;
  stack?: string | null;
  url?: string | null;
}

interface UiEventLogLine {
  buildId: string;
  surface: 'canvas' | 'tab-strip';
  action: string;
  target?: string | null;
}

interface StreamRecords {
  server: ServerLogLine;
  requests: RequestLogLine;
  'client-errors': ClientErrorLogLine;
  'ui-events': UiEventLogLine;
}

let cachedHookSecret: string | undefined;
/** Bytes of the hook-secret file taken by the last disk read. Zero when the cache answered. */
let hookSecretReadBytes = 0;

/** A hook secret is a short file. The read never asks for more than this. */
export const HOOK_SECRET_READ_CAP = 512;

/** Drop the cached hook secret. Tests use this so a file written mid-process is visible. */
export function resetTelemetryRedactionCache(): void {
  cachedHookSecret = undefined;
  hookSecretReadBytes = 0;
}

/** How many bytes the last hook-secret disk read took. Zero when the cache answered. */
export function lastHookSecretReadBytes(): number {
  return hookSecretReadBytes;
}

/**
 * Remember a secret `getHookSecret()` just read or created. A log line must not
 * keep a copy that appeared after an earlier miss. Unusable values are ignored.
 */
export function noteHookSecretForRedaction(value: string): void {
  const text = value.trim();
  if (text.length < 16 || text.length > 256) return;
  if (text.includes('\n') || text.includes('\r') || text.includes('\0')) return;
  cachedHookSecret = text;
}

/**
 * The hook secret already on disk, or undefined. This never creates the file:
 * `getHookSecret()` would mint one the first time a log line was written.
 * A miss is not cached. A value shorter than 16 characters, longer than 256,
 * or carrying a newline is ignored.
 */
export function readHookSecretForRedaction(): string | undefined {
  if (cachedHookSecret !== undefined) {
    hookSecretReadBytes = 0;
    return cachedHookSecret;
  }
  let fd: number | undefined;
  try {
    const path = dataPath('hook-secret');
    const info = lstatSync(path);
    if (!info.isFile()) return undefined;
    fd = openSync(path, constants.O_RDONLY);
    const buf = Buffer.alloc(HOOK_SECRET_READ_CAP);
    const n = readSync(fd, buf, 0, HOOK_SECRET_READ_CAP, 0);
    hookSecretReadBytes = n;
    const firstLine = buf.subarray(0, n).toString('utf8').split(/\r?\n/, 1)[0]?.trim() ?? '';
    if (firstLine.length < 16 || firstLine.length > 256) return undefined;
    if (firstLine.includes('\0')) return undefined;
    cachedHookSecret = firstLine;
    return firstLine;
  } catch {
    hookSecretReadBytes = 0;
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

type TelemetryStream = keyof StreamRecords;

/** The build id from `raw` when it is well formed, else `fallback`. */
export function resolveBuildId(raw: string | undefined, fallback: string): string {
  return raw !== undefined && BUILD_ID_PATTERN.test(raw) ? raw : fallback;
}

export function currentBuildId(env: NodeJS.ProcessEnv = process.env): string {
  return resolveBuildId(env.CODEMAN_BUILD_ID, PACKAGE_VERSION);
}

export function resolveMaxBytes(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

/** A request path for the log: no query string, and no capability or QR token a URL carries as a path segment. */
export function requestPath(url: string): string {
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  return path.replace(/^\/(q|webview|html-view)\/[^/]+/, '/$1/:redacted').slice(0, MAX_PATH_CHARS);
}

function formatConsoleArgs(args: readonly unknown[]): string {
  try {
    return format(...args).slice(0, MAX_MESSAGE_CHARS);
  } catch {
    return '[unformattable console arguments]';
  }
}

/** A file is rotated once it has passed the cap. A batch may overshoot it by its own size. */
function shouldRotate(sizeBytes: number, maxBytes: number): boolean {
  return sizeBytes > maxBytes;
}

class StreamWriter {
  private queue: string[] = [];
  private queuedChars = 0;
  private timer: NodeJS.Timeout | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly maxBytes: number
  ) {}

  push(line: string): void {
    let safe: string;
    try {
      safe = redactLogLine(line, readHookSecretForRedaction());
      if (!safe.endsWith('\n')) safe += '\n';
    } catch {
      safe = '[unredactable]\n';
    }
    if (this.queuedChars + safe.length > MAX_QUEUED_CHARS) return;
    this.queue.push(safe);
    this.queuedChars += safe.length;
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), FLUSH_DELAY_MS);
      this.timer.unref();
    }
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.tail = this.tail.then(() => this.drain());
    return this.tail;
  }

  /** Last-gasp write at process exit. Skips rotation: the next async flush does it. */
  flushSync(): void {
    const batch = this.take();
    if (!batch) return;
    try {
      appendFileSync(this.path, batch, { mode: 0o600 });
    } catch {
      /* telemetry must never break the process */
    }
  }

  private take(): string {
    const batch = this.queue.join('');
    this.queue = [];
    this.queuedChars = 0;
    return batch;
  }

  private async drain(): Promise<void> {
    const batch = this.take();
    if (!batch) return;
    try {
      const size = await stat(this.path).then(
        (s) => s.size,
        () => 0
      );
      if (shouldRotate(size, this.maxBytes)) await rename(this.path, `${this.path}.1`);
      await appendFile(this.path, batch, { mode: 0o600 });
    } catch {
      /* telemetry must never break the process */
    }
  }
}

export class Telemetry {
  private readonly writers = new Map<TelemetryStream, StreamWriter>();
  private readonly onExit = () => this.flushSync();

  constructor(
    readonly dir: string,
    readonly buildId: string,
    private readonly maxBytes: number
  ) {
    process.once('exit', this.onExit);
  }

  write<S extends TelemetryStream>(stream: S, record: StreamRecords[S]): void {
    try {
      const line =
        JSON.stringify({ ts: new Date().toISOString(), buildId: this.buildId, pid: process.pid, ...record }) + '\n';
      let writer = this.writers.get(stream);
      if (!writer) {
        writer = new StreamWriter(join(this.dir, `${stream}.jsonl`), this.maxBytes);
        this.writers.set(stream, writer);
      }
      writer.push(line);
    } catch {
      /* telemetry must never break the caller */
    }
  }

  async flush(): Promise<void> {
    await Promise.all([...this.writers.values()].map((w) => w.flush()));
  }

  flushSync(): void {
    for (const w of this.writers.values()) w.flushSync();
  }

  async close(): Promise<void> {
    process.off('exit', this.onExit);
    await this.flush();
  }
}

/** The telemetry sink `CODEMAN_LOG_DIR` asks for, or null when it is unset or its directory is unusable. */
export function createTelemetryFromEnv(env: NodeJS.ProcessEnv = process.env): Telemetry | null {
  const raw = env.CODEMAN_LOG_DIR;
  if (!raw) return null;
  const dir = resolve(raw);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    accessSync(dir, constants.W_OK);
  } catch (err) {
    console.warn(`[telemetry] CODEMAN_LOG_DIR is not usable, file telemetry is off: ${(err as Error).message}`);
    return null;
  }
  return new Telemetry(dir, currentBuildId(env), resolveMaxBytes(env.CODEMAN_LOG_MAX_BYTES));
}

/**
 * Mirror every console.log/info/warn/error/debug line into `server.jsonl`. The original
 * console method runs first and unchanged, so stdout and stderr are what they were.
 * @returns a function that puts the original console methods back
 */
export function installConsoleMirror(telemetry: Telemetry): () => void {
  const originals = new Map<ConsoleLevel, (...args: unknown[]) => void>();
  for (const level of CONSOLE_LEVELS) {
    const original = console[level].bind(console) as (...args: unknown[]) => void;
    originals.set(level, console[level]);
    console[level] = (...args: unknown[]) => {
      original(...args);
      telemetry.write('server', {
        level,
        buildId: telemetry.buildId,
        pid: process.pid,
        msg: formatConsoleArgs(args),
      });
    };
  }
  return () => {
    for (const [level, method] of originals) console[level] = method;
  };
}
