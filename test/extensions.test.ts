/**
 * Importing and removing plugins and skills: GitHub parsing, classification,
 * archive safety, and the service with a fake CLI runner.
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { extractArchive } from '../src/extensions/archive.js';
import { classifyTree } from '../src/extensions/classify.js';
import { looksLikeGitHub, parseGitHubSource } from '../src/extensions/github.js';
import { pluginPlans } from '../src/extensions/plugin-plans.js';
import { importExtensions, listExtensions, removeExtension } from '../src/extensions/service.js';
import { ExtensionError, type ExtensionDeps, type RunResult } from '../src/extensions/types.js';
import { resolveExtensionSource } from '../src/cli-extensions.js';

const dirs: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'codeman-ext-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function skill(name: string, description = 'A skill'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

async function writeSkill(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), skill(name));
}

function deps(
  home: string,
  data: string,
  opts: {
    bins?: string[];
    run?: (bin: string, args: string[]) => RunResult;
    clone?: ExtensionDeps['clone'];
  } = {}
): { deps: ExtensionDeps; calls: string[][] } {
  const calls: string[][] = [];
  const bins = new Set(opts.bins ?? []);
  return {
    calls,
    deps: {
      homeDir: home,
      dataDir: data,
      now: () => new Date('2026-11-04T00:00:00.000Z'),
      binExists: async (bin) => bins.has(bin),
      run: async (bin, args) => {
        calls.push([bin, ...args]);
        return opts.run ? opts.run(bin, args) : { code: 0, stdout: '', stderr: '' };
      },
      clone: opts.clone ?? (async () => {
        throw new ExtensionError('OPERATION_FAILED', 'clone was not stubbed');
      }),
    },
  };
}

function zipStore(entries: { name: string; data: Buffer; mode?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const local = Buffer.alloc(30 + name.length + entry.data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    entry.data.copy(local, 30 + name.length);
    locals.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function tarBlock(name: string, data: Buffer, type = '0'): Buffer {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header[156] = type.charCodeAt(0);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const pad = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(pad);
  return Buffer.concat([header, pad]);
}

describe('GitHub sources', () => {
  it('parses shorthand, a ref, a subdirectory, and tree and blob URLs', () => {
    expect(parseGitHubSource('Ark0N/Codeman')).toMatchObject({
      cloneUrl: 'https://github.com/Ark0N/Codeman.git',
      repo: 'Ark0N/Codeman',
      label: 'https://github.com/Ark0N/Codeman',
    });
    expect(parseGitHubSource('Ark0N/Codeman@v1.2.3#skills/review')).toMatchObject({
      ref: 'v1.2.3',
      subdir: 'skills/review',
    });
    expect(parseGitHubSource('https://github.com/Ark0N/Codeman.git')).toMatchObject({ repo: 'Ark0N/Codeman' });
    expect(parseGitHubSource('https://github.com/Ark0N/Codeman/tree/main/skills/review')).toMatchObject({
      ref: 'main',
      subdir: 'skills/review',
    });
    expect(parseGitHubSource('https://github.com/Ark0N/Codeman/blob/main/skills/review/SKILL.md')).toMatchObject({
      ref: 'main',
      subdir: 'skills/review',
    });
  });

  it('refuses credentials, other hosts, parent segments, and a leading dash', () => {
    expect(() => parseGitHubSource('https://user:token@github.com/Ark0N/Codeman')).toThrow(/credentials/i);
    expect(() => parseGitHubSource('https://gitlab.com/Ark0N/Codeman')).toThrow(/github\.com/);
    expect(() => parseGitHubSource('Ark0N/Codeman#../secrets')).toThrow(/segment/);
    expect(() => parseGitHubSource('-Ark0N/Codeman')).toThrow(/start with "-"/);
    expect(looksLikeGitHub('Ark0N/Codeman')).toBe(true);
    expect(looksLikeGitHub('/tmp/skill')).toBe(false);
  });
});

describe('classification', () => {
  it('finds a skill, a manifest plugin, a loose plugin, and a marketplace entry', async () => {
    const root = await scratch();
    await writeSkill(join(root, 'alpha'), 'Alpha');
    await mkdir(join(root, 'bundled', '.claude-plugin'), { recursive: true });
    await writeFile(
      join(root, 'bundled', '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'bundled', description: 'A plugin' })
    );
    await writeSkill(join(root, 'bundled', 'skills', 'inside'), 'Inside');
    await mkdir(join(root, 'loose', 'skills'), { recursive: true });
    await writeFile(join(root, 'loose', 'plugin.json'), JSON.stringify({ name: 'loose' }));
    await writeSkill(join(root, 'loose', 'skills', 'also'), 'Also');
    await mkdir(join(root, 'market', '.claude-plugin'), { recursive: true });
    await mkdir(join(root, 'market', 'plugins', 'hinted'), { recursive: true });
    await writeFile(
      join(root, 'market', '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'm', plugins: [{ name: 'hinted', source: './plugins/hinted' }] })
    );

    const found = await classifyTree(root);
    expect(found.skills.map((item) => item.name)).toEqual(['Alpha']);
    expect(found.plugins.map((item) => item.name).sort()).toEqual(['bundled', 'hinted', 'loose']);
  });

  it('does not follow a symlink and refuses an empty tree or more than 30 units', async () => {
    const root = await scratch();
    const outside = await scratch();
    await writeSkill(outside, 'Outside');
    await symlink(outside, join(root, 'linked'));
    await expect(classifyTree(root)).rejects.toThrow(/No skill or plugin/);

    await writeSkill(join(root, 'real'), 'Real');
    const found = await classifyTree(root);
    expect(found.skills.map((item) => item.name)).toEqual(['Real']);

    const many = await scratch();
    for (let i = 0; i < 31; i++) await writeSkill(join(many, `s${i}`), `S${i}`);
    await expect(classifyTree(many)).rejects.toThrow(/30 at a time/);
  });
});

describe('archives', () => {
  it('rejects a path that escapes the archive and a symlink entry', async () => {
    const root = await scratch();
    const slipped = join(root, 'slipped.zip');
    await writeFile(slipped, zipStore([{ name: '../evil.txt', data: Buffer.from('nope') }]));
    await expect(extractArchive(slipped, join(root, 'out-slip'))).rejects.toThrow(/\.\./);
    await expect(lstat(join(root, 'evil.txt')).then(() => true, () => false)).resolves.toBe(false);

    const linked = join(root, 'link.zip');
    await writeFile(linked, zipStore([{ name: 'link', data: Buffer.from('x'), mode: 0o120777 }]));
    await expect(extractArchive(linked, join(root, 'out-link'))).rejects.toThrow(/symlink/i);

    const tar = join(root, 'link.tar');
    await writeFile(tar, Buffer.concat([tarBlock('link', Buffer.alloc(0), '2'), Buffer.alloc(1024)]));
    await expect(extractArchive(tar, join(root, 'out-tar'))).rejects.toThrow(/link/i);
  });

  it('rejects a gzip archive that expands past 64 MB', async () => {
    const root = await scratch();
    const file = join(root, 'bomb.tar.gz');
    await writeFile(file, gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1)));
    await expect(extractArchive(file, join(root, 'out'))).rejects.toThrow(/64 MB/);
  });

  it('extracts a skill zip', async () => {
    const root = await scratch();
    const file = join(root, 'skill.zip');
    const body = Buffer.from(skill('Zipped'));
    await writeFile(file, zipStore([{ name: 'zipped/SKILL.md', data: body }]));
    await extractArchive(file, join(root, 'out'));
    expect(await readFile(join(root, 'out', 'zipped', 'SKILL.md'), 'utf8')).toContain('name: Zipped');
  });
});

describe('import and remove', () => {
  async function layout(): Promise<{ home: string; data: string }> {
    const root = await scratch();
    return { home: join(root, 'home'), data: join(root, 'data') };
  }

  it('copies a skill into every CLI directory and will not replace a foreign one', async () => {
    const { home, data } = await layout();
    await mkdir(join(home, '.claude', 'skills', 'codeman'), { recursive: true });
    await writeFile(join(home, '.claude', 'skills', 'codeman', 'SKILL.md'), '<!-- codeman-managed-agent-skill -->\nowned');
    await mkdir(join(home, '.claude', 'skills', 'mine'), { recursive: true });
    await writeFile(join(home, '.claude', 'skills', 'mine', 'SKILL.md'), 'user authored');
    const source = join(data, 'src');
    await writeSkill(source, 'Mine');
    const { deps: fake } = deps(home, data);
    const result = await importExtensions({ path: source }, fake);
    expect(result.installed.map((item) => item.id)).toEqual(['skill:mine']);
    expect(await readFile(join(home, '.claude', 'skills', 'codeman', 'SKILL.md'), 'utf8')).toContain('owned');
    expect(await readFile(join(home, '.claude', 'skills', 'mine', 'SKILL.md'), 'utf8')).toBe('user authored');
    const claude = result.installed[0].targets.find((target) => target.cli === 'claude');
    expect(claude?.status).toBe('skipped');
    expect(await readFile(join(home, '.agents', 'skills', 'mine', 'SKILL.md'), 'utf8')).toContain('name: Mine');
    const marker = JSON.parse(await readFile(join(home, '.agents', 'skills', 'mine', '.codeman-extension.json'), 'utf8'));
    expect(marker).toEqual({ managedBy: 'codeman', id: 'skill:mine' });
  });

  it('leaves a symlinked skill directory alone', async () => {
    const { home, data } = await layout();
    const elsewhere = join(data, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    await mkdir(join(home, '.codex', 'skills'), { recursive: true });
    await symlink(elsewhere, join(home, '.codex', 'skills', 'mine'));
    const source = join(data, 'src');
    await writeSkill(source, 'Mine');
    const result = await importExtensions({ path: source }, deps(home, data).deps);
    const codex = result.installed[0].targets.find((target) => target.cli === 'codex');
    expect(codex?.status).toBe('skipped');
    expect((await lstat(join(home, '.codex', 'skills', 'mine'))).isSymbolicLink()).toBe(true);
  });

  it('records a plugin when one CLI fails and rolls back when every CLI fails', async () => {
    const { home, data } = await layout();
    const source = join(data, 'plugin');
    await mkdir(join(source, '.claude-plugin'), { recursive: true });
    await writeFile(join(source, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', description: 'Demo' }));
    await writeSkill(join(source, 'skills', 'inner'), 'Inner');
    const fake = deps(home, data, {
      bins: ['claude', 'grok'],
      run: (bin) => (bin === 'claude' ? { code: 1, stdout: '', stderr: 'claude refused' } : { code: 0, stdout: '', stderr: '' }),
    });
    const result = await importExtensions({ path: source }, fake.deps);
    expect(result.installed[0].plugins.map((plugin) => plugin.cli)).toEqual(['grok']);
    expect(result.installed[0].targets.find((target) => target.cli === 'claude')?.status).toBe('failed');
    expect(result.installed[0].targets.find((target) => target.cli === 'grok')?.status).toBe('installed');
    expect(fake.calls.some((call) => call[0] === 'grok' && call.includes('--trust'))).toBe(true);
    expect(fake.calls.some((call) => call[0] === 'claude' && call.includes('--marketplace'))).toBe(true);
    await expect(readFile(join(home, '.grok', 'skills', 'inner', 'SKILL.md'), 'utf8')).rejects.toThrow();
    expect(await readFile(join(home, '.claude', 'skills', 'inner', 'SKILL.md'), 'utf8')).toContain('name: Inner');

    const empty = join(data, 'empty-plugin');
    await mkdir(join(empty, '.claude-plugin'), { recursive: true });
    await writeFile(join(empty, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'solo' }));
    await expect(importExtensions({ path: empty }, deps(home, data).deps)).rejects.toThrow(/no skills/);
    expect((await listExtensions(deps(home, data).deps)).map((item) => item.id)).toEqual(['plugin:demo']);
  });

  it('refreshes the same skill and keeps the row when uninstall fails', async () => {
    const { home, data } = await layout();
    const source = join(data, 'src');
    await writeSkill(source, 'Mine');
    const fake = deps(home, data);
    await importExtensions({ path: source }, fake.deps);
    await writeFile(join(source, 'SKILL.md'), skill('Mine', 'Updated'));
    const again = await importExtensions({ path: source }, fake.deps);
    expect(again.installed).toHaveLength(1);
    expect(again.installed[0].targets.find((target) => target.cli === 'agents')?.status).toBe('refreshed');
    expect(await readFile(join(home, '.agents', 'skills', 'mine', 'SKILL.md'), 'utf8')).toContain('Updated');
    expect(await listExtensions(fake.deps)).toHaveLength(1);

    const plugin = join(data, 'plugin');
    await mkdir(join(plugin, '.claude-plugin'), { recursive: true });
    await writeFile(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo' }));
    await writeSkill(join(plugin, 'skills', 'inner'), 'Inner');
    const pluginDeps = deps(home, data, {
      bins: ['claude'],
      run: (_bin, args) =>
        args[0] === 'plugin' && args[1] === 'uninstall'
          ? { code: 1, stdout: '', stderr: 'still here' }
          : { code: 0, stdout: '', stderr: '' },
    });
    const imported = await importExtensions({ path: plugin }, pluginDeps.deps);
    await expect(removeExtension(imported.installed[0].id, pluginDeps.deps)).rejects.toThrow(/Could not uninstall/);
    expect((await listExtensions(pluginDeps.deps)).some((item) => item.id === 'plugin:demo')).toBe(true);
    pluginDeps.deps.run = async (bin, args) => {
      pluginDeps.calls.push([bin, ...args]);
      return { code: 0, stdout: '', stderr: '' };
    };
    await removeExtension('plugin:demo', pluginDeps.deps);
    await removeExtension('skill:mine', fake.deps);
    expect(await listExtensions(fake.deps)).toEqual([]);
  });

  it('asks Copilot to install a whole GitHub repository and not a subdirectory', async () => {
    const { home, data } = await layout();
    let clones = 0;
    const fake = deps(home, data, {
      bins: ['copilot'],
      clone: async (_url, _ref, dest) => {
        clones += 1;
        await mkdir(join(dest, '.claude-plugin'), { recursive: true });
        await writeFile(join(dest, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'rootplug' }));
        await writeSkill(join(dest, 'skills', 'root'), 'Root');
        if (clones > 1) {
          await mkdir(join(dest, 'pkg', '.claude-plugin'), { recursive: true });
          await writeFile(join(dest, 'pkg', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'pkg' }));
          await writeSkill(join(dest, 'pkg', 'skills', 'inner'), 'Inner');
        }
      },
    });
    await importExtensions({ github: 'acme/plugins' }, fake.deps);
    expect(fake.calls.filter((call) => call[0] === 'copilot')).toEqual([
      ['copilot', 'plugin', 'install', 'acme/plugins'],
    ]);

    fake.calls.length = 0;
    await importExtensions({ github: 'acme/plugins#pkg' }, fake.deps);
    expect(fake.calls.some((call) => call[0] === 'copilot')).toBe(false);
    expect(await readFile(join(home, '.copilot', 'skills', 'inner', 'SKILL.md'), 'utf8')).toContain('name: Inner');
  });

  it('builds the installer argv and prefers a local path over a repository name', async () => {
    const plans = pluginPlans({
      name: 'demo',
      pluginDir: '/tmp/plugin',
      marketplaceDir: '/tmp/market',
      githubRepo: 'acme/plugins',
    });
    const claude = plans.find((plan) => plan.bin === 'claude');
    expect(claude?.install[0].args).toEqual([
      'plugin',
      'install',
      'demo',
      '--marketplace',
      '/tmp/market',
      '--scope',
      'user',
      '--yes',
      '--json',
    ]);
    expect(plans.find((plan) => plan.bin === 'copilot')?.install[0].args).toEqual(['plugin', 'install', 'acme/plugins']);
    expect(pluginPlans({ name: 'demo', pluginDir: '/p', marketplaceDir: '/m' }).some((plan) => plan.bin === 'copilot')).toBe(
      false
    );

    const root = await scratch();
    await writeFile(join(root, 'owner'), 'not a repo');
    expect(resolveExtensionSource('owner/repo', root)).toEqual({ github: 'owner/repo' });
    const file = join(root, 'SKILL.md');
    await writeFile(file, skill('Local'));
    expect(resolveExtensionSource('SKILL.md', root)).toEqual({ path: file });
  });
});
