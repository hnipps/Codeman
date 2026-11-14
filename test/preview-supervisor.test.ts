import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  PreviewAbandonedError,
  PreviewLimitError,
  PreviewRefusedError,
  PreviewSupervisor,
  nextPreviewState,
  parsePreviewRecords,
  planReconcile,
  substitutePort,
} from '../src/preview-supervisor.js';
import {
  findListenerPids,
  parseListenInodes,
  parsePreviewMarker,
  parseProcStat,
  readProcSnapshot,
  readProcStat,
  type ProcEntry,
} from '../src/preview-proc.js';
import type { PreviewProcess } from '../src/types/preview.js';
import { PREVIEW_STRIPPED_ENV } from '../src/preview-env.js';

const NODE = process.execPath;
const SERVER = `${NODE} -e "require('http').createServer((q,s)=>s.end('ok '+process.env.PORT)).listen(Number(process.argv[1]))" {port}`;

let dataDir: string;
let workDir: string;

function markerPids(owner: string, previewId?: string): number[] {
  return [...readProcSnapshot().values()]
    .filter((e) => !e.zombie && e.previewOwner === owner && (previewId === undefined || e.previewId === previewId))
    .map((e) => e.pid);
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

function supervisor(extra: Partial<ConstructorParameters<typeof PreviewSupervisor>[0]> = {}) {
  return new PreviewSupervisor({ dataDir, stopGraceMs: 2000, readyTimeoutMs: 10_000, ...extra });
}

let nextId = 0;
const bindNew = async () => `wv-${++nextId}`;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-sup-data-'));
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-sup-work-'));
});

afterEach(async () => {
  for (const pid of markerPids(dataDir)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(workDir, { recursive: true, force: true });
});

describe('/proc parsing', () => {
  it('reads pgid and field 22 past a comm that contains spaces and parentheses', () => {
    const stat = '4242 (my (odd) cmd) S 1 4240 4240 0 -1 4194304 117 0 0 0 0 0 0 0 20 0 1 0 17147718 5971968 448';
    expect(parseProcStat(stat)).toEqual({ pid: 4242, pgid: 4240, startTicks: 17147718, zombie: false });
    expect(parseProcStat(stat.replace(' S ', ' Z '))?.zombie).toBe(true);
  });

  it('reads the preview marker from a NUL-separated environment', () => {
    const environ = 'PATH=/bin\0CODEMAN_PREVIEW_ID=abc\0CODEMAN_PREVIEW_OWNER=/data\0';
    expect(parsePreviewMarker(environ)).toEqual({ previewId: 'abc', previewOwner: '/data' });
    expect(parsePreviewMarker('PATH=/bin\0')).toEqual({ previewId: undefined, previewOwner: undefined });
  });

  it('finds listening inodes for a port in /proc/net/tcp text', () => {
    const text = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 111 1',
      '   1: 0100007F:1F90 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1001        0 222 1',
      '   2: 00000000:1F91 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 333 1',
    ].join('\n');
    expect(parseListenInodes(text, 8080)).toEqual(['111']);
  });

  it('skips malformed rows of previews.json', () => {
    const good = {
      webviewId: 'a',
      sessionId: 's',
      name: 'web',
      cmd: 'x',
      cwd: '/',
      port: 1,
      pid: 2,
      pgid: 2,
      startTicks: 3,
      logPath: '/l',
      state: 'running',
      lastViewedAt: 0,
    };
    expect(parsePreviewRecords(JSON.stringify([good, { ...good, state: 'odd' }, null, 4]))).toEqual([good]);
    expect(parsePreviewRecords('not json')).toEqual([]);
  });
});

describe('state transitions', () => {
  it('starts to running from any state, stops only a running preview on idle, marks it exited when gone', () => {
    for (const s of ['running', 'stopped', 'exited'] as const) expect(nextPreviewState(s, 'started')).toBe('running');
    expect(nextPreviewState('running', 'idle')).toBe('stopped');
    expect(nextPreviewState('running', 'gone')).toBe('exited');
    expect(nextPreviewState('stopped', 'gone')).toBe('stopped');
  });

  it('substitutes every {port}', () => {
    expect(substitutePort('serve --port {port} --hmr {port}', 4100)).toBe('serve --port 4100 --hmr 4100');
  });
});

