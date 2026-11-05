/**
 * @fileoverview Persistence for web tabs (saved dashboard URLs).
 *
 * Stores `Webview` records in `~/.codeman/webviews.json`, following the same
 * read-array / write-array shape as `src/remote-hosts.ts`. Deliberately dumb: no
 * caching, no watchers. The list is small (bounded by MAX_WEBVIEWS) and is read
 * on demand by the route handlers.
 *
 * Records written before `origin` existed are given one as they are read (see
 * `withOrigin`). Nothing is written back here, so the file on disk keeps its old
 * shape until the next ordinary write.
 *
 * The file lives under the instance data dir, so a beta instance started with a
 * distinct CODEMAN_INSTANCE keeps its own dashboards.
 */

import { existsSync, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import type { Webview, WebviewOrigin } from './types.js';

const WEBVIEWS_FILE = 'webviews.json';

export function webviewsPath(configDir: string): string {
  return join(configDir, WEBVIEWS_FILE);
}

export async function readWebviews(configDir: string): Promise<Webview[]> {
  try {
    const raw = await fs.readFile(webviewsPath(configDir), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(withOrigin) : [];
  } catch {
    return [];
  }
}

function isOrigin(value: unknown): value is WebviewOrigin {
  if (!value || typeof value !== 'object') return false;
  const origin = value as Record<string, unknown>;
  switch (origin.kind) {
    case 'user':
      return true;
    case 'managed':
      return origin.managed === 'deepseek-web';
    case 'session':
      return typeof origin.sessionId === 'string' && typeof origin.name === 'string';
    default:
      return false;
  }
}

function withOrigin(record: Webview & { managed?: unknown }): Webview {
  const { managed, ...rest } = record;
  if (isOrigin(rest.origin)) return rest;
  if (managed === 'deepseek-web') return { ...rest, origin: { kind: 'managed', managed } };
  return { ...rest, origin: { kind: 'user' } };
}

export async function writeWebviews(configDir: string, webviews: Webview[]): Promise<void> {
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  await fs.writeFile(webviewsPath(configDir), JSON.stringify(webviews, null, 2));
}
