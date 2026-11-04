/**
 * @fileoverview Map with automatic TTL-based entry expiration.
 *
 * StaleExpirationMap automatically removes entries that haven't been accessed
 * within a configurable TTL (time-to-live). Useful for caches and tracking
 * ephemeral data that should be cleaned up after a period of inactivity.
 *
 * @module utils/stale-expiration-map
 */

import type { Disposable } from '../types.js';

/**
 * Entry wrapper that tracks last access time.
 */
interface TimedEntry<V> {
  value: V;
  lastAccessedAt: number;
  createdAt: number;
}

/**
 * Configuration options for StaleExpirationMap.
 */
interface StaleExpirationMapOptions<K, V> {
  /** Time-to-live in milliseconds before entries expire */
  ttlMs: number;
  /** How often to run cleanup (default: ttlMs / 2) */
  cleanupIntervalMs?: number;
  /** Optional callback when an entry expires */
  onExpire?: (key: K, value: V) => void;
  /** Whether to refresh TTL on get (default: true) */
  refreshOnGet?: boolean;
}

/**
 * A Map that automatically expires entries after a TTL.
 *
 * Entries are removed if not accessed within the TTL period.
 * Periodic cleanup runs to remove expired entries.
 *
 * @example
 * ```typescript
 * const cache = new StaleExpirationMap<string, object>({
 *   ttlMs: 5 * 60 * 1000,  // 5 minutes
 *   onExpire: (key, value) => console.log(`Expired: ${key}`)
 * });
 *
 * cache.set('key1', { data: 'value' });
 * // After 5 minutes of no access, 'key1' will be automatically removed
 * ```
 */
export class StaleExpirationMap<K, V> implements Disposable {
  private entries = new Map<K, TimedEntry<V>>();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private _isDisposed = false;

  private readonly ttlMs: number;
  private readonly cleanupIntervalMs: number;
  private readonly onExpire?: (key: K, value: V) => void;
  private readonly refreshOnGet: boolean;

  /**
   * Creates a new StaleExpirationMap.
   *
   * @param options - Configuration options
   */
  constructor(options: StaleExpirationMapOptions<K, V>) {
    this.ttlMs = options.ttlMs;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? Math.floor(options.ttlMs / 2);
    this.onExpire = options.onExpire;
    this.refreshOnGet = options.refreshOnGet ?? true;

    // Start periodic cleanup
    this.startCleanup();
  }

  /**
   * Whether this map has been disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Number of entries in the map.
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Set a value with automatic TTL tracking.
   *
   * @param key - Key to set
   * @param value - Value to associate
   * @returns this (for chaining)
   */
  set(key: K, value: V): this {
    if (this._isDisposed) return this;

    const now = Date.now();
    this.entries.set(key, {
      value,
      lastAccessedAt: now,
      createdAt: now,
    });
    this.onChange('entries');
    return this;
  }

  /**
   * Put back an entry saved earlier with its original timestamps, as read from
   * {@link timedEntries}. An entry already past its TTL is not added.
   *
   * @returns True if the entry was added
   */
  restore(key: K, value: V, createdAt: number, lastAccessedAt: number): boolean {
    if (this._isDisposed) return false;
    const entry: TimedEntry<V> = { value, createdAt, lastAccessedAt };
    if (this.isExpired(entry)) return false;
    this.entries.set(key, entry);
    return true;
  }

  /**
   * Every non-expired entry with its timestamps, oldest insertion first, so a
   * subclass or owner can save the map and {@link restore} it later.
   */
  *timedEntries(): IterableIterator<{ key: K; value: V; createdAt: number; lastAccessedAt: number }> {
    for (const [key, entry] of this.entries) {
      if (!this.isExpired(entry)) {
        yield { key, value: entry.value, createdAt: entry.createdAt, lastAccessedAt: entry.lastAccessedAt };
      }
    }
  }

  /**
   * Called after the map changes. `entries` means an entry was added or removed;
   * `access` means only an access time moved. The base class does nothing.
   */
  protected onChange(_kind: 'entries' | 'access'): void {}