describe('planReconcile', () => {
  const owner = '/data';
  const record = (over: Partial<PreviewProcess> = {}): PreviewProcess => ({
    webviewId: 'w1',
    sessionId: 's1',
    name: 'web',
    cmd: 'x',
    cwd: '/',
    port: 4000,
    pid: 100,
    pgid: 100,
    startTicks: 5000,
    logPath: '/l',
    state: 'running',
    lastViewedAt: 1_000,
    ...over,
  });
  const entry = (over: Partial<ProcEntry>): ProcEntry => ({
    pid: 100,
    pgid: 100,
    startTicks: 5000,
    zombie: false,
    ...over,
  });
  const snap = (...entries: ProcEntry[]) => new Map(entries.map((e) => [e.pid, e]));
  const base = { owner, now: 2_000, idleStopMs: 10_000, webviewIds: new Set(['w1']) };

  it('keeps a running preview whose leader matches and whose web tab exists', () => {
    const plan = planReconcile({ ...base, records: [record()], snapshot: snap(entry({})) });
    expect(plan.decisions).toEqual([{ webviewId: 'w1', kill: false, next: 'running' }]);
    expect(plan.orphanPids).toEqual([]);
  });

  it('treats a reused pid with different startTicks as gone and never kills it', () => {
    const plan = planReconcile({ ...base, records: [record()], snapshot: snap(entry({ startTicks: 9999 })) });
    expect(plan.decisions).toEqual([{ webviewId: 'w1', kill: false, next: 'exited' }]);
  });

  it('keeps a preview alive through a marker process after its leader exited', () => {
    const daemon = entry({ pid: 300, pgid: 300, startTicks: 7, previewId: 'w1', previewOwner: owner });
    const plan = planReconcile({ ...base, records: [record()], snapshot: snap(daemon) });
    expect(plan.decisions[0]).toEqual({ webviewId: 'w1', kill: false, next: 'running' });
  });

  it('stops and removes a live preview whose web tab is gone', () => {
    const plan = planReconcile({ ...base, webviewIds: new Set(), records: [record()], snapshot: snap(entry({})) });
    expect(plan.decisions).toEqual([{ webviewId: 'w1', kill: true, next: 'removed' }]);
  });

  it('stops a running preview not viewed for longer than the idle limit', () => {
    const plan = planReconcile({ ...base, now: 12_001, records: [record()], snapshot: snap(entry({})) });
    expect(plan.decisions).toEqual([{ webviewId: 'w1', kill: true, next: 'stopped' }]);
  });

  it("names marker processes of this owner without a record as orphans, and leaves another owner's alone", () => {
    const orphan = entry({ pid: 400, previewId: 'gone', previewOwner: owner });
    const foreign = entry({ pid: 401, previewId: 'gone', previewOwner: '/other' });
    const plan = planReconcile({ ...base, records: [], snapshot: snap(orphan, foreign) });
    expect(plan.orphanPids).toEqual([400]);
  });
});

