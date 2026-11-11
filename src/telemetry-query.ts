/**
 * @fileoverview Bounded read of one telemetry stream and its rotated `.1` file.
 *
 * Matches a literal substring, a time range and a level. It never compiles the
 * caller's text into a RegExp. Each generation is read from its tail, in chunks,
 * so a byte cap keeps the newest rows and a generation is not loaded whole. A
 * line over the line cap is skipped. Results are passed through `redactLogLine`
 * again so a line written by an older release is masked on the way out.
 *
 * @module telemetry-query
 */

import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { redactLogLine } from './telemetry-redact.js';

export const LOG_STREAMS = ['server', 'requests', 'client-errors', 'ui-events'] as const;
export type LogStream = (typeof LOG_STREAMS)[number];

export const LOG_LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_QUERY_DEFAULT_LIMIT = 200;
export const LOG_QUERY_MAX_LIMIT = 500;
export const LOG_QUERY_MAX_TEXT = 500;
/** One generation. Rotation is 20 MiB, and a batch may overshoot it by a chunk. */
export const LOG_QUERY_FILE_BYTE_CAP = 21 * 1024 * 1024;
export const LOG_QUERY_MAX_LINE_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

export const NO_LOG_DIR_REASON = 'No log directory is configured';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const QUERY_FIELDS = new Set(['stream', 'since', 'until', 'level', 'text', 'limit']);

export class LogQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogQueryError';
  }
}

export interface LogQueryResult {
  lines: string[];
  truncated: boolean;
  reason?: string;
}

export interface LogQueryOptions {
  dir?: string | null;
  stream?: string;
  since?: string;
  until?: string;
  level?: string;
  text?: string;
  limit?: number;
  /** Literal hook secret, applied by `redactLogLine`. Not a pattern. */
  hookSecret?: string;
  /** Defaults to `LOG_QUERY_FILE_BYTE_CAP`. The HTTP route does not set it. */
  maxFileBytes?: number;
  /** Defaults to `LOG_QUERY_MAX_LINE_BYTES`. The HTTP route does not set it. */
  maxLineBytes?: number;
}

interface NormalizedQuery {
  stream: LogStream;
  sinceMs?: number;
  untilMs?: number;
  level?: LogLevel;
  text?: string;
  limit: number;
  hookSecret?: string;
  maxFileBytes: number;
  maxLineBytes: number;
}

function isStream(value: string): value is LogStream {
  return (LOG_STREAMS as readonly string[]).includes(value);
}

function isLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

