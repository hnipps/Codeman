import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    return readFileSync(`/proc/${pid}/environ`, 'utf-8');
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

  it('keeps a child that outlived SIGKILL recorded, so a retried stop still reports it', async () => {
    // Invariant I6: OnlyTheLiveColourRunsTheSidecar
    const sup = supervisor(() => true);
    expect((await sup.start()).ok).toBe(true);
    const [pid] = markedPids(owner);

    const realKill = process.kill.bind(process);
    const kill = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (target === pid) return true; // the child ignores every signal, as one stuck in the kernel would
      return realKill(target, signal);
    });
    try {
      expect(await sup.stop()).toBe(false);
      expect(isAlive(pid)).toBe(true);
      expect(await sup.stop()).toBe(false);
    } finally {
      kill.mockRestore();
    }
    expect(await sup.stop()).toBe(true);
    expect(await until(() => !isAlive(pid))).toBe(true);
  }, 30_000);

  it('a start gives way to a stop called after it, so nothing outlives a retire', async () => {
    // Invariant I6: OnlyTheLiveColourRunsTheSidecar
    let live = true;
    const sup = supervisor(() => live);

    const started = sup.start();
    expect(await sup.stop()).toBe(true);
    expect(markedPids(owner)).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(markedPids(owner)).toEqual([]);
    live = false;

    // The start gives way to the stop queued behind it rather than hold it for the readiness timeout.
    expect(await started).toMatchObject({ ok: false, reason: 'stopped' });
  });

  it('a stop is not held for the readiness timeout by a start whose sidecar never answers', async () => {
    const silent = path.join(root, 'silent');
    await fs.writeFile(silent, `#!${process.execPath}\nsetInterval(() => {}, 1e3);\n`);
    await fs.chmod(silent, 0o755);
    const sup = supervisor(() => true, { binary: silent, readyTimeoutMs: 30_000 });

    const started = sup.start();
    expect(await until(() => markedPids(owner).length === 1)).toBe(true);
    const t0 = Date.now();
    expect(await sup.stop()).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(await started).toMatchObject({ ok: false, reason: 'stopped' });
    expect(markedPids(owner)).toEqual([]);
  }, 20_000);

  it('refuses a socket path too long for sun_path, with a message naming the limit', async () => {
    // `<dir>/sock` of exactly 108 bytes: one over the limit.
    const long = path.join(root, 'x'.repeat(108 - Buffer.byteLength(root) - '//sock'.length));
    expect(Buffer.byteLength(path.join(long, 'sock'))).toBe(108);
    const sup = supervisor(() => true, { dir: long });

    const result = await sup.start();
    expect(result).toMatchObject({ ok: false, reason: 'failed' });
    expect(result.ok ? '' : result.error).toContain('107 bytes');
    expect(markedPids(owner)).toEqual([]);
  });

  it('starts on a socket path of exactly 107 bytes', async () => {
    const edge = path.join(root, 'y'.repeat(107 - Buffer.byteLength(root) - '//sock'.length));
    expect(Buffer.byteLength(path.join(edge, 'sock'))).toBe(107);

    expect(await supervisor(() => true, { dir: edge }).start()).toEqual({ ok: true, reused: false });
  });

  it('sweeps an orphan whose owner marker is a non-ASCII data dir', async () => {
    const accented = `${owner}-josé`;
    const sup = supervisor(() => true, { owner: accented });
    await spawnMarked(accented);

    expect(await sup.sweep()).toBe(1);
  });

  it('a start queued after a sweep runs once the orphans are gone, and keeps its own child', async () => {
    const sup = supervisor(() => true);
    const orphan = await spawnMarked(owner);

    const swept = sup.sweep();
    const started = sup.start();
    const again = sup.sweep();

    expect(await swept).toBe(1);
    expect(isAlive(orphan)).toBe(false);
    expect(await started).toEqual({ ok: true, reused: false });
    expect(await again).toBe(0);
    expect(markedPids(owner)).toHaveLength(1);
    expect(await sup.health()).toBe(true);
  });

  /**
   * Property-based check of the supervisor under the call structure `server.ts` gives it
   * (Crosscheck /lightweight-verify, option B). Role changes run one at a time, like
   * `changeDeployRole`; `runChatGraph` queues a sweep and a start without awaiting them, and a
   * retire awaits `stop()` and flips the role only after more awaited work, as `retireFromLive`
   * does. Schedules come from a seeded generator so a failure names a replayable seed.
   */
  it('holds I6 over random interleavings of boot, retire, reinstate and shutdown', async () => {
    // Invariant I6: OnlyTheLiveColourRunsTheSidecar
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    for (const seed of seeds) {
      let state = seed;
      const rand = (n: number) => {
        state = (state * 1103515245 + 12345) % 2 ** 31;
        return state % n;
      };
      const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

      let live = true;
      const sup = supervisor(() => live);
      const starts: Promise<unknown>[] = [];
      const runChatGraph = () => {
        void sup.sweep();
        starts.push(sup.start());
      };
      let roles: Promise<void> = Promise.resolve();
      const violations: string[] = [];

      runChatGraph();
      for (let step = 0; step < 6; step++) {
        const op = rand(3);
        if (op === 0) {
          roles = roles.then(async () => {
            if (!live) return;
            await sup.stop();
            await pause(rand(150));
            const left = markedPids(owner);
            if (left.length > 0) violations.push(`seed ${seed}: sidecar ${left.join(',')} alive when retire returned`);
            live = false;
          });
        } else if (op === 1) {
          roles = roles.then(async () => {
            if (live) return;
            live = true;
            runChatGraph();
          });
        } else {
          roles = roles.then(async () => {
            if (live) runChatGraph();
          });
        }
        await pause(rand(80));
      }
      await roles;
      await Promise.all(starts);
      const finallyLive = live;
      roles = roles.then(async () => {
        if (!live) return;
        await sup.stop();
        live = false;
      });
      await roles;
      await pause(200);

      expect(violations).toEqual([]);
      expect(markedPids(owner), `seed ${seed} (ended live: ${finallyLive})`).toEqual([]);
      for (const result of await Promise.all(starts)) {
        const r = result as { ok: boolean; reason?: string; error?: string };
        expect(r.ok || r.reason === 'role' || r.reason === 'stopped', `seed ${seed}: ${JSON.stringify(r)}`).toBe(true);
      }
    }
  }, 60_000);

  it('reports a missing binary without spawning', async () => {
    const sup = supervisor(() => true, { binary: path.join(root, 'absent') });

    expect(await sup.start()).toMatchObject({ ok: false, reason: 'missing-binary' });
    expect(markedPids(owner)).toEqual([]);
  });
});
