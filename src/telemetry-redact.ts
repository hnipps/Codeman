/**
 * @fileoverview Pure redaction of one telemetry line, before it is queued for disk.
 *
 * One function, no I/O, no caller-supplied pattern. A key that contains a
 * credential word is masked, at any length, except a short exact allowlist of
 * attribution keys. The masked span is the whole value: a quoted string, a
 * bracketed object or array, or an unquoted token. When that end is not found,
 * the span runs to the end of the line. Bearer tokens have no minimum length.
 * URL userinfo is masked at any length. A hook secret is removed as a literal.
 * Odd input returns a placeholder instead of throwing. A secret with no key and
 * no known shape is not detected. Config backup keeps its own key rule.
 *
 * @module telemetry-redact
 */

const REDACTED = '[redacted]';
const HOOK_SECRET_MIN = 16;
const HOOK_SECRET_MAX = 256;
/** Skip the scanners when a line cannot hold a secret we know how to mask. */
const NEEDS_SCAN = /bearer|:\/\/|token|secret|passw|credential|auth|key/i;
const BEARER_RE = /\bbearer\s+\S+/gi;
/** Credential words. `key` is a substring, so an ordinary word such as `keyboard` matches. */
const CREDENTIAL_MARK = /token|secret|passw|credential|auth|key/i;

/**
 * Attribution keys, after case and `-`/`_` are removed. Nothing else is exempt.
 * `authoredBy`, `authored_by` and `authored-by` share one entry.
 */
const ATTRIBUTION_KEYS = new Set(['author', 'authors', 'authored', 'authoredby', 'authorid', 'authorname', 'authuser']);

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

function isIdentStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

function isIdent(code: number): boolean {
  return isIdentStart(code) || (code >= 48 && code <= 57);
}

function isKeyChar(code: number): boolean {
  return isIdent(code) || code === 45 || code === 46;
}

function isWs(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

function normalizeKey(key: string): string {
  let out = '';
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code === 45 || code === 95) continue;
    if (code >= 65 && code <= 90) out += String.fromCharCode(code + 32);
    else out += key[i];
  }
  return out;
}

/**
 * A telemetry key names a credential when it contains one, at any length.
 * Attribution keys in `ATTRIBUTION_KEYS` do not. Config backup's `SECRET_KEY_RE`
 * is a different rule and still matches `author`.
 */
export function isTelemetrySecretKey(key: string): boolean {
  if (key.length === 0) return false;
  if (ATTRIBUTION_KEYS.has(normalizeKey(key))) return false;
  return CREDENTIAL_MARK.test(key);
}

function hexDigit(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

interface Quoted {
  value: string;
  end: number;
  closed: boolean;
}

/** A quoted span. An unclosed quote runs to the end of the text, which is the line. */
function readQuoted(text: string, open: number): Quoted | null {
  const quote = text[open];
  if (quote !== '"' && quote !== "'") return null;
  let j = open + 1;
  let value = '';
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\\') {
      if (j + 1 >= text.length) return { value, end: text.length, closed: false };
      const n = text[j + 1];
      if (n === 'u') {
        if (j + 5 >= text.length) return { value, end: text.length, closed: false };
        const hex = text.slice(j + 2, j + 6);
        if (hex.length < 4 || !hexDigit(hex[0]) || !hexDigit(hex[1]) || !hexDigit(hex[2]) || !hexDigit(hex[3])) {
          value += n;
          j += 2;
          continue;
        }
        value += String.fromCharCode(Number.parseInt(hex, 16));
        j += 6;
      } else if (n === '"' || n === "'" || n === '\\' || n === '/') {
        value += n;
        j += 2;
      } else if (n === 'b') {
        value += '\b';
        j += 2;
      } else if (n === 'f') {
        value += '\f';
        j += 2;
      } else if (n === 'n') {
        value += '\n';
        j += 2;
      } else if (n === 'r') {
        value += '\r';
        j += 2;
      } else if (n === 't') {
        value += '\t';
        j += 2;
      } else {
        value += n;
        j += 2;
      }
    } else if (ch === quote) {
      return { value, end: j + 1, closed: true };
    } else {
      value += ch;
      j++;
    }
  }
  return { value, end: text.length, closed: false };
}