function parseInstant(label: string, value: string): number {
  if (!ISO_RE.test(value)) throw new LogQueryError(`${label} must be an ISO-8601 timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new LogQueryError(`${label} must be an ISO-8601 timestamp`);
  return ms;
}

/** Validate a query-string object. Unknown fields are refused, including anything that would ask for raw lines. */
export function parseLogsQuery(raw: unknown): {
  stream: LogStream;
  since?: string;
  until?: string;
  level?: LogLevel;
  text?: string;
  limit?: number;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new LogQueryError('Query must be an object');
  const q = raw as Record<string, unknown>;
  for (const [key, value] of Object.entries(q)) {
    if (!QUERY_FIELDS.has(key)) throw new LogQueryError(`Unknown query field ${key}`);
    if (Array.isArray(value)) throw new LogQueryError(`${key} must appear once`);
  }
  const stream = q.stream;
  if (typeof stream !== 'string' || !isStream(stream)) {
    throw new LogQueryError(`stream must be one of: ${LOG_STREAMS.join(', ')}`);
  }
  let since: string | undefined;
  let until: string | undefined;
  if (q.since !== undefined) {
    if (typeof q.since !== 'string') throw new LogQueryError('since must be a string');
    since = q.since;
    parseInstant('since', since);
  }
  if (q.until !== undefined) {
    if (typeof q.until !== 'string') throw new LogQueryError('until must be a string');
    until = q.until;
    parseInstant('until', until);
  }
  if (since !== undefined && until !== undefined && parseInstant('since', since) > parseInstant('until', until)) {
    throw new LogQueryError('since must not be after until');
  }
  let level: LogLevel | undefined;
  if (q.level !== undefined) {
    if (typeof q.level !== 'string' || !isLevel(q.level)) {
      throw new LogQueryError(`level must be one of: ${LOG_LEVELS.join(', ')}`);
    }
    level = q.level;
  }
  let text: string | undefined;
  if (q.text !== undefined) {
    if (typeof q.text !== 'string') throw new LogQueryError('text must be a string');
    if (q.text.length > LOG_QUERY_MAX_TEXT) throw new LogQueryError(`text is longer than ${LOG_QUERY_MAX_TEXT}`);
    if (q.text.length > 0) text = q.text;
  }
  let limit: number | undefined;
  if (q.limit !== undefined) {
    const rawLimit = q.limit;
    const parsed = typeof rawLimit === 'number' ? rawLimit : typeof rawLimit === 'string' ? Number(rawLimit) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > LOG_QUERY_MAX_LIMIT) {
      throw new LogQueryError(`limit must be an integer from 1 to ${LOG_QUERY_MAX_LIMIT}`);
    }
    limit = parsed;
  }
  return { stream, since, until, level, text, limit };
}

function normalize(opts: LogQueryOptions): NormalizedQuery {
  const parsed = parseLogsQuery({
    stream: opts.stream,
    since: opts.since,
    until: opts.until,
    level: opts.level,
    text: opts.text,
    limit: opts.limit === undefined ? undefined : String(opts.limit),
  });
  return {
    stream: parsed.stream,
    sinceMs: parsed.since === undefined ? undefined : parseInstant('since', parsed.since),
    untilMs: parsed.until === undefined ? undefined : parseInstant('until', parsed.until),
    level: parsed.level,
    text: parsed.text,
    limit: parsed.limit ?? LOG_QUERY_DEFAULT_LIMIT,
    hookSecret: opts.hookSecret,
    maxFileBytes: opts.maxFileBytes ?? LOG_QUERY_FILE_BYTE_CAP,
    maxLineBytes: opts.maxLineBytes ?? LOG_QUERY_MAX_LINE_BYTES,
  };
}

function lineMatches(line: string, q: NormalizedQuery): boolean {
  if (q.text !== undefined && !line.includes(q.text)) return false;
  if (q.sinceMs === undefined && q.untilMs === undefined && q.level === undefined) return true;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return false;
  }
  if (!record || typeof record !== 'object') return false;
  const obj = record as Record<string, unknown>;
  if (q.level !== undefined && obj.level !== q.level) return false;
  if (q.sinceMs !== undefined || q.untilMs !== undefined) {
    if (typeof obj.ts !== 'string') return false;
    const ts = Date.parse(obj.ts);
    if (!Number.isFinite(ts)) return false;
    if (q.sinceMs !== undefined && ts < q.sinceMs) return false;
    if (q.untilMs !== undefined && ts > q.untilMs) return false;
  }
  return true;
}

interface MatchState {
  buf: string[];
  count: number;
  start: number;
  seen: number;
  truncated: boolean;
  limit: number;
}

function pushMatch(state: MatchState, line: string): void {
  state.seen++;
  if (state.count < state.limit) {
    state.buf[state.count] = line;
    state.count++;
    return;
  }
  state.truncated = true;
  state.buf[state.start] = line;
  state.start = (state.start + 1) % state.limit;
}

function matchedLines(state: MatchState): string[] {
  if (state.count < state.limit) return state.buf.slice(0, state.count);
  return [...state.buf.slice(state.start), ...state.buf.slice(0, state.start)];
}

/**
 * Read the tail of one generation, at most `maxFileBytes`. A start in the
 * middle of a line drops that partial line. A line longer than `maxLineBytes`
 * is dropped. Older bytes outside the window set `truncated`.
 */
async function scanFile(path: string, q: NormalizedQuery, state: MatchState): Promise<void> {
  let file;
  let size = 0;
  try {
    const st = await lstat(path);
    if (!st.isFile()) return;
    size = st.size;
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP' || code === 'EINVAL') return;
    throw new LogQueryError('Could not read a log file');
  }
  const startAt = size > q.maxFileBytes ? size - q.maxFileBytes : 0;
  if (startAt > 0) state.truncated = true;
  const chunk = Buffer.alloc(READ_CHUNK_BYTES);
  let pending = Buffer.alloc(0);
  let skipping = startAt > 0;
  let position = startAt;
  try {
    while (position < size) {
      const want = Math.min(chunk.length, size - position);
      const { bytesRead } = await file.read(chunk, 0, want, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      if (skipping) {
        const nl = pending.indexOf(0x0a);
        if (nl === -1) {
          pending = Buffer.alloc(0);
          continue;
        }
        skipping = false;
        pending = pending.subarray(nl + 1);
      }
      let start = 0;
      for (let i = 0; i < pending.length; i++) {
        if (pending[i] !== 0x0a) continue;
        const lineBuf = pending.subarray(start, i);
        start = i + 1;
        consider(lineBuf, q, state);
      }
      pending = pending.subarray(start);
      if (pending.length > q.maxLineBytes) {
        state.truncated = true;
        const nl = pending.indexOf(0x0a);
        if (nl === -1) {
          skipping = true;
          pending = Buffer.alloc(0);
        } else {
          pending = pending.subarray(nl + 1);
        }
      }
    }
    if (!skipping && pending.length > 0) consider(pending, q, state);
  } finally {
    await file.close();
  }
}

function consider(lineBuf: Buffer, q: NormalizedQuery, state: MatchState): void {
  let raw = lineBuf;
  if (raw.length > 0 && raw[raw.length - 1] === 0x0d) raw = raw.subarray(0, -1);
  if (raw.length === 0) return;
  if (raw.length > q.maxLineBytes) {
    state.truncated = true;
    return;
  }
  const redacted = redactLogLine(raw.toString('utf8'), q.hookSecret);
  const line = redacted.endsWith('\n') ? redacted.slice(0, -1) : redacted;
  if (!lineMatches(line, q)) return;
  pushMatch(state, line);
}

/**
 * Read the tail of `stream.jsonl.1`, then the tail of `stream.jsonl`, so the
 * newest rows win a byte cap. `dir` empty means nothing is configured. There is
 * no switch that returns the raw line.
 */
export async function queryLogs(opts: LogQueryOptions): Promise<LogQueryResult> {
  if (!opts.dir) return { lines: [], truncated: false, reason: NO_LOG_DIR_REASON };
  const q = normalize(opts);
  const state: MatchState = {
    buf: [],
    count: 0,
    start: 0,
    seen: 0,
    truncated: false,
    limit: q.limit,
  };
  await scanFile(join(opts.dir, `${q.stream}.jsonl.1`), q, state);
  await scanFile(join(opts.dir, `${q.stream}.jsonl`), q, state);
  return { lines: matchedLines(state), truncated: state.truncated || state.seen > q.limit };
}
