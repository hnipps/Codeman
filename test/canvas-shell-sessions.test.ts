/**
 * The canvas shell's Sessions section (PC13): the pure state and order rules, their parity with the dashboard's
 * `CodemanSessionOrder`, and `GET /api/canvas/:workspaceId/sessions` through the real routes with stand-in sessions.
 */
import Fastify from 'fastify';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_STATE_RANK,
  compareSessions,
  deriveSessionState,
  needsYou,
  sessionAnchor,
  sortSessions,
  type ShellSessionRow,
} from '../src/canvas/shell-sessions.js';
import { registerCanvasRoutes } from '../src/web/routes/canvas-routes.js';
import { insideFolder } from '../src/web/routes/canvas-shell-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { resolveCasesDir } from '../src/web/route-helpers.js';
import { CanvasStores } from '../src/canvas/canvas-store.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';
import { addConversation, conversationsPath } from '../src/canvas/conversations.js';
import { approvalInbox } from '../src/web/approval-inbox.js';
import { probePathKind } from '../src/utils/bounded-path-probe.js';
import { dataPath } from '../src/config/instance.js';
import { safeRmHomeTree } from './mocks/test-helpers.js';

vi.mock('../src/utils/bounded-path-probe.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/utils/bounded-path-probe.js')>();
  return { ...real, probePathKind: vi.fn(real.probePathKind) };
});

type Row = { id: string; state: string; lastActivityAt?: number; lastSubmitAt?: number; orderIndex?: number };
function dashboardOrder() {
  const context = vm.createContext({ window: {}, globalThis: {} });
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'constants.js' });
  return (
    context.window as {
      CodemanSessionOrder: {
        RANK: Record<string, number>;
        anchor: (row: Row) => number;
        compare: (a: Row, b: Row) => number;
        sort: (rows: Row[]) => Row[];
      };
    }
  ).CodemanSessionOrder;
}

describe('session state', () => {
  it('names one state per session, most urgent first', () => {
    const base = { approval: 'none', status: 'idle', exited: false, busy: false } as const;
    expect(deriveSessionState(base)).toBe('idle');
    expect(deriveSessionState({ ...base, busy: true })).toBe('working');
    expect(deriveSessionState({ ...base, approval: 'idle', busy: true })).toBe('waiting');
    expect(deriveSessionState({ ...base, approval: 'blocking', busy: true })).toBe('needs');
    expect(deriveSessionState({ ...base, approval: 'blocking', status: 'error' })).toBe('error');
    expect(deriveSessionState({ ...base, status: 'stopped' })).toBe('done');
  });
  it('reads an exited agent as ended whatever else is recorded', () => {
    expect(deriveSessionState({ approval: 'blocking', status: 'busy', exited: true, busy: true })).toBe('done');
  });
  it('counts only the sessions that wait on a person', () => {
    expect(needsYou([{ state: 'needs' }, { state: 'waiting' }, { state: 'needs' }, { state: 'error' }])).toBe(2);
  });
});

