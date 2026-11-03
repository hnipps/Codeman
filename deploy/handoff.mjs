#!/usr/bin/env node
/**
 * Hand the live deploy role from one running Codeman to another, for a blue-green supervisor.
 *
 *   node deploy/handoff.mjs --new-port 3102 [--old-port 3101] [--host 127.0.0.1]
 *
 * Retires the old colour (it writes its view of the shared files once, then stops writing
 * and acting on panes), then promotes the new one (it re-reads those files and takes over).
 * Without --old-port it only promotes. An old colour that answers 404 is an older release
 * without the role endpoint: it is left as it is, with a warning on stderr, and the handoff
 * continues.
 *
 * Any failure puts the old colour back as it was before this ran and exits 1; a usage error
 * exits 2. Prints ONE JSON line `{ ok, steps: [{ name, ok, detail }] }`. Uses HTTP Basic auth
 * from CODEMAN_USERNAME (default admin) and CODEMAN_PASSWORD when the password is set.
 * Zero dependencies.
 */
import { parseArgs } from 'node:util';

const RETIRE_TIMEOUT_MS = 30_000;
// Promotion re-attaches every session, so it takes longer the more there are.
const PROMOTE_TIMEOUT_MS = 120_000;

function usageError(message) {
  console.log(JSON.stringify({ ok: false, steps: [{ name: 'args', ok: false, detail: message }] }));
  process.exit(2);
}

function parsePort(value, flag) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) usageError(`${flag} <1-65535> is required`);
  return port;
}

let args;
try {
  args = parseArgs({
    options: {
      'new-port': { type: 'string' },
      'old-port': { type: 'string' },
      host: { type: 'string', default: '127.0.0.1' },
    },
    strict: true,
  }).values;
} catch (err) {
  usageError(err.message);
}
const newPort = parsePort(args['new-port'], '--new-port');
const oldPort = args['old-port'] === undefined ? null : parsePort(args['old-port'], '--old-port');
if (oldPort === newPort) usageError('--old-port and --new-port must differ');

const host = args.host.includes(':') ? `[${args.host}]` : args.host;
const password = process.env.CODEMAN_PASSWORD;
const headers = { 'content-type': 'application/json' };
if (password) {
  headers.authorization =
    'Basic ' + Buffer.from(`${process.env.CODEMAN_USERNAME || 'admin'}:${password}`).toString('base64');
}

/** POST a role; never throws. `status` is 0 when no HTTP answer came back. */
async function setRole(port, role, timeoutMs) {
  try {
    const res = await fetch(`http://${host}:${port}/api/deploy/role`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ role }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => null);
    const detail = res.ok
      ? `${body?.data?.previous} -> ${body?.data?.role}`
      : `HTTP ${res.status}${body?.error ? `: ${body.error}` : ''}`;
    return { status: res.status, detail };
  } catch (err) {
    return { status: 0, detail: err instanceof Error ? err.message : String(err) };
  }
}

const steps = [];
function finish(ok) {
  console.log(JSON.stringify({ ok, steps }));
  process.exit(ok ? 0 : 1);
}

/** Put the old colour back to live. Live -> live is a no-op, so this is safe whatever the retire did. */
async function reinstateOld() {
  const result = await setRole(oldPort, 'live', RETIRE_TIMEOUT_MS);
  steps.push({ name: 'reinstate-old', ok: result.status === 200, detail: result.detail });
}

let oldRetired = false;
if (oldPort !== null) {
  const result = await setRole(oldPort, 'retired', RETIRE_TIMEOUT_MS);
  if (result.status === 200) {
    oldRetired = true;
    steps.push({ name: 'retire-old', ok: true, detail: result.detail });
  } else if (result.status === 404) {
    console.error(
      `handoff: the colour on port ${oldPort} has no /api/deploy/role (an older release), so it cannot retire. ` +
        'It keeps writing until it is stopped, and its shutdown flush will overwrite state.json with its view.'
    );
    steps.push({ name: 'retire-old', ok: true, detail: 'skipped: older release without /api/deploy/role' });
  } else {
    steps.push({ name: 'retire-old', ok: false, detail: result.detail });
    // A refusal (409) changed nothing; anything else may have left it retired.
    if (result.status !== 409) await reinstateOld();
    finish(false);
  }
}

const promoted = await setRole(newPort, 'live', PROMOTE_TIMEOUT_MS);
if (promoted.status === 200) {
  steps.push({ name: 'promote-new', ok: true, detail: promoted.detail });
  finish(true);
}
steps.push({ name: 'promote-new', ok: false, detail: promoted.detail });

// A promotion that completed after the wait gave up would leave two live colours; retiring
// the new one first means the old colour's reinstate flush is the last write.
const demoted = await setRole(newPort, 'retired', RETIRE_TIMEOUT_MS);
steps.push({
  name: 'retire-new',
  ok: demoted.status === 200 || demoted.status === 409,
  detail: demoted.status === 409 ? `still a candidate (${demoted.detail})` : demoted.detail,
});
if (oldRetired) await reinstateOld();
finish(false);
