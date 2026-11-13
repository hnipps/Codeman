/**
 * @fileoverview Canvas shell in multi-user mode (PC13): only an admin can change the shell switch, and `/` opens
 * only a workspace the caller owns, whatever the remembered-workspace cookie names.
 *
 * Port: 0 (live server on an ephemeral port, read from `boundPort`).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebServer } from '../src/web/server.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { createUser, invalidateUsersCache } from '../src/user-store.js';
import { dataPath } from '../src/config/instance.js';
import { workspaceForCase } from '../src/canvas/workspace-registry.js';

vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);

const basic = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const url = (p: string) => `http://localhost:${server.boundPort}${p}`;
const admin = { Authorization: basic('root', 'rootpass123') };
const joe = { Authorization: basic('joe', 'joepass1234') };
const amy = { Authorization: basic('amy', 'amypass1234') };
const shown = (body: string) => /name="codeman-canvas-workspace" content="([^"]*)"/.exec(body)?.[1];

let server: WebServer;
let spacesDir: string;
let joeWorkspace: string;
let rootWorkspace: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ['CODEMAN_USER_SPACES_DIR', 'CODEMAN_MULTIUSER', 'CODEMAN_PASSWORD', 'CODEMAN_USERNAME'];

beforeAll(async () => {
  spacesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shell-mu-spaces-'));
  // The data directory is this file's own temporary HOME (test/setup.ts); the settings path is fixed at import.
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.CODEMAN_USER_SPACES_DIR = spacesDir;
  process.env.CODEMAN_MULTIUSER = '1';
  delete process.env.CODEMAN_PASSWORD;
  delete process.env.CODEMAN_USERNAME;
  invalidateUsersCache();
  await createUser({ username: 'root', role: 'admin', password: 'rootpass123' });
  await createUser({ username: 'joe', role: 'user', password: 'joepass1234' });
  await createUser({ username: 'amy', role: 'user', password: 'amypass1234' });
  writeFileSync(dataPath('settings.json'), JSON.stringify({ canvasEnabled: true, canvasShellEnabled: true }));
  rootWorkspace = workspaceForCase('ops', 'root').id;
  joeWorkspace = workspaceForCase('notes', 'joe').id;
  server = new WebServer(0, false, true);
  await server.start();
}, 60000);

afterAll(async () => {
  await server?.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  invalidateUsersCache();
  await fs.rm(spacesDir, { recursive: true, force: true }).catch(() => {});
}, 60000);

describe('canvas shell in multi-user mode', () => {
  it('refuses a non-admin who tries to change the shell switch and leaves the file as it was', async () => {
    const before = readFileSync(dataPath('settings.json'), 'utf8');
    for (const body of [{ canvasShellEnabled: false }, { canvasShellEnabled: true, canvasEnabled: false }]) {
      const res = await fetch(url('/api/settings'), {
        method: 'PUT',
        headers: { ...joe, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);
    }
    expect(readFileSync(dataPath('settings.json'), 'utf8')).toBe(before);
  });

  it('lets an admin change it', async () => {
    const put = (body: unknown) =>
      fetch(url('/api/settings'), {
        method: 'PUT',
        headers: { ...admin, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await put({ canvasShellEnabled: false })).status).toBe(200);
    expect(await (await fetch(url('/'), { headers: joe })).text()).not.toContain('data-canvas');
    expect((await put({ canvasShellEnabled: true })).status).toBe(200);
  });

  it("opens only the caller's own workspace on `/`, whatever the cookie names", async () => {
    const mine = await (await fetch(url('/'), { headers: joe })).text();
    expect(shown(mine)).toBe(joeWorkspace);
    expect(mine).toContain('<meta name="codeman-canvas-viewer" content="joe" />');
    const withCookie = await fetch(url('/'), { headers: { ...joe, Cookie: `codeman_canvas_ws=${rootWorkspace}` } });
    expect(shown(await withCookie.text())).toBe(joeWorkspace);
    expect((await fetch(url(`/canvas/${rootWorkspace}`), { headers: joe })).status).toBe(404);
    // An admin may open any workspace, and the cookie picks among them.
    const asAdmin = await fetch(url('/'), { headers: { ...admin, Cookie: `codeman_canvas_ws=${joeWorkspace}` } });
    expect(shown(await asAdmin.text())).toBe(joeWorkspace);
  });

  it('shows the first-run page to a person with no workspace, not someone else’s canvas', async () => {
    const body = await (await fetch(url('/'), { headers: amy })).text();
    expect(shown(body)).toBe('');
    expect(body).toMatch(/src="canvas-home\.js/);
    expect(body).not.toContain(joeWorkspace);
    expect(body).not.toContain(rootWorkspace);
  });

  it('asks for credentials before it answers `/`, shell on or off', async () => {
    const res = await fetch(url('/'));
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('data-canvas');
  });
});
