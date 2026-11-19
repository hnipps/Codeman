/**
 * The health check's session decision, pure and separate from its I/O, for deploy/healthcheck.mjs.
 *
 * `decideSessions` is `Decide` in deploy/model/SessionSurvival.dfy, where its meaning is proved: a pass
 * means every expected session is listed by the new colour or provably dead (its tmux session is gone),
 * a session whose tmux session still runs always fails, and with any doubt the check is exactly the old
 * "every expected id is listed". test/session-survival.drt.test.ts tests this file against a build of
 * that model on random inputs. Change the two together.
 *
 * Zero dependencies: the supervisor runs the release's deploy/ scripts with plain node.
 */

/** A tmux session name or socket name the check will use. Anything else proves nothing. */
export const MUX_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * The live colour's mux records (`mux-sessions.json`) as a Map of session id to tmux session name, or
 * null when the text is not a JSON array. Records without a string id or a valid name are skipped; a
 * later record for the same id wins.
 */
export function parseMuxRecords(text) {
  let records;
  try {
    records = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(records)) return null;
  const muxNameOf = new Map();
  for (const r of records) {
    if (typeof r?.sessionId === 'string' && typeof r.muxName === 'string' && MUX_NAME.test(r.muxName)) {
      muxNameOf.set(r.sessionId, r.muxName);
    }
  }
  return muxNameOf;
}

/**
 * What one `tmux list-sessions -F '#{session_name}'` run says: `running` with the names, `none` when no
 * server runs on the socket (a missing socket file, or one nothing listens on), else `unknown`.
 */
export function classifyTmuxResult(err, stdout, stderr) {
  if (!err) return { kind: 'running', names: new Set(String(stdout).split('\n').filter(Boolean)) };
  if (
    /no server running|error connecting to .*\((No such file or directory|Connection refused)\)/i.test(String(stderr))
  ) {
    return { kind: 'none' };
  }
  return { kind: 'unknown' };
}

/** `Dead` in the model. */
function isDead(id, envOk, records, tmux) {
  if (!envOk || records === null || !records.has(id) || tmux.kind === 'unknown') return false;
  return tmux.kind === 'none' || !tmux.names.has(records.get(id));
}

/**
 * The decision. `expected` is the live colour's ids in order, `listed` a Set of the new colour's ids,
 * `records` the result of parseMuxRecords (null when unreadable), `tmux` the result of
 * classifyTmuxResult, and `envOk` whether the data dir and a valid socket name are configured.
 * Returns `{ ok, excused, lost }`: the missing ids split, in order, into provably dead and the rest.
 */
export function decideSessions({ expected, listed, records, tmux, envOk }) {
  const missing = expected.filter((id) => !listed.has(id));
  const excused = missing.filter((id) => isDead(id, envOk, records, tmux));
  const lost = missing.filter((id) => !isDead(id, envOk, records, tmux));
  return { ok: lost.length === 0, excused, lost };
}
