/**
 * @fileoverview redactLogLine masks fixed secret shapes and never throws.
 * A line with none of those shapes is returned unchanged, including its newline.
 */
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataPath } from '../src/config/instance.js';
import { Telemetry, resetTelemetryRedactionCache } from '../src/telemetry.js';
import { SECRET_KEY_RE, redactLogLine } from '../src/telemetry-redact.js';

const TOKEN = 'abcdefghijklmnop';

describe('redactLogLine', () => {
  it('keeps a line that holds none of the secret shapes', () => {
    const line = '{"ts":"2026-11-10T00:00:00.000Z","level":"info","msg":"steady"}\n';
    expect(redactLogLine(line)).toBe(line);
  });

  it('keeps a sentence that merely contains the word key', () => {
    const line = '{"msg":"press key"}\n';
    expect(redactLogLine(line)).toBe(line);
    expect(redactLogLine('keyboard layout\n')).toBe('keyboard layout\n');
  });

  it('masks values under secret-shaped keys and leaves the key', () => {
    const line = JSON.stringify({
      password: 'hunter2',
      token: TOKEN,
      secret: 's',
      credential: 'c',
      authorization: 'a',
      apiKey: 'k',
      nested: { password: 'inner' },
      ok: 1,
    });
    const out = JSON.parse(redactLogLine(line)) as Record<string, unknown>;
    expect(out.password).toBe('[redacted]');
    expect(out.token).toBe('[redacted]');
    expect(out.secret).toBe('[redacted]');
    expect(out.credential).toBe('[redacted]');
    expect(out.authorization).toBe('[redacted]');
    expect(out.apiKey).toBe('[redacted]');
    expect(out.nested).toEqual({ password: '[redacted]' });
    expect(out.ok).toBe(1);
    expect(redactLogLine(line)).not.toContain('hunter2');
    expect(redactLogLine(line)).not.toContain(TOKEN);
  });

  it('masks an author key because SECRET_KEY_RE matches auth unanchored', () => {
    expect(SECRET_KEY_RE.test('author')).toBe(true);
    expect(SECRET_KEY_RE.test('keyboard')).toBe(false);
    expect(JSON.parse(redactLogLine('{"author":"ada"}')).author).toBe('[redacted]');
  });

  it('masks bearer tokens and URL userinfo', () => {
    const header = redactLogLine(`Authorization: Bearer ${TOKEN}`);
    expect(header).not.toContain(TOKEN);
    expect(header).toContain('[redacted]');
    expect(redactLogLine(`use bearer ${TOKEN} now`)).toBe('use Bearer [redacted] now');
    expect(redactLogLine(`clone https://user:p4ss@github.com/org/repo.git`)).toBe(
      'clone https://[redacted]@github.com/org/repo.git'
    );
    expect(redactLogLine('https://github.com/org/repo')).toBe('https://github.com/org/repo');
  });

  it('masks a secret-shaped JSON pair and an assignment buried in a string', () => {
    const buried = JSON.stringify({ msg: `see {"token":"${TOKEN}"}` }) + '\n';
    const out = redactLogLine(buried);
    expect(out).not.toContain(TOKEN);
    expect(JSON.parse(out).msg).toContain('[redacted]');
    expect(redactLogLine("password: 'hunter2'")).toBe('password: [redacted]');
    expect(redactLogLine('password=hunter2')).not.toContain('hunter2');
  });

  it('replaces a hook secret as a literal, and ignores one that is too short', () => {
    const dots = '.'.repeat(16);
    expect(redactLogLine('abcdefghijklmnop', dots)).toBe('abcdefghijklmnop');
    expect(redactLogLine(`see ${dots} here`, dots)).toBe('see [redacted] here');
    expect(redactLogLine('the short value stays', 'short')).toBe('the short value stays');
  });

  it('does not throw on odd input', () => {
    expect(redactLogLine(null)).toBe('');
    expect(redactLogLine(undefined)).toBe('');
    expect(redactLogLine(3)).toBe('3');
    expect(redactLogLine(true)).toBe('true');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(redactLogLine(circular)).toBe('[unredactable]');
    expect(redactLogLine(Symbol('x'))).toBe('[unredactable]');
  });

  it('stays cheap on clean lines', () => {
    const line = '{"ts":"2026-11-10T00:00:00.000Z","level":"info","msg":"steady"}\n';
    const started = performance.now();
    for (let i = 0; i < 50_000; i++) {
      if (redactLogLine(line) !== line) throw new Error('a clean line was rewritten');
    }
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('redaction before the queue', () => {
  let dir: string;
  const open: Telemetry[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codeman-redact-'));
    resetTelemetryRedactionCache();
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map((t) => t.close()));
    rmSync(dir, { recursive: true, force: true });
    resetTelemetryRedactionCache();
    try {
      unlinkSync(dataPath('hook-secret'));
    } catch {
      /* no secret was planted */
    }
  });

  function sink(): Telemetry {
    const telemetry = new Telemetry(dir, 'b', 1024 * 1024);
    open.push(telemetry);
    return telemetry;
  }

  it('writes [redacted] where a bearer token was', async () => {
    const telemetry = sink();
    telemetry.write('server', {
      level: 'error',
      buildId: 'b',
      pid: 1,
      msg: `Authorization: Bearer ${TOKEN}`,
    });
    await telemetry.flush();
    const raw = readFileSync(join(dir, 'server.jsonl'), 'utf8');
    expect(raw).toContain('[redacted]');
    expect(raw).not.toContain(TOKEN);
  });

  it('masks a password field and the hook secret already on disk', async () => {
    const secret = 'ab12cd34ef56ab12cd34ef56ab12cd34';
    writeFileSync(dataPath('hook-secret'), `${secret}\n`, { mode: 0o600 });
    resetTelemetryRedactionCache();
    const telemetry = sink();
    telemetry.write('server', {
      level: 'log',
      buildId: 'b',
      pid: 1,
      msg: `hook ${secret}`,
      password: 'hunter2',
    } as never);
    await telemetry.flush();
    const raw = readFileSync(join(dir, 'server.jsonl'), 'utf8');
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain('hunter2');
    const row = JSON.parse(raw) as { password?: string; msg?: string };
    expect(row.password).toBe('[redacted]');
    expect(row.msg).toContain('[redacted]');
  });
});
