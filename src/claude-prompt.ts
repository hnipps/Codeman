/**
 * @fileoverview One-shot `claude -p` runs in a throwaway tmux session: the spawn mechanics shared by the AI
 * checkers (`ai-checker-base.ts`), the Read My Mind predictor and Chat Graph's router.
 *
 * Every helper session runs on Codeman's own tmux socket (`resolveTmuxSocketName()`), never tmux's default
 * one, so instances stay isolated. Its tmux name is the caller's name behind {@link HELPER_MUX_PREFIX}, which
 * does not start with `codeman-`: `TmuxManager.reconcileSessions()` adopts every `codeman-*` session it finds on
 * that socket as a restored tab, and a helper alive at boot must not become one. Each spawn creates a pane, so
 * it first asks the deploy role for `persist` and throws {@link DeployRoleRefusal} when this colour may not.
 *
 * The prompt goes through a file and stdin (a large prompt exceeds argv limits), the model name is checked
 * against a safe pattern before it reaches the shell, and the output file is polled for a done marker.
 */

import { execFileSync, spawn as childSpawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTmuxSocketName } from './config/instance.js';
import { deployRole, DeployRoleRefusal } from './deploy-role.js';
import { getAugmentedPath } from './utils/index.js';
import { getErrorMessage } from './types.js';

export const HELPER_MUX_PREFIX = 'helper-';

const POLL_INTERVAL_MS = 500;

/** Model names reach the shell: letters, digits, `._/-` only, at most 100 characters. */
export function isValidModelName(model: string): boolean {
  if (!model || typeof model !== 'string') return false;
  return /^[a-zA-Z0-9._/-]+$/.test(model) && model.length <= 100;
}

/** Mux names reach tmux and the shell: letters, digits, `_-` only, at most 100 characters. */
export function isValidMuxName(muxName: string): boolean {
  if (!muxName || typeof muxName !== 'string') return false;
  return /^[a-zA-Z0-9_-]+$/.test(muxName) && muxName.length <= 100;
}

function helperTmuxName(name: string): string {
  const muxName = `${HELPER_MUX_PREFIX}${name}`;
  if (!isValidMuxName(muxName)) throw new Error(`Invalid mux name generated: ${muxName.substring(0, 50)}`);
  return muxName;
}

/** Kills the helper session `name` on Codeman's socket, if there is one. */
export function killHelperSession(name: string, timeoutMs = 2000): void {
  try {
    execFileSync('tmux', ['-L', resolveTmuxSocketName(), 'kill-session', '-t', helperTmuxName(name)], {
      timeout: timeoutMs,
      stdio: 'ignore',
    });
  } catch {
    // No such session: fine.
  }
}

/** Starts `bash -c command` in a detached helper session `name` on Codeman's socket, replacing a leftover one. */
export function spawnHelperSession(name: string, command: string): void {
  if (!deployRole.allows('persist')) throw new DeployRoleRefusal(deployRole.current, 'runs claude -p helpers');
  const muxName = helperTmuxName(name);
  killHelperSession(name, 3000);
  const child = childSpawn(
    'tmux',
    ['-L', resolveTmuxSocketName(), 'new-session', '-d', '-s', muxName, 'bash', '-c', command],
    {
      detached: true,
      stdio: 'ignore',
    }
  );
  child.unref();
}

export interface ClaudePromptOptions {
  /** Helper session name, unique per concurrent run (letters, digits, `_-`). */
  name: string;
  prompt: string;
  model: string;
  timeoutMs: number;
  /** What the errors call this run, e.g. "Prediction". */
  label: string;
}

export interface ClaudePromptResult {
  output: string;
  durationMs: number;
}

function readStderr(stderrFile: string): string {
  try {
    return existsSync(stderrFile) ? readFileSync(stderrFile, 'utf-8').trim().substring(0, 200) : '';
  } catch {
    return '';
  }
}

/**
 * Runs `claude -p --model <model>` over `prompt` and resolves with its trimmed output. Rejects on a refused
 * spawn, an empty output or the timeout; the helper session and temp files are removed in every case.
 */
export async function runClaudePrompt(options: ClaudePromptOptions): Promise<ClaudePromptResult> {
  const { name, prompt, model, timeoutMs, label } = options;
  if (!isValidModelName(model)) throw new Error(`Invalid model name: ${String(model).substring(0, 50)}`);
  helperTmuxName(name);

  const doneMarker = '__CODEMAN_CLAUDE_P_DONE__';
  const stamp = `${name}-${Date.now()}`;
  const outFile = join(tmpdir(), `codeman-claude-p-${stamp}.txt`);
  const stderrFile = join(tmpdir(), `codeman-claude-p-stderr-${stamp}.txt`);
  const promptFile = join(tmpdir(), `codeman-claude-p-prompt-${stamp}.txt`);
  writeFileSync(outFile, '');
  writeFileSync(stderrFile, '');
  writeFileSync(promptFile, prompt, { mode: 0o600 });

  const modelArg = `--model "${model.replace(/"/g, '\\"')}"`;
  const claudeCmd = `cat "${promptFile}" | claude -p ${modelArg} --output-format text`;
  const fullCmd = `export PATH="${getAugmentedPath()}"; ${claudeCmd} > "${outFile}" 2> "${stderrFile}"; echo "${doneMarker}" >> "${outFile}"; rm -f "${promptFile}"`;

  let pollTimer: NodeJS.Timeout | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;
  const cleanup = (): void => {
    if (pollTimer) clearInterval(pollTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    pollTimer = null;
    timeoutTimer = null;
    killHelperSession(name);
    for (const file of [outFile, stderrFile, promptFile]) {
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch {
        // Best-effort cleanup.
      }
    }
  };

  const startTime = Date.now();
  try {
    spawnHelperSession(name, fullCmd);
  } catch (err) {
    cleanup();
    if (err instanceof DeployRoleRefusal) throw err;
    throw new Error(`Failed to spawn ${label} tmux session: ${getErrorMessage(err)}`);
  }

  return new Promise<ClaudePromptResult>((resolve, reject) => {
    let settled = false;
    pollTimer = setInterval(() => {
      if (settled) return;
      try {
        if (!existsSync(outFile)) return;
        const content = readFileSync(outFile, 'utf-8');
        if (!content.includes(doneMarker)) return;
        settled = true;
        const output = content.replace(doneMarker, '').trim();
        const stderr = output ? '' : readStderr(stderrFile);
        cleanup();
        if (!output) reject(new Error(`${label} produced no output${stderr ? `: ${stderr}` : ''}`));
        else resolve({ output, durationMs: Date.now() - startTime });
      } catch {
        // Output file mid-write or already removed: keep polling.
      }
    }, POLL_INTERVAL_MS);

    timeoutTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}
