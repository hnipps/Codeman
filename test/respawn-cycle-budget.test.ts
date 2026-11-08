/**
 * An idle respawn loop must end by itself, and /clear must be sent every cycle.
 *
 * Overnight a loop with nothing to do ran for 12 hours: nothing counted cycles or
 * noticed the workspace never changed. Separately, /clear was skipped on a "3.2k
 * tokens" figure that is Claude's per-turn counter, not the context size.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RespawnController } from '../src/respawn-controller.js';
import { Session } from '../src/session.js';
import { MockSession } from './mocks/index.js';

type Internals = {
  _state: string;
  completeCycle(): void;
  checkUpdateComplete(): void;
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' });

async function waitFor(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}

describe('respawn cycle budget', () => {
  let dir: string;
  let session: MockSession;
  let controller: RespawnController;

  const make = (extra: Record<string, unknown> = {}) => {
    controller = new RespawnController(session as unknown as Session, {
      idleTimeoutMs: 100,
      interStepDelayMs: 10,
      completionConfirmMs: 10,
      noOutputTimeoutMs: 60000,
      aiIdleCheckEnabled: false,
      ...extra,
    });
    controller.start();
    return controller as unknown as Internals;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'respawn-budget-'));
    git(dir, 'init', '-q');
    writeFileSync(join(dir, 'a.txt'), 'one');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    session = new MockSession();
    session.workingDir = dir;
  });

  afterEach(() => {
    controller.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stops after N consecutive cycles that left the workspace unchanged, and says why', async () => {
    const c = make({ maxUnchangedCycles: 3 });
    const reasons: string[] = [];
    controller.on('budgetExhausted', (r: { reason: string }) => reasons.push(r.reason));

    for (let i = 0; i < 2; i++) {
      c.completeCycle();
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(controller.state).not.toBe('stopped');

    c.completeCycle();
    await waitFor(() => controller.state === 'stopped');

    expect(controller.state).toBe('stopped');
    expect(reasons).toEqual(['unchanged_workspace']);
  });

  it('keeps going while each cycle changes the workspace', async () => {
    const c = make({ maxUnchangedCycles: 2 });
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(dir, 'a.txt'), `edit ${i}`);
      c.completeCycle();
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(controller.state).not.toBe('stopped');
  });

  it('stops after maxCycles when set, regardless of changes', async () => {
    const c = make({ maxCycles: 2, maxUnchangedCycles: 0 });
    (controller as unknown as { cycleCount: number }).cycleCount = 2;
    c.completeCycle();
    await waitFor(() => controller.state === 'stopped');
    expect(controller.state).toBe('stopped');
  });

  it('never stops on unchanged cycles when the check is disabled (0)', async () => {
    const c = make({ maxUnchangedCycles: 0 });
    for (let i = 0; i < 4; i++) {
      c.completeCycle();
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(controller.state).not.toBe('stopped');
  });

  it('does not stop a non-git working directory on unchanged cycles', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'respawn-budget-plain-'));
    try {
      session.workingDir = plain;
      const c = make({ maxUnchangedCycles: 2 });
      for (let i = 0; i < 4; i++) {
        c.completeCycle();
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(controller.state).not.toBe('stopped');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('sends /clear every cycle even after "3.2k tokens" shows on screen', async () => {
    const c = make({ sendClear: true, sendInit: false, maxUnchangedCycles: 0 });
    const write = vi.spyOn(session, 'writeViaMux');

    for (let i = 0; i < 2; i++) {
      session.simulateTerminalOutput('Worked for 1m | 3.2k tokens');
      write.mockClear();
      c._state = 'waiting_update';
      c.checkUpdateComplete();
      await waitFor(() => write.mock.calls.some(([d]) => String(d).startsWith('/clear')));
      expect(write.mock.calls.some(([d]) => String(d).startsWith('/clear'))).toBe(true);
    }
  });
});
