/**
 * @fileoverview The environment a preview server starts with.
 *
 * A preview is the agent's own dev server, which can be anything, including
 * another Codeman. It starts from the Codeman server's environment so that PATH,
 * HOME, locale and the user's tool settings carry over, minus the variables that
 * scope, deploy or authenticate THIS Codeman. Inheriting those made a throwaway
 * Codeman started as a preview with its own `CODEMAN_INSTANCE` still use the live
 * data dir and tmux socket, because `CODEMAN_DATA_DIR` and `CODEMAN_TMUX_SOCKET`
 * outrank the instance name (`config/instance.ts`): the multi-instance attach
 * danger. The reasons for each entry are in
 * `intent/2026-11-14-preview-env-isolation.md`.
 *
 * Pure: the caller passes the base environment, so the test reads the shipped list.
 */

import { PREVIEW_ID_ENV, PREVIEW_OWNER_ENV } from './preview-proc.js';

/**
 * Variables a preview server never inherits from the Codeman server.
 * `CODEMAN_API_URL` is deliberately absent: it names this server and nothing more,
 * a nested Codeman overwrites it when it starts, and `codeman agent` refuses to run
 * without the `CODEMAN_MUX`/`CODEMAN_SESSION_ID` pair stripped below.
 */
export const PREVIEW_STRIPPED_ENV: readonly string[] = Object.freeze([
  // Instance scoping: which data dir and tmux socket a Codeman uses.
  'CODEMAN_INSTANCE',
  'CODEMAN_DATA_DIR',
  'CODEMAN_TMUX_SOCKET',
  // Where and how this server listens.
  'CODEMAN_PORT',
  'CODEMAN_HOST',
  'CODEMAN_BASE_URL',
  // Blue/green deployment and supervision of this server.
  'CODEMAN_DEPLOY_ROLE',
  'CODEMAN_SUPERVISOR_CLI',
  'CODEMAN_STABLE_API_URL',
  'CODEMAN_RESTART_BY_EXIT',
  'CODEMAN_BUILD_ID',
  'CODEMAN_LOG_DIR',
  // Login and the acknowledgements that waive it.
  'CODEMAN_PASSWORD',
  'CODEMAN_USERNAME',
  'CODEMAN_MULTIUSER',
  'CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK',
  'CODEMAN_ALLOW_UNAUTHENTICATED_TUNNEL',
  // A session's identity, present when the server itself was started from a pane.
  'CODEMAN_MUX',
  'CODEMAN_SESSION_ID',
  'CODEMAN_MUX_NAME',
  'CODEMAN_HOOK_SECRET_FILE',
]);

export interface PreviewEnvInput {
  port: number;
  previewId: string;
  owner: string;
}

/**
 * The base environment minus {@link PREVIEW_STRIPPED_ENV}, plus `PORT` and the
 * two preview markers the stop path finds the server by. Keys are deleted, never
 * set to `undefined`, so nothing serializes as the literal string "undefined".
 */
export function buildPreviewEnv(base: NodeJS.ProcessEnv, input: PreviewEnvInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of PREVIEW_STRIPPED_ENV) delete env[name];
  env.PORT = String(input.port);
  env[PREVIEW_ID_ENV] = input.previewId;
  env[PREVIEW_OWNER_ENV] = input.owner;
  return env;
}
