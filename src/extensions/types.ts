/**
 * @fileoverview Shared types for importing and removing plugins and skills.
 *
 * One catalog serves every agent CLI Codeman can launch. The settings screen,
 * `codeman extension`, the HTTP routes and the MCP tools all call the same
 * service, so an agent and a person install and remove through one path.
 *
 * @module extensions/types
 */

/** A per-CLI outcome stored on the catalog record and returned to callers. */
export interface ExtensionTarget {
  cli: string;
  label: string;
  status: 'installed' | 'refreshed' | 'skipped' | 'failed';
  detail?: string;
}

/** A skill directory Codeman copied and still owns. */
export interface ExtensionCopy {
  cli: string;
  /** Absolute path of the skill directory (the folder that contains SKILL.md). */
  path: string;
}

/** A plugin the CLI's own installer accepted, so remove can uninstall it. */
export interface ExtensionPluginInstall {
  cli: string;
  /** The selector that CLI's uninstall command expects. */
  selector: string;
}

/**
 * One imported skill or plugin. `copies` and `plugins` are the removal plan:
 * remove deletes only those paths and uninstalls only those selectors.
 */
export interface ExtensionRecord {
  id: string;
  kind: 'skill' | 'plugin';
  name: string;
  description: string;
  /** What the user pasted or uploaded, for the list. Never a secret. */
  source: string;
  installedAt: string;
  targets: ExtensionTarget[];
  copies: ExtensionCopy[];
  plugins: ExtensionPluginInstall[];
}

export interface ExtensionCatalog {
  version: 1;
  items: ExtensionRecord[];
}

export interface ImportInput {
  /** GitHub repository, owner/repo, or a tree/blob URL. */
  github?: string;
  /** Absolute path on the Codeman host: a directory, a zip, a tar.gz, or a SKILL.md file. */
  path?: string;
  /** Original upload filename, used only to name the source in the catalog. */
  filename?: string;
  /**
   * Absolute case directory. Skills are also copied into that case so CLIs that
   * only scan the project (Antigravity, DeepSeek, OMP) can see them.
   */
  caseDir?: string;
}

export interface ImportResult {
  installed: ExtensionRecord[];
  /** Limits and CLIs that still need a case, said once per import. */
  notes: string[];
}

export type ExtensionErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'OPERATION_FAILED';

/** A refusal the routes map onto the API error codes. The message is the whole answer. */
export class ExtensionError extends Error {
  readonly code: ExtensionErrorCode;

  constructor(code: ExtensionErrorCode, message: string) {
    super(message);
    this.name = 'ExtensionError';
    this.code = code;
  }
}

/** One CLI invocation. `tolerateExists` treats "already installed" as success. */
export interface PluginInstallStep {
  bin: string;
  args: string[];
  tolerateExists?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** What the service needs from the machine. Tests pass fakes. */
export interface ExtensionDeps {
  homeDir: string;
  dataDir: string;
  run: (bin: string, args: string[], timeoutMs: number) => Promise<RunResult>;
  binExists: (bin: string) => Promise<boolean>;
  clone: (url: string, ref: string | undefined, dest: string) => Promise<void>;
  now?: () => Date;
}
