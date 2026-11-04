/**
 * @fileoverview Import and remove plugins and skills for every agent CLI.
 *
 * One catalog (`extensions/catalog.json`) is the removal plan. Skills are copied
 * into each CLI's user skill directory and marked `.codeman-extension.json`.
 * Plugins are copied into a private marketplace named `codeman-imports` and
 * handed to each CLI's own installer. A directory without that marker, and any
 * symlink, is left alone. File contents are never edited.
 *
 * Callers (the HTTP routes, `codeman extension`, and the MCP tools) all use
 * these functions. Imports and removals run one at a time in this process.
 *
 * @module extensions/service
 */

import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { dataPath } from '../config/instance.js';
import { gitNonInteractiveEnv } from '../git-clone.js';
import { extractArchive } from './archive.js';
import { classifyTree, readFrontmatter, safePluginName, skillsInside, slugify, type FoundSkill } from './classify.js';
import { parseGitHubSource } from './github.js';
import { MARKETPLACE_NAME, pluginPlans, uninstallStep, type PluginSkillRoot } from './plugin-plans.js';
import {
  ExtensionError,
  type ExtensionCatalog,
  type ExtensionCopy,
  type ExtensionDeps,
  type ExtensionPluginInstall,
  type ExtensionRecord,
  type ExtensionTarget,
  type ImportInput,
  type ImportResult,
  type RunResult,
} from './types.js';

const MARKER = '.codeman-extension.json';
const TAIL_BYTES = 4096;
const FILE_CAP = 8 * 1024 * 1024;
const ALREADY_THERE = /already (?:exists|added|installed|configured)/i;
const ALREADY_GONE = /not (?:installed|found)|no such|unknown plugin|is not installed/i;

const PROJECT_NOTE =
  'Antigravity, DeepSeek Harness and OMP read skills from the project (.agents/skills). Pass case to install into one case as well. Pi reads ~/.agents/skills, which this install always writes.';

/** Skill-directory suffixes a copy is allowed to live under. One segment follows the suffix. */
const SKILL_SUFFIXES = [
  '.claude/skills',
  '.codex/skills',
  '.grok/skills',
  '.config/opencode/skills',
  '.gemini/skills',
  '.copilot/skills',
  '.agents/skills',
];

interface SkillRoot {
  cli: string;
  label: string;
  dir: string;
  /** Set when a successful plugin install already covers this directory. */
  cover?: PluginSkillRoot;
}

interface Materialized {
  root: string;
  source: string;
  githubRepo?: string;
  subdir: boolean;
}

