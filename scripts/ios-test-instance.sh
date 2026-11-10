#!/usr/bin/env bash
# Runs a disposable Codeman for real-device tests: its own data dir, tmux socket,
# cases folder and password, so a test that taps the wrong thing never reaches
# your real sessions and your real login never lands in the phone's browser.
# It is not a sandbox: its shell sessions run as your OS user.
# Guide: docs/ios-device-testing.md
#
#   [IOS_TEST_PORT=3190] [IOS_TEST_ALLOWED_HOSTS=<host the phone uses>] \
#     scripts/ios-test-instance.sh start [CODE_DIR]
#   scripts/ios-test-instance.sh status | stop | password | login-scenario <url>
set -euo pipefail

action=${1:-status}
instance=${IOS_TEST_INSTANCE:-iphone}
port=${IOS_TEST_PORT:-3190}
data_dir="$HOME/.codeman-$instance"
password_file="$data_dir/ios-test-password"
code_file="$data_dir/ios-test-code-dir"
dir_arg=
[[ $action == start || $action == status || $action == stop ]] && dir_arg=${2:-}
if [[ -n $dir_arg || $action == start || ! -s $code_file ]]; then
  code_dir=$(cd "${dir_arg:-$(dirname "$0")/..}" && pwd)
else
  code_dir=$(cat "$code_file")
fi

[[ $instance =~ ^[a-z0-9-]+$ ]] || { echo "IOS_TEST_INSTANCE must be a non-empty [a-z0-9-] name" >&2; exit 2; }

for name in $(compgen -e | grep '^CODEMAN_' || true); do unset "$name"; done
export CODEMAN_INSTANCE=$instance
export CODEMAN_CASES_PATH="$data_dir/cases"

if [[ -f $code_dir/dist/index.js ]]; then
  entry=(node "$code_dir/dist/index.js")
else
  entry=("$code_dir/node_modules/.bin/tsx" "$code_dir/src/index.ts")
fi

case $action in
  start)
    mkdir -p "$CODEMAN_CASES_PATH"
    chmod 700 "$data_dir"
    if [[ ! -s $password_file ]]; then
      (umask 077 && node -e 'process.stdout.write(require("crypto").randomBytes(18).toString("base64url"))' >"$password_file")
    fi
    CODEMAN_PASSWORD=$(cat "$password_file")
    export CODEMAN_PASSWORD CODEMAN_USERNAME=admin
    [[ -z ${IOS_TEST_ALLOWED_HOSTS:-} ]] || export CODEMAN_ALLOWED_HOSTS=$IOS_TEST_ALLOWED_HOSTS
    cd "$code_dir"
    "${entry[@]}" web -d --host 127.0.0.1 --port "$port"
    echo "$code_dir" >"$code_file"
    echo "code: $code_dir ($(git -C "$code_dir" rev-parse --short HEAD 2>/dev/null || basename "$code_dir"))"
    ;;
  status | stop)
    cd "$code_dir"
    "${entry[@]}" web "--$action" --host 127.0.0.1 --port "$port"
    ;;
  password)
    cat "$password_file"
    echo
    ;;
  login-scenario)
    # The user name field point is for a 414x896 portrait screen (iPhone XR/11). Read others off login-dialog.png.
    url=${2:?usage: $0 login-scenario <url the phone opens>}
    URL=$url PASSWORD=$(cat "$password_file") node -e '
      const { URL: url, PASSWORD: password } = process.env;
      const page = new globalThis.URL(url).host;
      process.stdout.write(JSON.stringify({ page, steps: [
        { do: "open", url },
        { do: "sleep", ms: 5000 },
        { do: "shot", name: "login-dialog" },
        { do: "tap", name: "user name field", at: { x: 207, y: 401 } },
        { do: "type", name: "username", text: "admin\n" },
        { do: "type", name: "password", text: password + "\n" },
        { do: "waitFor", name: "Codeman loaded", js: "return !!window.app", timeoutMs: 15000 },
        { do: "shot", name: "logged-in" },
      ] }, null, 1) + "\n");'
    ;;
  *)
    echo "usage: $0 start [CODE_DIR] | status | stop | password | login-scenario <url>" >&2
    exit 2
    ;;
esac
