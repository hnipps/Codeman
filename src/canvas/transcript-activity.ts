/**
 * @fileoverview The tool calls of a Claude transcript, cut down to what a conversation view may show. Pure.
 *
 * The transcript reader hands each row's content blocks to a {@link ToolLedger} while it makes its own prompt and
 * reply rows, so one pass over the file gives both and their order agrees. Tool input and output are untrusted and
 * can hold secrets: every field is flattened, cut to a fixed length and passed through the telemetry redactor here,
 * before it leaves the server. Release facts are read from the uncut text first, since the redactor may mask a line.
 */

import { stripAnsi } from '../utils/index.js';
import { redactLogLine } from '../telemetry-redact.js';
import { printedOutcome, releaseRequest, type ReleasePrinted, type ReleaseRequest } from './release.js';

export const MAX_TOOL_ROWS = 400;
export const MAX_TOOL_NAME = 80;
export const MAX_TOOL_INPUT = 400;
export const MAX_TOOL_EXCERPT = 600;
export const MAX_SOURCE_LABEL = 200;

export type ToolSource = { kind: 'file' | 'search' | 'web' | 'canvas'; label: string };
export type ToolRow = {
  id: string;
  name: string;
  /** The call's input as one line. */
  input: string;
  status: 'pending' | 'ok' | 'error';
  /** The start and the end of the result; `tail` is empty when the whole result fits in `head`. */
  head: string;
  tail: string;
  /** Characters of the result that are in neither excerpt. */
  cut: number;
  at: string | null;
  /** How many prompt and reply rows precede this call. */
  after: number;
  /** Set when the call reads something a person may want named under Sources used. */
  reads?: ToolSource;
  /** Set when the call asks the deploy supervisor for a release. */
  release?: { request: ReleaseRequest; printed: ReleasePrinted };
};

type Block = Record<string, unknown>;
const blocks = (content: unknown): Block[] =>
  Array.isArray(content) ? content.filter((b): b is Block => typeof b === 'object' && b !== null) : [];
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

// eslint-disable-next-line no-control-regex
const CONTROL_RUN = /[\x00-\x1f\x7f-\x9f]+/g;
// eslint-disable-next-line no-control-regex
const CONTROL_KEEPING_BREAKS = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g;

/** One line of printable text: no escape sequences, no control characters, runs of space folded. */
function oneLine(value: string, max: number): string {
  const flat = stripAnsi(value.slice(0, max * 8))
    .replace(CONTROL_RUN, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  const safe = redactLogLine(flat);
  return safe.length > max ? `${safe.slice(0, max - 1)}…` : safe;
}
/** Printable text that keeps its line breaks. */
function excerpt(value: string): string {
  // The redactor's placeholder can be longer than what it masks, so the cap is applied again after it.
  return redactLogLine(stripAnsi(value).replace(CONTROL_KEEPING_BREAKS, ' ')).trim().slice(0, MAX_TOOL_EXCERPT);
}

function compact(input: unknown): string {
  try {
    return JSON.stringify(input) ?? '';
  } catch {
    return '';
  }
}

const shortName = (name: string): string => name.replace(/^mcp__.*__/, '');

/** The input field that says what a call is about, tried in this order; anything else shows as compact JSON. */
const SUBJECT_KEYS = ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'description', 'skill'];
function inputLine(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const fields = input as Block;
  const key = SUBJECT_KEYS.find((k) => typeof fields[k] === 'string' && fields[k] !== '');
  if (!key) return oneLine(compact(input), MAX_TOOL_INPUT);
  const where = key === 'pattern' && typeof fields.path === 'string' && fields.path ? ` in ${fields.path}` : '';
  return oneLine(`${text(fields[key])}${where}`, MAX_TOOL_INPUT);
}

