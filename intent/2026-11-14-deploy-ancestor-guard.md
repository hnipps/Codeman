# Intent: A deploy may not take commits out of production

**Status:** Implemented outside this repository. The guard was installed in the supervisor on 2026-11-14: `lib/deploy.mjs` carries `refuseDroppingCommits()`, called from `resolve()` for a `deploy`, and `test/ancestry.test.mjs` is installed beside it. The `codeman-deploy` wrapper's `status` case now runs `codeman-supervisor status` directly. The proposed `docs/self-building.md` text is not applied yet, and the open questions below are still open.

## Problem statement

On 2026-11-14 two agent sessions deployed within four minutes of each other, and neither knew about the other:

| Time (UTC) | What happened |
| --- | --- |
| 15:23:34 | Session A's deploy of `76101a08` starts. It is one canvas fix committed on top of `b7976495` (GitHub `master`, #45). |
| 15:26:50 | `76101a08` goes live on green. |
| 15:26:51 | A deploy of `b7976495`, requested by session B while A's deploy was still running, starts 1.3 s later. `b7976495` is the parent of `76101a08`. |
| 15:30:08 | `b7976495` goes live on blue. The canvas fix is gone from production. Nothing warned anyone. |
| after | `codeman-deploy status` reports `push: pending for b7976495`, so `76101a08` would never reach GitHub. One `codeman-deploy status` call took over 120 s. |

The parent session redeployed `76101a08` at 15:33, so production and GitHub are right again. The hole that allowed it is still open.

You can check each cause in the supervisor's installed source without running anything:

1. **A deploy and a rollback are the same pipeline.** `PIPELINES` in the supervisor's `lib/deploy.mjs` (lines 293-295) maps `deploy` and `rollback` to the same `DEPLOY` step list. `resolve()` (lines 91-107) turns the argument into a sha and picks the idle colour. It never compares the sha with the live release, so a strict ancestor of live passes as an ordinary deploy.
2. **The action label decides what gets pushed.** `pushTarget()` in `lib/state.mjs` (lines 86-89) pushes the sha of the newest history row when that row is a `deploy`. The ancestor's deploy became the push target, and the newer commit was orphaned in the local clone. This is the case `docs/self-building.md` describes as "stays local, unless a later deploy is built on top of it", but here it happened by accident and without a rollback.
3. **Any check made when the request is written would be too early.** Session B's request was queued while A's deploy held the lock. When B asked, the live release was still `82de6e82`, and `b7976495` descended from it. Only the state read under the lock (`recover()`, lines 56-75, then `resolve()`) shows what A put live.
4. **The fork's own `deploy/` scripts cannot guard this.** The supervisor runs `deploy/build.sh` and `deploy/test.sh` from the release being deployed. Deploying an ancestor runs the ancestor's copies, which predate any guard added now. Those scripts also run on a `git archive` export with no git history and no supervisor state.
5. **`codeman-deploy status` waits for the deploy lock.** The wrapper's `status` case runs `codeman-supervisor request status`. That goes through the queue, and `queueRun()` in `lib/queue.mjs` waits for the deploy lock (line 94) before it answers anything (lines 132-133). So a status request waits behind a whole deploy. `gatherStatus()` in `lib/status.mjs` is read-only and says so (line 205). As the app user, `codeman-supervisor status` without `request` reads every file it needs and answered in 0.1 s while I checked.
6. **The shared checkout makes a stale base easy.** Local `master` in the shared clone was at `9142a6e1`, far behind `origin/master`. A session that branches from local `master` builds on a base that is older than live.

## Proposed outcome

1. `codeman-deploy <sha>` is refused at `resolve` when `<sha>` does not contain the live release. That covers both a strict ancestor of live and a branch that forked before it. The outcome line says what would be dropped, and the deploy log lists up to 20 of the dropped commits (the line is wrapped here):

   ```
   FAILED at resolve: b79764959729 does not contain the live release 76101a08adff and would drop 1 commit(s):
   76101a0 fix(canvas): place comment pins after the rail is shown or hidden. Build on 76101a08adff and deploy
   that, or use "codeman-deploy rollback b79764959729" if going back is intended
   ```

   Nothing is backed up, built, started or switched, and `state.json` is unchanged.
