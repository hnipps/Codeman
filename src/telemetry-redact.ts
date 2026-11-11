/**
 * @fileoverview Pure redaction of one telemetry line, before it is queued for disk.
 *
 * One function, no I/O, no caller-supplied pattern. It masks values under
 * credential keys, bearer tokens in any capitalization, URL userinfo with or
 * without a password, and a hook secret passed in as a literal string. Odd
 * input returns a placeholder instead of throwing. Attribution keys such as
 * `author` keep their values. Config backup keeps its own key rule.
 *
 * @module telemetry-redact
 */

const REDACTED = '[redacted]';
const HOOK_SECRET_MIN = 16;
const HOOK_SECRET_MAX = 256;
/** Skip the scanners when a line cannot hold a secret we know how to mask. */
const NEEDS_SCAN = /bearer|:\/\/|token|secret|passw|credential|auth|key/i;
const BEARER_RE = /\bbearer\s+[A-Za-z0-9._~+/=_-]{8,}/gi;
const CREDENTIAL_FRAGMENT = /token|secret|passw|credential/i;
const KEY_SUFFIX = /key$/i;
const AUTHORIZATION_WORD = /authorization/i;
const X_AUTH_PREFIX = /(^|[^a-z0-9])x[-_]auth[-_]/i;
/** The word after a bare `auth` stem when the key is naming a person, not a credential. */
const AUTH_ATTRIBUTION_NEXT = new Set(['user', 'username', 'name']);

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

