/**
 * @fileoverview Cycle budget for the respawn loop: stops a loop that has nothing to do.
 *
 * After each cycle the controller fingerprints the session's working directory
 * (git HEAD + hashes of `git status --porcelain` and `git diff`). A run of
 * consecutive identical fingerprints means the cycles are producing nothing.
 * Non-git directories use a bounded content hash instead.
 *
 * @module respawn-cycle-budget
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { probePathKind } from './utils/bounded-path-probe.js';

/** Consecutive unchanged cycles after which the loop stops. 0 disables the check. */
export const DEFAULT_MAX_UNCHANGED_CYCLES = 3;

const GIT_TIMEOUT_MS = 10000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 1024 * 1024;

async function contentFingerprint(workingDir: string): Promise<string | null> {
  const hash = createHash('sha256');
  let files = 0;
  let directories = 0;
  const pending = [''];
  try {
    while (pending.length && files < MAX_FILES && directories < MAX_FILES) {
      const relativeDir = pending.pop()!;
      directories++;
      const entries = await readdir(join(workingDir, relativeDir), { withFileTypes: true });
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const subdirs: string[] = [];
      for (const entry of entries) {
        if (files >= MAX_FILES) break;
        const relativePath = join(relativeDir, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && entry.name !== 'node_modules') subdirs.push(relativePath);
        } else if (entry.isFile()) {
          files++;
          const file = await open(join(workingDir, relativePath), constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
            const content = Buffer.alloc(MAX_FILE_BYTES + 1);
            const { bytesRead } = await file.read(content, 0, content.length, 0);
            if (bytesRead > MAX_FILE_BYTES) continue;
            hash
              .update(relativePath)
              .update('\0')
              .update(createHash('sha256').update(content.subarray(0, bytesRead)).digest());
          } finally {
            await file.close();
          }
        }
      }
      pending.push(...subdirs.reverse());
    }
    return hash.digest('hex');
  } catch {
    // A partial or unreadable scan is not evidence that the workspace is idle.
    return null;
  }
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    // Same hardening as the git status indicator: no optional locks, no fsmonitor, no external diff.
    execFile(
      'git',
      ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8' },
      (err, stdout) => resolve(err ? null : stdout)
    );
  });
}

/**
 * Fingerprint git state, falling back to bounded workspace content outside git.
 * @returns null when the workspace could not be read
 */
export async function computeWorkspaceFingerprint(workingDir: string): Promise<string | null> {
  if (!workingDir) return null;
  if ((await probePathKind(workingDir)) !== 'directory') return null;
  const inside = await git(workingDir, ['rev-parse', '--is-inside-work-tree']);
  if (inside?.trim() !== 'true') return contentFingerprint(workingDir);

  const head = (await git(workingDir, ['rev-parse', '--verify', '-q', 'HEAD']))?.trim() ?? 'no-head';
  const status = await git(workingDir, ['status', '--porcelain']);
  const diff = await git(workingDir, ['diff', '--no-ext-diff', '--no-textconv', 'HEAD']);
  if (status === null) return null;

  const hash = createHash('sha256');
  hash
    .update(head)
    .update('\0')
    .update(status)
    .update('\0')
    .update(diff ?? '');
  return hash.digest('hex');
}

export type BudgetExhaustion = { reason: 'unchanged_workspace' | 'max_cycles'; details: string };

/** Tracks consecutive unchanged cycles. */
export class CycleBudget {
  private lastFingerprint: string | null = null;
  private unchanged = 0;

  reset(): void {
    this.lastFingerprint = null;
    this.unchanged = 0;
  }

  /** Set the fingerprint cycles are compared against (the state when the loop started). */
  seed(fingerprint: string | null): void {
    this.lastFingerprint = fingerprint;
    this.unchanged = 0;
  }

  /** Record the fingerprint taken after a cycle; a null fingerprint breaks the run. */
  record(fingerprint: string | null): number {
    if (fingerprint !== null && fingerprint === this.lastFingerprint) {
      this.unchanged++;
    } else {
      this.unchanged = 0;
    }
    this.lastFingerprint = fingerprint;
    return this.unchanged;
  }
}
