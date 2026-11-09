/**
 * @fileoverview Recovery from the versioned native bundle without a browser or system package installation.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerMermaidCommands } from '../src/cli-mermaid.js';
import { setupMermaidRuntime } from '../src/mermaid-runtime-setup.js';
import { safeRmHomeTree } from './mocks/index.js';

vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  platform: () => 'linux',
  arch: () => 'x64',
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, readFile: vi.fn(fs.readFile) };
});

describe('Mermaid runtime recovery', () => {
  let root: string;
  let exitCode: typeof process.exitCode;

  beforeEach(async () => {
    exitCode = process.exitCode;
    root = await mkdtemp(join(homedir(), 'mermaid-recovery-'));
    vi.stubEnv('CODEMAN_DATA_DIR', root);
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(readFile).mockImplementation(((path, options) =>
      path === '/etc/os-release'
        ? Promise.resolve('ID=ubuntu\nVERSION_ID="24.04"\n')
        : fs.readFile(path, options)) as typeof readFile);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    process.exitCode = exitCode;
    safeRmHomeTree(root);
  });

  it.each([
    { args: [], noSandbox: false },
    { args: ['--no-sandbox'], noSandbox: true },
  ])(
    'restores through the CLI and preserves an identical repeat: sandbox opt-out $noSandbox',
    async ({ args, noSandbox }) => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const program = new Command();
      registerMermaidCommands(program);
      await program.parseAsync(['mermaid', 'setup', ...args], { from: 'user' });
      const path = join(root, 'mermaid-runtime.json');
      const config = JSON.parse(await readFile(path, 'utf8'));
      expect(config).toEqual({ noSandbox, libraryPath: join(root, 'mermaid-runtime/lib') });
      const before = await stat(path);
      expect(await setupMermaidRuntime(noSandbox)).toBe(path);
      expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
      const library = await readFile(join(config.libraryPath, 'libasound.so.2'));
      const manifest = JSON.parse(
        await readFile(new URL('../src/mermaid-runtime/ubuntu-24.04-x64/manifest.json', import.meta.url), 'utf8')
      );
      expect(createHash('sha256').update(library).digest('hex')).toBe(
        manifest.files.find((file: { path: string }) => file.path === 'lib/libasound.so.2').sha256
      );
    }
  );

  it('refuses symlinked destination directories and configuration files', async () => {
    const external = join(root, 'external');
    await mkdir(external);
    await symlink(external, join(root, 'mermaid-runtime'));
    await expect(setupMermaidRuntime()).rejects.toThrow('not a real directory');
    const path = join(root, 'mermaid-runtime.json');
    const otherConfig = join(root, 'external.json');
    await writeFile(otherConfig, JSON.stringify({ noSandbox: false, libraryPath: join(root, 'mermaid-runtime/lib') }));
    await symlink(otherConfig, path);
    await expect(setupMermaidRuntime()).rejects.toThrow('Existing Mermaid configuration differs');
  });

  it('persists an explicit opt-out but refuses to replace a different existing configuration', async () => {
    const path = await setupMermaidRuntime(true);
    const before = await readFile(path, 'utf8');
    expect(JSON.parse(before).noSandbox).toBe(true);
    await expect(setupMermaidRuntime(false)).rejects.toThrow('Existing Mermaid configuration differs');
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it.each([null, 'false'])('refuses an invalid existing sandbox value: %s', async (noSandbox) => {
    const path = join(root, 'mermaid-runtime.json');
    const original = JSON.stringify({ noSandbox, libraryPath: join(root, 'mermaid-runtime/lib') });
    await writeFile(path, original);
    await expect(setupMermaidRuntime()).rejects.toThrow('Existing Mermaid configuration differs');
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('refuses a modified installed library instead of overwriting it', async () => {
    const path = await setupMermaidRuntime();
    const library = join(root, 'mermaid-runtime/lib/libasound.so.2');
    await writeFile(library, 'modified');
    await expect(setupMermaidRuntime()).rejects.toThrow('does not match');
    expect(await readFile(library, 'utf8')).toBe('modified');
    expect(JSON.parse(await readFile(path, 'utf8')).noSandbox).toBe(false);
  });

  it('rejects a corrupt source bundle before creating runtime configuration', async () => {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(readFile).mockImplementation(((path, options) => {
      if (String(path).endsWith('/lib/libasound.so.2')) return Promise.resolve(Buffer.from('corrupt'));
      if (path === '/etc/os-release') return Promise.resolve('ID=ubuntu\nVERSION_ID=24.04\n');
      return fs.readFile(path, options);
    }) as typeof readFile);
    await expect(setupMermaidRuntime()).rejects.toThrow('checksum mismatch');
    await expect(stat(join(root, 'mermaid-runtime.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses an untested distribution before writing anything', async () => {
    vi.mocked(readFile).mockResolvedValue('ID=debian\nVERSION_ID=12\n');
    await expect(setupMermaidRuntime()).rejects.toThrow('only Ubuntu 24.04 x64');
    await expect(stat(join(root, 'mermaid-runtime.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
