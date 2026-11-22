/**
 * The Reviews page's pr-swarm words (`src/web/public/reviews-swarm.js`), run as the browser runs the script, and the
 * rules the page keeps around them: agent text reaches the DOM as text only, and the script loads before the page.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const PUBLIC = join(__dirname, '..', 'src', 'web', 'public');
const source = readFileSync(join(PUBLIC, 'reviews-swarm.js'), 'utf8');
const sandbox: { window: Record<string, unknown> } = { window: {} };
runInNewContext(source, sandbox);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const S = sandbox.window.CodemanReviewSwarm as any;

const SHA1 = '1'.repeat(40);
const SHA2 = '2'.repeat(40);
const queued = { id: 'run00000001', trigger: 'manual', requestedAt: 1, state: 'queued', tip: SHA1 };
const running = {
  id: 'run00000001',
  trigger: 'push',
  requestedAt: 1,
  state: 'running',
  sessionId: 's1',
  startedAt: 2,
  round: 2,
  roundTip: SHA1,
};
const result = { verdict: 'REQUEST_CHANGES', findings: [], degradations: [] };
const changes = {
  id: 'run00000002',
  trigger: 'submit',
  requestedAt: 1,
  state: 'changes',
  sessionId: 's1',
  startedAt: 2,
  endedAt: 3,
  rounds: 1,
  reviewedTip: SHA2,
  result,
};
const file = (runs: object[], escalated: object | null = null) => ({
  version: 1,
  reviewId: 'aaaaaaaa',
  streak: 0,
  escalated,
  runs,
});

describe('the chip', () => {
  it('names every state the server sends, with a tone, and nothing for an unknown or absent one', () => {
    expect(S.chip('running')).toEqual({ text: 'swarm: running', tone: 'run' });
    expect(S.chip('approve').tone).toBe('ok');
    expect(S.chip('changes').tone).toBe('warn');
    expect(S.chip('escalated').tone).toBe('bad');
    expect(S.chip('queued').text).toBe('swarm: queued');
    expect(S.chip(undefined)).toBeNull();
    expect(S.chip('toString')).toBeNull();
  });
});

describe('the top bar', () => {
  it('shows the round and tip of a running run, and the newer tip a push brought', () => {
    expect(S.statusLine(file([running]))).toBe('round 2 · 1111111');
    expect(S.statusLine(file([{ ...running, pendingTip: SHA2 }]))).toBe('round 2 · 1111111 · new commits at 2222222');
    expect(S.statusLine(file([queued]))).toBe('waiting for a slot · 1111111');
    expect(S.statusLine(file([changes]))).toBe('reviewed 2222222');
    expect(S.statusLine(file([]))).toBe('');
  });

  it('Run pr-swarm reads Running… and is disabled while a run is active, and says why it cannot start', () => {
    const live = { swarm: file([changes]), live: true, refusal: null };
    expect(S.runButton(live, {})).toMatchObject({ text: 'Run pr-swarm', disabled: false });
    expect(S.runButton({ ...live, swarm: file([running]) }, {})).toMatchObject({ text: 'Running…', disabled: true });
    expect(S.runButton({ ...live, swarm: file([queued]) }, {})).toMatchObject({ text: 'Running…', disabled: true });
    expect(S.runButton(live, { busy: true }).disabled).toBe(true);
    expect(S.runButton(live, { decided: true }).disabled).toBe(true);
    const candidate = S.runButton({ ...live, live: false }, {});
    expect(candidate.disabled).toBe(true);
    expect(candidate.title).toMatch(/not the live one/);
    expect(S.runButton({ ...live, refusal: 'a Docker case' }, {})).toMatchObject({
      disabled: true,
      title: 'a Docker case',
    });
  });
});

describe('the escalation line', () => {
  it('says why the review waits, for both kinds, and nothing when it is not escalated', () => {
    expect(S.escalation(file([]))).toBeNull();
    expect(S.escalation(file([], { kind: 'streak', at: 1, runIds: ['run00000001'] }))).toMatch(
      /two pr-swarm verdicts in a row/
    );
    expect(S.escalation(file([], { kind: 'r3', at: 1, runId: 'run00000001', trigger: 'constraint-broken' }))).toMatch(
      /R-3 found that the work breaks a constraint of the spec/
    );
  });
});

describe('the panel', () => {
  it('names each run state', () => {
    expect(S.verdict(changes)).toBe('Request changes');
    expect(S.verdict({ ...changes, state: 'passed', result: { ...result, verdict: 'APPROVE_WITH_NITS' } })).toBe(
      'Approve with nits'
    );
    expect(S.verdict(running)).toBe('Running, round 2');
    expect(S.verdict({ state: 'failed' })).toBe('Failed');
    expect(S.verdict({ state: 'incomplete' })).toMatch(/kept moving/);
  });

  it('a finding links into Changes with a path the page’s link reader decodes back', () => {
    const href = S.findingHref({ file: 'src/a b:c.ts', line: 12 });
    const m = /^#code=(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(href)!;
    expect(decodeURIComponent(m[1])).toBe('src/a b:c.ts');
    expect(m[2]).toBe('12');
    expect(S.findingHref({ file: 'src/a.ts', line: 'general' })).toBe('#code=src%2Fa.ts');
    expect(S.findingHref({ file: '', line: 'general' })).toBeNull();
  });

  it('a fix commit links to GitHub only for a GitHub pull request and a full sha', () => {
    expect(S.commitHref('https://github.com/o/r/pull/7', SHA1)).toBe(`https://github.com/o/r/commit/${SHA1}`);
    expect(S.commitHref('https://example.com/o/r/pull/7', SHA1)).toBeNull();
    expect(S.commitHref('javascript:alert(1)//github.com/o/r/pull/7', SHA1)).toBeNull();
    expect(S.commitHref('https://github.com/o/r/pull/7', 'abc')).toBeNull();
    expect(S.commitHref(undefined, SHA1)).toBeNull();
  });

  it('the send line offers Send again only after a failed send', () => {
    const clock = () => '10:00';
    expect(S.sendLine(changes, clock)).toBeNull();
    expect(S.sendLine({ ...changes, send: { state: 'sent', at: 1 } }, clock)).toEqual({
      text: 'Sent to the agent at 10:00.',
      failed: false,
    });
    expect(S.sendLine({ ...changes, send: { state: 'failed', at: 1, reason: 'pane gone' } }, clock)).toEqual({
      text: 'Not sent: pane gone',
      failed: true,
    });
  });

  it('R-3 names its trigger when it escalated', () => {
    expect(S.r3Label({ verdict: 'pass' })).toBe('R-3 · Pass');
    expect(S.r3Trigger({ verdict: 'escalate', trigger: 'outgrew-ticket' })).toBe(
      'It escalated because the work outgrew its ticket.'
    );
    expect(S.r3Trigger({ verdict: 'changes' })).toBe('');
  });
});

describe('the page around it', () => {
  it('agent text reaches the DOM as text: neither the words nor the page’s pr-swarm code use innerHTML', () => {
    expect(source).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    const page = readFileSync(join(PUBLIC, 'reviews.js'), 'utf8');
    const start = page.indexOf('// ---------------------------------------------------------------- pr-swarm');
    const end = page.indexOf('// ---------------------------------------------------------------- walkthrough');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(page.slice(start, end)).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
  });

  it('the page loads the words before itself and listens for review:swarm', () => {
    const html = readFileSync(join(PUBLIC, 'reviews.html'), 'utf8');
    const words = html.indexOf('src="reviews-swarm.js"');
    expect(words).toBeGreaterThan(0);
    expect(words).toBeLessThan(html.indexOf('src="reviews.js"'));
    expect(readFileSync(join(PUBLIC, 'reviews.js'), 'utf8')).toContain("addEventListener('review:swarm'");
  });
});
