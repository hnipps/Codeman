/**
 * @fileoverview Cycle budget for the respawn loop: stops a loop that has nothing to do.
 *
 * After each cycle the controller fingerprints the session's working directory
 * (git HEAD + hashes of `git status --porcelain` and `git diff`). A run of
 * consecutive identical fingerprints means the cycles are producing nothing.
 * A directory that is not a git repository has no fingerprint, so only
 * `maxCycles` can end its loop.
 *
 * @module respawn-cycle-budget
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

/** Consecutive unchanged cycles after which the loop stops. 0 disables the check. */
export const DEFAULT_MAX_UNCHANGED_CYCLES = 3;

const GIT_TIMEOUT_MS = 10000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

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
 * Cheap fingerprint of a working directory's git state.
 * @returns null when the directory is not a git work tree or git failed
 */
export async function computeWorkspaceFingerprint(workingDir: string): Promise<string | null> {
  if (!workingDir) return null;
  const inside = await git(workingDir, ['rev-parse', '--is-inside-work-tree']);
  if (inside?.trim() !== 'true') return null;

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
