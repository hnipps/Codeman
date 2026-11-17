/**
 * @fileoverview Open live: a reviewed branch of Codeman itself, running in its own throwaway VM.
 *
 * The app never talks to the machine that runs those VMs. It asks the deploy supervisor, with
 * `<CODEMAN_SUPERVISOR_CLI> review create|use|release|destroy|status`, and the supervisor passes the request on
 * (`docs/review-instance-address-plan.md`). Each command prints one line of JSON.
 *
 * Rules:
 * - Off unless the supervisor says it has the commands, by setting `CODEMAN_REVIEW_PREVIEWS=1` in this process's
 *   environment. An older supervisor is never sent a `review` argument.
 * - Nothing is stored. A review's preview is the one the supervisor lists for the review's `headSha`, so a
 *   rollback to a release without this file loses nothing.
 * - Everything the supervisor prints is checked before use: a preview id is 8 hex characters, a hostname is a
 *   plain DNS name. The hostname is only ever a value read at run time; no zone is written in this repository.
 * - argv only, a timeout on every call, and an error message that is safe to show a browser.
 */
import { execFile } from 'node:child_process';
import { z } from 'zod';
import { supervisorCli } from '../deploy-control.js';

export const PREVIEW_ID = /^[0-9a-f]{8}$/;
const HOSTNAME = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const SHA = /^[0-9a-f]{40}$/;

/** `create` and `release` answer at once; `use` waits for a wake, which is slow when the cap is full. */
export const LIVE_TIMEOUT_MS = { create: 60_000, use: 60_000, release: 15_000, destroy: 30_000, status: 10_000 };
const STATUS_TTL_MS = 3_000;
const MAX_PREVIEWS = 50;

export const LIVE_STATES = ['building', 'build-failed', 'starting', 'running', 'stopped', 'destroyed'] as const;
export type LiveState = (typeof LIVE_STATES)[number];

const PreviewSchema = z.object({
  id: z.string().regex(PREVIEW_ID),
  sha: z.string().regex(/^[0-9a-f]{7,40}$/),
  hostname: z.string().regex(HOSTNAME),
  state: z.enum(LIVE_STATES),
  createdAt: z.union([z.string(), z.number()]).optional(),
  lastUsed: z.union([z.string(), z.number()]).nullable().optional(),
  error: z.string().nullable().optional(),
});
export type LivePreview = z.infer<typeof PreviewSchema>;

const StatusSchema = z.object({ previews: z.array(z.unknown()).max(1000) });
const CreatedSchema = z.object({ id: z.string().regex(PREVIEW_ID), hostname: z.string().regex(HOSTNAME) });

/** Thrown with a message that is safe to show a browser. `code` is the supervisor's exit code, when it had one. */
export class LiveError extends Error {
  constructor(
    message: string,
    readonly code?: number
  ) {
    super(message);
    this.name = 'LiveError';
  }
}

/** The supervisor's list, cut to the entries this file understands. One unreadable entry does not hide the rest. */
export function parseLiveStatus(json: unknown): LivePreview[] {
  const { previews } = StatusSchema.parse(json);
  const out: LivePreview[] = [];
  for (const p of previews) {
    const one = PreviewSchema.safeParse(p);
    if (one.success) out.push({ ...one.data, error: one.data.error ? one.data.error.slice(0, 200) : null });
    if (out.length >= MAX_PREVIEWS) break;
  }
  return out;
}

/**
 * The preview that shows one commit: the newest one the supervisor lists for it that is not destroyed. A failed
 * build is returned, so the page can say so. Pure.
 */
export function previewFor(previews: LivePreview[], headSha: string): LivePreview | null {
  const mine = previews.filter((p) => p.state !== 'destroyed' && headSha.startsWith(p.sha));
  if (mine.length === 0) return null;
  const stamp = (p: LivePreview): number => {
    const t = typeof p.createdAt === 'number' ? p.createdAt : Date.parse(String(p.createdAt ?? ''));
    return Number.isFinite(t) ? t : 0;
  };
  return mine.reduce((a, b) => (stamp(b) > stamp(a) ? b : a));
}

/** What a browser is told about a review's preview. The id stays on the server. */
export type LiveView =
  | { available: false }
  | { available: true; state: 'none' }
  | { available: true; state: LiveState; url: string; error: string | null };

export function liveView(preview: LivePreview | null): LiveView {
  if (!preview) return { available: true, state: 'none' };
  return {
    available: true,
    state: preview.state,
    url: `https://${preview.hostname}/`,
    error: preview.state === 'build-failed' ? (preview.error ?? 'The build failed') : null,
  };
}

/** The last non-empty line of what a command printed, as JSON. */
function lastJsonLine(stdout: string): unknown {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return JSON.parse(lines[lines.length - 1] ?? '');
}

const EXIT_MESSAGE: Record<number, string> = {
  1: 'The preview service refused: too many previews are busy, or this one is gone',
  2: 'The preview service did not accept the request',
  3: 'The preview service did not answer in time',
};

export type LiveRunner = (cli: string, args: string[], timeoutMs: number) => Promise<string>;

const runCli: LiveRunner = (cli, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(cli, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, out) => {
      if (!err) return resolve(out);
      const code = typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : undefined;
      reject(new LiveError(EXIT_MESSAGE[code ?? 0] ?? 'The preview service could not be reached', code));
    });
  });

export interface LiveControl {
  /** False when this deployment has no preview service; every other call then rejects. */
  available(): boolean;
  status(): Promise<LivePreview[]>;
  create(sha: string): Promise<{ id: string; hostname: string }>;
  use(id: string): Promise<void>;
  release(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
}

/** The supervisor's `review` commands. `env` and `run` are injected by tests, which must never reach a real one. */
export function createLiveControl(env: NodeJS.ProcessEnv = process.env, run: LiveRunner = runCli): LiveControl {
  const cli = (): string | null => (env.CODEMAN_REVIEW_PREVIEWS === '1' ? supervisorCli(env) : null);
  const need = (): string => {
    const path = cli();
    if (!path) throw new LiveError('This Codeman has no preview service');
    return path;
  };
  const idArg = (id: string): string => {
    if (!PREVIEW_ID.test(id)) throw new LiveError('Not a preview id');
    return id;
  };
  let cached: { at: number; list: Promise<LivePreview[]> } | null = null;
  const forget = (): void => {
    cached = null;
  };
  return {
    available: () => cli() !== null,
    status() {
      if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.list;
      const list = (async () => {
        const out = await run(need(), ['review', 'status'], LIVE_TIMEOUT_MS.status);
        try {
          return parseLiveStatus(lastJsonLine(out));
        } catch {
          throw new LiveError('The preview service answered with something unreadable');
        }
      })();
      cached = { at: Date.now(), list };
      list.catch(forget);
      return list;
    },
    async create(sha) {
      if (!SHA.test(sha)) throw new LiveError('A preview needs a full commit sha');
      const out = await run(need(), ['review', 'create', sha], LIVE_TIMEOUT_MS.create);
      forget();
      try {
        return CreatedSchema.parse(lastJsonLine(out));
      } catch {
        throw new LiveError('The preview service answered with something unreadable');
      }
    },
    async use(id) {
      await run(need(), ['review', 'use', idArg(id)], LIVE_TIMEOUT_MS.use);
      forget();
    },
    async release(id) {
      await run(need(), ['review', 'release', idArg(id)], LIVE_TIMEOUT_MS.release);
      forget();
    },
    async destroy(id) {
      await run(need(), ['review', 'destroy', idArg(id)], LIVE_TIMEOUT_MS.destroy);
      forget();
    },
  };
}