describe('start and stop against real processes', () => {
  it('substitutes {port}, sets PORT and the marker, and writes the record before returning', async () => {
    const sup = supervisor();
    const { record, ready } = await sup.start({ sessionId: 's1', name: 'web', cmd: SERVER, cwd: workDir }, bindNew);
    expect(ready).toBe(true);
    const body = await (await fetch(`http://127.0.0.1:${record.port}/`)).text();
    expect(body).toBe(`ok ${record.port}`);
    expect(markerPids(dataDir, record.webviewId).length).toBeGreaterThan(0);
    const onDisk = JSON.parse(await fs.readFile(path.join(dataDir, 'previews.json'), 'utf-8'));
    expect(onDisk).toMatchObject([{ webviewId: record.webviewId, port: record.port, state: 'running', cwd: workDir }]);
    expect(onDisk[0].startTicks).toBe(readProcStat(record.pid)?.startTicks);
  });

  it("starts the server without the Codeman server's instance, deploy and credential variables", async () => {
    for (const name of PREVIEW_STRIPPED_ENV) vi.stubEnv(name, `leaked-${name}`);
    vi.stubEnv('CODEMAN_API_URL', 'https://127.0.0.1:1');
    try {
      const envFile = path.join(workDir, 'env.txt');
      const sup = supervisor();
      const { ready } = await sup.start(
        { sessionId: 's1', name: 'web', cmd: `env > ${envFile}; exec ${SERVER}`, cwd: workDir },
        bindNew
      );
      expect(ready).toBe(true);
      const names = new Set(
        (await fs.readFile(envFile, 'utf-8')).split('\n').map((line) => line.slice(0, line.indexOf('=')))
      );
      for (const name of PREVIEW_STRIPPED_ENV) expect(names.has(name), name).toBe(false);
      expect(names.has('CODEMAN_API_URL')).toBe(true);
      expect(names.has('CODEMAN_PREVIEW_ID')).toBe(true);
      expect(names.has('CODEMAN_PREVIEW_OWNER')).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a repeated start leaves one live process group, on the same web tab and port', async () => {
    const sup = supervisor();
    const input = { sessionId: 's1', name: 'web', cmd: SERVER, cwd: workDir };
    const bind = async (_port: number, existing?: string) => existing ?? 'wv-repeat';
    const first = await sup.start(input, bind);
    const second = await sup.start(input, bind);
    const third = await sup.start(input, bind);
    expect(sup.list()).toHaveLength(1);
    expect(third.record.webviewId).toBe(first.record.webviewId);
    expect(third.record.port).toBe(first.record.port);
    expect(readProcStat(first.record.pid)).toBeNull();
    expect(readProcStat(second.record.pid)).toBeNull();
    const groups = new Set(markerPids(dataDir).map((pid) => readProcStat(pid)?.pgid));
    expect(groups).toEqual(new Set([third.record.pgid]));
  });

  it('removing a preview whose process group is already gone succeeds', async () => {
    const sup = supervisor();
    const { record } = await sup.start({ sessionId: 's1', name: 'web', cmd: SERVER, cwd: workDir }, bindNew);
    process.kill(-record.pgid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 200));
    expect(await sup.remove(record.webviewId)).toEqual({
      record: expect.objectContaining({ webviewId: record.webviewId }),
    });
    expect(sup.list()).toEqual([]);
    expect(await fs.readFile(path.join(dataDir, 'previews.json'), 'utf-8')).toBe('[]');
  });

  it('stops a server that left its process group with setsid, and frees its port', async () => {
    const sup = supervisor();
    const cmd = `(setsid nohup ${SERVER} >/dev/null 2>&1 &)`;
    const { record, ready } = await sup.start({ sessionId: 's1', name: 'web', cmd, cwd: workDir }, bindNew);
    expect(ready).toBe(true);
    const daemon = findListenerPids(record.port);
    expect(daemon.length).toBe(1);
    expect(readProcStat(daemon[0])?.pgid).not.toBe(record.pgid);
    const started = Date.now();
    await sup.remove(record.webviewId);
    expect(Date.now() - started).toBeLessThan(6000);
    expect(await portOpen(record.port)).toBe(false);
    expect(markerPids(dataDir, record.webviewId)).toEqual([]);
  });

  it('marks a command that exits at once as exited and keeps its log', async () => {
    const sup = supervisor();
    const { record, ready } = await sup.start(
      { sessionId: 's1', name: 'web', cmd: 'echo boom on {port}; exit 3', cwd: workDir },
      bindNew
    );
    expect(ready).toBe(false);
    expect(sup.forWebview(record.webviewId)?.state).toBe('exited');
    expect((await sup.readLog(record.webviewId, 1000))?.text).toBe(`boom on ${record.port}\n`);
  });
});

