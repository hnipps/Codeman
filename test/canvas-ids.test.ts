import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { uuidFrom } from '../packages/canvas/src/ids.js';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
describe('canvas ids', () => {
  it('builds a valid v4 UUID from getRandomValues when randomUUID is missing (insecure contexts)', () => {
    const source = { getRandomValues: <T extends ArrayBufferView>(a: T) => crypto.getRandomValues(a as never) as T };
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = uuidFrom(source);
      expect(id).toMatch(V4);
      seen.add(id);
    }
    expect(seen.size).toBe(200);
  });
  it('sets the version and variant bits whatever the random bytes are', () => {
    for (const fill of [0x00, 0xff]) {
      const id = uuidFrom({
        getRandomValues: <T extends ArrayBufferView>(a: T) => (new Uint8Array(a.buffer).fill(fill), a),
      });
      expect(id).toMatch(V4);
    }
  });
  it('prefers the platform randomUUID when there is one', () => {
    expect(
      uuidFrom({
        randomUUID: () => 'fixed',
        getRandomValues: () => {
          throw new Error('unused');
        },
      })
    ).toBe('fixed');
  });
  it('is the only place packages/canvas calls crypto.randomUUID', () => {
    const dir = new URL('../packages/canvas/src', import.meta.url).pathname;
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]
      );
    const offenders = walk(dir).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('/ids.ts') && /crypto\.randomUUID/.test(readFileSync(f, 'utf8'))
    );
    expect(offenders).toEqual([]);
  });
});
