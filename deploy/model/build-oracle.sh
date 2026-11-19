#!/usr/bin/env bash
# Verify SessionSurvival.dfy and rebuild the committed Python oracle in oracle/ from it.
#   deploy/model/build-oracle.sh           verify, then rewrite oracle/
#   deploy/model/build-oracle.sh --check   verify, then fail if oracle/ differs from a fresh build
# Needs Dafny 4 (`dafny` on PATH, or DAFNY=/path/to/dafny). The oracle is generated code: never edit it.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dafny="${DAFNY:-dafny}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

"$dafny" verify "$here/SessionSurvival.dfy"
"$dafny" build -t:py --no-verify --output:"$tmp/oracle" "$here/SessionSurvival.dfy" >/dev/null
out="$tmp/oracle-py"
mkdir -p "$tmp/fresh/_dafny" "$tmp/fresh/System_"
cp "$out/SessionSurvival.py" "$out/module_.py" "$tmp/fresh/"
cp "$out/_dafny/__init__.py" "$tmp/fresh/_dafny/"
cp "$out/System_/__init__.py" "$tmp/fresh/System_/"

if [[ "${1:-}" == "--check" ]]; then
  diff -r -x __pycache__ "$tmp/fresh" "$here/oracle" && echo "oracle/ matches SessionSurvival.dfy"
else
  rm -rf "$here/oracle"
  cp -r "$tmp/fresh" "$here/oracle"
  echo "rebuilt $here/oracle"
fi
