/**
 * @fileoverview The argv each agent CLI accepts to install and remove a plugin.
 *
 * The marketplace name is `codeman-imports`. `codeman` is the published
 * marketplace for this product, and reusing it would collide with that install.
 * Plans are pure data: the service decides which binaries exist and runs them.
 *
 * @module extensions/plugin-plans
 */

import type { ExtensionPluginInstall, PluginInstallStep } from './types.js';

export const MARKETPLACE_NAME = 'codeman-imports';

const CLI_TIMEOUT_MS = 60_000;
const SLOW_TIMEOUT_MS = 90_000;

export type PluginSkillRoot = 'claude' | 'codex' | 'grok' | 'copilot';

export interface CliPluginPlan {
  bin: string;
  label: string;
  /** What uninstall must pass back to this CLI. */
  selector: string;
  install: PluginInstallStep[];
  uninstall: PluginInstallStep[];
  /**
   * A successful install already exposes the plugin's skills to this CLI, so
   * the service does not also copy them into that CLI's skill directory.
   * Antigravity has no entry here: Pi reads ~/.agents/skills either way.
   */
  skillRoot?: PluginSkillRoot;
  timeoutMs: number;
}

/**
 * Install and uninstall argv for one plugin.
 *
 * `githubRepo` is `owner/repo` only when the import is that whole repository.
 * Copilot's installer accepts a GitHub repo and rejects a local directory, so
 * it is included only then. A subdirectory or a second plugin is copied as skills.
 */
export function pluginPlans(input: {
  name: string;
  pluginDir: string;
  marketplaceDir: string;
  githubRepo?: string;
}): CliPluginPlan[] {
  const { name, pluginDir, marketplaceDir, githubRepo } = input;
  const selector = `${name}@${MARKETPLACE_NAME}`;
  const plans: CliPluginPlan[] = [
    {
      bin: 'claude',
      label: 'Claude Code',
      selector,
      timeoutMs: CLI_TIMEOUT_MS,
      skillRoot: 'claude',
      install: [
        {
          bin: 'claude',
          args: ['plugin', 'install', name, '--marketplace', marketplaceDir, '--scope', 'user', '--yes', '--json'],
        },
      ],
      uninstall: [
        {
          bin: 'claude',
          args: ['plugin', 'uninstall', selector, '--scope', 'user', '--yes', '--json'],
        },
      ],
    },
    {
      bin: 'grok',
      label: 'Grok',
      selector: name,
      timeoutMs: CLI_TIMEOUT_MS,
      skillRoot: 'grok',
      install: [{ bin: 'grok', args: ['plugin', 'install', pluginDir, '--trust'] }],
      uninstall: [{ bin: 'grok', args: ['plugin', 'uninstall', name, '--confirm'] }],
    },
    {
      bin: 'codex',
      label: 'Codex',
      selector,
      timeoutMs: CLI_TIMEOUT_MS,
      skillRoot: 'codex',
      install: [
        { bin: 'codex', args: ['plugin', 'marketplace', 'add', marketplaceDir, '--json'], tolerateExists: true },
        { bin: 'codex', args: ['plugin', 'add', selector, '--json'] },
      ],
      uninstall: [{ bin: 'codex', args: ['plugin', 'remove', selector, '--json'] }],
    },
    {
      bin: 'agy',
      label: 'Antigravity',
      selector: name,
      timeoutMs: CLI_TIMEOUT_MS,
      install: [{ bin: 'agy', args: ['plugin', 'install', pluginDir] }],
      uninstall: [{ bin: 'agy', args: ['plugin', 'uninstall', name] }],
    },
  ];
  if (githubRepo && /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(githubRepo)) {
    plans.push({
      bin: 'copilot',
      label: 'GitHub Copilot',
      selector: name,
      timeoutMs: SLOW_TIMEOUT_MS,
      skillRoot: 'copilot',
      install: [{ bin: 'copilot', args: ['plugin', 'install', githubRepo] }],
      uninstall: [{ bin: 'copilot', args: ['plugin', 'uninstall', name] }],
    });
  }
  return plans;
}

/** Uninstall argv for a selector the catalog stored. Unknown CLIs are skipped. */
export function uninstallStep(plugin: ExtensionPluginInstall): PluginInstallStep | undefined {
  switch (plugin.cli) {
    case 'claude':
      return { bin: 'claude', args: ['plugin', 'uninstall', plugin.selector, '--scope', 'user', '--yes', '--json'] };
    case 'grok':
      return { bin: 'grok', args: ['plugin', 'uninstall', plugin.selector, '--confirm'] };
    case 'codex':
      return { bin: 'codex', args: ['plugin', 'remove', plugin.selector, '--json'] };
    case 'agy':
      return { bin: 'agy', args: ['plugin', 'uninstall', plugin.selector] };
    case 'copilot':
      return { bin: 'copilot', args: ['plugin', 'uninstall', plugin.selector] };
    default:
      return undefined;
  }
}