2. When push is on, the same check runs against `push.json`'s `pushed.sha`, the commit the last background push sent. This catches a deploy built on a rolled-back release that skips work GitHub already has. Without this check, that deploy would go live and its push would then fail as non-fast-forward forever.
3. Going back on purpose stays possible, and stays explicit: `codeman-deploy rollback <sha>` is not checked. A rollback is never pushed and it clears the push target, which is the right meaning for "take these commits out".
4. Deploying the live sha again is still allowed.
5. `codeman-deploy status` answers at once, even while a deploy runs. The wrapper's `status` case runs `codeman-supervisor status` directly instead of going through the request queue.

I chose not to add an override flag. The request grammar is exactly `{action, arg}` (`validateRequest()` in `lib/queue.mjs`), and `rollback <sha>` already means "deploy this older code on purpose, and do not push it". A flag would add a second way to say the same thing, and that way would push.

### The patch to the supervisor (`lib/deploy.mjs`)

The check runs inside `resolve()`, under the deploy lock, after `recover()` has read `state.json`. So a deploy that was queued behind another one is judged against what that one put live. `git merge-base --is-ancestor` exits 0 when the sha contains the base, 1 when it does not, and anything else (for example, a base missing from the clone) fails closed.

```diff
--- a/lib/deploy.mjs
+++ b/lib/deploy.mjs
@@ -11,7 +11,7 @@
 import { listSessionIds, portAnswers } from './probe.mjs';
 import { pointProxyAt } from './proxy.mjs';
 import { buildSteps, listReleases, pruneReleases, readRelease, releaseDir } from './releases.mjs';
-import { previousSha, readState, withSwitch, withTag, writeState } from './state.mjs';
+import { previousSha, readPushState, readState, withSwitch, withTag, writeState } from './state.mjs';
 
 /**
  * A deploy, a rollback and a boot-time start-live are step sequences over one context. Steps before the
@@ -88,6 +88,51 @@
   return sha;
 }
 
+const DROPPED_LISTED = 20;
+
+async function git(ctx, args) {
+  const { config, log } = ctx;
+  return run(asApp(config, ['git', '-C', config.repoPath, ...args]), {
+    env: baseEnv(),
+    timeoutMs: config.limits.gitTimeoutSeconds * 1000,
+    graceMs: 1000,
+    logFd: log.fd,
+    capture: true,
+  });
+}
+
+/**
+ * A deploy moves production forward. A commit that does not contain the live release (an ancestor of it, or a
+ * branch that forked before it) would silently take the live release's newer commits out of production and
+ * make itself the push target, so their only copy stays local. Going back on purpose is a rollback, which is
+ * never pushed. Runs under the lock, after recover read state.json, so a deploy queued behind another one is
+ * judged against what that one put live, not against what was live when it was requested.
+ */
+async function refuseDroppingCommits(ctx) {
+  const { state, sha, log } = ctx;
+  const bases = [];
+  if (state.live && state.live.sha !== sha) bases.push({ what: 'the live release', sha: state.live.sha });
+  if (ctx.config.push.enabled) {
+    const pushed = readPushState(ctx.config).pushed?.sha;
+    if (pushed && pushed !== sha && !bases.some((b) => b.sha === pushed)) bases.push({ what: 'the commit GitHub has from the last push', sha: pushed });
+  }
+  for (const base of bases) {
+    const r = await git(ctx, ['merge-base', '--is-ancestor', base.sha, sha]);
+    if (r.code === 0 && !r.timedOut) continue;
+    const short = (s) => s.slice(0, 12);
+    const rollback = `use "codeman-deploy rollback ${short(sha)}" if going back is intended`;
+    if (r.code !== 1 || r.timedOut)
+      throw new Error(`cannot tell whether ${short(sha)} contains ${base.what} ${short(base.sha)} (git merge-base exited ${r.signal ?? r.code}); ${rollback}`);
+    const dropped = await git(ctx, ['log', '--format=%h %s', `${sha}..${base.sha}`]);
+    const lines = dropped.code === 0 ? dropped.stdout.split('\n').filter(Boolean) : [];
+    log.line(`${short(sha)} does not contain ${base.what} ${short(base.sha)}; deploying it would drop:`);
+    for (const l of lines.slice(0, DROPPED_LISTED)) log.line(`  ${l}`);
+    if (lines.length > DROPPED_LISTED) log.line(`  ... and ${lines.length - DROPPED_LISTED} more`);
+    const count = lines.length ? `${lines.length} commit(s): ${lines.slice(0, 3).join('; ')}${lines.length > 3 ? '; ...' : ''}` : 'commits';
+    throw new Error(`${short(sha)} does not contain ${base.what} ${short(base.sha)} and would drop ${count}. Build on ${short(base.sha)} and deploy that, or ${rollback}`);
+  }
+}
+
 async function resolve(ctx) {
   const { config, log, state, action } = ctx;
   let wanted = ctx.arg;
@@ -98,6 +143,7 @@
   const kept = listReleases(config).filter((r) => r.sha.startsWith(wanted));
   if (kept.length > 1) throw new Error(`${wanted} matches more than one kept release`);
   ctx.sha = kept.length === 1 ? kept[0].sha : await gitResolve(ctx, wanted);
+  if (action === 'deploy') await refuseDroppingCommits(ctx);
   ctx.reuse = readRelease(config, ctx.sha) !== null;
   const colour = state.live ? otherColour(state.live.colour) : COLOURS[0];
   ctx.target = { colour, port: config.colours[colour].port };
```

