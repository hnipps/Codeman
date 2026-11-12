type RandomSource = { randomUUID?: () => string; getRandomValues: <T extends ArrayBufferView>(array: T) => T };

/** `crypto.randomUUID` exists only in secure contexts (Safari omits it on plain http), `getRandomValues` everywhere. */
export function uuidFrom(source: RandomSource): string {
  if (typeof source.randomUUID === 'function') return source.randomUUID();
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A v4 UUID for ids the server validates as UUIDs. Every id the canvas mints goes through here. */
export const uuid = (): string => uuidFrom(crypto);
