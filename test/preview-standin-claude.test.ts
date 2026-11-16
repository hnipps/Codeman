/**
 * The stand-in for `claude` that a preview machine runs (`deploy/preview/`): its pure parts, and the script
 * itself in a real terminal, read the way Codeman reads a claude pane.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as pty from 'node-pty';
import { afterEach, describe, expect, it } from 'vitest';
import { compileVersionRegex } from '../src/config/cli-registry/patterns.js';
import { getCli } from '../src/config/cli-registry/registry.js';
import { claudeProjectDirName } from '../src/case-rename.js';
import { generateHooksConfig } from '../src/hooks-config.js';
// @ts-expect-error a plain script outside the TypeScript project
import * as standin from '../deploy/preview/standin-claude.mjs';

const BIN = join(__dirname, '..', 'deploy', 'preview', 'bin', 'claude');
const SOURCE = readFileSync(join(__dirname, '..', 'deploy', 'preview', 'standin-claude.mjs'), 'utf8');
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');

describe('stand-in claude: the pure parts', () => {
  it('reads the flags Codeman launches claude with and ignores the rest', () => {
    const args = standin.parseArgs([
      '--dangerously-skip-permissions',
      '--session-id',
      '0b9d3c1e-1111-4222-8333-444455556666',
      '--settings',
      '{"hooks":{"Stop":[]},"statusLine":{"type":"command","command":"x"}}',
      '--name',
      'w1',
      '--effort',
      'max',
    ]);
    expect(args.sessionId).toBe('0b9d3c1e-1111-4222-8333-444455556666');
    expect(args.settings.hooks).toEqual({ Stop: [] });
    expect(standin.parseArgs(['--settings', '/some/file.json']).settings).toEqual({});
    expect(standin.parseArgs(['--version']).version).toBe(true);
    expect(standin.parseArgs(['-p', 'hello']).print).toBe(true);
  });

  it('keeps conversations where Codeman looks for them', () => {
    expect(standin.projectDirName('/srv/my.case/x_y')).toBe(claudeProjectDirName('/srv/my.case/x_y'));
    expect(standin.transcriptPath({ HOME: '/h' }, '/a/b', 'sid')).toBe('/h/.claude/projects/-a-b/sid.jsonl');
    expect(standin.transcriptPath({ HOME: '/h', CLAUDE_CONFIG_DIR: '/c' }, '/a/b', 'sid')).toBe(
      '/c/projects/-a-b/sid.jsonl'
    );
  });

  it('answers from the scenario file by substring, and with the fixed answer otherwise', () => {
    const scripted = [{ match: 'Deploy', reply: 'Deployed.', seconds: 9999 }, { match: '(a+)+$', reply: 'no' }, null];
    expect(standin.replyFor('please deploy it', scripted)).toEqual({ text: 'Deployed.', seconds: 600 });
    expect(standin.replyFor('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!', scripted).text).toContain(
      'stand-in for Claude'
    );
    expect(standin.replyFor('/model opus').text).toContain('/model is not available here');
    expect(standin.replyFor('hello').text).toContain('You wrote: hello');
  });

  it('writes a turn as the two rows Claude Code writes', () => {
    const [user, assistant] = standin.transcriptRows({
      sessionId: 'sid',
      cwd: '/a',
      prompt: 'hello',
      reply: 'hi',
      parentUuid: null,
      now: 1_700_000_000_000,
    });
    expect(user).toMatchObject({
      type: 'user',
      sessionId: 'sid',
      cwd: '/a',
      message: { role: 'user', content: 'hello' },
    });
    expect(assistant).toMatchObject({
      type: 'assistant',
      parentUuid: user.uuid,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    });
  });

  it('finds the hooks Codeman installs for the three events it fires', () => {
    const settings = generateHooksConfig();
    expect(standin.hookCommands(settings, 'Stop', '')).toHaveLength(1);
    expect(standin.hookCommands(settings, 'UserPromptSubmit', '')).toHaveLength(1);
    const idle = standin.hookCommands(settings, 'Notification', 'idle_prompt');
    expect(idle).toHaveLength(1);
    expect(idle[0]).toMatchObject({ file: '/bin/sh', args: ['-c', expect.stringContaining('idle_prompt')] });
    expect(standin.hookCommands({ hooks: { Stop: 'nope' } }, 'Stop', '')).toEqual([]);
    expect(standin.hookCommands(null, 'Stop', '')).toEqual([]);
  });

  it('turns terminal bytes into keys: a paste keeps its line breaks, and stray sequences are dropped', () => {
    const events: { type: string; text?: string }[] = [];
    const feed = standin.createInputParser((e: { type: string; text?: string }) => events.push(e));
    feed('\x1b[200~one\rtwo\x1b[201~');
    feed('\r');
    feed('\x1b[A\x1b[I\x1b[<64;10;5Mab\x7f');
    feed('\x1b[20');
    feed('0~x\x1b[201~');
    feed('\x1b');
    feed('\x03\x04');
    expect(events).toEqual([
      { type: 'text', text: 'one\ntwo' },
      { type: 'enter' },
      { type: 'text', text: 'ab' },
      { type: 'backspace' },
      { type: 'text', text: 'x' },
      { type: 'escape' },
      { type: 'interrupt' },
      { type: 'eof' },
    ]);
  });

  it('can open no network connection', () => {
    for (const banned of [
      'node:http',
      'node:https',
      'node:net',
      'node:tls',
      'node:dgram',
      'node:dns',
      'fetch(',
      'WebSocket',
    ])
      expect(SOURCE).not.toContain(banned);
  });
});

describe('stand-in claude: in a terminal', () => {
  const dirs: string[] = [];
  const terms: pty.IPty[] = [];
  afterEach(() => {
    for (const term of terms.splice(0)) {
      try {
        term.kill();
      } catch {
        /* already gone */
      }
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function start() {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'standin-home-')));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'standin-case-')));
    dirs.push(home, cwd);
    mkdirSync(join(cwd, '.claude'));
    writeFileSync(
      join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: `cat > ${join(home, 'prompt.json')}` }] }],
          Stop: [{ hooks: [{ type: 'command', command: `cat > ${join(home, 'stop.json')}` }] }],
        },
      })
    );
    const sessionId = '0b9d3c1e-1111-4222-8333-444455556666';
    const term = pty.spawn(process.execPath, [BIN, '--session-id', sessionId, '--name', 'w1'], {
      cwd,
      cols: 100,
      rows: 30,
      env: { PATH: process.env.PATH ?? '', HOME: home, TERM: 'xterm-256color', CODEMAN_STANDIN_SPEED: '10' },
    });
    terms.push(term);
    let screen = '';
    term.onData((d) => (screen += d));
    const until = async (test: (text: string) => boolean, what: string) => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (test(plain(screen))) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`never saw ${what}; the screen was:\n${plain(screen).slice(-600)}`);
    };
    return { term, home, cwd, sessionId, until, text: () => plain(screen) };
  }

  it('prints its version the way the real command does, and answers print mode without a terminal', () => {
    expect(execFileSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' })).toMatch(
      /^2\.\d+\.\d+ \(Claude Code\)/
    );
    expect(execFileSync(process.execPath, [BIN, '-p', 'hi'], { encoding: 'utf8', input: '' })).toContain('stand-in');
  });

  it('draws a composer, takes a pasted prompt, works, answers, and is idle again', async () => {
    const claude = getCli('claude')!;
    const working = compileVersionRegex(claude.capabilities.workDetect!.workingLine!)!;
    const glyph = claude.capabilities.workDetect!.promptGlyph!;
    const s = start();
    await s.until((t) => t.includes(`${glyph} `) && t.includes(claude.capabilities.composerReadyMark!), 'the composer');
    expect(working.test(s.text())).toBe(false);

    s.term.write('\x1b[200~What does this do?\x1b[201~');
    await s.until((t) => t.includes(`${glyph} What does this do?`), 'the pasted prompt on the composer row');
    const before = s.text().length;
    s.term.write('\r');
    await s.until((t) => working.test(t.slice(before)), 'the working row');
    await s.until((t) => t.slice(before).includes('● This is a preview of Codeman'), 'the answer');
    await s.until((t) => existsSync(join(s.home, 'stop.json')), 'the Stop hook');

    // What is on screen after the answer: an empty composer and no working row.
    const tail = s.text().slice(s.text().lastIndexOf('● This is a preview'));
    expect(working.test(tail)).toBe(false);
    expect(tail).toMatch(new RegExp(`${glyph} \\s*\\n`));

    const rows = readFileSync(
      join(s.home, '.claude', 'projects', claudeProjectDirName(s.cwd), `${s.sessionId}.jsonl`),
      'utf8'
    )
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rows.map((r) => r.type)).toEqual(['user', 'assistant']);
    expect(rows[0].message.content).toBe('What does this do?');
    expect(JSON.parse(readFileSync(join(s.home, 'prompt.json'), 'utf8'))).toMatchObject({
      session_id: s.sessionId,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'What does this do?',
    });
    expect(JSON.parse(readFileSync(join(s.home, 'stop.json'), 'utf8')).hook_event_name).toBe('Stop');
  });

  it('stops working on Escape, and leaves on /exit', async () => {
    const s = start();
    await s.until((t) => t.includes('❯ '), 'the composer');
    s.term.write('take your time\r');
    await s.until((t) => t.includes('esc to interrupt'), 'the working row');
    s.term.write('\x1b');
    await s.until((t) => t.includes('Interrupted'), 'the interrupt');
    const exited = new Promise<number>((done) => s.term.onExit((e) => done(e.exitCode)));
    s.term.write('/exit\r');
    expect(await exited).toBe(0);
  });
});