### A new supervisor test (`test/ancestry.test.mjs`)

It uses the supervisor's own hermetic world (`test/support/world.mjs`: a throwaway fork repo, the process backend, free ports and a temporary state directory).

```js
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createWorld } from './support/world.mjs';

let w;
before(async () => {
  w = await createWorld();
});
after(async () => {
  await w?.destroy();
});

const lastSummary = () => w.summaries().at(-1);
const shas = {};

/** A deploy that must be refused at resolve: nothing is backed up, built, started or switched. */
async function expectRefused(sha) {
  const stateBefore = w.state();
  const releasesBefore = w.releases();
  const backupsBefore = w.backups();
  const testRunsBefore = w.testRuns().length;
  const servedBefore = await w.served();
  const r = await w.cli('deploy', sha);
  assert.equal(r.code, 1, r.stdout);
  const summary = lastSummary();
  assert.equal(summary.outcome, 'failed');
  assert.equal(summary.failedStep, 'resolve');
  assert.deepEqual(w.state(), stateBefore, 'state.json untouched');
  assert.deepEqual(w.releases(), releasesBefore, 'nothing built');
  assert.deepEqual(w.backups(), backupsBefore, 'nothing backed up');
  assert.equal(w.testRuns().length, testRunsBefore, 'test.sh never ran');
  assert.equal(await w.served(), servedBefore, 'the proxy still serves the live release');
  assert.deepEqual(readdirSync(w.config.stagingDir), [], 'no staging left behind');
  return { summary, log: readFileSync(summary.log, 'utf8'), stdout: r.stdout };
}

test('setup: v1 then its child v2 are deployed', async () => {
  shas.v1 = w.fork.first;
  assert.equal((await w.cli('deploy', shas.v1)).code, 0);
  shas.v2 = w.fork.commit({ VERSION: 'v2\n' }, 'canvas fix on top of v1');
  assert.equal((await w.cli('deploy', shas.v2)).code, 0);
  assert.equal(await w.served(), 'v2');
});

test('deploying an ancestor of the live release is refused and names the commits it would drop', async () => {
  const { summary, log, stdout } = await expectRefused(shas.v1);
  assert.match(summary.error, /does not contain the live release/);
  assert.match(summary.error, /would drop 1 commit\(s\): \w+ canvas fix on top of v1/);
  assert.match(summary.error, /codeman-deploy rollback/);
  assert.match(log, /deploying it would drop:\n.*canvas fix on top of v1/);
  assert.match(stdout, /deploy REJECTED at resolve/);
});

test('a short sha of an ancestor is refused the same way', async () => {
  await expectRefused(shas.v1.slice(0, 7));
});

test('a commit on a branch that forked before the live release is refused', async () => {
  w.fork.git('checkout', '-q', '-b', 'stale', shas.v1);
  shas.side = w.fork.commit({ VERSION: 'side\n' }, 'built on a stale master');
  w.fork.git('checkout', '-q', 'main');
  const { summary } = await expectRefused(shas.side);
  assert.match(summary.error, /canvas fix on top of v1/);
});

test('a descendant of the live release still deploys', async () => {
  shas.v3 = w.fork.commit({ VERSION: 'v3\n' }, 'v3');
  assert.equal((await w.cli('deploy', shas.v3)).code, 0);
  assert.equal(await w.served(), 'v3');
});

test('going back on purpose is a rollback, and it is not refused', async () => {
  const r = await w.cli('rollback', shas.v1);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(await w.served(), 'v1');
  assert.equal(w.state().history.at(-1).action, 'rollback');
});

test('after a rollback, a deploy that skips what GitHub already has is refused', async () => {
  // Pretend the background push sent v3 before the rollback.
  writeFileSync(
    join(w.config.stateDir, 'push.json'),
    JSON.stringify({ version: 1, pushed: { sha: shas.v3, tag: null, at: new Date().toISOString() }, lastAttempt: null })
  );
  w.fork.git('checkout', '-q', '-b', 'skip-v3', shas.v1);
  const skip = w.fork.commit({ VERSION: 'skip\n' }, 'fix built on the rolled-back release');
  w.fork.git('checkout', '-q', 'main');
  const { summary } = await expectRefused(skip);
  assert.match(summary.error, /the commit GitHub has from the last push/);
});

test('after a rollback, a fix committed on the tip deploys', async () => {
  const fix = w.fork.commit({ VERSION: 'v4\n' }, 'fix forward on the tip');
  assert.equal((await w.cli('deploy', fix)).code, 0);
  assert.equal(await w.served(), 'v4');
});
```

