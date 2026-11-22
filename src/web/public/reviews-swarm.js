/**
 * @fileoverview The Reviews page's pr-swarm words: what the chip, the status line, the Run button, the escalation
 * line and each run say, as pure functions over `GET /api/reviews/:id/swarm` (design:
 * intent/2026-11-20-pr-swarm-reviews.md, Design). `reviews.js` owns the DOM and writes every string here with
 * `textContent`; nothing here builds markup.
 *
 * @loadorder before reviews.js
 */
(function (root) {
  'use strict';

  const CHIPS = {
    queued: { text: 'swarm: queued', tone: 'run' },
    running: { text: 'swarm: running', tone: 'run' },
    approve: { text: 'swarm: approve', tone: 'ok' },
    changes: { text: 'swarm: changes', tone: 'warn' },
    escalated: { text: 'swarm: escalated', tone: 'bad' },
  };

  const VERDICTS = {
    APPROVE: 'Approve',
    APPROVE_WITH_NITS: 'Approve with nits',
    REQUEST_CHANGES: 'Request changes',
    BLOCKED: 'Blocked',
  };

  const R3_TRIGGERS = {
    'outcome-changed': 'the work changes an outcome the spec set',
    'constraint-broken': 'the work breaks a constraint of the spec',
    'unspecified-visible-change': 'the work makes a visible change the spec does not cover',
    'outgrew-ticket': 'the work outgrew its ticket',
    'unresolved-disagreement': 'the reviewers disagree and could not settle it',
    unverifiable: 'the work could not be verified',
    'deploy-fix-failed': 'a fix for a failed deploy did not work',
  };

  const R3_VERDICTS = { pass: 'Pass', changes: 'Changes', escalate: 'Escalate', unavailable: 'Unavailable' };

  const TRIGGERS = { submit: 'on submit', push: 'on a push', manual: 'by hand' };

  const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 7) : '');

  /** The chip's text and tone, or null when the review has no run state worth a chip. */
  function chip(name) {
    return Object.prototype.hasOwnProperty.call(CHIPS, name) ? CHIPS[name] : null;
  }

  const activeRun = (file) => {
    const run = file && file.runs && file.runs[0];
    return run && (run.state === 'queued' || run.state === 'running') ? run : null;
  };

  /** The round or tip beside the chip in the top bar. */
  function statusLine(file) {
    const active = activeRun(file);
    if (active && active.state === 'running')
      return `round ${active.round} · ${short(active.roundTip)}${
        active.pendingTip ? ` · new commits at ${short(active.pendingTip)}` : ''
      }`;
    if (active) return `waiting for a slot · ${short(active.tip)}`;
    const last = file && file.runs && file.runs.find((r) => r.reviewedTip);
    return last ? `reviewed ${short(last.reviewedTip)}` : '';
  }

  /**
   * The Run pr-swarm button. It is the person's own press, so it is offered whenever a run could start, and says why
   * when one cannot.
   */
  function runButton(data, opts) {
    const busy = !!(opts && opts.busy);
    const decided = !!(opts && opts.decided);
    if (activeRun(data && data.swarm))
      return { text: 'Running…', disabled: true, title: 'A pr-swarm run is queued or running for this review.' };
    if (busy) return { text: 'Starting…', disabled: true, title: '' };
    if (decided) return { text: 'Run pr-swarm', disabled: true, title: 'This review has been decided.' };
    if (data && data.live === false)
      return {
        text: 'Run pr-swarm',
        disabled: true,
        title: 'This server is not the live one, so it does not start runs. The live server does.',
      };
    if (data && data.refusal) return { text: 'Run pr-swarm', disabled: true, title: data.refusal };
    return { text: 'Run pr-swarm', disabled: false, title: 'Reviews the branch tip with pr-swarm now.' };
  }

  /** Why the review waits for its owner, or null when it is not escalated. */
  function escalation(file) {
    const e = file && file.escalated;
    if (!e) return null;
    if (e.kind === 'r3')
      return `Escalated to you: R-3 found that ${R3_TRIGGERS[e.trigger] || e.trigger}. Nothing is sent to an agent and nothing merges by itself until you act.`;
    return 'Escalated to you: two pr-swarm verdicts in a row asked for changes. Nothing is sent to an agent and nothing merges by itself until you act.';
  }

  /** A run's state as one phrase. */
  function verdict(run) {
    switch (run.state) {
      case 'queued':
        return 'Queued';
      case 'running':
        return `Running, round ${run.round}`;
      case 'passed':
      case 'changes':
      case 'blocked':
        return VERDICTS[run.result.verdict] || run.result.verdict;
      case 'incomplete':
        return 'Incomplete: the branch kept moving';
      case 'failed':
        return 'Failed';
      default:
        return run.state;
    }
  }

  const VERDICT_TONE = { passed: 'ok', changes: 'warn', blocked: 'bad', failed: 'bad', incomplete: 'dim' };
  const verdictTone = (run) => VERDICT_TONE[run.state] || 'run';

  /** The run's line in the earlier-runs list: when, how it started, the tip and the rounds. */
  function runLine(run, ago) {
    const when = ago(run.endedAt || run.startedAt || run.requestedAt);
    const tip = run.reviewedTip || run.roundTip || run.tip;
    const rounds = run.rounds ? ` · ${run.rounds} ${run.rounds === 1 ? 'round' : 'rounds'}` : '';
    return `${when} · ${TRIGGERS[run.trigger] || run.trigger}${tip ? ` · ${short(tip)}` : ''}${rounds}`;
  }

  /** The Changes link of a finding, or null for a finding about no file. */
  function findingHref(finding) {
    if (!finding.file) return null;
    const line = finding.line === 'general' ? '' : `:${finding.line}`;
    return `#code=${encodeURIComponent(finding.file)}${line}`;
  }

  /** A fix commit's page on GitHub, when the review's pull request is a GitHub one; otherwise null. */
  function commitHref(prUrl, sha) {
    if (typeof prUrl !== 'string' || !/^[0-9a-f]{40}$/.test(sha || '')) return null;
    const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/\d+/.exec(prUrl);
    return m ? `https://github.com/${m[1]}/${m[2]}/commit/${sha}` : null;
  }

  function r3Label(r3) {
    return `R-3 · ${R3_VERDICTS[r3.verdict] || r3.verdict}`;
  }

  const r3Tone = (r3) => ({ pass: 'ok', changes: 'warn', escalate: 'bad' })[r3.verdict] || 'dim';

  function r3Trigger(r3) {
    return r3.verdict === 'escalate' ? `It escalated because ${R3_TRIGGERS[r3.trigger] || r3.trigger}.` : '';
  }

  /** What became of the verdict's send, or null when the run sends nothing. */
  function sendLine(run, clock) {
    const send = run.send;
    if (!send) return null;
    if (send.state === 'pending') return { text: 'Sending the findings to the agent.', failed: false };
    if (send.state === 'sent') return { text: `Sent to the agent at ${clock(send.at)}.`, failed: false };
    return { text: `Not sent: ${send.reason}`, failed: true };
  }

  const api = {
    chip,
    statusLine,
    runButton,
    escalation,
    verdict,
    verdictTone,
    runLine,
    findingHref,
    commitHref,
    r3Label,
    r3Tone,
    r3Trigger,
    sendLine,
    activeRun,
  };
  root.CodemanReviewSwarm = api;
})(typeof window !== 'undefined' ? window : globalThis);
