/**
 * File telemetry (src/telemetry.ts): the build id boundary, the JSONL streams, size
 * rotation, the console mirror and the "never throws into a caller" guarantee.
 *
 * Real files in a temp dir; no ports.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Telemetry,
  createRequestIdGenerator,
  createTelemetryFromEnv,
  installConsoleMirror,
  requestPath,
  resolveBuildId,
  resolveMaxBytes,
} from '../src/telemetry.js';
import { redactLogLine } from '../src/telemetry-redact.js';

let dir: string;
const open: Telemetry[] = [];

function telemetry(maxBytes = 1024 * 1024, buildId = 'b1'): Telemetry {
  const t = new Telemetry(dir, buildId, maxBytes);
  open.push(t);
  return t;
}

function lines(file: string): Array<Record<string, unknown>> {
  return readFileSync(join(dir, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const request = (n: number) => ({ reqId: `req-${n}`, method: 'GET', path: '/api/status', status: 200, ms: 1 });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codeman-telemetry-'));
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((t) => t.close()));
  rmSync(dir, { recursive: true, force: true });
});

describe('request ids', () => {
  it('count up within one process and never repeat across two', () => {
    const first = createRequestIdGenerator();
    const second = createRequestIdGenerator();
    const a = [first(), first(), first()];
    const b = [second(), second(), second()];
    expect(new Set([...a, ...b]).size).toBe(6);
    for (const id of [...a, ...b]) expect(id).toMatch(/^req-[0-9a-f]{8}-[0-9a-z]+$/);
    expect(a.map((id) => id.split('-')[1])).toEqual(Array(3).fill(a[0].split('-')[1]));
    expect(createRequestIdGenerator('tag')()).toBe('req-tag-1');
  });

  it('survive the redactor in a request line and in a canvas error line', () => {
    for (let i = 0; i < 200; i++) {
      const id = createRequestIdGenerator()();
      const request = JSON.stringify({ reqId: id, method: 'GET', path: '/api/status', status: 500, ms: 1 });
      const server = JSON.stringify({
        level: 'error',
        msg: `[canvas] GET /api/canvas/:workspaceId failed 500 reqId=${id}`,
      });
      expect(redactLogLine(request)).toBe(request);
      expect(redactLogLine(server)).toBe(server);
    }
  });
});

describe('build id', () => {
  it.each(['testbuild1', 'a.b_c-9', '1.47.0', 'x'.repeat(64)])('accepts %s', (id) => {
    expect(resolveBuildId(id, 'fallback')).toBe(id);
  });

  it.each([undefined, '', 'has space', 'x'.repeat(65), '../etc', 'a/b', 'id\n', 'ünï', 'a;b'])(
    'falls back for %j',
    (id) => {
      expect(resolveBuildId(id, 'fallback')).toBe('fallback');
    }
  );
});

describe('CODEMAN_LOG_MAX_BYTES', () => {
  it('uses a positive integer and otherwise the 20 MiB default', () => {
    expect(resolveMaxBytes('4096')).toBe(4096);
    for (const bad of [undefined, '', '0', '-5', '1.5', 'abc']) {
      expect(resolveMaxBytes(bad)).toBe(20 * 1024 * 1024);
    }
  });
});

describe('request path', () => {
  it('drops the query string', () => {
    expect(requestPath('/api/sessions?token=secret&x=1')).toBe('/api/sessions');
    expect(requestPath('/api/status')).toBe('/api/status');
    expect(requestPath('/?a=b')).toBe('/');
  });

  it('never carries a capability or QR token from the path', () => {
    expect(requestPath('/q/ab12cd')).toBe('/q/:redacted');
    expect(requestPath('/webview/capsecret/dash/app.js?v=1')).toBe('/webview/:redacted/dash/app.js');
    expect(requestPath('/html-view/capsecret/index.html')).toBe('/html-view/:redacted/index.html');
  });
});

describe('streams', () => {
  it('appends one JSON object per line with a timestamp, per stream file', async () => {
    const t = telemetry();
    t.write('requests', request(1));
    t.write('requests', request(2));
    t.write('client-errors', { buildId: 'b1', ua: 'UA', message: 'boom' });
    await t.flush();

    const requests = lines('requests.jsonl');
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ reqId: 'req-1', method: 'GET', path: '/api/status', status: 200, ms: 1 });
    expect(Date.parse(requests[0].ts as string)).not.toBeNaN();
    expect(lines('client-errors.jsonl')).toEqual([
      expect.objectContaining({ buildId: 'b1', ua: 'UA', message: 'boom' }),
    ]);
    expect(existsSync(join(dir, 'server.jsonl'))).toBe(false);
  });

  it('flushes on its own shortly after a write', async () => {
    const t = telemetry();
    t.write('requests', request(1));
    await vi.waitFor(() => expect(lines('requests.jsonl')).toHaveLength(1));
  });

  it('writes owner-only files', async () => {
    const t = telemetry();
    t.write('requests', request(1));
    await t.flush();
    expect(statSync(join(dir, 'requests.jsonl')).mode & 0o077).toBe(0);
  });
});

describe('rotation', () => {
  it('moves a file that has passed the cap to <name>.1 and starts a fresh one', async () => {
    const t = telemetry(300);
    for (let i = 0; i < 5; i++) t.write('requests', request(i));
    await t.flush();
    expect(lines('requests.jsonl')).toHaveLength(5);
    expect(existsSync(join(dir, 'requests.jsonl.1'))).toBe(false);

    t.write('requests', request(99));
    await t.flush();

    expect(lines('requests.jsonl')).toEqual([expect.objectContaining({ reqId: 'req-99' })]);
    expect(lines('requests.jsonl.1').map((l) => l.reqId)).toEqual(['req-0', 'req-1', 'req-2', 'req-3', 'req-4']);
  });

  it('replaces an older .1 instead of keeping a chain', async () => {
    writeFileSync(join(dir, 'requests.jsonl.1'), '{"old":true}\n');
    const t = telemetry(100);
    t.write('requests', request(1));
    await t.flush();
    t.write('requests', request(2));
    await t.flush();
    t.write('requests', request(3));
    await t.flush();

    expect(readFileSync(join(dir, 'requests.jsonl.1'), 'utf8')).not.toContain('"old"');
    expect(existsSync(join(dir, 'requests.jsonl.2'))).toBe(false);
  });

  it('judges the file on disk, so one another process already rotated away is not rotated again', async () => {
    const t = telemetry(300);
    for (let i = 0; i < 5; i++) t.write('requests', request(i));
    await t.flush();
    rmSync(join(dir, 'requests.jsonl'));

    t.write('requests', request(99));
    await t.flush();

    expect(existsSync(join(dir, 'requests.jsonl.1'))).toBe(false);
    expect(lines('requests.jsonl')).toEqual([expect.objectContaining({ reqId: 'req-99' })]);
  });
});

describe('failure isolation', () => {
  it('neither throws nor rejects when the directory is gone, and keeps working after it returns', async () => {
    const t = telemetry();
    rmSync(dir, { recursive: true, force: true });
    expect(() => t.write('requests', request(1))).not.toThrow();
    await expect(t.flush()).resolves.toBeUndefined();
    expect(() => t.flushSync()).not.toThrow();

    mkdirSync(dir);
    t.write('requests', request(2));
    await t.flush();
    expect(lines('requests.jsonl')).toEqual([expect.objectContaining({ reqId: 'req-2' })]);
  });

  it('survives a record it cannot serialize', async () => {
    const t = telemetry();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => t.write('requests', cyclic as never)).not.toThrow();
    t.write('requests', request(1));
    await t.flush();
    expect(lines('requests.jsonl')).toHaveLength(1);
  });

  it('flushSync writes what is still queued', () => {
    const t = telemetry();
    t.write('requests', request(1));
    t.flushSync();
    expect(lines('requests.jsonl')).toEqual([expect.objectContaining({ reqId: 'req-1' })]);
  });
});

describe('createTelemetryFromEnv', () => {
  it('is off when CODEMAN_LOG_DIR is unset or empty', () => {
    expect(createTelemetryFromEnv({})).toBeNull();
    expect(createTelemetryFromEnv({ CODEMAN_LOG_DIR: '' })).toBeNull();
  });

  it('creates the directory and stamps lines with the validated build id', async () => {
    const target = join(dir, 'nested', 'logs');
    const t = createTelemetryFromEnv({ CODEMAN_LOG_DIR: target, CODEMAN_BUILD_ID: 'env-build' });
    expect(t).not.toBeNull();
    open.push(t!);
    expect(t!.buildId).toBe('env-build');
    t!.write('requests', request(1));
    await t!.flush();
    expect(existsSync(join(target, 'requests.jsonl'))).toBe(true);
  });

  it('falls back to the package version for an invalid build id', () => {
    const t = createTelemetryFromEnv({ CODEMAN_LOG_DIR: dir, CODEMAN_BUILD_ID: 'not valid!' });
    open.push(t!);
    const { version } = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
    expect(t!.buildId).toBe(version);
  });

  it('is off, with a warning, when the directory cannot be used', () => {
    const file = join(dir, 'a-file');
    writeFileSync(file, 'x');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(createTelemetryFromEnv({ CODEMAN_LOG_DIR: join(file, 'logs') })).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('file telemetry is off'));
    warn.mockRestore();
  });
});

describe('console mirror', () => {
  it('mirrors every level into server.jsonl and leaves console output unchanged', async () => {
    const sinks = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const saved = { ...console };
    Object.assign(console, sinks);
    const t = telemetry(1024 * 1024, 'mirror-build');
    const uninstall = installConsoleMirror(t);
    try {
      console.log('hello', { a: 1 }, 42);
      console.info('i');
      console.warn('w');
      console.error('e %s', 'fmt');
      console.debug('d');
      await t.flush();
    } finally {
      uninstall();
      Object.assign(console, saved);
    }

    expect(sinks.log).toHaveBeenCalledWith('hello', { a: 1 }, 42);
    expect(sinks.error).toHaveBeenCalledWith('e %s', 'fmt');
    const got = lines('server.jsonl');
    expect(got.map((l) => l.level)).toEqual(['log', 'info', 'warn', 'error', 'debug']);
    expect(got[0]).toMatchObject({ buildId: 'mirror-build', pid: process.pid, msg: 'hello { a: 1 } 42' });
    expect(got[3].msg).toBe('e fmt');
  });

  it('stops mirroring once uninstalled', async () => {
    const log = vi.fn();
    const saved = console.log;
    console.log = log;
    const t = telemetry();
    const uninstall = installConsoleMirror(t);
    uninstall();
    console.log('after');
    await t.flush();
    console.log = saved;

    expect(log).toHaveBeenCalledWith('after');
    expect(existsSync(join(dir, 'server.jsonl'))).toBe(false);
  });

  it('caps one huge message and survives arguments that cannot be formatted', async () => {
    const saved = { ...console };
    Object.assign(console, { log: vi.fn(), error: vi.fn() });
    const t = telemetry();
    const uninstall = installConsoleMirror(t);
    try {
      console.log('x'.repeat(100_000));
      console.error('%s', {
        toString() {
          throw new Error('not printable');
        },
      });
      await t.flush();
    } finally {
      uninstall();
      Object.assign(console, saved);
    }
    const got = lines('server.jsonl');
    expect((got[0].msg as string).length).toBeLessThanOrEqual(8 * 1024);
    expect(got).toHaveLength(2);
  });
});
