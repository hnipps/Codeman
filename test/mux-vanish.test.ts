/**
 * @fileoverview A tmux session that vanishes while the server runs (2026-11-19).
 *
 * The tmux server died under a running Codeman twice; every session lost its pane and stayed listed
 * as an idle tab, and the deploy health check then refused every deploy because the new colour did
 * not keep the dead sessions. These tests pin the rules that now drop them:
 *  - the pure classifier and miss counter (`src/mux-vanish.ts`),
 *  - `TmuxManager.refreshVanishedSessions()` through a subclass that scripts the tmux read,
 *  - the deploy-role guards: a non-live colour shares the live colour's socket and must never kill
 *    a session or respawn a pane on it, nor drop sessions it noticed missing,
 *  - the restore offer the dropped sessions go to (`RebootRestoreRegistry.offer`).
 *
 * Port: N/A (no server needed)
 */

import { afterEach, describe, expect, it } from 'vitest';
import { deployRole, DeployRoleRefusal } from '../src/deploy-role.js';
import type { MuxSession } from '../src/mux-interface.js';
import { classifyListSessions, nextVanishCounts, VANISH_CONFIRM_READS, type MuxProbe } from '../src/mux-vanish.js';
import type { RebootRestoreEntry } from '../src/reboot-restore.js';
import { TmuxManager } from '../src/tmux-manager.js';
import type { SessionState } from '../src/types.js';
import { RebootRestoreRegistry } from '../src/web/reboot-restore-registry.js';

afterEach(() => {
  deployRole.initFromEnv({});
});

const running = (...names: string[]): MuxProbe => ({ kind: 'running', names: new Set(names) });

describe('classifying one tmux list-sessions', () => {
  it('lists the names tmux printed', () => {
    const probe = classifyListSessions(false, 'codeman-a\ncodeman-b\n', '');
    expect(probe).toEqual({ kind: 'running', names: new Set(['codeman-a', 'codeman-b']) });
  });

  it('reads a missing socket or a refused connection as no server', () => {
    expect(classifyListSessions(true, '', 'no server running on /tmp/tmux-1001/codeman').kind).toBe('none');
    expect(
      classifyListSessions(true, '', 'error connecting to /tmp/tmux-1001/codeman (No such file or directory)').kind
    ).toBe('none');
    // tmux 3.4 capitalises it.
    expect(classifyListSessions(true, '', 'Error connecting to /tmp/tmux-1001/codeman (Connection refused)').kind).toBe(
      'none'
    );
  });

  it('proves nothing from any other failure', () => {
    expect(classifyListSessions(true, '', 'error connecting to /tmp/x (Permission denied)').kind).toBe('unknown');
    expect(classifyListSessions(true, '', '').kind).toBe('unknown');
  });
});

describe('counting misses', () => {
  it(`needs ${VANISH_CONFIRM_READS} answering reads in a row`, () => {
    const first = nextVanishCounts(new Map(), ['codeman-a'], running());
    expect(first.vanished).toEqual([]);
    const second = nextVanishCounts(first.counts, ['codeman-a'], running());
    expect(second.vanished).toEqual(['codeman-a']);
  });

  it('counts no server as a miss for every watched session', () => {
    const first = nextVanishCounts(new Map(), ['codeman-a', 'codeman-b'], { kind: 'none' });
    const second = nextVanishCounts(first.counts, ['codeman-a', 'codeman-b'], { kind: 'none' });
    expect(second.vanished).toEqual(['codeman-a', 'codeman-b']);
  });

  it('starts again when the session is seen', () => {
    const first = nextVanishCounts(new Map(), ['codeman-a'], running());
    const seen = nextVanishCounts(first.counts, ['codeman-a'], running('codeman-a'));
    expect(seen.counts.size).toBe(0);
    expect(nextVanishCounts(seen.counts, ['codeman-a'], running()).vanished).toEqual([]);
  });

  it('keeps the count through a read that proves nothing, and never vanishes on one', () => {
    let counts = new Map<string, number>();
    for (let i = 0; i < 10; i++) {
      const next = nextVanishCounts(counts, ['codeman-a'], { kind: 'unknown' });
      expect(next.vanished).toEqual([]);
      counts = next.counts;
    }
    const missed = nextVanishCounts(counts, ['codeman-a'], running());
    expect(missed.vanished).toEqual([]);
    const held = nextVanishCounts(missed.counts, ['codeman-a'], { kind: 'unknown' });
    expect(held.counts.get('codeman-a')).toBe(1);
    expect(nextVanishCounts(held.counts, ['codeman-a'], running()).vanished).toEqual(['codeman-a']);
  });

  it('forgets a name that is no longer watched', () => {
    const first = nextVanishCounts(new Map(), ['codeman-a'], running());
    expect(nextVanishCounts(first.counts, [], running()).counts.size).toBe(0);
  });
});

/** A TmuxManager whose tmux read is scripted. */
class ScriptedTmux extends TmuxManager {
  probes: MuxProbe[] = [];
  reads = 0;
  protected override async probeMuxSessions(): Promise<MuxProbe> {
    this.reads++;
    return this.probes.shift() ?? { kind: 'unknown' };
  }
}

function local(sessionId: string): MuxSession {
  return {
    sessionId,
    muxName: `codeman-${sessionId}`,
    pid: 1,
    createdAt: Date.now(),
    workingDir: '/tmp',
    mode: 'claude',
    attached: false,
  };
}

