/**
 * @fileoverview The server's answer to tmux sessions that vanished while it ran, against the real WebServer.
 *
 * `TmuxManager.refreshVanishedSessions()` emits `sessionsVanished`; the server must put the sessions on the
 * restore offer while `state.json` still holds their records, then delete them through the normal path, with
 * `tmuxGone` on the `session:deleted` broadcast so an open board re-reads the offer. A deploy candidate must
 * do neither. The mux event is emitted by hand here; the watcher itself is covered by test/mux-vanish.test.ts.
 *
 * Port: 0 (ephemeral, read back from `server.boundPort`).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { deployRole } from '../src/deploy-role.js';
import { rebootRestoreRegistry } from '../src/web/reboot-restore-registry.js';
import { WebServer } from '../src/web/server.js';
import { safeRmHomeTree } from './mocks/test-helpers.js';

interface Internals {
  mux: { emit(event: string, data: unknown): boolean };
  sessions: Map<string, unknown>;
  store: {
    getSession(id: string): Record<string, unknown> | undefined;
    setSession(id: string, s: Record<string, unknown>): void;
  };
  broadcast(event: string, data: unknown): void;
}

let server: WebServer;
let dir: string;
const internals = () => server as unknown as Internals;
const url = (path: string) => `http://localhost:${server.boundPort}${path}`;

async function createRunningSession(): Promise<string> {
  const res = await fetch(url('/api/sessions'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workingDir: dir, mode: 'claude' }),
  });
  const session = ((await res.json()) as { data: { session: Record<string, unknown> & { id: string } } }).data.session;
  const id = session.id;
  // As if its pane had been running: the offer needs an attach pid on the record.
  internals().store.setSession(id, { ...(internals().store.getSession(id) ?? session), pid: 4242, status: 'idle' });
  return id;
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  dir = join(homedir(), 'codeman-cases', 'vanish-case');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), 'vanish');
  server = new WebServer(0, false, true);
  await server.start();
}, 60000);

afterEach(() => {
  deployRole.initFromEnv({});
  rebootRestoreRegistry.reset();
});

afterAll(async () => {
  await server?.stop();
  safeRmHomeTree(dir);
}, 60000);

describe('a tmux session that vanished while the server ran', () => {
  it('goes on the restore offer, then its tab is deleted with tmuxGone', async () => {
    const id = await createRunningSession();
    const deleted: unknown[] = [];
    const s = internals();
    const original = s.broadcast.bind(server);
    s.broadcast = (event, data) => {
      if (event === 'session:deleted') deleted.push(data);
      original(event, data);
    };
    try {
      s.mux.emit('sessionsVanished', { sessionIds: [id] });
      await until(() => !s.sessions.has(id));
    } finally {
      s.broadcast = original;
    }
    expect(deleted).toContainEqual({ id, tmuxGone: true });
    expect(rebootRestoreRegistry.list(() => true).map((e) => e.sessionId)).toEqual([id]);
    expect(rebootRestoreRegistry.offerCause).toBe('tmux');

    const res = await fetch(url('/api/reboot-restore'));
    const body = (await res.json()) as { data: { cause: string; sessions: { id: string }[] } };
    expect(body.data.cause).toBe('tmux');
    expect(body.data.sessions.map((x) => x.id)).toEqual([id]);
  });

  it('leaves everything alone on a deploy candidate', async () => {
    const id = await createRunningSession();
    deployRole.initFromEnv({ CODEMAN_DEPLOY_ROLE: 'candidate' });
    internals().mux.emit('sessionsVanished', { sessionIds: [id] });
    await new Promise((r) => setTimeout(r, 300));
    expect(internals().sessions.has(id)).toBe(true);
    expect(rebootRestoreRegistry.list(() => true)).toEqual([]);
    deployRole.initFromEnv({});
    await fetch(url(`/api/sessions/${id}`), { method: 'DELETE' });
  });

  it('ignores an id the server does not hold', async () => {
    internals().mux.emit('sessionsVanished', { sessionIds: ['not-a-session'] });
    await new Promise((r) => setTimeout(r, 100));
    expect(rebootRestoreRegistry.list(() => true)).toEqual([]);
  });
});
