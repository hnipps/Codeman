/**
 * @fileoverview When `scripts/build.mjs` skips Chat Graph's Go sidecar instead of failing the build.
 * Pure, so `test/chat-graph-build.test.ts` pins the skip/fail split against Go's real output.
 */

/**
 * Whether the local go (`go env GOVERSION`, e.g. `go1.23.4`) is older than the `go` line of
 * `go.mod`, by major.minor. Null when either cannot be parsed, which leaves the decision to go.
 * A go older than 1.21 accepts a newer `go` line and compiles against its own stdlib, so this
 * check, not go's refusal, is what keeps such a go from linking a sidecar that misbehaves.
 * @param {string} goModText
 * @param {string} goVersion
 * @returns {boolean | null}
 */
export function isGoTooOld(goModText, goVersion) {
  const wanted = /^go (\d+)\.(\d+)/m.exec(goModText);
  const have = /^go(\d+)\.(\d+)/.exec(goVersion.trim());
  if (!wanted || !have) return null;
  const [wMajor, wMinor, hMajor, hMinor] = [wanted[1], wanted[2], have[1], have[2]].map(Number);
  return hMajor < wMajor || (hMajor === wMajor && hMinor < wMinor);
}

/**
 * Whether `go build`'s stderr is go 1.21+'s refusal under `GOTOOLCHAIN=local` to build a module
 * that needs a newer go (a patch level or pre-release the major.minor check cannot see). Any
 * other failure, a compile error included, must fail the build.
 * @param {string} stderr
 * @returns {boolean}
 */
export function isGoVersionRefusal(stderr) {
  return /go\.mod requires go >= /.test(stderr);
}

/**
 * The `GOOS/GOARCH` pairs whose files `chat-graph/vendor/` keeps (`scripts/vendor-chat-graph.mjs`
 * deletes every other platform's). The supervisor runs the sidecar on Linux only, and
 * `scripts/build.mjs` skips the sidecar on any platform not listed here.
 */
export const CHAT_GRAPH_PLATFORMS = ['linux/amd64', 'linux/arm64'];
