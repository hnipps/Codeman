#!/usr/bin/env bash
set -euo pipefail

repo=$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)
ref=${1:-HEAD}
commit=$(git -C "$repo" rev-parse --verify "${ref}^{commit}")
root=$(mktemp -d /tmp/codeman-respawn-e2e.XXXXXXXX)
worktree="$root/worktree"
runner_pid=

cleanup() {
  local result=$?
  trap - EXIT INT TERM
  if [[ -n "$runner_pid" ]]; then
    kill -TERM "$runner_pid" 2>/dev/null || true
    wait "$runner_pid" 2>/dev/null || true
  fi
  git -C "$repo" worktree remove --force "$worktree" 2>/dev/null || true
  # Only named children of the freshly allocated directory are removed.
  rm -rf -- "$root/home" "$root/data" "$root/workspace"
  rm -f -- "$root/build.log" "$root/server-a.log" "$root/server-b.log"
  rmdir "$root" 2>/dev/null || true
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'REF %s (%s)\n' "$ref" "$commit"
git -C "$repo" worktree add --quiet --detach "$worktree" "$commit"
ln -s "$HOME/codeman/node_modules" "$worktree/node_modules"
mkdir "$root/home" "$root/data" "$root/workspace"
if ! (cd "$worktree" && HOME="$root/home" npm run build) >"$root/build.log" 2>&1; then
  cat "$root/build.log"
  exit 2
fi
printf 'BUILD PASS\n'

node --input-type=module - "$root" "$HOME" <<'NODE' &
import { spawn, execFileSync } from 'node:child_process';
import { createServer, get } from 'node:http';
import { createWriteStream, readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const [root, realHome] = process.argv.slice(2);
const instance = `e2e-${randomBytes(8).toString('hex')}`;
const socket = `codeman-${instance}`;
const dataDir = realpathSync(`${root}/data`);
const env = {
  PATH: process.env.PATH,
  HOME: `${root}/home`,
  USER: process.env.USER,
  LOGNAME: process.env.LOGNAME,
  SHELL: '/bin/bash',
  LANG: 'C.UTF-8',
  TERM: 'xterm-256color',
  CODEMAN_INSTANCE: instance,
  CODEMAN_DATA_DIR: dataDir,
  CODEMAN_TMUX_SOCKET: socket,
  CODEMAN_CASES_PATH: `${root}/workspace`,
  XDG_CACHE_HOME: `${root}/home/.cache`,
};
const children = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let interrupted = false;
let failures = 0;
let server;
let port;
let events;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { interrupted = true; });
}

async function until(check, timeout = 30000) {
  const deadline = Date.now() + timeout;
  do {
    if (interrupted) throw new Error('Interrupted');
    if (await check()) return true;
    await sleep(200);
  } while (Date.now() < deadline);
  return false;
}

