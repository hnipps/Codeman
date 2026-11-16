/**
 * @fileoverview Open live on the Reviews page: what the supervisor's `review` commands are sent, how their answers
 * are checked, and the route a page uses. The supervisor and the preview service are always fakes.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeployOverviewConfigured } from '../src/deploy-control.js';
import {
  createLiveControl,
  LiveError,
  liveView,
  parseLiveStatus,
  previewFor,
  type LiveControl,
  type LivePreview,
} from '../src/reviews/review-live.js';
import { registerReviewPageRoutes } from '../src/web/routes/review-routes.js';
import { createRouteTestHarness, type RouteTestHarness } from './routes/_route-test-utils.js';

const SHA_A = 'a'.repeat(40);
const preview = (over: Partial<LivePreview> = {}): LivePreview => ({
  id: '0123abcd',
  sha: SHA_A,
  hostname: 'pv-0123abcd.example.test',
  state: 'stopped',
  createdAt: '2026-11-16T10:00:00Z',
  ...over,
});

describe('what the supervisor lists', () => {
  it('keeps well-formed previews and drops the rest', () => {
    const list = parseLiveStatus({
      previews: [
        preview(),
        { ...preview(), id: '../../etc' },
        { ...preview(), id: 'ffff0000', hostname: 'evil.test/path' },
        { ...preview(), id: 'ffff0001', hostname: 'UPPER.test' },
        { ...preview(), id: 'ffff0002', state: 'exploded' },
        'text',
      ],
    });
    expect(list.map((p) => p.id)).toEqual(['0123abcd']);
  });

  it('refuses an answer that is not a list of previews', () => {
    expect(() => parseLiveStatus({ ok: true })).toThrow();
    expect(() => parseLiveStatus('previews')).toThrow();
  });

  it('picks the newest preview of a commit that is not destroyed, matching a short sha too', () => {
    const list = [
      preview({ id: '00000001', state: 'destroyed', createdAt: '2026-11-16T12:00:00Z' }),
      preview({ id: '00000002', state: 'build-failed', createdAt: '2026-11-16T10:00:00Z', error: 'npm failed' }),
      preview({ id: '00000003', sha: 'aaaaaaa', createdAt: '2026-11-16T11:00:00Z' }),
      preview({ id: '00000004', sha: 'b'.repeat(40) }),
    ];
    expect(previewFor(list, SHA_A)?.id).toBe('00000003');
    expect(previewFor(list, 'c'.repeat(40))).toBeNull();
  });

  it('tells the browser a state and an https address, never the id', () => {
    expect(liveView(null)).toEqual({ available: true, state: 'none' });
    const view = liveView(preview({ state: 'build-failed', error: 'npm failed' }));
    expect(view).toEqual({
      available: true,
      state: 'build-failed',
      url: 'https://pv-0123abcd.example.test/',
      error: 'npm failed',
    });
    expect(JSON.stringify(view)).not.toContain('"id"');
  });
});

describe('the supervisor commands', () => {
  const env = { CODEMAN_REVIEW_PREVIEWS: '1', CODEMAN_SUPERVISOR_CLI: '/fake/supervisor' };

  it('is off, and runs nothing, unless the supervisor says it has the commands', async () => {
    const run = vi.fn(async () => '{}');
    for (const off of [{}, { CODEMAN_SUPERVISOR_CLI: '/fake/supervisor' }, { CODEMAN_REVIEW_PREVIEWS: '1' }]) {
      const control = createLiveControl(off, run);
      expect(control.available()).toBe(false);
      await expect(control.status()).rejects.toBeInstanceOf(LiveError);
      await expect(control.create(SHA_A)).rejects.toBeInstanceOf(LiveError);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('sends each command as argv and reads the last line it prints', async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (_cli: string, args: string[]) => {
      calls.push(args);
      if (args[1] === 'create') return 'note\n{"ok":true,"id":"0123abcd","hostname":"pv-0123abcd.example.test"}\n';
      if (args[1] === 'status') return JSON.stringify({ previews: [preview()] });
      return '{"ok":true}';
    });
    const control = createLiveControl(env, run);
    expect(await control.create(SHA_A)).toEqual({ id: '0123abcd', hostname: 'pv-0123abcd.example.test' });
    await control.use('0123abcd');
    await control.release('0123abcd');
    await control.destroy('0123abcd');
    expect((await control.status())[0]?.id).toBe('0123abcd');
    expect(calls).toEqual([
      ['review', 'create', SHA_A],
      ['review', 'use', '0123abcd'],
      ['review', 'release', '0123abcd'],
      ['review', 'destroy', '0123abcd'],
      ['review', 'status'],
    ]);
  });

  it('refuses a bad sha or id before anything runs', async () => {
    const run = vi.fn(async () => '{}');
    const control = createLiveControl(env, run);
    await expect(control.create('main')).rejects.toBeInstanceOf(LiveError);
    await expect(control.create('--help')).rejects.toBeInstanceOf(LiveError);
    await expect(control.use('-x')).rejects.toBeInstanceOf(LiveError);
    await expect(control.destroy('0123abcd; rm')).rejects.toBeInstanceOf(LiveError);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a created preview whose hostname is not a plain name', async () => {
    const run = vi.fn(async () => '{"ok":true,"id":"0123abcd","hostname":"a.test/@evil"}');
    await expect(createLiveControl(env, run).create(SHA_A)).rejects.toThrow('unreadable');
  });

  it('reads the list once for calls close together, and again after a change', async () => {
    const run = vi.fn(async () => JSON.stringify({ previews: [] }));
    const control = createLiveControl(env, run);
    await Promise.all([control.status(), control.status()]);
    expect(run).toHaveBeenCalledTimes(1);
    await control.release('0123abcd');
    await control.status();
    expect(run).toHaveBeenCalledTimes(3);
  });
});

describe('the live route', () => {
  const dirs: string[] = [];
  let harness: RouteTestHarness;
  let head = '';
  let previews: LivePreview[];
  let control: LiveControl & { calls: string[] };
  const AGENT = { 'x-codeman-parent-session': 'test-session-1' };

  const fakeControl = (available = true): LiveControl & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      available: () => available,
      status: async () => previews,
      create: async (sha) => {
        calls.push(`create ${sha}`);
        previews = [
          ...previews,
          preview({
            id: '0000000a',
            hostname: 'pv-0000000a.example.test',
            sha,
            state: 'building',
            createdAt: Date.now(),
          }),
        ];
        return { id: '0000000a', hostname: 'pv-0000000a.example.test' };
      },
      use: async (id) => {
        calls.push(`use ${id}`);
        previews = previews.map((p) => (p.id === id ? { ...p, state: 'running' } : p));
      },
      release: async (id) => void calls.push(`release ${id}`),
      destroy: async (id) => {
        calls.push(`destroy ${id}`);
        previews = previews.map((p) => (p.id === id ? { ...p, state: 'destroyed' } : p));
      },
    };
  };

  /** Starts the routes over a repository that is, or is not, the one the fake supervisor says is live. */
  const start = async ({ own = true, available = true } = {}) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'review-live-')));
    dirs.push(dir);
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-q', '-b', 'feat/x');
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    git('commit', '-q', '-am', 'work');
    head = git('rev-parse', 'HEAD');
    const overview: DeployOverviewConfigured = {
      configured: true,
      live: { sha: own ? base : 'f'.repeat(40), since: 't' },
      releases: [],
      recent: [],
      busy: false,
    };
    control = fakeControl(available);
    harness = await createRouteTestHarness((app, ctx) =>
      registerReviewPageRoutes(app, ctx, {
        dockerWorkspaces: async () => [],
        deploy: {
          cli: () => '/fake/supervisor',
          readOverview: async () => overview,
          requestDeploy: async () => ({ requestId: 'r' }),
        },
        live: control,
      })
    );
    harness.ctx.sessions.get('test-session-1')!.workingDir = dir;
    const made = await harness.app.inject({
      method: 'POST',
      url: '/api/reviews',
      headers: AGENT,
      payload: { title: 'Work', walkthrough: 'Done' },
    });
    return made.json().data.id as string;
  };
  const say = (id: string, action: string, headers: Record<string, string> = {}) =>
    harness.app.inject({ method: 'POST', url: `/api/reviews/${id}/live`, headers, payload: { action } });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  beforeEach(() => {
    previews = [];
  });
  afterEach(async () => {
    await harness?.app.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('builds a preview of the submitted commit for a branch of Codeman itself', async () => {
    const id = await start();
    await settle();
    expect(control.calls).toEqual([`create ${head}`]);
    const live = (await harness.app.inject({ url: `/api/reviews/${id}` })).json().data.live;
    expect(live).toEqual({ available: true, state: 'building', url: 'https://pv-0000000a.example.test/', error: null });
  });

  it('has no live preview for another project, or without the service', async () => {
    let id = await start({ own: false });
    await settle();
    expect(control.calls).toEqual([]);
    expect((await harness.app.inject({ url: `/api/reviews/${id}` })).json().data.live).toEqual({ available: false });
    expect((await say(id, 'open')).statusCode).toBe(409);
    await harness.app.close();

    id = await start({ available: false });
    await settle();
    expect(control.calls).toEqual([]);
    expect((await harness.app.inject({ url: `/api/reviews/${id}` })).json().data.live).toEqual({ available: false });
  });

  it('wakes on open, lets go on close, and refuses an agent', async () => {
    const id = await start();
    await settle();
    expect((await say(id, 'open')).statusCode).toBe(409);
    previews = previews.map((p) => ({ ...p, state: 'stopped' as const }));
    control.calls.length = 0;

    expect((await say(id, 'open', AGENT)).statusCode).toBe(403);
    const opened = await say(id, 'open');
    expect(opened.json().data.live.state).toBe('running');
    expect((await say(id, 'close')).statusCode).toBe(200);
    expect(control.calls).toEqual(['use 0000000a', 'release 0000000a']);
    expect((await say(id, 'restart')).statusCode).toBe(400);
  });

  it('builds again only after a failed build, replacing the failed preview', async () => {
    const id = await start();
    await settle();
    control.calls.length = 0;
    expect((await say(id, 'build')).json().data.live.state).toBe('building');
    expect(control.calls).toEqual([]);

    previews = previews.map((p) => ({ ...p, state: 'build-failed' as const, error: 'npm failed' }));
    expect((await say(id, 'build')).json().data.live.state).toBe('building');
    expect(control.calls).toEqual(['destroy 0000000a', `create ${head}`]);
  });

  it('says so when the service refuses', async () => {
    const id = await start();
    await settle();
    previews = previews.map((p) => ({ ...p, state: 'stopped' as const }));
    control.use = async () => {
      throw new LiveError('The preview service refused', 1);
    };
    const res = await say(id, 'open');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('The preview service refused');
  });
});
