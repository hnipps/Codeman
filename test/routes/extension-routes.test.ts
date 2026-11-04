/**
 * POST /api/extensions/import and DELETE /api/extensions/:id with an injected service.
 */
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { registerExtensionRoutes } from '../../src/web/routes/extension-routes.js';
import type { ExtensionDeps } from '../../src/extensions/types.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function harness(): Promise<{ app: FastifyInstance; home: string; skill: string }> {
  const root = await mkdtemp(join(tmpdir(), 'codeman-ext-route-'));
  dirs.push(root);
  const home = join(root, 'home');
  const data = join(root, 'data');
  const skill = join(root, 'SKILL.md');
  await mkdir(home, { recursive: true });
  await writeFile(skill, '---\nname: Routed\ndescription: From a file\n---\n\n# Routed\n');
  const deps: ExtensionDeps = {
    homeDir: home,
    dataDir: data,
    now: () => new Date('2026-11-04T00:00:00.000Z'),
    binExists: async () => false,
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    clone: async () => undefined,
  };
  const app = Fastify({ logger: false });
  registerExtensionRoutes(app, () => deps);
  installRouteErrorHandler(app);
  await app.ready();
  return { app, home, skill };
}

describe('extension routes', () => {
  it('imports a SKILL.md by absolute path and removes it', async () => {
    const { app, home, skill } = await harness();
    const imported = await app.inject({ method: 'POST', url: '/api/extensions/import', payload: { path: skill } });
    expect(imported.statusCode).toBe(200);
    const body = imported.json();
    expect(body.data.installed[0].id).toBe('skill:routed');
    expect(body.data.installed[0].copies.some((copy: { path: string }) => copy.path.startsWith(home))).toBe(true);

    const listed = await app.inject({ method: 'GET', url: '/api/extensions' });
    expect(listed.json().data.items).toHaveLength(1);

    const removed = await app.inject({ method: 'DELETE', url: '/api/extensions/skill:routed' });
    expect(removed.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/extensions' });
    expect(after.json().data.items).toEqual([]);
    await app.close();
  });

  it('rejects a body that names both a repository and a path', async () => {
    const { app } = await harness();
    const res = await app.inject({
      method: 'POST',
      url: '/api/extensions/import',
      payload: { github: 'acme/plugins', path: '/tmp/skill' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('INVALID_INPUT');
    await app.close();
  });
});
