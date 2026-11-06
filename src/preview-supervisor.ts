/**
 * @fileoverview Starts, stops and reconciles the preview servers Codeman runs for sessions.
 *
 * Processes are matched by environment marker and port listener as well as by
 * process group, because the 2026-11-05 experiment measured that the process
 * group alone misses a server that ran `setsid`.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  truncateSync,
} from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import {
  PREVIEW_LOG_MAX_BYTES,
  PREVIEW_READY_TIMEOUT_MS,
  PREVIEW_STOP_GRACE_MS,
  previewIdleStopMs,
} from './config/preview-limits.js';
import {
  PREVIEW_ID_ENV,
  PREVIEW_OWNER_ENV,
  findListenerPids,
  isPortListening,
  parsePreviewMarker,
  readProcSnapshot,
  readProcStat,
  type ProcEntry,
  type ProcSnapshot,
} from './preview-proc.js';
import type { PreviewLeftRunning, PreviewLeftRunningRecord, PreviewProcess, PreviewState } from './types/preview.js';

const PREVIEWS_FILE = 'previews.json';
const LEFT_RUNNING_FILE = 'previews-left-running.json';
const LEFT_RUNNING_SETTLE_MS = 1000;

export type PreviewEvent = 'started' | 'idle' | 'gone';

const TRANSITIONS: Record<PreviewState, Record<PreviewEvent, PreviewState>> = {
  running: { started: 'running', idle: 'stopped', gone: 'exited' },
  stopped: { started: 'running', idle: 'stopped', gone: 'stopped' },
  exited: { started: 'running', idle: 'exited', gone: 'exited' },
};

export function nextPreviewState(state: PreviewState, event: PreviewEvent): PreviewState {
  return TRANSITIONS[state][event];
}

export function substitutePort(cmd: string, port: number): string {
  return cmd.replaceAll('{port}', String(port));
}

export interface PreviewLiveness {
  leaderAlive: boolean;
  markerPids: number[];
}

export function previewLiveness(
  record: Pick<PreviewProcess, 'webviewId' | 'pid' | 'startTicks'>,
  snapshot: ProcSnapshot,
  owner: string
): PreviewLiveness {
  const leaderEntry = snapshot.get(record.pid);
  const leaderAlive = !!leaderEntry && !leaderEntry.zombie && leaderEntry.startTicks === record.startTicks;
  const markerPids: number[] = [];
  for (const entry of snapshot.values()) {
    if (!entry.zombie && entry.previewId === record.webviewId && entry.previewOwner === owner) {
      markerPids.push(entry.pid);
    }
  }
  return { leaderAlive, markerPids };
}

export interface ReconcileDecision {
  webviewId: string;
  kill: boolean;
  next: PreviewState | 'removed';
}

export interface ReconcilePlan {
  decisions: ReconcileDecision[];
  orphanPids: number[];
}

export function planReconcile(input: {
  records: readonly PreviewProcess[];
  webviewIds: ReadonlySet<string>;
  snapshot: ProcSnapshot;
  owner: string;
  now: number;
  idleStopMs: number;
}): ReconcilePlan {
  const decisions: ReconcileDecision[] = [];
  const known = new Set<string>();
  for (const record of input.records) {
    known.add(record.webviewId);
    const { leaderAlive, markerPids } = previewLiveness(record, input.snapshot, input.owner);
    const alive = leaderAlive || markerPids.length > 0;
    if (!input.webviewIds.has(record.webviewId)) {
      decisions.push({ webviewId: record.webviewId, kill: alive, next: 'removed' });
    } else if (record.state !== 'running') {
      decisions.push({ webviewId: record.webviewId, kill: alive, next: record.state });
    } else if (!alive) {
      decisions.push({ webviewId: record.webviewId, kill: false, next: nextPreviewState(record.state, 'gone') });
    } else if (input.now - record.lastViewedAt > input.idleStopMs) {
      decisions.push({ webviewId: record.webviewId, kill: true, next: nextPreviewState(record.state, 'idle') });
    } else {
      decisions.push({ webviewId: record.webviewId, kill: false, next: record.state });
    }
  }
  const orphanPids: number[] = [];
  for (const entry of input.snapshot.values()) {
    if (entry.zombie || entry.previewOwner !== input.owner || entry.previewId === undefined) continue;
    if (!known.has(entry.previewId)) orphanPids.push(entry.pid);
  }
  return { decisions, orphanPids };
}

export function parsePreviewRecords(raw: string): PreviewProcess[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((row): row is PreviewProcess => {
    if (!row || typeof row !== 'object') return false;
    const r = row as Record<string, unknown>;
    return (
      ['webviewId', 'sessionId', 'name', 'cmd', 'cwd', 'logPath'].every((k) => typeof r[k] === 'string') &&
      ['port', 'pid', 'pgid', 'startTicks', 'lastViewedAt'].every((k) => Number.isFinite(r[k])) &&
      (r.state === 'running' || r.state === 'stopped' || r.state === 'exited')
    );
  });
}

export function parseLeftRunningRecords(raw: string): PreviewLeftRunningRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((row): row is PreviewLeftRunningRecord => {
    if (!row || typeof row !== 'object') return false;
    const r = row as Record<string, unknown>;
    return (
      ['webviewId', 'sessionId', 'name', 'logPath'].every((k) => typeof r[k] === 'string') &&
      ['port', 'since'].every((k) => Number.isFinite(r[k])) &&
      Array.isArray(r.pids) &&
      (r.owner === undefined || typeof r.owner === 'string')
    );
  });
}

export class PreviewLimitError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // Already gone.
  }
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function bindablePort(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(null));
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const bound = address && typeof address === 'object' ? address.port : null;
      server.close(() => resolve(bound));
    });
  });
}

export interface PreviewSupervisorOptions {
  dataDir: string;
  owner?: string;
  now?: () => number;
  idleStopMs?: () => number;
  stopGraceMs?: number;
  readyTimeoutMs?: number;
  canPersist?: () => boolean;
}

export interface PreviewStartInput {
  sessionId: string;
  name: string;
  cmd: string;
  cwd: string;
}

/** Runs inside the supervisor's queue, so a reconcile never sees the record without its tab. */
export type PreviewWebviewBinder = (port: number, existingId: string | undefined) => Promise<string>;