describe('reconcile against real processes', () => {
  const allTabs = (ids: string[]) => async () => new Set(ids);

  it('keeps a matching process running', async () => {
    const sup = supervisor();
    const { record } = await sup.start({ sessionId: 's1', name: 'web', cmd: SERVER, cwd: workDir }, bindNew);
    await sup.reconcile(allTabs([record.webviewId]));
    expect(sup.forWebview(record.webviewId)?.state).toBe('running');
    expect(await portOpen(record.port)).toBe(true);
  });

  it('stops the group of a preview whose web tab is gone, and forgets it', async () => {
    const sup = supervisor();
    const { record } = await sup.start({ sessionId: 's1', name: 'web', cmd: SERVER, cwd: workDir }, bindNew);
    await sup.reconcile(allTabs([]));
    expect(sup.list()).toEqual([]);
    expect(await portOpen(record.port)).toBe(false);
    expect(markerPids(dataDir)).toEqual([]);
  });

  it('kills an orphan: a marker process whose record is gone after a restart', async () => {
    const first = supervisor();
    const { record } = await first.start({ sessionId: 's1', name: 'web', cmd: SERVER, cwd: workDir }, bindNew);
    await fs.writeFile(path.join(dataDir, 'previews.json'), '[]');
    const rebooted = supervisor();
    expect(rebooted.list()).toEqual([]);
    const plan = await rebooted.reconcile(allTabs([record.webviewId]));
    expect(plan.orphanPids.length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 200));
    expect(await portOpen(record.port)).toBe(false);
    expect(markerPids(dataDir)).toEqual([]);
  });

  it('the minute pass without the orphan sweep still keeps a daemonized preview running', async () => {
    const sup = supervisor();
    const cmd = `(setsid nohup ${SERVER} >/dev/null 2>&1 &)`;
    const { record } = await sup.start({ sessionId: 's1', name: 'web', cmd, cwd: workDir }, bindNew);
    await sup.reconcile(allTabs([record.webviewId]), { sweepOrphans: false });
    expect(sup.forWebview(record.webviewId)?.state).toBe('running');
    expect(await portOpen(record.port)).toBe(true);
    await sup.reconcile(allTabs([]), { sweepOrphans: false });
    expect(await portOpen(record.port)).toBe(false);
    expect(markerPids(dataDir)).toEqual([]);
  });

  it('never signals a recorded pid whose startTicks differ', async () => {
    const bystander = spawn(NODE, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
    try {
      const stat = readProcStat(bystander.pid!)!;
      const fake: PreviewProcess = {
        webviewId: 'wv-reused',
        sessionId: 's1',
        name: 'web',
        cmd: 'x',
        cwd: workDir,
        port: 1,
        pid: bystander.pid!,
        pgid: stat.pgid,
        startTicks: stat.startTicks - 1,
        logPath: path.join(dataDir, 'x.log'),
        state: 'running',
        lastViewedAt: Date.now(),
      };
      await fs.writeFile(path.join(dataDir, 'previews.json'), JSON.stringify([fake]));
      const sup = supervisor();
      await sup.reconcile(allTabs(['wv-reused']));
      expect(sup.forWebview('wv-reused')?.state).toBe('exited');
      await sup.remove('wv-reused');
      expect(readProcStat(bystander.pid!)?.startTicks).toBe(stat.startTicks);
    } finally {
      bystander.kill('SIGKILL');
    }
  });

  it('stops a preview left unopened past the idle limit, using a fake clock', async () => {
    let now = 1_000_000;
    const sup = supervisor({ now: () => now, idleStopMs: () => 60_000 });
    const { record } = await sup.start({ sessionId: 's1', name: 'web', cmd: SERVER, cwd: workDir }, bindNew);
    now += 30_000;
    await sup.reconcile(allTabs([record.webviewId]));
    expect(sup.forWebview(record.webviewId)?.state).toBe('running');
    sup.markViewed(record.webviewId);
    now += 59_000;
    await sup.reconcile(allTabs([record.webviewId]));
    expect(sup.forWebview(record.webviewId)?.state).toBe('running');
    now += 2_000;
    await sup.reconcile(allTabs([record.webviewId]));
    expect(sup.forWebview(record.webviewId)?.state).toBe('stopped');
    expect(await portOpen(record.port)).toBe(false);
    const onDisk = JSON.parse(await fs.readFile(path.join(dataDir, 'previews.json'), 'utf-8'));
    expect(onDisk[0].state).toBe('stopped');
  });
});

