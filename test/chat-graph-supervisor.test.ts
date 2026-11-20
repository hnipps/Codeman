import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CHAT_GRAPH_OWNER_ENV, ChatGraphSupervisor } from '../src/chat-graph/supervisor.js';
import { ownPids, readEnvVar, readProcStat } from '../src/preview-proc.js';

const FAKE_SIDECAR = `#!${process.execPath}
const fs = require('fs');
const http = require('http');
const path = require('path');
const dir = process.argv[process.argv.indexOf('--dir') + 1];
if (!path.isAbsolute(dir)) process.exit(2);
const sock = path.join(dir, 'sock');
try { fs.unlinkSync(sock); } catch {}
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); }
  else { res.statusCode = 404; res.end(); }
});
server.listen(sock, () => fs.chmodSync(sock, 0o600));
process.on('SIGTERM', () => server.close(() => { try { fs.unlinkSync(sock); } catch {} process.exit(0); }));
`;

let root: string;
let binary: string;
let dir: string;
let owner: string;
const spawned: number[] = [];
const supervisors: ChatGraphSupervisor[] = [];

function environOf(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'latin1');
  } catch {
    return '';
  }
}

function markedPids(markerOwner: string): number[] {
  return ownPids(process.getuid!()).filter((pid) => {
    const stat = readProcStat(pid);
    return stat && !stat.zombie && readEnvVar(environOf(pid), CHAT_GRAPH_OWNER_ENV) === markerOwner;
  });
}

function isAlive(pid: number): boolean {
  const stat = readProcStat(pid);
  return stat !== null && !stat.zombie;
}

async function until(check: () => boolean, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

/** A process carrying the owner marker, as a crashed Codeman's sidecar would. */
async function spawnMarked(markerOwner: string): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e3)'], {
    stdio: 'ignore',
    env: { PATH: process.env.PATH ?? '', [CHAT_GRAPH_OWNER_ENV]: markerOwner },
  });
  const pid = child.pid!;
  spawned.push(pid);
  expect(await until(() => readEnvVar(environOf(pid), CHAT_GRAPH_OWNER_ENV) === markerOwner)).toBe(true);
  return pid;
}

function supervisor(
  mayPersist: () => boolean,
  extra: Partial<ConstructorParameters<typeof ChatGraphSupervisor>[0]> = {}
) {
  const sup = new ChatGraphSupervisor({ binary, dir, owner, mayPersist, ...extra });
  supervisors.push(sup);
  return sup;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-'));
  binary = path.join(root, 'chat-graph');
  await fs.writeFile(binary, FAKE_SIDECAR);
  await fs.chmod(binary, 0o755);
  dir = path.join(root, 'd');
  owner = path.join(root, 'data');
});

afterEach(async () => {
  for (const sup of supervisors.splice(0)) await sup.stop();
  for (const pid of [...spawned.splice(0), ...markedPids(owner), ...markedPids(`${owner}-other`)]) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  await fs.rm(root, { recursive: true, force: true });
});

describe('ChatGraphSupervisor', () => {
  it('starts nothing and sweeps nothing when the role may not persist', async () => {
    // Invariant I6: OnlyTheLiveColourRunsTheSidecar
    const sup = supervisor(() => false);
    const orphan = await spawnMarked(owner);

    const result = await sup.start();

    expect(result).toMatchObject({ ok: false, reason: 'role' });
    expect(existsSync(path.join(dir, 'sock'))).toBe(false);
    expect(markedPids(owner)).toEqual([orphan]);
    expect(await sup.sweep()).toBe(0);
    expect(isAlive(orphan)).toBe(true);
  });

  it('starts a healthy sidecar with only the owner marker in its environment, and reuses it', async () => {
    const previous = process.env.CODEMAN_PASSWORD;
    process.env.CODEMAN_PASSWORD = 'not-for-the-sidecar';
    try {
      const sup = supervisor(() => true);

      expect(await sup.start()).toEqual({ ok: true, reused: false });
      expect(await sup.health()).toBe(true);
      const [pid] = markedPids(owner);
      expect(pid).toBeDefined();
      const environ = environOf(pid);
      expect(readEnvVar(environ, CHAT_GRAPH_OWNER_ENV)).toBe(owner);
      expect(readEnvVar(environ, 'CODEMAN_PASSWORD')).toBeUndefined();
      expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);

      expect(await sup.start()).toEqual({ ok: true, reused: true });
      expect(markedPids(owner)).toEqual([pid]);
    } finally {
      if (previous === undefined) delete process.env.CODEMAN_PASSWORD;
      else process.env.CODEMAN_PASSWORD = previous;
    }
  });

  it('stops its own child after the role changes away from live', async () => {
    // Invariant I6: OnlyTheLiveColourRunsTheSidecar
    let live = true;
    const sup = supervisor(() => live);
    expect((await sup.start()).ok).toBe(true);
    const [pid] = markedPids(owner);

    live = false;
    await sup.stop();

    expect(await until(() => !isAlive(pid))).toBe(true);
    expect(await sup.health()).toBe(false);
  });

  it('sweeps orphans with this owner marker only, and spares its own child', async () => {
    // Invariant I6: OnlyTheLiveColourRunsTheSidecar
    const sup = supervisor(() => true);
    expect((await sup.start()).ok).toBe(true);
    const [own] = markedPids(owner);
    const orphan = await spawnMarked(owner);
    const otherColour = await spawnMarked(`${owner}-other`);

    expect(await sup.sweep()).toBe(1);

    expect(await until(() => !isAlive(orphan))).toBe(true);
    expect(isAlive(otherColour)).toBe(true);
    expect(isAlive(own)).toBe(true);
    expect(await sup.health()).toBe(true);
  });

  it('never signals a pid whose start time no longer matches the recorded one', async () => {
    // Invariant I6: OnlyTheLiveColourRunsTheSidecar
    let recycled = false;
    const sup = supervisor(() => true, {
      readStat: (pid) => {
        const stat = readProcStat(pid);
        return stat && recycled ? { ...stat, startTicks: stat.startTicks + 1 } : stat;
      },
    });
    expect((await sup.start()).ok).toBe(true);
    const [pid] = markedPids(owner);

    recycled = true;
    await sup.stop();

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(isAlive(pid)).toBe(true);
    expect(await sup.health()).toBe(true);
  });

  it('reports a missing binary without spawning', async () => {
    const sup = supervisor(() => true, { binary: path.join(root, 'absent') });

    expect(await sup.start()).toMatchObject({ ok: false, reason: 'missing-binary' });
    expect(markedPids(owner)).toEqual([]);
  });
});