let tail: Promise<void> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function clip(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function stamp(deps: ExtensionDeps): string {
  return (deps.now ?? (() => new Date()))().toISOString();
}

function inside(root: string, target: string): boolean {
  const base = resolve(root);
  const resolved = resolve(target);
  return resolved === base || resolved.startsWith(base + sep);
}

function skillRoots(home: string, caseDir?: string): SkillRoot[] {
  const roots: SkillRoot[] = [
    { cli: 'claude', label: 'Claude Code', dir: join(home, '.claude', 'skills'), cover: 'claude' },
    { cli: 'codex', label: 'Codex', dir: join(home, '.codex', 'skills'), cover: 'codex' },
    { cli: 'grok', label: 'Grok', dir: join(home, '.grok', 'skills'), cover: 'grok' },
    { cli: 'opencode', label: 'OpenCode', dir: join(home, '.config', 'opencode', 'skills') },
    { cli: 'gemini', label: 'Gemini CLI', dir: join(home, '.gemini', 'skills') },
    { cli: 'copilot', label: 'GitHub Copilot', dir: join(home, '.copilot', 'skills'), cover: 'copilot' },
    { cli: 'agents', label: 'Pi and shared agents', dir: join(home, '.agents', 'skills') },
  ];
  if (caseDir) {
    roots.push(
      { cli: 'case-claude', label: 'This case (Claude)', dir: join(caseDir, '.claude', 'skills') },
      { cli: 'case-agents', label: 'This case (project)', dir: join(caseDir, '.agents', 'skills') },
      { cli: 'case-grok', label: 'This case (Grok)', dir: join(caseDir, '.grok', 'skills') }
    );
  }
  return roots;
}

function catalogFile(deps: ExtensionDeps): string {
  return join(deps.dataDir, 'extensions', 'catalog.json');
}

function marketplaceDir(deps: ExtensionDeps): string {
  return join(deps.dataDir, 'extensions', 'marketplace');
}

async function readCatalog(deps: ExtensionDeps): Promise<ExtensionCatalog> {
  try {
    const parsed = JSON.parse(await readFile(catalogFile(deps), 'utf8')) as ExtensionCatalog;
    if (parsed?.version !== 1 || !Array.isArray(parsed.items)) throw new Error('bad catalog');
    for (const item of parsed.items) {
      if (!item || typeof item.id !== 'string' || !Array.isArray(item.copies) || !Array.isArray(item.plugins)) {
        throw new Error('bad catalog');
      }
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, items: [] };
    throw new ExtensionError('OPERATION_FAILED', 'The extensions catalog is unreadable. It was left unchanged.');
  }
}

async function writeCatalog(deps: ExtensionDeps, catalog: ExtensionCatalog): Promise<void> {
  const file = catalogFile(deps);
  await mkdir(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.catalog-${process.pid}.json`);
  await writeFile(tmp, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

function marketplaceEntries(items: ExtensionRecord[]): { name: string; source: string; description?: string }[] {
  const seen = new Set<string>();
  const entries: { name: string; source: string; description?: string }[] = [];
  for (const item of items) {
    if (item.kind !== 'plugin') continue;
    const name = safePluginName(item.name);
    const slug = item.id.startsWith('plugin:') ? item.id.slice('plugin:'.length) : '';
    if (!name || seen.has(name) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) continue;
    seen.add(name);
    entries.push({
      name,
      source: `./plugins/${slug}`,
      ...(item.description ? { description: item.description } : {}),
    });
  }
  return entries;
}

async function rewriteMarketplace(deps: ExtensionDeps, items: ExtensionRecord[]): Promise<void> {
  const body = `${JSON.stringify({ name: MARKETPLACE_NAME, plugins: marketplaceEntries(items) }, null, 2)}\n`;
  const root = marketplaceDir(deps);
  for (const folder of ['.claude-plugin', '.grok-plugin']) {
    const dir = join(root, folder);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.marketplace-${process.pid}.json`);
    await writeFile(tmp, body, { mode: 0o644 });
    await rename(tmp, join(dir, 'marketplace.json'));
  }
}

type DestState = 'absent' | 'ours' | 'foreign' | 'symlink';

async function destState(dir: string, id: string): Promise<DestState> {
  let stat;
  try {
    stat = await lstat(dir);
  } catch {
    return 'absent';
  }
  if (stat.isSymbolicLink()) return 'symlink';
  if (!stat.isDirectory()) return 'foreign';
  const marker = join(dir, MARKER);
  try {
    const markerStat = await lstat(marker);
    if (markerStat.isSymbolicLink() || !markerStat.isFile() || markerStat.size > 1024) return 'foreign';
    const parsed = JSON.parse(await readFile(marker, 'utf8')) as { managedBy?: unknown; id?: unknown };
    if (parsed.managedBy === 'codeman' && parsed.id === id) return 'ours';
  } catch {
    // missing or unreadable marker
  }
  return 'foreign';
}

async function writeMarker(dir: string, id: string): Promise<void> {
  const file = join(dir, MARKER);
  const existing = await lstat(file).catch(() => undefined);
  if (existing?.isSymbolicLink()) {
    throw new ExtensionError('CONFLICT', 'The extension marker is a symlink.');
  }
  await writeFile(file, `${JSON.stringify({ managedBy: 'codeman', id })}\n`, { mode: 0o644 });
}