function watch(mux: TmuxManager) {
  const died: string[] = [];
  const vanished: string[][] = [];
  mux.on('sessionDied', (d: { sessionId: string }) => died.push(d.sessionId));
  mux.on('sessionsVanished', (d: { sessionIds: string[] }) => vanished.push(d.sessionIds));
  return { died, vanished };
}

describe('the running server drops a session whose tmux session vanished', () => {
  it('drops it after two misses and reports the batch once', async () => {
    const mux = new ScriptedTmux();
    mux.registerSession(local('a'));
    mux.registerSession(local('b'));
    mux.registerSession(local('c'));
    const seen = watch(mux);
    mux.probes = [running('codeman-c'), running('codeman-c')];
    await mux.refreshVanishedSessions();
    expect(seen.died).toEqual([]);
    expect(mux.getSession('a')).toBeDefined();
    await mux.refreshVanishedSessions();
    expect(seen.died).toEqual(['a', 'b']);
    expect(seen.vanished).toEqual([['a', 'b']]);
    expect(mux.getSession('a')).toBeUndefined();
    expect(mux.getSession('c')).toBeDefined();
    mux.destroy();
  });

  it('never drops anything on reads that prove nothing', async () => {
    const mux = new ScriptedTmux();
    mux.registerSession(local('a'));
    const seen = watch(mux);
    for (let i = 0; i < 5; i++) await mux.refreshVanishedSessions();
    expect(mux.reads).toBe(5);
    expect(seen.died).toEqual([]);
    expect(mux.getSession('a')).toBeDefined();
    mux.destroy();
  });

  it('leaves remote and docker sessions to their own watchers', async () => {
    const mux = new ScriptedTmux();
    mux.registerSession({
      ...local('r'),
      remote: { hostId: 'h', remotePath: '/x', owned: true } as MuxSession['remote'],
    });
    mux.registerSession({ ...local('d'), docker: { caseName: 'c' } as unknown as MuxSession['docker'] });
    const seen = watch(mux);
    mux.probes = [{ kind: 'none' }, { kind: 'none' }];
    await mux.refreshVanishedSessions();
    await mux.refreshVanishedSessions();
    // Nothing local to watch, so it never even reads.
    expect(mux.reads).toBe(0);
    expect(seen.died).toEqual([]);
    mux.destroy();
  });

  it('does nothing on a candidate colour, which shares the live socket', async () => {
    deployRole.initFromEnv({ CODEMAN_DEPLOY_ROLE: 'candidate' });
    const mux = new ScriptedTmux();
    mux.registerSession(local('a'));
    const seen = watch(mux);
    mux.probes = [{ kind: 'none' }, { kind: 'none' }];
    await mux.refreshVanishedSessions();
    await mux.refreshVanishedSessions();
    expect(mux.reads).toBe(0);
    expect(seen.died).toEqual([]);
    expect(mux.getSession('a')).toBeDefined();
    mux.destroy();
  });
});

describe('a non-live colour never changes a pane on the shared socket', () => {
  it('refuses to kill a session', async () => {
    const mux = new TmuxManager();
    mux.registerSession(local('a'));
    deployRole.initFromEnv({ CODEMAN_DEPLOY_ROLE: 'candidate' });
    await expect(mux.killSession('a')).rejects.toBeInstanceOf(DeployRoleRefusal);
    expect(mux.getSession('a')).toBeDefined();
    mux.destroy();
  });

  it('refuses to respawn a pane', async () => {
    const mux = new TmuxManager();
    mux.registerSession(local('a'));
    deployRole.initFromEnv({ CODEMAN_DEPLOY_ROLE: 'candidate' });
    await expect(mux.respawnPane({ sessionId: 'a', workingDir: '/tmp', mode: 'claude' })).rejects.toBeInstanceOf(
      DeployRoleRefusal
    );
    mux.destroy();
  });

  it('still answers false for a session it does not hold', async () => {
    const mux = new TmuxManager();
    deployRole.initFromEnv({ CODEMAN_DEPLOY_ROLE: 'candidate' });
    await expect(mux.killSession('nope')).resolves.toBe(false);
    mux.destroy();
  });

  it('lets the live colour kill', async () => {
    const mux = new TmuxManager();
    mux.registerSession(local('a'));
    await expect(mux.killSession('a')).resolves.toBe(true);
    mux.destroy();
  });
});

describe('the restore offer for vanished sessions', () => {
  const all = () => true;
  const entry = (sessionId: string): RebootRestoreEntry => ({
    sessionId,
    workingDir: '/tmp',
    mode: 'claude',
    resumeConversationId: `conv-${sessionId}`,
    state: { id: sessionId } as SessionState,
  });

  it('adds to what is on offer and names the tmux server as the cause', () => {
    const registry = new RebootRestoreRegistry();
    registry.set([entry('boot')]);
    expect(registry.offerCause).toBe('reboot');
    registry.offer([entry('lost')]);
    expect(registry.list(all).map((e) => e.sessionId)).toEqual(['boot', 'lost']);
    expect(registry.offerCause).toBe('tmux');
    registry.set([]);
    expect(registry.offerCause).toBe('reboot');
  });

  it('does not put back an entry a restore is building', () => {
    const registry = new RebootRestoreRegistry();
    registry.set([entry('a')]);
    const taken = registry.take(all, undefined, undefined);
    registry.offer([entry('a'), entry('b')]);
    expect(registry.list(all).map((e) => e.sessionId)).toEqual(['b']);
    registry.releaseFlight(undefined, taken);
  });

  it('changes nothing for an empty offer', () => {
    const registry = new RebootRestoreRegistry();
    registry.offer([]);
    expect(registry.offerCause).toBe('reboot');
    expect(registry.list(all)).toEqual([]);
  });
});
