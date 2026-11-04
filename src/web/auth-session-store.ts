/**
 * @fileoverview Login sessions (`codeman_session` cookies) kept in the data dir, so a
 * deploy, a rollback or a restart no longer logs everyone out.
 *
 * The rules:
 * - **Tokens are never stored.** The map is keyed by {@link authSessionKey} (SHA-256 of the
 *   cookie value), in memory and on disk, so a copy of the file (a deploy backup, say) is
 *   not a set of working cookies. Every caller hashes the cookie before a lookup.
 * - **Only the live colour writes** (`deployRole.allows('persist')`, checked at the moment
 *   of the write). A candidate or retired colour keeps its changes in memory and leaves the
 *   file to the live one. The server reloads the file on promotion and flushes it on
 *   retire and reinstate, through `promoteToLive()` and `writeSharedState()`.
 * - **The credential is pinned.** Single-user mode stores a salted scrypt digest of
 *   `CODEMAN_USERNAME:CODEMAN_PASSWORD`; a boot with a different password, or in the other
 *   auth mode, starts empty, which is what a restart used to do. Multi-user sessions carry
 *   {@link passwordStamp} instead and the cookie path drops one whose user's password has
 *   changed since it was minted.
 * - **Writes are batched.** A login, logout or revoke is written within
 *   {@link ENTRY_WRITE_DELAY_MS}; a cookie that was only used moves its sliding expiry on
 *   disk at most every {@link ACCESS_WRITE_DELAY_MS}, which is noise against a 30-day TTL.
 * - **Format.** `{ version: 1, credential, sessions: [{ key, createdAt, lastAccessedAt,
 *   record }] }`, 0600, written through tmp + rename. Readers accept any version >= 1 and
 *   ignore fields they do not know, so later changes must be additive: rule 5 of
 *   docs/self-building.md, the release before must still read the file. A file that cannot
 *   be read is an empty store, never a failed boot.
 *
 * Releases from before this file never read it, so a rollback past it logs people out
 * once and leaves the file alone; logins and revocations made while such a release is live
 * do not reach the file.
 *
 * @module web/auth-session-store
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from '../config/instance.js';
import { deployRole } from '../deploy-role.js';
import { StaleExpirationMap } from '../utils/index.js';
import type { PasswordHash } from '../types.js';
import type { AuthSessionRecord } from './ports/auth-port.js';

export const AUTH_SESSIONS_FILE = 'auth-sessions.json';
const FILE_VERSION = 1;

/** A login, logout or revoke reaches the disk this soon. */
export const ENTRY_WRITE_DELAY_MS = 250;
/** A cookie that was only used moves its expiry on disk at most this often. */
export const ACCESS_WRITE_DELAY_MS = 5 * 60 * 1000;
/** How often expired sessions are swept from memory (and so from the next write). */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** The map key for a cookie value. The raw token is never kept. */
export function authSessionKey(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * A short fingerprint of a user's password record that changes whenever the password
 * does (`setPassword` draws a fresh salt). Derived from the salt alone, so it says
 * nothing about the password.
 */
export function passwordStamp(password: PasswordHash): string {
  return createHash('sha256').update(`codeman-auth-session:${password.salt}`).digest('hex').slice(0, 16);
}

interface CredentialDigest {
  salt: string;
  hash: string;
}

interface StoredSession {
  key: string;
  createdAt: number;
  lastAccessedAt: number;
  record: AuthSessionRecord;
}

interface StoredFile {
  version: number;
  credential: CredentialDigest | null;
  sessions: StoredSession[];
}

export interface AuthSessionStoreOptions {
  ttlMs: number;
  /** Most sessions kept; a load keeps the most recently used. */
  maxSessions: number;
  /**
   * The single-user `username:password`, or null in multi-user mode. A file written
   * under another credential (or the other mode) is not loaded.
   */
  credential: string | null;
  /** Resolved per call: test HOMEs change between files. */
  filePath?: () => string;
  entryWriteDelayMs?: number;
  accessWriteDelayMs?: number;
}

function deriveCredential(credential: string, salt: string): string {
  return scryptSync(credential, Buffer.from(salt, 'hex'), 32).toString('hex');
}

function isStoredSession(value: unknown): value is StoredSession {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const r = v.record as Record<string, unknown> | undefined;
  return (
    typeof v.key === 'string' &&
    /^[0-9a-f]{64}$/.test(v.key) &&
    typeof v.createdAt === 'number' &&
    typeof v.lastAccessedAt === 'number' &&
    !!r &&
    typeof r === 'object' &&
    typeof r.ip === 'string' &&
    typeof r.ua === 'string' &&
    typeof r.createdAt === 'number' &&
    (r.method === 'basic' || r.method === 'qr')
  );
}

export class AuthSessionStore extends StaleExpirationMap<string, AuthSessionRecord> {
  private readonly filePath: () => string;
  private readonly maxSessions: number;
  private readonly credential: string | null;
  private readonly entryWriteDelayMs: number;
  private readonly accessWriteDelayMs: number;
  /** The credential digest written with the file; its salt is reused while the credential holds. */
  private digest: CredentialDigest | null = null;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private timerDueAt = 0;
  /** Set while load() fills the map, so the fill itself schedules no write. */
  private loading = false;

  constructor(options: AuthSessionStoreOptions) {
    super({ ttlMs: options.ttlMs, refreshOnGet: true, cleanupIntervalMs: CLEANUP_INTERVAL_MS });
    this.filePath = options.filePath ?? (() => dataPath(AUTH_SESSIONS_FILE));
    this.maxSessions = options.maxSessions;
    this.credential = options.credential;
    this.entryWriteDelayMs = options.entryWriteDelayMs ?? ENTRY_WRITE_DELAY_MS;
    this.accessWriteDelayMs = options.accessWriteDelayMs ?? ACCESS_WRITE_DELAY_MS;
  }

  /**
   * Replace what is in memory with what is on disk: at boot, and when this colour is
   * promoted and the colour that served until now has flushed. Returns how many sessions
   * were loaded. Reading is allowed in every role.
   */
  load(): number {
    this.cancelTimer();
    this.dirty = false;
    this.loading = true;
    try {
      this.clear();
      const file = this.readFile();
      if (!file) return 0;
      if (!this.credentialMatches(file.credential)) {
        console.log('[Auth] Saved login sessions belong to another password or auth mode; starting empty');
        return 0;
      }
      const sessions = file.sessions
        .filter(isStoredSession)
        .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt)
        .slice(-this.maxSessions);
      let loaded = 0;
      for (const s of sessions) {
        if (this.restore(s.key, s.record, s.createdAt, s.lastAccessedAt)) loaded++;
      }
      return loaded;
    } finally {
      this.loading = false;
    }
  }

  /** Write a pending change now: retire, reinstate and shutdown call this. */
  flush(): void {
    if (!this.dirty) return;
    this.cancelTimer();
    this.writeNow();
  }

  /** Whether a change is waiting to be written (a non-live colour keeps it pending). */
  get hasPendingWrite(): boolean {
    return this.dirty;
  }

  override dispose(): void {
    if (this.isDisposed) return;
    this.flush();
    this.cancelTimer();
    super.dispose();
  }

  protected override onChange(kind: 'entries' | 'access'): void {
    if (this.loading || this.isDisposed) return;
    this.dirty = true;
    this.schedule(kind === 'entries' ? this.entryWriteDelayMs : this.accessWriteDelayMs);
  }

  private schedule(delayMs: number): void {
    const dueAt = Date.now() + delayMs;
    if (this.timer && this.timerDueAt <= dueAt) return;
    this.cancelTimer();
    this.timerDueAt = dueAt;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writeNow();
    }, delayMs);
    // A pending write must not hold the process open; shutdown flushes it explicitly.
    this.timer.unref();
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private credentialMatches(stored: CredentialDigest | null): boolean {
    if (this.credential === null) {
      this.digest = null;
      return stored === null;
    }
    if (!stored || typeof stored.salt !== 'string' || typeof stored.hash !== 'string') return false;
    let derived: string;
    try {
      derived = deriveCredential(this.credential, stored.salt);
    } catch {
      return false;
    }
    const a = Buffer.from(derived, 'hex');
    const b = Buffer.from(stored.hash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    this.digest = { salt: stored.salt, hash: stored.hash };
    return true;
  }

  private currentDigest(): CredentialDigest | null {
    if (this.credential === null) return null;
    if (!this.digest) {
      const salt = randomBytes(16).toString('hex');
      this.digest = { salt, hash: deriveCredential(this.credential, salt) };
    }
    return this.digest;
  }

  private readFile(): StoredFile | null {
    const path = this.filePath();
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<StoredFile>;
      if (typeof parsed.version !== 'number' || parsed.version < 1 || !Array.isArray(parsed.sessions)) {
        console.warn(`[Auth] Ignoring ${path}: not a login session file this release can read`);
        return null;
      }
      return { version: parsed.version, credential: parsed.credential ?? null, sessions: parsed.sessions };
    } catch (err) {
      console.warn(`[Auth] Failed to read ${path}, starting with no saved logins:`, err);
      return null;
    }
  }

  /** Write the whole map. Only the live colour writes; anything else stays pending. */
  private writeNow(): void {
    if (this.isDisposed || !deployRole.allows('persist')) return;
    const path = this.filePath();
    const tmpPath = `${path}.tmp`;
    const sessions: StoredSession[] = [];
    for (const e of this.timedEntries()) {
      sessions.push({ key: e.key, createdAt: e.createdAt, lastAccessedAt: e.lastAccessedAt, record: e.value });
    }
    const file: StoredFile = { version: FILE_VERSION, credential: this.currentDigest(), sessions };
    try {
      mkdirSync(dirname(path), { recursive: true });
      // 0600 like the other credential-adjacent files. `mode` applies only when the file
      // is created, and the rename makes every write a fresh file.
      rmSync(tmpPath, { force: true });
      writeFileSync(tmpPath, JSON.stringify(file), { mode: 0o600 });
      renameSync(tmpPath, path);
      this.dirty = false;
    } catch (err) {
      console.warn(`[Auth] Failed to save login sessions to ${path}:`, err);
    }
  }
}
