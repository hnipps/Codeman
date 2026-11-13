import { describe, expect, it } from 'vitest';
import { joinRelease, printedOutcome, releaseRequest, releaseText, type ReleaseRecord } from '../src/canvas/release.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const record = (over: Partial<ReleaseRecord> = {}): ReleaseRecord => ({
  id: 'd-1',
  action: 'deploy',
  sha: SHA,
  outcome: 'success',
  failedStep: null,
  startedAt: '2026-11-13T10:00:05.000Z',
  finishedAt: '2026-11-13T10:04:00.000Z',
  ...over,
});
const none = { deployId: null, outcome: null, failedStep: null };
const LATER = Date.parse('2026-11-13T12:00:00.000Z');

describe('a release request in a shell command', () => {
  it('reads a deploy of a commit, with or without a command in front of it', () => {
    expect(releaseRequest(`codeman-deploy ${SHA}`)).toEqual({ action: 'deploy', target: SHA });
    expect(releaseRequest('git push && codeman-deploy "$(git rev-parse HEAD)"')).toEqual({
      action: 'deploy',
      target: '$(git rev-parse HEAD)',
    });
  });
  it('reads a rollback and its target', () => {
    expect(releaseRequest('codeman-deploy rollback previous')).toEqual({ action: 'rollback', target: 'previous' });
    expect(releaseRequest(`cd repo\nFOO=1 codeman-deploy ${SHA} | tail -n 5`)).toEqual({
      action: 'deploy',
      target: SHA,
    });
  });
  it('asks for nothing on status, help, a flag, or a word that only contains the command name', () => {
    for (const command of [
      'codeman-deploy status',
      'codeman-deploy --help',
      'codeman-deploy help',
      'codeman-deploy rollback',
      'cat docs/codeman-deploy.md',
      'echo not-codeman-deploy abc',
      'which codeman-deploy',
      'git commit -m "docs: run codeman-deploy abc1234 after merge"',
      'grep -rn "codeman-deploy rollback" docs',
    ]) {
      expect(releaseRequest(command), command).toBeNull();
    }
  });
});

describe('what the deploy command printed', () => {
  it('takes the deploy id and the last outcome line, and the failed step', () => {
    const output = [
      'queued request r-9',
      'deploy d-7; log /somewhere/d-7.log',
      'outcome: this line is part of a test log',
      'outcome: failed at test: deploy/test.sh exited 1',
    ].join('\n');
    expect(printedOutcome(output)).toEqual({ deployId: 'd-7', outcome: 'failed', failedStep: 'test' });
    expect(printedOutcome('deploy d-8; log x\noutcome: success\n')).toEqual({
      deployId: 'd-8',
      outcome: 'success',
      failedStep: null,
    });
  });
  it('reads nothing from output that has neither line', () => {
    expect(printedOutcome('no result after 600s; request r-1 is still queued or running.')).toEqual(none);
  });
});

describe('joining a request with the supervisor record', () => {
  const asked = { toolId: 't1', request: { action: 'deploy' as const, target: SHA }, at: '2026-11-13T10:00:00.000Z' };

  it("uses the supervisor's run when the printed deploy id names it, whatever the command printed", () => {
    const view = joinRelease(
      { ...asked, printed: { deployId: 'd-1', outcome: 'success', failedStep: null }, pending: false },
      [record({ outcome: 'failed', failedStep: 'health' })]
    );
    expect(view).toMatchObject({ state: 'failed', failedStep: 'health', source: 'supervisor', sha: '0123456' });
    expect(releaseText(view).title).toBe('Release 0123456 · Failed at health');
  });
  it('without a printed id, matches the same action and commit started after the command, not an earlier run', () => {
    const earlier = record({
      id: 'd-0',
      startedAt: '2026-11-13T09:00:00.000Z',
      outcome: 'failed',
      failedStep: 'build',
    });
    const view = joinRelease({ ...asked, printed: none, pending: true }, [record(), earlier]);
    expect(view).toMatchObject({ state: 'succeeded', source: 'supervisor' });
    expect(joinRelease({ ...asked, printed: none, pending: false }, [earlier], LATER)).toMatchObject({
      state: 'unknown',
      source: 'none',
    });
  });
  it('does not take a run of another commit or another action for it', () => {
    const other = record({ sha: 'f'.repeat(40) });
    expect(joinRelease({ ...asked, printed: none, pending: false }, [other]).source).toBe('none');
    expect(joinRelease({ ...asked, printed: none, pending: false }, [record({ action: 'rollback' })]).source).toBe(
      'none'
    );
  });
  it('a run that has not finished is Running, never its outcome field', () => {
    const view = joinRelease({ ...asked, printed: none, pending: true }, [record({ finishedAt: null })]);
    expect(view.state).toBe('running');
    expect(releaseText(view).title).toBe('Release 0123456 · Running');
  });
  it('falls back to what the command printed and says so', () => {
    const view = joinRelease(
      { ...asked, printed: { deployId: 'd-gone', outcome: 'success', failedStep: null }, pending: false },
      [record({ id: 'd-other', startedAt: '2026-11-12T10:00:00.000Z' })]
    );
    expect(view).toMatchObject({ state: 'succeeded', source: 'printed' });
    expect(releaseText(view).note).toMatch(/command printed/);
    expect(joinRelease({ ...asked, printed: { ...none, outcome: 'rejected' }, pending: false }, null).state).toBe(
      'rejected'
    );
  });
  it('with no record and no printed outcome: Running while the command runs or was just asked in the background, then not known', () => {
    expect(joinRelease({ ...asked, printed: none, pending: true }, null, LATER)).toMatchObject({
      state: 'running',
      source: 'none',
    });
    const soon = Date.parse(asked.at) + 60_000;
    expect(joinRelease({ ...asked, printed: none, pending: false }, null, soon).state).toBe('running');
    expect(joinRelease({ ...asked, at: null, printed: none, pending: false }, null, soon).state).toBe('unknown');
    const done = joinRelease({ ...asked, printed: none, pending: false }, null, LATER);
    expect(done.state).toBe('unknown');
    expect(releaseText(done).title).toBe('Release 0123456 · Outcome not known');
  });
  it('names a rollback as one, and shows no commit for a target that is not one', () => {
    const view = joinRelease(
      {
        toolId: 't2',
        request: { action: 'rollback', target: 'previous' },
        printed: { deployId: null, outcome: 'success', failedStep: null },
        at: null,
        pending: false,
      },
      []
    );
    expect(releaseText(view).title).toBe('Rollback · Succeeded');
  });
});
