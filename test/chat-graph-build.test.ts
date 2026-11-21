import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isGoTooOld, isGoVersionRefusal } from '../scripts/lib/go-toolchain.mjs';

const GO_MOD = 'module codeman/chat-graph\n\ngo 1.23\n';

function goVersion(): string | null {
  try {
    return execFileSync('go', ['env', 'GOVERSION'], { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

/** `go build` of a one-file module under the build's own environment; returns its stderr. */
async function goBuild(goLine: string, source: string): Promise<{ status: number | null; stderr: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-build-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'go.mod'), `module probe\n\ngo ${goLine}\n`);
  await fs.writeFile(path.join(root, 'main.go'), source);
  const result = spawnSync('go', ['build', '-o', path.join(root, 'out'), '.'], {
    cwd: root,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GOFLAGS: '-mod=mod',
      GOPROXY: 'off',
      GOTOOLCHAIN: 'local',
      CGO_ENABLED: '0',
    },
  });
  return { status: result.status, stderr: result.stderr };
}

describe('chat-graph build skip/fail split', () => {
  it('skips a go older than go.mod by major.minor, and only then', () => {
    expect(isGoTooOld(GO_MOD, 'go1.22.9')).toBe(true);
    expect(isGoTooOld(GO_MOD, 'go1.20')).toBe(true);
    expect(isGoTooOld(GO_MOD, 'go1.18.10\n')).toBe(true);
    expect(isGoTooOld(GO_MOD, 'go1.23.0')).toBe(false);
    expect(isGoTooOld(GO_MOD, 'go1.24rc1')).toBe(false);
    expect(isGoTooOld(GO_MOD, 'go2.0')).toBe(false);
  });

  it('leaves an unparsable version to go itself', () => {
    expect(isGoTooOld(GO_MOD, 'devel +abc123')).toBeNull();
    expect(isGoTooOld('module x\n', 'go1.23.4')).toBeNull();
  });

  it("reads go's own version refusal as a skip and a compile error as a failure", () => {
    expect(isGoVersionRefusal('go: go.mod requires go >= 1.23.4 (running go 1.23.0; GOTOOLCHAIN=local)')).toBe(true);
    expect(isGoVersionRefusal('./main.go:3:1: syntax error: non-declaration statement outside function body')).toBe(
      false
    );
    // What a pre-1.21 go prints after compiling against a newer go line: the up-front check covers it.
    expect(isGoVersionRefusal('note: module requires Go 1.23')).toBe(false);
  });

  const local = goVersion();
  it.skipIf(!local)(
    'matches the refusal the installed go really prints, and not its compile errors',
    async () => {
      const refused = await goBuild('1.99', 'package main\n\nfunc main() {}\n');
      expect(refused.status).not.toBe(0);
      expect(isGoVersionRefusal(refused.stderr), refused.stderr).toBe(true);

      const broken = await goBuild('1.21', 'package main\n\nfunc main() { undefined() }\n');
      expect(broken.status).not.toBe(0);
      expect(isGoVersionRefusal(broken.stderr), broken.stderr).toBe(false);
    },
    60_000
  );
});
