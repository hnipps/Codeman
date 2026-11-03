/**
 * Two deploy colours share one data dir. What reaches that dir from a real WebServer
 * (port 0) in each role: a candidate writes nothing, a retire writes its view once and then
 * nothing (its shutdown neither flushes nor kills a tmux session), and a promotion takes
 * over the records another colour wrote, under their real identity.
 *
 * The servers run one after another on the file's temp data dir, the way the colours
 * of a deploy take turns on a real one.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { getDataDir } from '../src/config/instance.js';
import { WebServer } from '../src/web/server.js';
import type { ScheduledRun } from '../src/web/ports/infra-port.js';

const workingDir = mkdtempSync(join(tmpdir(), 'codeman-deploy-colours-'));
// Longer than the store's 500 ms save debounce, so a write that was going to happen has.
const SETTLE_MS = 900;

let server: WebServer | null = null;

afterAll(async () => {
  await server?.stop();
  delete process.env.CODEMAN_DEPLOY_ROLE;
});

async function boot(role: 'candidate' | 'live'): Promise<WebServer> {
  process.env.CODEMAN_DEPLOY_ROLE = role;
  server = new WebServer(0, false, true);
  await server.start();
  return server;
}

async function stop(s: WebServer): Promise<void> {
  await s.stop();
  server = null;
}

async function api(s: WebServer, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${s.boundPort}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function createSession(s: WebServer, name: string): Promise<string> {
  const { body } = await api(s, 'POST', '/api/sessions', { workingDir, mode: 'shell', name });
  return body.data.session.id;
}

/** Every file under the data dir, by relative path, with its content hash. */
function snapshotDataDir(dir = getDataDir(), prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) Object.assign(out, snapshotDataDir(path, `${prefix}${entry}/`));
    else out[`${prefix}${entry}`] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
  return out;
}

function sessionsOnDisk(): Record<string, { name?: string; mode?: string; workingDir?: string }> {
  return JSON.parse(readFileSync(join(getDataDir(), 'state.json'), 'utf8')).sessions;
}

const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

/** A scheduled run whose session the server would kill when it shuts down. */
function attachScheduledRun(s: WebServer, sessionId: string): void {
  const now = Date.now();
  const run: ScheduledRun = {
    id: `run-${sessionId}`,
    prompt: 'p',
    workingDir,
    durationMinutes: 1,
    startedAt: now,
    endAt: now + 60_000,
    status: 'running',
    sessionId,
    completedTasks: 0,
    totalCost: 0,
    logs: [],
  };
  (s as unknown as { scheduledRuns: Map<string, ScheduledRun> }).scheduledRuns.set(run.id, run);
}

function spyOnTmuxKill(s: WebServer) {
  const mux = (s as unknown as { mux: { killSession(id: string): Promise<boolean> } }).mux;
  return vi.spyOn(mux, 'killSession');
}

