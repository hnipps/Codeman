/**
 * @fileoverview Integrity-checked, instance-local installation of the versioned native renderer bundle.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { dataPath } from './config/instance.js';

const BUNDLE = fileURLToPath(new URL('./mermaid-runtime/ubuntu-24.04-x64/', import.meta.url));
const ManifestSchema = z.object({
  target: z.literal('ubuntu-24.04-x64'),
  files: z
    .array(
      z.object({
        path: z.string().regex(/^(lib|licenses|sources)\/[A-Za-z0-9][A-Za-z0-9._+-]*$/),
        bytes: z.number().int().positive(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
    )
    .nonempty()
    .refine((files) => new Set(files.map((file) => file.path)).size === files.length),
});
type BundleFile = z.infer<typeof ManifestSchema>['files'][number];

async function verifyFile(path: string, expected: BundleFile): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size !== expected.bytes) throw new Error(`Native runtime file does not match: ${path}`);
  const digest = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
  if (digest !== expected.sha256) throw new Error(`Native runtime checksum mismatch: ${path}`);
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (!(await lstat(path)).isDirectory()) throw new Error(`Native runtime directory is not a real directory: ${path}`);
}

async function matchesConfiguration(
  path: string,
  expected: { noSandbox: boolean; libraryPath: string }
): Promise<boolean> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (stat.isFile()) {
    try {
      const current = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown> | null;
      if (
        current &&
        Object.keys(current).every((key) => key === 'noSandbox' || key === 'libraryPath') &&
        (current.noSandbox === undefined ? false : current.noSandbox) === expected.noSandbox &&
        current.libraryPath === expected.libraryPath
      ) {
        return true;
      }
    } catch {
      // An unreadable or malformed existing file is never replaced.
    }
  }
  throw new Error(`Existing Mermaid configuration differs; it was not changed: ${path}`);
}

export async function setupMermaidRuntime(noSandbox = false): Promise<string> {
  if (platform() !== 'linux' || arch() !== 'x64')
    throw new Error('The bundled runtime supports only Ubuntu 24.04 x64.');
  const release = await readFile('/etc/os-release', 'utf8');
  if (!/^ID="?ubuntu"?$/m.test(release) || !/^VERSION_ID="?24\.04"?$/m.test(release)) {
    throw new Error("The bundled runtime supports only Ubuntu 24.04 x64. Use this host's native packages instead.");
  }
  const manifest = ManifestSchema.parse(JSON.parse(await readFile(join(BUNDLE, 'manifest.json'), 'utf8')));
  const libraries = manifest.files.filter((file) => file.path.startsWith('lib/'));
  if (!libraries.length) throw new Error('Native runtime bundle contains no libraries.');
  for (const file of manifest.files) await verifyFile(join(BUNDLE, file.path), file);

  const root = dataPath('mermaid-runtime');
  const libraryPath = join(root, 'lib');
  const configPath = dataPath('mermaid-runtime.json');
  const config = { noSandbox, libraryPath };
  const configured = await matchesConfiguration(configPath, config);
  await ensureDirectory(root);
  await ensureDirectory(libraryPath);
  for (const file of libraries) {
    const destination = join(root, file.path);
    try {
      await copyFile(join(BUNDLE, file.path), destination, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await verifyFile(destination, file);
  }
  if (!configured) {
    try {
      await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await matchesConfiguration(configPath, config);
    }
  }
  return configPath;
}
