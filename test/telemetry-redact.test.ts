/**
 * @fileoverview redactLogLine masks fixed secret shapes and never throws.
 * A line with none of those shapes is returned unchanged, including its newline.
 */
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SECRET_KEY_RE as CONFIG_BACKUP_SECRET_KEY_RE } from '../src/config-backup.js';
import { getHookSecret } from '../src/config/hook-secret.js';
import { dataPath } from '../src/config/instance.js';
import {
  HOOK_SECRET_READ_CAP,
  Telemetry,
  lastHookSecretReadBytes,
  readHookSecretForRedaction,
  resetTelemetryRedactionCache,
} from '../src/telemetry.js';
import { isTelemetrySecretKey, redactLogLine } from '../src/telemetry-redact.js';
import { queryLogs } from '../src/telemetry-query.js';

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

  it('keeps attribution keys and masks credential keys', () => {
    expect(CONFIG_BACKUP_SECRET_KEY_RE.test('author')).toBe(true);
    expect(CONFIG_BACKUP_SECRET_KEY_RE.test('authorization')).toBe(true);
    expect(CONFIG_BACKUP_SECRET_KEY_RE.test('keyboard')).toBe(false);

    for (const key of [
      'author',
      'authors',
      'authored',
      'authoredBy',
      'authored_by',
      'authored-by',
      'authorId',
      'author_id',
      'author-id',
      'authorName',
      'author_name',
      'author-name',
      'authUser',
      'auth_user',
      'auth-user',
    ]) {
      expect(isTelemetrySecretKey(key), key).toBe(false);
      expect(JSON.parse(redactLogLine(JSON.stringify({ [key]: 'agent-a' })))[key]).toBe('agent-a');
    }
    expect(JSON.parse(redactLogLine(JSON.stringify({ author: { name: 'agent-a' } }))).author).toEqual({
      name: 'agent-a',
    });

    const credentialKeys = [
      'auth',
      'authorization',
      'auth_token',
      'authToken',
      'x-auth-token',
      'proxy-authorization',
      'authentication',
      'Authentication',
      'AUTHENTICATION',
      'authenticate',
      'AUTHENTICATE',
      'oauth',
      'OAuth',
      'OAUTH',
      'oauth2',
      'xauth',
      'httpauth',
      'authheader',
      'HTTPAuth',
      `${'a'.repeat(81)}password`,
    ];
    for (const key of credentialKeys) {
      expect(isTelemetrySecretKey(key), key).toBe(true);
      expect(JSON.parse(redactLogLine(JSON.stringify({ [key]: TOKEN })))[key]).toBe('[redacted]');
    }
    expect(isTelemetrySecretKey('x-auth-user')).toBe(true);
    expect(isTelemetrySecretKey('keyboard')).toBe(true);
  });

  it('masks bearer tokens and URL userinfo', () => {
    const header = redactLogLine(`Authorization: Bearer ${TOKEN}`);
    expect(header).not.toContain(TOKEN);
    expect(header).toContain('[redacted]');
    expect(redactLogLine(`use bearer ${TOKEN} now`)).toBe('use Bearer [redacted] now');
    expect(redactLogLine(`request failed with BEARER ${TOKEN}`)).toBe('request failed with Bearer [redacted]');
    expect(redactLogLine(`clone https://user:p4ss@github.com/org/repo.git`)).toBe(
      'clone https://[redacted]@github.com/org/repo.git'
    );
    expect(redactLogLine(`clone HTTPS://user:p4ss@github.com/org/repo.git`)).toBe(
      'clone HTTPS://[redacted]@github.com/org/repo.git'
    );
    expect(redactLogLine(`clone https://${TOKEN}@example.invalid/repo.git`)).toBe(
      'clone https://[redacted]@example.invalid/repo.git'
    );
    expect(redactLogLine('https://github.com/org/repo')).toBe('https://github.com/org/repo');
    expect(redactLogLine('clone https://user@example.invalid/repo.git')).toBe(
      'clone https://[redacted]@example.invalid/repo.git'
    );
    expect(redactLogLine('clone https://us%3Aer:p%40ss@example.invalid/repo.git')).toBe(
      'clone https://[redacted]@example.invalid/repo.git'
    );
    expect(redactLogLine('clone git+https://user:p4ss@example.invalid/repo.git')).toBe(
      'clone git+https://[redacted]@example.invalid/repo.git'
    );
    expect(redactLogLine('clone custom.v1://user:p4ss@example.invalid/repo.git')).toBe(
      'clone custom.v1://[redacted]@example.invalid/repo.git'
    );
    expect(redactLogLine('https://example.invalid/a@b?q=@c#@d')).toBe('https://example.invalid/a@b?q=@c#@d');
    expect(redactLogLine(`request BEARER abc1234`)).toBe('request Bearer [redacted]');
    const user = 'u'.repeat(256);
    const password = `${TOKEN}pad`.padEnd(256, 'p');
    const longUrl = redactLogLine(`https://${user}:${password}@example.invalid/repo`);
    expect(longUrl).toBe('https://[redacted]@example.invalid/repo');
    expect(longUrl).not.toContain(TOKEN);
  });

  it('masks a secret-shaped JSON pair and an assignment buried in a string', () => {
    const buried = JSON.stringify({ msg: `see {"token":"${TOKEN}"}` }) + '\n';
    const out = redactLogLine(buried);
    expect(out).not.toContain(TOKEN);
    expect(JSON.parse(out).msg).toContain('[redacted]');
    expect(redactLogLine("password: 'hunter2'")).toBe('password: [redacted]');
    expect(redactLogLine('password=hunter2')).not.toContain('hunter2');
    expect(redactLogLine(`auth-header=${TOKEN}`)).toBe('auth-header= [redacted]');
    expect(redactLogLine(`auth.header=${TOKEN}`)).toBe('auth.header= [redacted]');
    expect(redactLogLine(`client-secret-value=${TOKEN}`)).toBe('client-secret-value= [redacted]');
    const nested = redactLogLine(format({ authorization: { value: TOKEN } }));
    expect(nested).not.toContain(TOKEN);
    expect(nested).not.toContain('] value');
    const longValue = redactLogLine(`password: '${'x'.repeat(8200)}${TOKEN}'`);
    expect(longValue).not.toContain(TOKEN);
    expect(longValue).toContain('[redacted]');
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

  it('finishes a 1 MiB adversarial line within a generous bound', () => {
    const patterns = ['://', '\'"{}auth', 'auth', `${'a.'.repeat(40)}://host/path`];
    for (const pattern of patterns) {
      const line = pattern.repeat(Math.ceil((1024 * 1024) / pattern.length)).slice(0, 1024 * 1024);
      const started = performance.now();
      const out = redactLogLine(line);
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(10_000);
      expect(typeof out).toBe('string');
      expect(out.length).toBeGreaterThan(0);
    }
  });

  it('does not throw on lone surrogates or NUL bytes', () => {
    const lone = 'before \uD800 after \uDE00 end';
    expect(typeof redactLogLine(lone)).toBe('string');
    const withNul = redactLogLine(`password=\u0000${TOKEN}`);
    expect(withNul).not.toContain(TOKEN);
    expect(typeof redactLogLine(`auth\u0000${'\uD800'.repeat(100)}`)).toBe('string');
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

  async function written(msg: string, text: string): Promise<{ raw: string; lines: string[] }> {
    const telemetry = sink();
    telemetry.write('server', { level: 'error', buildId: 'b', pid: 1, msg });
    await telemetry.flush();
    const raw = readFileSync(join(dir, 'server.jsonl'), 'utf8');
    const queried = await queryLogs({ dir, stream: 'server', text });
    return { raw, lines: queried.lines };
  }

  it('masks a URL username through the writer and the query', async () => {
    const cred = 'synthetic-credential-123456789';
    const { raw, lines } = await written(`clone https://${cred}@example.invalid/repo.git`, 'clone');
    expect(raw).not.toContain(cred);
    expect(raw).toContain('[redacted]');
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(cred);
    expect(lines[0]).toContain('https://[redacted]@example.invalid/repo.git');
  });

  it('masks secret-shaped keys as the console printer writes them', async () => {
    const cred = 'synthetic-credential-123456789';
    const inspected = format({ 'api-key': cred });
    const tabbed = `password:\t${cred}`;
    const escaped = `{"\\u0070assword":"${cred}"}`;
    const telemetry = sink();
    for (const msg of [inspected, tabbed, escaped]) {
      telemetry.write('server', { level: 'error', buildId: 'b', pid: 1, msg });
    }
    await telemetry.flush();
    const raw = readFileSync(join(dir, 'server.jsonl'), 'utf8');
    expect(raw).not.toContain(cred);
    const queried = await queryLogs({ dir, stream: 'server', text: cred });
    expect(queried.lines).toEqual([]);
    const masked = await queryLogs({ dir, stream: 'server', text: '[redacted]' });
    expect(masked.lines).toHaveLength(3);
  });

  it('masks any capitalization of the bearer scheme', async () => {
    const cred = 'synthetic-credential-123456789';
    const { raw, lines } = await written(`request failed with BEARER ${cred}`, 'request failed');
    expect(raw).not.toContain(cred);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(cred);
    expect(lines[0]).toContain('Bearer [redacted]');
  });

  it('masks a hook secret created after the first line', async () => {
    writeFileSync(dataPath('hook-secret'), '\n', { mode: 0o600 });
    resetTelemetryRedactionCache();
    const secret = 'ab12cd34ef56ab12cd34ef56ab12cd34';
    const telemetry = sink();
    telemetry.write('server', { level: 'log', buildId: 'b', pid: 1, msg: 'startup banner' });
    await telemetry.flush();
    writeFileSync(dataPath('hook-secret'), `${secret}\n`, { mode: 0o600 });
    telemetry.write('server', { level: 'error', buildId: 'b', pid: 1, msg: `hook failed: ${secret}` });
    await telemetry.flush();
    const raw = readFileSync(join(dir, 'server.jsonl'), 'utf8');
    expect(raw).toContain('startup banner');
    expect(raw).not.toContain(secret);
    const queried = await queryLogs({ dir, stream: 'server', text: 'hook failed' });
    expect(queried.lines).toHaveLength(1);
    expect(queried.lines[0]).not.toContain(secret);
    expect(queried.lines[0]).toContain('[redacted]');
  });

  it('masks credential keys from the second audit on disk and in the query', async () => {
    const cred = 'synthetic-credential-123456789';
    const keys = [
      'authentication',
      'Authentication',
      'AUTHENTICATION',
      'authenticate',
      'AUTHENTICATE',
      'oauth',
      'OAuth',
      'OAUTH',
      'oauth2',
      'xauth',
      'httpauth',
      'authheader',
      'HTTPAuth',
      `${'a'.repeat(81)}password`,
    ];
    const telemetry = sink();
    const record: Record<string, unknown> = { level: 'error', buildId: 'b', pid: 1, msg: 'kept' };
    for (const key of keys) record[key] = cred;
    telemetry.write('server', record as never);
    const longKey = `${'a'.repeat(81)}password`;
    telemetry.write('server', {
      level: 'error',
      buildId: 'b',
      pid: 1,
      msg: JSON.stringify({ [longKey]: cred }),
    });
    telemetry.write('server', {
      level: 'error',
      buildId: 'b',
      pid: 1,
      msg: 'names',
      author: 'agent-a',
      authored: 'agent-a',
      authUser: 'agent-a',
      authorId: 'agent-a',
      auth_user: 'agent-a',
    } as never);
    await telemetry.flush();
    const raw = readFileSync(join(dir, 'server.jsonl'), 'utf8');
    expect(raw).not.toContain(cred);
    expect(raw).toContain('agent-a');
    const leaked = await queryLogs({ dir, stream: 'server', text: cred });
    expect(leaked.lines).toEqual([]);
    const named = await queryLogs({ dir, stream: 'server', text: 'agent-a' });
    expect(named.lines).toHaveLength(1);
    const row = JSON.parse(named.lines[0]) as Record<string, string>;
    for (const key of ['author', 'authored', 'authUser', 'authorId', 'auth_user']) {
      expect(row[key]).toBe('agent-a');
    }
  });

  it('masks a long URL userinfo, separator keys, a whole object and a long quoted value', async () => {
    const cred = 'synthetic-credential-123456789';
    const user = 'u'.repeat(256);
    const password = cred.padEnd(256, 'p');
    const messages = [
      `https://${user}:${password}@example.invalid/repo`,
      `auth-header=${cred}`,
      `auth.header=${cred}`,
      `client-secret-value=${cred}`,
      format({ authorization: { value: cred } }),
      `password: '${'x'.repeat(8200)}${cred}'`,
      `request BEARER abc1234`,
    ];
    const telemetry = sink();
    for (const msg of messages) {
      telemetry.write('server', { level: 'error', buildId: 'b', pid: 1, msg });
    }
    await telemetry.flush();
    const raw = readFileSync(join(dir, 'server.jsonl'), 'utf8');
    expect(raw).not.toContain(cred);
    expect(raw).not.toContain('abc1234');
    const leaked = await queryLogs({ dir, stream: 'server', text: cred });
    expect(leaked.lines).toEqual([]);
    const short = await queryLogs({ dir, stream: 'server', text: 'abc1234' });
    expect(short.lines).toEqual([]);
  });

  it('reads at most 512 bytes of an oversized hook-secret file', async () => {
    const secret = 'ab12cd34ef56ab12cd34ef56ab12cd34';
    writeFileSync(dataPath('hook-secret'), `${secret}\n${'x'.repeat(1024 * 1024)}`, { mode: 0o600 });
    resetTelemetryRedactionCache();
    expect(readHookSecretForRedaction()).toBe(secret);
    expect(lastHookSecretReadBytes()).toBe(HOOK_SECRET_READ_CAP);
    expect(lastHookSecretReadBytes()).toBeLessThanOrEqual(512);
    expect(readHookSecretForRedaction()).toBe(secret);
    expect(lastHookSecretReadBytes()).toBe(0);
    const telemetry = sink();
    telemetry.write('server', { level: 'error', buildId: 'b', pid: 1, msg: `hook failed: ${secret}` });
    await telemetry.flush();
    const raw = readFileSync(join(dir, 'server.jsonl'), 'utf8');
    expect(raw).not.toContain(secret);
    const queried = await queryLogs({ dir, stream: 'server', text: 'hook failed' });
    expect(queried.lines).toHaveLength(1);
    expect(queried.lines[0]).not.toContain(secret);
  });

  it('masks a hook secret minted by getHookSecret after a miss', async () => {
    resetTelemetryRedactionCache();
    const telemetry = sink();
    telemetry.write('server', { level: 'log', buildId: 'b', pid: 1, msg: 'startup banner' });
    await telemetry.flush();
    const secret = getHookSecret();
    telemetry.write('server', { level: 'error', buildId: 'b', pid: 1, msg: `hook failed: ${secret}` });
    await telemetry.flush();
    const raw = readFileSync(join(dir, 'server.jsonl'), 'utf8');
    expect(raw).not.toContain(secret);
    const queried = await queryLogs({ dir, stream: 'server', text: 'hook failed' });
    expect(queried.lines).toHaveLength(1);
    expect(queried.lines[0]).not.toContain(secret);
  });
});
