/**
 * @fileoverview A stand-in for the `claude` command, for a preview of Codeman.
 *
 * A preview runs a branch of Codeman for a reviewer, on a machine with no Claude Code login and no API key. Its
 * sessions still need something to run, so this script takes the place of `claude` on that machine's PATH. It
 * draws a composer, takes a prompt, shows a working line for a moment, prints a fixed answer and waits again.
 * Those are the states Codeman's own features read off a pane.
 *
 * It never opens a network connection: it imports nothing that could, and it starts no process except the hooks
 * Codeman itself wrote into the workspace, which report to the Codeman server on the same machine.
 *
 * What it keeps of the real command, because Codeman reads it:
 * - the composer row starts with `❯`, and the footer carries `shift+tab`;
 * - a working row carries `esc to interrupt` and is gone when the answer is printed;
 * - a prompt arrives as one bracketed paste followed by Enter, and the composer is empty afterwards;
 * - each turn is appended to `<config dir>/projects/<folder>/<session id>.jsonl`;
 * - the `UserPromptSubmit`, `Stop` and `Notification` (`idle_prompt`) hooks from the workspace's settings run.
 *
 * Everything else the real command does is absent, and says so when asked.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const VERSION = '2.1.300';
export const BANNER = 'Claude stand-in for previews';
const WORK_SECONDS = 2;
const IDLE_NOTICE_MS = 60_000;
const HOOK_TIMEOUT_MS = 10_000;
const MAX_INPUT_CHARS = 100_000;

/** The flags this script reads. Every other flag, and its value, is ignored. */
export function parseArgs(argv) {
  const out = { version: false, print: false, sessionId: '', settings: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--version' || arg === '-v') out.version = true;
    else if (arg === '-p' || arg === '--print') out.print = true;
    else if ((arg === '--session-id' || arg === '--resume' || arg === '-r') && isId(argv[i + 1]))
      out.sessionId = argv[++i];
    else if (arg === '--settings') {
      try {
        const parsed = JSON.parse(argv[++i] ?? '');
        if (parsed && typeof parsed === 'object') out.settings = parsed;
      } catch {
        // A settings argument that is a file path, or does not parse, carries no hooks this script can run.
      }
    }
  }
  return out;
}
const isId = (value) => typeof value === 'string' && /^[0-9a-fA-F-]{8,64}$/.test(value);

/** The folder Claude Code keeps a project's conversations in: every non-alphanumeric of the path becomes `-`. */
export const projectDirName = (cwd) => resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
export const transcriptPath = (env, cwd, sessionId) =>
  join(
    env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude'),
    'projects',
    projectDirName(cwd),
    `${sessionId}.jsonl`
  );

/**
 * The fixed answers. `scripted` is an optional list `[{ match, reply, seconds? }]` from the file named in
 * `CODEMAN_STANDIN_REPLIES`; the first entry whose `match` is a substring of the prompt answers it. Substring
 * only, never a pattern, so a scenario file cannot make this script hang.
 */
export function replyFor(prompt, scripted = []) {
  const lower = prompt.toLowerCase();
  for (const row of scripted) {
    if (!row || typeof row.match !== 'string' || typeof row.reply !== 'string') continue;
    if (!lower.includes(row.match.toLowerCase())) continue;
    const seconds = Number.isFinite(row.seconds) ? Math.min(600, Math.max(0, row.seconds)) : WORK_SECONDS;
    return { text: row.reply.slice(0, 20_000), seconds };
  }
  if (prompt.startsWith('/'))
    return {
      text: `${prompt.split(/\s/)[0]} is not available here. This is a stand-in for Claude, for previews.`,
      seconds: 0,
    };
  const quoted = prompt.length > 200 ? `${prompt.slice(0, 200)}…` : prompt;
  return {
    text: [
      'This is a preview of Codeman, and I am a stand-in for Claude: a script with fixed answers.',
      'Nothing typed here is sent anywhere, and no file is changed.',
      '',
      `You wrote: ${quoted}`,
    ].join('\n'),
    seconds: lower.includes('take your time') ? 20 : WORK_SECONDS,
  };
}

export function readScript(path) {
  if (!path) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) ? parsed.slice(0, 200) : [];
  } catch {
    return [];
  }
}