function result(name, ok, observed) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(observed)}`);
  if (!ok) failures++;
}

async function freePort(exclude) {
  const start = Math.floor(Math.random() * 1000);
  for (let i = 0; i < 1000; i++) {
    const candidate = 39000 + ((start + i) % 1000);
    if (candidate === exclude) continue;
    const probe = createServer();
    const free = await new Promise((resolve) => {
      probe.once('error', () => resolve(false));
      probe.listen(candidate, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) return candidate;
  }
  throw new Error('No free port in 39000-39999');
}

function launch(label, listenPort) {
  const logPath = `${root}/server-${label}.log`;
  const log = createWriteStream(logPath, { flags: 'a' });
  const child = spawn(process.execPath,
    [`${root}/worktree/dist/index.js`, 'web', '--host', '127.0.0.1', '--port', String(listenPort)],
    { cwd: `${root}/worktree`, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.once('close', () => log.end());
  child.once('error', (error) => { child.launchError = error.message; });
  return child;
}

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null || child.launchError;
}

async function stop(child) {
  if (!child) return;
  if (!exited(child)) {
    child.kill('SIGTERM');
    const deadline = Date.now() + 20000;
    while (!exited(child) && Date.now() < deadline) await sleep(100);
    if (!exited(child)) {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }
  children.delete(child);
}

async function api(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const value = await response.json();
  if (!response.ok || value.success === false) {
    throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
  }
  return value.data ?? value;
}

async function start() {
  server = launch('a', port);
  const ready = await until(async () => {
    if (exited(server)) throw new Error(`Server exited: ${readFileSync(`${root}/server-a.log`, 'utf8')}`);
    try { await api('GET', '/status'); return true; } catch { return false; }
  });
  if (!ready) throw new Error('Server did not become ready');
}

async function restart() {
  events?.close();
  await stop(server);
  await start();
}

async function createShell(name) {
  const { session } = await api('POST', '/sessions', {
    name, mode: 'shell', workingDir: `${root}/workspace`,
  });
  if (!session.id || session.mode !== 'shell') throw new Error(`Not a shell: ${JSON.stringify(session)}`);
  await api('POST', `/sessions/${session.id}/shell`, {});
  if (!await until(async () => (await api('GET', `/sessions/${session.id}`)).pid)) {
    throw new Error('Shell did not start');
  }
  // Respawn's step-completion detector needs a prompt glyph, not bash's stock "$".
  await api('POST', `/sessions/${session.id}/input`, {
    input: "PS1=$'\\u276f '; PROMPT_COMMAND=''\r",
  });
  if (!await until(() => capture().includes('\u276f'))) throw new Error('Shell prompt was not configured');
  await sleep(1500);
  return session.id;
}

const config = {
  enabled: true, idleTimeoutMs: 1000, interStepDelayMs: 100,
  completionConfirmMs: 1000, noOutputTimeoutMs: 5000,
  // Let the mux write finish before bash redraws the step-completion prompt.
  updatePrompt: 'true; sleep 0.5', sendClear: false, sendInit: false,
  autoAcceptPrompts: false, aiIdleCheckEnabled: false, aiPlanCheckEnabled: false,
  adaptiveTimingEnabled: false, maxUnchangedCycles: 3, maxCycles: 0,
};

function persisted(id) {
  const state = JSON.parse(readFileSync(`${dataDir}/state.json`, 'utf8'));
  return state.sessions[id];
}

async function disabled(id) {
  const status = await api('GET', `/sessions/${id}/respawn`);
  const session = await api('GET', `/sessions/${id}`);
  const saved = persisted(id);
  return {
    sessionRestored: session.id === id && session.mode === 'shell' && !!session.pid,
    running: status.enabled === true && status.state !== 'stopped',
    state: status.state ?? null,
    respawnEnabled: saved?.respawnEnabled ?? null,
    hasConfig: !!saved?.respawnConfig,
  };
}

function isDisabled(value) {
  return value.sessionRestored && !value.running && value.respawnEnabled === false && !value.hasConfig;
}

async function restartObservation(id) {
  await restart();
  // Restore waits out a two-minute grace period; sample beyond it, not just at boot.
  await until(async () => (await disabled(id)).running, 125000);
  return disabled(id);
}

function capture() {
  return execFileSync('tmux', ['-L', socket, 'capture-pane', '-p', '-S', '-', '-t',
    execFileSync('tmux', ['-L', socket, 'list-panes', '-a', '-F', '#{pane_id}'],
      { encoding: 'utf8', env, timeout: 5000 }).trim()],
    { encoding: 'utf8', env, timeout: 5000 });
}

async function listenEvents() {
  const records = [];
  let pending = '';
  let stream;
  await new Promise((resolve, reject) => {
    stream = get(`http://127.0.0.1:${port}/api/events`, (response) => {
      if (response.statusCode !== 200) return reject(new Error(`SSE: ${response.statusCode}`));
      stream.setTimeout(0);
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        pending += chunk.replace(/\r/g, '');
        let end;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const event = frame.match(/^event: ?(.+)$/m)?.[1];
          const data = frame.match(/^data: ?(.+)$/m)?.[1];
          if (event && data) records.push({ event, data: JSON.parse(data) });
        }
      });
      response.on('error', () => {});
      resolve();
    });
    stream.setTimeout(10000, () => stream.destroy(new Error('SSE connection timeout')));
    stream.on('error', reject);
  });
  return { records, close: () => stream.destroy() };
}

