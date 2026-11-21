/**
 * @fileoverview Starts, health-checks and stops Chat Graph's Go sidecar (`chat-graph --dir <dir>`).
 *
 * One SQLite store must have one writer, so only a colour whose deploy role allows `persist`
 * starts the sidecar or sweeps orphans (invariant I6 in intent/2026-11-18-chat-graph.md).
 * Stopping is allowed in any role, because a retired colour must still stop its own child.
 *
 * A pid alone is reused by the kernel, so every signal is sent only while `/proc/<pid>/stat`
 * still shows the start time recorded for it. The child is marked with
 * `CODEMAN_CHAT_GRAPH_OWNER=<data dir>`, which is how a later sweep finds an orphan left by a
 * crashed Codeman. The child gets a minimal environment, so Codeman's password never reaches it.
 *
 * The lifecycle copies `src/deepseek-web-server.ts`: one instance, killed on shutdown, failures
 * reported with the child's captured output. `sweep`, `start` and `stop` run one at a time, in the
 * order they were called: a `stop` that ran beside a pending `start` could find nothing running and
 * then watch the start spawn, and a `start` queued after a `sweep` must wait for the orphans to die.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { constants, readFileSync } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getErrorMessage } from '../types.js';
import { ownPids, readEnvVar, readProcStat, type ProcStat } from '../preview-proc.js';

export const CHAT_GRAPH_OWNER_ENV = 'CODEMAN_CHAT_GRAPH_OWNER';

const READY_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 100;
const HEALTH_TIMEOUT_MS = 1_000;
const KILL_GRACE_MS = 3_000;
const OUTPUT_CAP = 16_384;

export interface ProcIdentity {
  pid: number;
  /** Field 22 of `/proc/<pid>/stat`. */
  startTicks: number;
}

type SidecarState = { kind: 'stopped' } | { kind: 'running'; child: ChildProcess; identity: ProcIdentity };

export type ChatGraphStartResult =
  | { ok: true; reused: boolean }
  | { ok: false; reason: 'role' | 'missing-binary' | 'failed'; error: string };

export interface ChatGraphSupervisorOptions {
  /** Defaults to the `chat-graph` binary the build places next to this module. */
  binary?: string;
  /** The sidecar's directory, `dataPath('chat-graph')`. */
  dir: string;
  /** Codeman's data dir: the owner marker a sweep matches. */
  owner: string;
  mayPersist: () => boolean;
  readyTimeoutMs?: number;
  /** Reads `/proc/<pid>/stat`. Replaced only by tests that need a recycled pid. */
  readStat?: (pid: number) => ProcStat | null;
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export class ChatGraphSupervisor {
  private state: SidecarState = { kind: 'stopped' };
  private queue: Promise<unknown> = Promise.resolve();
  private output = '';
  private readonly binary: string;
  private readonly readStat: (pid: number) => ProcStat | null;

  constructor(private readonly options: ChatGraphSupervisorOptions) {
    this.binary = options.binary ?? join(dirname(fileURLToPath(import.meta.url)), 'chat-graph');
    this.readStat = options.readStat ?? readProcStat;
  }

  private get socketPath(): string {
    return join(this.options.dir, 'sock');
  }

  /** Whether `pid` is still the process that was recorded, and not a recycled pid. */
  private isSame(identity: ProcIdentity): boolean {
    const stat = this.readStat(identity.pid);
    return stat !== null && !stat.zombie && stat.startTicks === identity.startTicks;
  }

  private signalIfSame(identity: ProcIdentity, signal: NodeJS.Signals): boolean {
    if (!this.isSame(identity)) return false;
    try {
      process.kill(identity.pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  health(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = request({ socketPath: this.socketPath, path: '/health', timeout: HEALTH_TIMEOUT_MS }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(false));
      req.end();
    });
  }

  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.catch(() => undefined);
    return run;
  }

  start(): Promise<ChatGraphStartResult> {
    return this.serialize(() => this.startLocked());
  }

  private async startLocked(): Promise<ChatGraphStartResult> {
    const refused = (): ChatGraphStartResult => ({
      ok: false,
      reason: 'role',
      error: 'this deploy role may not run the Chat Graph sidecar',
    });
    if (!this.options.mayPersist()) return refused();

    if (this.state.kind === 'running') {
      if (await this.health()) return { ok: true, reused: true };
      if (!(await this.stopLocked())) {
        return { ok: false, reason: 'failed', error: 'the previous Chat Graph sidecar did not exit' };
      }
    }

    try {
      await access(this.binary, constants.X_OK);
    } catch {
      return { ok: false, reason: 'missing-binary', error: `Chat Graph sidecar not found at ${this.binary}` };
    }
    try {
      await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      return { ok: false, reason: 'failed', error: `Cannot create ${this.options.dir}: ${getErrorMessage(err)}` };
    }
    if (!this.options.mayPersist()) return refused();

    let child: ChildProcess;
    try {
      child = spawn(this.binary, ['--dir', this.options.dir], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH ?? '', [CHAT_GRAPH_OWNER_ENV]: this.options.owner },
      });
    } catch (err) {
      return { ok: false, reason: 'failed', error: `Failed to start the Chat Graph sidecar: ${getErrorMessage(err)}` };
    }
    const stat = child.pid === undefined ? null : this.readStat(child.pid);

