import { describe, expect, it } from 'vitest';
import { PREVIEW_STRIPPED_ENV, buildPreviewEnv } from '../src/preview-env.js';
import { PREVIEW_ID_ENV, PREVIEW_OWNER_ENV } from '../src/preview-proc.js';

describe('buildPreviewEnv', () => {
  const input = { port: 4321, previewId: 'wv-1', owner: '/data/one' };

  it('drops every listed variable, keys deleted rather than left undefined', () => {
    const base = Object.fromEntries(PREVIEW_STRIPPED_ENV.map((name) => [name, 'from-the-server']));
    const env = buildPreviewEnv(base, input);
    for (const name of PREVIEW_STRIPPED_ENV) expect(Object.hasOwn(env, name)).toBe(false);
  });

  it('keeps the rest of the environment, CODEMAN_API_URL included', () => {
    const env = buildPreviewEnv(
      { PATH: '/usr/bin', HOME: '/home/x', CODEMAN_API_URL: 'https://127.0.0.1:1', CODEMAN_CASES_PATH: '/cases' },
      input
    );
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/home/x',
      CODEMAN_API_URL: 'https://127.0.0.1:1',
      CODEMAN_CASES_PATH: '/cases',
    });
  });

  it('sets PORT and both stop markers, overriding inherited values', () => {
    const env = buildPreviewEnv({ PORT: '1', [PREVIEW_ID_ENV]: 'stale', [PREVIEW_OWNER_ENV]: '/data/other' }, input);
    expect(env.PORT).toBe('4321');
    expect(env[PREVIEW_ID_ENV]).toBe('wv-1');
    expect(env[PREVIEW_OWNER_ENV]).toBe('/data/one');
  });

  it('never strips the markers the stop path depends on', () => {
    expect(PREVIEW_STRIPPED_ENV).not.toContain(PREVIEW_ID_ENV);
    expect(PREVIEW_STRIPPED_ENV).not.toContain(PREVIEW_OWNER_ENV);
  });

  it('names the instance, deploy and credential variables', () => {
    for (const name of [
      'CODEMAN_INSTANCE',
      'CODEMAN_DATA_DIR',
      'CODEMAN_TMUX_SOCKET',
      'CODEMAN_DEPLOY_ROLE',
      'CODEMAN_PASSWORD',
      'CODEMAN_USERNAME',
    ]) {
      expect(PREVIEW_STRIPPED_ENV).toContain(name);
    }
  });

  it('does not mutate the base environment', () => {
    const base = { CODEMAN_DATA_DIR: '/data/live' };
    buildPreviewEnv(base, input);
    expect(base).toEqual({ CODEMAN_DATA_DIR: '/data/live' });
  });
});
