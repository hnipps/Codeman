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

function logCanvasFailure(req: FastifyRequest, status: number, error: unknown): void {
  const workspaceId = (req.params as { workspaceId?: unknown } | undefined)?.workspaceId;
  console.error(
    `[canvas] ${req.method} ${routeOf(req)} failed ${status} reqId=${req.id}` +
      (typeof workspaceId === 'string' ? ` workspace=${workspaceId}` : '') +
      ` ${describeCanvasFailure(error)}`
  );
}
const routeOf = (req: FastifyRequest): string => req.routeOptions?.url ?? 'unmatched route';

/** Logs the cause and answers `status` (a 5xx). `message` replaces the fixed sentence and must carry no path. */
export function canvasFailure(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  error: unknown,
  message = `${CANVAS_FAILURE_MESSAGE} (request ${req.id})`,
  log = true
): FastifyReply {
  if (log) logCanvasFailure(req, status, error);
  return reply.code(status).send({
    ...createErrorResponse(ApiErrorCode.OPERATION_FAILED, message),
    requestId: req.id,
  });
}

/**
 * Folders a polled route last found not answering, by route and folder. A page asks every few seconds, so the
 * error line is written when a folder stops answering and one more line when it answers again, not per poll.
 */
const stalledFolders = new Set<string>();
const STALLED_FOLDERS_MAX = 1000;
const stalledKey = (req: FastifyRequest, folder: string): string => `${routeOf(req)}\0${folder}`;

/**
 * The 503 for a case folder whose mount is not answering: the sentence without the folder, which goes to the
 * log. A `polled` route logs the first such answer for a folder and stays quiet until `caseFolderAnswered()`.
 */
export function caseFolderUnavailable(
  req: FastifyRequest,
  reply: FastifyReply,
  folder: string,
  options: PathProbeOptions & { polled?: boolean } = {}
): FastifyReply {
  const { polled = false, ...probe } = options;
  const detail = describeUnknownPath('Case folder', folder, probe);
  const key = stalledKey(req, folder);
  const repeat = polled && stalledFolders.has(key);
  if (polled && !repeat) {
    if (stalledFolders.size >= STALLED_FOLDERS_MAX) stalledFolders.clear();
    stalledFolders.add(key);
  }
  return canvasFailure(req, reply, 503, detail, detail.replace(`: ${folder}`, ''), !repeat);
}

/** A polled route read the folder: if its last answer was the 503 above, say once that it is back. */
export function caseFolderAnswered(req: FastifyRequest, folder: string): void {
  if (!stalledFolders.delete(stalledKey(req, folder))) return;
  const workspaceId = (req.params as { workspaceId?: unknown } | undefined)?.workspaceId;
  console.log(
    `[canvas] ${req.method} ${routeOf(req)} recovered reqId=${req.id}` +
      (typeof workspaceId === 'string' ? ` workspace=${workspaceId}` : '') +
      ' the case folder is answering again'
  );
}
