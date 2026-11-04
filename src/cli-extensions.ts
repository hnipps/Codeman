/**
 * @fileoverview `codeman extension` — import, list and remove plugins and skills.
 *
 * The same actions as Settings and `POST/DELETE /api/v1/extensions`. A path that
 * exists is read as a local file. Anything else that looks like a GitHub
 * repository is cloned. Agents can rely on `--json` and on `--help`.
 *
 * @module cli-extensions
 */

import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { looksLikeGitHub, parseGitHubSource } from './extensions/github.js';
import { defaultExtensionDeps, importExtensions, listExtensions, removeExtension } from './extensions/service.js';
import { ExtensionError, type ExtensionRecord, type ImportInput, type ImportResult } from './extensions/types.js';
import { palette } from './cli-style.js';
import { getErrorMessage } from './types.js';

/** A local path when one exists, otherwise a GitHub repository. */
export function resolveExtensionSource(source: string, cwd: string): ImportInput {
  const trimmed = source.trim();
  if (!trimmed) throw new ExtensionError('INVALID_INPUT', 'Provide a GitHub repository or a path.');
  const abs = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
  if (existsSync(abs)) return { path: abs };
  if (looksLikeGitHub(trimmed)) {
    parseGitHubSource(trimmed);
    return { github: trimmed };
  }
  throw new ExtensionError('INVALID_INPUT', `No such file: ${abs}`);
}

function printRecord(record: ExtensionRecord): void {
  console.log(`${record.id}  ${record.kind}  ${record.name}`);
  for (const target of record.targets) {
    const detail = target.detail ? ` — ${target.detail}` : '';
    console.log(`  ${target.label}: ${target.status}${detail}`);
  }
}

function printImport(result: ImportResult, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.installed.length === 0) {
    console.log('Nothing installed.');
  }
  for (const record of result.installed) printRecord(record);
  for (const note of result.notes) console.log(note);
}

export function registerExtensionCommands(program: Command, resolveCase: (name: string) => string): void {
  const extension = program
    .command('extension')
    .description('Import and remove plugins and skills for every agent CLI');

  extension
    .command('list')
    .description('List plugins and skills Codeman has imported')
    .option('--json', 'Print the catalog as JSON')
    .action(async (options: { json?: boolean }) => {
      try {
        const items = await listExtensions(defaultExtensionDeps());
        if (options.json) {
          console.log(JSON.stringify({ items }, null, 2));
          return;
        }
        if (items.length === 0) {
          console.log('No imported plugins or skills.');
          return;
        }
        for (const item of items) {
          console.log(`${item.id}  ${item.kind}  ${item.name}  ${item.source}`);
        }
      } catch (err) {
        fail(err);
      }
    });

  extension
    .command('import <source>')
    .description('Import a GitHub repository, or a local directory, zip, tar.gz, or SKILL.md')
    .option('-c, --case <name>', 'Also copy skills into this case (for CLIs that only scan the project)')
    .option('--json', 'Print the install result as JSON')
    .action(async (source: string, options: { case?: string; json?: boolean }) => {
      try {
        const input = resolveExtensionSource(source, process.cwd());
        if (options.case) {
          const dir = resolveCase(options.case);
          if (!existsSync(dir)) {
            console.error(palette.err(`✗ Case not found: ${dir}`));
            process.exit(1);
          }
          input.caseDir = dir;
        }
        const result = await importExtensions(input, defaultExtensionDeps());
        printImport(result, Boolean(options.json));
      } catch (err) {
        fail(err);
      }
    });

  extension
    .command('remove <id>')
    .description('Uninstall a plugin or skill Codeman imported (id from `extension list`)')
    .option('--json', 'Print the removed record as JSON')
    .action(async (id: string, options: { json?: boolean }) => {
      try {
        const removed = await removeExtension(id, defaultExtensionDeps());
        if (options.json) console.log(JSON.stringify(removed, null, 2));
        else console.log(palette.ok(`✓ Removed ${removed.id}`));
      } catch (err) {
        fail(err);
      }
    });
}

function fail(err: unknown): void {
  const message = err instanceof ExtensionError ? err.message : getErrorMessage(err);
  console.error(palette.err(`✗ ${message}`));
  process.exit(1);
}