/**
 * End of a value that is already being masked. The closer is a quote, a matching
 * bracket, or the next delimiter. When it is not found, the value runs to the
 * end of the text.
 */
function endOfValue(text: string, i: number): number {
  if (i >= text.length) return text.length;
  const ch = text[i];
  if (ch === '"' || ch === "'") {
    const quoted = readQuoted(text, i);
    return quoted ? quoted.end : text.length;
  }
  if (ch === '{' || ch === '[') return endOfBracketed(text, i);
  let j = i;
  while (j < text.length) {
    const c = text[j];
    if (isWs(c) || c === ',' || c === '}' || c === ']') break;
    j++;
  }
  return j;
}

function endOfBracketed(text: string, open: number): number {
  const stack: string[] = [];
  let j = open;
  while (j < text.length) {
    const c = text[j];
    if (c === '"' || c === "'") {
      const quoted = readQuoted(text, j);
      const next = quoted ? quoted.end : text.length;
      if (next <= j) return text.length;
      j = next;
      continue;
    }
    if (c === '{' || c === '[') {
      stack.push(c === '{' ? '}' : ']');
      j++;
      continue;
    }
    if (stack.length > 0 && c === stack[stack.length - 1]) {
      stack.pop();
      j++;
      if (stack.length === 0) return j;
      continue;
    }
    j++;
  }
  return text.length;
}

function skipWs(text: string, i: number): number {
  while (i < text.length && isWs(text[i])) i++;
  return i;
}

/** `"password": "hunter2"` and `"\u0070assword":"..."` inside a string. */
function maskJsonPairs(text: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    const quote = text.indexOf('"', i);
    if (quote === -1) {
      parts.push(text.slice(i));
      break;
    }
    const quoted = readQuoted(text, quote);
    if (!quoted || !quoted.closed) {
      parts.push(text.slice(i));
      break;
    }
    let j = skipWs(text, quoted.end);
    if (text[j] !== ':' || !isTelemetrySecretKey(quoted.value)) {
      parts.push(text.slice(i, quoted.end));
      i = quoted.end;
      continue;
    }
    j = skipWs(text, j + 1);
    const valueEnd = endOfValue(text, j);
    parts.push(text.slice(i, quote));
    parts.push(`${JSON.stringify(quoted.value)}: "${REDACTED}"`);
    i = valueEnd > j ? valueEnd : quoted.end;
  }
  return parts.join('');
}

interface Assignment {
  keyStart: number;
  key: string;
  sep: number;
  valueEnd: number;
}

function keyAt(text: string, i: number): { key: string; end: number } | null {
  const ch = text[i];
  if (ch === '"' || ch === "'") {
    const quoted = readQuoted(text, i);
    if (!quoted || !quoted.closed || quoted.value.length === 0) return null;
    return { key: quoted.value, end: quoted.end };
  }
  if (!isIdentStart(text.charCodeAt(i))) return null;
  if (i > 0 && isKeyChar(text.charCodeAt(i - 1))) return null;
  let end = i + 1;
  while (end < text.length && isKeyChar(text.charCodeAt(end))) end++;
  return { key: text.slice(i, end), end };
}

/**
 * An identifier, a separator-bearing word, or a quoted key, then `:` or `=`.
 * The value is scanned only after the key is known to be a credential, so a
 * line of ordinary `scheme:` pairs does not rescan its tail.
 */