describe('a server Codeman cannot stop', () => {
  const escaped = `(env -i setsid ${SERVER} >/dev/null 2>&1 &)`;

  function killListener(port: number) {
    for (const pid of findListenerPids(port)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }

  it('reports a server that escaped the marker with env -i, keeps it listed, and logs it', async () => {
    const sup = supervisor();
    const { record } = await sup.start({ sessionId: 's1', name: 'web', cmd: escaped, cwd: workDir }, bindNew);
    try {
      const deadline = Date.now() + 5000;
      while (!(await portOpen(record.port)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      const listener = findListenerPids(record.port);
      expect(listener).toHaveLength(1);
      expect(markerPids(dataDir)).toEqual([]);

      const removal = await sup.remove(record.webviewId, 'alice');
      expect(removal?.leftRunning).toEqual({ port: record.port, pids: listener });
      expect(await portOpen(record.port)).toBe(true);
      expect(sup.list()).toEqual([]);
      expect(sup.listLeftRunning()).toEqual([
        expect.objectContaining({ port: record.port, pids: listener, name: 'web', sessionId: 's1', owner: 'alice' }),
      ]);
      expect(await fs.readFile(record.logPath, 'utf-8')).toContain(`Port ${record.port} is still listening`);
      const onDisk = JSON.parse(await fs.readFile(path.join(dataDir, 'previews-left-running.json'), 'utf-8'));
      expect(onDisk).toMatchObject([{ port: record.port, webviewId: record.webviewId }]);
      expect(supervisor().listLeftRunning()).toHaveLength(1);

      killListener(record.port);
      await new Promise((r) => setTimeout(r, 200));
      await sup.reconcile(async () => new Set(), { sweepOrphans: false });
      expect(sup.listLeftRunning()).toEqual([]);
      await expect(fs.stat(record.logPath)).rejects.toThrow();
    } finally {
      killListener(record.port);
    }
  });

  it('a replacing start reports the escaped server and moves to another port', async () => {
    const sup = supervisor();
    const input = { sessionId: 's1', name: 'web', cmd: escaped, cwd: workDir };
    const first = await sup.start(input, async (_p, existing) => existing ?? 'wv-escape');
    try {
      const deadline = Date.now() + 5000;
      while (!(await portOpen(first.record.port)) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 100));
      const second = await sup.start({ ...input, cmd: SERVER }, async (_p, existing) => existing ?? 'wv-escape');
      expect(second.leftRunning?.port).toBe(first.record.port);
      expect(second.record.port).not.toBe(first.record.port);
      expect(second.ready).toBe(true);
      expect(sup.listLeftRunning().map((r) => r.port)).toEqual([first.record.port]);
      expect(await fs.readFile(second.record.logPath, 'utf-8')).toContain(
        `Port ${first.record.port} is still listening`
      );
    } finally {
      killListener(first.record.port);
    }
  });

  it('an idle stop checks the port and reports a listener that survived', async () => {
    let now = Date.now();
    const sup = supervisor({ now: () => now, idleStopMs: () => 1000 });
    const cmd = `${escaped}; exec ${NODE} -e "setInterval(() => {}, 1000)"`;
    const { record } = await sup.start({ sessionId: 's1', name: 'web', cmd, cwd: workDir }, bindNew);
    try {
      const deadline = Date.now() + 5000;
      while (!(await portOpen(record.port)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      const listener = findListenerPids(record.port);
      now += 5000;
      await sup.reconcile(async () => new Set([record.webviewId]));
      expect(sup.forWebview(record.webviewId)?.state).toBe('stopped');
      expect(markerPids(dataDir)).toEqual([]);
      expect(sup.listLeftRunning()).toEqual([expect.objectContaining({ port: record.port, pids: listener })]);
      expect(await fs.readFile(record.logPath, 'utf-8')).toContain(`Port ${record.port} is still listening`);
    } finally {
      killListener(record.port);
    }
  });

  it('a failed write of previews.json after a stop still leaves the escaped server listed on reload', async () => {
    const sup = supervisor();
    const { record } = await sup.start({ sessionId: 's1', name: 'web', cmd: escaped, cwd: workDir }, bindNew);
    const previewsFile = path.join(dataDir, 'previews.json');
    const realRename = fs.rename;
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === previewsFile) throw Object.assign(new Error('injected EIO'), { code: 'EIO' });
      return realRename(from, to);
    });
    try {
      const deadline = Date.now() + 5000;
      while (!(await portOpen(record.port)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      await expect(sup.remove(record.webviewId, 'alice')).rejects.toThrow('injected EIO');
      spy.mockRestore();
      expect(await portOpen(record.port)).toBe(true);
      expect(supervisor().listLeftRunning()).toEqual([
        expect.objectContaining({ port: record.port, webviewId: record.webviewId, owner: 'alice' }),
      ]);
    } finally {
      spy.mockRestore();
      killListener(record.port);
    }
  });

  it('a stopped server whose port frees reports nothing', async () => {
    const sup = supervisor();
    const { record } = await sup.start({ sessionId: 's1', name: 'web', cmd: SERVER, cwd: workDir }, bindNew);
    expect(await sup.remove(record.webviewId)).not.toHaveProperty('leftRunning');
    expect(sup.listLeftRunning()).toEqual([]);
  });
});

describe('starts of one session', () => {
  it('concurrent starts never pass the per-session limit', async () => {
    const sup = supervisor();
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        sup.start({ sessionId: 's1', name: `n${i}`, cmd: 'exit 0', cwd: workDir }, bindNew, { maxPerSession: 3 })
      )
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(PreviewLimitError);
    expect(sup.list()).toHaveLength(3);
  });

  it('concurrent starts of one name each report the server they started as ready', async () => {
    const sup = supervisor();
    const input = { sessionId: 's1', name: 'web', cmd: SERVER, cwd: workDir };
    const bind = async (_port: number, existing?: string) => existing ?? 'wv-concurrent';
    const results = await Promise.all([sup.start(input, bind), sup.start(input, bind), sup.start(input, bind)]);
    expect(results.map((r) => r.ready)).toEqual([true, true, true]);
    expect(sup.list()).toHaveLength(1);
  });
});

describe('a colour that may not act', () => {
  it('a sweep queued before the colour retired stops nothing when it runs', async () => {
    let live = true;
    const sup = supervisor({ mayAct: () => live, canPersist: () => live });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = sup.reconcile(async () => {
      await held;
      return new Set();
    });
    const queued = sup.reconcile(async () => new Set());
    await new Promise((r) => setTimeout(r, 50));

    live = false;
    const child = spawn(NODE, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CODEMAN_PREVIEW_ID: 'started-by-the-live-colour', CODEMAN_PREVIEW_OWNER: dataDir },
    });
    child.unref();
    await new Promise((r) => setTimeout(r, 200));
    const pid = child.pid!;
    expect(markerPids(dataDir)).toEqual([pid]);

    release();
    expect(await first).toEqual({ decisions: [], orphanPids: [] });
    expect(await queued).toEqual({ decisions: [], orphanPids: [] });
    await new Promise((r) => setTimeout(r, 300));
    expect(markerPids(dataDir)).toEqual([pid]);
  });

  it('refuses a start, a remove and a session removal when the work begins', async () => {
    let live = true;
    const sup = supervisor({ mayAct: () => live });
    const { record } = await sup.start({ sessionId: 's1', name: 'web', cmd: SERVER, cwd: workDir }, bindNew);
    live = false;
    const bind = vi.fn(bindNew);
    await expect(sup.start({ sessionId: 's1', name: 'web', cmd: SERVER, cwd: workDir }, bind)).rejects.toThrow(
      PreviewRefusedError
    );
    await expect(sup.remove(record.webviewId)).rejects.toThrow(PreviewRefusedError);
    await expect(sup.removeSession('s1')).rejects.toThrow(PreviewRefusedError);
    expect(bind).not.toHaveBeenCalled();
    expect(await portOpen(record.port)).toBe(true);
    expect(sup.forWebview(record.webviewId)?.pid).toBe(record.pid);
  });

  describe('retiring during a stop', () => {
    const resistant = `${NODE} -e "process.on('SIGTERM',()=>{});require('http').createServer((q,s)=>s.end('ok')).listen(Number(process.argv[1]))" {port}`;

    function startLiveColourProcess(previewId: string): number {
      const child = spawn(NODE, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, CODEMAN_PREVIEW_ID: previewId, CODEMAN_PREVIEW_OWNER: dataDir },
      });
      child.unref();
      return child.pid!;
    }

    const alive = (pid: number) => {
      const stat = readProcStat(pid);
      return !!stat && !stat.zombie;
    };

    async function retireDuringGrace(live: { value: boolean }, previewId: string): Promise<number> {
      await new Promise((r) => setTimeout(r, 300));
      live.value = false;
      const pid = startLiveColourProcess(previewId);
      await new Promise((r) => setTimeout(r, 100));
      expect(alive(pid)).toBe(true);
      return pid;
    }

    it('a remove abandons its stop and never signals the live colour once retired', async () => {
      const live = { value: true };
      const sup = supervisor({ mayAct: () => live.value, canPersist: () => live.value });
      const { record } = await sup.start({ sessionId: 's1', name: 'web', cmd: resistant, cwd: workDir }, bindNew);
      expect(await portOpen(record.port)).toBe(true);
      const removal = sup.remove(record.webviewId);
      const replacement = await retireDuringGrace(live, record.webviewId);
      await expect(removal).rejects.toThrow(PreviewAbandonedError);
      await new Promise((r) => setTimeout(r, 300));
      expect(alive(replacement)).toBe(true);
      expect(sup.forWebview(record.webviewId)).toBeDefined();
    });

    it('a reconcile abandons its stop once retired and leaves the live colour alone', async () => {
      const live = { value: true };
      const sup = supervisor({ mayAct: () => live.value, canPersist: () => live.value });
      const { record } = await sup.start({ sessionId: 's1', name: 'web', cmd: resistant, cwd: workDir }, bindNew);
      const pass = sup.reconcile(async () => new Set());
      const replacement = await retireDuringGrace(live, record.webviewId);
      await expect(pass).resolves.toBeDefined();
      await new Promise((r) => setTimeout(r, 300));
      expect(alive(replacement)).toBe(true);
    });

    it('a replacing start retired during the stop spawns no new server', async () => {
      const live = { value: true };
      const sup = supervisor({ mayAct: () => live.value, canPersist: () => live.value });
      const input = { sessionId: 's1', name: 'web', cmd: resistant, cwd: workDir };
      const { record } = await sup.start(input, bindNew);
      const bind = vi.fn(async (_p: number, existing?: string) => existing ?? 'never');
      const restart = sup.start({ ...input, cmd: SERVER }, bind);
      const replacement = await retireDuringGrace(live, record.webviewId);
      await expect(restart).rejects.toThrow(PreviewAbandonedError);
      await new Promise((r) => setTimeout(r, 300));
      expect(alive(replacement)).toBe(true);
      expect(bind).not.toHaveBeenCalled();
    });
  });
});

