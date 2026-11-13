import type { ToolRow as ServerToolRow, ToolSource } from '../../../src/canvas/transcript-activity.js';
import type { ReleaseView } from '../../../src/canvas/release.js';
import type { Turn } from './conversation.js';

export type ToolRow = Omit<ServerToolRow, 'release'>;
export type Activity = { supported: boolean; tools: ToolRow[]; dropped: number; releases: ReleaseView[] };
export const NO_ACTIVITY: Activity = { supported: false, tools: [], dropped: 0, releases: [] };

/** Tool rows shown for one run of calls; a longer run shows its newest and counts the rest. */
export const MAX_GROUP_ROWS = 12;
export const MAX_SOURCES = 50;

const str = (v: unknown): v is string => typeof v === 'string';
const SOURCE_KINDS = ['file', 'search', 'web', 'canvas'];
const RELEASE_STATES = ['succeeded', 'failed', 'rejected', 'running', 'unknown'];

/** The server's answer, read leniently: a row or release this page cannot place is left out, never thrown on. */
export function parseActivity(data: unknown): Activity {
  const a = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  if (a.supported !== true) return NO_ACTIVITY;
  const tools = (Array.isArray(a.tools) ? a.tools : []).flatMap((raw): ToolRow[] => {
    const t = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    if (!str(t.id) || !str(t.name) || !Number.isInteger(t.after)) return [];
    const reads = t.reads as { kind?: unknown; label?: unknown } | undefined;
    return [
      {
        id: t.id,
        name: t.name,
        input: str(t.input) ? t.input : '',
        status: t.status === 'ok' || t.status === 'error' ? t.status : 'pending',
        head: str(t.head) ? t.head : '',
        tail: str(t.tail) ? t.tail : '',
        cut: typeof t.cut === 'number' && t.cut > 0 ? t.cut : 0,
        at: str(t.at) ? t.at : null,
        after: t.after as number,
        ...(reads && str(reads.label) && SOURCE_KINDS.includes(reads.kind as string)
          ? { reads: { kind: reads.kind as ToolSource['kind'], label: reads.label } }
          : {}),
      },
    ];
  });
  const releases = (Array.isArray(a.releases) ? a.releases : []).flatMap((raw): ReleaseView[] => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    if (!str(r.toolId) || !RELEASE_STATES.includes(r.state as string)) return [];
    return [
      {
        toolId: r.toolId,
        action: r.action === 'rollback' ? 'rollback' : 'deploy',
        sha: str(r.sha) ? r.sha : null,
        state: r.state as ReleaseView['state'],
        failedStep: str(r.failedStep) ? r.failedStep : null,
        source: r.source === 'supervisor' || r.source === 'printed' ? r.source : 'none',
        finishedAt: str(r.finishedAt) ? r.finishedAt : null,
      },
    ];
  });
  return { supported: true, tools, dropped: typeof a.dropped === 'number' ? a.dropped : 0, releases };
}

export type ThreadItem =
  | { kind: 'turn'; turn: Turn }
  | { kind: 'tools'; key: string; rows: ToolRow[]; hidden: number }
  | { kind: 'release'; key: string; view: ReleaseView }
  | { kind: 'sources'; key: string; sent: string[]; read: ToolSource[] };

/**
 * Places tool calls, release outcomes and each turn's Sources used among the thread's turns. `turns` are the
 * transcript's rows in order (the first `rowCount`), then messages the transcript does not hold yet. A tool call sits
 * before the row it precedes. A turn runs from a prompt (or a run of prompts) to the next prompt, and ends with one
 * sources item when anything was sent with it or read during it.
 */
export function weave(turns: readonly Turn[], rowCount: number, activity: Activity): ThreadItem[] {
  const items: ThreadItem[] = [];
  const releases = new Map(activity.releases.map((r) => [r.toolId, r]));
  const before = new Map<number, ToolRow[]>();
  for (const tool of activity.tools) {
    const at = Math.min(Math.max(tool.after, 0), rowCount);
    before.set(at, [...(before.get(at) ?? []), tool]);
  }
  let sent: string[] = [];
  let read: ToolSource[] = [];
  let segment = '';
  let dropped = activity.dropped;
  const closeSegment = (): void => {
    if (segment && (sent.length || read.length)) items.push({ kind: 'sources', key: `src:${segment}`, sent, read });
    sent = [];
    read = [];
  };
  const tools = (index: number): void => {
    const rows = before.get(index);
    if (!rows) return;
    const shown = rows.slice(-MAX_GROUP_ROWS);
    items.push({
      kind: 'tools',
      key: `tools:${rows[0].id}`,
      rows: shown,
      hidden: rows.length - shown.length + dropped,
    });
    dropped = 0;
    for (const row of rows) {
      const source = row.reads;
      if (
        source &&
        read.length < MAX_SOURCES &&
        !read.some((s) => s.kind === source.kind && s.label === source.label)
      ) {
        read.push(source);
      }
      const release = releases.get(row.id);
      if (release) items.push({ kind: 'release', key: `release:${row.id}`, view: release });
    }
  };
  for (let index = 0; index < rowCount && index < turns.length; index += 1) {
    const turn = turns[index];
    tools(index);
    const prompt = turn.who !== 'claude';
    if (prompt && (index === 0 || turns[index - 1].who === 'claude')) {
      closeSegment();
      segment = turn.key;
    }
    if (prompt) for (const ref of turn.refs) if (!sent.includes(ref)) sent.push(ref);
    items.push({ kind: 'turn', turn });
  }
  tools(rowCount);
  closeSegment();
  for (const turn of turns.slice(rowCount)) items.push({ kind: 'turn', turn });
  return items;
}

/** One quiet word after a tool call that did not simply succeed. */
export function toolState(row: ToolRow, working: boolean): string {
  if (row.status === 'error') return 'Failed';
  if (row.status === 'pending') return working ? 'Running' : 'No result';
  return '';
}

/** A tool call's result as shown when its row is opened: the start, how much is left out, the end. */
export function toolResult(row: ToolRow): string {
  if (row.status === 'pending') return 'No result yet.';
  if (!row.head && !row.tail) return 'No output.';
  if (!row.tail) return row.head;
  const gap = row.cut > 0 ? `\n… ${row.cut.toLocaleString('en-US')} characters not shown …\n` : '\n';
  return `${row.head}${gap}${row.tail}`;
}

const KIND_WORD: Record<ToolSource['kind'], string> = { file: 'File', search: 'Search', web: 'Web', canvas: 'Canvas' };
export const sourceLine = (source: ToolSource): string => `${KIND_WORD[source.kind]} · ${source.label}`;
