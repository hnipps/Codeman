/**
 * W-130: a codex or antigravity worker started without a config (an agent's
 * `codeman agent spawn`, MCP `start_session`, a bare POST) takes its approvals bypass
 * from the synced App Settings, through `capabilities.launchDefaults`. The bypass is
 * filled BEFORE the multi-user clamp, so a non-granted owner still launches without it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { registerSystemRoutes } from '../../src/web/routes/system-routes.js';
import { CASES_DIR, SETTINGS_PATH } from '../../src/web/route-helpers.js';
import { applyLaunchDefaults } from '../../src/web/launch-defaults.js';
import { buildCodexCommand } from '../../src/tmux-manager.js';
import { Session } from '../../src/session.js';
import { safeRmHomeTree } from '../mocks/index.js';
import { createUser, invalidateUsersCache } from '../../src/user-store.js';
import { userCasesDir } from '../../src/config/multiuser.js';
import type { AntigravityConfig, CodexConfig } from '../../src/types.js';

vi.mock('../../src/utils/cli-launcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/cli-launcher.js')>();
  return { ...actual, resolveCliLaunchError: vi.fn().mockResolvedValue(null) };
});

const writeSettings = async (settings: Record<string, unknown>) => {
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(settings));
};

describe('applyLaunchDefaults with boolean settings', () => {
  const codex = async (config: CodexConfig | undefined) =>
    (await applyLaunchDefaults('codex', { codexConfig: config })).codexConfig;
  const agy = async (config: AntigravityConfig | undefined) =>
    (await applyLaunchDefaults('antigravity', { antigravityConfig: config })).antigravityConfig;

  it('fills nothing while the setting is unset or false', async () => {
    for (const settings of [{}, { codexDangerouslyBypassApprovals: false, antigravitySkipPermissions: false }]) {
      await writeSettings(settings);
      expect(await codex(undefined)).toBeUndefined();
      expect(await agy(undefined)).toBeUndefined();
      expect(await codex({ animations: false })).toEqual({ animations: false });
    }
  });

  it('fills the bypass when the setting is true', async () => {
    await writeSettings({ codexDangerouslyBypassApprovals: true, antigravitySkipPermissions: true });
    expect(await codex(undefined)).toEqual({ dangerouslyBypassApprovals: true });
    expect(await codex({ animations: false })).toEqual({ animations: false, dangerouslyBypassApprovals: true });
    expect(await agy(undefined)).toEqual({ dangerouslySkipPermissions: true });
    expect(buildCodexCommand(await codex(undefined))).toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('never overrides a value the caller sent', async () => {
    await writeSettings({ codexDangerouslyBypassApprovals: true, antigravitySkipPermissions: true });
    expect(await codex({ dangerouslyBypassApprovals: false })).toEqual({ dangerouslyBypassApprovals: false });
    expect(await agy({ dangerouslySkipPermissions: false })).toEqual({ dangerouslySkipPermissions: false });
    await writeSettings({ codexDangerouslyBypassApprovals: false, antigravitySkipPermissions: false });
    expect(await codex({ dangerouslyBypassApprovals: true })).toEqual({ dangerouslyBypassApprovals: true });
    expect(await agy({ dangerouslySkipPermissions: true })).toEqual({ dangerouslySkipPermissions: true });
  });

  it('ignores a hand-edited non-boolean value', async () => {
    await writeSettings({ codexDangerouslyBypassApprovals: 'yes', antigravitySkipPermissions: 1 });
    expect(await codex(undefined)).toBeUndefined();
    expect(await agy(undefined)).toBeUndefined();
  });
});

type Mode = 'codex' | 'antigravity';
const bypassOf = (session: Session, mode: Mode): boolean | undefined =>
  mode === 'codex'
    ? session.codexConfig?.dangerouslyBypassApprovals
    : (session as unknown as { _antigravityConfig?: AntigravityConfig })._antigravityConfig?.dangerouslySkipPermissions;

describe('agent-started workers through the routes', () => {
  let harness: RouteTestHarness | undefined;
  const workingDir = join(homedir(), 'agent-bypass-test');

  beforeEach(async () => {
    await mkdir(workingDir, { recursive: true });
    vi.spyOn(Session.prototype, 'startInteractive').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await harness?.app.close();
    harness = undefined;
    safeRmHomeTree(CASES_DIR);
    safeRmHomeTree(workingDir);
    vi.restoreAllMocks();
  });

  async function launch(url: string, mode: Mode, extra: Record<string, unknown> = {}): Promise<Session> {
    const payload =
      url === '/api/sessions' ? { workingDir, mode, ...extra } : { caseName: 'agent-bypass-test', mode, ...extra };
    const res = await harness!.app.inject({ method: 'POST', url, payload });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().success, res.body).not.toBe(false);
    return [...harness!.ctx.sessions.values()].at(-1) as Session;
  }

  for (const url of ['/api/sessions', '/api/quick-start']) {
    for (const mode of ['codex', 'antigravity'] as const) {
      it(`${mode} at ${url}: follows the setting when the caller sends no config`, async () => {
        harness = await createRouteTestHarness(registerSessionRoutes);
        await writeSettings({ codexDangerouslyBypassApprovals: true, antigravitySkipPermissions: true });
        expect(bypassOf(await launch(url, mode), mode)).toBe(true);
        await writeSettings({ codexDangerouslyBypassApprovals: false, antigravitySkipPermissions: false });
        expect(bypassOf(await launch(url, mode), mode)).toBeUndefined();
      });

      it(`${mode} at ${url}: an explicit false from the caller wins over the setting`, async () => {
        harness = await createRouteTestHarness(registerSessionRoutes);
        await writeSettings({ codexDangerouslyBypassApprovals: true, antigravitySkipPermissions: true });
        const config =
          mode === 'codex'
            ? { codexConfig: { dangerouslyBypassApprovals: false } }
            : { antigravityConfig: { dangerouslySkipPermissions: false } };
        expect(bypassOf(await launch(url, mode, config), mode)).toBe(false);
      });
    }
  }

  describe('multi-user mode', () => {
    const PASSWORD = 'bypass-default-password';
    let prev: string | undefined;

    beforeEach(async () => {
      prev = process.env.CODEMAN_MULTIUSER;
      process.env.CODEMAN_MULTIUSER = '1';
      invalidateUsersCache();
      for (const [username, role] of [
        ['boss', 'admin'],
        ['peon', 'user'],
      ] as const) {
        await createUser({ username, role, password: PASSWORD }).catch(() => undefined);
      }
      await writeSettings({ codexDangerouslyBypassApprovals: true, antigravitySkipPermissions: true });
    });

    afterEach(() => {
      if (prev === undefined) delete process.env.CODEMAN_MULTIUSER;
      else process.env.CODEMAN_MULTIUSER = prev;
      invalidateUsersCache();
      safeRmHomeTree(join(homedir(), 'codeman-users'));
    });

    for (const [url, mode] of [
      ['/api/quick-start', 'codex'],
      ['/api/quick-start', 'antigravity'],
      ['/api/sessions', 'codex'],
      ['/api/sessions', 'antigravity'],
    ] as const) {
      it(`${mode} at ${url}: the clamp still forces a filled bypass off for a non-granted owner`, async () => {
        harness = await createRouteTestHarness(registerSessionRoutes, { authUser: { username: 'peon', role: 'user' } });
        // A non-admin's workingDir must sit inside their own space.
        const ownDir = join(userCasesDir('peon'), 'agent-bypass-test');
        await mkdir(ownDir, { recursive: true });
        const extra = url === '/api/sessions' ? { workingDir: ownDir } : {};
        expect(bypassOf(await launch(url, mode, extra), mode)).toBe(false);
      });

      it(`${mode} at ${url}: an admin owner keeps the filled bypass`, async () => {
        harness = await createRouteTestHarness(registerSessionRoutes, {
          authUser: { username: 'boss', role: 'admin' },
        });
        expect(bypassOf(await launch(url, mode), mode)).toBe(true);
      });
    }

    it('only an admin can write the setting', async () => {
      const asUser = await createRouteTestHarness(registerSystemRoutes, {
        authUser: { username: 'peon', role: 'user' },
      });
      const asAdmin = await createRouteTestHarness(registerSystemRoutes, {
        authUser: { username: 'boss', role: 'admin' },
      });
      try {
        const put = (h: RouteTestHarness, value: boolean) =>
          h.app.inject({ method: 'PUT', url: '/api/settings', payload: { antigravitySkipPermissions: value } });
        expect((await put(asUser, false)).statusCode).toBe(403);
        expect((await put(asAdmin, false)).statusCode).toBe(200);
        const read = await asAdmin.app.inject({ method: 'GET', url: '/api/settings' });
        expect(read.json()).toMatchObject({ antigravitySkipPermissions: false });
      } finally {
        await asUser.app.close();
        await asAdmin.app.close();
      }
    });
  });

  it('the setting round-trips through PUT /api/settings and refuses a non-boolean', async () => {
    const system = await createRouteTestHarness(registerSystemRoutes);
    try {
      const put = (payload: unknown) => system.app.inject({ method: 'PUT', url: '/api/settings', payload });
      expect((await put({ antigravitySkipPermissions: true })).statusCode).toBe(200);
      const read = await system.app.inject({ method: 'GET', url: '/api/settings' });
      expect(read.json()).toMatchObject({ antigravitySkipPermissions: true });
      expect((await put({ antigravitySkipPermissions: 'yes' })).statusCode).toBe(400);
    } finally {
      await system.app.close();
    }
  });
});
