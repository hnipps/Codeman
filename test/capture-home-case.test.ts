/**
 * @fileoverview Ambient capture, ticket 4: Codeman's own case (src/capture-home-case.ts) and its route,
 * `GET /api/capture/home-case` (src/web/routes/capture-routes.ts). Git and the path probe are injected,
 * so no repository is touched.
 */
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHomeCaseCache, findHomeCase, HOME_CASE_CACHE_MS, type HomeCaseDeps } from '../src/capture-home-case.js';
import { registerCaptureRoutes } from '../src/web/routes/capture-routes.js';

const SHA = 'a'.repeat(40);

/** A fake world: case folders, which hold the build commit, and which are worktrees. */
function world(opts: {
  cases: Array<{ name: string; holds?: boolean; worktree?: boolean; top?: string }>;
  buildId?: string;
  installTop?: string;
  foreign?: string[];
  docker?: string[];
}): HomeCaseDeps & { gitCalls: string[][] } {
  const gitCalls: string[][] = [];
  const byPath = new Map(opts.cases.map((c) => [`/cases/${c.name}`, c]));
  return {
    gitCalls,
    cases: async () => opts.cases.map((c) => ({ name: c.name, path: `/cases/${c.name}` })),
    foreignNames: async () => opts.foreign ?? [],
    dockerWorkspaces: async () => opts.docker ?? [],
    buildId: opts.buildId,
    installDir: '/install/dist/web',
    probe: async (path) => {
      if (path.endsWith('/.git')) return byPath.get(path.slice(0, -5))?.worktree ? 'file' : 'directory';
      return byPath.has(path) ? 'directory' : 'absent';
    },
    git: async (cwd, args) => {
      gitCalls.push([cwd, ...args]);
      if (args[0] === 'cat-file') {
        if (byPath.get(cwd)?.holds) return '';
        throw new Error('missing');
      }
      if (cwd === '/install/dist/web') {
        if (!opts.installTop) throw new Error('not a repository');
        return `${opts.installTop}\n`;
      }
      return `${byPath.get(cwd)?.top ?? cwd}\n`;
    },
  };
}

describe('findHomeCase', () => {
  it('answers the first case by name whose main checkout holds the build commit', async () => {
    const deps = world({
      buildId: SHA,
      cases: [{ name: 'zeta', holds: true }, { name: 'alpha' }, { name: 'mid', holds: true }],
    });
    expect(await findHomeCase(deps)).toBe('mid');
    expect(deps.gitCalls.every((c) => c[1] === 'cat-file')).toBe(true);
  });

  it('skips a linked worktree, a Docker workspace and a name the remote or Docker registry holds', async () => {
    expect(
      await findHomeCase(
        world({
          buildId: SHA,
          cases: [
            { name: 'a-tree', holds: true, worktree: true },
            { name: 'b-docker', holds: true },
            { name: 'c-remote', holds: true },
            { name: 'd-home', holds: true },
          ],
          docker: ['/cases/b-docker'],
          foreign: ['c-remote'],
        })
      )
    ).toBe('d-home');
  });

  it('answers null when no case holds the commit', async () => {
    expect(await findHomeCase(world({ buildId: SHA, cases: [{ name: 'a' }] }))).toBeNull();
  });

  it('without a build id, answers the case that is the install directory`s git top level', async () => {
    const deps = world({ installTop: '/cases/codeman', cases: [{ name: 'other' }, { name: 'codeman' }] });
    expect(await findHomeCase(deps)).toBe('codeman');
    expect(await findHomeCase({ ...deps, buildId: 'v1.47.0' })).toBe('codeman');
    expect(await findHomeCase(world({ cases: [{ name: 'codeman' }] }))).toBeNull();
  });

  it('never probes git in a folder the bounded probe could not read', async () => {
    const deps = world({ buildId: SHA, cases: [{ name: 'stalled', holds: true }] });
    deps.probe = async () => 'unknown';
    expect(await findHomeCase(deps)).toBeNull();
    expect(deps.gitCalls).toEqual([]);
  });
});

describe('the home-case cache', () => {
  it('keeps an answer, found or not, for ten minutes', async () => {
    let t = 0;
    const find = vi.fn(async () => (t < HOME_CASE_CACHE_MS ? null : 'codeman'));
    const cache = createHomeCaseCache(find, () => t);
    expect(await cache.get()).toBeNull();
    t = HOME_CASE_CACHE_MS - 1;
    expect(await cache.get()).toBeNull();
    expect(find).toHaveBeenCalledTimes(1);
    t = HOME_CASE_CACHE_MS;
    expect(await cache.get()).toBe('codeman');
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('shares one lookup between callers that ask together', async () => {
    const find = vi.fn(async () => 'codeman');
    const cache = createHomeCaseCache(find);
    expect(await Promise.all([cache.get(), cache.get()])).toEqual(['codeman', 'codeman']);
    expect(find).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/capture/home-case', () => {
  afterEach(() => vi.unstubAllEnvs());

  async function harness(role: 'user' | 'admin', deps: Partial<HomeCaseDeps>) {
    const app = Fastify();
    app.addHook('onRequest', async (req) => {
      req.authUser = { username: role === 'admin' ? 'boss' : 'someone', role };
    });
    registerCaptureRoutes(app, deps);
    await app.ready();
    return app;
  }

  it('answers the case name', async () => {
    const app = await harness('admin', world({ buildId: SHA, cases: [{ name: 'codeman', holds: true }] }));
    const r = await app.inject({ method: 'GET', url: '/api/capture/home-case' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ success: true, data: { caseName: 'codeman' } });
  });

  it('answers 404 NO_HOME_CASE when no case qualifies', async () => {
    const app = await harness('admin', world({ buildId: SHA, cases: [] }));
    const r = await app.inject({ method: 'GET', url: '/api/capture/home-case' });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ success: false, errorCode: 'NOT_FOUND', reason: 'NO_HOME_CASE' });
  });

  // Invariant I7: TheWorkspaceIsTheOneOnScreen (the home case is admin-only in multi-user mode)
  it('refuses a non-admin in multi-user mode before any lookup, and answers an admin', async () => {
    vi.stubEnv('CODEMAN_MULTIUSER', '1');
    const deps = world({ buildId: SHA, cases: [{ name: 'codeman', holds: true }] });
    const user = await harness('user', deps);
    const refused = await user.inject({ method: 'GET', url: '/api/capture/home-case' });
    expect(refused.statusCode).toBe(403);
    expect(deps.gitCalls).toEqual([]);
    const admin = await harness('admin', deps);
    expect((await admin.inject({ method: 'GET', url: '/api/capture/home-case' })).statusCode).toBe(200);
  });
});
