/**
 * @fileoverview Pure redaction of one telemetry line, before it is queued for disk.
 *
 * One function, no I/O, no caller-supplied pattern. A key that contains a
 * credential word is masked, at any length, except a short exact allowlist of
 * attribution keys. A key longer than the classifier cap is secret too, and is
 * not copied or normalised. A key may start with a digit. The masked span is
 * the whole value: a quoted string, a bracketed object or array, or an
 * unquoted token. When that end is not found, the span runs to the end of the
 * line. The inside of a quote that is not itself a secret value is scanned for
 * the same shapes, up to a fixed depth. Bearer tokens have no minimum length.
 * URL userinfo is masked through the last `@` in the authority. A hook secret
 * is removed as a literal. Odd input returns a placeholder instead of throwing.
 * A secret with no key and no known shape is not detected. Config backup keeps
 * its own key rule.
 *
 * @module telemetry-redact
 */

const REDACTED = '[redacted]';
const HOOK_SECRET_MIN = 16;
const HOOK_SECRET_MAX = 256;
/**
 * Keys longer than this are secret without a second walk. The round-2
 * regression key (`81` a's plus `password`) is shorter, so it still goes
 * through the real classifier.
 */
const KEY_CAP = 256;
/** Nested quotes scanned for assignments. Deeper marked text is masked whole. */
const QUOTE_DEPTH = 4;
/** Skip the scanners when a line cannot hold a secret we know how to mask. */
const NEEDS_SCAN = /bearer|:\/\/|token|secret|passw|credential|auth|key/i;
const BEARER_RE = /\bbearer\s+\S+/gi;
/** Credential words. `key` is a substring, so an ordinary word such as `keyboard` matches. */
const CREDENTIAL_MARK = /token|secret|passw|credential|auth|key/i;
/** `Error:` itself, or `TypeError:` and the same shape. The shorter pattern misses `Error:`. */
const ERROR_LABEL = /^(?:[A-Za-z][A-Za-z0-9]*)?Error:$/;
const PATH_LINE = /^\d+(:\d+)*\)?$/;

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
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

