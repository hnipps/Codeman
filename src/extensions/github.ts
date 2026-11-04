/**
 * @fileoverview Parse a pasted GitHub repository into a clone URL, ref and subdirectory.
 *
 * Only github.com over https. Owner/repo shorthand is accepted and rewritten to
 * that URL. SSH, other hosts, credentials and transport helpers are refused:
 * this endpoint clones as the Codeman user, and a helper URL would run code.
 *
 * @module extensions/github
 */

import { ExtensionError } from './types.js';

const MAX_LEN = 500;
/** GitHub owner or repo: no slashes, no leading dot, no `..`. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** A ref or path segment. Slashes are allowed only where the caller joins segments. */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

export interface GitHubSource {
  cloneUrl: string;
  /** owner/repo, for CLIs that install a plugin straight from GitHub. */
  repo: string;
  ref?: string;
  /** Path inside the repo. Empty means the repository root. */
  subdir?: string;
  /** The text shown in the catalog. */
  label: string;
}

function reject(message: string): never {
  throw new ExtensionError('INVALID_INPUT', message);
}

function name(value: string, what: string): string {
  if (!NAME_RE.test(value) || value.includes('..')) {
    reject(`That GitHub ${what} is not a usable name.`);
  }
  return value;
}

/** A relative path of safe segments, or undefined when empty. */
function subdir(segments: string[]): string | undefined {
  if (segments.length === 0) return undefined;
  const clean: string[] = [];
  for (const segment of segments) {
    if (!SEGMENT_RE.test(segment) || segment === '.' || segment === '..') {
      reject('That GitHub path has a segment Codeman will not check out.');
    }
    clean.push(segment);
  }
  return clean.join('/');
}

function refOf(value: string): string {
  const parts = value.split('/');
  if (parts.length === 0 || parts.some((part) => !SEGMENT_RE.test(part) || part === '.' || part === '..')) {
    reject('That GitHub ref is not a branch, tag or commit Codeman will check out.');
  }
  return parts.join('/');
}

/**
 * True when the text is trying to name a repository rather than a local file.
 * A failed parse then stays an error instead of being looked up as a path.
 */
export function looksLikeGitHub(input: string): boolean {
  const raw = input.trim();
  if (/^https?:\/\//i.test(raw)) return true;
  if (raw.startsWith('/') || raw.startsWith('.')) return false;
  return /^[^/\s]+\/[^/\s]+/.test(raw);
}

/**
 * Parse a GitHub repository the user pasted.
 *
 * Accepted:
 * - `owner/repo`
 * - `owner/repo@ref` and `owner/repo#subdir` (and both)
 * - `https://github.com/owner/repo` (optional `.git`)
 * - `https://github.com/owner/repo/tree/<ref>/<path>`
 * - `https://github.com/owner/repo/blob/<ref>/<path>` (a trailing SKILL.md is dropped)
 *
 * A tree or blob URL takes the first segment after `tree` or `blob` as the ref.
 * A branch name that itself contains a slash uses the `owner/repo@ref#path` form.
 */
export function parseGitHubSource(input: string): GitHubSource {
  const raw = (input ?? '').trim();
  if (!raw) reject('Enter a GitHub repository.');
  if (raw.length > MAX_LEN) reject(`That GitHub repository is longer than ${MAX_LEN} characters.`);
  // eslint-disable-next-line no-control-regex -- reject C0/C1 and DEL before they reach git.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(raw)) reject('That GitHub repository contains control characters.');
  if (raw.startsWith('-')) reject('That GitHub repository may not start with "-".');
  if (raw.includes('://') && raw.includes('@') && /:\/\/[^/]*@/.test(raw)) {
    reject('Remove the credentials from the URL. Codeman never accepts or stores Git credentials.');
  }

  if (/^https?:\/\//i.test(raw)) return parseUrl(raw);
  return parseShorthand(raw);
}

function parseShorthand(raw: string): GitHubSource {
  const hash = raw.indexOf('#');
  const withRef = hash === -1 ? raw : raw.slice(0, hash);
  const path = hash === -1 ? '' : raw.slice(hash + 1);
  const at = withRef.indexOf('@');
  const repoPart = at === -1 ? withRef : withRef.slice(0, at);
  const ref = at === -1 ? undefined : refOf(withRef.slice(at + 1));
  const [owner, repo, extra] = repoPart.split('/');
  if (!owner || !repo || extra !== undefined) {
    reject('Use owner/repo, or a https://github.com/owner/repo URL.');
  }
  return finish(name(owner, 'owner'), name(repo, 'repository'), ref, path ? subdir(path.split('/')) : undefined);
}

function parseUrl(raw: string): GitHubSource {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    reject('That does not look like a GitHub URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    reject('Use an https://github.com URL.');
  }
  if (url.username || url.password) {
    reject('Remove the credentials from the URL. Codeman never accepts or stores Git credentials.');
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') {
    reject('Codeman imports plugins and skills from github.com. Other hosts are refused.');
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    reject('That URL contains an invalid percent-escape.');
  }
  const segments = pathname
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.replace(/\.git$/i, ''));
  if (segments.length < 2) reject('That URL has no owner/repo in it.');
  const owner = name(segments[0], 'owner');
  const repo = name(segments[1], 'repository');
  if (segments.length === 2) return finish(owner, repo, undefined, undefined);

  const kind = segments[2];
  if (kind !== 'tree' && kind !== 'blob') {
    reject('Use the repository URL, or a /tree/ or /blob/ link to a folder inside it.');
  }
  if (segments.length < 4) reject('That GitHub link has no branch or path.');
  const ref = refOf(segments[3]);
  let rest = segments.slice(4);
  if (kind === 'blob' && rest[rest.length - 1]?.toLowerCase() === 'skill.md') rest = rest.slice(0, -1);
  return finish(owner, repo, ref, subdir(rest));
}

function finish(owner: string, repo: string, ref: string | undefined, sub: string | undefined): GitHubSource {
  const label = `https://github.com/${owner}/${repo}${ref ? `@${ref}` : ''}${sub ? `#${sub}` : ''}`;
  return {
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
    repo: `${owner}/${repo}`,
    ref,
    subdir: sub,
    label,
  };
}