/** A symlink anywhere between `dir` and `boundary` (not including `boundary`). */
async function symlinkBetween(dir: string, boundary: string): Promise<boolean> {
  let current = resolve(dir);
  const stop = resolve(boundary);
  while (current !== stop) {
    const stat = await lstat(current).catch(() => undefined);
    if (stat?.isSymbolicLink()) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return false;
}

async function copyTree(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, {
    recursive: true,
    dereference: false,
    errorOnExist: false,
    force: true,
    filter: (source) => {
      if (resolve(source) === resolve(src)) return true;
      if (basename(source) === MARKER) return false;
      try {
        return !lstatSync(source).isSymbolicLink();
      } catch {
        return false;
      }
    },
  });
}

async function homeReal(deps: ExtensionDeps): Promise<string> {
  return realpath(deps.homeDir).catch(() => resolve(deps.homeDir));
}

async function assertCase(caseDir: string, deps: ExtensionDeps): Promise<string> {
  const stat = await lstat(caseDir).catch(() => undefined);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ExtensionError('INVALID_INPUT', 'That case directory does not exist.');
  }
  const real = await realpath(caseDir);
  const home = await homeReal(deps);
  if (real === '/' || real === home) {
    throw new ExtensionError('INVALID_INPUT', 'Refusing to install into the home directory or /.');
  }
  return real;
}

async function assertLocal(inputPath: string, deps: ExtensionDeps): Promise<string> {
  if (!inputPath || !isAbsolute(inputPath)) {
    throw new ExtensionError('INVALID_INPUT', 'The path must be absolute on this host.');
  }
  const stat = await lstat(inputPath).catch(() => undefined);
  if (!stat) throw new ExtensionError('INVALID_INPUT', 'That path does not exist.');
  if (stat.isSymbolicLink()) {
    throw new ExtensionError('INVALID_INPUT', 'That path is a symlink. Import the directory it points at.');
  }
  const real = await realpath(inputPath);
  const home = await homeReal(deps);
  if (real === home) throw new ExtensionError('INVALID_INPUT', 'Refusing to import the home directory.');
  if (real === resolve('/')) throw new ExtensionError('INVALID_INPUT', 'Refusing to import /.');
  if (inside(resolve(deps.dataDir, 'extensions'), real)) {
    throw new ExtensionError('INVALID_INPUT', 'Refusing to import the extensions directory.');
  }
  return real;
}

function takeSlug(kind: 'skill' | 'plugin', name: string, fresh: Set<string>): string {
  const base = slugify(name);
  if (!base) throw new ExtensionError('INVALID_INPUT', `No usable name in "${clip(name)}".`);
  let slug = base;
  let n = 2;
  while (fresh.has(`${kind}:${slug}`)) {
    slug = `${base.slice(0, 60)}-${n}`;
    n += 1;
    if (n > 40) throw new ExtensionError('INVALID_INPUT', 'Too many skills share that name.');
  }
  fresh.add(`${kind}:${slug}`);
  return slug;
}

async function materialize(input: ImportInput, work: string, deps: ExtensionDeps): Promise<Materialized> {
  if (input.github) {
    const src = parseGitHubSource(input.github);
    const repoDir = join(work, 'repo');
    await deps.clone(src.cloneUrl, src.ref, repoDir);
    let root = repoDir;
    if (src.subdir) {
      const sub = resolve(repoDir, src.subdir);
      if (!inside(repoDir, sub)) {
        throw new ExtensionError('INVALID_INPUT', 'That GitHub path escapes the repository.');
      }
      const stat = await lstat(sub).catch(() => undefined);
      if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new ExtensionError('INVALID_INPUT', `That repository has no folder ${src.subdir}.`);
      }
      root = sub;
    }
    return { root, source: src.label, githubRepo: src.repo, subdir: Boolean(src.subdir) };
  }

  const real = await assertLocal(input.path ?? '', deps);
  const stat = await lstat(real);
  const source = clip(input.filename || real);
  if (stat.isDirectory()) return { root: real, source, subdir: false };
  if (!stat.isFile()) throw new ExtensionError('INVALID_INPUT', 'That path is not a file or a directory.');
  if (basename(real).toLowerCase() === 'skill.md') {
    if (stat.size > FILE_CAP) throw new ExtensionError('INVALID_INPUT', 'That SKILL.md is larger than 8 MB.');
    const front = readFrontmatter(await readFile(real, 'utf8'));
    const dir = join(work, slugify(front.name || 'skill') || 'skill');
    await mkdir(dir, { recursive: true });
    await copyFile(real, join(dir, 'SKILL.md'));
    return { root: dir, source, subdir: false };
  }
  const extracted = join(work, 'extracted');
  await extractArchive(real, extracted);
  return { root: extracted, source, subdir: false };
}