function isWs(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

function splitKeyWords(key: string): string[] {
  const words: string[] = [];
  let cur = '';
  for (let i = 0; i < key.length; i++) {
    const ch = key[i];
    const prev = i > 0 ? key[i - 1] : '';
    const sep = !/[A-Za-z0-9]/.test(ch);
    const camel = /[a-z0-9]/.test(prev) && ch >= 'A' && ch <= 'Z';
    if (sep || camel) {
      if (cur) words.push(cur);
      cur = sep ? '' : ch;
      continue;
    }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words;
}

/**
 * A telemetry key names a credential. `author`, `authored`, `authUser` and
 * `authorId` do not. Config backup's `SECRET_KEY_RE` is a different rule.
 */
export function isTelemetrySecretKey(key: string): boolean {
  if (key.length === 0 || key.length > 80) return false;
  if (CREDENTIAL_FRAGMENT.test(key) || KEY_SUFFIX.test(key) || AUTHORIZATION_WORD.test(key)) return true;
  if (X_AUTH_PREFIX.test(key)) return true;
  const words = splitKeyWords(key);
  for (let i = 0; i < words.length; i++) {
    if (words[i].toLowerCase() !== 'auth') continue;
    const next = words[i + 1]?.toLowerCase();
    if (next === undefined || !AUTH_ATTRIBUTION_NEXT.has(next)) return true;
  }
  return false;
}

function hexDigit(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

/** A quoted key or value. Escapes follow JSON, plus `\'` for Node's single quotes. */
function decodeQuoted(text: string, open: number, maxChars: number): { value: string; end: number } | null {
  const quote = text[open];
  if (quote !== '"' && quote !== "'") return null;
  let j = open + 1;
  let value = '';
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\\') {
      if (j + 1 >= text.length) return null;
      const n = text[j + 1];
      if (n === 'u') {
        if (j + 5 >= text.length) return null;
        const hex = text.slice(j + 2, j + 6);
        if (hex.length < 4 || !hexDigit(hex[0]) || !hexDigit(hex[1]) || !hexDigit(hex[2]) || !hexDigit(hex[3])) {
          return null;
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
        return null;
      }
    } else if (ch === quote) {
      return { value, end: j + 1 };
    } else {
      value += ch;
      j++;
    }
    if (value.length > maxChars) return null;
  }
  return null;
}

function endOfQuoted(text: string, open: number): number {
  const decoded = decodeQuoted(text, open, 8192);
  return decoded ? decoded.end : Math.min(text.length, open + 8192);
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

function skipWs(text: string, i: number): number {
  while (i < text.length && isWs(text[i])) i++;
  return i;
}

function parseJsonKeyAt(text: string, quote: number): { key: string; valueStart: number } | null {
  if (text[quote] !== '"') return null;
  const decoded = decodeQuoted(text, quote, 80);
  if (!decoded || decoded.value.length === 0) return null;
  let j = skipWs(text, decoded.end);
  if (text[j] !== ':') return null;
  j = skipWs(text, j + 1);
  return { key: decoded.value, valueStart: j };
}

/** `"password": "hunter2"` and `"\u0070assword":"..."` inside a string. */
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
    if (!parsed || !isTelemetrySecretKey(parsed.key)) {
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

function endOfPlainValue(text: string, i: number): number {
  if (i >= text.length) return i;
  const q = text[i];
  if (q === '"' || q === "'") return Math.min(endOfQuoted(text, i), i + 8192);
  let j = i;
  const limit = Math.min(text.length, i + 8192);
  while (j < limit) {
    const c = text[j];
    if (isWs(c) || c === ',' || c === '}' || c === ']') break;
    j++;
  }
  return j;
}

interface Assignment {
  key: string;
  sep: number;
  valueEnd: number;
}

/** An identifier or a quoted key, then `:` or `=`, as `util.format` prints it. */
function parseAssignment(text: string, i: number): Assignment | null {
  let keyEnd = i;
  let key = '';
  const ch = text[i];
  if (ch === '"' || ch === "'") {
    const decoded = decodeQuoted(text, i, 80);
    if (!decoded || decoded.value.length === 0) return null;
    key = decoded.value;
    keyEnd = decoded.end;
  } else {
    if (!isIdentStart(text.charCodeAt(i))) return null;
    if (i > 0 && isIdent(text.charCodeAt(i - 1))) return null;
    keyEnd = i + 1;
    while (keyEnd < text.length && isIdent(text.charCodeAt(keyEnd))) keyEnd++;
    if (keyEnd - i > 80) return null;
    key = text.slice(i, keyEnd);
  }
  const sep = skipWs(text, keyEnd);
  if (text[sep] !== ':' && text[sep] !== '=') return null;
  const valueStart = skipWs(text, sep + 1);
  return { key, sep, valueEnd: endOfPlainValue(text, valueStart) };
}

/** `password: 'hunter2'`, `'api-key': '...'` and `password:\\tsecret`. */
function maskAssignments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const parsed = parseAssignment(text, i);
    if (!parsed || !isTelemetrySecretKey(parsed.key)) {
      out += text[i];
      i++;
      continue;
    }
    out += text.slice(i, parsed.sep + 1);
    out += ` ${REDACTED}`;
    i = parsed.valueEnd > parsed.sep ? parsed.valueEnd : parsed.sep + 1;
  }
  return out;
}

function isSchemeChar(code: number, first: boolean): boolean {
  if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return true;
  if (first) return false;
  return (code >= 48 && code <= 57) || code === 43 || code === 45 || code === 46;
}

/** `scheme://userinfo@host`, password optional, scheme letters any case. */
function maskUrlUserinfo(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const colon = text.indexOf('://', i);
    if (colon === -1) {
      out += text.slice(i);
      break;
    }
    let scheme = colon - 1;
    while (scheme >= i && isSchemeChar(text.charCodeAt(scheme), false)) scheme--;
    scheme++;
    if (scheme >= colon || !isSchemeChar(text.charCodeAt(scheme), true)) {
      out += text.slice(i, colon + 3);
      i = colon + 3;
      continue;
    }
    const authStart = colon + 3;
    let j = authStart;
    let at = -1;
    const limit = Math.min(text.length, authStart + 512);
    while (j < limit) {
      const code = text.charCodeAt(j);
      if (code === 64) {
        at = j;
        break;
      }
      if (code <= 32 || code === 47 || code === 63 || code === 35 || code === 92) break;
      j++;
    }
    if (at <= authStart) {
      out += text.slice(i, authStart);
      i = authStart;
      continue;
    }
    out += text.slice(i, authStart);
    out += `${REDACTED}@`;
    i = at + 1;
  }
  return out;
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
