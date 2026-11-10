#!/usr/bin/env node
/**
 * @fileoverview Runs a real-iPhone Safari scenario in one call.
 *
 * Gestures go to WebDriverAgent as W3C touch actions, so iOS receives real
 * touches. Page reads and assertions run as JS through Appium's Safari web
 * context. Taps aim at CSS selectors: one swallowed calibration touch maps
 * page coordinates to screen points, so nothing queries the accessibility
 * tree (slow inside Safari, and it can stall WebDriverAgent).
 *
 * Run it on the Mac next to Appium, or pass `--ssh user@host` to copy it there,
 * run it, and copy the report and screenshots back. Guide: docs/ios-device-testing.md
 *
 *   node scripts/ios-device.mjs scenario.json [--out DIR] [--caps caps.json]
 *   node scripts/ios-device.mjs scenario.json --ssh user@mac [--ssh-key KEY] [--remote-node PATH]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APPIUM = process.env.APPIUM_URL || 'http://127.0.0.1:4723';
const WDA = process.env.WDA_URL || 'http://127.0.0.1:8100';
const STATE_FILE = join(homedir(), '.cache', 'codeman-ios-device', 'session.json');

function parseArgs(argv) {
  const opts = { scenario: null, out: null, caps: null, ssh: null, sshKey: null, remoteNode: 'node' };
  const flags = {
    '--out': 'out',
    '--caps': 'caps',
    '--ssh': 'ssh',
    '--ssh-key': 'sshKey',
    '--remote-node': 'remoteNode',
  };
  for (let i = 0; i < argv.length; i++) {
    const key = flags[argv[i]];
    if (key) opts[key] = argv[++i];
    else if (argv[i].startsWith('--')) throw new Error(`unknown flag ${argv[i]}`);
    else opts.scenario = argv[i];
  }
  if (!opts.scenario)
    throw new Error('usage: ios-device.mjs <scenario.json> [--out DIR] [--caps FILE] [--ssh user@host]');
  return opts;
}

async function http(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${json?.value?.message ?? ''}`.trim());
  return json.value;
}

class Device {
  constructor(appiumSession, wdaSession) {
    this.appium = (m, p, b) => http(APPIUM, m, `/session/${appiumSession}${p}`, b);
    this.wda = (m, p, b) => http(WDA, m, `/session/${wdaSession}${p}`, b);
    this.calibration = null;
  }

  async js(source, args = []) {
    return this.appium('POST', '/execute/sync', { script: source, args });
  }

  async touch(actions) {
    await this.wda('POST', '/actions', {
      actions: [{ type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' }, actions }],
    });
  }

  async screenshot(dir, file) {
    const png = await http(WDA, 'GET', '/screenshot');
    writeFileSync(join(dir, file), Buffer.from(png, 'base64'));
    return file;
  }

  async calibrate() {
    const size = await this.wda('GET', '/window/size');
    const screen = { x: Math.round(size.width / 2), y: Math.round(size.height / 2) };
    await this.js(CALIBRATION_ARM);
    await this.touch(tapAt(screen, 50));
    const seen = await poll(() => this.js('return window.__iosDeviceCal || null'), 2000);
    if (!seen) await this.js('window.__iosDeviceCalDisarm?.()');
    if (!seen) throw new Error('calibration touch never reached the page (is a native sheet or keyboard covering it?)');
    this.calibration = { dx: screen.x - seen.x, dy: screen.y - seen.y, innerHeight: seen.innerHeight };
    return this.calibration;
  }

  async point(target) {
    if (target.css === undefined && target.selection === undefined) return { x: target.x, y: target.y };
    if (target.scroll) {
      const scrolled = await this.js(RESOLVE_TARGET, [target]);
      if (scrolled.error?.startsWith('no element')) throw new Error(scrolled.error);
      await new Promise((r) => setTimeout(r, 400));
    }
    const at = await this.js(RESOLVE_TARGET, [{ ...target, scroll: false }]);
    if (at.error) throw new Error(at.error);
    if (!this.calibration || this.calibration.innerHeight !== at.innerHeight) await this.calibrate();
    return { x: at.x + this.calibration.dx, y: at.y + this.calibration.dy };
  }
}

const CALIBRATION_ARM = `
  window.__iosDeviceCal = null;
  const swallow = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  const onStart = (event) => {
    const touch = event.touches[0], vv = window.visualViewport;
    window.__iosDeviceCal = {
      x: (touch.clientX - vv.offsetLeft) * vv.scale,
      y: (touch.clientY - vv.offsetTop) * vv.scale,
      innerHeight: window.innerHeight,
    };
    swallow(event);
    removeEventListener('touchstart', onStart, true);
  };
  const onEnd = (event) => { swallow(event); removeEventListener('touchend', onEnd, true); };
  window.__iosDeviceCalDisarm = () => {
    removeEventListener('touchstart', onStart, true);
    removeEventListener('touchend', onEnd, true);
  };
  addEventListener('touchstart', onStart, { capture: true, passive: false });
  addEventListener('touchend', onEnd, { capture: true, passive: false });
  return true;`;

const RESOLVE_TARGET = `
  const t = arguments[0];
  let r;
  if (t.selection) {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return { error: 'no text selection to take the ' + t.selection + ' of' };
    const range = sel.getRangeAt(0), all = [...range.getClientRects()];
    const wide = all.filter((q) => q.width > 0);
    const rects = wide.length ? wide : all.length ? all : [range.getBoundingClientRect()];
    const q = t.selection === 'start' ? rects[0] : rects[rects.length - 1];
    const x = t.selection === 'start' ? q.left : q.right;
    r = { left: x, top: q.top, width: 0, height: q.height };
  } else {
    const el = document.querySelectorAll(t.css)[t.index || 0];
    if (!el) return { error: 'no element matches ' + t.css + (t.index ? ' at index ' + t.index : '') };
    if (t.scroll) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return { error: t.css + ' is not rendered (zero-size box)' };
  }
  const vv = window.visualViewport;
  const cx = r.left + r.width * (t.ax ?? 0.5) + (t.dx || 0);
  const cy = r.top + r.height * (t.ay ?? 0.5) + (t.dy || 0);
  const x = (cx - vv.offsetLeft) * vv.scale, y = (cy - vv.offsetTop) * vv.scale;
  if (x < 0 || y < 0 || x > vv.width * vv.scale || y > vv.height * vv.scale)
    return { error: (t.css ?? 'selection ' + t.selection) + ' is outside the visible viewport (add "scroll": true)' };
  return { x, y, innerHeight: window.innerHeight };`;

function tapAt(p, holdMs) {
  return [
    { type: 'pointerMove', duration: 0, x: Math.round(p.x), y: Math.round(p.y) },
    { type: 'pointerDown', button: 0 },
    { type: 'pause', duration: holdMs },
    { type: 'pointerUp', button: 0 },
  ];
}

async function poll(read, timeoutMs, intervalMs = 100) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() >= end) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const STEPS = {
  async open(d, s) {
    await d.appium('POST', '/url', { url: s.url });
    d.calibration = null;
  },
  async calibrate(d) {
    return d.calibrate();
  },
  async tap(d, s) {
    const p = await d.point(s.at);
    await d.touch(tapAt(p, 50));
    return p;
  },
  async press(d, s) {
    const p = await d.point(s.at);
    await d.touch(tapAt(p, s.ms ?? 800));
    return p;
  },
  async drag(d, s) {
    const from = await d.point(s.from);
    const to = await d.point(s.to);
    await d.touch([
      { type: 'pointerMove', duration: 0, x: Math.round(from.x), y: Math.round(from.y) },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: s.holdMs ?? 0 },
      { type: 'pointerMove', duration: s.ms ?? 600, x: Math.round(to.x), y: Math.round(to.y) },
      { type: 'pointerUp', button: 0 },
    ]);
    return { from, to };
  },
  async type(d, s) {
    await d.wda('POST', '/wda/keys', { value: [...s.text] });
  },
  async eval(d, s) {
    return d.js(s.js, s.args);
  },
  async check(d, s) {
    const value = await d.js(s.js, s.args);
    if (!value) throw new Error(`check failed: ${s.js} returned ${JSON.stringify(value)}`);
    return value;
  },
  async waitFor(d, s) {
    let lastError = null;
    const read = () => d.js(s.js, s.args).catch((error) => ((lastError = error.message), null));
    const value = await poll(read, s.timeoutMs ?? 5000, s.intervalMs ?? 100);
    if (!value) {
      throw new Error(
        `timed out after ${s.timeoutMs ?? 5000} ms waiting for: ${s.js}${lastError ? ` (last error: ${lastError})` : ''}`
      );
    }
    return value;
  },
  async sleep(_d, s) {
    await new Promise((r) => setTimeout(r, s.ms));
  },
  async shot(d, s, ctx) {
    return d.screenshot(ctx.out, `${String(ctx.index).padStart(2, '0')}-${s.name ?? 'shot'}.png`);
  },
};

async function liveSession(capsPath) {
  let saved = null;
  try {
    saved = JSON.parse(readFileSync(STATE_FILE, 'utf8')).appiumSession ?? null;
  } catch {
    saved = null;
  }
  if (saved) {
    const alive = await http(APPIUM, 'GET', `/session/${saved}/contexts`).then(
      () => true,
      () => false
    );
    if (alive) return saved;
  }
  if (!capsPath) {
    throw new Error(
      `no live Appium session${saved ? ` (saved ${saved} is gone)` : ''}; pass --caps <capabilities.json> to create one`
    );
  }
  const caps = JSON.parse(readFileSync(capsPath, 'utf8'));
  const created = await http(APPIUM, 'POST', '/session', { capabilities: { alwaysMatch: caps, firstMatch: [{}] } });
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ appiumSession: created.sessionId }));
  return created.sessionId;
}

async function enterWebContext(d, match) {
  const contexts = (await d.appium('GET', '/contexts')).filter((c) => c !== 'NATIVE_APP');
  for (const name of contexts.reverse()) {
    await d.appium('POST', '/context', { name });
    if (!match || (await d.js('return location.href')).includes(match)) return name;
  }
  throw new Error(match ? `no Safari page whose URL contains ${match}` : 'no Safari web context; is Safari open?');
}

export async function runScenario(scenario, { out, caps }) {
  const unknown = scenario.steps.map((step) => step.do).filter((name) => !Object.hasOwn(STEPS, name));
  if (unknown.length) throw new Error(`unknown step ${unknown.join(', ')}; known: ${Object.keys(STEPS).join(', ')}`);
  mkdirSync(out, { recursive: true });
  const started = Date.now();
  const appiumSession = await liveSession(caps);
  const { sessionId: wdaSession } = await fetch(`${WDA}/status`, { signal: AbortSignal.timeout(10_000) }).then((r) =>
    r.json()
  );
  if (!wdaSession) throw new Error(`WebDriverAgent at ${WDA} has no session`);
  const device = new Device(appiumSession, wdaSession);
  await device.wda('POST', '/appium/settings', { settings: { waitForIdleTimeout: 0, animationCoolOffTimeout: 0 } });
  const context = await enterWebContext(device, scenario.page);
  if (scenario.url) await STEPS.open(device, { url: scenario.url });

  const results = [];
  let index = 0;
  for (const step of scenario.steps) {
    index += 1;
    const run = STEPS[step.do];
    const t = Date.now();
    const result = { i: index, do: step.do, name: step.name, ok: true, ms: 0 };
    try {
      const value = await run(device, step, { out, index });
      if (value !== undefined) result.value = value;
    } catch (error) {
      result.ok = false;
      result.error = error.message;
      result.shot = await device.screenshot(out, `${String(index).padStart(2, '0')}-failure.png`).catch(() => null);
    }
    result.ms = Date.now() - t;
    results.push(result);
    process.stderr.write(
      `${result.ok ? 'ok  ' : 'FAIL'} ${index} ${step.do}${step.name ? ` ${step.name}` : ''} ${result.ms}ms${result.error ? ` ${result.error}` : ''}\n`
    );
    if (!result.ok && !scenario.keepGoing) break;
  }
  const report = {
    ok: results.length === scenario.steps.length && results.every((r) => r.ok),
    ms: Date.now() - started,
    context,
    calibration: device.calibration,
    steps: results,
  };
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}

function runRemote(opts) {
  const keyArgs = opts.sshKey ? ['-i', opts.sshKey, '-o', 'IdentitiesOnly=yes'] : [];
  const control = join(tmpdir(), `codeman-ios-ssh-${process.pid}`);
  const sshArgs = [
    ...keyArgs,
    '-o',
    'BatchMode=yes',
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${control}`,
    '-o',
    'ControlPersist=30',
  ];
  const remoteDir = `/tmp/codeman-ios-device-${process.pid}-${Date.now()}`;
  const localOut = resolve(opts.out ?? join(tmpdir(), basename(remoteDir)));
  const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}`);
  };
  run('ssh', [...sshArgs, opts.ssh, `mkdir -p ${quote(remoteDir)}`]);
  const files = [fileURLToPath(import.meta.url), opts.scenario, ...(opts.caps ? [opts.caps] : [])];
  run('scp', ['-q', ...sshArgs, ...files, `${opts.ssh}:${remoteDir}/`]);
  const remoteCmd = [
    `cd ${quote(remoteDir)} &&`,
    quote(opts.remoteNode),
    'ios-device.mjs',
    quote(basename(opts.scenario)),
    '--out out',
    ...(opts.caps ? ['--caps', quote(basename(opts.caps))] : []),
  ].join(' ');
  const remote = spawnSync('ssh', [...sshArgs, opts.ssh, `/bin/zsh -lc ${quote(remoteCmd)}`], { stdio: 'inherit' });
  const ran = remote.status === 0 || remote.status === 1;
  const copied = ran
    ? (mkdirSync(localOut, { recursive: true }),
      spawnSync('scp', ['-q', '-r', ...sshArgs, `${opts.ssh}:${remoteDir}/out/.`, localOut], { stdio: 'inherit' }))
    : null;
  if (!ran || copied.status === 0) {
    spawnSync('ssh', [...sshArgs, opts.ssh, `rm -rf ${quote(remoteDir)}`], { stdio: 'ignore' });
  }
  spawnSync('ssh', [...sshArgs, '-O', 'exit', opts.ssh], { stdio: 'ignore' });
  if (!ran) return 2;
  if (copied.status !== 0) {
    process.stderr.write(`ios-device: copying results back failed; they are still on ${opts.ssh}:${remoteDir}/out\n`);
    return 2;
  }
  process.stderr.write(`ios-device: report and screenshots in ${localOut}\n`);
  return remote.status === 0 || remote.status === 1 ? remote.status : 2;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.ssh) {
      process.exitCode = runRemote(opts);
    } else {
      const scenario = JSON.parse(readFileSync(opts.scenario, 'utf8'));
      const out = resolve(opts.out ?? join(tmpdir(), `codeman-ios-device-${Date.now()}`));
      const report = await runScenario(scenario, { out, caps: opts.caps });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = report.ok ? 0 : 1;
    }
  } catch (error) {
    process.stderr.write(`ios-device: ${error.message}\n`);
    process.exitCode = 2;
  }
}
