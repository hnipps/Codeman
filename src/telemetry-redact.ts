/**
 * @fileoverview Pure redaction of one telemetry line, before it is queued for disk.
 *
 * One function, no I/O, no caller-supplied pattern. It masks values under keys that
 * match `SECRET_KEY_RE` (the same shape as config-backup), bearer tokens, URL
 * userinfo, and a hook secret passed in as a literal string. Odd input returns a
 * placeholder instead of throwing.
 *
 * @module telemetry-redact
 */

/**
 * Same shape as `SECRET_KEY_RE` in `src/config-backup.ts`. Duplicated so a log line
 * does not import the backup writer. `auth` is unanchored, so `author` matches too.
 */
export const SECRET_KEY_RE = /(token|secret|passw|credential|auth|key$)/i;

const REDACTED = '[redacted]';
const HOOK_SECRET_MIN = 16;
const HOOK_SECRET_MAX = 256;
/** Skip the scanners when a line cannot hold a secret we know how to mask. */
const NEEDS_SCAN = /bearer|:\/\/|token|secret|passw|credential|auth|key/i;
const BEARER_RE = /\b[Bb]earer\s+[A-Za-z0-9._~+/=_-]{8,}/g;
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s@:]{1,256}):([^/\s@]{1,256})@/gi;

function usableSecret(hookSecret: string | undefined): string | undefined {
  if (typeof hookSecret !== 'string') return undefined;
  const trimmed = hookSecret.trim();
  if (trimmed.length < HOOK_SECRET_MIN || trimmed.length > HOOK_SECRET_MAX) return undefined;
  if (trimmed.includes('\n') || trimmed.includes('\r') || trimmed.includes('\0')) return undefined;
  return trimmed;
}

function applySecret(text: string, secret: string | undefined): string {
  if (!secret || !text.includes(secret)) return text;
  return text.split(secret).join(REDACTED);
}

function toText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input == null) return '';
  if (typeof input === 'number') return Number.isFinite(input) ? String(input) : '';
  if (typeof input === 'boolean') return input ? 'true' : 'false';
  if (typeof input === 'bigint') return input.toString();
  try {
    const json = JSON.stringify(input);
    if (typeof json === 'string') return json;
  } catch {
    return '[unredactable]';
  }
  return '[unredactable]';
}

function endOfQuoted(text: string, open: number): number {
  const quote = text[open];
  let j = open + 1;
  while (j < text.length) {
    if (text[j] === '\\') {
      j += 2;
      continue;
    }
    if (text[j] === quote) return j + 1;
    j++;
  }
  return text.length;
}

function endOfJsonValue(text: string, i: number): number {
  if (i >= text.length) return text.length;
  const ch = text[i];
  if (ch === '"') return endOfQuoted(text, i);
  if (ch === '{' || ch === '[') {
    const close = ch === '{' ? '}' : ']';
    let depth = 0;
    let j = i;
    while (j < text.length) {
      const c = text[j];
      if (c === '"') {
        j = endOfQuoted(text, j);
        continue;
      }
      if (c === ch) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) return j + 1;
      }
      j++;
    }
    return text.length;
  }
  let j = i;
  while (j < text.length && text[j] !== ',' && text[j] !== '}' && text[j] !== ']') j++;
  return j;
}

function parseJsonKeyAt(text: string, quote: number): { key: string; valueStart: number } | null {
  let j = quote + 1;
  let key = '';
  while (j < text.length && text[j] !== '"') {
    if (text[j] === '\\') return null;
    key += text[j];
    j++;
    if (key.length > 80) return null;
  }
  if (text[j] !== '"' || key.length === 0) return null;
  j++;
  while (j < text.length && text[j] === ' ') j++;
  if (text[j] !== ':') return null;
  j++;
  while (j < text.length && text[j] === ' ') j++;
  return { key, valueStart: j };
}

