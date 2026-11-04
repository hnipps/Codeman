/**
 * Login sessions across a blue-green handoff, with real WebServers (port 0) on one data
 * dir: the retire flushes the live colour's logins and then writes nothing, the candidate
 * writes none while it stands by, and the promoted colour takes over every saved login,
 * including one saved after the candidate booted. The deploy role is process-wide, so the
 * colours take turns here, as in deploy-colours.test.ts.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dataPath } from '../src/config/instance.js';
import { WebServer } from '../src/web/server.js';
import { AUTH_SESSIONS_FILE, authSessionKey } from '../src/web/auth-session-store.js';

const USER = 'admin';
const PASS = 'colour-handoff-password';
const basic = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
// Longer than the store's 250 ms write delay, so a write that was going to happen has.
const SETTLE_MS = 600;
const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

const servers: WebServer[] = [];
const file = () => dataPath(AUTH_SESSIONS_FILE);
const fileHash = () => (existsSync(file()) ? createHash('sha256').update(readFileSync(file())).digest('hex') : null);

beforeAll(() => {
  process.env.CODEMAN_PASSWORD = PASS;
  process.env.CODEMAN_USERNAME = USER;
  rmSync(file(), { force: true });
});

afterAll(async () => {
  for (const s of servers) await s.stop().catch(() => {});
  delete process.env.CODEMAN_DEPLOY_ROLE;
  delete process.env.CODEMAN_PASSWORD;
  delete process.env.CODEMAN_USERNAME;
  rmSync(file(), { force: true });
});

async function boot(role: 'candidate' | 'live'): Promise<WebServer> {
  process.env.CODEMAN_DEPLOY_ROLE = role;
  const s = new WebServer(0, false, true);
  await s.start();
  servers.push(s);
  return s;
}

const at = (s: WebServer, path: string) => `http://127.0.0.1:${s.boundPort}${path}`;

async function login(s: WebServer): Promise<string> {
  const res = await fetch(at(s, '/api/status'), { headers: { Authorization: basic } });
  expect(res.status).toBe(200);
  return `codeman_session=${res.headers.get('set-cookie')!.match(/codeman_session=([^;]+)/)![1]}`;
}

const statusWith = async (s: WebServer, cookie: string) =>
  (await fetch(at(s, '/api/status'), { headers: { Cookie: cookie } })).status;

async function setRole(s: WebServer, role: 'live' | 'retired') {
  const res = await fetch(at(s, '/api/deploy/role'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: basic },
    body: JSON.stringify({ role }),
  });
  return res.json();
}

describe('login sessions across a deploy handoff', () => {
  it('the retire flushes and stops writing, a candidate writes nothing, the promotion takes over', async () => {
    const blue = await boot('live');
    const kept = await login(blue);
    const loggedOutLate = await login(blue);
    expect(await setRole(blue, 'retired')).toEqual({ success: true, data: { role: 'retired', previous: 'live' } });
    // Read at once, inside the write delay: the retire's own flush put them there.
    const atRetire = fileHash();
    expect(atRetire).not.toBeNull();

    // Nothing a retired colour does reaches the file, its shutdown included.
    await fetch(at(blue, '/api/logout'), { method: 'POST', headers: { Cookie: loggedOutLate } });
    await login(blue);
    await settle();
    await blue.stop();
    expect(fileHash()).toBe(atRetire);

    const green = await boot('candidate');
    // The candidate read the logins at boot, and writes nothing while it serves requests.
    expect(await statusWith(green, kept)).toBe(200);
    const mintedByCandidate = await login(green);
    await settle();
    expect(fileHash()).toBe(atRetire);

    // A login the old colour saved after this candidate booted (in a real deploy both run at once).
    const overlapToken = 'f'.repeat(64);
    const saved = JSON.parse(readFileSync(file(), 'utf-8'));
    const now = Date.now();
    saved.sessions.push({
      key: authSessionKey(overlapToken),
      createdAt: now,
      lastAccessedAt: now,
      record: { ip: '127.0.0.1', ua: 'test', createdAt: now, method: 'basic' },
    });
    writeFileSync(file(), JSON.stringify(saved));
    const overlap = `codeman_session=${overlapToken}`;
    expect(await statusWith(green, overlap)).toBe(401);

    expect(await setRole(green, 'live')).toEqual({ success: true, data: { role: 'live', previous: 'candidate' } });
    expect(await statusWith(green, kept)).toBe(200);
    expect(await statusWith(green, overlap)).toBe(200);
    expect(await statusWith(green, loggedOutLate)).toBe(200); // the retired colour's logout never landed
    // What the candidate minted for itself was never on disk, so the takeover drops it.
    expect(await statusWith(green, mintedByCandidate)).toBe(401);

    // Now live, green writes: a logout there holds for the next process.
    await fetch(at(green, '/api/logout'), { method: 'POST', headers: { Cookie: overlap } });
    await green.stop();

    const next = await boot('live');
    expect(await statusWith(next, kept)).toBe(200);
    expect(await statusWith(next, overlap)).toBe(401);
  });
});
