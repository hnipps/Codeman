#!/usr/bin/env node
/**
 * Single-attempt health check of one running Codeman, for a deploy supervisor.
 *
 *   node deploy/healthcheck.mjs --port 3101 [--host 127.0.0.1] \
 *     [--expect-build <id>] [--expect-sessions <id,id,...>]
 *
 * Checks GET /api/health (and its build id when asked), GET /api/sessions (every expected
 * session id is listed) and the /ws/health WebSocket. Prints ONE JSON line
 * `{ ok, checks: [{ name, ok, detail }] }` and exits 0 only when every check passed.
 * No retries: the caller owns those. Uses HTTP Basic auth from CODEMAN_USERNAME
 * (default admin) and CODEMAN_PASSWORD when the password is set. Zero dependencies.
 *
 * An expected session the new server does not list still passes when its tmux session
 * is gone (`decideSessions` in session-survival.mjs, proved in model/SessionSurvival.dfy). The live server keeps listing a session whose tmux
 * session died, for example when the tmux server restarts, and a new server rightly
 * drops it, so such a session can never be "kept". Every other missing id fails.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { classifyTmuxResult, decideSessions, MUX_NAME, parseMuxRecords } from './session-survival.mjs';

const TIMEOUT_MS = 5000;

function usageError(message) {
  console.log(JSON.stringify({ ok: false, checks: [{ name: 'args', ok: false, detail: message }] }));
  process.exit(2);
}

let args;
try {
  args = parseArgs({
    options: {
      port: { type: 'string' },
      host: { type: 'string', default: '127.0.0.1' },
      'expect-build': { type: 'string' },
      'expect-sessions': { type: 'string' },
    },
    strict: true,
  }).values;
} catch (err) {
  usageError(err.message);
}
const port = Number(args.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) usageError('--port <1-65535> is required');

const authority = `${args.host.includes(':') ? `[${args.host}]` : args.host}:${port}`;
const expectBuild = args['expect-build'];
const expectSessions = (args['expect-sessions'] ?? '').split(',').filter(Boolean);
const password = process.env.CODEMAN_PASSWORD;
const headers = password
  ? {
      authorization:
        'Basic ' + Buffer.from(`${process.env.CODEMAN_USERNAME || 'admin'}:${password}`).toString('base64'),
    }
  : {};

async function getData(path) {
  const res = await fetch(`http://${authority}${path}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return body?.data ?? body;
}

function readWsHealth() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${authority}/ws/health`, { headers });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('timed out')), TIMEOUT_MS);
    ws.onmessage = (event) => {
      try {
        finish(resolve, JSON.parse(String(event.data)));
      } catch {
        finish(reject, new Error('frame is not JSON'));
      }
    };
    ws.onerror = () => finish(reject, new Error('connection failed'));
    ws.onclose = (event) => finish(reject, new Error(`closed (${event.code}) before the ok frame`));
  });
}

/**
 * What the check needs to tell a dead session from a lost one, read once and only when an expected
 * session is missing: the live colour's mux records (`mux-sessions.json` in CODEMAN_DATA_DIR) and the
 * tmux sessions on CODEMAN_TMUX_SOCKET. Any doubt (an unset variable, an unreadable file, a tmux error)
 * leaves `decideSessions` exactly as strict as listing every expected id.
 */
async function survivalFacts() {
  const dataDir = process.env.CODEMAN_DATA_DIR;
  const socket = process.env.CODEMAN_TMUX_SOCKET;
  const envOk = Boolean(dataDir) && Boolean(socket) && MUX_NAME.test(socket);
  if (!envOk) return { envOk, records: null, tmux: { kind: 'unknown' } };
  let records;
  try {
    records = parseMuxRecords(await readFile(join(dataDir, 'mux-sessions.json'), 'utf8'));
  } catch {
    records = null;
  }
  const tmux = await new Promise((resolveTmux) => {
    execFile(
      'tmux',
      ['-L', socket, 'list-sessions', '-F', '#{session_name}'],
      { timeout: TIMEOUT_MS },
      (err, stdout, stderr) => resolveTmux(classifyTmuxResult(err, stdout, stderr))
    );
  });
  return { envOk, records, tmux };
}

const checks = [
  [
    'health',
    async () => {
      const health = await getData('/api/health');
      if (health.status !== 'ok') throw new Error(`status is ${JSON.stringify(health.status)}`);
      if (expectBuild && health.buildId !== expectBuild) {
        throw new Error(`build is ${health.buildId}, expected ${expectBuild}`);
      }
      return `build ${health.buildId}, version ${health.version}, pid ${health.pid}`;
    },
  ],
  [
    'ws',
    async () => {
      const frame = await readWsHealth();
      if (frame.ok !== true) throw new Error(`frame is ${JSON.stringify(frame)}`);
      if (expectBuild && frame.buildId !== expectBuild) {
        throw new Error(`build is ${frame.buildId}, expected ${expectBuild}`);
      }
      return `build ${frame.buildId}`;
    },
  ],
];
if (expectSessions.length > 0) {
  checks.push([
    'sessions',
    async () => {
      const list = await getData('/api/sessions');
      if (!Array.isArray(list)) throw new Error('session list is not an array');
      const listed = new Set(list.map((s) => s.id));
      if (expectSessions.every((id) => listed.has(id))) return `${expectSessions.length} expected, all present`;
      const { excused, lost } = decideSessions({ expected: expectSessions, listed, ...(await survivalFacts()) });
      if (lost.length > 0) throw new Error(`missing ${lost.join(',')}`);
      return `${expectSessions.length} expected, ${expectSessions.length - excused.length} present, ${excused.length} not listed because their tmux session is gone: ${excused.join(',')}`;
    },
  ]);
}

const results = await Promise.all(
  checks.map(async ([name, run]) => {
    try {
      return { name, ok: true, detail: await run() };
    } catch (err) {
      return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  })
);
const ok = results.every((r) => r.ok);
console.log(JSON.stringify({ ok, checks: results }));
process.exitCode = ok ? 0 : 1;