function parseAssignment(text: string, i: number): Assignment | null {
  const key = keyAt(text, i);
  if (!key) return null;
  const sep = skipWs(text, key.end);
  if (text[sep] !== ':' && text[sep] !== '=') return null;
  if (!isTelemetrySecretKey(key.key)) return null;
  const valueStart = skipWs(text, sep + 1);
  const valueEnd = endOfValue(text, valueStart);
  return { keyStart: i, key: key.key, sep, valueEnd: valueEnd > valueStart ? valueEnd : valueStart };
}

/** `password: 'hunter2'`, `auth-header=...` and `{ authorization: { value: '...' } }`. */
function maskAssignments(text: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const maybeKey =
      ch === '"' || ch === "'" || (isIdentStart(text.charCodeAt(i)) && (i === 0 || !isKeyChar(text.charCodeAt(i - 1))));
    if (!maybeKey) {
      const start = i;
      i++;
      while (i < text.length) {
        const c = text[i];
        if (c === '"' || c === "'" || isIdentStart(text.charCodeAt(i))) break;
        i++;
      }
      parts.push(text.slice(start, i));
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quoted = readQuoted(text, i);
      if (!quoted || !quoted.closed) {
        parts.push(text.slice(i));
        break;
      }
    }
    const parsed = parseAssignment(text, i);
    if (!parsed || !isTelemetrySecretKey(parsed.key)) {
      const key = keyAt(text, i);
      const end = key && key.end > i ? key.end : i + 1;
      parts.push(text.slice(i, end));
      i = end;
      continue;
    }
    parts.push(text.slice(i, parsed.sep + 1));
    parts.push(` ${REDACTED}`);
    i = parsed.valueEnd > parsed.sep ? parsed.valueEnd : parsed.sep + 1;
  }
  return parts.join('');
}

function isSchemeChar(code: number, first: boolean): boolean {
  if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return true;
  if (first) return false;
  return (code >= 48 && code <= 57) || code === 43 || code === 45 || code === 46;
}

function isUserinfoStop(code: number): boolean {
  return code <= 32 || code === 47 || code === 63 || code === 35 || code === 92;
}

/**
 * `scheme://userinfo@host`, password optional, any userinfo length. When `@`
 * is not found before a delimiter, the span is not userinfo. When the scan
 * cannot decide, the rest of the line is masked.
 */
function maskUrlUserinfo(text: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    const colon = text.indexOf('://', i);
    if (colon === -1) {
      parts.push(text.slice(i));
      break;
    }
    let scheme = colon - 1;
    while (scheme >= i && isSchemeChar(text.charCodeAt(scheme), false)) scheme--;
    scheme++;
    if (scheme >= colon || !isSchemeChar(text.charCodeAt(scheme), true)) {
      parts.push(text.slice(i, colon + 3));
      i = colon + 3;
      continue;
    }
    const authStart = colon + 3;
    let j = authStart;
    let at = -1;
    let stopped = false;
    while (j < text.length) {
      const code = text.charCodeAt(j);
      if (code === 64) {
        at = j;
        break;
      }
      if (isUserinfoStop(code)) {
        stopped = true;
        break;
      }
      j++;
    }
    if (at > authStart) {
      parts.push(text.slice(i, authStart));
      parts.push(`${REDACTED}@`);
      i = at + 1;
      continue;
    }
    // A `user:secret` cut off before `@` has no delimiter. Mask through the end of the line.
    if (!stopped && text.slice(authStart, j).includes(':')) {
      parts.push(text.slice(i, authStart));
      parts.push(REDACTED);
      break;
    }
    const next = j > authStart ? j : authStart + 1;
    parts.push(text.slice(i, next));
    i = next;
  }
  return parts.join('');
}

function redactPlain(text: string, secret: string | undefined): string {
  let out = applySecret(text, secret);
  if (!NEEDS_SCAN.test(out)) return out;
  BEARER_RE.lastIndex = 0;
  out = out.replace(BEARER_RE, `Bearer ${REDACTED}`);
  out = maskUrlUserinfo(out);
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
      out[key] = redactValue(item, isTelemetrySecretKey(key), secret);
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
