/**
 * @fileoverview Import and remove plugins and skills.
 *
 * GET    /api/extensions           — the catalog (copies and per-CLI results, never file contents)
 * POST   /api/extensions/import    — JSON `{ github }` or `{ path }`, or a multipart `file`
 * DELETE /api/extensions/:id       — uninstall and delete one Codeman-owned import
 *
 * `path` is an absolute path on this host. `github` is a github.com repository.
 * An optional `case` (a case name) also copies skills into that case. Writes are
 * admin-only in multi-user mode. The same service backs `codeman extension`.
 *
 * @module web/routes/extension-routes
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { resolveCliCasePath } from '../../cli.js';
import { importExtensions, listExtensions, removeExtension, defaultExtensionDeps } from '../../extensions/service.js';
import { ExtensionError, type ExtensionDeps } from '../../extensions/types.js';
import { ApiErrorCode, createErrorResponse, getErrorMessage, httpStatusForErrorCode } from '../../types.js';
import { parseBody, requireAdmin } from '../route-helpers.js';

const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
const CASE_NAME = /^[a-zA-Z0-9_-]+$/;

const ImportSchema = z
  .object({
    github: z.string().min(1).max(500).optional(),
    path: z.string().min(1).max(4096).optional(),
    case: z.string().regex(CASE_NAME).optional(),
  })
  .strict()
  .refine((body) => Number(Boolean(body.github)) + Number(Boolean(body.path)) === 1, {
    message: 'Provide a GitHub repository or a path, not both.',
  });

function sendFailure(reply: FastifyReply, err: unknown) {
  if (err instanceof ExtensionError) {
    const code =
      err.code === 'NOT_FOUND'
        ? ApiErrorCode.NOT_FOUND
        : err.code === 'CONFLICT'
          ? ApiErrorCode.CONFLICT
          : err.code === 'OPERATION_FAILED'
            ? ApiErrorCode.OPERATION_FAILED
            : ApiErrorCode.INVALID_INPUT;
    reply.code(httpStatusForErrorCode(code));
    return createErrorResponse(code, err.message);
  }
  const structured = err as { statusCode?: number; body?: ReturnType<typeof createErrorResponse> };
  if (structured.body && structured.statusCode) {
    reply.code(structured.statusCode);
    return structured.body;
  }
  reply.code(500);
  return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
}

function caseDir(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const dir = resolveCliCasePath(name);
  if (!existsSync(dir)) {
    throw Object.assign(new Error(`Case not found: ${name}`), {
      statusCode: 400,
      body: createErrorResponse(ApiErrorCode.INVALID_INPUT, `Case not found: ${name}`),
    });
  }
  return dir;
}

function fieldText(fields: unknown, name: string): string | undefined {
  if (!fields || typeof fields !== 'object') return undefined;
  const field = (fields as Record<string, { value?: unknown } | { value?: unknown }[] | undefined>)[name];
  const one = Array.isArray(field) ? field[0] : field;
  return one && typeof one.value === 'string' ? one.value : undefined;
}

async function writeUpload(stream: AsyncIterable<Buffer>, dest: string): Promise<void> {
  const handle = await open(dest, 'w', 0o600);
  let total = 0;
  try {
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > MAX_UPLOAD_BYTES) {
        throw new ExtensionError('INVALID_INPUT', 'That file is larger than 32 MB. Import a subdirectory.');
      }
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }
}

export function registerExtensionRoutes(app: FastifyInstance, deps: () => ExtensionDeps = defaultExtensionDeps): void {
  app.get('/api/extensions', async (_req, reply) => {
    try {
      const items = await listExtensions(deps());
      return { success: true, data: { items } };
    } catch (err) {
      return sendFailure(reply, err);
    }
  });

  app.post('/api/extensions/import', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const use = deps;
    try {
      const multipart = typeof req.isMultipart === 'function' && req.isMultipart();
      if (multipart) {
        const part = await req.file();
        if (!part || part.fieldname !== 'file') {
          reply.code(400);
          return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Upload the archive or SKILL.md as the file field.');
        }
        const filename = basename(part.filename || 'upload').replace(/[^\w.\- ]+/g, '');
        if (!filename || filename === '.' || filename === '..') {
          reply.code(400);
          return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'That file name is not usable.');
        }
        const caseName = fieldText(part.fields, 'case');
        if (caseName && !CASE_NAME.test(caseName)) {
          reply.code(400);
          return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Case names use letters, numbers, "_" and "-".');
        }
        const tmp = join(tmpdir(), `codeman-ext-${randomBytes(8).toString('hex')}-${filename}`);
        try {
          await writeUpload(part.file, tmp);
          if (part.file.truncated) {
            throw new ExtensionError('INVALID_INPUT', 'That file is larger than 32 MB. Import a subdirectory.');
          }
          const data = await importExtensions({ path: tmp, filename, caseDir: caseDir(caseName || undefined) }, use());
          return { success: true, data };
        } finally {
          await unlink(tmp).catch(() => undefined);
        }
      }

      const body = parseBody(ImportSchema, req.body);
      if (body.path && !body.path.startsWith('/')) {
        reply.code(400);
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'The path must be absolute on this host.');
      }
      const data = await importExtensions({ github: body.github, path: body.path, caseDir: caseDir(body.case) }, use());
      return { success: true, data };
    } catch (err) {
      return sendFailure(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/extensions/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!/^(skill|plugin):[a-z0-9][a-z0-9-]{0,70}$/.test(req.params.id)) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'That extension id is not valid.');
    }
    try {
      const removed = await removeExtension(req.params.id, deps());
      return { success: true, data: removed };
    } catch (err) {
      return sendFailure(reply, err);
    }
  });
}
