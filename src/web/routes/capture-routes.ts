/**
 * @fileoverview Ambient capture routes (intent/2026-11-19-ambient-capture.md, ticket 4).
 *
 * `GET /api/capture/home-case` answers the name of Codeman's own case (`findHomeCase()` in
 * src/capture-home-case.ts), which the browser's capture filing uses when no canvas workspace is on
 * screen and no session is shown (I7, rule `home`). It reads only: filing itself goes through the
 * existing canvas routes.
 *
 * - `200 { success: true, data: { caseName } }`
 * - `404` with `reason: "NO_HOME_CASE"` (errorCode `NOT_FOUND`) when no case qualifies
 * - `403 FORBIDDEN` for a non-admin in multi-user mode (the answer names a server-wide folder)
 *
 * Internal: the route is not part of the versioned API, so `/api/v1/capture/*` is not rewritten to it
 * (`rewriteApiV1Url()` in server.ts) and answers 404.
 */

import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { createHomeCaseCache, findHomeCase, type HomeCaseDeps } from '../../capture-home-case.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { dataPath, getDataDir } from '../../config/instance.js';
import { readRemoteCases } from '../../remote-hosts.js';
import { readDockerCases } from '../../docker-hosts.js';
import { readJsonConfig, requireAdmin, resolveCasesDir } from '../route-helpers.js';
import { defaultDockerWorkspaces } from './worktree-routes.js';

const SAFE_CASE_NAME = /^[a-zA-Z0-9_-]+$/;
export const NO_HOME_CASE = 'NO_HOME_CASE';

/** Local cases of the admin's (or single user's) case space plus the linked cases. */
async function localCases(casesDir: string): Promise<Array<{ name: string; path: string }>> {
  const out: Array<{ name: string; path: string }> = [];
  try {
    for (const e of await fs.readdir(casesDir, { withFileTypes: true }))
      if (e.isDirectory() && SAFE_CASE_NAME.test(e.name)) out.push({ name: e.name, path: join(casesDir, e.name) });
  } catch {
    // No cases folder yet.
  }
  const seen = new Set(out.map((c) => c.name));
  const linked = await readJsonConfig<Record<string, string>>(dataPath('linked-cases.json'), 'linked cases', {});
  for (const [name, path] of Object.entries(linked))
    if (!seen.has(name) && SAFE_CASE_NAME.test(name) && typeof path === 'string') out.push({ name, path });
  return out;
}

export function registerCaptureRoutes(app: FastifyInstance, overrides: Partial<HomeCaseDeps> = {}): void {
  const installDir = dirname(fileURLToPath(import.meta.url));
  const cache = createHomeCaseCache(() =>
    findHomeCase({
      cases: () => localCases(resolveCasesDir(undefined)),
      foreignNames: async () => [
        ...(await readRemoteCases(getDataDir()).catch(() => [])).map((c) => c.name),
        ...(await readDockerCases(getDataDir()).catch(() => [])).map((c) => c.name),
      ],
      dockerWorkspaces: defaultDockerWorkspaces,
      buildId: process.env.CODEMAN_BUILD_ID,
      installDir,
      ...overrides,
    })
  );

  app.get('/api/capture/home-case', async (req, reply) => {
    if (isMultiUserMode() && !requireAdmin(req, reply)) return reply;
    const caseName = await cache.get();
    if (!caseName)
      return reply.code(404).send({
        ...createErrorResponse(ApiErrorCode.NOT_FOUND, `${NO_HOME_CASE}: no case holds Codeman's own source`),
        reason: NO_HOME_CASE,
      });
    return { success: true, data: { caseName } };
  });
}