export interface PreviewStartResult {
  record: PreviewProcess;
  ready: boolean;
  host: '127.0.0.1' | '::1';
  /** The replaced server, when it was still listening after the stop. */
  leftRunning?: PreviewLeftRunning;
}

export interface PreviewRemoval {
  record: PreviewProcess;
  leftRunning?: PreviewLeftRunning;
}

export class PreviewSupervisor {
  private readonly records = new Map<string, PreviewProcess>();
  private readonly leftRunning = new Map<number, PreviewLeftRunningRecord>();
  private readonly sessionLocks = new Map<string, Promise<unknown>>();
  private readonly owner: string;
  private readonly now: () => number;
  private readonly idleStopMs: () => number;
  private readonly stopGraceMs: number;
  private readonly readyTimeoutMs: number;
  private readonly canPersist: () => boolean;
  private queue: Promise<unknown> = Promise.resolve();
  private dirty = false;

  constructor(private readonly opts: PreviewSupervisorOptions) {
    this.owner = opts.owner ?? opts.dataDir;
    this.now = opts.now ?? Date.now;
    this.idleStopMs = opts.idleStopMs ?? previewIdleStopMs;
    this.stopGraceMs = opts.stopGraceMs ?? PREVIEW_STOP_GRACE_MS;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? PREVIEW_READY_TIMEOUT_MS;
    this.canPersist = opts.canPersist ?? (() => true);
    this.load();
  }

  get filePath(): string {
    return join(this.opts.dataDir, PREVIEWS_FILE);
  }

  private get leftRunningPath(): string {
    return join(this.opts.dataDir, LEFT_RUNNING_FILE);
  }

  load(): void {
    this.records.clear();
    this.leftRunning.clear();
    const read = (file: string) => {
      try {
        return readFileSync(file, 'utf-8');
      } catch {
        return '[]';
      }
    };
    for (const record of parsePreviewRecords(read(this.filePath))) this.records.set(record.webviewId, record);
    for (const left of parseLeftRunningRecords(read(this.leftRunningPath))) this.leftRunning.set(left.port, left);
  }