    this.output = '';
    const capture = (chunk: Buffer) => {
      if (this.output.length < OUTPUT_CAP) this.output += chunk.toString('utf-8');
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    const forget = () => {
      if (this.state.kind === 'running' && this.state.child === child) this.state = { kind: 'stopped' };
    };
    child.once('exit', forget);
    child.once('error', forget);

    if (!stat) {
      child.kill('SIGKILL');
      return { ok: false, reason: 'failed', error: `Chat Graph sidecar exited at once: ${this.output.trim()}` };
    }
    this.state = { kind: 'running', child, identity: { pid: stat.pid, startTicks: stat.startTicks } };

    const deadline = Date.now() + (this.options.readyTimeoutMs ?? READY_TIMEOUT_MS);
    while (Date.now() < deadline) {
      if (hasExited(child)) {
        return { ok: false, reason: 'failed', error: `Chat Graph sidecar exited: ${this.output.trim()}` };
      }
      if (await this.health()) return { ok: true, reused: false };
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
    await this.stopLocked();
    return { ok: false, reason: 'failed', error: `Chat Graph sidecar did not answer in time: ${this.output.trim()}` };
  }

  /**
   * Stop this supervisor's own child, whatever the deploy role, after any start already called.
   * Safe when nothing runs. False only when the child outlived SIGKILL's grace.
   */
  stop(): Promise<boolean> {
    return this.serialize(() => this.stopLocked());
  }

  /**
   * A recycled pid counts as gone: it is not ours. A child that outlives SIGKILL stays recorded as
   * running, so the next `stop()` (a retried retire) tries again rather than report it gone.
   */
  private async stopLocked(): Promise<boolean> {
    const running = this.state;
    this.state = { kind: 'stopped' };
    if (running.kind === 'stopped' || hasExited(running.child)) return true;
    if (!this.signalIfSame(running.identity, 'SIGTERM')) return true;
    if (await waitForExit(running.child, KILL_GRACE_MS)) return true;
    this.signalIfSame(running.identity, 'SIGKILL');
    if (await waitForExit(running.child, KILL_GRACE_MS)) return true;
    if (this.state.kind === 'stopped' && !hasExited(running.child)) this.state = running;
    return false;
  }

  /**
   * Kill sidecars a previous Codeman on this data dir left behind, and wait until they are gone,
   * so a `start()` after it never finds one still answering on the socket. Returns how many were
   * signalled.
   *
   * SIGKILL, not SIGTERM: an orphan shutting down cleanly removes `<dir>/sock` on its way out,
   * which can delete the socket of the sidecar `start()` spawns right after.
   */
  sweep(): Promise<number> {
    return this.serialize(() => this.sweepLocked());
  }

  private async sweepLocked(): Promise<number> {
    if (!this.options.mayPersist()) return 0;
    const own = this.state.kind === 'running' ? this.state.identity.pid : null;
    const orphans: ProcIdentity[] = [];
    for (const pid of ownPids(process.getuid?.() ?? 0)) {
      if (pid === own) continue;
      let environ: string;
      try {
        environ = readFileSync(`/proc/${pid}/environ`, 'latin1');
      } catch {
        continue;
      }
      if (readEnvVar(environ, CHAT_GRAPH_OWNER_ENV) !== this.options.owner) continue;
      const stat = this.readStat(pid);
      if (stat && !stat.zombie) orphans.push({ pid, startTicks: stat.startTicks });
    }
    const killed = orphans.filter((identity) => this.signalIfSame(identity, 'SIGKILL'));
    const deadline = Date.now() + KILL_GRACE_MS;
    while (killed.some((identity) => this.isSame(identity)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
    return killed.length;
  }
}