**How it was checked.** I ran it in a scratch copy of the installed supervisor and never touched the installed tree. The unmodified copy's suite passed 48 tests with 1 skipped (the root-only `app-user` test). With the patch and the new file, all 56 tests pass and the same 1 is skipped. That includes every existing deploy, queue, push, recovery and rollback test. I did not run the `tests/done` scripts. On this repository, `git merge-base --is-ancestor 76101a08 b7976495` exits 1, and `git log b7976495..76101a08` lists exactly the canvas fix, so the patch would have refused the 15:26:51 deploy.

### The change to the `codeman-deploy` wrapper

```sh
  status)
    [ $# -eq 1 ] || usage 2
    exec codeman-supervisor status   # was: codeman-supervisor request status
    ;;
```

The wrapper uses the same absolute path it already uses for the other cases. The Deploys section in Settings already reads `status --json` directly (`src/deploy-control.ts`), so this change brings the agent's command in line with the app.

## Affected users and systems

- Agent sessions that run `codeman-deploy`. A deploy that would drop commits now fails at `resolve` with exit 1, and nothing else changes.
- The supervisor (`lib/deploy.mjs`, plus one new test file) and the `codeman-deploy` wrapper. Both are root-owned and installed outside this repository, so Harry has to install them.
- `docs/self-building.md`. That needs Harry's approval before it changes (rule 11), so the proposed text is listed here and the file is left as it is:
  - In the outcome table, the `failed at resolve` row becomes: "The sha is not a commit in this clone, or it does not contain the live release or the commit the last push sent. The log lists the commits it would drop." What to read: "Build on the live sha, or use `rollback <sha>` to go back on purpose."
  - Step 3 of "Deploy a change" gains: "Base the commit on the live sha that `codeman-deploy status` shows, or on a freshly fetched `origin/<push.branch>`. Local `master` in the shared checkout may be stale."
  - The `status` paragraph gains: "`status` reads without taking the deploy lock, so it answers while a deploy runs, and the `lock:` line shows whether one is running."
- The Deploys section in Settings and the canvas release read already treat any `failed` row as a rejected run. They need no change.

## Constraints

- No reverse migration and no state shape change. `state.json` and `push.json` are only read, so the guard can be installed or removed at any time.
- The check fails closed. When git cannot answer, the deploy is refused, and the message says how to deploy the commit on purpose.
- `rollback`, `start-live`, the queue grammar and the push timer are unchanged.
- The guard adds two `git` calls (an ancestry check, plus a `git log` only when refusing), each bounded by `gitTimeoutSeconds`.

## Open questions

- Should a refused deploy name the session that put the live release up? The supervisor does not know who asked, because a request is only `{action, arg}`. Recording a requester would change the queue grammar. I left that out.
- Should the guard also compare against the tip of `origin/<push.branch>`, beyond the supervisor's own `pushed.sha`? That would catch a deploy that skips work merged on GitHub by a PR, but only after a `git fetch` inside the lock, which adds network access to a step that has none today. I suggest no, and to rely on the doc's "build on a fetched `origin/master`".
- Should `queueRun()` also answer `status` requests before it waits for the lock, for any other caller of `request status`? Once the wrapper is fixed, nothing in this fork uses that path.