function isKeyChar(code: number): boolean {
  return isIdentStart(code) || code === 45 || code === 46;
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
 * A key longer than `KEY_CAP` is secret without normalisation. Attribution
 * keys in `ATTRIBUTION_KEYS` do not match. Config backup's `SECRET_KEY_RE`
 * is a different rule and still matches `author`.
 */
export function isTelemetrySecretKey(key: string): boolean {
  if (key.length === 0) return false;
  if (key.length > KEY_CAP) return true;
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

interface QuoteEnd {
  end: number;
  closed: boolean;
}

/** Closing quote, ignoring a `\"` or `\'`. An unclosed quote ends at the text. */
function findQuoteEnd(text: string, open: number): QuoteEnd {
  const quote = text[open];
  let j = open + 1;
  while (j < text.length) {
    const at = text.indexOf(quote, j);
    if (at < 0) return { end: text.length, closed: false };
    let slashes = 0;
    let p = at - 1;
    while (p >= open && text.charCodeAt(p) === 92) {
      slashes++;
      p--;
    }
    if (slashes % 2 === 0) return { end: at + 1, closed: true };
    j = at + 1;
  }
  return { end: text.length, closed: false };
}

/** A short quoted key. Callers use `findQuoteEnd` for a key past `KEY_CAP`. */
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
 * end of the text. The quote closer is an index, not a copied string.
 */
function endOfValue(text: string, i: number): number {
  if (i >= text.length) return text.length;
  const ch = text[i];
  if (ch === '"' || ch === "'") return findQuoteEnd(text, i).end;
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
      const found = findQuoteEnd(text, j);
      if (!found.closed || found.end <= j) return text.length;
      j = found.end;
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

/**
 * A path-like key's `file.ts:247:27)` and a `<Word>Error:` label are diagnostics,
 * not credentials. Anything else after a secret key is masked.
 */
function isExemptValue(text: string, valueStart: number, pathLike: boolean): boolean {
  const ch = text[valueStart];
  if (!ch || ch === '"' || ch === "'" || ch === '{' || ch === '[') return false;
  let j = valueStart;
  let sample = '';
  while (j < text.length && sample.length < 64) {
    const c = text[j];
    if (isWs(c) || c === ',' || c === '}' || c === ']') break;
    sample += c;
    j++;
  }
  if (j < text.length) {
    const c = text[j];
    if (!isWs(c) && c !== ',' && c !== '}' && c !== ']') return false;
  }
  if (ERROR_LABEL.test(sample)) return true;
  return pathLike && PATH_LINE.test(sample);
}

interface UnquotedKey {
  end: number;
  key: string;
  overlong: boolean;
  pathLike: boolean;
}

function readUnquotedKey(text: string, i: number): UnquotedKey | null {
  if (!isIdentStart(text.charCodeAt(i))) return null;
  if (i > 0 && isKeyChar(text.charCodeAt(i - 1))) return null;
  let end = i + 1;
  let overlong = false;
  let pathLike = false;
  while (end < text.length && isKeyChar(text.charCodeAt(end))) {
    if (text.charCodeAt(end) === 46) pathLike = true;
    end++;
    if (end - i > KEY_CAP) {
      overlong = true;
      while (end < text.length && isKeyChar(text.charCodeAt(end))) {
        if (text.charCodeAt(end) === 46) pathLike = true;
        end++;
      }
      break;
    }
  }
  return { end, key: overlong ? '' : text.slice(i, end), overlong, pathLike };
}

function maskValue(
  parts: string[],
  text: string,
  from: number,
  sep: number,
  valueStart: number
): { end: number; changed: boolean } {
  const valueEnd = endOfValue(text, valueStart);
  const end = valueEnd > valueStart ? valueEnd : valueStart;
  const replacement = ` ${REDACTED}`;
  parts.push(text.slice(from, sep + 1));
  parts.push(replacement);
  return { end, changed: text.slice(sep + 1, end) !== replacement };
}

/**
 * Assignments and the inside of a quote that is not a secret value.
 * A non-secret key does not pull its value in, so a line of ordinary
 * `scheme:` pairs does not rescan its tail.
 */
function maskSecrets(text: string, depth: number): string {
  const parts: string[] = [];
  let i = 0;
  let changed = false;
  while (i < text.length) {
    const ch = text[i];
    const quote = ch === '"' || ch === "'";
    const ident = isIdentStart(text.charCodeAt(i)) && (i === 0 || !isKeyChar(text.charCodeAt(i - 1)));
    if (!quote && !ident) {
      const start = i;
      i++;
      while (i < text.length) {
        const c = text[i];
        if (c === '"' || c === "'" || (isIdentStart(text.charCodeAt(i)) && !isKeyChar(text.charCodeAt(i - 1)))) break;
        i++;
      }
      parts.push(text.slice(start, i));
      continue;
    }
    if (quote) {
      const found = findQuoteEnd(text, i);
      const interiorEnd = found.closed ? found.end - 1 : text.length;
      const rawLen = interiorEnd - (i + 1);
      const sep = found.closed ? skipWs(text, found.end) : text.length;
      const sepChar = text[sep];
      const hasSep = sepChar === ':' || sepChar === '=';
      if (hasSep && found.closed) {
        let secret = rawLen > KEY_CAP;
        let pathLike = false;
        if (!secret && rawLen > 0) {
          const quoted = readQuoted(text, i);
          const key = quoted && quoted.closed ? quoted.value : '';
          pathLike = key.includes('.') || key.includes('/');
          secret = key.length > 0 && (key.length > KEY_CAP || isTelemetrySecretKey(key));
        }
        if (secret) {
          const valueStart = skipWs(text, sep + 1);
          if (!isExemptValue(text, valueStart, pathLike)) {
            const masked = maskValue(parts, text, i, sep, valueStart);
            if (masked.changed) changed = true;
            i = masked.end;
            continue;
          }
        }
      }
      const interior = text.slice(i + 1, interiorEnd);
      const scanned = scanInterior(interior, depth);
      if (scanned !== interior) changed = true;
      parts.push(ch);
      parts.push(scanned);
      if (found.closed) parts.push(ch);
      if (!found.closed) break;
      i = found.end;
      continue;
    }
    const key = readUnquotedKey(text, i);
    if (!key) {
      parts.push(ch);
      i++;
      continue;
    }
    const sep = skipWs(text, key.end);
    const sepChar = text[sep];
    if ((sepChar === ':' || sepChar === '=') && (key.overlong || isTelemetrySecretKey(key.key))) {
      const valueStart = skipWs(text, sep + 1);
      if (!isExemptValue(text, valueStart, key.pathLike)) {
        const masked = maskValue(parts, text, i, sep, valueStart);
        if (masked.changed) changed = true;
        i = masked.end;
        continue;
      }
    }
    parts.push(text.slice(i, key.end));
    i = key.end;
  }
  return changed ? parts.join('') : text;
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
 * `scheme://userinfo@host`. The mask runs through the last `@` before `/`,
 * `?`, `#`, whitespace, or the end of the authority. A cut-off authority is
 * masked only when a `:` is followed by a non-digit, so `host:port` stays.
 */
function maskUrlUserinfo(text: string): string {
  if (!text.includes('://')) return text;
  const parts: string[] = [];
  let i = 0;
  let changed = false;
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
    let lastAt = -1;
    let stopped = false;
    let colonThenNonDigit = false;
    while (j < text.length) {
      const code = text.charCodeAt(j);
      if (isUserinfoStop(code)) {
        stopped = true;
        break;
      }
      if (code === 64) lastAt = j;
      else if (code === 58) {
        const next = j + 1 < text.length ? text.charCodeAt(j + 1) : -1;
        if (next < 48 || next > 57) colonThenNonDigit = true;
      }
      j++;
    }
    if (lastAt >= authStart) {
      parts.push(text.slice(i, authStart));
      parts.push(`${REDACTED}@`);
      changed = true;
      i = lastAt + 1;
      continue;
    }
    if (!stopped && colonThenNonDigit) {
      parts.push(text.slice(i, authStart));
      parts.push(REDACTED);
      changed = true;
      break;
    }
    const next = j > authStart ? j : authStart + 1;
    parts.push(text.slice(i, next));
    i = next;
  }
  return changed ? parts.join('') : text;
}

function scanInterior(interior: string, depth: number): string {
  if (interior.length === 0) return interior;
  if (depth + 1 >= QUOTE_DEPTH) return NEEDS_SCAN.test(interior) ? REDACTED : interior;
  if (!NEEDS_SCAN.test(interior)) return interior;
  return redactPlainOnce(interior, depth + 1);
}

function redactPlainOnce(text: string, depth: number): string {
  BEARER_RE.lastIndex = 0;
  let bearer = text;
  if (BEARER_RE.test(text)) {
    BEARER_RE.lastIndex = 0;
    bearer = text.replace(BEARER_RE, `Bearer ${REDACTED}`);
  }
  BEARER_RE.lastIndex = 0;
  return maskUrlUserinfo(maskSecrets(bearer, depth));
}

/** Up to three passes so a mask that uncovers a later shape still settles. */
function redactPlain(text: string, secret: string | undefined): string {
  let out = applySecret(text, secret);
  if (!NEEDS_SCAN.test(out)) return out;
  for (let pass = 0; pass < 3; pass++) {
    const next = redactPlainOnce(out, 0);
    if (next === out) return out;
    out = next;
  }
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