const CANVAS_READS = /^canvas_(read|search|query)$/;
function sourceOf(name: string, input: unknown): ToolSource | undefined {
  const fields = (typeof input === 'object' && input !== null ? input : {}) as Block;
  const label = (value: string): string => oneLine(value, MAX_SOURCE_LABEL);
  const tool = shortName(name);
  if (tool === 'Read' || tool === 'NotebookRead') {
    const path = text(fields.file_path) || text(fields.notebook_path);
    return path ? { kind: 'file', label: label(path) } : undefined;
  }
  if (tool === 'Grep' || tool === 'Glob') {
    const pattern = text(fields.pattern);
    if (!pattern) return undefined;
    return { kind: 'search', label: label(`${pattern}${text(fields.path) ? ` in ${text(fields.path)}` : ''}`) };
  }
  if (tool === 'WebFetch') return text(fields.url) ? { kind: 'web', label: label(text(fields.url)) } : undefined;
  if (tool === 'WebSearch')
    return text(fields.query) ? { kind: 'search', label: label(text(fields.query)) } : undefined;
  if (CANVAS_READS.test(tool)) {
    const detail = compact(input);
    return { kind: 'canvas', label: label(detail === '{}' || !detail ? tool : `${tool} ${detail}`) };
  }
  return undefined;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  return blocks(content)
    .map((b) => (b.type === 'text' ? text(b.text) : b.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

/** Collects tool calls in transcript order and pairs each with its result. Keeps the newest {@link MAX_TOOL_ROWS}. */
export class ToolLedger {
  private byId = new Map<string, ToolRow>();
  private dropped = 0;

  /** The `tool_use` blocks of one assistant row; `after` is the count of prompt and reply rows made so far. */
  uses(content: unknown, at: string | undefined, after: number): void {
    for (const block of blocks(content)) {
      if (block.type !== 'tool_use') continue;
      const id = text(block.id).slice(0, 120);
      const name = text(block.name);
      // A replayed row repeats a call already seen; the first sighting keeps its place.
      if (!id || !name || this.byId.has(id)) continue;
      const command = shortName(name) === 'Bash' ? text((block.input as Block | undefined)?.command) : '';
      const request = command ? releaseRequest(command) : null;
      const reads = sourceOf(name, block.input);
      this.byId.set(id, {
        id,
        name: oneLine(shortName(name), MAX_TOOL_NAME),
        input: inputLine(block.input),
        status: 'pending',
        head: '',
        tail: '',
        cut: 0,
        at: at ?? null,
        after,
        ...(reads ? { reads } : {}),
        ...(request ? { release: { request, printed: { deployId: null, outcome: null, failedStep: null } } } : {}),
      });
      if (this.byId.size > MAX_TOOL_ROWS) {
        const oldest = this.byId.keys().next().value;
        if (oldest !== undefined) this.byId.delete(oldest);
        this.dropped += 1;
      }
    }
  }

  /** The `tool_result` blocks of one user row. A result whose call is not held is ignored. */
  results(content: unknown): void {
    for (const block of blocks(content)) {
      if (block.type !== 'tool_result') continue;
      const row = this.byId.get(text(block.tool_use_id));
      if (!row || row.status !== 'pending') continue;
      const whole = resultText(block.content);
      row.status = block.is_error === true ? 'error' : 'ok';
      if (row.release) row.release.printed = printedOutcome(whole);
      if (whole.length <= MAX_TOOL_EXCERPT) {
        row.head = excerpt(whole);
        continue;
      }
      row.head = excerpt(whole.slice(0, MAX_TOOL_EXCERPT));
      const rest = whole.length - MAX_TOOL_EXCERPT;
      const tail = Math.min(MAX_TOOL_EXCERPT, rest);
      row.tail = excerpt(whole.slice(whole.length - tail));
      row.cut = rest - tail;
    }
  }

  rows(): ToolRow[] {
    return [...this.byId.values()];
  }
  /** Calls older than the kept rows. */
  get droppedCount(): number {
    return this.dropped;
  }
}
