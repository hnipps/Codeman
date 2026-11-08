#!/usr/bin/env bash
# Runs each check in the PATH an agent session gets from Codeman, not a login shell.
set -u
AGENT_PATH="$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/snap/bin"

CHECKS=(
  "grok-on-path|command -v grok"
  "lean-on-path|command -v lean && command -v lake && command -v elan"
  "python-alias|python -c 'import sys; assert sys.version_info >= (3, 8)'"
  "venv-with-pip|d=\$(mktemp -d) && uv venv -q --seed \"\$d/v\" && \"\$d/v/bin/python\" -m pip --version; rc=\$?; rm -rf \"\$d\"; exit \$rc"
  "ripgrep|rg --version"
  "hyperfine|hyperfine --version"
  "go-toolchain|go version"
  "unzip|command -v unzip"
  "fontconfig|command -v fc-list"
  "docker|command -v docker"
  "system-pip|python3 -m pip --version"
  "pillow|python3 -c 'import PIL'"
  "cgroup-delegation|test -w /sys/fs/cgroup/system.slice/codeman-tmux.service"
)

fail=0
for c in "${CHECKS[@]}"; do
  name=${c%%|*}; cmd=${c#*|}
  if env -i HOME="$HOME" PATH="$AGENT_PATH" bash -c "$cmd" >/dev/null 2>&1; then
    printf 'PASS %s\n' "$name"
  else
    printf 'FAIL %s\n' "$name"; fail=$((fail + 1))
  fi
done
printf '%d failing\n' "$fail"
exit $((fail > 0))
