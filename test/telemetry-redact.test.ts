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
    for (const key of ['cookie', 'Set-Cookie', 'codeman_session', 'sid']) {
      expect(isTelemetrySecretKey(key), key).toBe(true);
    }
    for (const key of ['session', 'sessionId', 'session_id', 'claudeSessionId']) {
      expect(isTelemetrySecretKey(key), key).toBe(false);
    }
    for (const key of [
      'tokens',
      'inputTokens',
      'output_tokens',
      'totalTokens',
      'max_tokens',
      'cache_read_input_tokens',
      'tokenCount',
      'tokenUsage',
      'tokenLimit',
      'tokenBudget',
    ]) {
      expect(isTelemetrySecretKey(key), key).toBe(false);
    }
    for (const key of [
      'token',
      'access_token',
      'refresh_token',
      'id_token',
      'tokenSecret',
      'authTokens',
      'refreshTokens',
    ]) {
      expect(isTelemetrySecretKey(key), key).toBe(true);
    }
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

  it('is idempotent on the split-authority witness and 2000 seeded strings', () => {
    const witness = 'passw://}s://[@';
    const once = redactLogLine(witness);
    expect(redactLogLine(once)).toBe(once);
    expect(once).not.toContain('://[@');
    // The audit minimised to that witness and did not list the atom set.
    // These are the characters and words the scanners actually branch on.
    const atoms = [
      'a',
      's',
      ':',
      '/',
      '@',
      '=',
      '"',
      "'",
      '{',
      '}',
      '[',
      ']',
      ' ',
      'passw',
      'password',
      'auth',
      'key',
      'bearer',
      'http',
      'Error',
      '://',
      'Basic',
      'Cookie',
      ';',
      'sk-',
      '1',
      '.',
      '-',
      '_',
      'x',
    ];
    let seed = 0xc0de4a11;
    const next = (): number => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let n = 0; n < 2000; n++) {
      let sample = '';
      for (let k = 0; k < 12; k++) sample += atoms[Math.floor(next() * atoms.length)];
      const redacted = redactLogLine(sample);
      expect(redactLogLine(redacted), sample).toBe(redacted);
    }
  });

  it('redacts a long quoted key without copying it into the classifier', () => {
    const times: string[] = [];
    for (const bytes of [1024 * 1024, 4 * 1024 * 1024]) {
      const line = `"${'a'.repeat(bytes - 16)}password":"abc"`;
      expect(line.length).toBe(bytes);
      const started = performance.now();
      const out = redactLogLine(line);
      const elapsed = performance.now() - started;
      times.push(elapsed);
      expect(out, `${bytes} took ${elapsed.toFixed(2)} ms`).not.toContain(':"abc"');
      expect(out).toContain('[redacted]');
      expect(elapsed, `${bytes} took ${elapsed.toFixed(2)} ms`).toBeLessThan(bytes === 1024 * 1024 ? 250 : 1000);
    }
    expect(times).toHaveLength(2);
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

  it('masks a quoted assignment, a repeated @ and a digit key on disk and in the query', async () => {
    const cred = 'synthetic-credential-123456789';
    const messages = [
      `note: "password=${cred}"`,
      JSON.stringify({ details: `password=${cred}` }),
      format({ details: `password=${cred}` }),
      `clone https://user:first@${cred}@example.invalid/repo`,
      `1password=${cred}`,
    ];
    const telemetry = sink();
    for (const msg of messages) {
      telemetry.write('server', { level: 'error', buildId: 'b', pid: 1, msg });
    }
    await telemetry.flush();
    const raw = readFileSync(join(dir, 'server.jsonl'), 'utf8');
    expect(raw).not.toContain(cred);
    expect(raw).toContain('https://[redacted]@example.invalid/repo');
    const leaked = await queryLogs({ dir, stream: 'server', text: cred });
    expect(leaked.lines).toEqual([]);
    const url = await queryLogs({ dir, stream: 'server', text: 'example.invalid/repo' });
    expect(url.lines).toHaveLength(1);
    expect(url.lines[0]).toContain('https://[redacted]@example.invalid/repo');
    expect(url.lines[0]).not.toContain(cred);
  });

  it('keeps a stack frame, a host port and an Error label on disk and in the query', async () => {
    const frame = 'at readFile (/workspace/src/web/auth-session-store.ts:247:27)';
    const banner = 'listening on http://example.invalid:4567';
    const failed = 'Failed to set env override COPILOT_KEYBOARD: Error: command failed';
    const settings = 'Failed to read settings: Error: EACCES';
    const telemetry = sink();
    for (const msg of [frame, banner, failed, settings]) {
      telemetry.write('server', { level: 'error', buildId: 'b', pid: 1, msg });
    }
    await telemetry.flush();
    const raw = readFileSync(join(dir, 'server.jsonl'), 'utf8');
    expect(raw).toContain('auth-session-store.ts:247:27');
    expect(raw).toContain('http://example.invalid:4567');
    expect(raw).toContain('Error: command failed');
    expect(raw).toContain('Error: EACCES');
    const queried = await queryLogs({ dir, stream: 'server', text: 'auth-session-store.ts:247:27' });
    expect(queried.lines).toHaveLength(1);
    expect(queried.lines[0]).toContain(frame);
    const port = await queryLogs({ dir, stream: 'server', text: 'example.invalid:4567' });
    expect(port.lines).toHaveLength(1);
    expect(port.lines[0]).toContain(banner);
    const label = await queryLogs({ dir, stream: 'server', text: 'Error: command failed' });
    expect(label.lines).toHaveLength(1);
    expect(label.lines[0]).toContain(failed);
  });

  it('masks an unquoted secret value through the end of the line', async () => {
    const cred = 'synthetic-credential-123456789';
    const messages = [
      `Authorization: Basic ${cred}`,
      `Proxy-Authorization: Basic ${cred}`,
      `authorization: token ${cred}`,
      `Authorization: Digest username="u", response="${cred}"`,
      `password: correct horse ${cred}`,
      `curl -H "X-Api-Key: ${cred}" http://h`,
    ];
    const telemetry = sink();
    for (const msg of messages) {
      telemetry.write('server', { level: 'error', buildId: 'b', pid: 1, msg });
    }
    await telemetry.flush();
    const raw = readFileSync(join(dir, 'server.jsonl'), 'utf8');
    expect(raw).not.toContain(cred);
    const leaked = await queryLogs({ dir, stream: 'server', text: cred });
    expect(leaked.lines).toEqual([]);
    expect(raw).toContain('Authorization: [redacted]');
    expect(raw).not.toContain(`Basic ${cred}`);
    const basic = await queryLogs({ dir, stream: 'server', text: 'Authorization: [redacted]' });
    expect(basic.lines.length).toBeGreaterThan(0);
    expect(basic.lines.every((line) => !line.includes(cred))).toBe(true);
  });

  it('masks cookie headers and sid, and keeps session ids', async () => {
    const cred = 'synthetic-credential-123456789';
    const telemetry = sink();
    telemetry.write('server', {
      level: 'error',
      buildId: 'b',
      pid: 1,
      msg: 'correlation',
      session: 'sess-keep',
      sessionId: 'sess-keep',
      session_id: 'sess-keep',
      claudeSessionId: 'sess-keep',
      cookie: cred,
      sid: cred,
    } as never);
    for (const msg of [
      `Cookie: codeman_session=${cred}; theme=dark`,
      `Set-Cookie: codeman_session=${cred}; Path=/`,
      `cookie: sid=${cred}`,
    ]) {
      telemetry.write('server', { level: 'error', buildId: 'b', pid: 1, msg });
    }
    await telemetry.flush();
    const raw = readFileSync(join(dir, 'server.jsonl'), 'utf8');
    expect(raw).not.toContain(cred);
    expect(raw).toContain('sess-keep');
    const leaked = await queryLogs({ dir, stream: 'server', text: cred });
    expect(leaked.lines).toEqual([]);
    const kept = await queryLogs({ dir, stream: 'server', text: 'sess-keep' });
    expect(kept.lines).toHaveLength(1);
    const row = JSON.parse(kept.lines[0]) as Record<string, string>;
    for (const key of ['session', 'sessionId', 'session_id', 'claudeSessionId']) {
      expect(row[key]).toBe('sess-keep');
    }
    expect(row.cookie).toBe('[redacted]');
    expect(row.sid).toBe('[redacted]');
  });

  it('masks known token shapes with no key', async () => {
    const cred = 'synthetic-credential-123456789';
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w5N';
    const aws = 'AKIAIOSFODNN7EXAMPLE';
    const messages = [
      `sk-ant-api03-${cred}`,
      `ghp_${'A'.repeat(36)}`,
      `github_pat_${'B'.repeat(22)}`,
      `xoxb-${'1'.repeat(12)}`,
      aws,
      jwt,
    ];
    const telemetry = sink();
    for (const msg of messages) {
      telemetry.write('server', { level: 'error', buildId: 'b', pid: 1, msg });
    }
    await telemetry.flush();
    const raw = readFileSync(join(dir, 'server.jsonl'), 'utf8');
    expect(raw).not.toContain(cred);
    expect(raw).not.toContain('AAAAAAAA');
    expect(raw).not.toContain(aws);
    expect(raw).not.toContain('eyJhbGci');
    const leaked = await queryLogs({ dir, stream: 'server', text: cred });
    expect(leaked.lines).toEqual([]);
    const pat = await queryLogs({ dir, stream: 'server', text: 'github_pat_' });
    expect(pat.lines).toEqual([]);
  });

  it('masks a curl user argument', async () => {
    const cred = 'synthetic-credential-123456789';
    const telemetry = sink();
    telemetry.write('server', { level: 'error', buildId: 'b', pid: 1, msg: `-u admin:${cred} https://h` });
    telemetry.write('server', { level: 'error', buildId: 'b', pid: 1, msg: `--user admin:${cred} https://h` });
    await telemetry.flush();
    const raw = readFileSync(join(dir, 'server.jsonl'), 'utf8');
    expect(raw).not.toContain(cred);
    expect(raw).toContain('https://h');
    const leaked = await queryLogs({ dir, stream: 'server', text: cred });
    expect(leaked.lines).toEqual([]);
    const kept = await queryLogs({ dir, stream: 'server', text: 'https://h' });
    expect(kept.lines).toHaveLength(2);
    expect(kept.lines.every((line) => line.includes('[redacted]') && !line.includes(cred))).toBe(true);
  });

  it('keeps token usage counts and still masks token secrets', async () => {
    const cred = 'synthetic-credential-123456789';
    const usage = 'tokens: 15234 input, 921 output';
    const max = 'max_tokens=4096';
    const telemetry = sink();
    telemetry.write('server', {
      level: 'log',
      buildId: 'b',
      pid: 1,
      msg: usage,
      inputTokens: 15234,
      outputTokens: 921,
      totalTokens: 16155,
    } as never);
    telemetry.write('server', { level: 'log', buildId: 'b', pid: 1, msg: max });
    telemetry.write('server', { level: 'log', buildId: 'b', pid: 1, msg: 'tokens: 174k' });
    for (const msg of [
      `token: ${cred}`,
      `access_token=${cred}`,
      `refreshTokens: ${cred}`,
      `authTokens: ["${cred}"]`,
      `{"tokens":{"access":"${cred}"}}`,
      `tokens: 1${cred}`,
      'tokens: 12ab34cd56ef',
      'max_tokens=4096abcdef',
    ]) {
      telemetry.write('server', { level: 'error', buildId: 'b', pid: 1, msg });
    }
    telemetry.write('server', {
      level: 'error',
      buildId: 'b',
      pid: 1,
      msg: 'nested',
      tokens: { access: cred },
    } as never);
    await telemetry.flush();
    const raw = readFileSync(join(dir, 'server.jsonl'), 'utf8');
    expect(raw).toContain(usage);
    expect(raw).toContain(max);
    expect(raw).toContain('tokens: 174k');
    expect(raw).not.toContain('12ab34cd56ef');
    expect(raw).not.toContain('4096abcdef');
    expect(raw).toContain('"inputTokens":15234');
    expect(raw).toContain('"outputTokens":921');
    expect(raw).toContain('"totalTokens":16155');
    expect(raw).not.toContain(cred);
    const leaked = await queryLogs({ dir, stream: 'server', text: cred });
    expect(leaked.lines).toEqual([]);
    const kept = await queryLogs({ dir, stream: 'server', text: usage });
    expect(kept.lines).toHaveLength(1);
    expect(kept.lines[0]).toContain(usage);
    const row = JSON.parse(kept.lines[0]) as {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    };
    expect(row.inputTokens).toBe(15234);
    expect(row.outputTokens).toBe(921);
    expect(row.totalTokens).toBe(16155);
    const cap = await queryLogs({ dir, stream: 'server', text: max });
    expect(cap.lines).toHaveLength(1);
    expect(cap.lines[0]).toContain(max);
    const kilo = await queryLogs({ dir, stream: 'server', text: 'tokens: 174k' });
    expect(kilo.lines).toHaveLength(1);
    expect(kilo.lines[0]).toContain('tokens: 174k');
    const glued = await queryLogs({ dir, stream: 'server', text: '12ab34cd56ef' });
    expect(glued.lines).toEqual([]);
    const junk = await queryLogs({ dir, stream: 'server', text: '4096abcdef' });
    expect(junk.lines).toEqual([]);
    const nested = await queryLogs({ dir, stream: 'server', text: '"tokens":"[redacted]"' });
    expect(nested.lines.length).toBeGreaterThan(0);
    expect(nested.lines.every((line) => !line.includes(cred))).toBe(true);
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
