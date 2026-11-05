import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
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
  const entry = (over: Partial<ProcEntry>): ProcEntry => ({ pid: 100, pgid: 100, startTicks: 5000, zombie: false, ...over });
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
    expect(await sup.remove(record.webviewId)).toMatchObject({ webviewId: record.webviewId });
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