interface PlaceResult {
  target: ExtensionTarget;
  copy?: ExtensionCopy;
}

async function placeSkill(
  skill: FoundSkill,
  dirName: string,
  id: string,
  root: SkillRoot,
  boundary: string,
  replacing: boolean
): Promise<PlaceResult> {
  const label = root.label;
  if (await symlinkBetween(root.dir, boundary)) {
    return {
      target: {
        cli: root.cli,
        label,
        status: 'skipped',
        detail: `${root.dir} is reached through a symlink, so it was left alone.`,
      },
    };
  }
  const dest = join(root.dir, dirName);
  if (!inside(root.dir, dest)) {
    return { target: { cli: root.cli, label, status: 'failed', detail: 'The skill path escapes its directory.' } };
  }
  const state = await destState(dest, id);
  if (state === 'symlink') {
    return {
      target: { cli: root.cli, label, status: 'skipped', detail: `${dest} is a symlink, so it was left alone.` },
    };
  }
  if (state === 'foreign') {
    return {
      target: {
        cli: root.cli,
        label,
        status: 'skipped',
        detail: `${dest} already exists and is not a Codeman import, so it was left alone.`,
      },
    };
  }
  try {
    if (state === 'ours') {
      const again = await lstat(dest);
      if (again.isSymbolicLink()) {
        return {
          target: { cli: root.cli, label, status: 'skipped', detail: `${dest} is a symlink, so it was left alone.` },
        };
      }
      await rm(dest, { recursive: true, force: false });
    }
    await mkdir(root.dir, { recursive: true });
    await copyTree(skill.dir, dest);
    const skillFile = await lstat(join(dest, 'SKILL.md'));
    if (!skillFile.isFile()) throw new Error('SKILL.md is not a regular file after copy');
    await writeMarker(dest, id);
    return {
      target: { cli: root.cli, label, status: state === 'ours' || replacing ? 'refreshed' : 'installed' },
      copy: { cli: root.cli, path: dest },
    };
  } catch (err) {
    await rm(dest, { recursive: true, force: true }).catch(() => undefined);
    const message = err instanceof Error ? err.message : 'copy failed';
    return { target: { cli: root.cli, label, status: 'failed', detail: clip(message) } };
  }
}

function dirNameFor(name: string, used: Set<string>): string {
  const base = slugify(name) || 'skill';
  let slug = base;
  let n = 2;
  while (used.has(slug)) {
    slug = `${base.slice(0, 60)}-${n}`;
    n += 1;
  }
  used.add(slug);
  return slug;
}

async function copySkills(
  skills: FoundSkill[],
  id: string,
  roots: SkillRoot[],
  covered: Set<PluginSkillRoot>,
  boundary: string,
  replacing: boolean
): Promise<{ targets: ExtensionTarget[]; copies: ExtensionCopy[] }> {
  const targets: ExtensionTarget[] = [];
  const copies: ExtensionCopy[] = [];
  const used = new Set<string>();
  const named = skills.map((skill) => ({ skill, dirName: dirNameFor(skill.name, used) }));
  for (const root of roots) {
    if (root.cover && covered.has(root.cover)) {
      targets.push({
        cli: root.cli,
        label: root.label,
        status: 'skipped',
        detail: 'The plugin installer already loaded these skills.',
      });
      continue;
    }
    const placed: ExtensionTarget[] = [];
    for (const entry of named) {
      const result = await placeSkill(entry.skill, entry.dirName, id, root, boundary, replacing);
      placed.push(result.target);
      if (result.copy) copies.push(result.copy);
    }
    const installed = placed.filter((target) => target.status === 'installed' || target.status === 'refreshed');
    const failed = placed.find((target) => target.status === 'failed');
    if (installed.length > 0) {
      targets.push({
        cli: root.cli,
        label: root.label,
        status: installed.some((target) => target.status === 'refreshed') ? 'refreshed' : 'installed',
        detail: installed.length === named.length ? undefined : `${installed.length} of ${named.length} skills`,
      });
    } else if (failed) {
      targets.push({ cli: root.cli, label: root.label, status: 'failed', detail: failed.detail });
    } else if (placed[0]) {
      targets.push(placed[0]);
    }
  }
  return { targets, copies };
}

