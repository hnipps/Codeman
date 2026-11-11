/**
 * @fileoverview queryLogs filters one stream and its .1 file without compiling a pattern.
 */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LogQueryError, NO_LOG_DIR_REASON, parseLogsQuery, queryLogs } from '../src/telemetry-query.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codeman-logs-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function plant(name: string, rows: string[]): void {
  writeFileSync(join(dir, name), rows.length === 0 ? '' : `${rows.join('\n')}\n`);
}

function row(ts: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts, level: 'info', msg: 'm', ...extra });
}

describe('parseLogsQuery', () => {
  it('refuses an unknown field, a repeated field and a since that is after until', () => {
    expect(() => parseLogsQuery({ stream: 'server', raw: '1' })).toThrow(LogQueryError);
    expect(() => parseLogsQuery({ stream: 'server', raw: '1' })).toThrow(/Unknown query field raw/);
    expect(() => parseLogsQuery({ stream: ['server'] })).toThrow(/must appear once/);
    expect(() =>
      parseLogsQuery({ stream: 'server', since: '2026-11-10T00:00:02.000Z', until: '2026-11-10T00:00:01.000Z' })
    ).toThrow(/since must not be after until/);
  });
});

describe('queryLogs', () => {
  it('returns an empty list and a reason when no directory is configured', async () => {
    const result = await queryLogs({ dir: '', stream: 'not-a-stream' });
    expect(result).toEqual({ lines: [], truncated: false, reason: NO_LOG_DIR_REASON });
  });

  it('filters by an inclusive time range, level and a case-sensitive literal', async () => {
    plant('server.jsonl', [
      row('2026-11-10T00:00:00.000Z', { msg: 'before' }),
      row('2026-11-10T00:00:01.000Z', { level: 'error', msg: 'Deploy failed' }),
      row('2026-11-10T00:00:02.000Z', { msg: 'deploy ok' }),
      row('2026-11-10T00:00:03.000Z', { msg: 'after' }),
    ]);
    const ranged = await queryLogs({
      dir,
      stream: 'server',
      since: '2026-11-10T00:00:01.000Z',
      until: '2026-11-10T00:00:02.000Z',
    });
    expect(ranged.lines.map((line) => JSON.parse(line).msg)).toEqual(['Deploy failed', 'deploy ok']);
    expect(ranged.truncated).toBe(false);

    const errors = await queryLogs({ dir, stream: 'server', level: 'error' });
    expect(errors.lines).toHaveLength(1);
    expect(JSON.parse(errors.lines[0]).msg).toBe('Deploy failed');

    const exact = await queryLogs({ dir, stream: 'server', text: 'deploy' });
    expect(exact.lines.map((line) => JSON.parse(line).msg)).toEqual(['deploy ok']);
  });

  it('keeps the newest matches in order when the row cap is hit', async () => {
    plant(
      'server.jsonl',
      [0, 1, 2, 3, 4].map((n) => row(`2026-11-10T00:00:0${n}.000Z`, { msg: `n${n}` }))
    );
    const result = await queryLogs({ dir, stream: 'server', limit: 2 });
    expect(result.truncated).toBe(true);
    expect(result.lines.map((line) => JSON.parse(line).msg)).toEqual(['n3', 'n4']);
  });

  it('reads the rotated generation before the current file', async () => {
    plant('server.jsonl.1', [row('2026-11-10T00:00:00.000Z', { msg: 'only-old' })]);
    plant('server.jsonl', [row('2026-11-10T00:00:01.000Z', { msg: 'new' })]);
    const both = await queryLogs({ dir, stream: 'server' });
    expect(both.lines.map((line) => JSON.parse(line).msg)).toEqual(['only-old', 'new']);

    const onlyOld = await queryLogs({ dir, stream: 'requests', text: 'only-old' });
    expect(onlyOld.lines).toEqual([]);
    plant('requests.jsonl.1', [row('2026-11-10T00:00:00.000Z', { msg: 'only-old' })]);
    const found = await queryLogs({ dir, stream: 'requests', text: 'only-old' });
    expect(found.lines).toHaveLength(1);
  });

  it('treats a ReDoS-shaped pattern as a literal and finishes quickly', async () => {
    const attacks = 'a'.repeat(40);
    plant('server.jsonl', [
      row('2026-11-10T00:00:00.000Z', { msg: attacks }),
      row('2026-11-10T00:00:01.000Z', { msg: 'pattern (a+)+$' }),
    ]);
    const started = performance.now();
    const result = await queryLogs({ dir, stream: 'server', text: '(a+)+$' });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toContain('(a+)+$');
    expect(result.lines[0]).not.toContain(attacks);
  });

  it('redacts a planted secret on the way out and will not find the raw value', async () => {
    plant('server.jsonl', [row('2026-11-10T00:00:00.000Z', { msg: 'Authorization: Bearer abcdefghijklmnop' })]);
    const leaked = await queryLogs({ dir, stream: 'server', text: 'abcdefghijklmnop' });
    expect(leaked.lines).toEqual([]);
    const masked = await queryLogs({ dir, stream: 'server', text: '[redacted]' });
    expect(masked.lines).toHaveLength(1);
    expect(masked.lines[0]).not.toContain('abcdefghijklmnop');
    expect(JSON.parse(masked.lines[0]).msg).toContain('[redacted]');
  });

  it('skips a line over the line cap and stops after the byte cap', async () => {
    const big = row('2026-11-10T00:00:00.000Z', { msg: 'x'.repeat(200) });
    plant('client-errors.jsonl', [big, row('2026-11-10T00:00:01.000Z', { msg: 'kept' })]);
    const skipped = await queryLogs({ dir, stream: 'client-errors', maxLineBytes: 80, text: 'kept' });
    expect(skipped.truncated).toBe(true);
    expect(skipped.lines).toHaveLength(1);

    const chunk = Buffer.from(`${row('2026-11-10T00:00:00.000Z', { msg: 'head-needle' })}\n`);
    const filler = Buffer.from(`${row('2026-11-10T00:00:01.000Z', { msg: 'pad' })}\n`);
    const tail = Buffer.from(`${row('2026-11-10T00:00:02.000Z', { msg: 'tail-needle' })}\n`);
    const body = Buffer.alloc(160 * 1024);
    chunk.copy(body, 0);
    let offset = chunk.length;
    while (offset + filler.length < body.length - tail.length) {
      filler.copy(body, offset);
      offset += filler.length;
    }
    tail.copy(body, offset);
    offset += tail.length;
    writeFileSync(join(dir, 'ui-events.jsonl'), body.subarray(0, offset));
    const capped = await queryLogs({
      dir,
      stream: 'ui-events',
      text: 'needle',
      maxFileBytes: 70 * 1024,
    });
    expect(capped.truncated).toBe(true);
    expect(capped.lines.map((line) => JSON.parse(line).msg)).toEqual(['head-needle']);
  });

  it('does not follow a symlink', async () => {
    writeFileSync(join(dir, 'real.jsonl'), `${row('2026-11-10T00:00:00.000Z', { msg: 'secret-file' })}\n`);
    symlinkSync(join(dir, 'real.jsonl'), join(dir, 'server.jsonl'));
    const result = await queryLogs({ dir, stream: 'server', text: 'secret-file' });
    expect(result.lines).toEqual([]);
  });

  it('scans a 20 MiB generation without loading it as one string', async () => {
    const line = Buffer.from('{"ts":"2026-11-10T00:00:00.000Z","level":"info","msg":"steady"}\n');
    const needle = Buffer.from('{"ts":"2026-11-10T00:00:01.000Z","level":"info","msg":"NEEDLE-pc8"}\n');
    const size = 20 * 1024 * 1024;
    const body = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset + line.length + needle.length < size) {
      line.copy(body, offset);
      offset += line.length;
    }
    needle.copy(body, offset);
    offset += needle.length;
    writeFileSync(join(dir, 'server.jsonl'), body.subarray(0, offset));
    const started = performance.now();
    const result = await queryLogs({ dir, stream: 'server', text: 'NEEDLE-pc8' });
    expect(performance.now() - started).toBeLessThan(3000);
    expect(result.lines).toHaveLength(1);
    expect(result.truncated).toBe(false);
  });
});