describe('an exited preview whose server escaped', () => {
  const escaped = `env -i PATH=/usr/bin:/bin setsid ${NODE} -e "require('http').createServer((q,s)=>s.end('ok')).listen(Number(process.argv[1]))" {port} >/dev/null 2>&1 &`;

  function killListener(port: number) {
    for (const pid of findListenerPids(port)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }

  it('is reported as still listening as soon as the start answers', async () => {
    const sup = supervisor();
    const { record, ready } = await sup.start({ sessionId: 's1', name: 'web', cmd: escaped, cwd: workDir }, bindNew);
    try {
      expect(ready).toBe(false);
      expect(sup.forWebview(record.webviewId)?.state).toBe('exited');
      const listener = findListenerPids(record.port);
      expect(listener).toHaveLength(1);
      expect(sup.leftRunningOn(record.webviewId)).toEqual({ port: record.port, pids: listener });
      expect(sup.listLeftRunning()).toEqual([expect.objectContaining({ port: record.port, name: 'web' })]);
      expect(await fs.readFile(record.logPath, 'utf-8')).toContain(`after "web" exited`);
    } finally {
      killListener(record.port);
    }
  });

  it('a reconcile pass finds it from the exited record and writes the tombstone', async () => {
    const first = supervisor();
    const { record } = await first.start({ sessionId: 's1', name: 'web', cmd: escaped, cwd: workDir }, bindNew);
    try {
      await fs.rm(path.join(dataDir, 'previews-left-running.json'), { force: true });
      const sup = supervisor();
      expect(sup.listLeftRunning()).toEqual([]);
      expect(sup.forWebview(record.webviewId)?.state).toBe('exited');
      await sup.reconcile(async () => new Set([record.webviewId]), { sweepOrphans: false });
      expect(sup.listLeftRunning()).toEqual([
        expect.objectContaining({ port: record.port, pids: findListenerPids(record.port) }),
      ]);
      expect(supervisor().listLeftRunning()).toHaveLength(1);
    } finally {
      killListener(record.port);
    }
  });
});
