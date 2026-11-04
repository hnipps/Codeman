/**
 * @fileoverview Find the skills and plugins inside an imported tree.
 *
 * A skill is a directory whose own SKILL.md is the skill. A plugin is a
 * directory with a Claude or Grok plugin manifest, a plugin.json that sits
 * beside skills/commands/agents/hooks, or a folder a marketplace.json lists.
 * Skills that live inside a plugin stay part of that plugin: installing them
 * again as loose skills would show the same skill twice in the CLIs that load
 * the plugin.
 *
 * The walk does not follow symlinks. A link that points outside the import
 * would otherwise pull in whatever it names.
 *
 * @module extensions/classify
 */

import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { ExtensionError } from './types.js';

const MAX_DEPTH = 6;
const MAX_UNITS = 30;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'vendor', 'coverage']);

export interface FoundSkill {
  /** Directory that contains SKILL.md. */
  dir: string;
  name: string;
  description: string;
}

export interface FoundPlugin {
  dir: string;
  name: string;
  description: string;
}

export interface ClassifiedTree {
  skills: FoundSkill[];
  plugins: FoundPlugin[];
}

/** `name` and `description` from a SKILL.md frontmatter block. Missing keys stay unset. */
export function readFrontmatter(text: string): { name?: string; description?: string } {
  const normalized = text.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---')) return {};
  const end = normalized.indexOf('\n---', 3);
  if (end < 0) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of normalized.slice(3, end).split('\n')) {
    const match = /^(name|description):\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (match[1] === 'name') out.name = value;
    else out.description = value;
  }
  return out;
}

/** Lowercase token used as the directory name and the catalog id. Empty when nothing usable remains. */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

/** A name a CLI plugin installer will take as one argument. */
export function safePluginName(name: string): string | undefined {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) ? name : undefined;
}

interface Manifest {
  name?: string;
  description?: string;
}

async function readJson(file: string): Promise<Manifest | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { name?: unknown; description?: unknown };
    return {
      name: typeof parsed.name === 'string' ? parsed.name.trim() : undefined,
      description: typeof parsed.description === 'string' ? parsed.description.trim() : undefined,
    };
  } catch {
    return undefined;
  }
}

function marketplaceSources(value: unknown): { name?: string; description?: string; path?: string }[] {
  if (!value || typeof value !== 'object') return [];
  const plugins = (value as { plugins?: unknown }).plugins;
  if (!Array.isArray(plugins)) return [];
  const out: { name?: string; description?: string; path?: string }[] = [];
  for (const entry of plugins) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as { name?: unknown; description?: unknown; source?: unknown };
    let path: string | undefined;
    if (typeof row.source === 'string') path = row.source;
    else if (row.source && typeof row.source === 'object') {
      const source = row.source as { path?: unknown; type?: unknown };
      if (typeof source.path === 'string') path = source.path;
    }
    out.push({
      name: typeof row.name === 'string' ? row.name.trim() : undefined,
      description: typeof row.description === 'string' ? row.description.trim() : undefined,
      path,
    });
  }
  return out;
}

/** True when `dir` is `root` or a directory inside it. Both are absolute. */
function inside(root: string, dir: string): boolean {
  const base = resolve(root);
  const target = resolve(dir);
  return target === base || target.startsWith(base + sep);
}

/**
 * Skills and plugins under `root`. `root` itself can be either one.
 * Throws INVALID_INPUT when the tree has neither, or more than {@link MAX_UNITS}.
 */