  /**
   * Get a value, optionally refreshing its TTL.
   *
   * @param key - Key to look up
   * @returns Value if found and not expired, undefined otherwise
   */
  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    // Check if expired
    if (this.isExpired(entry)) {
      this.delete(key);
      return undefined;
    }

    // Refresh access time if configured
    if (this.refreshOnGet) {
      entry.lastAccessedAt = Date.now();
      this.onChange('access');
    }

    return entry.value;
  }

  /**
   * Check if a key exists and is not expired.
   *
   * @param key - Key to check
   * @returns True if key exists and is not expired
   */
  has(key: K): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;

    if (this.isExpired(entry)) {
      this.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Peek at a value without refreshing its TTL.
   *
   * @param key - Key to peek
   * @returns Value if found and not expired, undefined otherwise
   */
  peek(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    if (this.isExpired(entry)) {
      this.delete(key);
      return undefined;
    }

    return entry.value;
  }

  /**
   * Delete an entry.
   *
   * @param key - Key to delete
   * @returns True if entry existed and was deleted
   */
  delete(key: K): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;

    this.entries.delete(key);
    this.onChange('entries');
    // Don't call onExpire for manual deletes
    return true;
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    const had = this.entries.size > 0;
    this.entries.clear();
    if (had) this.onChange('entries');
  }

  /**
   * Touch an entry to refresh its TTL without returning the value.
   *
   * @param key - Key to touch
   * @returns True if entry exists
   */
  touch(key: K): boolean {
    const entry = this.entries.get(key);
    if (!entry || this.isExpired(entry)) return false;

    entry.lastAccessedAt = Date.now();
    this.onChange('access');
    return true;
  }

  /**
   * Get the age of an entry in milliseconds.
   *
   * @param key - Key to check
   * @returns Age in ms, or undefined if not found
   */
  getAge(key: K): number | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    return Date.now() - entry.createdAt;
  }

  /**
   * Get remaining TTL for an entry in milliseconds.
   *
   * @param key - Key to check
   * @returns Remaining TTL in ms, or undefined if not found/expired
   */
  getRemainingTtl(key: K): number | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    const elapsed = Date.now() - entry.lastAccessedAt;
    const remaining = this.ttlMs - elapsed;
    return remaining > 0 ? remaining : 0;
  }

  /**
   * Iterate over all non-expired entries.
   */
  *[Symbol.iterator](): IterableIterator<[K, V]> {
    for (const [key, entry] of this.entries) {
      if (!this.isExpired(entry)) {
        yield [key, entry.value];
      }
    }
  }

  /**
   * Get all keys (non-expired).
   */
  *keys(): IterableIterator<K> {
    for (const [key, entry] of this.entries) {
      if (!this.isExpired(entry)) {
        yield key;
      }
    }
  }

  /**
   * Get all values (non-expired).
   */
  *values(): IterableIterator<V> {
    for (const [, entry] of this.entries) {
      if (!this.isExpired(entry)) {
        yield entry.value;
      }
    }
  }

  /**
   * Run cleanup immediately, removing all expired entries.
   *
   * @returns Number of entries removed
   */
  cleanup(): number {
    let removed = 0;
    const now = Date.now();

    for (const [key, entry] of this.entries) {
      if (now - entry.lastAccessedAt > this.ttlMs) {
        this.entries.delete(key);
        this.onExpire?.(key, entry.value);
        removed++;
      }
    }

    if (removed > 0) this.onChange('entries');
    return removed;
  }

  /**
   * Dispose the map, stopping cleanup timer and clearing entries.
   */
  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;

    this.stopCleanup();
    this.entries.clear();
  }

  /**
   * Check if an entry has expired.
   */
  private isExpired(entry: TimedEntry<V>): boolean {
    return Date.now() - entry.lastAccessedAt > this.ttlMs;
  }

  /**
   * Start the periodic cleanup timer.
   */
  private startCleanup(): void {
    if (this.cleanupTimer) return;

    this.cleanupTimer = setInterval(() => {
      if (!this._isDisposed) {
        this.cleanup();
      }
    }, this.cleanupIntervalMs);

    // Don't prevent process exit
    this.cleanupTimer.unref();
  }

  /**
   * Stop the periodic cleanup timer.
   */
  private stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