  list(): PreviewProcess[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  listLeftRunning(): PreviewLeftRunningRecord[] {
    return [...this.leftRunning.values()].map((r) => ({ ...r, pids: [...r.pids] }));
  }

  get(sessionId: string, name: string): PreviewProcess | undefined {
    const record = this.find(sessionId, name);
    return record && { ...record };
  }

  forWebview(webviewId: string): PreviewProcess | undefined {
    const record = this.records.get(webviewId);
    return record && { ...record };
  }

  markViewed(webviewId: string): void {
    const record = this.records.get(webviewId);
    if (!record) return;
    const now = this.now();
    if (now - record.lastViewedAt < 1000) return;
    record.lastViewedAt = now;
    this.dirty = true;
  }

  /**
   * Starts of one session run one at a time, readiness wait included, so the
   * per-session limit is checked against what earlier starts really created and an
   * earlier caller is not handed `ready: false` for a server a later start replaced.
   */
  start(
    input: PreviewStartInput,
    bindWebview: PreviewWebviewBinder,
    { maxPerSession = Infinity }: { maxPerSession?: number } = {}
  ): Promise<PreviewStartResult> {
    const previous = this.sessionLocks.get(input.sessionId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.startNow(input, bindWebview, maxPerSession));
    const tail = run.catch(() => undefined);
    this.sessionLocks.set(input.sessionId, tail);
    void tail.then(() => {
      if (this.sessionLocks.get(input.sessionId) === tail) this.sessionLocks.delete(input.sessionId);
    });
    return run;
  }

  private async startNow(
    input: PreviewStartInput,
    bindWebview: PreviewWebviewBinder,
    maxPerSession: number
  ): Promise<PreviewStartResult> {
    let leftRunning: PreviewLeftRunning | undefined;
    const record = await this.serialize(async () => {
      const existing = this.find(input.sessionId, input.name);
      if (!existing) {
        const count = [...this.records.values()].filter((r) => r.sessionId === input.sessionId).length;
        if (count >= maxPerSession) throw new PreviewLimitError(`A session can run at most ${maxPerSession} previews`);
      }
      if (existing) {
        await this.terminate(existing);
        leftRunning = await this.stillListening(existing.port);
      }
      const port = (existing && !leftRunning && (await bindablePort(existing.port))) || (await bindablePort(0));
      if (!port) throw new Error('No free port for the preview');
      this.leftRunning.delete(port);
      const webviewId = await bindWebview(port, existing?.webviewId);
      if (existing && existing.webviewId !== webviewId) this.records.delete(existing.webviewId);
      const next = this.spawnServer(input, webviewId, port, existing?.state);
      this.records.set(webviewId, next);
      if (existing && leftRunning) this.keepLeftRunning(existing, leftRunning, next.logPath);
      await this.persist();
      return next;
    });
    const { ready, host } = await this.waitReady(record);
    return { record: { ...record }, ready, host, ...(leftRunning ? { leftRunning } : {}) };
  }

  remove(webviewId: string, owner?: string): Promise<PreviewRemoval | null> {
    return this.serialize(async () => {
      const record = this.records.get(webviewId);
      if (!record) return null;
      const leftRunning = await this.drop(record, owner);
      await this.persist();
      return { record, ...(leftRunning ? { leftRunning } : {}) };
    });
  }

  removeSession(sessionId: string, owner?: string): Promise<PreviewRemoval[]> {
    return this.serialize(async () => {
      const removed: PreviewRemoval[] = [];
      for (const record of [...this.records.values()].filter((r) => r.sessionId === sessionId)) {
        const leftRunning = await this.drop(record, owner);
        removed.push({ record, ...(leftRunning ? { leftRunning } : {}) });
      }
      if (removed.length > 0) await this.persist();
      return removed;
    });
  }

  /**
   * One reconcile pass. `webviewIds` is read inside the queue, so a preview being
   * created cannot be judged against a web tab list from before its tab existed.
   */
  reconcile(
    webviewIds: () => Promise<ReadonlySet<string>>,
    { sweepOrphans = true }: { sweepOrphans?: boolean } = {}
  ): Promise<ReconcilePlan> {
    return this.serialize(async () => {
      const ids = await webviewIds();
      const snapshot = this.reconcileSnapshot(ids, sweepOrphans);
      const plan = planReconcile({
        records: [...this.records.values()],
        webviewIds: ids,
        snapshot,
        owner: this.owner,
        now: this.now(),
        idleStopMs: this.idleStopMs(),
      });
      let changed = this.dirty;
      for (const decision of plan.decisions) {
        const record = this.records.get(decision.webviewId);
        if (!record) continue;
        if (decision.kill) await this.terminate(record);
        if (decision.next === 'removed') {
          await this.drop(record);
          changed = true;
        } else if (decision.next !== record.state) {
          record.state = decision.next;
          changed = true;
        }
        if (record.state === 'running') this.capLog(record.logPath);
      }
      if (plan.orphanPids.length > 0) {
        await this.terminatePids(new Map(plan.orphanPids.map((pid) => [pid, snapshot.get(pid)!.startTicks])));
      }
      for (const left of [...this.leftRunning.values()]) {
        if (isPortListening(left.port)) continue;
        this.leftRunning.delete(left.port);
        if (!this.records.has(left.webviewId)) await fs.rm(left.logPath, { force: true }).catch(() => undefined);
        changed = true;
      }
      if (changed) await this.persist();
      return plan;
    });
  }

  /**
   * A full `/proc` sweep costs a read of every process's environment, so a pass
   * where every running leader is alive and every record keeps its web tab reads
   * only the recorded leaders.
   */
  private reconcileSnapshot(webviewIds: ReadonlySet<string>, sweepOrphans: boolean): ProcSnapshot {
    if (sweepOrphans) return readProcSnapshot();
    const leaders = new Map<number, ProcEntry>();
    for (const record of this.records.values()) {
      const stat = readProcStat(record.pid);
      const alive = !!stat && !stat.zombie && stat.startTicks === record.startTicks;
      if (alive) leaders.set(stat.pid, stat);
      else if (record.state === 'running' || !webviewIds.has(record.webviewId)) return readProcSnapshot();
    }
    return leaders;
  }

  async readLog(webviewId: string, tailBytes: number): Promise<{ text: string; size: number } | null> {
    const record = this.records.get(webviewId);
    if (!record) return null;
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(record.logPath, 'r');
    } catch {
      return { text: '', size: 0 };
    }
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, tailBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return { text: buffer.toString('utf-8'), size };
    } finally {
      await handle.close();
    }
  }

  private find(sessionId: string, name: string): PreviewProcess | undefined {
    for (const record of this.records.values()) {
      if (record.sessionId === sessionId && record.name === name) return record;
    }
    return undefined;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private spawnServer(
    input: PreviewStartInput,
    webviewId: string,
    port: number,
    previous: PreviewState | undefined
  ): PreviewProcess {
    const logDir = join(this.opts.dataDir, 'previews');
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const logPath = join(logDir, `${webviewId}.log`);
    closeSync(openSync(logPath, 'w', 0o600));
    // O_APPEND, so the reconcile's truncation moves the server's next write back to offset 0.
    const logFd = openSync(logPath, 'a');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(port),
      [PREVIEW_ID_ENV]: webviewId,
      [PREVIEW_OWNER_ENV]: this.owner,
    };
    delete env.CODEMAN_PASSWORD;
    delete env.CODEMAN_USERNAME;
    let pid: number | undefined;
    try {
      const child = spawn('/bin/sh', ['-c', substitutePort(input.cmd, port)], {
        cwd: input.cwd,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env,
      });
      child.on('error', (err) => console.warn(`[Previews] ${input.name}: ${err.message}`));
      child.unref();
      pid = child.pid;
    } finally {
      closeSync(logFd);
    }
    if (pid === undefined) throw new Error(`Could not start the preview command in ${input.cwd}`);
    const stat = readProcStat(pid);
    return {
      webviewId,
      sessionId: input.sessionId,
      name: input.name,
      cmd: input.cmd,
      cwd: input.cwd,
      port,
      pid,
      pgid: stat?.pgid ?? pid,
      startTicks: stat?.startTicks ?? 0,
      logPath,
      state: nextPreviewState(previous ?? 'running', 'started'),
      lastViewedAt: this.now(),
    };
  }

  private async waitReady(record: PreviewProcess): Promise<{ ready: boolean; host: '127.0.0.1' | '::1' }> {
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (await canConnect('127.0.0.1', record.port)) return { ready: true, host: '127.0.0.1' };
      if (await canConnect('::1', record.port)) return { ready: true, host: '::1' };
      if (!this.isAlive(record)) {
        await this.serialize(async () => {
          const current = this.records.get(record.webviewId);
          if (current === record && current.state === 'running' && !this.isAlive(current)) {
            current.state = nextPreviewState(current.state, 'gone');
            await this.persist();
          }
        });
        return { ready: false, host: '127.0.0.1' };
      }
      await sleep(100);
    }
    return { ready: false, host: '127.0.0.1' };
  }

  private isAlive(record: PreviewProcess): boolean {
    const leader = readProcStat(record.pid);
    if (leader && !leader.zombie && leader.startTicks === record.startTicks) return true;
    return previewLiveness(record, readProcSnapshot(), this.owner).markerPids.length > 0;
  }

  private async drop(record: PreviewProcess, owner?: string): Promise<PreviewLeftRunning | undefined> {
    await this.terminate(record);
    this.records.delete(record.webviewId);
    const leftRunning = await this.stillListening(record.port);
    if (leftRunning) this.keepLeftRunning(record, leftRunning, record.logPath, owner);
    else await fs.rm(record.logPath, { force: true }).catch(() => undefined);
    return leftRunning;
  }

  /**
   * A stopped server's socket closes as it exits, so the port gets a moment to free
   * before a listener on it counts as a server Codeman could not stop.
   */
  private async stillListening(port: number): Promise<PreviewLeftRunning | undefined> {
    const deadline = Date.now() + LEFT_RUNNING_SETTLE_MS;
    while (isPortListening(port)) {
      if (Date.now() >= deadline) return { port, pids: findListenerPids(port) };
      await sleep(100);
    }
    return undefined;
  }

  private keepLeftRunning(record: PreviewProcess, left: PreviewLeftRunning, logPath: string, owner?: string): void {
    const pids = left.pids.length > 0 ? `pids ${left.pids.join(', ')}` : 'a process of another user';
    const line = `[codeman] Port ${left.port} is still listening (${pids}) after "${record.name}" was stopped. The server left the preview's process group and environment, so Codeman cannot stop it; stop it where it was handed off.\n`;
    try {
      appendFileSync(logPath, line);
    } catch {
      // The log directory is gone; the record below still reports it.
    }
    console.warn(`[Previews] ${line.slice('[codeman] '.length).trim()}`);
    this.leftRunning.set(left.port, {
      webviewId: record.webviewId,
      sessionId: record.sessionId,
      name: record.name,
      ...(owner !== undefined ? { owner } : {}),
      logPath,
      since: this.now(),
      ...left,
    });
  }

  private async terminate(record: PreviewProcess): Promise<void> {
    if (!this.signalPreviewIfAlive(record, 'SIGTERM')) return;
    const deadline = Date.now() + this.stopGraceMs;
    while (Date.now() < deadline) {
      await sleep(100);
      if (!this.isAlive(record)) return;
    }
    this.signalPreviewIfAlive(record, 'SIGKILL');
    for (let i = 0; i < 20 && this.isAlive(record); i++) await sleep(100);
  }

  private signalPreviewIfAlive(record: PreviewProcess, sig: NodeJS.Signals): boolean {
    const snapshot = readProcSnapshot();
    const { leaderAlive, markerPids } = previewLiveness(record, snapshot, this.owner);
    if (leaderAlive) signal(-record.pgid, sig);
    for (const pid of markerPids) this.signalIfSame(pid, snapshot.get(pid)!.startTicks, sig);
    let listener = false;
    for (const pid of findListenerPids(record.port)) {
      if (markerPids.includes(pid) || !this.carriesMarker(pid, record.webviewId)) continue;
      const stat = readProcStat(pid);
      if (stat) this.signalIfSame(pid, stat.startTicks, sig);
      listener = true;
    }
    return leaderAlive || markerPids.length > 0 || listener;
  }

  private async terminatePids(pids: ReadonlyMap<number, number>): Promise<void> {
    for (const [pid, ticks] of pids) this.signalIfSame(pid, ticks, 'SIGTERM');
    const alive = () => [...pids].filter(([pid, ticks]) => readProcStat(pid)?.startTicks === ticks);
    const deadline = Date.now() + this.stopGraceMs;
    while (alive().length > 0 && Date.now() < deadline) await sleep(100);
    for (const [pid, ticks] of alive()) this.signalIfSame(pid, ticks, 'SIGKILL');
  }

  private signalIfSame(pid: number, startTicks: number, sig: NodeJS.Signals): void {
    const stat = readProcStat(pid);
    if (stat && !stat.zombie && stat.startTicks === startTicks) signal(pid, sig);
  }

  private carriesMarker(pid: number, webviewId: string): boolean {
    try {
      const marker = parsePreviewMarker(readFileSync(`/proc/${pid}/environ`, 'latin1'));
      return marker.previewId === webviewId && marker.previewOwner === this.owner;
    } catch {
      return false;
    }
  }

  private capLog(logPath: string): void {
    try {
      if (statSync(logPath).size > PREVIEW_LOG_MAX_BYTES) truncateSync(logPath, 0);
    } catch {
      // No log yet.
    }
  }

  private async persist(): Promise<void> {
    this.dirty = false;
    if (!this.canPersist()) return;
    if (!existsSync(this.opts.dataDir)) mkdirSync(this.opts.dataDir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify([...this.records.values()], null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.filePath);
    const leftTmp = `${this.leftRunningPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(leftTmp, JSON.stringify([...this.leftRunning.values()], null, 2), { mode: 0o600 });
    await fs.rename(leftTmp, this.leftRunningPath);
  }
}