function succeeded(targets: ExtensionTarget[], copies: ExtensionCopy[]): boolean {
  return copies.length > 0 || targets.some((target) => target.status === 'installed' || target.status === 'refreshed');
}

function failureText(name: string, targets: ExtensionTarget[]): string {
  if (targets.length === 0) {
    return `${name} has no skills, and no plugin installer ran.`;
  }
  const bits = targets.map(
    (target) => `${target.label}: ${target.status}${target.detail ? ` (${target.detail})` : ''}`
  );
  return `Nothing from ${name} was installed. ${bits.join('; ')}`;
}

async function dropOwned(dir: string, id: string): Promise<void> {
  if ((await destState(dir, id)) !== 'ours') return;
  const stat = await lstat(dir);
  if (stat.isSymbolicLink()) return;
  await rm(dir, { recursive: true, force: false });
}

async function installPlugin(
  pluginDir: string,
  pluginName: string,
  description: string,
  ctx: {
    deps: ExtensionDeps;
    catalog: ExtensionCatalog;
    fresh: Set<string>;
    caseDir?: string;
    source: string;
    githubRepo?: string;
    notes: string[];
    boundary: string;
  }
): Promise<{ catalog: ExtensionCatalog; record: ExtensionRecord }> {
  const slug = takeSlug('plugin', pluginName, ctx.fresh);
  const id = `plugin:${slug}`;
  const replacing = ctx.catalog.items.some((item) => item.id === id);
  let catalog = ctx.catalog;
  if (replacing) catalog = await removeUnlocked(id, ctx.deps);

  const market = marketplaceDir(ctx.deps);
  const dest = join(market, 'plugins', slug);
  const state = await destState(dest, id);
  if (state === 'foreign' || state === 'symlink') {
    throw new ExtensionError('CONFLICT', `${dest} already exists and is not a Codeman import.`);
  }
  if (state === 'ours') await rm(dest, { recursive: true, force: false });
  try {
    await copyTree(pluginDir, dest);
    await writeMarker(dest, id);
  } catch (err) {
    await rm(dest, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  const safe = safePluginName(pluginName);
  const nameTaken = Boolean(safe) && catalog.items.some((item) => item.kind === 'plugin' && item.name === pluginName);
  const targets: ExtensionTarget[] = [];
  const plugins: ExtensionPluginInstall[] = [];
  const covered = new Set<PluginSkillRoot>();

  if (!safe) {
    ctx.notes.push(
      `"${clip(pluginName)}" is not a name a plugin installer accepts, so only its skills were copied. The plugin files were not rewritten.`
    );
  } else if (nameTaken) {
    ctx.notes.push(
      `A plugin named ${safe} is already imported, so this copy was not handed to the installers. Its skills were copied when that succeeded.`
    );
  } else {
    const preview: ExtensionRecord = {
      id,
      kind: 'plugin',
      name: pluginName,
      description,
      source: ctx.source,
      installedAt: stamp(ctx.deps),
      targets: [],
      copies: [],
      plugins: [],
    };
    await rewriteMarketplace(ctx.deps, [...catalog.items, preview]);
    for (const plan of pluginPlans({
      name: safe,
      pluginDir: dest,
      marketplaceDir: market,
      githubRepo: ctx.githubRepo,
    })) {
      if (!(await ctx.deps.binExists(plan.bin))) {
        targets.push({ cli: plan.bin, label: plan.label, status: 'skipped', detail: `${plan.bin} is not installed.` });
        continue;
      }
      try {
        for (const step of plan.install) {
          const result = await ctx.deps.run(step.bin, step.args, plan.timeoutMs);
          const text = `${result.stdout}\n${result.stderr}`;
          if (result.code !== 0 && !ALREADY_THERE.test(text)) {
            throw new Error(clip(text) || `${step.bin} exited ${result.code}`);
          }
        }
        targets.push({ cli: plan.bin, label: plan.label, status: replacing ? 'refreshed' : 'installed' });
        plugins.push({ cli: plan.bin, selector: plan.selector });
        if (plan.skillRoot) covered.add(plan.skillRoot);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'install failed';
        targets.push({ cli: plan.bin, label: plan.label, status: 'failed', detail: clip(message) });
      }
    }
  }

  const inner = await skillsInside(dest);
  const copied = await copySkills(
    inner,
    id,
    skillRoots(ctx.deps.homeDir, ctx.caseDir),
    covered,
    ctx.boundary,
    replacing
  );
  targets.push(...copied.targets);

  if (!succeeded(targets, copied.copies)) {
    await dropOwned(dest, id);
    await rewriteMarketplace(ctx.deps, catalog.items);
    const noCli = targets.every((target) => target.status === 'skipped' && /not installed/.test(target.detail ?? ''));
    const message =
      inner.length === 0 && (noCli || targets.length === 0)
        ? `${pluginName} has no skills, and none of the plugin CLIs (claude, grok, codex, agy, copilot) installed it.`
        : failureText(pluginName, targets);
    throw new ExtensionError('OPERATION_FAILED', message);
  }

  const record: ExtensionRecord = {
    id,
    kind: 'plugin',
    name: pluginName,
    description,
    source: ctx.source,
    installedAt: stamp(ctx.deps),
    targets,
    copies: copied.copies,
    plugins,
  };
  catalog = { version: 1, items: [...catalog.items.filter((item) => item.id !== id), record] };
  await writeCatalog(ctx.deps, catalog);
  await rewriteMarketplace(ctx.deps, catalog.items);
  return { catalog, record };
}

async function installSkill(
  skill: FoundSkill,
  ctx: {
    deps: ExtensionDeps;
    catalog: ExtensionCatalog;
    fresh: Set<string>;
    caseDir?: string;
    source: string;
    boundary: string;
  }
): Promise<{ catalog: ExtensionCatalog; record: ExtensionRecord }> {
  const slug = takeSlug('skill', skill.name, ctx.fresh);
  const id = `skill:${slug}`;
  const replacing = ctx.catalog.items.some((item) => item.id === id);
  let catalog = ctx.catalog;
  if (replacing) catalog = await removeUnlocked(id, ctx.deps);

  const copied = await copySkills(
    [skill],
    id,
    skillRoots(ctx.deps.homeDir, ctx.caseDir),
    new Set(),
    ctx.boundary,
    replacing
  );
  if (!succeeded(copied.targets, copied.copies)) {
    for (const copy of copied.copies) await dropOwned(copy.path, id);
    throw new ExtensionError('OPERATION_FAILED', failureText(skill.name, copied.targets));
  }
  const record: ExtensionRecord = {
    id,
    kind: 'skill',
    name: skill.name,
    description: skill.description,
    source: ctx.source,
    installedAt: stamp(ctx.deps),
    targets: copied.targets,
    copies: copied.copies,
    plugins: [],
  };
  catalog = { version: 1, items: [...catalog.items.filter((item) => item.id !== id), record] };
  await writeCatalog(ctx.deps, catalog);
  return { catalog, record };
}

async function importUnlocked(input: ImportInput, deps: ExtensionDeps): Promise<ImportResult> {
  if (Boolean(input.github) === Boolean(input.path)) {
    throw new ExtensionError('INVALID_INPUT', 'Provide a GitHub repository or a path.');
  }
  const caseDir = input.caseDir ? await assertCase(input.caseDir, deps) : undefined;
  const boundary = await homeReal(deps);
  const notes: string[] = [];
  if (!caseDir) notes.push(PROJECT_NOTE);

  await mkdir(join(deps.dataDir, 'extensions'), { recursive: true });
  const work = await mkdtemp(join(deps.dataDir, 'extensions', 'work-'));
  const installed: ExtensionRecord[] = [];
  try {
    const tree = await materialize(input, work, deps);
    const classified = await classifyTree(tree.root);
    const plainRepo = Boolean(tree.githubRepo) && !tree.subdir && classified.plugins.length === 1;
    if (tree.githubRepo && !plainRepo && (await deps.binExists('copilot'))) {
      notes.push(
        'GitHub Copilot installs a whole repository, and only when that repository contains one plugin. Its skills were copied into ~/.copilot/skills instead when that copy succeeded.'
      );
    }
    let catalog = await readCatalog(deps);
    const fresh = new Set<string>();
    const githubRepo = plainRepo ? tree.githubRepo : undefined;
    for (const plugin of classified.plugins) {
      const installedPlugin = await installPlugin(plugin.dir, plugin.name, plugin.description, {
        deps,
        catalog,
        fresh,
        caseDir,
        source: tree.source,
        githubRepo,
        notes,
        boundary,
      });
      catalog = installedPlugin.catalog;
      installed.push(installedPlugin.record);
    }
    for (const skill of classified.skills) {
      const installedSkill = await installSkill(skill, {
        deps,
        catalog,
        fresh,
        caseDir,
        source: tree.source,
        boundary,
      });
      catalog = installedSkill.catalog;
      installed.push(installedSkill.record);
    }
    return { installed, notes };
  } catch (err) {
    if (installed.length > 0 && err instanceof ExtensionError) {
      throw new ExtensionError(
        err.code,
        `Installed ${installed.map((item) => item.id).join(', ')}. Then: ${err.message}`
      );
    }
    throw err;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** The parent of a copied skill, when the path is exactly one directory under a known skill root. */
function skillParentOk(real: string, home: string): boolean {
  if (real === '/' || real === home) return false;
  const norm = real.split(sep).join('/');
  return SKILL_SUFFIXES.some((suffix) => {
    const needle = `/${suffix}/`;
    const idx = norm.indexOf(needle);
    if (idx < 0) return false;
    const rest = norm.slice(idx + needle.length);
    return rest.length > 0 && !rest.includes('/') && !rest.includes('..');
  });
}

async function removeCopy(copy: ExtensionCopy, id: string, deps: ExtensionDeps): Promise<boolean> {
  const stat = await lstat(copy.path).catch(() => undefined);
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) return true;
  const real = await realpath(copy.path);
  const home = await homeReal(deps);
  if (!skillParentOk(real, home)) return true;
  if ((await destState(real, id)) !== 'ours') return false;
  const again = await lstat(real);
  if (again.isSymbolicLink()) return true;
  await rm(real, { recursive: true, force: false });
  return false;
}

async function removeUnlocked(id: string, deps: ExtensionDeps): Promise<ExtensionCatalog> {
  const catalog = await readCatalog(deps);
  const index = catalog.items.findIndex((item) => item.id === id);
  if (index < 0) throw new ExtensionError('NOT_FOUND', `No imported extension ${id}.`);
  const record = catalog.items[index];
  const failed: ExtensionPluginInstall[] = [];
  const reasons: string[] = [];

  for (const plugin of record.plugins) {
    const step = uninstallStep(plugin);
    if (!step) {
      failed.push(plugin);
      reasons.push(`${plugin.cli}: unknown installer`);
      continue;
    }
    if (!(await deps.binExists(step.bin))) {
      failed.push(plugin);
      reasons.push(`${plugin.cli} is not installed, so ${plugin.selector} was not uninstalled.`);
      continue;
    }
    const result = await deps.run(step.bin, step.args, 60_000);
    const text = `${result.stdout}\n${result.stderr}`;
    if (result.code === 0 || ALREADY_GONE.test(text)) continue;
    failed.push(plugin);
    reasons.push(`${plugin.cli}: ${clip(text) || `exited ${result.code}`}`);
  }
  if (failed.length > 0) {
    record.plugins = failed;
    catalog.items[index] = record;
    await writeCatalog(deps, catalog);
    throw new ExtensionError('OPERATION_FAILED', `Could not uninstall ${id}. ${reasons.join(' ')}`);
  }

  const left: ExtensionCopy[] = [];
  for (const copy of record.copies) {
    if (await removeCopy(copy, id, deps)) left.push(copy);
  }
  if (left.length > 0) {
    record.copies = left;
    record.plugins = [];
    catalog.items[index] = record;
    await writeCatalog(deps, catalog);
    throw new ExtensionError(
      'OPERATION_FAILED',
      `Could not delete every copy of ${id}. The copies still listed were left in place.`
    );
  }

  if (record.kind === 'plugin' && id.startsWith('plugin:')) {
    const slug = id.slice('plugin:'.length);
    if (/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
      await dropOwned(join(marketplaceDir(deps), 'plugins', slug), id);
    }
  }
  catalog.items.splice(index, 1);
  await writeCatalog(deps, catalog);
  await rewriteMarketplace(deps, catalog.items);
  return catalog;
}

/** Import every skill and plugin in a GitHub repository or a local file. One import at a time. */
export function importExtensions(input: ImportInput, deps: ExtensionDeps): Promise<ImportResult> {
  return withLock(() => importUnlocked(input, deps));
}

/** The catalog. Paths are included so a caller can see where a copy went. File contents are not. */
export async function listExtensions(deps: ExtensionDeps): Promise<ExtensionRecord[]> {
  return (await readCatalog(deps)).items;
}

/** Remove one imported skill or plugin. A failed uninstall keeps the row so a retry can finish it. */
export function removeExtension(id: string, deps: ExtensionDeps): Promise<ExtensionRecord> {
  return withLock(async () => {
    const before = await readCatalog(deps);
    const record = before.items.find((item) => item.id === id);
    if (!record) throw new ExtensionError('NOT_FOUND', `No imported extension ${id}.`);
    await removeUnlocked(id, deps);
    return record;
  });
}

function spawnCaptured(bin: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, { env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const take = (prev: string, chunk: Buffer): string => {
      const next = prev + chunk.toString('utf8');
      return next.length > TAIL_BYTES ? next.slice(next.length - TAIL_BYTES) : next;
    };
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      stderr = take(stderr, Buffer.from(`\n${bin} timed out after ${timeoutMs} ms`));
      finish(124);
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = take(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = take(stderr, chunk);
    });
    child.on('error', (err) => {
      stderr = take(stderr, Buffer.from(err.message));
      finish(127);
    });
    child.on('close', (code) => finish(code ?? 1));
  });
}

/** Deps bound to this machine. `dataDir` and `homeDir` are read when a call starts. */
export function defaultExtensionDeps(): ExtensionDeps {
  return {
    homeDir: homedir(),
    dataDir: dataPath(),
    now: () => new Date(),
    binExists: async (bin) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(bin)) return false;
      const result = await spawnCaptured('which', [bin], 5_000);
      return result.code === 0 && result.stdout.trim().length > 0;
    },
    run: (bin, args, timeoutMs) => spawnCaptured(bin, args, timeoutMs),
    clone: async (url, ref, dest) => {
      const args = ['clone', '--depth', '1'];
      if (ref) args.push('--branch', ref);
      args.push('--', url, dest);
      const result = await spawnCaptured('git', args, 90_000, gitNonInteractiveEnv());
      if (result.code !== 0) {
        const detail = clip(result.stderr || result.stdout) || `git exited ${result.code}`;
        throw new ExtensionError('OPERATION_FAILED', `Could not clone that repository. ${detail}`);
      }
    },
  };
}
