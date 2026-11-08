/**
 * @fileoverview Respawn lifecycle: a stop is the user's persisted desired state,
 * and a session never has two controllers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state-store.js';
import {
  restoreRespawnController,
  stopRespawnForSession,
  saveRespawnConfig,
  setupTimedRespawn,
  type RespawnWiringDeps,
} from '../src/web/respawn-event-wiring.js';
import type { RespawnController } from '../src/respawn-controller.js';
import type { PersistedRespawnConfig } from '../src/types.js';
import { MockSession } from './mocks/index.js';

const enabledConfig: PersistedRespawnConfig = {
  enabled: true,
  idleTimeoutMs: 10000,
  updatePrompt: 'update',
  interStepDelayMs: 1000,
  sendClear: true,
  sendInit: true,
};

describe('respawn lifecycle', () => {
  let dir: string;
  let store: StateStore;
  let controllers: Map<string, RespawnController>;
  let pending: Map<string, NodeJS.Timeout>;
  let timers: Map<string, { timer: NodeJS.Timeout; endAt: number; startedAt: number }>;
  let muxConfig: PersistedRespawnConfig | undefined;
  let session: MockSession;
  let deps: RespawnWiringDeps;
  let serverStartTime: number;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'respawn-lifecycle-'));
    store = new StateStore(join(dir, 'state.json'));
    controllers = new Map();
    pending = new Map();
    timers = new Map();
    muxConfig = { ...enabledConfig };
    session = new MockSession('s1');
    serverStartTime = Date.now();
    store.setSession('s1', { id: 's1', respawnEnabled: true, respawnConfig: { ...enabledConfig } } as never);
    deps = {
      broadcast: vi.fn(),
      sendPushNotifications: vi.fn(),
      persistSessionState: vi.fn(),
      getSession: () => session as never,
      sessionExists: () => true,
      getRunSummaryTracker: () => undefined,
      getRespawnControllers: () => controllers,
      getRespawnTimers: () => timers,
      getPendingRespawnStarts: () => pending,
      teamWatcher: { getTeams: () => [], getTeamTasks: () => [], hasActiveTeammates: () => false } as never,
      serverStartTime,
      respawnRestoreGracePeriodMs: 120000,
      mux: {
        getSession: () => (muxConfig ? { respawnConfig: muxConfig } : undefined),
        clearRespawnConfig: () => {
          muxConfig = undefined;
        },
        updateRespawnConfig: vi.fn(),
      } as never,
      store,
    };
  });

  afterEach(() => {
    for (const c of controllers.values()) c.stop();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  // Invariant RL-1: Respawn stop is absorbing across restart
  it('stop with no controller still clears persisted and mux enabled state', () => {
    stopRespawnForSession('s1', deps);
    const saved = store.getSession('s1');
    expect(saved?.respawnEnabled).toBe(false);
    expect(saved?.respawnConfig?.enabled).toBeFalsy();
    expect(muxConfig).toBeUndefined();
  });

  // Invariant RL-1: Respawn stop is absorbing across restart
  it('a stop cancels a restore that is still waiting out the grace period', () => {
    restoreRespawnController(session as never, enabledConfig, 'state.json', deps);
    const controller = controllers.get('s1')!;
    expect(pending.has('s1')).toBe(true);

    stopRespawnForSession('s1', deps);
    vi.advanceTimersByTime(300000);

    expect(pending.has('s1')).toBe(false);
    expect(controllers.has('s1')).toBe(false);
    expect(controller.state).toBe('stopped');
  });

  // Invariant RL-2: At most one controller per session
  it('restoring over an existing controller stops the old one', () => {
    restoreRespawnController(session as never, enabledConfig, 'state.json', deps);
    const first = controllers.get('s1')!;
    first.start();
    expect(first.state).not.toBe('stopped');

    restoreRespawnController(session as never, enabledConfig, 'mux-sessions.json', deps);

    expect(first.state).toBe('stopped');
    expect(controllers.get('s1')).not.toBe(first);
    expect(controllers.size).toBe(1);
  });

  it('budget exhaustion clears desired state, timers and pending restore, and broadcasts its reason once', () => {
    restoreRespawnController(session as never, enabledConfig, 'state.json', deps);
    const controller = controllers.get('s1')!;
    setupTimedRespawn('s1', 10, deps);
    vi.mocked(deps.broadcast).mockClear();
    const reason = { reason: 'unchanged_workspace', details: '3 unchanged cycles' };
    controller.emit('budgetExhausted', reason);
    vi.advanceTimersByTime(700000);

    expect(store.getSession('s1')?.respawnEnabled).toBe(false);
    expect(store.getSession('s1')?.respawnConfig).toBeUndefined();
    expect(muxConfig).toBeUndefined();
    expect(controllers.size).toBe(0);
    expect(pending.size).toBe(0);
    expect(timers.size).toBe(0);
    expect(vi.mocked(deps.broadcast).mock.calls.filter(([event]) => event === 'respawn:stopped')).toEqual([
      ['respawn:stopped', { sessionId: 's1', ...reason }],
    ]);
  });

  it('duration exhaustion uses the persisted stop path and cancels a delayed restore', () => {
    restoreRespawnController(session as never, enabledConfig, 'state.json', deps);
    setupTimedRespawn('s1', 1, deps);
    vi.advanceTimersByTime(300000);
    expect(store.getSession('s1')?.respawnEnabled).toBe(false);
    expect(store.getSession('s1')?.respawnConfig).toBeUndefined();
    expect(muxConfig).toBeUndefined();
    expect(pending.size).toBe(0);
    expect(controllers.size).toBe(0);
    expect(deps.broadcast).toHaveBeenCalledWith('respawn:stopped', {
      sessionId: 's1',
      reason: 'duration_expired',
    });
  });

  // Invariant RL-3: Loop off implies the respawn it started is off
  it('records that the loop started the respawn, and keeps the mark on later saves', () => {
    const updateRespawnConfig = vi.fn();
    const mux = { updateRespawnConfig, getSession: () => ({ respawnConfig: { startedByLoop: true } }) };
    saveRespawnConfig('s1', { ...enabledConfig } as never, mux as never, undefined, { startedByLoop: true });
    expect(updateRespawnConfig.mock.calls[0][1].startedByLoop).toBe(true);
    saveRespawnConfig('s1', { ...enabledConfig } as never, mux as never);
    expect(updateRespawnConfig.mock.calls[1][1].startedByLoop).toBe(true);
  });
});
