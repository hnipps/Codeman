/**
 * @fileoverview What the preview supervisor reads from `/proc`.
 *
 * Reads are synchronous because `/proc` answers from memory and one pass must be
 * one consistent view.
 *
 * A preview server is recognised by its environment, never by its ancestry. The
 * 2026-11-05 experiment (docs/agent-previews-plan.md, Appendix A) measured that a
 * server started with `setsid` leaves both the process group and the descendant
 * tree, while the environment it inherited still names the preview.
 */

import { readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';

export const PREVIEW_ID_ENV = 'CODEMAN_PREVIEW_ID';
export const PREVIEW_OWNER_ENV = 'CODEMAN_PREVIEW_OWNER';

export interface ProcStat {
  pid: number;
  pgid: number;
  /** Field 22 of `/proc/<pid>/stat`, in clock ticks since boot. */
  startTicks: number;
  zombie: boolean;
}

export interface ProcEntry extends ProcStat {
  previewId?: string;
  previewOwner?: string;
}

export type ProcSnapshot = ReadonlyMap<number, ProcEntry>;

export function parseProcStat(text: string): ProcStat | null {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const pid = Number(text.slice(0, open).trim());
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const pgid = Number(fields[2]);
  const startTicks = Number(fields[19]);
  if (!Number.isInteger(pid) || !Number.isInteger(pgid) || !Number.isFinite(startTicks)) return null;
  return { pid, pgid, startTicks, zombie: fields[0] === 'Z' || fields[0] === 'X' };
}

export function parsePreviewMarker(environ: string): { previewId?: string; previewOwner?: string } {
  let previewId: string | undefined;
  let previewOwner: string | undefined;
  for (const entry of environ.split('\0')) {
    if (entry.startsWith(`${PREVIEW_ID_ENV}=`)) previewId = entry.slice(PREVIEW_ID_ENV.length + 1);
    else if (entry.startsWith(`${PREVIEW_OWNER_ENV}=`)) previewOwner = entry.slice(PREVIEW_OWNER_ENV.length + 1);
  }
  return { previewId, previewOwner };
}

/** Socket inodes in LISTEN state on `port`, from the text of `/proc/net/tcp` or `/proc/net/tcp6`. */
export function parseListenInodes(text: string, port: number): string[] {
  const inodes: string[] = [];
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10 || cols[3] !== '0A') continue;
    const local = cols[1];
    const portHex = local.slice(local.lastIndexOf(':') + 1);
    if (parseInt(portHex, 16) === port) inodes.push(cols[9]);
  }
  return inodes;
}

function ownPids(uid: number): number[] {
  const pids: number[] = [];
  for (const name of readdirSync('/proc')) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      if (statSync(`/proc/${name}`).uid === uid) pids.push(pid);
    } catch {
      // The process exited between readdir and stat.
    }
  }
  return pids;
}

export function readProcStat(pid: number): ProcStat | null {
  try {
    return parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf-8'));
  } catch {
    return null;
  }
}

export function readProcSnapshot(uid: number = process.getuid?.() ?? 0): ProcSnapshot {
  const snapshot = new Map<number, ProcEntry>();
  for (const pid of ownPids(uid)) {
    const stat = readProcStat(pid);
    if (!stat) continue;
    let marker = {};
    try {
      marker = parsePreviewMarker(readFileSync(`/proc/${pid}/environ`, 'latin1'));
    } catch {
      // A zombie or a process that just exited has no readable environ.
    }
    snapshot.set(pid, { ...stat, ...marker });
  }
  return snapshot;
}

/** Whether any process, of any uid, listens on `port`. */
export function isPortListening(port: number): boolean {
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      if (parseListenInodes(readFileSync(file, 'utf-8'), port).length > 0) return true;
    } catch {
      // No IPv6 on this host.
    }
  }
  return false;
}

export function findListenerPids(port: number, uid: number = process.getuid?.() ?? 0): number[] {
  const inodes = new Set<string>();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      for (const inode of parseListenInodes(readFileSync(file, 'utf-8'), port)) inodes.add(`socket:[${inode}]`);
    } catch {
      // No IPv6 on this host.
    }
  }
  if (inodes.size === 0) return [];
  const pids: number[] = [];
  for (const pid of ownPids(uid)) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (inodes.has(readlinkSync(`/proc/${pid}/fd/${fd}`))) {
          pids.push(pid);
          break;
        }
      } catch {
        // fd closed while scanning.
      }
    }
  }
  return pids;
}
