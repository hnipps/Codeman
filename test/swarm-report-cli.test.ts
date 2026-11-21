/**
 * `codeman agent swarm report` (`src/cli-agent.ts`): the run id and size checks, finding the JSON result in what the
 * session saved, and the request it sends. Every refusal happens before any request.
 */
import { describe, expect, it } from 'vitest';
import {
  agentSwarmReport,
  EXIT,
  parseSwarmReportText,
  SWARM_REPORT_MAX_BYTES,
  type AgentDeps,
  type ApiResponse,
  type RequestOptions,
} from '../src/cli-agent.js';

const fakeDeps = (answer: ApiResponse) => {
  const calls: RequestOptions[] = [];
  const out: string[] = [];
  const deps: AgentDeps = {
    ctx: { apiUrl: 'http://127.0.0.1:1', selfId: 'self-session-1' },
    json: false,
    io: { out: (l) => out.push(l), err: (l) => out.push(l) },
    request: async (_c, options) => {
      calls.push(options);
      return answer;
    },
  };
  return { deps, calls, out };
};
const answered = (data: unknown): ApiResponse => ({ status: 200, json: { success: true, data }, text: '' });

describe('parseSwarmReportText', () => {
  it('reads a whole-file JSON object', () => {
    expect(parseSwarmReportText(' {"verdict":"APPROVE"}\n')).toEqual({ ok: true, report: { verdict: 'APPROVE' } });
  });

  it('reads the last fenced JSON block of a transcript', () => {
    const text = 'Round 1\n```json\n{"round":1}\n```\nthen\n```json\n{"round":2}\n```\nDone.';
    expect(parseSwarmReportText(text)).toEqual({ ok: true, report: { round: 2 } });
  });

  it('refuses no JSON, and JSON that is not one object', () => {
    expect(parseSwarmReportText('nothing here').ok).toBe(false);
    expect(parseSwarmReportText('[1,2]')).toMatchObject({ ok: false, error: expect.stringContaining('object') });
  });
});

describe('agentSwarmReport', () => {
  it('posts the result for the run and tells the session to end its turn', async () => {
    const { deps, calls, out } = fakeDeps(answered({ state: 'running', round: 2, tip: 'b'.repeat(40) }));
    expect(await agentSwarmReport(deps, { runId: 'abcdef0123456789', text: '{"verdict":"APPROVE"}' })).toBe(EXIT.ok);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/api/v1/reviews/swarm-runs/abcdef0123456789/report',
      body: { report: { verdict: 'APPROVE' } },
    });
    expect(out.join(' ')).toContain('round 2 follows');
  });

  it('refuses a bad run id, an oversized result and an unreadable one before any request', async () => {
    for (const runId of ['', 'short', 'ABCDEF0123456789', '../../etc', 'a'.repeat(41)]) {
      const { deps, calls } = fakeDeps(answered({}));
      expect(await agentSwarmReport(deps, { runId, text: '{}' })).toBe(EXIT.refused);
      expect(calls).toHaveLength(0);
    }
    const big = fakeDeps(answered({}));
    const text = `{"x":"${'a'.repeat(SWARM_REPORT_MAX_BYTES)}"}`;
    expect(await agentSwarmReport(big.deps, { runId: 'abcdef0123456789', text })).toBe(EXIT.refused);
    expect(big.calls).toHaveLength(0);
    const none = fakeDeps(answered({}));
    expect(await agentSwarmReport(none.deps, { runId: 'abcdef0123456789', text: 'no json' })).toBe(EXIT.refused);
    expect(none.calls).toHaveLength(0);
  });

  it('fails when the server refuses the report', async () => {
    const { deps } = fakeDeps({
      status: 403,
      json: { success: false, error: "FORBIDDEN: Only the run's own session may report it", errorCode: 'FORBIDDEN' },
      text: '',
    });
    expect(await agentSwarmReport(deps, { runId: 'abcdef0123456789', text: '{}' })).not.toBe(EXIT.ok);
  });
});