/** The two transcript rows of one turn, in the shape Claude Code writes. */
export function transcriptRows({ sessionId, cwd, prompt, reply, parentUuid, now }) {
  const base = { isSidechain: false, userType: 'external', cwd, sessionId, version: VERSION, gitBranch: '' };
  const user = {
    parentUuid,
    ...base,
    type: 'user',
    message: { role: 'user', content: prompt },
    uuid: randomUUID(),
    timestamp: new Date(now).toISOString(),
  };
  const assistant = {
    parentUuid: user.uuid,
    ...base,
    type: 'assistant',
    message: {
      id: `msg_standin_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-standin',
      content: [{ type: 'text', text: reply }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    uuid: randomUUID(),
    timestamp: new Date(now + 1).toISOString(),
  };
  return [user, assistant];
}

/** The commands a settings object runs for one hook event. `matcher` is compared exactly; a group without one always runs. */
export function hookCommands(settings, event, matcher) {
  const groups = settings && settings.hooks && Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  const out = [];
  for (const group of groups) {
    if (!group || !Array.isArray(group.hooks)) continue;
    if (group.matcher && group.matcher !== matcher) continue;
    for (const hook of group.hooks) {
      if (!hook || hook.type !== 'command' || typeof hook.command !== 'string') continue;
      const args = Array.isArray(hook.args) ? hook.args.filter((a) => typeof a === 'string') : null;
      out.push(args ? { file: hook.command, args } : { file: '/bin/sh', args: ['-c', hook.command] });
    }
  }
  return out;
}

/**
 * Turns the bytes a terminal sends into what was meant. Returns a function fed one chunk at a time; it calls
 * `on(event)` with `{ type: 'text', text }`, `'enter'`, `'backspace'`, `'escape'`, `'interrupt'` or `'eof'`.
 * Arrow keys, focus reports, mouse reports and every other escape sequence are dropped.
 */
export function createInputParser(on) {
  const decoder = new StringDecoder('utf8');
  let pasting = false;
  let held = '';
  return (chunk) => {
    let data = held + (typeof chunk === 'string' ? chunk : decoder.write(chunk));
    held = '';
    let text = '';
    const flush = () => {
      if (text) on({ type: 'text', text });
      text = '';
    };
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      if (ch === '\x1b') {
        const rest = data.slice(i);
        if (rest.startsWith('\x1b[200~')) {
          pasting = true;
          i += 5;
          continue;
        }
        if (rest.startsWith('\x1b[201~')) {
          pasting = false;
          i += 5;
          continue;
        }
        const csi = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(rest) || /^\x1bO[@-~]/.exec(rest);
        if (csi) {
          i += csi[0].length - 1;
          continue;
        }
        // The start of a sequence whose end is in the next chunk.
        if (/^\x1b(\[[0-?]*[ -/]*|O)$/.test(rest) && rest.length < 32) {
          held = rest;
          break;
        }
        flush();
        if (!pasting) on({ type: 'escape' });
        continue;
      }
      if (pasting) {
        text += ch === '\r' ? '\n' : ch;
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        flush();
        on({ type: 'enter' });
      } else if (ch === '\x7f' || ch === '\b') {
        flush();
        on({ type: 'backspace' });
      } else if (ch === '\x03') {
        flush();
        on({ type: 'interrupt' });
      } else if (ch === '\x04') {
        flush();
        on({ type: 'eof' });
      } else if (ch >= ' ') text += ch;
    }
    flush();
  };
}

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const stdout = process.stdout;
  if (args.version) {
    stdout.write(`${VERSION} (Claude Code) [${BANNER}]\n`);
    return 0;
  }
  if (args.print || !process.stdin.isTTY || !stdout.isTTY) {
    stdout.write(
      'This is a stand-in for Claude, for previews of Codeman. It has fixed answers and sends nothing anywhere.\n'
    );
    return 0;
  }

  const cwd = process.cwd();
  const scripted = readScript(env.CODEMAN_STANDIN_REPLIES);
  const speed = Number(env.CODEMAN_STANDIN_SPEED) > 0 ? Number(env.CODEMAN_STANDIN_SPEED) : 1;
  const settings = [args.settings];
  for (const name of ['settings.json', 'settings.local.json']) {
    try {
      settings.push(JSON.parse(readFileSync(join(cwd, '.claude', name), 'utf8')));
    } catch {
      // No such file, or one that does not parse: it has no hooks to run.
    }
  }

  let sessionId = args.sessionId || randomUUID();
  let parentUuid = null;
  let input = '';
  let working = null;
  let drawn = 0;
  let lastInterrupt = 0;
  let idleTimer = null;
  let finish;
  const done = new Promise((resolveDone) => (finish = resolveDone));

  const runHooks = (event, matcher, extra) => {
    const payload = JSON.stringify({
      session_id: sessionId,
      transcript_path: transcriptPath(env, cwd, sessionId),
      cwd,
      hook_event_name: event,
      ...extra,
    });
    for (const one of settings)
      for (const command of hookCommands(one, event, matcher)) {
        try {
          const child = spawn(command.file, command.args, {
            cwd,
            env,
            stdio: ['pipe', 'ignore', 'ignore'],
            timeout: HOOK_TIMEOUT_MS,
          });
          child.on('error', () => undefined);
          child.stdin.on('error', () => undefined);
          child.stdin.end(payload);
        } catch {
          // A hook that cannot start is the workspace's problem, never a reason to stop.
        }
      }
  };

  const cols = () => Math.max(20, stdout.columns || 80);
  const erase = () => {
    if (drawn) stdout.write(`\r\x1b[${drawn}A\x1b[0J`);
    drawn = 0;
  };
  const draw = () => {
    erase();
    const width = cols();
    const rule = `${DIM}${'─'.repeat(width)}${RESET}`;
    const flat = input.replace(/\n/g, '↵');
    const room = width - 3;
    const shown = flat.length > room ? `…${flat.slice(flat.length - room + 1)}` : flat;
    const lines = [];
    if (working) {
      const seconds = Math.floor((Date.now() - working.startedAt) / 1000);
      lines.push(`✻ Thinking… (${seconds}s · esc to interrupt)`, '');
    }
    lines.push(
      rule,
      `❯ ${shown}`,
      rule,
      `${DIM}  ? for shortcuts · shift+tab to cycle modes · stand-in, no model${RESET}`
    );
    stdout.write(`${lines.join('\r\n')}\r\n`);
    drawn = lines.length;
  };
  const print = (text) => {
    erase();
    stdout.write(`${text.replace(/\r?\n/g, '\r\n')}\r\n`);
    draw();
  };
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () =>
        runHooks('Notification', 'idle_prompt', {
          message: 'Claude is waiting for your input',
          notification_type: 'idle_prompt',
        }),
      IDLE_NOTICE_MS
    );
    idleTimer.unref();
  };
  const stopWorking = () => {
    if (!working) return;
    clearTimeout(working.timer);
    clearInterval(working.tick);
    working = null;
  };

  const submit = () => {
    const prompt = input.trim();
    input = '';
    if (!prompt) return draw();
    if (prompt === '/exit' || prompt === '/quit') return finish(0);
    if (prompt === '/clear') {
      sessionId = randomUUID();
      parentUuid = null;
      stdout.write('\x1b[2J\x1b[3J\x1b[H');
      drawn = 0;
      return draw();
    }
    clearTimeout(idleTimer);
    print(`${DIM}> ${prompt.replace(/\n/g, '\n  ')}${RESET}\n`);
    runHooks('UserPromptSubmit', '', { prompt });
    const reply = replyFor(prompt, scripted);
    const finishTurn = () => {
      stopWorking();
      const rows = transcriptRows({ sessionId, cwd, prompt, reply: reply.text, parentUuid, now: Date.now() });
      parentUuid = rows[1].uuid;
      try {
        const path = transcriptPath(env, cwd, sessionId);
        mkdirSync(join(path, '..'), { recursive: true });
        appendFileSync(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
      } catch {
        // No transcript then; the pane still shows the turn.
      }
      print(`● ${reply.text.replace(/\n/g, '\n  ')}\n`);
      runHooks('Stop', '', { stop_hook_active: false });
      armIdle();
    };
    working = {
      startedAt: Date.now(),
      timer: setTimeout(finishTurn, (reply.seconds * 1000) / speed),
      tick: setInterval(draw, 1000),
    };
    draw();
  };

  const parse = createInputParser((event) => {
    if (event.type === 'text') {
      if (input.length < MAX_INPUT_CHARS) input += event.text.slice(0, MAX_INPUT_CHARS - input.length);
      draw();
    } else if (event.type === 'enter') submit();
    else if (event.type === 'backspace') {
      input = Array.from(input).slice(0, -1).join('');
      draw();
    } else if (event.type === 'escape') {
      if (!working) return;
      stopWorking();
      print(`${DIM}  ⎿ Interrupted${RESET}\n`);
      runHooks('Stop', '', { stop_hook_active: false });
      armIdle();
    } else if (event.type === 'interrupt') {
      if (input) {
        input = '';
        return draw();
      }
      if (Date.now() - lastInterrupt < 1500) return finish(0);
      lastInterrupt = Date.now();
      print(`${DIM}Press Ctrl-C again to exit${RESET}`);
    } else if (event.type === 'eof' && !input) finish(0);
  });

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', parse);
  process.stdin.on('end', () => finish(0));
  stdout.on('resize', draw);
  for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => finish(0));
  stdout.write('\x1b[?2004h');
  stdout.write(
    [
      '',
      ` ${BOLD}✻ ${BANNER}${RESET}`,
      `${DIM}   This is not Claude. It is a script with fixed answers, so a preview of Codeman has`,
      `   sessions to show. Nothing typed here is sent anywhere.`,
      `   cwd: ${cwd}${RESET}`,
      '',
      '',
    ].join('\r\n')
  );
  draw();
  armIdle();

  const code = await done;
  stopWorking();
  clearTimeout(idleTimer);
  stdout.write('\x1b[?2004l');
  try {
    process.stdin.setRawMode(false);
  } catch {
    // The terminal is already gone.
  }
  process.stdin.pause();
  return code;
}
