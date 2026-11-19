/**
 * Differential random testing of the deploy health check's session decision against its Dafny model.
 *
 * The oracle is `Decide` in deploy/model/SessionSurvival.dfy, built to Python in deploy/model/oracle/
 * (deploy/model/build-oracle.sh) and driven by deploy/model/drt_oracle.py. Its meaning is proved there:
 * a pass means every expected session is listed or provably dead, and with any doubt the check is
 * exactly the old one. These tests check that the shipped JavaScript computes the same function.
 *
 * - Tier 1 runs `decideSessions` (deploy/session-survival.mjs) on thousands of random abstract inputs.
 * - Tier 2 runs the real deploy/healthcheck.mjs end to end on random scenarios: a stub server for the
 *   new colour, a real mux-sessions.json (valid, malformed or absent), and a real tmux server on a
 *   throwaway socket, no server, or no tmux binary at all. It checks the I/O the model abstracts.
 *
 * DRT_SEED and DRT_CASES override the seed and tier 1's case count; a failure prints the seed and case.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs with no types; the deploy scripts have zero dependencies by design.
import { decideSessions } from '../deploy/session-survival.mjs';

const ORACLE = resolve(import.meta.dirname, '../deploy/model/drt_oracle.py');
const SCRIPT = resolve(import.meta.dirname, '../deploy/healthcheck.mjs');
const SEED = Number(process.env.DRT_SEED ?? 20261119);
const CASES = Number(process.env.DRT_CASES ?? 5000);
const E2E_CASES = 120;

type Tmux = { kind: 'running'; names: string[] } | { kind: 'none' } | { kind: 'unknown' };
interface Case {
  expected: string[];
  listed: string[];
  records: Record<string, string> | null;
  tmux: Tmux;
  envOk: boolean;
}
interface Outcome {
  ok: boolean;
  excused: string[];
  lost: string[];
}

function has(bin: string, args: string[]): boolean {
  try {
    execFileSync(bin, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const HAS_PYTHON = has('python3', ['--version']);
const HAS_TMUX = has('tmux', ['-V']);

/** mulberry32: small, seedable, good enough to spread cases. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(xs: readonly T[]) => xs[int(xs.length)];
  const chance = (p: number) => next() < p;
  const some = <T>(xs: readonly T[], p: number) => xs.filter(() => chance(p));
  const seq = <T>(xs: readonly T[], max: number) => Array.from({ length: int(max + 1) }, () => pick(xs));
  return { int, pick, chance, some, seq };
}

function runOracle(cases: Case[]): Outcome[] {
  const out = execFileSync('python3', ['-I', '-B', ORACLE], {
    input: JSON.stringify(cases),
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out.toString('utf8'));
}

function runJs(c: Case): Outcome {
  return decideSessions({
    expected: c.expected,
    listed: new Set(c.listed),
    records: c.records === null ? null : new Map(Object.entries(c.records)),
    tmux: c.tmux.kind === 'running' ? { kind: 'running', names: new Set(c.tmux.names) } : c.tmux,
    envOk: c.envOk,
  });
}

describe.skipIf(!HAS_PYTHON)('session survival: shipped code against the Dafny model', () => {
  it(`tier 1: decideSessions equals Decide on ${CASES} random inputs (seed ${SEED})`, () => {
    const r = rng(SEED);
    // Small pools force collisions, duplicates and overlaps; the odd ids test that nothing assumes a shape.
    const ids = ['s1', 's2', 's3', 's4', 's5', 's6', 'é✓', 'a,b', ' '];
    const muxNames = ['m1', 'm2', 'm3', 'm4', 'm5'];
    const cases: Case[] = Array.from({ length: CASES }, () => {
      const records: Record<string, string> | null = r.chance(0.15)
        ? null
        : Object.fromEntries(r.some(ids, 0.6).map((id) => [id, r.pick(muxNames)]));
      const tmuxRoll = r.int(10);
      const tmux: Tmux =
        tmuxRoll < 6
          ? { kind: 'running', names: r.some(muxNames, 0.5) }
          : tmuxRoll < 8
            ? { kind: 'none' }
            : { kind: 'unknown' };
      return { expected: r.seq(ids, 8), listed: r.some(ids, 0.5), records, tmux, envOk: r.chance(0.85) };
    });

    const oracle = runOracle(cases);
    const seen = { allListed: 0, passWithExcused: 0, fail: 0, failClosed: 0 };
    cases.forEach((c, i) => {
      const js = runJs(c);
      if (JSON.stringify(js) !== JSON.stringify(oracle[i])) {
        throw new Error(
          `DRT divergence, seed ${SEED}, case ${i}:\n${JSON.stringify(c)}\njs:     ${JSON.stringify(js)}\noracle: ${JSON.stringify(oracle[i])}`
        );
      }
      const missing = c.expected.filter((id) => !c.listed.includes(id));
      if (missing.length === 0) seen.allListed++;
      else if (js.ok) seen.passWithExcused++;
      else seen.fail++;
      if (missing.length > 0 && (!c.envOk || c.records === null || c.tmux.kind === 'unknown')) seen.failClosed++;
    });
    // A generator that never reaches a branch would pass vacuously.
    for (const [branch, n] of Object.entries(seen)) expect(n, branch).toBeGreaterThan(CASES / 50);
  });

  describe.skipIf(!HAS_TMUX)(`tier 2: deploy/healthcheck.mjs end to end on ${E2E_CASES} random scenarios`, () => {
    const socket = `codeman-drt-${process.pid}`;
    const freeSocket = `codeman-drt-none-${process.pid}`;
    const alive = ['codeman-alive001', 'codeman-alive002', 'codeman-alive003'];
    const dead = ['codeman-dead0004', 'codeman-dead0005'];
    let dataDir: string;
    let stub: http.Server;
    let port: number;
    let listedNow: string[] = [];

    beforeAll(async () => {
      dataDir = mkdtempSync(join(tmpdir(), 'codeman-drt-'));
      for (const name of alive) execFileSync('tmux', ['-L', socket, 'new-session', '-d', '-s', name, 'sleep 900']);
      stub = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/sessions') return res.end(JSON.stringify(listedNow.map((id) => ({ id }))));
        if (req.url === '/api/health')
          return res.end(JSON.stringify({ status: 'ok', buildId: 'drt', version: '0', pid: 1 }));
        res.statusCode = 404;
        res.end('{}');
      });
      await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
      port = (stub.address() as AddressInfo).port;
    });

    afterAll(async () => {
      try {
        execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
      } catch {
        /* already gone */
      }
      await new Promise<void>((r) => stub.close(() => r()));
      rmSync(dataDir, { recursive: true, force: true });
    });

    function runScript(expected: string[], env: Record<string, string>) {
      return new Promise<{ ok: boolean; detail: string }>((resolveRun, reject) => {
        const child = spawn(
          process.execPath,
          [SCRIPT, '--port', String(port), '--expect-sessions', expected.join(',')],
          { env }
        );
        let stdout = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.on('error', reject);
        child.on('close', () => {
          const report = JSON.parse(stdout.trim().split('\n').pop()!);
          resolveRun(report.checks.find((c: { name: string }) => c.name === 'sessions'));
        });
      });
    }

    it('reports what the model decides, in every scenario', async () => {
      const r = rng(SEED ^ 0x5eed);
      const ids = ['s1', 's2', 's3', 's4', 's5', 's6'];
      const names = [...alive, ...dead];
      const running = execFileSync('tmux', ['-L', socket, 'list-sessions', '-F', '#{session_name}'], {
        encoding: 'utf8',
      })
        .split('\n')
        .filter(Boolean);
      const seen = new Set<string>();

      for (let i = 0; i < E2E_CASES; i++) {
        const expected = Array.from(new Set(r.seq(ids, 6))).filter(Boolean);
        if (expected.length === 0) expected.push(r.pick(ids));
        listedNow = r.some(ids, 0.5);

        // The record file the live colour wrote, possibly odd, and what the model is told it means.
        const fileMode = r.pick(['valid', 'valid', 'valid', 'notArray', 'garbage', 'absent'] as const);
        const file = join(dataDir, 'mux-sessions.json');
        let records: Record<string, string> | null = null;
        if (fileMode === 'valid') {
          const rows = r.some(ids, 0.7).map((id) => ({ sessionId: id, muxName: r.pick(names) }));
          // Rows the parser must skip, and a later duplicate that must win.
          if (r.chance(0.3)) rows.push({ sessionId: r.pick(ids), muxName: 'bad name;rm' });
          if (r.chance(0.3)) rows.push({ sessionId: r.pick(ids) } as { sessionId: string; muxName: string });
          if (r.chance(0.3)) rows.push({ sessionId: r.pick(ids), muxName: r.pick(names) });
          writeFileSync(file, JSON.stringify(rows));
          records = {};
          for (const row of rows)
            if (typeof row.muxName === 'string' && /^[A-Za-z0-9._-]+$/.test(row.muxName))
              records[row.sessionId] = row.muxName;
        } else if (fileMode === 'notArray') {
          writeFileSync(file, JSON.stringify({ sessions: [] }));
        } else if (fileMode === 'garbage') {
          writeFileSync(file, '{not json');
        } else {
          try {
            unlinkSync(file);
          } catch {
            /* absent already */
          }
        }

        // Where tmux stands: sessions running, no server, no tmux at all, or a variable the check refuses.
        const tmuxMode = r.pick(['running', 'running', 'none', 'noTmuxBinary', 'badSocket', 'noDataDir'] as const);
        const env: Record<string, string> = {
          PATH: process.env.PATH ?? '',
          CODEMAN_DATA_DIR: dataDir,
          CODEMAN_TMUX_SOCKET: socket,
        };
        let tmux: Tmux = { kind: 'running', names: running };
        let envOk = true;
        if (tmuxMode === 'none') {
          env.CODEMAN_TMUX_SOCKET = freeSocket;
          tmux = { kind: 'none' };
        } else if (tmuxMode === 'noTmuxBinary') {
          env.PATH = '';
          tmux = { kind: 'unknown' };
        } else if (tmuxMode === 'badSocket') {
          env.CODEMAN_TMUX_SOCKET = 'bad socket';
          envOk = false;
        } else if (tmuxMode === 'noDataDir') {
          delete env.CODEMAN_DATA_DIR;
          envOk = false;
        }

        const c: Case = { expected, listed: listedNow, records, tmux, envOk };
        const [want] = runOracle([c]);
        const got = await runScript(expected, env);
        const allListed = expected.every((id) => listedNow.includes(id));
        const wantDetail = allListed
          ? `${expected.length} expected, all present`
          : want.ok
            ? `${expected.length} expected, ${expected.length - want.excused.length} present, ${want.excused.length} not listed because their tmux session is gone: ${want.excused.join(',')}`
            : `missing ${want.lost.join(',')}`;
        if (got.ok !== want.ok || got.detail !== wantDetail) {
          throw new Error(
            `DRT divergence, seed ${SEED}, e2e case ${i} (${fileMode}, ${tmuxMode}):\n${JSON.stringify(c)}\nscript: ${JSON.stringify(got)}\nmodel:  ${JSON.stringify({ ok: want.ok, detail: wantDetail })}`
          );
        }
        seen.add(`${fileMode}/${tmuxMode}/${allListed ? 'listed' : want.ok ? 'excused' : 'lost'}`);
      }
      // Every file mode and tmux mode was reached, and both an excusing pass and a failure happened.
      for (const mode of [
        'valid',
        'notArray',
        'garbage',
        'absent',
        'running',
        'none',
        'noTmuxBinary',
        'badSocket',
        'noDataDir',
      ]) {
        expect(
          [...seen].some((s) => s.split('/').includes(mode)),
          mode
        ).toBe(true);
      }
      expect(
        [...seen].some((s) => s.endsWith('/excused')),
        'an excusing pass'
      ).toBe(true);
      expect(
        [...seen].some((s) => s.endsWith('/lost')),
        'a failure'
      ).toBe(true);
    }, 120_000);
  });
});
