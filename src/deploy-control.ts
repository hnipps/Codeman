/**
 * @fileoverview The browser's view of the deploy supervisor, and the one action it may ask for.
 *
 * The supervisor is a separate program, reached only through the command line named by
 * `CODEMAN_SUPERVISOR_CLI`. Its status JSON is parsed here and cut down to
 * {@link DeployOverview}; nothing else it prints (ports, log files, colours) reaches a browser.
 * A rollback is queued with `request rollback <target>`, which runs in the supervisor's own
 * service. Once it has printed its `queued request <id>` line the child is left to finish
 * on its own, because a successful rollback stops the very process that asked for it.
 */

import { execFile, spawn } from 'node:child_process';
import type { Socket } from 'node:net';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

export type RollbackTarget = 'previous' | string;

export interface DeployOverviewConfigured {
  configured: true;
  live: { sha: string; since: string } | null;
  releases: { sha: string; builtAt: string; live: boolean }[];
  recent: DeployRecord[];
  busy: boolean;
}

export interface DeployRecord {
  id: string;
  action: 'deploy' | 'rollback';
  sha: string | null;
  outcome: string;
  failedStep: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export type DeployOverview = { configured: false } | DeployOverviewConfigured;

export const STATUS_TIMEOUT_MS = 10_000;
export const QUEUE_TIMEOUT_MS = 15_000;
const MAX_RECENT = 5;
const MAX_ERROR_CHARS = 200;
const QUEUED_LINE = /^queued request (\S+)$/m;

/** Thrown with a message that is safe to show a browser: no stack, no paths. */
export class DeployControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeployControlError';
  }
}

const StatusSchema = z.object({
  live: z.object({ sha: z.string(), since: z.string() }).nullable().optional(),
  releases: z.array(z.object({ sha: z.string(), builtAt: z.string() })),
  deploys: z.array(
    z.object({
      id: z.string(),
      // The supervisor records other actions too (such as `start-live` at boot); those are skipped, not fatal.
      action: z.string(),
      sha: z.string().nullable().optional(),
      outcome: z.string(),
      failedStep: z.string().nullable().optional(),
      startedAt: z.string(),
      finishedAt: z.string().nullable().optional(),
    })
  ),
  lock: z.unknown().optional(),
});

/** The CLI path from the environment, or null when unset, empty or not absolute. */
export function supervisorCli(env: NodeJS.ProcessEnv = process.env): string | null {
  const path = (env.CODEMAN_SUPERVISOR_CLI ?? '').trim();
  return path !== '' && isAbsolute(path) ? path : null;
}

/** Cut the supervisor's `status --json` down to what the browser may see. Throws on a shape it does not know. */
export function parseStatus(json: unknown): DeployOverviewConfigured {
  const status = StatusSchema.parse(json);
  const liveSha = status.live?.sha ?? null;
  const recent = status.deploys
    .filter((d): d is typeof d & { action: DeployRecord['action'] } => d.action === 'deploy' || d.action === 'rollback')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, MAX_RECENT)
    .map((d) => ({
      id: d.id,
      action: d.action,
      sha: d.sha ?? null,
      outcome: d.outcome,
      failedStep: d.failedStep ?? null,
      startedAt: d.startedAt,
      finishedAt: d.finishedAt ?? null,
    }));
  return {
    configured: true,
    live: status.live ? { sha: status.live.sha, since: status.live.since } : null,
    releases: status.releases.map((r) => ({ sha: r.sha, builtAt: r.builtAt, live: r.sha === liveSha })),
    recent,
    busy: status.lock != null,
  };
}

export async function readOverview(cli: string): Promise<DeployOverviewConfigured> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(cli, ['status', '--json'], { timeout: STATUS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) reject(new DeployControlError('The deploy supervisor did not answer'));
      else resolve(out);
    });
  });
  try {
    return parseStatus(JSON.parse(stdout));
  } catch {
    throw new DeployControlError('The deploy supervisor answered with something unreadable');
  }
}

function lastLine(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return (lines[lines.length - 1] ?? '').slice(0, MAX_ERROR_CHARS);
}

/**
 * Queue a rollback and resolve with the request id as soon as the supervisor prints it. The child is
 * then detached from this process's event loop and its output kept drained; nothing waits on its exit.
 */
export function requestRollback(
  cli: string,
  target: RollbackTarget,
  timeoutMs: number = QUEUE_TIMEOUT_MS
): Promise<{ requestId: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, ['request', 'rollback', target], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const fail = (fallback: string): void =>
      settle(() => {
        child.kill();
        reject(new DeployControlError(lastLine(stderr) || fallback));
      });

    const timer = setTimeout(() => fail('The deploy supervisor did not queue the rollback in time'), timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdout += chunk.toString();
      const match = QUEUED_LINE.exec(stdout);
      if (match) {
        settle(() => {
          child.unref();
          (child.stdout as Socket).unref();
          (child.stderr as Socket).unref();
          resolve({ requestId: match[1] });
        });
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (!settled) stderr = (stderr + chunk.toString()).slice(-2048);
    });
    child.on('error', () => fail('The deploy supervisor could not be started'));
    child.on('close', () => fail('The deploy supervisor exited before queuing the rollback'));
  });
}
