/**
 * @fileoverview Saved login sessions (src/web/auth-session-store.ts).
 *
 * The file holds hashed cookies only, is 0600, is written only by the live colour, is
 * read back by a new process (a restart or the other colour), drops what has expired,
 * and refuses sessions saved under another password or auth mode. Readers accept a
 * later version with extra fields, the additive-change rule the previous release relies on.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuthSessionStore, authSessionKey, passwordStamp } from '../src/web/auth-session-store.js';
import { deployRole } from '../src/deploy-role.js';
import type { AuthSessionRecord } from '../src/web/ports/auth-port.js';

const DAY = 24 * 60 * 60 * 1000;
const TTL = 30 * DAY;
const CRED = 'admin:secret-password';

function record(ip = '10.0.0.1'): AuthSessionRecord {
  return { ip, ua: 'test-agent', createdAt: Date.now(), method: 'basic' };
}

describe('AuthSessionStore', () => {
  let dir: string;
  let file: string;
  const stores: AuthSessionStore[] = [];

  /** A store on the test file. Delays are 0 and 20 ms so a test waits a tick, not minutes. */
  function open(credential: string | null = CRED, maxSessions = 100): AuthSessionStore {
    const store = new AuthSessionStore({
      ttlMs: TTL,
      maxSessions,
      credential,
      filePath: () => file,
      entryWriteDelayMs: 0,
      accessWriteDelayMs: 20,
    });
    stores.push(store);
    store.load();
    return store;
  }

  const readFile = () => JSON.parse(readFileSync(file, 'utf-8'));
  const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codeman-auth-sessions-'));
    file = join(dir, 'auth-sessions.json');
    deployRole.initFromEnv({});
  });

  afterEach(() => {
    deployRole.initFromEnv({});
    for (const s of stores.splice(0)) s.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a 0600 file that holds the hash of the cookie, never the cookie', async () => {
    const store = open();
    store.set(authSessionKey('raw-cookie-value'), record());
    await tick();
    const text = readFileSync(file, 'utf-8');
    expect(text).not.toContain('raw-cookie-value');
    expect(text).not.toContain('secret-password');
    expect(readFile().sessions.map((s: { key: string }) => s.key)).toEqual([authSessionKey('raw-cookie-value')]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it('a new process on the same file sees the session, with its record and timestamps', async () => {
    const first = open();
    const key = authSessionKey('tok');
    first.set(key, { ...record('1.2.3.4'), username: 'alice', role: 'admin', passwordStamp: 'abc' });
    await tick();

    const second = open();
    expect(second.peek(key)).toMatchObject({ ip: '1.2.3.4', username: 'alice', role: 'admin', passwordStamp: 'abc' });
    expect(second.getAge(key)).toBeLessThan(1000);
    expect(second.getRemainingTtl(key)).toBeGreaterThan(TTL - 1000);
  });

  it('logout, revoke and revoke-all reach the file', async () => {
    const store = open();
    store.set(authSessionKey('a'), record());
    store.set(authSessionKey('b'), record());
    await tick();
    store.delete(authSessionKey('a'));
    await tick();
    expect(open().has(authSessionKey('a'))).toBe(false);
    store.clear();
    await tick();
    expect(readFile().sessions).toEqual([]);
  });

  it('does not load a session past its TTL', () => {
    const now = Date.now();
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        credential: null,
        sessions: [
          { key: authSessionKey('old'), createdAt: now - 40 * DAY, lastAccessedAt: now - 31 * DAY, record: record() },
          { key: authSessionKey('new'), createdAt: now - 40 * DAY, lastAccessedAt: now - 29 * DAY, record: record() },
        ],
      })
    );
    const store = open(null);
    expect(store.has(authSessionKey('old'))).toBe(false);
    expect(store.has(authSessionKey('new'))).toBe(true);
  });

  it('a session only used moves its expiry on disk on the slow timer, not on every request', async () => {
    const store = open();
    const key = authSessionKey('tok');
    store.set(key, record());
    await tick();
    const writtenAt = readFile().sessions[0].lastAccessedAt;
    await tick(10);
    store.get(key);
    await tick(2);
    expect(readFile().sessions[0].lastAccessedAt).toBe(writtenAt);
    await tick(40);
    expect(readFile().sessions[0].lastAccessedAt).toBeGreaterThan(writtenAt);
  });

  describe('only the live colour writes (rule 6)', () => {
    it('a candidate keeps its changes in memory and writes them once promoted', async () => {
      deployRole.initFromEnv({ CODEMAN_DEPLOY_ROLE: 'candidate' });
      const store = open();
      store.set(authSessionKey('tok'), record());
      await tick();
      expect(existsSync(file)).toBe(false);
      expect(store.hasPendingWrite).toBe(true);

      deployRole.enter('live');
      store.flush();
      expect(readFile().sessions).toHaveLength(1);
    });

    it('a retired colour writes nothing, even when disposed', async () => {
      const live = open();
      live.set(authSessionKey('kept'), record());
      await tick();

      deployRole.enter('retired');
      live.set(authSessionKey('late'), record());
      live.delete(authSessionKey('kept'));
      await tick();
      live.dispose();
      expect(readFile().sessions.map((s: { key: string }) => s.key)).toEqual([authSessionKey('kept')]);
    });

    it('a live colour flushes a pending change when disposed (shutdown)', () => {
      const store = new AuthSessionStore({
        ttlMs: TTL,
        maxSessions: 100,
        credential: CRED,
        filePath: () => file,
        entryWriteDelayMs: 60_000,
      });
      store.load();
      store.set(authSessionKey('tok'), record());
      expect(existsSync(file)).toBe(false);
      store.dispose();
      expect(readFile().sessions).toHaveLength(1);
    });

    it('load() on promotion replaces memory with what the old colour wrote', async () => {
      const oldColour = open();
      deployRole.initFromEnv({ CODEMAN_DEPLOY_ROLE: 'candidate' });
      const candidate = open();
      deployRole.initFromEnv({});
      // While the candidate stood by, the live colour minted a session.
      oldColour.set(authSessionKey('minted-during-overlap'), record());
      oldColour.flush();
      expect(candidate.has(authSessionKey('minted-during-overlap'))).toBe(false);
      candidate.load();
      expect(candidate.has(authSessionKey('minted-during-overlap'))).toBe(true);
      expect(candidate.hasPendingWrite).toBe(false);
    });
  });

  describe('the credential is pinned', () => {
    it('a different single-user password starts empty, and the next write replaces the file', async () => {
      const first = open('admin:old-password');
      first.set(authSessionKey('tok'), record());
      await tick();

      const second = open('admin:new-password');
      expect(second.size).toBe(0);
      second.set(authSessionKey('other'), record());
      await tick();
      expect(open('admin:old-password').size).toBe(0);
      expect(open('admin:new-password').has(authSessionKey('other'))).toBe(true);
    });

    it('a different username counts as a different credential', async () => {
      open('admin:pw').set(authSessionKey('tok'), record());
      await tick();
      expect(open('harry:pw').size).toBe(0);
    });

    it('single-user sessions do not load in multi-user mode, nor the reverse', async () => {
      open(CRED).set(authSessionKey('single'), record());
      await tick();
      expect(open(null).size).toBe(0);

      rmSync(file);
      open(null).set(authSessionKey('multi'), record());
      await tick();
      expect(open(CRED).size).toBe(0);
    });

    it('the file carries a salted digest, not the password', async () => {
      open(CRED).set(authSessionKey('tok'), record());
      await tick();
      const { credential } = readFile();
      expect(credential.salt).toMatch(/^[0-9a-f]{32}$/);
      expect(credential.hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('reading the file', () => {
    it('a missing, corrupt or foreign file is an empty store, never a throw', () => {
      expect(open().size).toBe(0);
      writeFileSync(file, '{not json');
      expect(open().size).toBe(0);
      writeFileSync(file, JSON.stringify({ hello: 'world' }));
      expect(open().size).toBe(0);
    });

    it('skips malformed records and keeps the good ones', () => {
      const now = Date.now();
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          credential: null,
          sessions: [
            { key: 'not-a-hash', createdAt: now, lastAccessedAt: now, record: record() },
            { key: authSessionKey('no-record'), createdAt: now, lastAccessedAt: now },
            { key: authSessionKey('good'), createdAt: now, lastAccessedAt: now, record: record() },
          ],
        })
      );
      const store = open(null);
      expect(store.size).toBe(1);
      expect(store.has(authSessionKey('good'))).toBe(true);
    });

    it('reads a later version that only added fields (the contract that keeps a rollback reading it)', () => {
      const now = Date.now();
      writeFileSync(
        file,
        JSON.stringify({
          version: 2,
          credential: null,
          addedLater: { anything: true },
          sessions: [
            {
              key: authSessionKey('tok'),
              createdAt: now,
              lastAccessedAt: now,
              deviceName: 'phone',
              record: { ...record(), futureField: 1 },
            },
          ],
        })
      );
      expect(open(null).has(authSessionKey('tok'))).toBe(true);
    });

    it('keeps the most recently used sessions when the file holds more than the cap', () => {
      const now = Date.now();
      const sessions = [0, 1, 2, 3].map((i) => ({
        key: authSessionKey(`t${i}`),
        createdAt: now - 10_000,
        lastAccessedAt: now - 10_000 + i,
        record: record(),
      }));
      writeFileSync(file, JSON.stringify({ version: 1, credential: null, sessions }));
      const store = open(null, 2);
      expect([...store.keys()].sort()).toEqual([authSessionKey('t2'), authSessionKey('t3')].sort());
    });
  });
});

describe('passwordStamp', () => {
  const hash = { algo: 'scrypt' as const, N: 16384, r: 8, p: 1, salt: 'aa', hash: 'bb' };

  it('changes when the salt does (every setPassword draws a new one)', () => {
    expect(passwordStamp(hash)).toBe(passwordStamp({ ...hash }));
    expect(passwordStamp(hash)).not.toBe(passwordStamp({ ...hash, salt: 'ab' }));
  });

  it('does not contain the salt or the hash', () => {
    const stamp = passwordStamp({ ...hash, salt: 'deadbeefdeadbeef', hash: 'cafebabecafebabe' });
    expect(stamp).toMatch(/^[0-9a-f]{16}$/);
    expect(stamp).not.toContain('deadbeef');
    expect(stamp).not.toContain('cafebabe');
  });
});
