/**
 * @fileoverview A candidate colour promoted to live runs the full preview orphan sweep.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deployRole } from '../src/deploy-role.js';
import { readProcSnapshot, readProcStat } from '../src/preview-proc.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { WebServer } from '../src/web/server.js';

vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);

let server: WebServer;
let dataDir: string;
let savedDataDir: string | undefined;
let savedRole: string | undefined;

function ownerPids(): number[] {
  return [...readProcSnapshot().values()].filter((e) => !e.zombie && e.previewOwner === dataDir).map((e) => e.pid);
}

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-promotion-'));
  savedDataDir = process.env.CODEMAN_DATA_DIR;
  process.env.CODEMAN_DATA_DIR = dataDir;
  savedRole = process.env.CODEMAN_DEPLOY_ROLE;
  process.env.CODEMAN_DEPLOY_ROLE = 'candidate';
  server = new WebServer(0, false, true);
  await server.start();
});

afterAll(async () => {
  await server?.stop().catch(() => {});
  for (const pid of ownerPids()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  if (savedRole === undefined) delete process.env.CODEMAN_DEPLOY_ROLE;
  else process.env.CODEMAN_DEPLOY_ROLE = savedRole;
  deployRole.initFromEnv();
  if (savedDataDir === undefined) delete process.env.CODEMAN_DATA_DIR;
  else process.env.CODEMAN_DATA_DIR = savedDataDir;
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

describe('promotion to live', () => {
  it('stops a marker server that has no preview record', async () => {
    const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CODEMAN_PREVIEW_ID: 'lost-before-promotion', CODEMAN_PREVIEW_OWNER: dataDir },
    });
    orphan.unref();
    const pid = orphan.pid!;
    await new Promise((r) => setTimeout(r, 200));
    expect(ownerPids()).toEqual([pid]);

    expect(deployRole.current).toBe('candidate');
    const outcome = await server.changeDeployRole('live');
    expect(outcome).toMatchObject({ kind: 'accepted', role: 'live' });

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && readProcStat(pid) && !readProcStat(pid)!.zombie) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const stat = readProcStat(pid);
    expect(!stat || stat.zombie).toBe(true);
    expect(ownerPids()).toEqual([]);
  }, 20_000);
});