describe('deploy colours on one data dir', () => {
  it('a live colour writes what it learns and kills a scheduled run on shutdown (control)', async () => {
    const live = await boot('live');
    const kept = await createSession(live, 'kept-by-live');
    const scheduled = await createSession(live, 'scheduled');
    attachScheduledRun(live, scheduled);
    const kill = spyOnTmuxKill(live);

    await stop(live);

    expect(sessionsOnDisk()[kept]?.name).toBe('kept-by-live');
    expect(kill).toHaveBeenCalledWith(scheduled);
  });

  it('a candidate writes nothing to the data dir while it serves requests', async () => {
    // The previous server's lifecycle appends are fire-and-forget past its stop().
    await settle();
    const before = snapshotDataDir();
    const candidate = await boot('candidate');

    expect((await api(candidate, 'GET', '/api/health')).body.data.deployRole).toBe('candidate');
    expect((await api(candidate, 'GET', '/api/sessions')).status).toBe(200);
    expect((await api(candidate, 'GET', '/api/status')).status).toBe(200);
    const made = await createSession(candidate, 'only-in-memory');
    expect((await api(candidate, 'GET', '/api/sessions')).body.data.map((x: { id: string }) => x.id)).toContain(made);
    // A pane it started would outlive every record of it: refused, not run some other way.
    const started = await api(candidate, 'POST', `/api/sessions/${made}/shell`);
    expect(started.body).toMatchObject({
      success: false,
      error: 'This Codeman is the candidate deploy colour; only the live colour creates sessions',
    });
    await settle();
    await stop(candidate);

    expect(snapshotDataDir()).toEqual(before);
  });

  it('a retire writes its view once, then nothing; its shutdown neither flushes nor kills', async () => {
    const live = await boot('live');
    const id = await createSession(live, 'before-rename');
    await api(live, 'PUT', `/api/sessions/${id}/name`, { name: 'renamed-just-before-retire' });

    const retired = await api(live, 'POST', '/api/deploy/role', { role: 'retired' });
    expect(retired.body).toEqual({ success: true, data: { role: 'retired', previous: 'live' } });
    // Read at once, inside the save debounce: the retire's own flush put it there.
    expect(sessionsOnDisk()[id]?.name).toBe('renamed-just-before-retire');

    const afterRetire = snapshotDataDir();
    attachScheduledRun(live, id);
    const kill = spyOnTmuxKill(live);
    await api(live, 'PUT', `/api/sessions/${id}/name`, { name: 'renamed-after-retire' });
    await createSession(live, 'made-after-retire');
    await settle();
    expect(snapshotDataDir()).toEqual(afterRetire);

    await stop(live);
    expect(snapshotDataDir()).toEqual(afterRetire);
    expect(kill).not.toHaveBeenCalled();
  });

  it('a promotion adopts the sessions another colour recorded, under their real identity', async () => {
    const candidate = await boot('candidate');
    const heldAtBoot = await createSession(candidate, 'name-the-candidate-saw');

    const overlap = 'b7d0c2a4-5e6f-4a1b-9c8d-0e1f2a3b4c5d';
    const now = Date.now();
    const muxRecord = (sessionId: string, name: string) => ({
      sessionId,
      muxName: `codeman-${sessionId.slice(0, 8)}`,
      pid: 4242,
      createdAt: now,
      workingDir,
      mode: 'shell',
      attached: false,
      name,
    });
    const stateRecord = (id: string, name: string) => ({
      id,
      name,
      nameSource: 'manual',
      mode: 'shell',
      workingDir,
      status: 'idle',
      createdAt: now,
      lastActivityAt: now,
    });
    // What the old colour flushed when it retired: a session made during the overlap,
    // and a rename of one the candidate already held.
    mkdirSync(getDataDir(), { recursive: true });
    writeFileSync(
      join(getDataDir(), 'mux-sessions.json'),
      JSON.stringify([muxRecord(overlap, 'made-during-overlap'), muxRecord(heldAtBoot, 'renamed-on-old-colour')])
    );
    const state = JSON.parse(readFileSync(join(getDataDir(), 'state.json'), 'utf8'));
    state.sessions = {
      [overlap]: stateRecord(overlap, 'made-during-overlap'),
      [heldAtBoot]: stateRecord(heldAtBoot, 'renamed-on-old-colour'),
    };
    writeFileSync(join(getDataDir(), 'state.json'), JSON.stringify(state));

    const promoted = await api(candidate, 'POST', '/api/deploy/role', { role: 'live' });
    expect(promoted.body).toEqual({ success: true, data: { role: 'live', previous: 'candidate' } });

    const listed = (await api(candidate, 'GET', '/api/sessions')).body.data as Array<Record<string, unknown>>;
    const byId = new Map(listed.map((s) => [s.id, s]));
    expect(byId.get(overlap)).toMatchObject({ name: 'made-during-overlap', mode: 'shell', workingDir });
    expect(byId.get(heldAtBoot)).toMatchObject({ name: 'renamed-on-old-colour', mode: 'shell' });
    expect(listed.filter((s) => String(s.id).startsWith('restored-'))).toEqual([]);

    // The promoted colour now writes, and what it wrote is the adopted view.
    const onDisk = sessionsOnDisk();
    expect(onDisk[overlap]).toMatchObject({ name: 'made-during-overlap', mode: 'shell' });
    expect(onDisk[heldAtBoot]?.name).toBe('renamed-on-old-colour');
    expect((await api(candidate, 'GET', '/api/health')).body.data.deployRole).toBe('live');
  });
});