describe('session order: parity with the dashboard', () => {
  const dashboard = dashboardOrder();
  it('ranks the six states as the dashboard does', () => {
    expect({ ...SESSION_STATE_RANK }).toEqual({ ...dashboard.RANK });
  });
  it('orders every pair of a mixed set the same way', () => {
    const states = Object.keys(dashboard.RANK).concat('unheard-of');
    const rows: Row[] = [];
    let n = 0;
    for (const state of states)
      for (const lastActivityAt of [0, 1000, 5000])
        for (const lastSubmitAt of [0, 2000, 9000])
          rows.push({ id: `r${n}`, state, lastActivityAt, lastSubmitAt, orderIndex: n++ });
    for (const a of rows)
      for (const b of rows) {
        expect(Math.sign(compareSessions(a, b)), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(
          Math.sign(dashboard.compare(a, b))
        );
        expect(sessionAnchor(a)).toBe(dashboard.anchor(a));
      }
  });
  it('sorts a shuffled list into the dashboard order, without sorting in place', () => {
    const rows: Row[] = [
      { id: 'quiet-old', state: 'idle', lastActivityAt: 100 },
      { id: 'run-long', state: 'working', lastActivityAt: 9000, lastSubmitAt: 200 },
      { id: 'blocked-new', state: 'needs', lastActivityAt: 800 },
      { id: 'quiet-new', state: 'idle', lastActivityAt: 900 },
      { id: 'ended', state: 'done', lastActivityAt: 950 },
      { id: 'run-short', state: 'working', lastActivityAt: 9000, lastSubmitAt: 700 },
      { id: 'blocked-old', state: 'needs', lastActivityAt: 300 },
      { id: 'failed', state: 'error', lastActivityAt: 10 },
      { id: 'asked', state: 'waiting', lastActivityAt: 500 },
      { id: 'no-stamp', state: 'idle' },
    ];
    const before = rows.map((r) => r.id);
    const mine = sortSessions(rows).map((r) => r.id);
    expect(rows.map((r) => r.id)).toEqual(before);
    expect(mine).toEqual(dashboard.sort(rows.map((r, orderIndex) => ({ ...r, orderIndex }))).map((r) => r.id));
    expect(mine).toEqual([
      'blocked-old',
      'blocked-new',
      'failed',
      'asked',
      'run-long',
      'run-short',
      'quiet-new',
      'quiet-old',
      'no-stamp',
      'ended',
    ]);
  });
});

describe('folder containment', () => {
  it('takes the folder and anything below it, and nothing beside it', () => {
    expect(insideFolder('/a/case', '/a/case')).toBe(true);
    expect(insideFolder('/a/case', '/a/case/.claude/worktrees/t1')).toBe(true);
    expect(insideFolder('/a/case', '/a/case-two')).toBe(false);
    expect(insideFolder('/a/case', '/a')).toBe(false);
    expect(insideFolder('/a/case', '/a/case/../other')).toBe(false);
  });
});

describe('GET /api/canvas/:workspaceId/sessions', () => {
  const cases: string[] = [];
  afterEach(() => {
    vi.mocked(probePathKind).mockClear();
    for (const id of ['s-term', 's-conv', 's-task', 's-out', 's-other'])
      approvalInbox.resolveForSession(id, 'answered');
    for (const path of cases.splice(0)) safeRmHomeTree(path);
  });
  async function harness(
    options: { enabled?: boolean; user?: { username: string; role: 'admin' | 'user' }; owner?: string } = {}
  ) {
    const caseName = `shell-case-${crypto.randomUUID().slice(0, 8)}`;
    const casePath = join(resolveCasesDir(options.user), caseName);
    mkdirSync(join(casePath, 'sub'), { recursive: true });
    cases.push(casePath);
    const app = Fastify();
    app.addHook('onRequest', async (req) => {
      req.authUser = options.user ?? { username: 'admin', role: 'admin' };
    });
    const sessions = new Map<string, Record<string, unknown>>();
    const stores = new CanvasStores();
    const port = {
      sessions,
      canvasEnabled: async () => options.enabled !== false,
      canvasStores: async () => stores,
      broadcast: vi.fn(),
    };
    registerCanvasRoutes(app, port as never);
    installRouteErrorHandler(app);
    await app.ready();
    const workspace = workspaceForCase(caseName, options.owner);
    const list = () => app.inject({ method: 'GET', url: `/api/canvas/${workspace.id}/sessions` });
    return { app, sessions, workspace, casePath, caseName, list };
  }
  const rowsOf = (response: { json(): { data: { sessions: ShellSessionRow[] } } }) => response.json().data.sessions;

  it('lists exactly the sessions whose folder is the case folder or below it, one row each', async () => {
    const h = await harness();
    h.sessions.set('s-term', { id: 's-term', name: 'w1-shell', mode: 'shell', workingDir: h.casePath, status: 'idle' });
    h.sessions.set('s-conv', { id: 's-conv', name: 'Chat', mode: 'claude', workingDir: join(h.casePath, 'sub') });
    h.sessions.set('s-out', { id: 's-out', name: 'elsewhere', workingDir: `${h.casePath}-sibling`, status: 'idle' });
    const response = await h.list();
    expect(response.statusCode).toBe(200);
    expect(
      rowsOf(response)
        .map((r) => r.id)
        .sort()
    ).toEqual(['s-conv', 's-term']);
    expect(rowsOf(response).find((r) => r.id === 's-term')).toMatchObject({
      name: 'w1-shell',
      mode: 'shell',
      kind: 'terminal',
      state: 'idle',
    });
  });

  it('names the kind from the conversation index and the state from the session and the inbox', async () => {
    const h = await harness();
    const now = Date.now();
    h.sessions.set('s-term', {
      id: 's-term',
      name: 'term',
      workingDir: h.casePath,
      status: 'busy',
      lastActivityAt: now,
      lastSubmitAt: now - 500,
    });
    h.sessions.set('s-conv', {
      id: 's-conv',
      name: 'conv',
      workingDir: h.casePath,
      status: 'idle',
      lastActivityAt: now - 100,
    });
    h.sessions.set('s-task', {
      id: 's-task',
      name: 'task',
      workingDir: h.casePath,
      status: 'idle',
      paneExit: { status: 0 },
      lastActivityAt: now - 50,
    });
    const made = (sessionId: string, extra: Record<string, unknown> = {}) =>
      addConversation(
        h.workspace.id,
        () =>
          ({
            id: crypto.randomUUID(),
            sessionId,
            cliId: 'claude',
            createdAt: now,
            createdBy: 'admin',
            ...extra,
          }) as never,
        crypto.randomUUID()
      );
    expect(made('s-conv').ok).toBe(true);
    expect(
      made('s-task', {
        task: {
          name: 'Tidy',
          requestId: crypto.randomUUID(),
          messageId: crypto.randomUUID(),
          isolation: { kind: 'shared' },
        },
      }).ok
    ).toBe(true);
    approvalInbox.notePrompt({ sessionId: 's-conv', sessionName: 'conv', kind: 'permission' });
    const rows = rowsOf(await h.list());
    expect(rows.map((r) => [r.id, r.kind, r.state])).toEqual([
      ['s-conv', 'conversation', 'needs'],
      ['s-term', 'terminal', 'working'],
      ['s-task', 'task', 'done'],
    ]);
    expect(rows[0]!.conversationId).toBeTruthy();
    expect(rows[1]!.since).toBe(now - 500);
    // The workspace list carries the counts.
    const listed = (await h.app.inject({ method: 'GET', url: '/api/canvas/workspaces' })).json().data.workspaces as {
      id: string;
      sessions: { live: number; needsYou: number };
    }[];
    expect(listed.find((w) => w.id === h.workspace.id)?.sessions).toEqual({ live: 2, needsYou: 1 });
  });

  it('reads an idle prompt as waiting until somebody has looked at it', async () => {
    const h = await harness();
    h.sessions.set('s-term', { id: 's-term', name: 'term', workingDir: h.casePath, status: 'idle' });
    approvalInbox.notePrompt({ sessionId: 's-term', sessionName: 'term', kind: 'idle' });
    expect(rowsOf(await h.list())[0]!.state).toBe('waiting');
    approvalInbox.acknowledge('s-term');
    expect(rowsOf(await h.list())[0]!.state).toBe('idle');
  });

  it('leaves every row a terminal when the conversation index cannot be read', async () => {
    const h = await harness();
    h.sessions.set('s-term', { id: 's-term', name: 'term', workingDir: h.casePath });
    mkdirSync(dataPath('canvas', h.workspace.id), { recursive: true });
    writeFileSync(conversationsPath(h.workspace.id), '{ not json');
    expect(rowsOf(await h.list()).map((r) => r.kind)).toEqual(['terminal']);
  });

  it("in multi-user mode lists only the caller's own sessions and hides another owner's workspace", async () => {
    const spaces = mkdtempSync(join(tmpdir(), 'shell-sessions-spaces-'));
    vi.stubEnv('CODEMAN_USER_SPACES_DIR', spaces);
    vi.stubEnv('CODEMAN_MULTIUSER', '1');
    try {
      const joe = { username: 'joe', role: 'user' as const };
      const h = await harness({ user: joe, owner: 'joe' });
      h.sessions.set('s-term', { id: 's-term', name: 'mine', workingDir: h.casePath, owner: 'joe' });
      h.sessions.set('s-other', { id: 's-other', name: 'theirs', workingDir: h.casePath, owner: 'amy' });
      expect(rowsOf(await h.list()).map((r) => r.id)).toEqual(['s-term']);
      const amy = await harness({ user: { username: 'amy', role: 'user' }, owner: 'amy' });
      const peek = await amy.app.inject({ method: 'GET', url: `/api/canvas/${h.workspace.id}/sessions` });
      expect(peek.statusCode).toBe(404);
      expect((await amy.app.inject({ method: 'GET', url: '/api/canvas/not-a-workspace/sessions' })).statusCode).toBe(
        404
      );
    } finally {
      vi.unstubAllEnvs();
      rmSync(spaces, { recursive: true, force: true });
    }
  });

  it('answers 404 while the canvas is off', async () => {
    const h = await harness({ enabled: false });
    expect((await h.list()).statusCode).toBe(404);
  });

  it('answers 503 with the reason when the case folder cannot be read in time, and lists nothing', async () => {
    const h = await harness();
    h.sessions.set('s-term', { id: 's-term', name: 'term', workingDir: h.casePath });
    vi.mocked(probePathKind).mockResolvedValueOnce('unknown');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await h.list();
    expect(response.statusCode).toBe(503);
    expect(logged.mock.calls.map(String).join()).toContain('GET /api/canvas/:workspaceId/sessions failed 503');
    logged.mockRestore();
    expect(response.json().success).toBe(false);
    expect(response.json().error).toContain('Case folder');
    expect(response.body).not.toContain(h.casePath);
    expect(response.json().requestId).toBeTruthy();
    expect(response.json().data).toBeUndefined();
    // The page asks by itself, so the probe keeps the stall cap: `pastCap` is for a folder a person named.
    expect(vi.mocked(probePathKind).mock.lastCall).toEqual([h.casePath]);
  });

  it('logs a stalled case folder once, and once more when it answers again, however often the page asks', async () => {
    const h = await harness();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const infos = vi.spyOn(console, 'log').mockImplementation(() => {});
    const count = (spy: typeof errors, text: string) =>
      spy.mock.calls.filter((c) => String(c[0]).includes(text)).length;
    try {
      await h.list();
      vi.mocked(probePathKind).mockResolvedValue('unknown');
      for (let i = 0; i < 5; i++) {
        const response = await h.list();
        expect(response.statusCode).toBe(503);
        expect(response.json().requestId).toBeTruthy();
      }
      expect(count(errors, 'sessions failed 503')).toBe(1);
      expect(count(infos, 'recovered')).toBe(0);

      vi.mocked(probePathKind).mockResolvedValue('directory');
      for (let i = 0; i < 3; i++) expect((await h.list()).statusCode).toBe(200);
      expect(count(infos, 'GET /api/canvas/:workspaceId/sessions recovered')).toBe(1);
      expect(String(infos.mock.calls.find((c) => String(c[0]).includes('recovered'))?.[0])).not.toContain(h.casePath);

      vi.mocked(probePathKind).mockResolvedValue('unknown');
      await h.list();
      await h.list();
      expect(count(errors, 'sessions failed 503')).toBe(2);
    } finally {
      vi.mocked(probePathKind).mockReset();
      errors.mockRestore();
      infos.mockRestore();
    }
  });

  it('leaves out a remote session whose path on the other machine sits under the local case folder', async () => {
    const h = await harness();
    h.sessions.set('s-local', { id: 's-local', name: 'local', workingDir: h.casePath });
    h.sessions.set('s-remote', {
      id: 's-remote',
      name: 'remote',
      workingDir: join(h.casePath, 'sub'),
      remote: { hostId: 'h1', tmuxSession: 't', owned: true },
    });
    // A Docker case shares the real folder with the host, so its sessions belong to the workspace.
    h.sessions.set('s-docker', { id: 's-docker', name: 'docker', workingDir: h.casePath, docker: { caseName: 'c' } });
    expect(
      rowsOf(await h.list())
        .map((r) => r.id)
        .sort()
    ).toEqual(['s-docker', 's-local']);
    const listed = (await h.app.inject({ method: 'GET', url: '/api/canvas/workspaces' })).json().data.workspaces as {
      id: string;
      sessions: { live: number };
    }[];
    expect(listed.find((w) => w.id === h.workspace.id)?.sessions.live).toBe(2);
  });

  it('writes nothing: no operation, no conversation and no session input', async () => {
    const h = await harness();
    const write = vi.fn(async () => true);
    h.sessions.set('s-term', { id: 's-term', name: 'term', workingDir: h.casePath, writeViaMux: write });
    await h.list();
    await h.app.inject({ method: 'GET', url: '/api/canvas/workspaces' });
    expect(write).not.toHaveBeenCalled();
    const ops = (await h.app.inject({ method: 'GET', url: `/api/canvas/${h.workspace.id}/ops?since=0` })).json();
    expect(ops.data?.operations ?? ops.data?.records ?? []).toEqual([]);
  });
});