export async function classifyTree(root: string): Promise<ClassifiedTree> {
  const pluginDirs = new Map<string, FoundPlugin>();
  const skillDirs: FoundSkill[] = [];

  const considerPlugin = async (dir: string, hinted?: Manifest): Promise<void> => {
    if (!inside(root, dir)) return;
    const resolved = resolve(dir);
    if (pluginDirs.has(resolved)) return;
    const manifest =
      (await readJson(join(dir, '.claude-plugin', 'plugin.json'))) ??
      (await readJson(join(dir, '.grok-plugin', 'plugin.json'))) ??
      hinted;
    const loose = await readJson(join(dir, 'plugin.json'));
    const named = manifest?.name ? manifest : loose?.name ? loose : manifest;
    if (!named?.name && !hinted?.name) return;
    if (!manifest?.name && loose?.name) {
      const markers = ['skills', 'commands', 'agents', 'hooks', '.mcp.json'];
      const present = await Promise.all(
        markers.map((name) =>
          lstat(join(dir, name)).then(
            () => true,
            () => false
          )
        )
      );
      if (!present.some(Boolean)) return;
    }
    const name = (named?.name || hinted?.name || '').trim();
    if (!name) return;
    pluginDirs.set(resolved, {
      dir: resolved,
      name,
      description: (named?.description || hinted?.description || '').replace(/\s+/g, ' ').slice(0, 240),
    });
  };

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    await considerPlugin(dir);
    for (const file of ['.claude-plugin/marketplace.json', '.grok-plugin/marketplace.json']) {
      const parsed = await readJson(join(dir, file));
      if (!parsed) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(join(dir, file), 'utf8'));
      } catch {
        continue;
      }
      for (const entry of marketplaceSources(raw)) {
        if (!entry.path || entry.path.split('/').includes('..')) continue;
        const pluginDir = resolve(dir, entry.path);
        await considerPlugin(pluginDir, { name: entry.name, description: entry.description });
      }
    }

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      await visit(join(dir, entry.name), depth + 1);
    }
  };

  await visit(resolve(root), 0);

  const visitSkills = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    const resolved = resolve(dir);
    const covered = [...pluginDirs.keys()].some((plugin) => inside(plugin, resolved));
    if (!covered) {
      try {
        const stat = await lstat(join(resolved, 'SKILL.md'));
        if (stat.isFile()) {
          const text = await readFile(join(resolved, 'SKILL.md'), 'utf8');
          const front = readFrontmatter(text);
          const name = (front.name || '').trim();
          skillDirs.push({
            dir: resolved,
            name: name || resolved.split(sep).pop() || 'skill',
            description: (front.description || '').replace(/\s+/g, ' ').slice(0, 240),
          });
        }
      } catch {
        // no SKILL.md here
      }
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      await visitSkills(join(dir, entry.name), depth + 1);
    }
  };
  await visitSkills(resolve(root), 0);

  const skills = dedupe(skillDirs);
  const plugins = [...pluginDirs.values()];
  if (skills.length + plugins.length === 0) {
    throw new ExtensionError(
      'INVALID_INPUT',
      'No skill or plugin found. A skill is a folder with SKILL.md. A plugin is a folder with plugin.json, or a marketplace that lists plugins.'
    );
  }
  if (skills.length + plugins.length > MAX_UNITS) {
    throw new ExtensionError(
      'INVALID_INPUT',
      `That import contains ${skills.length + plugins.length} skills and plugins. Import a subdirectory (30 at a time).`
    );
  }
  return { skills, plugins };
}

function dedupe(skills: FoundSkill[]): FoundSkill[] {
  const seen = new Set<string>();
  const out: FoundSkill[] = [];
  for (const skill of skills) {
    if (seen.has(skill.dir)) continue;
    seen.add(skill.dir);
    out.push(skill);
  }
  return out;
}

/** Skills inside a plugin, for CLIs that have no plugin installer. The plugin directory itself is not one. */
export async function skillsInside(pluginDir: string): Promise<FoundSkill[]> {
  const found: FoundSkill[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    if (resolve(dir) !== resolve(pluginDir)) {
      try {
        const stat = await lstat(join(dir, 'SKILL.md'));
        if (stat.isFile()) {
          const front = readFrontmatter(await readFile(join(dir, 'SKILL.md'), 'utf8'));
          found.push({
            dir: resolve(dir),
            name: (front.name || '').trim() || dir.split(sep).pop() || 'skill',
            description: (front.description || '').replace(/\s+/g, ' ').slice(0, 240),
          });
        }
      } catch {
        // not a skill directory
      }
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      await visit(join(dir, entry.name), depth + 1);
    }
  };
  await visit(pluginDir, 0);
  return dedupe(found);
}

/** Relative display of a found directory, for errors. */
export function displayPath(root: string, dir: string): string {
  const rel = relative(root, dir);
  return rel && !rel.startsWith('..') ? rel : dir;
}
