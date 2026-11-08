/**
 * @fileoverview The live lease: exactly one Codeman process per data dir may be the live colour.
 *
 * {@link ./deploy-role.ts} says only the live colour automates, but a process started with no
 * `CODEMAN_DEPLOY_ROLE` is live by default, so a second hand-started build on the same data dir and
 * tmux socket became a second writer typing into the same panes. Being live therefore means holding
 * a lease file (`deploy-lease.json` in the data dir) naming this process by pid and start time.
 *
 * - A server starting live acquires it at boot and refuses to start when a live Codeman holds it.
 * - A candidate holds nothing. Promote and reinstate acquire; retire and stop release.
 * - A lease whose holder is dead, was recycled to another program, or is a different process
 *   under the same pid (start time differs) is stale and is taken over.
 *
 * The tmux socket is recorded for the message only: the lease is per data dir, and the socket is
 * derived from the same `CODEMAN_INSTANCE` that derives the data dir.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dataPath, resolveTmuxSocketName } from './config/instance.js';
import { EXEC_TIMEOUT_MS } from './config/exec-timeout.js';
import { isProcessAlive, looksLikeCodemanWeb, readProcessCommand } from './daemon-control.js';

export interface LeaseHolder {
  pid: number;
  startedAt: string;
  tmuxSocket: string;
  command: string;
}

export interface ProcessProbe {
  alive(pid: number): boolean;
  command(pid: number): string | null;
  startedAt(pid: number): string | null;
}

export type LeaseResult = { kind: 'acquired' } | { kind: 'held'; holder: LeaseHolder };

export interface LeaseOptions {
  pid?: number;
  probe?: ProcessProbe;
}

export function leasePath(): string {
  return dataPath('deploy-lease.json');
}

/** Start time as `ps` prints it, which with the pid identifies one process for as long as it lives. */
export function readProcessStart(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

const REAL_PROBE: ProcessProbe = {
  alive: isProcessAlive,
  command: readProcessCommand,
  startedAt: readProcessStart,
};

function readLease(): LeaseHolder | null {
  try {
    const raw = JSON.parse(readFileSync(leasePath(), 'utf-8')) as Partial<LeaseHolder>;
    if (!Number.isInteger(raw.pid) || typeof raw.startedAt !== 'string') return null;
    return {
      pid: raw.pid as number,
      startedAt: raw.startedAt,
      tmuxSocket: typeof raw.tmuxSocket === 'string' ? raw.tmuxSocket : '',
      command: typeof raw.command === 'string' ? raw.command : '',
    };
  } catch {
    return null;
  }
}

/** Is the process the lease names still that process, and still a Codeman? */
function holderIsLive(holder: LeaseHolder, probe: ProcessProbe): boolean {
  if (!probe.alive(holder.pid)) return false;
  const command = probe.command(holder.pid);
  // `ps` can fail where procps is missing; "cannot tell" counts as live, never as a free lease.
  if (command !== null && !looksLikeCodemanWeb(command)) return false;
  const started = probe.startedAt(holder.pid);
  return started === null || started === holder.startedAt;
}

/** Take the lease for this process unless a live Codeman holds it. Holding it already is acquiring it. */
export function acquireLiveLease(options: LeaseOptions = {}): LeaseResult {
  const pid = options.pid ?? process.pid;
  const probe = options.probe ?? REAL_PROBE;
  const existing = readLease();
  if (existing && existing.pid !== pid && holderIsLive(existing, probe)) return { kind: 'held', holder: existing };
  const mine: LeaseHolder = {
    pid,
    startedAt: probe.startedAt(pid) ?? '',
    tmuxSocket: resolveTmuxSocketName(),
    command: probe.command(pid) ?? process.argv.join(' '),
  };
  const tmp = `${leasePath()}.${pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(mine), { mode: 0o600 });
  renameSync(tmp, leasePath());
  return { kind: 'acquired' };
}

/** Give the lease up, but only when this process is the one it names. */
export function releaseLiveLease(options: { pid?: number } = {}): void {
  const pid = options.pid ?? process.pid;
  if (readLease()?.pid !== pid) return;
  try {
    unlinkSync(leasePath());
  } catch {
    /* already gone */
  }
}

export class LiveLeaseRefusal extends Error {
  constructor(readonly holder: LeaseHolder) {
    super(
      `Another Codeman (pid ${holder.pid}${holder.tmuxSocket ? `, tmux socket "${holder.tmuxSocket}"` : ''}) is already the live ` +
        `server on this data dir (${leasePath()}); two live servers would type into the same panes. ` +
        'Start this one with its own CODEMAN_INSTANCE (e.g. CODEMAN_INSTANCE=dev) so it gets its own data dir and tmux socket, ' +
        'or stop the other one first.'
    );
    this.name = 'LiveLeaseRefusal';
  }
}

/** Acquire or throw {@link LiveLeaseRefusal}. */
export function requireLiveLease(options: LeaseOptions = {}): void {
  const result = acquireLiveLease(options);
  if (result.kind === 'held') throw new LiveLeaseRefusal(result.holder);
}
