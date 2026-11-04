import { describe, expect, it } from 'vitest';
import { parseStatus, supervisorCli } from '../src/deploy-control.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const status = {
  live: { colour: 'blue', sha: SHA_A, port: 4001, since: '2026-01-01T00:00:00.000Z' },
  releases: [
    { sha: SHA_A, builtAt: '2026-01-01T00:00:00.000Z', dir: '/srv/x' },
    { sha: SHA_B, builtAt: '2026-01-02T00:00:00.000Z' },
  ],
  deploys: [
    {
      id: 'old',
      action: 'deploy',
      sha: SHA_A,
      outcome: 'success',
      failedStep: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:01:00.000Z',
      log: '/srv/log/old.log',
      port: 4002,
    },
    {
      id: 'new',
      action: 'rollback',
      sha: SHA_B,
      outcome: 'failed',
      failedStep: 'health',
      startedAt: '2026-01-02T00:00:00.000Z',
      finishedAt: null,
    },
  ],
  lock: null,
};

describe('parseStatus', () => {
  it('keeps only what the browser may see, newest deploy first', () => {
    const overview = parseStatus(status);
    expect(overview).toEqual({
      configured: true,
      live: { sha: SHA_A, since: '2026-01-01T00:00:00.000Z' },
      releases: [
        { sha: SHA_A, builtAt: '2026-01-01T00:00:00.000Z', live: true },
        { sha: SHA_B, builtAt: '2026-01-02T00:00:00.000Z', live: false },
      ],
      recent: [
        {
          id: 'new',
          action: 'rollback',
          sha: SHA_B,
          outcome: 'failed',
          failedStep: 'health',
          startedAt: '2026-01-02T00:00:00.000Z',
          finishedAt: null,
        },
        {
          id: 'old',
          action: 'deploy',
          sha: SHA_A,
          outcome: 'success',
          failedStep: null,
          startedAt: '2026-01-01T00:00:00.000Z',
          finishedAt: '2026-01-01T00:01:00.000Z',
        },
      ],
      busy: false,
    });
    expect(JSON.stringify(overview)).not.toMatch(/4001|4002|\/srv|blue/);
  });

  it('is busy while a lock is held, and copes with nothing live', () => {
    const overview = parseStatus({ ...status, live: null, lock: { pid: 1 } });
    expect(overview.busy).toBe(true);
    expect(overview.live).toBeNull();
    expect(overview.releases.every((r) => !r.live)).toBe(true);
  });

  it('skips deploy records with an action it does not show, such as start-live', () => {
    const startLive = {
      id: 'boot',
      action: 'start-live',
      sha: SHA_A,
      outcome: 'success',
      failedStep: null,
      startedAt: '2026-01-03T00:00:00.000Z',
      finishedAt: '2026-01-03T00:00:01.000Z',
    };
    const overview = parseStatus({ ...status, deploys: [...status.deploys, startLive] });
    expect(overview.recent.map((d) => d.id)).toEqual(['new', 'old']);
  });

  it('rejects a shape it does not know', () => {
    expect(() => parseStatus({ releases: 'x' })).toThrow();
  });
});

describe('supervisorCli', () => {
  it('needs an absolute path', () => {
    expect(supervisorCli({})).toBeNull();
    expect(supervisorCli({ CODEMAN_SUPERVISOR_CLI: '  ' })).toBeNull();
    expect(supervisorCli({ CODEMAN_SUPERVISOR_CLI: 'tool' })).toBeNull();
    expect(supervisorCli({ CODEMAN_SUPERVISOR_CLI: '/opt/tool' })).toBe('/opt/tool');
  });
});
