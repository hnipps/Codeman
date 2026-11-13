/**
 * @fileoverview The one answer to a canvas route failure the server caused (5xx).
 *
 * The client gets a sentence with no filesystem path and the request id. The cause goes to one
 * `console.error` line, which file telemetry mirrors into `server.jsonl`, carrying the same request id
 * as the `requests.jsonl` line so the two can be joined. A 4xx is the caller's and writes nothing.
 */
import { homedir } from 'node:os';
import { basename } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getDataDir } from '../../config/instance.js';
import { describeUnknownPath, type PathProbeOptions } from '../../utils/bounded-path-probe.js';
import { ApiErrorCode, createErrorResponse, getErrorMessage } from '../../types.js';

export const CANVAS_FAILURE_MESSAGE = 'The canvas request failed on the server';

const FILE_ROLES: Record<string, string> = {
  'ops.jsonl': 'operation log',
  'snapshot.json': 'snapshot',
  'conversations.json': 'conversations',
  'workspaces.json': 'workspace registry',
};

/** The cause in words an agent can act on: errno, what the file is for, and the message with the data and home directories named, not spelled out. */
export function describeCanvasFailure(error: unknown, dataDir = getDataDir(), home = homedir()): string {
  const failure = error as NodeJS.ErrnoException | null;
  const scrub = (text: string): string =>
    [
      [dataDir, '<data dir>'],
      [home, '~'],
    ].reduce((out, [dir, name]) => (dir.length > 1 ? out.split(dir).join(name) : out), text);
  const role = typeof failure?.path === 'string' ? FILE_ROLES[basename(failure.path)] : undefined;
  return [
    typeof failure?.code === 'string' ? `errno=${failure.code}` : '',
    role ? `file="${role}"` : '',
    scrub(getErrorMessage(error)),
  ]
    .filter(Boolean)
    .join(' ');
}

/** Logs the cause and answers `status` (a 5xx). `message` replaces the fixed sentence and must carry no path. */
export function canvasFailure(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  error: unknown,
  message = `${CANVAS_FAILURE_MESSAGE} (request ${req.id})`
): FastifyReply {
  const workspaceId = (req.params as { workspaceId?: unknown } | undefined)?.workspaceId;
  console.error(
    `[canvas] ${req.method} ${req.routeOptions?.url ?? 'unmatched route'} failed ${status} reqId=${req.id}` +
      (typeof workspaceId === 'string' ? ` workspace=${workspaceId}` : '') +
      ` ${describeCanvasFailure(error)}`
  );
  return reply.code(status).send({
    ...createErrorResponse(ApiErrorCode.OPERATION_FAILED, message),
    requestId: req.id,
  });
}

/** The 503 for a case folder whose mount is not answering: the sentence without the folder, which goes to the log. */
export function caseFolderUnavailable(
  req: FastifyRequest,
  reply: FastifyReply,
  folder: string,
  options: PathProbeOptions = {}
): FastifyReply {
  const detail = describeUnknownPath('Case folder', folder, options);
  return canvasFailure(req, reply, 503, detail, detail.replace(`: ${folder}`, ''));
}
