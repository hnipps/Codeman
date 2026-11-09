/**
 * The live lease (src/deploy-lease.ts): one process per data dir holds the right to
 * automate. A server started with no deploy role must not become a second live writer
 * beside a Codeman that already holds it, and a promote hands the lease over.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deployRole } from '../src/deploy-role.js';
import {
  acquireLiveLease,
  leasePath,
  readProcessStart,
  releaseLiveLease,
  type ProcessProbe,
} from '../src/deploy-lease.js';
import { startWebServer, type WebServer } from '../src/web/server.js';

const children: ChildProcess[] = [];
const servers: WebServer[] = [];

/** A real process whose command line reads as a Codeman web server, standing in for another Codeman. */
async function foreignCodeman(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', 'index.js', 'web'], { stdio: 'ignore' });
  children.push(child);
  await new Promise((r) => setTimeout(r, 200));
  return child.pid!;
}

function holdLease(pid: number): void {
  writeFileSync(
    leasePath(),
    JSON.stringify({ pid, startedAt: readProcessStart(pid), tmuxSocket: 'codeman', command: 'node index.js web' })
  );
}

function fakeProbe(procs: Record<number, { command: string; startedAt: string }>): ProcessProbe {
  return {
    alive: (pid) => pid in procs,
    command: (pid) => procs[pid]?.command ?? null,
    startedAt: (pid) => procs[pid]?.startedAt ?? null,
  };
}

beforeEach(() => {
  deployRole.initFromEnv({});
  delete process.env.CODEMAN_DEPLOY_ROLE;
});

afterEach(async () => {
  deployRole.initFromEnv({});
  for (const s of servers.splice(0)) await s.stop().catch(() => undefined);
  for (const c of children.splice(0)) c.kill('SIGKILL');
  releaseLiveLease();
});

describe('a role-less server beside a live Codeman', () => {
  // Invariant RL-6: At most one process holds the live lease per data directory
  it('refuses to start and says which process owns the data dir', async () => {
    const pid = await foreignCodeman();
    holdLease(pid);
    const err = await startWebServer(0, false, true).then(
      (s) => {
        servers.push(s);
        return null;
      },
      (e: Error) => e
    );
    expect(err).not.toBeNull();
    expect(err!.message).toContain(String(pid));
    expect(err!.message).toContain('CODEMAN_INSTANCE');
  });

  // Invariant RL-6: At most one process holds the live lease per data directory
  it('still lets a candidate start, and refuses its promotion until the holder is gone', async () => {
    const pid = await foreignCodeman();
    holdLease(pid);
    process.env.CODEMAN_DEPLOY_ROLE = 'candidate';
    const server = await startWebServer(0, false, true);
    servers.push(server);
    const refused = await server.changeDeployRole('live').catch((e: Error) => e);
    expect(refused).toBeInstanceOf(Error);
    expect(deployRole.current).toBe('candidate');
    children.splice(0).forEach((c) => c.kill('SIGKILL'));
    await new Promise((r) => setTimeout(r, 200));
    const outcome = await server.changeDeployRole('live');
    expect(outcome.kind).toBe('accepted');
    expect(JSON.parse(readFileSync(leasePath(), 'utf-8')).pid).toBe(process.pid);
  });
});

describe('stale leases', () => {
  const holder = (pid: number, startedAt = 'Mon Nov  8 10:00:00 2026') => ({
    pid,
    startedAt,
    tmuxSocket: 'codeman',
    command: 'node index.js web',
  });

  it.each([
    ['a dead pid', {}, 'Mon Nov  8 10:00:00 2026'],
    [
      'a pid reused by another program',
      { 4242: { command: 'vim notes.txt', startedAt: 'Mon Nov  8 10:00:00 2026' } },
      'Mon Nov  8 10:00:00 2026',
    ],
    [
      'a pid reused by a later Codeman',
      { 4242: { command: 'node index.js web', startedAt: 'Mon Nov  8 12:00:00 2026' } },
      'Mon Nov  8 10:00:00 2026',
    ],
  ])('are taken over when the holder is %s', (_name, procs, startedAt) => {
    writeFileSync(leasePath(), JSON.stringify(holder(4242, startedAt)));
    const result = acquireLiveLease({ pid: 777, probe: fakeProbe(procs as never) });
    expect(result.kind).toBe('acquired');
    expect(JSON.parse(readFileSync(leasePath(), 'utf-8')).pid).toBe(777);
  });

  it('are kept when the holder is a live Codeman', () => {
    writeFileSync(leasePath(), JSON.stringify(holder(4242)));
    const probe = fakeProbe({ 4242: { command: 'node index.js web', startedAt: 'Mon Nov  8 10:00:00 2026' } });
    expect(acquireLiveLease({ pid: 777, probe }).kind).toBe('held');
  });
});

describe('handover', () => {
  // Invariant RL-6: At most one process holds the live lease per data directory
  it('moves from the retiring colour to the promoted one, and only the holder can release', () => {
    const probe = fakeProbe({
      1: { command: 'node index.js web', startedAt: 'a' },
      2: { command: 'node index.js web', startedAt: 'b' },
    });
    expect(acquireLiveLease({ pid: 1, probe }).kind).toBe('acquired');
    expect(acquireLiveLease({ pid: 2, probe }).kind).toBe('held');
    releaseLiveLease({ pid: 2 });
    expect(existsSync(leasePath())).toBe(true);
    releaseLiveLease({ pid: 1 });
    expect(acquireLiveLease({ pid: 2, probe }).kind).toBe('acquired');
  });
});
