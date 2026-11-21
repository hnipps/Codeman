#!/usr/bin/env node
/**
 * @fileoverview Re-vendors Chat Graph's Go modules (`chat-graph/vendor/`) for the platforms the
 * sidecar runs on, and nothing else.
 *
 * `go mod vendor` copies every platform's generated SQLite and libc translation, about 229 MB.
 * The supervisor starts the sidecar on Linux only, so this keeps the files a linux/amd64 or
 * linux/arm64 build reads and deletes the rest by Go's filename build constraints
 * (`name_GOOS.go`, `name_GOARCH.s`, `name_GOOS_GOARCH.go`). `scripts/build.mjs` skips the sidecar
 * on any other platform. Run it after changing `chat-graph/go.mod`, then commit `vendor/`:
 *
 *   node scripts/vendor-chat-graph.mjs
 *
 * It ends by building and vetting the sidecar offline for both kept platforms.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAT_GRAPH_PLATFORMS } from './lib/go-toolchain.mjs';

const MODULE = join(dirname(fileURLToPath(import.meta.url)), '..', 'chat-graph');
const go = (args, env = {}) =>
  execFileSync('go', args, {
    cwd: MODULE,
    encoding: 'utf-8',
    env: { ...process.env, GOTOOLCHAIN: 'local', CGO_ENABLED: '0', ...env },
  });

const pairs = go(['tool', 'dist', 'list'])
  .trim()
  .split('\n')
  .map((line) => line.split('/'));
const knownOs = new Set(pairs.map(([os]) => os));
const knownArch = new Set(pairs.map(([, arch]) => arch));
const keptOs = new Set(CHAT_GRAPH_PLATFORMS.map((p) => p.split('/')[0]));
const keptArch = new Set(CHAT_GRAPH_PLATFORMS.map((p) => p.split('/')[1]));

/** Whether Go's filename constraints exclude this file from every kept platform. */
function excluded(name) {
  const match = /^(.+?)\.(go|s)$/.exec(name);
  if (!match) return false;
  const parts = match[1].split('_');
  if (parts.at(-1) === 'test') parts.pop();
  const last = parts.at(-1);
  const prev = parts.length > 2 ? parts.at(-2) : undefined;
  if (prev && knownOs.has(prev) && knownArch.has(last)) {
    return !CHAT_GRAPH_PLATFORMS.includes(`${prev}/${last}`);
  }
  if (parts.length > 1 && knownOs.has(last)) return !keptOs.has(last);
  if (parts.length > 1 && knownArch.has(last)) return !keptArch.has(last);
  return false;
}

/** Deletes excluded files under dir and returns how many it deleted; drops emptied directories. */
function prune(dir) {
  let removed = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      removed += prune(path);
      if (readdirSync(path).length === 0) rmdirSync(path);
    } else if (excluded(entry.name)) {
      rmSync(path);
      removed += 1;
    }
  }
  return removed;
}

rmSync(join(MODULE, 'vendor'), { recursive: true, force: true });
go(['mod', 'vendor']);
const removed = prune(join(MODULE, 'vendor'));
console.log(`[vendor-chat-graph] removed ${removed} files for platforms the sidecar never runs on`);

for (const platform of CHAT_GRAPH_PLATFORMS) {
  const [GOOS, GOARCH] = platform.split('/');
  const env = { GOOS, GOARCH, GOFLAGS: '-mod=vendor', GOPROXY: 'off' };
  go(['build', '-o', '/dev/null', '.'], env);
  go(['vet', './...'], env);
  console.log(`[vendor-chat-graph] ${platform} builds and vets offline`);
}