/** `"password": "hunter2"` inside a string the JSON walk already pulled out. */
function maskJsonPairs(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const quote = text.indexOf('"', i);
    if (quote === -1) {
      out += text.slice(i);
      break;
    }
    const parsed = parseJsonKeyAt(text, quote);
    if (!parsed || !SECRET_KEY_RE.test(parsed.key)) {
      out += text.slice(i, quote + 1);
      i = quote + 1;
      continue;
    }
    const valueEnd = endOfJsonValue(text, parsed.valueStart);
    out += text.slice(i, quote);
    out += `"${parsed.key}": "${REDACTED}"`;
    i = valueEnd > quote ? valueEnd : quote + 1;
  }
  return out;
}

function isIdentStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

function isIdent(code: number): boolean {
  return isIdentStart(code) || (code >= 48 && code <= 57);
}

function endOfPlainValue(text: string, i: number): number {
  if (i >= text.length) return i;
  const q = text[i];
  if (q === '"' || q === "'") return Math.min(endOfQuoted(text, i), i + 8192);
  let j = i;
  const limit = Math.min(text.length, i + 8192);
  while (j < limit) {
    const c = text[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '}') break;
    j++;
  }
  return j;
}

/** `password: 'hunter2'` and `password=hunter2`, the shapes console output uses. */
function maskAssignments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (!isIdentStart(text.charCodeAt(i))) {
      out += text[i];
      i++;
      continue;
    }
    const start = i;
    i++;
    while (i < text.length && isIdent(text.charCodeAt(i))) i++;
    const key = text.slice(start, i);
    let k = i;
    while (k < text.length && text[k] === ' ') k++;
    const sep = text[k];
    if ((sep === ':' || sep === '=') && SECRET_KEY_RE.test(key)) {
      k++;
      while (k < text.length && text[k] === ' ') k++;
      const valueEnd = endOfPlainValue(text, k);
      out += `${key}${sep} ${REDACTED}`;
      i = valueEnd > i ? valueEnd : i;
      continue;
    }
    out += key;
  }
  return out;
}

function redactPlain(text: string, secret: string | undefined): string {
  let out = applySecret(text, secret);
  if (!NEEDS_SCAN.test(out)) return out;
  BEARER_RE.lastIndex = 0;
  out = out.replace(BEARER_RE, `Bearer ${REDACTED}`);
  URL_USERINFO_RE.lastIndex = 0;
  out = out.replace(URL_USERINFO_RE, `$1${REDACTED}@`);
  out = maskJsonPairs(out);
  out = maskAssignments(out);
  return out;
}

function redactValue(value: unknown, secretKey: boolean, secret: string | undefined): unknown {
  if (secretKey) return REDACTED;
  if (typeof value === 'string') return redactPlain(value, secret);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, false, secret));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactValue(item, SECRET_KEY_RE.test(key), secret);
    }
    return out;
  }
  return value;
}

function redactText(text: string, secret: string | undefined): string {
  const replaced = applySecret(text, secret);
  const changed = replaced !== text;
  if (!changed && !NEEDS_SCAN.test(replaced)) return text;
  const newline = replaced.endsWith('\n');
  const body = newline ? replaced.slice(0, -1) : replaced;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === 'object') {
      const redacted = redactValue(parsed, false, secret);
      const before = JSON.stringify(parsed);
      const after = JSON.stringify(redacted);
      if (before === after) return changed ? replaced : text;
      return newline ? `${after}\n` : after;
    }
  } catch {
    /* not JSON: the plain scanners still run */
  }
  const plain = redactPlain(body, secret);
  return newline ? `${plain}\n` : plain;
}

/**
 * Mask secrets in one log line. `hookSecret` is a literal value, never a pattern.
 * A secret shorter than 16 characters is ignored so a short string cannot blank a line.
 */
export function redactLogLine(input: unknown, hookSecret?: string): string {
  try {
    const secret = usableSecret(hookSecret);
    const text = typeof input === 'string' ? input : toText(input);
    return redactText(text, secret);
  } catch {
    return '[unredactable]';
  }
}