try {
  // Resolve isolation using the selected ref's shipped code, not only our env strings.
  Object.assign(process.env, env);
  const isolation = await import(pathToFileURL(`${root}/worktree/dist/config/instance.js`));
  if (realpathSync(isolation.getDataDir()) !== dataDir ||
      dataDir === `${realHome}/.codeman` || isolation.resolveTmuxSocketName() !== socket ||
      socket === 'codeman' || !/^codeman-e2e-[a-f0-9]+$/.test(socket)) {
    throw new Error('Unsafe instance isolation');
  }
  console.log(`ISOLATION PASS ${JSON.stringify({ instance, dataDir, socket })}`);
  port = await freePort();
  await start();

  const s1 = await createShell('e2e-stop');
  await api('POST', `/sessions/${s1}/respawn/enable`, { config });
  if (!await until(() => persisted(s1)?.respawnEnabled === true)) throw new Error('Enabled state never persisted');
  await api('POST', `/sessions/${s1}/respawn/stop`, {});
  await sleep(1000);
  const before = await disabled(s1);
  const after = await restartObservation(s1);
  result('S1 stop survives restart', isDisabled(before) && isDisabled(after), { before, after });
  await api('DELETE', `/sessions/${s1}`);

  const s2 = await createShell('e2e-lease');
  await api('POST', `/sessions/${s2}/respawn/enable`, {
    config: { ...config, idleTimeoutMs: 600000, noOutputTimeoutMs: 600000 },
  });
  await sleep(1000);
  const paneBefore = capture();
  const secondPort = await freePort(port);
  const second = launch('b', secondPort);
  const finished = await until(() => exited(second), 10000);
  await sleep(500);
  const log = readFileSync(`${root}/server-b.log`, 'utf8');
  const leaseMessage = log.split('\n').find((line) =>
    line.includes('already the live') && line.includes('server on this data dir')) ?? null;
  const paneUnchanged = capture() === paneBefore;
  result('S2 role-less second server refused',
    !!finished && second.exitCode !== null && second.exitCode !== 0 && !!leaseMessage && paneUnchanged,
    { exited: !!finished, exitCode: second.exitCode, leaseMessage, paneUnchanged });
  await stop(second);
  await api('POST', `/sessions/${s2}/respawn/stop`, {});
  await api('DELETE', `/sessions/${s2}`);

  const s3 = await createShell('e2e-idle');
  events = await listenEvents();
  await api('POST', `/sessions/${s3}/respawn/enable`, { config });
  const forSession = () => events.records.filter((record) => record.data.sessionId === s3);
  const budgetStop = () => forSession().find((record) =>
    record.event === 'respawn:stopped' && record.data.reason === 'unchanged_workspace');
  await until(() => budgetStop() ||
    forSession().filter((record) => record.event === 'respawn:cycleStarted').length > config.maxUnchangedCycles,
    90000);
  await sleep(1000);
  const records = forSession();
  const cycles = records.filter((record) => record.event === 'respawn:cycleStarted').length;
  const completed = records.filter((record) => record.event === 'respawn:cycleCompleted').length;
  const reason = budgetStop()?.data.reason ?? null;
  const trueReachedPane = /\btrue\b/.test(capture());
  const stopped = await disabled(s3);
  const automaticPersisted = isDisabled(stopped);
  // Contain an unbounded baseline loop, but never manually stop a passing automatic stop.
  if (!automaticPersisted) await api('POST', `/sessions/${s3}/respawn/stop`, {});
  const restored = await restartObservation(s3);
  result('S3 idle loop stops and stays stopped',
    !!reason && cycles === config.maxUnchangedCycles && completed === cycles &&
      trueReachedPane && automaticPersisted && isDisabled(restored),
    { cycles, completed, reason, trueReachedPane, stopped, restored });
  await api('DELETE', `/sessions/${s3}`);
  console.log(`RESULT ${failures ? 'FAIL' : 'PASS'} (${3 - failures}/3 scenarios)`);
} catch (error) {
  console.error(`ERROR ${error.stack ?? error}`);
  failures++;
} finally {
  events?.close();
  for (const child of children) await stop(child);
  if (/^codeman-e2e-[a-f0-9]+$/.test(socket)) {
    try {
      execFileSync('tmux', ['-L', socket, 'kill-server'], { env, timeout: 5000, stdio: 'ignore' });
    } catch { /* The private tmux server may already have exited. */ }
  }
  console.log(`CLEANUP complete (${socket})`);
}
process.exitCode = interrupted ? 130 : failures ? 1 : 0;
NODE
runner_pid=$!
wait "$runner_pid"
runner_pid=
