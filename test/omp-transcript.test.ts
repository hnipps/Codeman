import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseOmpConversation, readOmpConversation } from '../src/omp-transcript.js';
import { mangleOmpWorkingDir } from '../src/utils/omp-session-resolver.js';

describe('omp conversation transcript', () => {
  let home: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  it('parses only user and assistant text blocks and numbers turns', () => {
    const raw = [
      JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Question' }] } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Answer' }] } }),
      JSON.stringify({
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Follow-up' }] },
      }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Next?' }] } }),
      JSON.stringify({
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'tool_call', text: 'not shown' }] },
      }),
      'malformed',
    ].join('\n');

    expect(parseOmpConversation(raw)).toEqual([
      { role: 'user', text: 'Question', turn: 1, kind: 'prompt' },
      { role: 'assistant', text: 'Answer', turn: 1, kind: 'response' },
      { role: 'assistant', text: 'Follow-up', turn: 1, kind: 'response' },
      { role: 'user', text: 'Next?', turn: 2, kind: 'prompt' },
    ]);
  });

  it('reads only the pinned conversation for the matching working directory', () => {
    home = mkdtempSync(join(homedir(), 'codeman-omp-chat-'));
    vi.stubEnv('HOME', home);
    const workingDir = join(home, 'cases', 'example');
    const sessionId = '12345678-1234-4234-8234-123456789abc';
    const sessionDir = join(home, '.omp', 'agent', 'sessions', mangleOmpWorkingDir(workingDir));
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, `2026-11-04T00-00-00_${sessionId}.jsonl`),
      [
        JSON.stringify({ type: 'session', id: sessionId, cwd: workingDir }),
        JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Question' }] } }),
        JSON.stringify({
          type: 'message',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Answer' }] },
        }),
      ].join('\n')
    );

    expect(readOmpConversation(sessionId, workingDir)).toEqual([
      { role: 'user', text: 'Question', turn: 1, kind: 'prompt' },
      { role: 'assistant', text: 'Answer', turn: 1, kind: 'response' },
    ]);
    expect(readOmpConversation('another-session', workingDir)).toEqual([]);
  });
});
